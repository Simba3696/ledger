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
  the Expenses tab's month/year. Clicking any month's bar (even an empty one)
  jumps to the Expenses tab with that month/year selected, so you can view an
  existing month or drop straight into adding a new entry.
- A third tab, **Finances**, tracks Salary, Other Income, and a Current
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
  - **Current Savings** — a manually-entered snapshot (PPF/NPS/APY etc.)
    that carries forward across months until you update it again, rather
    than resetting to blank when a month has nothing new entered.

  Historical Salary and the one-time Current Savings baseline were backfilled
  once from `Expense Summary.xlsm`'s Summary sheet (that sheet's "Last
  Month's Salary" row stores each value one column *after* the month it was
  actually earned in, so the backfill shifted everything back by one month —
  confirmed against the sheet's own `Balance = LastMonthSalary − Expenses`
  formula and cross-checked exactly against its frozen `Money Earned` total).
- Light/dark theme: a sun/moon slider toggle in the header (top right). The
  choice is saved to `localStorage` and wins over the OS preference once set;
  before any explicit choice, it follows `prefers-color-scheme`.
- `Expense Summary.xlsm` and the yearly template (`Expenses (202X).xlsx`) are
  not read or written by the app — those stay manual.
- If a sheet is protected/locked in Excel (Review → Protect Sheet), the app
  refuses to write to it rather than silently editing through the lock.
- The first time a given workbook (a year's `Expenses (YYYY).xlsx` or
  `Finances.xlsx`) is written to in a server run, a timestamped copy is saved
  to a `.backups/` folder next to it.

## Project layout

```
server/   Express API (TypeScript). All Excel reading/writing lives in
          server/src/excel/ — categoryColors.ts (the color↔category map),
          workbookIO.ts (shared safe-write: backup + temp-file-then-rename,
          used by both files below), ledger.ts (expense read/append logic
          against Expenses (YYYY).xlsx), and finances.ts (Salary/Balance/
          Savings against its own Finances.xlsx).
          server/test/ — vitest suite + the synthetic-fixture builder.
client/   React + Vite frontend. Add Expense form + current month's entry list,
          a Dashboard tab (category chart), and a Finances tab — see
          src/components/.
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

- **`npm test`** — vitest, two files. `server/test/ledger.test.ts` covers
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
  forward across unset months. Fast (a few seconds), no browser or dev server
  needed — this is the one to run after any change under `server/src/excel/`.
- **`npm run test:e2e`** — `e2e/regression.ts` (Playwright, plain script, not
  the `@playwright/test` runner). Builds a scratch data directory seeded with
  a full year (so switching months never legitimately 404s), starts the real
  dev server against it, and drives an actual browser through the full app:
  Dashboard-is-default, chart click-through navigation, month/year selects,
  add (cash + card), edit, drag-reorder, delete, and theme toggle + persistence
  — failing loudly on both failed assertions and any browser console error.
  Seeds the *real current* month/year (not a hardcoded one), since edit/
  delete/reorder are only enabled in the UI for the actual current month.
  Slower (~15–20s) and needs the dev ports free — this is the one to run
  after any client-side change, or before considering a session's changes done.

Both suites are self-contained: they create their own temp data directories
and never touch the real `Expenses` folder.

## Notes / gotchas

- The target `.xlsx` file must be closed in Excel while adding entries through
  the app — Excel holds an exclusive lock, and a write while it's open will
  fail with a clear error rather than corrupting the file.
- Adding an entry for a year that doesn't have a workbook yet (e.g. next
  January) isn't supported — create that year's file from the template first,
  the same way as always.
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

Read-only views into `Expense Summary.xlsm`'s remaining data, one phase at a
time:

- Credit Card Bills — due/paid/due-date per month, one table per year.
- Debts — who owes whom.
- EMI schedules and Subscriptions.

Each of the above is manually-maintained data with no connection to the
per-year ledger files, and `.xlsm` is macro-enabled, so these will stay
strictly **read-only** unless/until explicitly decided otherwise.
