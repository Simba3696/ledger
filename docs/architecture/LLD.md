# Low-Level Design: Ledger, hosted edition

**Companion to:** [HLD.md](HLD.md). Decisions referenced as ADR-NNNN live in [../adr/](../adr/).

## 1. Repository layout (target)

```
client/                      React app (unchanged except auth + api.ts headers)
  src/auth/                  Supabase client, <SignIn/>, session hook
server/
  src/
    app.ts                   builds the Express app (shared by local server and function)
    index.ts                 local dev entry: app.listen(PORT)
    routes.ts                unchanged route table (30 routes)
    auth.ts                  JWT verification middleware
    db/
      client.ts              postgres.js connection + type parsers
      tx.ts                  withTransaction helper
    store/                   one module per concern; same exported function names
      categories.ts  ledger.ts  finances.ts  debts.ts  emi.ts
      subscriptions.ts  creditCardBills.ts  overview.ts
    domain/                  pure calculations, no I/O (moved verbatim from excel/*)
      dateMath.ts  emiMath.ts  subscriptionMath.ts  financeMath.ts  categoryColors.ts
      today.ts               "today" in APP_TIMEZONE
    errors.ts                LedgerError
  test/                      vitest, against the local Supabase Postgres
netlify/functions/api.ts     serverless-http(app)
supabase/
  config.toml
  migrations/                timestamped SQL, the only source of schema truth
  seed.sql                   local-only: default categories + a test owner
scripts/
  import-xlsx.ts             one-time Excel → Postgres import
  legacy-excel/              the old Excel readers, kept only for the importer
netlify.toml
```

The rule for the port: **store modules keep their current exported names and return shapes**, so `routes.ts`, `overview.ts` and the client don't change. Code that only computes is moved into `domain/` untouched.

## 2. Data model

All money is `numeric(14,2)`. All calendar dates are `date`. Months are `1..12`. `id` columns are `bigint generated always as identity`.

```sql
-- categories (replaces categories.json)
create table categories (
  id        text primary key,                      -- e.g. 'food'
  label     text not null,
  bg        text not null check (bg ~ '^#[0-9A-Fa-f]{6}$'),
  fg        text check (fg ~ '^#[0-9A-Fa-f]{6}$'), -- null = derived from bg on read (deriveForegroundColor)
  position  int  not null
);

-- expenses (replaces Expenses (YYYY).xlsx, one row per data row)
create table expenses (
  id          bigint generated always as identity primary key,
  year        int  not null check (year >= 2018),
  month       int  not null check (month between 1 and 12),
  position    int  not null,                       -- display order within the month
  amount      numeric(14,2) not null check (amount > 0),
  remarks     text not null check (length(btrim(remarks)) > 0),
  category_id text references categories(id) on update cascade on delete restrict,  -- null only for imported rows with an unrecognised fill colour
  card_note   text,                                -- null = cash; 'CC' or an imported note like 'CC (200)' = card
  constraint expenses_position_unique unique (year, month, position) deferrable initially deferred
);
create index expenses_year_month on expenses (year, month);

-- month locks (replaces Excel sheet protection)
create table month_locks (
  year  int not null,
  month int not null check (month between 1 and 12),
  primary key (year, month)
);                                                 -- row present = locked

-- years ever written (replaces "the year's workbook file exists"); see 2.1
create table ledger_years (
  year int primary key check (year >= 2018)
);

-- finances (replaces Finances.xlsx)
create table finance_months (
  year         int not null,
  month        int not null check (month between 1 and 12),
  salary       numeric(14,2),
  other_income numeric(14,2),
  primary key (year, month)
);
create table savings_balances (                    -- a month's snapshot; no rows = not entered
  year     int not null,
  month    int not null,
  position int not null,
  name     text not null check (length(btrim(name)) > 0),
  amount   numeric(14,2) not null,
  primary key (year, month, position),
  foreign key (year, month) references finance_months (year, month) on delete cascade
);

create table debts (
  id     bigint generated always as identity primary key,
  name   text not null check (length(btrim(name)) > 0),
  amount numeric(14,2) not null                     -- + you owe, − owed to you
);

create table emis (
  id                 bigint generated always as identity primary key,
  card_or_bank       text not null check (length(btrim(card_or_bank)) > 0),
  emi_amount         numeric(14,2) not null check (emi_amount > 0),
  due_day            int  not null check (due_day between 1 and 31),
  total_amount       numeric(14,2) not null check (total_amount >= 0),
  remarks            text not null default '',
  remaining_as_of    numeric(14,2) not null check (remaining_as_of >= 0),
  as_of_date         date not null,
  until_target       date,
  interest_rate      numeric(6,3) check (interest_rate between 0 and 100),
  foreclosure_charge numeric(6,3) check (foreclosure_charge between 0 and 100)
);

create table subscriptions (
  id            bigint generated always as identity primary key,
  service       text not null check (length(btrim(service)) > 0),
  amount        numeric(14,2) not null check (amount > 0),
  duration      text not null check (duration in ('Monthly','Yearly')),
  expiry_anchor date not null,
  card_or_bank  text not null default 'N/A'
);

create table card_bills (
  id       bigint generated always as identity primary key,
  year     int not null check (year >= 2018),
  month    int not null check (month between 1 and 12),
  position int not null,
  name     text not null,
  due      numeric(14,2) not null default 0,
  paid     numeric(14,2) not null default 0,
  due_date date,
  settled  boolean not null default false,
  unique (year, month, position)
);

-- Defence in depth: Supabase's auto-generated Data API must expose nothing.
-- RLS on, zero policies → anon/authenticated roles read and write nothing.
-- The API function connects as the postgres role, which bypasses RLS.
alter table categories       enable row level security;
alter table expenses         enable row level security;
alter table month_locks      enable row level security;
alter table ledger_years     enable row level security;
alter table finance_months   enable row level security;
alter table savings_balances enable row level security;
alter table debts            enable row level security;
alter table emis             enable row level security;
alter table subscriptions    enable row level security;
alter table card_bills       enable row level security;
```

### 2.1 Mapping from the Excel model

| Excel concept | Postgres equivalent |
|---|---|
| Sheet row number used as an id | `id` identity column. The JSON field stays named `row` ([§5](#5-api-contract)). |
| Row order within a month sheet | `position` (0-based, contiguous) |
| Category = cell fill colour | `category_id` foreign key. Colours live only in `categories`. |
| Column C "CC" note | `card_note` (`isCard = card_note is not null`) |
| Sheet protection = month lock | a row in `month_locks` |
| `Expenses (YYYY).xlsx` exists | the year has a `ledger_years` row, expenses or month locks. `appendEntry` is the only write that creates a year. Deleting a year's last entry doesn't un-create it, just as the emptied workbook stayed on disk, so its months still list as `[]` and can still be locked. A year nobody has written to 404s with `No workbook found for year N` on `listMonth`, `setMonthLocked` and the entry writes, checked before the month, and `isMonthLocked` is `false` for it. |
| Savings JSON cell | `savings_balances` rows. No rows means not entered, so carry-forward still uses the last non-empty month. |
| Credit Card Bills JSON cell per month | `card_bills` rows ordered by `position` |
| `.backups/` folder of xlsx copies | Supabase backups, `pg_dump` and the planned Excel export |
| `withFileLock` per file | one transaction per write |

## 3. Domain layer (unchanged behaviour)

These pure functions move from `excel/*` to `domain/*` with no logic changes:

- `dateMath.ts`: `daysInMonth`, `clampDay`, `makeDate`, `addMonths`, `addYears`, `formatDate`, `parseDate`, `startOfDay`
- `emiMath.ts`: `withComputed`, `countDueDatesPassed`, `nextDueDateAfter`, `dueDateOnOrAfter`, `nthFutureDueDate`, `computeOutstandingPrincipal`, `computeForeclosurePayoff`, plus the projection simulation behind `emiMonthlyProjection`
- `subscriptionMath.ts`: `withComputed`, `advanceToOnOrAfter`
- `financeMath.ts`: balance, cumulative, minimum savings, the savings carry-forward and the `previousSavings` baseline. These take plain arrays of month rows, not sheets.
- `categoryColors.ts`: `deriveForegroundColor`, `DEFAULT_CATEGORIES` (seed data)

`today.ts` replaces every bare `new Date()` used as "today" ([ADR-0005](../adr/0005-explicit-app-timezone.md)):

```ts
export function todayInAppZone(now = new Date(), tz = process.env.APP_TIMEZONE ?? "Asia/Kolkata"): Date {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now).split("-").map(Number);
  return new Date(y, m - 1, d); // local-midnight Date for that calendar day, matching dateMath's conventions
}
```

Functions that already accept an injectable `today` parameter keep it, so tests stay deterministic.

## 4. Data access

### 4.1 Client

`postgres` (postgres.js), configured once per process or function instance:

```ts
export const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false,           // required by Supabase's transaction pooler (port 6543)
  max: 1,                   // one connection per function instance; the pooler fans in
  idle_timeout: 20,
  types: { /* see 4.2 */ },
});
```

### 4.2 Driver configuration

- **`date` (OID 1082) → `string`** (`YYYY-MM-DD`). Never a JS `Date`, which shifts by the runtime's offset and causes off-by-one-day bugs. Every domain function already speaks `YYYY-MM-DD` strings.
- **`numeric` (OID 1700) → `number`.** Values are at most 14 digits with 2 decimals, so they're safe as doubles, and the domain code already rounds via `round2`.
- **`int8` (OID 20) → `number`** for ids. Identity values stay far below 2^53.

### 4.3 Transactions

`withTransaction(fn)` wraps `sql.begin`. Per-operation rules:

| Operation | Statement shape |
|---|---|
| `appendEntry` | lock check → `select coalesce(max(position)+1,0) … for update` → insert |
| `deleteEntry` | lock check → delete → `update … set position = position - 1 where position > deleted` |
| `moveEntry` | lock check → shift the positions between `from` and `to` by ±1 → set the moved row's position. Relies on the deferred unique constraint. |
| `setMonthBills` | delete the month's `card_bills` → insert the new array with positions 0..n-1 (the same whole-month replace semantics as today) |
| `setMonthIncome` | upsert into `finance_months` → delete and reinsert the month's `savings_balances` |
| `recordEmiPayment` | `select … for update` → compute the new anchor in the domain layer → update |
| every other single-row write | a single statement, which is atomic on its own |

### 4.4 Month lock enforcement

Every expense write checks `month_locks` inside the same transaction and throws `LedgerError(…, 403)` if the month is locked. That's identical to today's `assertWritable` contract, including the existing e2e check that a direct API write to a locked month gets a 403.

## 5. API contract

The route table, request bodies and response shapes **stay byte-compatible** with the Excel edition, so the client and the e2e suite don't change ([ADR-0004](../adr/0004-express-as-single-netlify-function.md)). The one semantic change: every `row` field and `:row` path parameter now carries the database `id`. It's an opaque, stable integer, no longer a sheet row number.

| Method | Path | Store function |
|---|---|---|
| GET | `/api/categories` | `categories.list` |
| GET | `/api/months/:year/:month` | `ledger.listMonth` |
| GET / PUT | `/api/months/:year/:month/lock` | `ledger.isMonthLocked` / `setMonthLocked` |
| GET | `/api/summary/:year` | `ledger.yearSummary` |
| POST | `/api/entries` | `ledger.appendEntry` |
| PUT / DELETE | `/api/entries/:year/:month/:row` | `ledger.updateEntry` / `deleteEntry` |
| PATCH | `/api/entries/:year/:month/:row/move` | `ledger.moveEntry` (`toRow` is the target entry's id) |
| GET / PUT | `/api/finance/:year/:month` | `finances.getMonthIncome` / `setMonthIncome` |
| GET | `/api/finance-summary/:year` | `finances.financeSummary` |
| GET / POST | `/api/debts` | `debts.listDebts` / `addDebt` |
| PUT / DELETE | `/api/debts/:row` | `debts.updateDebt` / `deleteDebt` |
| GET / PUT | `/api/credit-card-bills/:year/:month` | `creditCardBills.getMonthBills` / `setMonthBills` |
| GET | `/api/credit-card-bills-summary/:year` | `creditCardBills.yearBillsSummary` |
| GET / POST | `/api/emi` | `emi.listEmis` / `addEmi` |
| PUT / DELETE | `/api/emi/:row` | `emi.updateEmi` / `deleteEmi` |
| PATCH | `/api/emi/:row/pay` | `emi.recordEmiPayment` |
| GET | `/api/emi-monthly-projection` | `emi.emiMonthlyProjection` |
| GET / POST | `/api/subscriptions` | `subscriptions.listSubscriptions` / `addSubscription` |
| PUT / DELETE | `/api/subscriptions/:row` | `subscriptions.updateSubscription` / `deleteSubscription` |
| GET | `/api/overview` | `overview.dashboardOverview` |

Errors: `LedgerError(message, status)` → `{ error: message }` with that status, unchanged. Unknown errors → 500 with a generic message. The underlying database error is logged, never returned.

## 6. Authentication

**Client:** `@supabase/supabase-js` with the anon key handles sign-in (email + password) and token refresh. `api.ts`'s shared fetch helper adds `Authorization: Bearer <access_token>`. A 401 response sends the user back to `<SignIn/>`.

**Server (`auth.ts`):** Express middleware on `/api/*`:
1. Read the bearer token and return 401 if it's missing.
2. Verify it with `jose`'s `jwtVerify` against the project's JWKS (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, cached by `createRemoteJWKSet`). Check `iss` and `aud = authenticated`.
3. Require `email === OWNER_EMAIL` (case-insensitive), otherwise 403.

**Supabase project settings:** public sign-ups disabled. The owner account is created once from the dashboard.

**Local development and tests:** `AUTH_DISABLED=true` skips the middleware, and is refused at startup when `NODE_ENV=production` or when running inside Netlify (`process.env.NETLIFY` is set). The e2e suite still exercises real sign-in against the local stack's seeded owner account.

## 7. Netlify packaging

```toml
# netlify.toml
[build]
  command   = "npm run build -w client"
  publish   = "client/dist"
  functions = "netlify/functions"

[functions]
  node_bundler = "esbuild"

[[redirects]]
  from = "/api/*"
  to   = "/.netlify/functions/api/:splat"
  status = 200

[[redirects]]
  from = "/*"
  to   = "/index.html"
  status = 200
```

`netlify/functions/api.ts` exports `handler = serverless(createApp({ basePath: "/.netlify/functions/api" }))`. `createApp` mounts the router at `/api` locally and at the function's own path in production, so `routes.ts` is shared verbatim.

## 8. Import script (`scripts/import-xlsx.ts`)

- **Input:** `--from <folder of .xlsx files>`, `--database-url <url>`, `--dry-run`.
- **Reads** with the legacy readers copied to `scripts/legacy-excel/` before `server/src/excel/` is deleted, so the importer doesn't depend on server code that no longer exists.
- **Writes** everything in one transaction. It refuses to run if any target table already has rows, unless `--force` is passed. That stops a second import from duplicating data.
- **Order:** categories (from `categories.json`, or the defaults) → `ledger_years` (one row per workbook, including one whose sheets are all empty) → expenses (fill colour → category, keeping sheet order as `position`) → month locks (protected sheets) → finances and savings → debts → EMIs → subscriptions → card bills.
- **Report:** per-table row counts, plus every skipped row with its reason (for example an unrecognised fill colour, imported as `category_id = null`).

## 9. Configuration

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | server, function | Postgres connection string (pooler port 6543 in production) |
| `SUPABASE_URL` | server, function, client (`VITE_SUPABASE_URL`) | Auth and JWKS issuer |
| `VITE_SUPABASE_ANON_KEY` | client | Supabase public client key (safe to expose; RLS denies all) |
| `OWNER_EMAIL` | server, function | The only account allowed through |
| `APP_TIMEZONE` | server, function | IANA zone for "today" (default `Asia/Kolkata`) |
| `AUTH_DISABLED` | local only | Skips JWT checks in dev and tests; refused in production |
| `PORT` | local only | Dev server port (`main` worktree: 4100) |

## 10. Testing

| Layer | How |
|---|---|
| Domain | Unit tests on the pure functions, no database |
| Store | vitest against the local Supabase Postgres (`supabase start`, port 54322). Each file truncates the tables it touches in `beforeEach`. `fileParallelism: false`, since the files share one database. |
| API | supertest on `createApp()` covering auth (no token, wrong owner, valid owner) and error mapping |
| End to end | `e2e/regression.ts` and `e2e/screenshots.ts` against the local stack plus the dev server on 4100/5273, with real sign-in as the seeded owner |
| Import | A fixture `.xlsx` folder (built with `scripts/legacy-excel/fixtures.ts`) imported into an empty local database, then checked through the API |

The existing server test cases are the **parity contract**: each one is ported with identical expectations, changing only the setup (database rows instead of scratch workbooks).

## 11. Error handling and logging

- Validation errors become a `LedgerError` with status 400, missing rows 404, locked months 403. These are the same codes as today.
- Input is checked against the column bounds with the shared helpers in `server/src/store/validate.ts`, so some input the Excel edition accepted is now a 400 with a new message. This is deliberate, not a regression. For expenses: an amount that rounds to 0.00 (such as `0.001`) is `Amount must be a positive number`, an amount of 1e12 or more is `Amount is too large`, remarks containing a NUL character are rejected, and `appendEntry` to a year before 2018 is `Invalid year: N`, checked before the month.
- Database constraint violations (`23514` check, `23503` foreign key, `23505` unique) are mapped to 400 or 409 with a readable message.
- Function logs go to Netlify's function log: method, path, status and duration. Request bodies and financial values are never logged.
