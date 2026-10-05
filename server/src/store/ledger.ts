import { getSql, type Sql, type Tx } from "../db/client.js";
import { withTransaction } from "../db/tx.js";
import { LedgerError } from "../errors.js";
import type { Category } from "../domain/categoryColors.js";
import { loadCategoryConfig } from "./categories.js";
import { assertMoney, assertText, isPossibleId } from "./validate.js";

export { LedgerError };

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** The `year` column's own bounds: `check (year >= 2018)` and int4. */
const EARLIEST_YEAR = 2018;
const LATEST_YEAR = 2147483647;

export interface LedgerEntry {
  /** The expense's database id (opaque and stable; no longer a sheet row). */
  row: number;
  amount: number; // positive rupee amount
  remarks: string;
  isCard: boolean;
  cardNote: string | null;
  category: Category | null;
}

export interface MonthSummary {
  month: number; // 1-12
  /** Keyed by category id — always has every currently-configured category
   * present (0 if unused that month), same "always present" shape the
   * fixed-field version used to have, just with a dynamic key set. */
  categoryTotals: Record<string, number>;
  total: number;
}

export interface AppendEntryInput {
  year: number;
  month: number;
  amount: number;
  remarks: string;
  category: Category;
  isCard: boolean;
}

export interface UpdateEntryInput {
  year: number;
  month: number;
  row: number;
  amount: number;
  remarks: string;
  category: Category;
  isCard: boolean;
}

export interface DeleteEntryInput {
  year: number;
  month: number;
  row: number;
}

export interface MoveEntryInput {
  year: number;
  month: number;
  fromRow: number;
  toRow: number;
}

interface ExpenseRow {
  id: number;
  position: number;
  amount: number;
  remarks: string;
  category_id: string | null;
  card_note: string | null;
}

function toEntry(r: ExpenseRow): LedgerEntry {
  return {
    row: r.id,
    amount: r.amount,
    remarks: r.remarks,
    isCard: r.card_note !== null,
    cardNote: r.card_note,
    category: r.category_id,
  };
}

/** The note written for a card entry. Like the Excel edition, appending or
 * updating with isCard always writes plain "CC" — a longer imported note
 * such as "CC (200)" is replaced on update; only moveEntry keeps it. */
function cardNoteFor(isCard: boolean): string | null {
  return isCard ? "CC" : null;
}

function monthName(month: number): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new LedgerError(`Invalid month: ${month}`, 400);
  }
  return MONTH_NAMES[month - 1];
}

/** A year the `year` column can hold. Anything else can't have stored rows. */
function isStorableYear(year: number): boolean {
  return Number.isInteger(year) && year >= EARLIEST_YEAR && year <= LATEST_YEAR;
}

function validateWriteYear(year: number) {
  if (!isStorableYear(year)) throw new LedgerError(`Invalid year: ${year}`, 400);
}

function noYear(year: number): LedgerError {
  return new LedgerError(`No workbook found for year ${year}`, 404);
}

/** The Excel edition's loadWorkbook check, which ran before anything looked
 * at the month: a year nobody has written to is a 404. */
async function assertYearExists(q: Sql | Tx, year: number) {
  if (!(await yearExists(q, year))) throw noYear(year);
}

function noEntry(row: number, year: number, month: number): LedgerError {
  return new LedgerError(`No entry found at row ${row} in ${monthName(month)} ${year}`, 404);
}

/** The Excel edition's "does this year's workbook exist": whether the year
 * has ever been written to. appendEntry is the one write that "creates" a
 * year (recording it in `ledger_years`); a year with expenses or month locks
 * exists too. A year nobody has written to yet 404s on listMonth,
 * setMonthLocked and the entry writes exactly as a missing workbook did, and
 * deleting a year's last entry doesn't un-create it, as the emptied workbook
 * file stayed behind. */
async function yearExists(q: Sql | Tx, year: number): Promise<boolean> {
  if (!isStorableYear(year)) return false;
  const [{ found }] = await q<{ found: boolean }[]>`
    select exists (select 1 from ledger_years where year = ${year})
        or exists (select 1 from expenses where year = ${year})
        or exists (select 1 from month_locks where year = ${year}) as found`;
  return found;
}

/** Serialises every write to one month (LLD §4.3/§4.4): appends computing the
 * next position, deletes/moves renumbering positions, and lock toggles all
 * queue here, so a lock check and the write that follows it can't interleave
 * with another write to the same month. Released at commit/rollback. The
 * month key is hashed (year * 100 + month would overflow int4 for years the
 * column accepts); a collision only serialises two unrelated months. */
async function lockMonthForWrite(tx: Tx, year: number, month: number) {
  await tx`select pg_advisory_xact_lock(hashtext('expenses'), hashtext(${`${year}-${month}`}))`;
}

/** The Excel edition's assertWritable: a locked month rejects every write. */
async function assertWritable(tx: Tx, year: number, month: number) {
  const [locked] = await tx`select 1 from month_locks where year = ${year} and month = ${month}`;
  if (locked) {
    throw new LedgerError(
      `${monthName(month)} ${year} is locked. Unlock it first from the app if you really need to add an entry there.`,
      403,
    );
  }
}

/** The entry `row` (an id) in this month, row-locked for the rest of the
 * transaction; 404 unless it exists and belongs to (year, month). */
async function findEntry(tx: Tx, year: number, month: number, row: number): Promise<ExpenseRow> {
  if (!isPossibleId(row)) throw noEntry(row, year, month);
  const [r] = await tx<ExpenseRow[]>`
    select id, position, amount, remarks, category_id, card_note
    from expenses where id = ${row} and year = ${year} and month = ${month}
    for update`;
  if (!r) throw noEntry(row, year, month);
  return r;
}

async function validateEntryFields(amount: number, remarks: string, category: Category) {
  assertMoney(amount, { positive: true });
  if (!remarks || !remarks.trim()) throw new LedgerError("Remarks are required", 400);
  assertText(remarks, "Remarks");
  const categoryConfig = (await loadCategoryConfig()).find((c) => c.id === category);
  if (!categoryConfig) throw new LedgerError(`Unknown category: ${category}`, 400);
}

/** Whether a month is locked (a `month_locks` row). A month in a year with
 * nobody has written to is never locked, whatever the month; there's
 * nothing to lock. */
export async function isMonthLocked(year: number, month: number): Promise<boolean> {
  const sql = getSql();
  if (!(await yearExists(sql, year))) return false;
  monthName(month);
  const [locked] = await sql`select 1 from month_locks where year = ${year} and month = ${month}`;
  return !!locked;
}

/** Locks or unlocks a month. Nothing auto-locks; locking a month you're done
 * with is a deliberate, undoable choice. Like the Excel edition, a year
 * nobody has written to 404s (there's no "workbook" to lock). */
export async function setMonthLocked(year: number, month: number, locked: boolean): Promise<void> {
  await withTransaction(async (tx) => {
    await assertYearExists(tx, year);
    monthName(month);
    await lockMonthForWrite(tx, year, month);
    if (locked) {
      await tx`insert into month_locks (year, month) values (${year}, ${month}) on conflict do nothing`;
    } else {
      await tx`delete from month_locks where year = ${year} and month = ${month}`;
    }
  });
}

/** A month's entries in display order (`position`). */
export async function listMonth(year: number, month: number): Promise<LedgerEntry[]> {
  const sql = getSql();
  await assertYearExists(sql, year);
  monthName(month);
  const rows = await sql<ExpenseRow[]>`
    select id, position, amount, remarks, category_id, card_note
    from expenses where year = ${year} and month = ${month}
    order by position`;
  return rows.map(toEntry);
}

/** Category totals for every month of a year, for the dashboard. Every
 * currently configured category is present (0 if unused); a month (or a
 * whole year) with nothing entered is a zero row rather than an error.
 * Entries with no category (imported rows with an unrecognised colour) count
 * toward the total only, as before. */
export async function yearSummary(year: number): Promise<MonthSummary[]> {
  const categories = await loadCategoryConfig();
  const months: MonthSummary[] = [];
  for (let month = 1; month <= 12; month++) {
    months.push({ month, categoryTotals: Object.fromEntries(categories.map((c) => [c.id, 0])), total: 0 });
  }
  if (!isStorableYear(year)) return months;

  const sql = getSql();
  const rows = await sql<{ month: number; category_id: string | null; total: number }[]>`
    select month, category_id, sum(amount) as total
    from expenses where year = ${year}
    group by month, category_id`;
  for (const r of rows) {
    const summary = months[r.month - 1];
    if (r.category_id !== null) {
      summary.categoryTotals[r.category_id] = (summary.categoryTotals[r.category_id] ?? 0) + r.total;
    }
    summary.total += r.total;
  }
  return months;
}

/** Flat per-month expense totals for a year — like yearSummary without the
 * category breakdown. Index 0 is unused; 1-12 are the months. A year or
 * month with nothing entered is zero. */
export async function yearExpenseTotals(year: number): Promise<number[]> {
  const totals = Array.from({ length: 13 }, () => 0);
  if (!isStorableYear(year)) return totals;

  const sql = getSql();
  const rows = await sql<{ month: number; total: number }[]>`
    select month, sum(amount) as total
    from expenses where year = ${year}
    group by month`;
  for (const r of rows) totals[r.month] = r.total;
  return totals;
}

/** yearExpenseTotals for every year from `fromYear` through `toYear`, in one
 * grouped query rather than one round trip per year. Years with nothing
 * entered share a single all-zero array, so a far-future `toYear` costs no
 * extra queries and little memory. */
export async function expenseTotalsForYears(fromYear: number, toYear: number): Promise<Map<number, readonly number[]>> {
  const zeros: readonly number[] = Object.freeze(Array.from({ length: 13 }, () => 0));
  const byYear = new Map<number, readonly number[]>();
  if (toYear >= fromYear) {
    const sql = getSql();
    const rows = await sql<{ year: number; month: number; total: number }[]>`
      select year, month, sum(amount) as total
      from expenses where year between ${fromYear} and ${toYear}
      group by year, month`;
    for (const r of rows) {
      let totals = byYear.get(r.year) as number[] | undefined;
      if (!totals) {
        totals = Array.from({ length: 13 }, () => 0);
        byYear.set(r.year, totals);
      }
      totals[r.month] = r.total;
    }
  }
  for (let year = fromYear; year <= toYear; year++) {
    if (!byYear.has(year)) byYear.set(year, zeros);
  }
  return byYear;
}

/** Adds an entry at the end of the month (LLD §4.3). The per-month advisory
 * lock serialises concurrent appends, so each computes its own next
 * position and none is lost. Adding to a year nobody has written to yet
 * "creates" it (a `ledger_years` row), as the Excel edition created its
 * workbook. */
export async function appendEntry(input: AppendEntryInput): Promise<LedgerEntry> {
  const { year, month, amount, remarks, category, isCard } = input;
  await validateEntryFields(amount, remarks, category);
  validateWriteYear(year);
  monthName(month);

  return withTransaction(async (tx) => {
    await lockMonthForWrite(tx, year, month);
    await assertWritable(tx, year, month);
    await tx`insert into ledger_years (year) values (${year}) on conflict do nothing`;
    const [{ next }] = await tx<{ next: number }[]>`
      select coalesce(max(position) + 1, 0) as next
      from expenses where year = ${year} and month = ${month}`;
    const [r] = await tx<ExpenseRow[]>`
      insert into expenses (year, month, position, amount, remarks, category_id, card_note)
      values (${year}, ${month}, ${next}, ${amount}, ${remarks.trim()}, ${category}, ${cardNoteFor(isCard)})
      returning id, position, amount, remarks, category_id, card_note`;
    return toEntry(r);
  });
}

/** Edits an entry in place; its position never changes. */
export async function updateEntry(input: UpdateEntryInput): Promise<LedgerEntry> {
  const { year, month, row, amount, remarks, category, isCard } = input;
  await validateEntryFields(amount, remarks, category);

  return withTransaction(async (tx) => {
    await assertYearExists(tx, year);
    monthName(month);
    await lockMonthForWrite(tx, year, month);
    await assertWritable(tx, year, month);
    await findEntry(tx, year, month, row);
    const [r] = await tx<ExpenseRow[]>`
      update expenses
      set amount = ${amount}, remarks = ${remarks.trim()}, category_id = ${category}, card_note = ${cardNoteFor(isCard)}
      where id = ${row}
      returning id, position, amount, remarks, category_id, card_note`;
    return toEntry(r);
  });
}

/** Removes an entry and closes the gap: every later entry moves up one. */
export async function deleteEntry(input: DeleteEntryInput): Promise<void> {
  const { year, month, row } = input;
  await withTransaction(async (tx) => {
    await assertYearExists(tx, year);
    monthName(month);
    await lockMonthForWrite(tx, year, month);
    await assertWritable(tx, year, month);
    const entry = await findEntry(tx, year, month, row);
    await tx`delete from expenses where id = ${row}`;
    await tx`
      update expenses set position = position - 1
      where year = ${year} and month = ${month} and position > ${entry.position}`;
  });
}

/** Moves an entry to another entry's position within the same month
 * (drag-to-reorder): `fromRow` and `toRow` are entry ids. The entries in
 * between shift by one toward the gap, the same result as the Excel
 * edition's remove-then-insert; each keeps its own category and card note
 * (including notes like "CC (200)"). Positions pass through duplicates
 * mid-statement, which the deferred unique constraint allows. */
export async function moveEntry(input: MoveEntryInput): Promise<void> {
  const { year, month, fromRow, toRow } = input;
  await withTransaction(async (tx) => {
    await assertYearExists(tx, year);
    monthName(month);
    await lockMonthForWrite(tx, year, month);
    await assertWritable(tx, year, month);
    const from = await findEntry(tx, year, month, fromRow);

    let target: { position: number } | undefined;
    if (isPossibleId(toRow)) {
      [target] = await tx<{ position: number }[]>`
        select position from expenses where id = ${toRow} and year = ${year} and month = ${month}`;
    }
    if (!target) throw new LedgerError(`Invalid target row: ${toRow}`, 400);
    if (fromRow === toRow) return;

    const fromPos = from.position;
    const toPos = target.position;
    if (fromPos < toPos) {
      await tx`
        update expenses set position = position - 1
        where year = ${year} and month = ${month} and position > ${fromPos} and position <= ${toPos}`;
    } else {
      await tx`
        update expenses set position = position + 1
        where year = ${year} and month = ${month} and position >= ${toPos} and position < ${fromPos}`;
    }
    await tx`update expenses set position = ${toPos} where id = ${fromRow}`;
  });
}
