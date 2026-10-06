# Low-Level Design: Ledger, hosted edition

**Companion to:** [HLD.md](HLD.md). Decisions referenced as ADR-NNNN live in [../adr/](../adr/).

## 1. Repository layout

```
client/                      React app (the Excel edition's, plus auth and api.ts's bearer header)
  src/auth/                  Supabase client, <SignIn/>, session hook
server/
  src/
    app.ts                   createApp({ basePath }): request log, auth, module gate, JSON body, router, error handler
                             (shared by the local server and the function)
    index.ts                 local entry: createApp() + the built client (npm start only) + app.listen(PORT)
    routes.ts                route table (30 routes from the Excel edition + GET /config)
    auth.ts                  auth config checks + JWT verification middleware (§6)
    modules.ts               ENABLED_MODULES parsing, route → module map, disabled-module 404 (§5.1)
    db/
      client.ts              postgres.js connection + type parsers
      tx.ts                  withTransaction helper
    store/                   one module per concern; same exported function names
      categories.ts  ledger.ts  finances.ts  debts.ts  emi.ts
      subscriptions.ts  creditCardBills.ts  overview.ts
      validate.ts            shared input checks (assertText, assertMoney, isRealDate, isPossibleId)
    domain/                  pure calculations, no I/O (moved verbatim from the Excel edition's excel/*)
      dateMath.ts  emiMath.ts  subscriptionMath.ts  financeMath.ts  creditCardMath.ts  categoryColors.ts
      today.ts               "today" in APP_TIMEZONE
    errors.ts                LedgerError
    dbErrors.ts              SQLSTATE → 400/409 mapping (§11)
  test/                      vitest, against the local Supabase Postgres (api.test.ts: supertest on createApp)
netlify/
  functions/api.ts           serverless-http(createApp(...))
  tsconfig.json              typecheck-only (Bundler resolution, like Netlify's esbuild)
supabase/
  config.toml
  migrations/                timestamped SQL, the only source of schema truth
  seed.sql                   local-only: default categories + a test owner
scripts/
  import-xlsx.ts             one-time Excel → Postgres import: the CLI (§8)
  legacy-excel/              the old Excel readers, kept only for the importer, and
                             importer.ts (the import itself); typecheck-only
                             tsconfig.json; exceljs is a root devDependency
netlify.toml
```

The rule the port followed, and new store code keeps: **store modules kept the Excel modules' exported names and return shapes**, so `routes.ts`, `overview.ts` and the client didn't change. Code that only computes moved into `domain/` untouched.

## 2. Data model

All money is `numeric(14,2)`. All calendar dates are `date`. Months are `1..12`. `id` columns are `bigint generated always as identity`.

`supabase/migrations/` is authoritative; this listing is the net effect of 20261005160517_init_schema, 20261005175741_categories_fg_optional, 20261005184504_ledger_years and 20261005190934_card_bills_name_not_blank. (The `ledger_years` migration also backfills one row per year that already had expenses or month locks.)

```sql
-- categories (replaces categories.json)
create table categories (
  id        text primary key,                      -- e.g. 'food'
  label     text not null check (length(btrim(label)) > 0),
  bg        text not null check (bg ~ '^#[0-9A-Fa-f]{6}$'),
  fg        text check (fg ~ '^#[0-9A-Fa-f]{6}$'), -- null = derived from bg on read (deriveForegroundColor)
  position  int  not null
);

-- expenses (replaces Expenses (YYYY).xlsx, one row per data row)
create table expenses (
  id          bigint generated always as identity primary key,
  year        int  not null check (year >= 2018),
  month       int  not null check (month between 1 and 12),
  position    int  not null check (position >= 0),  -- display order within the month
  amount      numeric(14,2) not null check (amount > 0),
  remarks     text not null check (length(btrim(remarks)) > 0),
  category_id text references categories(id) on update cascade on delete restrict,  -- null only for imported rows with an unrecognised fill colour
  card_note   text,                                -- null = cash; 'CC' or an imported note like 'CC (200)' = card
  constraint expenses_position_unique unique (year, month, position) deferrable initially deferred
);
create index expenses_year_month on expenses (year, month);

-- month locks (replaces Excel sheet protection)
create table month_locks (
  year  int not null check (year >= 2018),
  month int not null check (month between 1 and 12),
  primary key (year, month)
);                                                 -- row present = locked

-- years ever written (replaces "the year's workbook file exists"); see 2.1
create table ledger_years (
  year int primary key check (year >= 2018)
);

-- finances (replaces Finances.xlsx)
create table finance_months (
  year         int not null check (year >= 2018),
  month        int not null check (month between 1 and 12),
  salary       numeric(14,2),
  other_income numeric(14,2),
  primary key (year, month)
);
create table savings_balances (                    -- a month's snapshot; no rows = not entered
  year     int not null,
  month    int not null,
  position int not null check (position >= 0),
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
  position int not null check (position >= 0),
  name     text not null check (length(btrim(name)) > 0),
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

-- Belt and braces (migration revoke_api_roles): anon and authenticated also
-- lose Supabase's default grants on every public table, sequence and
-- function, now and (default privileges) for objects created later, so a
-- table that forgot RLS still isn't reachable through the Data API.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
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

These pure functions moved from the Excel edition's `excel/*` to `domain/*` with no logic changes:

- `dateMath.ts`: `daysInMonth`, `clampDay`, `makeDate`, `addMonths`, `addYears`, `formatDate`, `parseDate`, `startOfDay`
- `emiMath.ts`: `withComputed`, `countDueDatesPassed`, `nextDueDateAfter`, `dueDateOnOrAfter`, `nthFutureDueDate`, `computeOutstandingPrincipal`, `computeForeclosurePayoff`, plus the projection simulation behind `emiMonthlyProjection`, `resolveUntilTarget`, `settleEmiPayment` (the recordEmiPayment rule), `projectEmiMonthly`, `round2`
- `subscriptionMath.ts`: `withComputed`, `advanceToOnOrAfter`
- `financeMath.ts`: balance, cumulative, minimum savings, the savings carry-forward and the `previousSavings` baseline. These take plain arrays of month rows, not sheets.
- `creditCardMath.ts`: `summarize` (per-month due/paid/outstanding totals)
- `categoryColors.ts`: `deriveForegroundColor`, `DEFAULT_CATEGORIES` (seed data)

`today.ts` replaces every bare `new Date()` used as "today" ([ADR-0005](../adr/0005-explicit-app-timezone.md)):

```ts
export function todayInAppZone(now = new Date(), tz = process.env.APP_TIMEZONE || "Asia/Kolkata"): Date {
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
export function getSql(): Sql  // created lazily on first call from DATABASE_URL; closeSql() ends it (tests call it in afterAll)
// getSql() builds the client with:
postgres(process.env.DATABASE_URL!, {
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

`withTransaction(fn)` wraps `sql.begin`. Its callback gets a `Tx` (`db/client.ts`): the transaction `sql`, typed with the client's custom types. Per-operation rules:

| Operation | Statement shape |
|---|---|
| `appendEntry` | month advisory lock (`pg_advisory_xact_lock(hashtext('expenses'), hashtext('<year>-<month>'))`) → lock check → `insert into ledger_years … on conflict do nothing` → `select coalesce(max(position)+1,0)` → insert |
| `updateEntry` | year check → month advisory lock → lock check → `select … for update` the entry (404 unless it's in that month) → update |
| `deleteEntry` | year check → month advisory lock → lock check → find entry → delete → `update … set position = position - 1 where position > deleted` (relies on the deferred unique constraint) |
| `moveEntry` | year check → month advisory lock → lock check → find both entries → shift the positions between `from` and `to` by ±1 → set the moved row's position. Relies on the deferred unique constraint. |
| `setMonthLocked` | year check → month advisory lock → insert/delete the `month_locks` row |
| `setMonthBills` | per-month advisory lock (`hashtext('card_bills')`) → delete the month's `card_bills` → insert the new array with positions 0..n-1 |
| `setMonthIncome` | upsert into `finance_months` (its row lock serialises concurrent saves to that month; last writer wins) → delete and reinsert the month's `savings_balances` at positions 0..n-1 |
| `recordEmiPayment` | `select … for update` → compute the new anchor in the domain layer → update |
| every other single-row write | a single statement, which is atomic on its own |

Every write to one expense month takes the same transaction-scoped advisory lock, so two devices writing to the same month queue rather than interleave. The lock-check-then-write in §4.4 therefore cannot race a concurrent lock toggle. Advisory locks are released at commit or rollback.

Reads that span years use one grouped query, not one per year: `financeSummary` gets every year's monthly expense totals from `ledger.expenseTotalsForYears(2018, uptoYear)`, so a far-future year costs a single round trip.

### 4.4 Month lock enforcement

Every expense write checks `month_locks` inside the same transaction and throws `LedgerError(…, 403)` if the month is locked. That's identical to the Excel edition's `assertWritable` contract, including the existing e2e check that a direct API write to a locked month gets a 403.

## 5. API contract

The route table, request bodies and response shapes **stay byte-compatible** with the Excel edition, so the client and the e2e suite don't change ([ADR-0004](../adr/0004-express-as-single-netlify-function.md)). The one semantic change: every `row` field and `:row` path parameter now carries the database `id`. It's an opaque, stable integer, no longer a sheet row number.

The one addition is `GET /api/config` and the per-deployment module switch ([§5.1](#51-enabled-modules)). With every module enabled (the default) it changes no existing response.

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
| GET | `/api/config` | `{ modules }` from `ENABLED_MODULES` (§5.1); new in this edition |

Errors: `LedgerError(message, status)` → `{ error: message }` with that status, unchanged. Unknown errors → 500 with a generic message. The underlying database error is logged, never returned.

### 5.1 Enabled modules

`ENABLED_MODULES` (§9) chooses which sections a deployment serves ([ADR-0006](../adr/0006-enabled-modules-per-deployment.md)). It is a comma-separated list of `expenses`, `finances`, `debts`, `emi`, `credit-cards` and `subscriptions`, case-insensitive and whitespace-tolerant. Unset or blank enables all of them, which is the behaviour before this setting existed. An unknown name makes `createApp` throw at startup (`parseEnabledModules` in `server/src/modules.ts`).

| Module | Routes (first path segment) |
|---|---|
| always on | `categories`, `config`, `overview` |
| `expenses` | `months`, `summary`, `entries` |
| `finances` | `finance`, `finance-summary` |
| `debts` | `debts` |
| `emi` | `emi`, `emi-monthly-projection` |
| `credit-cards` | `credit-card-bills`, `credit-card-bills-summary` |
| `subscriptions` | `subscriptions` |

- `requireEnabledModule` runs once per request, after auth and before the body parser. A disabled module's route is a 404 `{ error: "<Module> is not enabled on this deployment" }` (`Expenses`, `Finances`, `Debts`, `EMI`, `Credit Cards`, `Subscriptions`). It never reaches a store.
- `GET /api/config` returns `{ "modules": [...] }`, the enabled names in the canonical order above.
- `GET /api/overview` reads only enabled modules' stores. Each `netWorth` figure is `null` when its module is off: `currentSavings` (finances), `totalDebt` (debts), `emiRemaining` (emi), `creditCardOutstanding` (credit-cards). `netWorth.netWorth` is `null` unless all four are on. `emiFreeDate` is `null` without emi. `upcoming` includes Salary only with finances, EMI only with emi, Credit Card only with credit-cards, and Subscription only with subscriptions. With credit-cards off, no EMI is treated as card-billed. With every module on, the response is byte-identical to the Excel edition's.
- The client loads `/api/config` at startup, before rendering any tab. The nav shows Dashboard and then the enabled tabs (Expenses, Credit Cards, Debts, EMI, Subscriptions, Finances). The Dashboard renders the overview only if one of its modules is on, Upcoming only if one of its sources is on, each stat card only when its figure isn't `null`, the EMI projection chart only with emi, and the yearly expense charts only with expenses.

## 6. Authentication

**Client (`client/src/auth/`):** `@supabase/supabase-js`, created from `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (`supabase.ts`), is used for Auth only: email + password sign-in, keeping the session in localStorage and refreshing its access token. Data never goes through it. If either variable is missing from the build, the sign-in screen says so instead of the page failing to load.
- `useSession()` (`session.ts`) follows `onAuthStateChange` (the stored session first, then every sign-in, refresh and sign-out). `App` renders nothing but `<SignIn/>` until a session exists, then the app itself, keyed on the user id so signing out and back in starts it fresh. Config and categories load after sign-in as before, under the same loading overlay.
- `<SignIn/>` (`SignIn.tsx`): email and password only. There's no sign-up or magic-link UI, since sign-ups are disabled and the one account is created by the owner. A failed sign-in shows Supabase's message (e.g. "Invalid login credentials"), and the form is disabled while a sign-in is in flight. It shares the app's header (logo and theme toggle, which also applies the saved theme) and the add-forms' card and input styles.
- `api.ts`'s shared `request()` reads the current session on every call (`supabase.auth.getSession()`, which hands back a refreshed token near expiry) rather than caching a token, and adds `Authorization: Bearer <access_token>`. If that refresh fails (Auth unreachable, a 5xx), supabase-js keeps the stored session but returns none; the call then fails with a "try again" error instead of going out without a token, so a network blip doesn't earn a 401 and sign the owner out. A non-2xx response is thrown as an `ApiError` carrying its `status`.
- A **401** signs out locally (`signOut({ scope: "local" })`: the API already refused the session, so there's nothing to revoke) and returns to `<SignIn/>` with the server's message ("Your session has expired. Sign in again.") as a notice. Requests in flight together can each get the 401; only the first notice is kept.
- A **403** from the auth check (signed in, but not `OWNER_EMAIL`) is recognised on `GET /api/config`, the first request after sign-in. Every route answers a non-owner the same way, and a 403 can't mean "not the owner" everywhere because a locked month's write is also a 403 (§11). `App` then shows "This account is not allowed on this deployment." with the signed-in email and a Sign out button, instead of the app.
- The header has a small icon **Sign out** button next to the theme toggle (local scope: other devices stay signed in). Below 500px wide the month picker moves to its own row under the logo, so both controls stay on screen.

**Server (`auth.ts`):** Express middleware on every API mount (`/api` and the function's base path), ahead of the JSON body parser and the router, so a request without a valid token is a 401 whatever its body and is never parsed:
1. Read the `Authorization: Bearer <token>` header and return 401 `{ error }` if it's missing or not a bearer token.
2. Verify it with `jose`'s `jwtVerify` against the project's JWKS (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, one `createRemoteJWKSet` per process or warm function instance, which caches the keys). Check `iss = ${SUPABASE_URL}/auth/v1` and `aud = authenticated`, allow only the asymmetric algorithms (`ES256`, `RS256`, `EdDSA`), and require the `exp`, `sub` and `email` claims (jose only checks `exp` when it's present, and a token that never expires must not authorize anything). A malformed, expired, wrongly signed, wrong-`iss`/`aud` or `exp`-less token, or one whose `kid` isn't in the JWKS, is a 401. A JWKS fetch failure (timeout, non-200) isn't the caller's fault and goes to the error handler as a 500, so a Supabase Auth outage doesn't look like a sign-out.
3. Require the token's `email`, trimmed and case-insensitive, to equal `OWNER_EMAIL`, otherwise 403 `{ error }`.

The JWKS only publishes **asymmetric** signing keys, so the project must sign access tokens with one (the default for new Supabase projects; a project still on the legacy shared HS256 secret has to migrate to JWT signing keys first). The local stack already does: Supabase CLI 2.x signs with a built-in ES256 key (public, like its demo anon key) and serves it at `http://127.0.0.1:54321/auth/v1/.well-known/jwks.json`, so no `signing_keys.json` is needed. `supabase/config.toml` keeps `[auth.email] enable_signup = true`, because in the CLI that flag switches the whole email provider (password sign-in included) on or off; sign-ups stay off through `[auth] enable_signup = false`.

`createApp` reads the configuration once, at startup (`readAuthConfig`), and throws rather than serve a misconfigured API: `SUPABASE_URL` or `OWNER_EMAIL` missing while auth is on, or `AUTH_DISABLED=true` where it isn't allowed (below). In the function that means a cold start fails loudly.

**Supabase project settings:** public sign-ups disabled. The owner account is created once from the dashboard.

**Local owner account:** `supabase/seed.sql` creates `owner@example.test` with the password `local-owner-password` in the local stack's `auth.users` and `auth.identities` (bcrypt via `extensions.crypt(..., extensions.gen_salt('bf'))`). GoTrue needs the token columns `confirmation_token`, `recovery_token`, `email_change_token_new` and `email_change` to be `''`, not null, or every sign-in fails with "Database error querying schema". The inserts are `on conflict do nothing`, so `e2e/localDb.ts`'s reset, which truncates only the `public` tables and re-runs the seed, keeps the account. The seed is never pushed to a hosted project.

**Local development and tests:** `AUTH_DISABLED=true` (that exact value) skips the middleware. `createApp` refuses it when `NODE_ENV=production` or when running on Netlify: `NETLIFY`, `AWS_LAMBDA_FUNCTION_NAME` or `LAMBDA_TASK_ROOT` is set. `NETLIFY` is a build-time variable that isn't guaranteed inside the function, while the Lambda ones always are. The API tests sign tokens with a key pair generated in the test and inject it through `createApp({ authKeySet })`; the production path always uses the remote JWKS. `npm run dev` and e2e don't use `AUTH_DISABLED`: the gitignored `server/.env` sets `SUPABASE_URL=http://127.0.0.1:54321` and `OWNER_EMAIL=owner@example.test`, and `client/.env` the local stack's URL and anon key, so local development signs in for real as the seeded owner.

## 7. Netlify packaging

```toml
# netlify.toml
[build]
  command   = "npm ci && npm run build -w client"   # installs every workspace from the lockfile
  publish   = "client/dist"
  functions = "netlify/functions"

[build.environment]
  NODE_VERSION = "22"

[functions]
  node_bundler = "esbuild"

[[headers]]
  for = "/*"
  [headers.values]
    Content-Security-Policy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://*.supabase.co; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "no-referrer"

[[redirects]]
  from = "/api/*"
  to   = "/.netlify/functions/api/:splat"
  status = 200

[[redirects]]
  from = "/*"
  to   = "/index.html"
  status = 200
```

`netlify/functions/api.ts` exports `handler = serverless(createApp({ basePath: "/.netlify/functions/api" }))` (`serverless-http`, a root dependency since the function lives at the root). `createApp` always mounts the router (behind auth) at `/api`, and also at `basePath` when one is given, because the path the function receives depends on how it was reached: through the `/api/*` rewrite the event keeps the original `/api/...` path, while a direct call arrives as `/.netlify/functions/api/...`. `serverless-http` passes the event's path through unchanged (its own `basePath` option, which strips a single prefix, isn't used). `routes.ts` is shared verbatim.

Netlify bundles the function with esbuild from the repo root. esbuild resolves the server's ESM `.js` import specifiers to their `.ts` sources and inlines every dependency (including the ESM-only `jose`) into a CommonJS bundle, so no `included_files` are needed. The bundle must stay CommonJS: Netlify emits ESM instead if the root `package.json` gains `"type": "module"` or the file becomes `api.mts`, and that bundle crashes at load (`Dynamic require of "http" is not supported`, from the inlined `serverless-http`), so every request fails. A comment in `api.ts` and `netlify.toml` says so.

The build command keeps `npm ci` deliberately, although Netlify has already installed the dependencies by then: it reinstalls (and skips Netlify's dependency cache), but fails on a lockfile out of step with `package.json` rather than resolving something untested.

**Response headers.** The `[[headers]]` block gives every page a CSP that allows only the site's own scripts, Google Fonts (the logo's font) and connections to itself and `https://*.supabase.co` (Auth), and forbids framing (`frame-ancestors 'none'`, `X-Frame-Options: DENY`): the Supabase session, refresh token included, lives in localStorage, so framing (clickjacking) and injected script are what it has to be kept from. A Supabase custom domain would need adding to `connect-src`. `createApp` itself disables `X-Powered-By` and sends `Cache-Control: no-store` on every API response (the figures are financial, and Express's ETag would otherwise let a browser keep them). The server's static-client serving stays in `index.ts`, out of the function.

Netlify doesn't set `NODE_ENV=production` at function runtime (and it can't go in `[build.environment]`, where it would make `npm ci` skip the client's build tools), so Express would run in `development` mode and its default error page, used for body-parser's 400s, would include the stack trace with the bundle's paths. `createApp` therefore sets Express's `env` to `production` whenever it detects the deployed runtime (the same `NETLIFY`/Lambda check as `AUTH_DISABLED`'s refusal, §6). `netlify/tsconfig.json` typechecks the function (`cd server && npx tsc -p ../netlify/tsconfig.json`).

## 8. Import script (`scripts/import-xlsx.ts`)

`npm run import-xlsx -- --from <folder> [--database-url <url>] [--dry-run] [--force] [--yes]` (or `npx tsx scripts/import-xlsx.ts …`). The CLI only parses arguments and prints. The work is in `scripts/legacy-excel/importer.ts` (`importXlsx`, `readSource`, `formatReport`), which the tests call directly. The self-hoster's how-to is [DEPLOY.md, Moving from the Excel edition](../DEPLOY.md#moving-from-the-excel-edition).

- **Input:** `--from` is the Excel edition's data folder (its `LEDGER_DB_DIR`). `--database-url` defaults to `DATABASE_URL` in `server/.env`. A `DATABASE_URL` in the shell is deliberately ignored, so a value left in a terminal can't redirect the import. The CLI prints the source folder and the target as `host:port/db as user`, never the password (an unparseable URL isn't echoed either). A real import to any host but `localhost`/`127.0.0.1`/`::1` also needs `--yes`; a dry run doesn't. Remote hosts aren't refused outright, since importing into a hosted project is the point. A relative `--from` is resolved against `INIT_CWD` (where `npm run` was typed), not the repository root `npm run` starts the script in. Exit codes: 0 done, 1 fatal (nothing written), 2 usage.
- **Reads** with the legacy readers in `scripts/legacy-excel/`, so it sees exactly what the Excel edition showed. That copy differs from the Excel edition's in three ways. The folder is set with `setDbDir()` instead of being read from `LEDGER_DB_DIR` at module load (one test process imports several fixture folders). `loadCategoryConfig` no longer writes the defaults to a missing `categories.json`, so the source folder is never modified. And it has whole-sheet readers for the importer (`readYearForImport`, `listIncomeRows`, `listBillsRows`, `usedDataRows`) that reuse each module's own row parsing (`listMonth` and `readYearForImport` share one parser). The importer also imports `server/src/store/validate.ts` (`assertMoney`, `isRealDate`), so its rules are the store's.
- **Fatal** (nothing written, exit 1): the folder is missing or holds none of the Excel edition's files; Excel has one of them open (a `~$<name>` owner file is in the folder, so unsaved changes would be missed; a leftover one from a crash has to be deleted); two files' names differ only in case, or one differs from the Excel edition's name only in case on a file system where the readers' fixed name doesn't find it (file names are otherwise matched ignoring case, as Windows opened them, so `debts.xlsx` is imported); a workbook can't be read or lacks its sheet; `categories.json` is invalid (the Excel edition refused it too); the database already has data (below); any database error.
- **Writes** everything in one transaction, which first takes `lock table … in exclusive mode` on every import table, so the emptiness check can't race a write from the app. A write is only delayed, though: an app request that read `categories` as empty mid-import inserts the missing defaults right after the import commits, so the site must not be in use during an import (DEPLOY says so). It refuses if any import table has rows, except a `categories` table holding exactly the four defaults (what `seed.sql` and the app's first load create), which it replaces. `--force` instead truncates all ten tables (`restart identity`) inside the same transaction, so a failed forced import leaves the old data in place. There is deliberately no `cascade`: every table that references these is in the list, and a table a later migration adds that references one of them makes `--force` fail until it is added to the list and the docs on purpose, rather than being emptied unlisted. Rows go in as multi-row inserts of up to 1000 rows, in sheet order, so ids follow the Excel row order.
- **`--dry-run`** does all of the above inside the transaction, so every database constraint is checked for real, then rolls it back.
- **Order and mapping:** categories (`categories.json` in file order as `position`, or the defaults; a missing `fg` stays null) → `ledger_years` (one row per `Expenses (YYYY).xlsx`, including one whose sheets are all empty) → expenses (only the rows `listMonth` returns: fill colour → category, sheet order as a contiguous `position`, column C as `card_note`) → month locks (protected month sheets) → `finance_months` and `savings_balances` (the first row for a month, which is the one `getMonthIncome` read; it is the first even when it is skipped, so a later row for that month never stands in for it) → debts → EMIs → subscriptions → card bills (the first row for a month). Only stored inputs are imported. EMI remaining and payoff dates, subscription next expiry and the finance series are computed on read by the domain layer (§3), never stored.
- **Nothing is silently altered.** A row a column can't hold is skipped and listed: an amount that is 0, negative where it can't be, rounds to 0.00 or is 1e12 or more; blank remarks or names; a NUL character; a year before 2018 (for an expense workbook, the whole workbook); a month outside 1–12; an impossible date (`2024-02-30`, which the Excel edition clamped); a due day that isn't a whole number from 1 to 31; a percentage outside 0–100; a second row for the same month in Finances or CreditCardBills. Within a month's savings or card list only the bad entry is skipped. Some rows are imported with a listed difference: an expense whose fill colour matches no imported category (`category_id = null`), a value with more decimals than its column keeps (Postgres rounds the decimal postgres.js sends, half away from zero, and the report shows that same value, e.g. 1.005 → 1.01; float noise isn't reported), an invalid `fg` (stored null, derived on read), and a cell the Excel edition read as empty (text in Salary, unparseable savings or card JSON).
- **Report:** per-table row counts, the tables `--force` emptied, every skipped row and every difference with its file, sheet and row, the non-empty rows and sheets the Excel edition never read either (a formula Amount, an incomplete debt, a sheet that isn't a month), and any other files in the folder.

## 9. Configuration

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | server, function | Postgres connection string (pooler port 6543 in production) |
| `SUPABASE_URL` | server, function | Auth and JWKS issuer |
| `VITE_SUPABASE_URL` | client (build time) | The same project URL, for supabase-js sign-in. Local: `http://127.0.0.1:54321` |
| `VITE_SUPABASE_ANON_KEY` | client (build time) | Supabase public client key (safe to expose; RLS denies all). Local: the CLI's demo anon key from `npx supabase status` |
| `OWNER_EMAIL` | server, function | The only account allowed through |
| `APP_TIMEZONE` | server, function | IANA zone for "today" (default `Asia/Kolkata`) |
| `AUTH_DISABLED` | local only | `true` skips JWT checks; refused under `NODE_ENV=production`, `NETLIFY`, `AWS_LAMBDA_FUNCTION_NAME` or `LAMBDA_TASK_ROOT`. `npm run dev` and e2e don't use it (they sign in as the seeded owner), and e2e refuses to run with it set |
| `ENABLED_MODULES` | server, function | Comma-separated sections to serve: `expenses`, `finances`, `debts`, `emi`, `credit-cards`, `subscriptions`. Unset or blank = all. Unknown names fail at startup (§5.1, [ADR-0006](../adr/0006-enabled-modules-per-deployment.md)) |
| `PORT` | local only | Dev server port (default 4000; a second checkout running alongside another sets its own, e.g. 4100) |
| `VITE_DEV_PORT` | local only | Vite dev server port (default 5173; e.g. 5273 in a second checkout). `scripts/kill-ports.js` reads it too |
| `VITE_API_PROXY_TARGET` | local only | Where the Vite dev server proxies `/api` (default `http://localhost:4000`); must match `PORT` |

## 10. Testing

| Layer | How |
|---|---|
| Domain | Unit tests on the pure functions, no database |
| Store | vitest against the local Supabase Postgres (`supabase start`, port 54322). Each file truncates the tables it touches in `beforeEach`. `fileParallelism: false`, since the files share one database. |
| Modules | `server/test/modules.test.ts` (parsing `ENABLED_MODULES`) and `server/test/overviewModules.test.ts` (`dashboardOverview` per module subset, with spies proving a disabled module's store is never called) |
| API | `server/test/api.test.ts`: supertest on `createApp()` with a test-generated ES256 key pair injected as the JWKS. Covers enabled modules (every route mapped to a module or always on, `/api/config`, a 404 on every route of each disabled module, an expenses-only overview, unknown names failing at startup), auth (no token, malformed, unknown key, unknown `kid`, expired, no `exp`, wrong `aud`/`iss`, non-owner 403, owner 200, JWKS fetch failure 500, malformed JSON without a token 401), the startup checks (missing config, `AUTH_DISABLED` refused in production and on Netlify/Lambda), error mapping (including what a mapped database error logs, and no stack trace in a deployed 400), the request log's contents, and the Netlify handler invoked with API Gateway v1 events on both path shapes |
| End to end | `e2e/regression.ts`, `e2e/expensesOnly.ts` and `e2e/screenshots.ts` against the local stack plus the dev server on this checkout's `PORT`/`VITE_DEV_PORT`, with real auth: each script signs in through `<SignIn/>` as the seeded owner (§6) and makes its own direct API calls with the owner's token from the local Auth API (`e2e/auth.ts`). Before starting, `assertLocalAuth` refuses a `SUPABASE_URL` (`server/.env`) or `VITE_SUPABASE_URL` (`client/.env`) whose host isn't `127.0.0.1`/`localhost` (the same guard as `localDb.ts`'s for the database), a missing `OWNER_EMAIL` or anon key, and `AUTH_DISABLED=true`. `startDevServer` passes the `.env` files' auth settings to the spawned server explicitly, so values left in the calling shell can't override them. `regression.ts` also checks that a request without a token is a 401, a wrong password's error, sign-out (which survives a reload and keeps the theme), the not-allowed screen for a 403 (simulated on `/api/config` with `page.route`, since the local stack has only the owner and sign-ups are off) and its Sign out, and a mid-session 401 (a tampered token) signing out with a notice. `npm run test:e2e` then runs `e2e/expensesOnly.ts`, which starts the server with `ENABLED_MODULES=expenses` in its environment (never by editing `.env`) and checks the 401 without a token, the wrong-password error and sign-in, the two-tab nav, expense add/edit/delete, a Dashboard with no disabled-module cards or console errors, a disabled route's 404, and sign-out. `npm run screenshots` (`e2e/screenshots.ts`) seeds a fictional dataset, checking each tab is empty before writing into it (through its form) and checking this month's expenses and last month's income through the API before the first write, then seeding those two through the API after every tab's check. "This month" is taken in `APP_TIMEZONE`, and the browser runs in that zone too. It writes every image in `docs/screenshots/`: the Dashboard at 1280×960 and each tab full-page at 720px wide, light and dark. All three scripts share `e2e/devServer.ts` and `e2e/auth.ts` |
| Docs | `server/test/envDocs.test.ts`: every variable the server, function, client and `scripts/kill-ports.js` read is documented in `server/.env.example` or `client/.env.example`, every `# NAME=` example there is still read, and every variable a deployment sets appears in §9 and `docs/DEPLOY.md` |
| Import | `server/test/importXlsx.test.ts`: fixture folders built in a temp directory with `scripts/legacy-excel/fixtures.ts` (fictional data) and imported into the local database. A clean folder is read back through the store modules (`loadCategoryConfig`, `listMonth`, `yearSummary`, `isMonthLocked`, `getMonthIncome`, `financeSummary`, `listDebts`, `listEmis` and `listSubscriptions` with their computed fields, `getMonthBills`, `yearBillsSummary`) and compared with the legacy readers on the same folder, `row` aside. A messy folder checks each skip, difference and ignored-row report, including a skipped first Finances row for a month that a later row must not replace, and a 1.005 reported and stored as 1.01. Also: an all-empty workbook still creates its year; a non-empty database is refused (dry run too) and left unchanged; `--force` replaces rather than duplicates; a dry run writes nothing; the default categories are replaced but custom ones refuse; the source folder is never modified; file names match ignoring case; an Excel `~$` owner file refuses the import; and the CLI refuses a remote host without `--yes`, never prints the password, rejects bad usage, resolves a relative `--from` against `INIT_CWD` and prints a dry run's report |

The Excel edition's server test cases were the **parity contract** for the port: each one was ported with identical expectations, changing only the setup (database rows instead of scratch workbooks).

## 11. Error handling and logging

- Validation errors become a `LedgerError` with status 400, missing rows 404, locked months 403. These are the same codes as the Excel edition's.
- Input is checked against the column bounds with the shared helpers in `server/src/store/validate.ts`, so some input the Excel edition accepted is now a 400 with a new message. This is deliberate, not a regression. For expenses: an amount that rounds to 0.00 (such as `0.001`) is `Amount must be a positive number`, an amount of 1e12 or more is `Amount is too large`, remarks containing a NUL character are rejected, and `appendEntry` to a year before 2018 is `Invalid year: N`, checked before the month. The 403 for a locked month now reads `<Month> <year> is locked. Unlock it first from the app if you really need to add an entry there.` (the Excel edition also suggested unlocking "in Excel directly", which this edition has no way to do).
- Any database refusal that slips past `validate.ts` is mapped by `server/src/dbErrors.ts` (`mapDatabaseError`, applied in `app.ts`'s error handler) to a generic client error: 22021/22P05 invalid character, 22003 out of range, 22007/22008 invalid date, 22P02 invalid input, 23502 not-null, 23514 check and 23503 foreign key → 400, and 23505 unique → 409 (a deferred `expenses_position_unique` violation surfaces at COMMIT and maps the same way). For these mapped errors only the SQLSTATE and constraint name are logged, because Postgres's message and detail echo the offending input (`invalid input syntax for type numeric: "..."`, `Key (...)=(...)`). Neither is ever returned. Unmapped errors become a generic 500. A Postgres one is logged as its SQLSTATE, routine and constraint/table/column names, plus its message only for classes that never quote a row (08 connection, 28 authentication, 3D, 42 missing table or column, 53/54, 57/58, XX, e.g. the pooler's "Tenant or user not found"); its `detail` and `where`, which echo row values, never are. Any other error is logged with its stack.
- `app.ts` logs one line per request, `<METHOD> <path> <status> <ms>ms` (to Netlify's function log in production, the console locally). The path excludes the query string. Request bodies and headers (so tokens) are never logged, and neither is the input echoed by a mapped database error (above). The message of a non-database 500 is the one place a value could still appear.
- body-parser's own client errors (malformed JSON) still get Express's default response, as they did before the error handler moved from `routes.ts` to `app.ts`. They are only reachable after authentication, and in the deployed function the page carries no stack trace (§7).
