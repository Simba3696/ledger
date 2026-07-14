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
- Editing, deleting, and reordering are only available for the **current
  calendar month** in the UI (and blocked server-side for any protected sheet
  regardless). Deleting actually removes the row and shifts everything below
  it up, rather than just blanking it, so row numbers stay meaningful.
  Reordering (drag the ⠿ handle) similarly moves the row for real rather than
  just changing how it displays.
- `Expense Summary.xlsm` and the yearly template (`Expenses (202X).xlsx`) are
  not read or written by the app — those stay manual.
- If a sheet is protected/locked in Excel (Review → Protect Sheet), the app
  refuses to write to it rather than silently editing through the lock.
- The first time a given year's workbook is written to in a server run, a
  timestamped copy is saved to a `.backups/` folder next to it.

## Project layout

```
server/   Express API (TypeScript). All Excel reading/writing lives in
          server/src/excel/ — categoryColors.ts (the color↔category map) and
          ledger.ts (read/append logic, safety checks).
client/   React + Vite frontend. Add Expense form + current month's entry list.
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
`http://localhost:5173`. `predev` automatically clears anything left
listening on those two ports from a previous, uncleanly-stopped run, so this
is always safe to re-run.

To stop everything:

```
npm run stop
```

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

## Roadmap (not built yet)

- A summary/dashboard view (aggregated from the yearly files, without touching
  `Expense Summary.xlsm`).
- Possibly read-only views into the Summary workbook's other sheets (Credit
  Card Bills, Debts, EMI, Subscriptions).
- Light/dark theme, following the OS/browser's `prefers-color-scheme` (no
  manual toggle planned).
