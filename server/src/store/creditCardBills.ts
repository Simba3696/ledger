import { getSql } from "../db/client.js";
import { withTransaction } from "../db/tx.js";
import { LedgerError } from "../errors.js";
import { assertMoney, assertText, isRealDate } from "./validate.js";
import { summarize, type CardBill, type MonthBills, type MonthBillsSummary } from "../domain/creditCardMath.js";

export { type CardBill, type MonthBills, type MonthBillsSummary } from "../domain/creditCardMath.js";

export const EARLIEST_YEAR = 2018;
/** The `year` column is int4. The Excel edition had no upper bound; this is
 * only the column's limit, checked here so a huge year gets this store's own
 * "Invalid year" 400 rather than the generic out-of-range database error. */
export const LATEST_YEAR = 2147483647;

export interface SetMonthBillsInput {
  year: number;
  month: number;
  cards: CardBill[];
}

interface CardBillRow {
  month: number;
  position: number;
  name: string;
  due: number;
  paid: number;
  due_date: string | null; // 'YYYY-MM-DD' (date parser override in db/client.ts)
  settled: boolean;
}

function toEntry(r: CardBillRow): CardBill {
  return { name: r.name, due: r.due, paid: r.paid, dueDate: r.due_date, settled: r.settled };
}

function validateYear(year: number) {
  if (!Number.isInteger(year) || year < EARLIEST_YEAR || year > LATEST_YEAR) {
    throw new LedgerError(`Invalid year: ${year}`, 400);
  }
}

function validateYearMonth(year: number, month: number) {
  validateYear(year);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new LedgerError(`Invalid month: ${month}`, 400);
}

function validateCards(cards: CardBill[]) {
  for (const card of cards) {
    if (!card.name || !card.name.trim()) throw new LedgerError("Each card needs a name", 400);
    if (!Number.isFinite(card.due)) throw new LedgerError(`Amount due for "${card.name}" must be a number`, 400);
    if (!Number.isFinite(card.paid)) throw new LedgerError(`Amount paid for "${card.name}" must be a number`, 400);
    if (card.dueDate !== null && !isRealDate(card.dueDate)) {
      throw new LedgerError(`Due date for "${card.name}" must be YYYY-MM-DD or null`, 400);
    }
    if (typeof card.settled !== "boolean") {
      throw new LedgerError(`Settled flag for "${card.name}" must be a boolean`, 400);
    }
    // The checks above keep the Excel edition's messages; these add only the
    // column limits (text can't hold NUL; numeric(14,2) bounds). Due and paid
    // stay signed, as before — the old rules only required a finite number.
    assertText(card.name, "Card name");
    assertMoney(card.due, { positive: false });
    assertMoney(card.paid, { positive: false });
  }
}

/** One month's cards, in the order they were saved (`position`). */
export async function getMonthBills(year: number, month: number): Promise<MonthBills> {
  validateYearMonth(year, month);
  const sql = getSql();
  const rows = await sql<CardBillRow[]>`
    select month, position, name, due, paid, due_date, settled
    from card_bills where year = ${year} and month = ${month}
    order by position`;
  return { year, month, cards: rows.map(toEntry) };
}

/** Whole-month replace (LLD §4.3): the month's rows are deleted and the new
 * list inserted at positions 0..n-1 in one transaction, the same semantics
 * as the Excel edition overwriting the month's JSON cell. An empty list
 * clears the month. Returns the month as saved, so amounts come back
 * rounded to the column's 2 decimals. */
export async function setMonthBills(input: SetMonthBillsInput): Promise<MonthBills> {
  const { year, month, cards } = input;
  validateYearMonth(year, month);
  validateCards(cards);

  return withTransaction(async (tx) => {
    // The Excel edition serialized saves with withFileLock (last writer wins).
    // Without a lock, two overlapping saves to an empty or just-saved month
    // both miss each other's rows in the delete and the second insert hits
    // unique(year, month, position) as a 409. A per-month transaction lock
    // (released at commit/rollback) restores last-writer-wins; the two-int
    // form namespaces the key away from any other advisory-lock user. The
    // month key is hashed rather than computed (year * 100 + month would
    // overflow int4 for years the column still accepts); a hash collision
    // only serializes two unrelated saves, which is harmless.
    await tx`select pg_advisory_xact_lock(hashtext('card_bills'), hashtext(${`${year}-${month}`}))`;
    await tx`delete from card_bills where year = ${year} and month = ${month}`;
    if (cards.length === 0) return { year, month, cards: [] };

    const values = cards.map((c, position) => ({
      year,
      month,
      position,
      name: c.name,
      due: c.due,
      paid: c.paid,
      due_date: c.dueDate,
      settled: c.settled,
    }));
    const rows = await tx<CardBillRow[]>`
      insert into card_bills ${tx(values, "year", "month", "position", "name", "due", "paid", "due_date", "settled")}
      returning month, position, name, due, paid, due_date, settled`;
    // insert ... returning doesn't promise row order, so sort by position.
    const saved = [...rows].sort((a, b) => a.position - b.position);
    return { year, month, cards: saved.map(toEntry) };
  });
}

/** All 12 months of a year, each independently summarized (unlike Finances,
 * there's no running/cumulative figure here — every month's bills stand on
 * their own). Months with nothing entered come back with an empty card list
 * and zeroed totals rather than being omitted, so the UI can always render
 * a full 12-row year. */
export async function yearBillsSummary(year: number): Promise<MonthBillsSummary[]> {
  validateYear(year);

  const sql = getSql();
  const rows = await sql<CardBillRow[]>`
    select month, position, name, due, paid, due_date, settled
    from card_bills where year = ${year}
    order by month, position`;
  const byMonth = new Map<number, CardBill[]>();
  for (const r of rows) {
    const cards = byMonth.get(r.month) ?? [];
    cards.push(toEntry(r));
    byMonth.set(r.month, cards);
  }

  const results: MonthBillsSummary[] = [];
  for (let month = 1; month <= 12; month++) {
    results.push(summarize({ year, month, cards: byMonth.get(month) ?? [] }));
  }
  return results;
}
