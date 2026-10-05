# Ledger

A personal-finance web app for one person: day-to-day expenses, monthly
income and savings, debts, loans/EMIs, credit card bills and subscriptions,
plus a Dashboard that combines them.

This is the **hosted edition**. Each copy runs on its own
[Netlify](https://www.netlify.com) site (the website and the API) and
[Supabase](https://supabase.com) project (Postgres and sign-in), on their
free tiers, with exactly one user: the owner. Every request needs the
owner's sign-in. A copy can show every section or only some of them
(`ENABLED_MODULES`), for example expenses only.

- To stand up your own copy, follow **[docs/DEPLOY.md](docs/DEPLOY.md)**.
- For how it's built, see [ARCHITECTURE.md](ARCHITECTURE.md), and for the
  design detail (schema, API contract, auth, configuration) the
  [HLD](docs/architecture/HLD.md), [LLD](docs/architecture/LLD.md) and
  [ADRs](docs/adr/README.md).
- This file covers what each part of the app does and why, domain-wise, plus
  local development and testing.

Contents:

- [Why this exists](#why-this-exists)
- [See it in action](#see-it-in-action)
- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [Local development](#local-development)
- [Configuring categories](#configuring-categories)
- [Choosing sections (ENABLED_MODULES)](#choosing-sections-enabled_modules)
- [Deploying](#deploying)
- [Testing](#testing)
- [Notes / gotchas](#notes--gotchas)

## Why this exists

I'd tracked every expense by hand in Excel since 2018: one workbook per
year, one sheet per month, each row's category marked by coloring the cell
(yellow for food, blue for transport, and so on), plus a note for anything
paid by credit card. Typing into Excel on a phone was clunky, so Ledger
started as a small web app that read and wrote those same workbooks in
place, reachable from a phone over a private network. The same idea then
took over everything else a second, more fragile macro-enabled workbook
used to track by hand (credit card bills, loans, subscriptions, debts,
savings), computing automatically whatever the old sheet needed retyping (a
loan's remaining balance, a subscription's next renewal, a month's savings
target).

That edition still exists, on the `personal` branch, with Excel as its
source of truth. Its one hard limit is that a phone can only reach it while
the home PC is online. This edition keeps the same app, the same
calculation rules and the same API, and moves storage to Postgres on
managed hosting, so it works from anywhere and anyone can run their own
copy ([HLD §1–2](docs/architecture/HLD.md)). There's no Excel at runtime. A
one-time importer for existing workbooks is planned
([LLD §8](docs/architecture/LLD.md#8-import-script-scriptsimport-xlsxts))
but isn't part of this edition yet: a new copy starts empty.

## See it in action

*(Screenshots use made-up sample data, not anyone's real finances.)*

**Dashboard**: Net Worth and an Upcoming list combining every EMI due date,
subscription renewal, and outstanding credit card bill in the next two
weeks, above a yearly spending chart. Supports light and dark themes:

| Light | Dark |
|---|---|
| ![Dashboard, light theme](docs/screenshots/dashboard.png) | ![Dashboard, dark theme](docs/screenshots/dashboard-dark.png) |

**Adding an expense**: pick a category by color, mark it cash or card, and
it's added to the end of that month's list:

| | Light | Dark |
|---|---|---|
| Filling out the form | ![Add Expense form filled in, light theme](docs/screenshots/add-expense.png) | ![Add Expense form filled in, dark theme](docs/screenshots/add-expense-dark.png) |
| Saved, showing in the month's list | ![New entry appears in the list, light theme](docs/screenshots/recent-entries.png) | ![New entry appears in the list, dark theme](docs/screenshots/recent-entries-dark.png) |

**Finances**: Salary/Other Income, and a delta-based Current Savings
editor (type a deposit or withdrawal, not the running total; see
[How it works](#how-it-works)):

| Light | Dark |
|---|---|
| ![Finances tab, light theme](docs/screenshots/finances.png) | ![Finances tab, dark theme](docs/screenshots/finances-dark.png) |

**Debts**: a sortable flat list of who owes whom, colored red/green by
whether it's money you owe or money owed to you:

| Light | Dark |
|---|---|
| ![Debts tab, light theme](docs/screenshots/debts.png) | ![Debts tab, dark theme](docs/screenshots/debts-dark.png) |

**Credit Cards**: per-card monthly bills with a Settled checkbox, plus
month and year-to-date totals:

| Light | Dark |
|---|---|
| ![Credit Cards tab, light theme](docs/screenshots/credit-cards.png) | ![Credit Cards tab, dark theme](docs/screenshots/credit-cards-dark.png) |

**EMI**: active loans with an auto-decaying Remaining balance (no manual
monthly upkeep) and an estimated or bank-stated payoff date:

| Light | Dark |
|---|---|
| ![EMI tab, light theme](docs/screenshots/emi.png) | ![EMI tab, dark theme](docs/screenshots/emi-dark.png) |

**Subscriptions**: recurring services with a renewal date that
auto-advances to the next real cycle, never silently going stale:

| Light | Dark |
|---|---|
| ![Subscriptions tab, light theme](docs/screenshots/subscriptions.png) | ![Subscriptions tab, dark theme](docs/screenshots/subscriptions-dark.png) |

## How it works

- **Signing in.** The app opens on an email-and-password sign-in form.
  There's no sign-up: each copy has one account, the owner's, created in the
  Supabase dashboard, and the API refuses every other account. A session is
  remembered per device until you tap the sign-out icon in the header
  (signing out on one device leaves the others signed in). If the API
  rejects a session (for example it expired), the app returns to the
  sign-in form with a notice. A signed-in account that isn't the owner
  sees "This account is not allowed on this deployment." with a Sign out
  button instead of the app. Details: [LLD §6](docs/architecture/LLD.md#6-authentication).
- **Expenses.** Each month is an ordered list of entries. An entry is an
  **amount**, **remarks**, a **category**, and whether it was paid in
  **cash or by card**. There's no date per entry: entries are just in
  order within their month, and new ones are added at the end.
- **Categories** are colors. The default 4 (Yellow = Food, Blue =
  Transportation, Orange = Rent, Red = Other/non-recurring) come from the
  color-coding the original spreadsheets used, but the set is configurable
  per copy; see [Configuring categories](#configuring-categories).
- Any month can be **locked**. A banner above the entry form shows whether
  the month you're viewing is locked and lets you toggle it. The lock is
  enforced by the server, not just the UI: a write to a locked month is
  refused with a 403. A month only locks when you say so (an earlier rule
  auto-locked everything but the current month, which made a forgotten
  entry uneditable). Copying, editing, deleting and reordering are
  unavailable in the UI while a month is locked. Copy/Edit/Delete live under
  a "⋮" menu on each entry. Deleting removes the entry and closes the gap,
  rather than blanking it. Reordering (drag the ⠿ handle) moves the entry
  for real, and is driven by Pointer Events rather than the HTML5
  drag-and-drop API, since the latter never fires on touch (mobile Safari/
  Chrome). The "⋮" menu also has **Move up**/**Move down**, for a keyboard
  or when the handle is inconvenient. The handle itself is `aria-hidden`, so
  this is the only reorder path a screen reader can reach. Copy adds a
  brand new entry with the same amount/remarks/category/card status,
  appended at the end like any other, never linked back to the original.
- Adding an entry to a year nobody has written to yet (next January, say)
  starts that year automatically. Until then, browsing a month in that year
  shows "No workbook found for year N" below the form (wording kept from the
  Excel edition for API compatibility); the form still works. On a new
  copy that's every year, until the first expense is added.
- The app opens on the **Dashboard** tab. It shows a stacked bar chart of
  category totals per month for a selected year, computed live from the
  expenses (no separate storage), with a year selector independent of the
  Expenses view's month/year. Clicking any month's bar (even an empty one)
  jumps to Expenses with that month/year selected. Expenses also has its
  own nav tab, right after Dashboard. The nav bar is ordered Dashboard,
  Expenses, Credit Cards, Debts, EMI (Equated Monthly Installment, the
  standard Indian-banking term for a fixed loan repayment), Subscriptions,
  Finances. Below a ~600px viewport (a phone), "Dashboard", "Expenses",
  "Credit Cards" and "Subscriptions" shorten to "Home", "Spend", "CC Bills"
  and "Subs", and the nav's spacing tightens, so all seven tabs fit on one
  row. A copy can turn sections off with `ENABLED_MODULES`; their tabs and
  Dashboard cards then don't show (see
  [Choosing sections](#choosing-sections-enabled_modules)).
- The Dashboard also has an **overview widget** above the yearly chart: a
  **Net Worth** figure (Current Savings − Total Debt − EMI Remaining − this
  month's unpaid Credit Card bills, all pulled live from their own tabs) and
  an **Upcoming (next 2 weeks)** list combining every EMI due date,
  Subscription renewal, and outstanding Credit Card bill due in that window,
  sorted soonest-first. It's the one place that reads across every other
  tab, and nothing writes through it. Converting a purchase to EMI on a
  credit card bills it through that card's own monthly bill, so an EMI
  whose Card/Bank name matches a card that also has its own Credit Card
  Bill entry that month is left out of Upcoming (that card's own line
  already represents it), while a standalone loan not billed through any
  card still shows. This is worked out against whichever names actually
  appear in Credit Card Bills, not a hardcoded list, so a newly added card
  is picked up automatically. Net Worth's EMI Remaining still counts every
  EMI's *full* balance, including card-linked ones; excluding them there
  would understate real debt by everything beyond the current month's
  installment. The **Credit Cards Owed (This Month)** figure means this
  month's total bill across every card minus whatever's already been paid
  toward it (floored at 0), for every card not marked **Settled**. It's a
  single-cycle number, not a running credit card balance. A card checked
  off as Settled contributes exactly 0 here and is dropped from Upcoming
  entirely, whatever its raw due/paid gap, because payment apps routinely
  round a bill down by a rupee or two, and a card that's actually been paid
  off shouldn't still read as "owed". An EMI's Upcoming due date is computed
  from its own stored snapshot date, not just "today", so clicking **Paid
  this month** (or **Record payment**) advances which cycle shows as
  upcoming next. The header shows the total across every Upcoming item, and
  since it lives in the header rather than the list, it's still visible
  when Upcoming is collapsed. On a phone-width screen the "(next 2 weeks)"
  part of the heading drops to just "Upcoming". Upcoming's header is a
  fold/collapse toggle: open by default, and it remembers the state you
  last left it in (`localStorage`, like the theme toggle). It folds via an
  animated `grid-template-rows` 1fr↔0fr transition, so collapsing it visibly
  shrinks to a single-line card. Each Upcoming row is clickable, as a
  shortcut to go pay or settle it: an EMI item jumps to the EMI tab, a
  Subscription item to Subscriptions, and a Credit Card item to Credit Cards
  *on the month that bill is actually due*. Upcoming also carries a
  **salary reminder**: since salary is logged under the month it was
  *earned* (see Finances below), a new calendar month starting means last
  month's entry should already exist. If it doesn't, a reminder to log it
  appears (sorting first) for the first two weeks of the new month, then
  goes quiet either way. Clicking it jumps to Finances with last month
  selected. Below that widget, an **Upcoming EMIs** chart plots every active
  loan's future installments for the next year (installment count and total
  ₹ due per calendar month), so the debt load's monthly taper is visible at
  a glance. When a section is off, its figures, Upcoming items and chart
  don't appear, and Net Worth only shows when Finances, Debts, EMI and
  Credit Cards are all on.
- "Today" (for due dates, renewals, the salary reminder) is the calendar
  day in the copy's `APP_TIMEZONE`, not the server's clock, which runs in
  UTC ([ADR-0005](docs/adr/0005-explicit-app-timezone.md)).
- The **Finances** tab tracks Salary, Other Income, and a Current Savings
  snapshot per month. From those entries it computes:
  - **Balance**: last month's total income (salary + other income) minus
    this month's expenses. A month with no income on record counts as zero,
    so it shows as a real deficit rather than "unknown".
  - **Cumulative**: running sum of Balance since 2018.
  - **Minimum Savings**: `ceil(15% of this month's own salary + other income)`.
  - **Money Earned / Money Spent**: running totals of income / expenses
    since 2018.
  - **Current Savings**: named scheme balances (PPF, NPS, APY, etc.),
    summed into a total. Entry is delta-based, not absolute: each scheme
    shows its last known balance (carried forward from whichever month it
    was last touched) and you pick **Deposit** or **Withdrawal** and type
    the change; the app computes and stores the new absolute balance. Sign
    is a toggle, not something you type, since a phone's numeric keypad has
    no "-" key (see [SignedAmountInput](#notes--gotchas)). For a scheme with
    no prior balance, the first amount you enter becomes its starting
    balance. The stored data is still a plain absolute balance per scheme
    per month, so a scheme's figure can always be corrected by entering
    whatever deposit/withdrawal reconciles it to the real statement. The set
    of schemes isn't fixed. Whichever month's breakdown was most recently
    entered carries forward across later months until you update it again.

  The Save button stays disabled until something on the form actually
  differs from what's on record. Finances reads expense totals for its
  Balance even when the Expenses section is turned off.
- The **Debts** tab is a flat list of who you owe and who owes you. It's
  current state, not a monthly history. Each entry is a name and a single
  signed amount you update directly when it changes (positive = you owe
  them, negative = they owe you). The displayed total is a plain sum of
  every entry. Sortable by Name, Amount, or Type (groups owed-to-you vs
  you-owe apart); click a sort button again to flip ascending/descending.
  **You owe** and **Net** (when positive, meaning you owe more overall) are
  red; **Owed to you** (and Net when negative) is green: bad/good coloring,
  not "positive number = green". The Add Debt button stays disabled until
  both Name and Amount are filled in. Adding an entry whose name matches an
  existing one (case-insensitive) asks whether to **consolidate** the new
  amount into that entry (a plain sum, correct regardless of sign, so a
  partial repayment nets down the debt) or add it as a separate entry.
- The **Credit Cards** tab tracks each card's bill as its own named entry
  per month (due amount, paid amount, that card's due date, and a
  **Settled** checkbox). The number of cards isn't fixed. Cards can be
  dragged into any order (the same Pointer Events mechanism as reordering
  expenses); the saved list's order is what persists. From those entries it
  computes Total Due, Total Paid, the Earliest Due Date across all cards
  that month (so you know when to arrange funds), and Overpaid/Saved (Due −
  Paid, summed only across cards marked **Settled**: negative means you
  paid more than billed, positive means a payment app rounded a few rupees
  in your favor), red when Overpaid and green when Saved. Gating it on
  Settled keeps a still-unpaid bill from reading as "Saved"; Total Due/Total
  Paid still sum every card. Settled also affects the Dashboard's Net
  Worth/Upcoming (see above). It also shows yearly totals (Total Spent This
  Year, Total Paid This Year, Net Overpaid/Saved This Year) across all 12
  months of the selected year. Save stays disabled until the form has an
  unsaved change.
- The **EMI** tab is a flat list of active loans/EMI plans (Card/Bank, EMI
  Amount, Due Day, Total Amount, Remarks). Remaining is **auto-computed**:
  you enter the real current balance once (from the bank/card statement)
  and the app decreases it by the EMI Amount every time the due day passes.
  The estimated payoff month is computed the same way (Remaining ÷ EMI
  Amount) rather than typed in, so it can't drift out of sync with the
  balance. Foreclosed or fully-paid loans are removed via a dedicated
  **Foreclose EMI** action; the plain Edit/Delete menu is still there for
  correcting mistakes. Current Balance defaults to Total Amount when adding
  a fresh loan, so you only override it for one that's already partway
  through. An optional Duration (months) field, the number of months the
  bank stated at conversion time, is stored as a real payoff target
  (`Until Target`, an exact date) rather than derived, since a bank's
  final installment is often adjusted to land on the stated date. Once set,
  the target survives ordinary balance corrections and payments, and only
  changes if you enter a fresh Duration on a later edit. Each entry has
  quick payment actions, **Paid this month** (subtracts one EMI Amount) and
  **Record payment** (a custom amount, for a partial or extra payment).
  Both anchor the new balance snapshot to *this month's due date* rather
  than the day you click, so paying a few days early doesn't get
  double-subtracted once the due date passes, and paying the standard
  amount after the due date has passed is a no-op (the automatic decay
  already assumed it). Each row also shows **`Balance as of <date>`**, the
  anchor everything since is projected from. Sortable by Name, Due Day, EMI
  Amount, Remaining, or **% Paid**. An **EMI-Free On** stat (also on the
  Dashboard) shows the latest payoff date across every active loan: the day
  the *last* loan clears. It uses the same due-date logic as each loan's own
  estimate, rolling into the following month when a bank-stated target's
  day-of-month falls before the loan's due day (an Until Target of
  2030-05-23 with a due day of 9 actually finishes 2030-06-09).
  - **Foreclosure decision support**: each row shows a percent-paid
    progress bar (`(totalAmount − remaining) / totalAmount`); sorting by
    **% Paid** surfaces the best "quick win" foreclosure candidate better
    than raw Remaining. Optional **Interest Rate (% p.a.)** and
    **Foreclosure Charge (%)** fields are editable per loan (`0` is a real
    value, distinct from blank). With an Interest Rate on record, each row
    also shows a **Foreclosure payoff**: the true cost to close the loan
    today (standard reducing-balance amortization of the outstanding
    principal, plus any Foreclosure Charge), shown only when it differs
    from Remaining, which is total future payments including interest.
  - The Dashboard's **Upcoming EMIs** chart projects every active loan's
    installments for the next year as a dual-axis bar (installment count) +
    line (total ₹ due) chart per calendar month.
- The **Subscriptions** tab is a flat list (Service, Amount, Monthly/Yearly,
  Card/Bank), sortable by Next Renewal (default, soonest first), Service, or
  Amount. The renewal date you enter is never treated as stale: the app
  advances it by whole Monthly/Yearly cycles until it's on or after today,
  so a long-untouched entry always shows its real next renewal. Shows an
  approximate combined Monthly Cost (Yearly subscriptions divided by 12).
- Derived figures (EMI Remaining and payoff dates, next renewals, Finances'
  computed rows, the whole Dashboard overview) are computed on every read
  and never stored, so they can't go stale.
- Every tab shows a spinner over a faded backdrop while its data loads,
  keeping the previous content visible underneath instead of flashing to
  blank.
- Light/dark theme: a sun/moon slider in the header (top right). The choice
  is saved to `localStorage` and wins over the OS preference once set;
  before any explicit choice, it follows `prefers-color-scheme`.
- **Your data** lives in the copy's own Supabase Postgres database. Every
  table has row-level security on with no policies, and the public roles
  have no privileges on it, so Supabase's public data API can't read it; only the app's API, after checking the owner's
  sign-in, can. Free Supabase projects have no restorable backups and pause
  after about a week unused. See [DEPLOY.md](docs/DEPLOY.md#backups) for
  taking your own backup and unpausing.

## Project layout

```
client/     React 19 + Vite app. src/components/ (one .tsx + .css per piece),
            src/auth/ (Supabase sign-in, session, sign-out), src/api.ts
            (every API call, with the owner's token).
server/     Express API (TypeScript).
  src/      app.ts (createApp: logging, auth, section gate, routes, errors),
            routes.ts, auth.ts, modules.ts, index.ts (local entry point),
            db/ (Postgres client, transactions), store/ (SQL, one module per
            concern), domain/ (pure calculations, no I/O).
  test/     vitest suites, run against the local Supabase Postgres.
netlify/    functions/api.ts: the whole API as one Netlify Function.
supabase/   config.toml (local stack), migrations/ (the schema),
            seed.sql (local only: default categories + a test owner).
e2e/        Playwright scripts: regression, expenses-only pass, screenshots.
scripts/    kill-ports.js (frees this checkout's dev ports);
            legacy-excel/ (old Excel readers, kept for the planned importer).
docs/       DEPLOY.md, architecture/ (HLD, LLD), adr/, screenshots/.
netlify.toml
```

[LLD §1](docs/architecture/LLD.md#1-repository-layout-target) lists every
module.

## Local development

**Prerequisites:** [Node.js](https://nodejs.org) 22+, git, and
[Docker](https://www.docker.com/products/docker-desktop/) (Docker Desktop
on Windows/macOS) for the local Supabase stack. The Supabase CLI runs
through `npx supabase`.

1. **Get the code and install.** This is an npm-workspaces monorepo: one
   install at the root covers `server/`, `client/` and the e2e scripts.

   ```
   git clone <repository URL>
   cd ledger
   npm install
   ```

2. **Start the local Supabase stack** (Postgres on 54322, API on 54321,
   Studio on 54323, Mailpit on 54324). The first run pulls Docker images.

   ```
   npx supabase start
   npx supabase db reset   # applies supabase/migrations + supabase/seed.sql
   ```

   The seed creates the default categories and a local owner account,
   `owner@example.test` with password `local-owner-password`. It's never
   applied to a hosted project.

3. **Create the `.env` files** from the examples, which document every
   variable the code reads. Both are gitignored.

   - `server/.env` from `server/.env.example`:

     ```
     DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
     SUPABASE_URL=http://127.0.0.1:54321
     OWNER_EMAIL=owner@example.test
     ```

   - `client/.env` from `client/.env.example`: `VITE_SUPABASE_URL` and
     `VITE_SUPABASE_ANON_KEY`, both printed by `npx supabase status`
     (the URL is `http://127.0.0.1:54321`).

4. **Run it:**

   ```
   npm run dev
   ```

   This starts the API on `http://localhost:4000` and the client on
   `http://localhost:5173` (or the ports in your `.env` files), both with
   hot reload. Open the client and sign in as `owner@example.test` /
   `local-owner-password`.

   `npm start` instead builds everything once and serves the client and
   API from a single process on the server's port, without hot reload.
   `npm run stop` frees both ports.

Studio (`http://127.0.0.1:54323`) shows the local tables. `npx supabase stop`
stops the stack and keeps its data; `npx supabase db reset` wipes the local
database back to the seed.

Schema changes go through new migration files only
(`npx supabase migration new <name>`, then `npx supabase db reset`). Never
edit a migration that's already been applied anywhere.

`AUTH_DISABLED=true` in `server/.env` skips the API's sign-in check for
local experiments. It's refused in production and on Netlify, and
`npm run test:e2e` refuses to run with it. Normal local development signs in
for real against the local stack, as above.

### Running a second checkout alongside an existing one

Ports are overridable for this case: a separate clone, branch or `git
worktree` running at the same time as another checkout. In the second
checkout, set `PORT=4100` (or any free port) in `server/.env`, and in
`client/.env` both `VITE_DEV_PORT=5273` and
`VITE_API_PROXY_TARGET=http://localhost:4100` (the same port as `PORT`, so
the client's `/api` calls reach *this* checkout's server; it defaults to
`http://localhost:4000`).

This matters because `npm run dev`, `npm start`, `npm run stop`,
`npm run test:e2e` and `npm run screenshots` run `scripts/kill-ports.js`
first, which force-kills whatever is listening on the configured ports.
Without an override, starting a second checkout would kill the first
one's server. `kill-ports.js` reads the same `PORT`/`VITE_DEV_PORT` values
from `server/.env`/`client/.env`, so once both are set it only targets its
own checkout's ports. (The Supabase stack's ports are shared by every
checkout on the machine, and so is its database.)

## Configuring categories

The default 4 categories (Food/Transportation/Rent/Other) are a default,
not a fixed list. Categories live in the Postgres `categories` table, one
row per category, shown in `position` order. When the table is empty, the
server fills it with the 4 defaults on the first read, so a fresh copy
needs no setup step. Insert, delete, or update rows (in Supabase Studio's
**Table Editor**, or with `psql`) to add, remove, rename, or recolor
categories. Changes take effect on the next request, no restart needed.

Each row:

```sql
insert into categories (id, label, bg, fg, position)
values ('food', 'Food', '#FFFF00', '#3d3d00', 0);
```

- `id`: the stable key each expense stores. Changing an existing
  category's `id` updates the expenses that use it, but a category that's
  in use can't be deleted.
- `label`: display name in the picker, entry list, and dashboard chart
  legend.
- `bg`: the category's color, as CSS hex (`#RRGGBB`).
- `fg`: text color shown on that background. **Optional**: if null, the
  app computes a readable one from `bg` on every read (a darker shade of
  the same hue, or whichever of black/white contrasts better for an
  already-dark or saturated background), so a hand-written row only needs
  `id`/`label`/`bg`/`position`.
- `position`: display order (ascending) in the picker, entry list, and
  chart legend.

## Choosing sections (ENABLED_MODULES)

The server's `ENABLED_MODULES` setting picks which sections a copy shows: a
comma-separated list of `expenses`, `finances`, `debts`, `emi`,
`credit-cards` and `subscriptions` (case-insensitive). Unset or blank
shows them all. The Dashboard is always on, and shows only the parts whose
sections are on. A disabled section's tab is hidden and its API routes
answer 404. An unknown name stops the server at startup, so a typo can't
silently hide a section.

Every table exists in every copy, so turning a section on later is just a
change to the setting and a redeploy, with no database step; the client
asks the server which sections are on (`GET /api/config`) when it loads.
Turning one off keeps its data. See
[DEPLOY.md](docs/DEPLOY.md#turning-on-another-section-later),
[ADR-0006](docs/adr/0006-enabled-modules-per-deployment.md) and
[LLD §5.1](docs/architecture/LLD.md#51-enabled-modules).

## Deploying

[docs/DEPLOY.md](docs/DEPLOY.md) walks through creating the Supabase
project, applying the migrations, creating the owner account, creating
the Netlify site, every environment variable, and troubleshooting.
`netlify.toml` holds the build settings; [LLD §7](docs/architecture/LLD.md#7-netlify-packaging)
explains the packaging.

## Testing

Everything runs against the **local** Supabase stack. The test helpers
refuse any database or Supabase host other than `127.0.0.1`/`localhost`.

- **`npm test`**: the server's vitest suites in `server/test/`. They cover
  the pure calculations (date math, EMI decay, payoff and foreclosure math,
  subscription renewal advance, finance series, credit card totals,
  category colors, "today" in `APP_TIMEZONE`), every store module against
  real Postgres (including month locking, reordering, concurrent appends,
  the categories read-or-create, and the Dashboard overview's Net Worth,
  Upcoming and salary-reminder rules), the schema's constraints, input
  validation, `ENABLED_MODULES` parsing and the overview per section
  subset, and the API through `createApp` (auth: missing, malformed,
  expired, wrongly signed and non-owner tokens; startup configuration
  checks; error mapping; the request log; the Netlify handler).
  [LLD §10](docs/architecture/LLD.md#10-testing) has the full list. It takes
  a few seconds. It **truncates the local tables**, so run
  `npx supabase db reset` afterwards if you want the seeded categories back
  for `npm run dev`.
- **`npm run test:e2e`**: two Playwright scripts (plain scripts, not the
  `@playwright/test` runner). Each resets the local database, starts the
  dev server on this checkout's ports, and signs in through the real
  sign-in form as the seeded owner. `e2e/regression.ts` drives the whole
  app: Dashboard and chart click-through, a custom category seeded into the
  `categories` table rendering end to end, every tab's add/edit/delete/sort,
  reordering, month locking (including a raw API write to a locked month
  getting a 403), the Dashboard overview and Upcoming EMIs chart, theme
  persistence, and the auth flows (a request without a token is a 401, a
  wrong password, sign-out, the not-allowed screen, a mid-session 401
  signing out with a notice). `e2e/expensesOnly.ts` then runs with
  `ENABLED_MODULES=expenses`: only Dashboard and Expenses tabs, expense
  add/edit/delete, a Dashboard with no card from a disabled section, and a
  disabled section's API answering 404. Both fail on any browser console
  error. Run it after any client or server change.
- **`npm run screenshots`**: `e2e/screenshots.ts` regenerates
  `docs/screenshots/dashboard.png` and `dashboard-dark.png` from a fixed
  fictional dataset (Alex/Sam, Visa Rewards/Amex Gold, Car Loan/Home Loan,
  Netflix/Spotify/Amazon Prime, Emergency Fund/PPF/NPS/APY), using the same
  isolation as e2e and asserting every tab is empty before adding anything.

Typechecks:

```
(cd client && npx tsc -b)
(cd server && npx tsc --noEmit)                          # server src + tests
(cd server && npx tsc -p tsconfig.build.json --noEmit)   # what the server build compiles
(cd server && npx tsc -p ../netlify/tsconfig.json)       # the Netlify function
```

Run the server checks from `server/` so they use the server's own
TypeScript version.

## Notes / gotchas

- A phone's numeric/decimal keyboard has no "-" key, so
  `<input type="number">` made a negative amount impossible to type on iOS.
  Signed amounts (Debts, the savings delta) use a shared
  `SignedAmountInput` component instead: an explicit two-button sign toggle
  (You owe/Owed to you, Deposit/Withdrawal) plus a magnitude-only field.
- On Windows, `npm run dev`'s process tree is several layers deep
  (`concurrently` → per-workspace `npm` shims → `tsx watch` / `vite`), and
  Ctrl+C or closing the terminal doesn't always reach every layer, so an
  orphaned Node process can keep a port held. This is self-healing: the
  next `npm run dev`/`npm start` runs `scripts/kill-ports.js` first. Run
  `npm run stop` to clean up without restarting.
- Never hand-write a one-off script that drives the app's UI or API against
  a real copy's data, even to regenerate a screenshot. Use (or extend)
  `npm run screenshots` / `e2e/`, which only ever touch the local stack. On
  the Excel edition, an ad hoc screenshot script once reached the real
  server through the client's dev proxy (`VITE_API_PROXY_TARGET` defaulting
  to `http://localhost:4000`) and overwrote real rows by filling forms by
  position. The e2e scripts' local-host checks and empty-tab assertion
  exist so that can't recur.
- Some input the Excel edition accepted is now refused with a 400, because
  the database enforces the same bounds the API checks (for example an
  amount that rounds to 0.00, or one of 1e12 or more). See
  [LLD §11](docs/architecture/LLD.md#11-error-handling-and-logging).
- Row ids (the `row` field in the API) are database ids: stable, but not
  positions. Deleting an entry doesn't change other entries' ids.
