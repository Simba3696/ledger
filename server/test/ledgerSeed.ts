// Seeds expenses and month locks straight into the local test database, the
// Postgres stand-in for the Excel edition's buildFixtureWorkbook. Import
// dbHelpers.js first in the test file (it sets DATABASE_URL).
import { sql } from "./dbHelpers.js";
import { loadCategoryConfig, type Category } from "../src/store/categories.js";

export interface SeedEntry {
  amount: number; // positive rupee amount
  remarks: string;
  category: Category;
  isCard?: boolean;
  /** Overrides the card note ("CC" when isCard), e.g. an imported "CC (200)". */
  cardNote?: string;
}

export interface SeedMonth {
  month: number;
  entries: SeedEntry[];
  /** Adds a month_locks row (the Excel edition's protected sheet). */
  locked?: boolean;
}

/** Inserts each month's entries at positions 0..n-1, in order, and returns
 * their ids per month (keyed by month number) — the values that stand in for
 * the sheet row numbers the Excel tests used. The categories table is
 * filled with the defaults first if it's empty, as the store would. */
export async function seedYear(year: number, months: SeedMonth[]): Promise<Record<number, number[]>> {
  await loadCategoryConfig();
  const ids: Record<number, number[]> = {};
  for (const { month, entries, locked } of months) {
    ids[month] = [];
    for (const [position, e] of entries.entries()) {
      const cardNote = e.cardNote ?? (e.isCard ? "CC" : null);
      const [{ id }] = await sql<{ id: number }[]>`
        insert into expenses (year, month, position, amount, remarks, category_id, card_note)
        values (${year}, ${month}, ${position}, ${e.amount}, ${e.remarks}, ${e.category}, ${cardNote})
        returning id`;
      ids[month].push(id);
    }
    if (locked) await sql`insert into month_locks (year, month) values (${year}, ${month})`;
  }
  return ids;
}
