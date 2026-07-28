# Ledger

A local web app for logging personal expenses directly into the existing
`Expenses (YYYY).xlsx` workbooks — one sheet per month, one workbook per year —
that have been used to track spending since 2018. There is no database; the
Excel files themselves are the source of truth, and the app reads and writes
them in place.

## How it works

- Each month sheet has three columns: **Amount** (negative, ₹-formatted),
  **Remarks**, and an optional **CC** marker (blank = cash, `"CC"` = paid by
  credit card).
- **Category isn't a column — it's the row's cell fill color**, matching the
  scheme already used in the sheets:
  - Yellow (`FFFFFF00`) = Food
  - Blue (`FF00B0F0`) = Transportation
  - Orange (`FFFFC000`) = Rent
  - Red (`FFFF0000`) = Other / non-recurring
- There's no date column — rows are just chronological within a month sheet.
  New entries append to the bottom of the target month's sheet.
- The app only ever touches columns A–C. Anything else on a sheet (e.g. old
  odometer/mileage tracking columns) is left completely alone.
- Borders are preserved: the Amount/Remarks columns keep a thick outer box
  whose bottom edge always tracks whichever row is currently last, and the CC
  column keeps its own individually-boxed border on every row — but only on
  rows that are actually card transactions; a cash row's CC cell is left
  completely blank (no fill, no border), matching the sheets exactly.
  New/edited/deleted/reordered rows are formatted to match automatically.
- Amount is right-aligned and Remarks is left-aligned, both vertically
  centered, matching every existing row (ExcelJS otherwise defaults to bottom
  alignment for cells with no explicit alignment set).
- Copying, editing, deleting, and reordering are only available for the
  **current calendar month** in the UI (and blocked server-side for any
  protected sheet regardless). Copy/Edit/Delete live under a "⋮" menu on each
  entry. Deleting actually removes the row and shifts everything below it up,
  rather than just blanking it, so row numbers stay meaningful. Reordering
  (drag the ⠿ handle) similarly moves the row for real rather than just
  changing how it displays. Copy adds a brand new entry with the same
  amount/remarks/category/card-status, appended at the end like any other new
  entry — never linked back to the original — so editing one afterward never
  touches the other.
- The app opens on the **Dashboard** tab by default. It shows a stacked bar
  chart of category totals per month for a selected year, computed live from
  the same ledger data (no separate storage) — a year selector independent of
  the Expenses view's month/year. Clicking any month's bar (even an empty one)
  jumps to Expenses with that month/year selected, so you can view an existing
  month or drop straight into adding a new entry. **Expenses has no button in
  the nav bar** — the Dashboard chart is the only way in, by design, since the
  Dashboard is meant to be the main view day to day. The rest of the nav bar
  is ordered Dashboard, Credit Cards, Debts, Finances — matching the sheet
  order in `Expense Summary.xlsm` (Credit Card Bills, Debts, then EMI/
  Subscriptions when built) rather than the order each tab happened to be
  built in.
- The **Finances** tab tracks Salary, Other Income, and a Current
  Savings snapshot per month — entered through the app into a new
  `Finances.xlsx` that it owns entirely (separate from `Expense
  Summary.xlsm`, which stays macro-enabled, manual, and untouched). From
  those entries it computes:
  - **Balance** — last month's total income (salary + other income) minus
    this month's expenses. A month with no income on record counts as zero,
    so it shows as a real deficit rather than "unknown".
  - **Cumulative** — running sum of Balance since 2018.
  - **Minimum Savings** — `ceil(15% of this month's own salary + other income)`.
  - **Money Earned / Money Spent** — running totals of income / ledger
    expenses since 2018.
  - **Current Savings** — named scheme balances (PPF, NPS, APY, etc.),
    entered and edited individually and summed automatically into a total,
    matching how you actually update it (touch one scheme, not recompute
    the whole figure by hand). The set of schemes isn't fixed — add or
    remove one freely as your actual savings mix changes. Whichever month's
    breakdown was most recently entered carries forward across later months
    until you update it again, rather than resetting to blank.

  Historical Salary was backfilled once from `Expense Summary.xlsm`'s
  Summary sheet (that sheet's "Last Month's Salary" row stores each value
  one column *after* the month it was actually earned in, so the backfill
  shifted everything back by one month — confirmed against the sheet's own
  `Balance = LastMonthSalary − Expenses` formula and cross-checked exactly
  against its frozen `Money Earned` total). Current Savings wasn't
  backfilled the same way — the `.xlsm` only ever had one snapshot, entered
  once as a present-day figure rather than tied to a specific month, so it
  was entered fresh as of the actual month it was true.
- The **Debts** tab is a flat list of who you owe and who owes you —
  entered into its own app-owned `Debts.xlsx`, not month-indexed like
  Finances since it's just current state, not a monthly history. Each
  entry is a name and a single signed amount you update directly when it
  changes (positive = you owe them, negative = they owe you — the same
  convention `Expense Summary.xlsm`'s Debts sheet already used). The
  displayed total is a plain sum of every entry — the old sheet's own total
  used a formula that only covered its first four rows and silently missed
  two real debts further down; the app's total doesn't have that gap.
  Sortable by Name, Amount, or Type (groups owed-to-you vs you-owe apart) —
  click a sort button again to flip ascending/descending.
- The **Credit Cards** tab tracks each card/loan's bill as its own
  named entry per month (due amount, paid amount, and that card's own due
  date) in its own app-owned `CreditCardBills.xlsx` — the number of cards
  isn't fixed, so adding or paying off one is just adding/removing an entry,
  never touching a formula. From those entries it computes Total Due, Total
  Paid, the Earliest Due Date across all cards that month (so you know when
  to arrange funds), and Overpaid/Saved (Due − Paid: negative means you paid
  more than billed, positive means a payment app rounded a few rupees in
  your favor). It also shows yearly totals — Total Spent This Year, Total
  Paid This Year, and Net Overpaid/Saved This Year — summed across all 12
  months of the selected year. Historical Due/Paid amounts were backfilled
  from `Expense Summary.xlsm`'s Credit Card Bills sheet, whose own
  `=a+b+c+...` formulas turned out to be literally one term per card (in the
  order the cards were acquired) — splitting those formulas back into named
  per-card entries reproduced every year's own total exactly (2020 through
  2025, ₹140,301.76 through ₹669,857.81). The old sheet only ever tracked one
  shared "earliest due date" per month, not per-card, so historical per-card
  due dates were backfilled with that same shared date as a floor value (no
  individual card's real due date could have been earlier than it, only
  later) — it's tracked per-card going forward from here.
- Every tab shows a spinner over a faded backdrop while its data loads,
  rather than swapping content out for plain "Loading…" text — previous
  content (e.g. last month's stats while this month's are being fetched)
  stays visible-but-faded underneath instead of flashing to blank.
- Light/dark theme: a sun/moon slider toggle in the header (top right). The
  choice is saved to `localStorage` and wins over the OS preference once set;
  before any explicit choice, it follows `prefers-color-scheme`.
- `Expense Summary.xlsm` and the yearly template (`Expenses (202X).xlsx`) are
  not read or written by the app — those stay manual.
- If a sheet is protected/locked in Excel (Review → Protect Sheet), the app
  refuses to write to it rather than silently editing through the lock.
- The first time a given workbook (a year's `Expenses (YYYY).xlsx`,
  `Finances.xlsx`, `Debts.xlsx`, or `CreditCardBills.xlsx`) is written to in
  a server run, a timestamped copy is saved to a `.backups/` folder next to it.

## Project layout

```
server/   Express API (TypeScript). All Excel reading/writing lives in
          server/src/excel/ — categoryColors.ts (the color↔category map),
          workbookIO.ts (shared safe-write: backup + temp-file-then-rename,
          used by every file below), ledger.ts (expense read/append logic
          against Expenses (YYYY).xlsx), finances.ts (Salary/Balance/
          Savings against its own Finances.xlsx), debts.ts (who-owes-whom
          against its own Debts.xlsx), and creditCardBills.ts (per-card
          bills against its own CreditCardBills.xlsx).
          server/test/ — vitest suite + the synthetic-fixture builder.
client/   React + Vite frontend. A Dashboard tab (category chart), a Credit
          Cards tab, a Debts tab, and a Finances tab in the nav bar — see
          src/components/. The Add Expense form + current month's entry list
          (Expenses) has no nav button; it's only reached via a Dashboard
          chart click.
e2e/      Full-stack Playwright regression script (see Testing below).
scripts/  kill-ports.js — frees the dev ports before/on demand.
```

## Setup

Requires Node 22+.

```
npm install
```

Then point the server at wherever your `Expenses (YYYY).xlsx` files actually
live by creating `server/.env`:

```
LEDGER_DB_DIR=C:/path/to/your/Expenses/folder
```

(Defaults to a `db/` folder at the repo root if `LEDGER_DB_DIR` isn't set.)

## Running

```
npm run dev
```

Starts the API on `http://localhost:4000` and the frontend on
`http://localhost:5173`, both with hot-reload — this is the mode for actually
working on the code.

For everyday use where you're not making changes, `npm start` instead:

```
npm start
```

Builds the client and server once, then serves the whole app — client
included — from a single process on `http://localhost:4000`. No hot-reload
or file-watching, so it starts faster and uses less memory than `npm run dev`.
Re-run it after pulling in code changes to pick them up (it always rebuilds
first).

Either way, to stop everything:

```
npm run stop
```

## Testing

Two suites, covering different layers:

- **`npm test`** — vitest, four files. `server/test/ledger.test.ts` covers
  `appendEntry`/`updateEntry`/`deleteEntry`/`moveEntry`/`yearSummary` against
  synthetic `.xlsx` fixtures built at run time by `server/test/fixtures.ts`
  (never real data — nothing sensitive is committed), including a couple of
  specific regression tests for the shared-style-object bug described above:
  they seed two entries with *deliberately identical* style (same category,
  both non-last rows) so ExcelJS's normal dedup gives them a shared style
  object on read, then assert that editing/deleting one doesn't cascade into
  the other. `server/test/finances.test.ts` covers `getMonthIncome`/
  `setMonthIncome`/`financeSummary`'s Balance/Cumulative/Minimum Savings/
  Money Earned/Spent math, including carrying a Current Savings snapshot
  forward across unset months. `server/test/debts.test.ts` covers add/update/
  delete and the sign convention. `server/test/creditCardBills.test.ts`
  covers per-card entries summing correctly into totals, the earliest-due-
  date computation, and Overpaid/Saved. Fast (a few seconds), no browser or
  dev server needed — this is the one to run after any change under
  `server/src/excel/`.
- **`npm run test:e2e`** — `e2e/regression.ts` (Playwright, plain script, not
  the `@playwright/test` runner). Builds a scratch data directory seeded with
  a full year (so switching months never legitimately 404s), starts the real
  dev server against it, and drives an actual browser through the full app:
  Dashboard-is-default, chart click-through navigation (main chart and the
  per-category mini-charts, including their synced hover), month/year
  selects, add (cash + card), edit, drag-reorder, delete, Finances entry +
  persistence, Debts add/edit/delete/sort, Credit Cards add/edit/persistence,
  and theme toggle + persistence — failing loudly on both failed assertions
  and any browser console error. Seeds the *real current* month/year (not a
  hardcoded one), since edit/delete/reorder are only enabled in the UI for
  the actual current month. Slower (~20–25s) and needs the dev ports free —
  this is the one to run after any client-side change, or before considering
  a session's changes done.

Both suites are self-contained: they create their own temp data directories
and never touch the real `Expenses` folder.

## Notes / gotchas

- The target `.xlsx` file must be closed in Excel while adding entries through
  the app — Excel holds an exclusive lock, and a write while it's open will
  fail with a clear error rather than corrupting the file.
- Adding an entry for a year with no workbook yet (e.g. next January) creates
  `Expenses (YYYY).xlsx` automatically — 12 blank month sheets, matching your
  own `Expenses (202X).xlsx` template exactly (just an Amount/Remarks header;
  no formulas or protection to copy). The new entry's own formatting (number
  format, borders, alignment, category fill) comes from the same fallback
  logic already used for the first entry on any sheet.
- ExcelJS shares one JS style object across every cell that happens to have
  the same style index (normal XLSX dedup — see `getStyleModel()` in its
  source), and its `.fill`/`.border`/etc setters mutate that object in place.
  Every cell this app writes to is detached (`ledger.ts`'s `detachStyle()`)
  before any property is touched, specifically to prevent a write to one
  entry from silently changing others that happened to share a style.
- On Windows, `npm run dev`'s process tree is several layers deep
  (`concurrently` → per-workspace `npm` shims → `tsx watch` / `vite`), and
  Ctrl+C or closing the terminal window doesn't always propagate down through
  every layer — an orphaned Node process can occasionally keep a port held
  after you've "closed" the app. This is self-healing: `predev`/`prestart`
  both run `scripts/kill-ports.js` automatically before starting, so the
  *next* launch always clears anything left over. Run `npm run stop`
  directly if you want to clean up without immediately restarting.

## Roadmap (not built yet)

The remaining data still living in `Expense Summary.xlsm`, one phase at a
time, following the same pattern as Finances/Debts/Credit Cards above — a
new app-owned workbook with a one-time historical backfill, so the app is
fully read/write and the `.xlsm` never needs a write path:

- EMI schedules and Subscriptions (possibly one workbook, two sheets — both
  are recurring obligations with a due date and an amount, unlike Credit
  Card Bills' month-grouped structure).

The end goal is to retire `Expense Summary.xlsm` entirely once everything
in it has a home in the app; `.xlsm` itself stays read-only right up until
that point (it's macro-enabled, so it's never worth writing to
programmatically even for a single field).
