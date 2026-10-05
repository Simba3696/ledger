import { describe, it, expect, beforeAll, afterAll } from "vitest";
// Expenses now live in Postgres: dbHelpers must load before any store module.
import { sql, resetTables, closeSql } from "./dbHelpers.js";
import postgres from "postgres";
import * as ledger from "../src/store/ledger.js";
import { seedYear } from "./ledgerSeed.js";

// The cases below build on each other within each describe, the same way
// the Excel edition's per-year scratch workbooks did, so the tables are
// wiped once up front rather than before every case. Each describe uses its
// own year, as each used its own workbook. categories too, so the first
// read re-creates DEFAULT_CATEGORIES, as a fresh scratch folder's missing
// categories.json did.
await resetTables("expenses", "month_locks", "ledger_years", "categories");

/** An id no entry has (ids are identity values starting at 1). Stands in for
 * the Excel tests' header row / past-the-end sheet row numbers. */
const MISSING_ID = 999_999;

afterAll(async () => {
  await closeSql();
});

describe("listMonth", () => {
  const YEAR = 2091;

  beforeAll(async () => {
    await seedYear(YEAR, [
      {
        month: 1,
        entries: [
          { amount: 100, remarks: "Lunch", category: "food" },
          { amount: 50, remarks: "Bus fare", category: "transportation", isCard: true },
        ],
      },
    ]);
  });

  it("reads entries with correct amount, category, and card status", async () => {
    const entries = await ledger.listMonth(YEAR, 1);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ amount: 100, remarks: "Lunch", category: "food", isCard: false });
    expect(entries[1]).toMatchObject({ amount: 50, remarks: "Bus fare", category: "transportation", isCard: true });
  });

  it("throws a 404 LedgerError for a year with no workbook", async () => {
    await expect(ledger.listMonth(2999, 1)).rejects.toMatchObject({ status: 404 });
  });
});

describe("appendEntry auto-creates a missing year's workbook", () => {
  const YEAR = 2097;

  it("creates all 12 month sheets and adds the entry, on a year with no file at all", async () => {
    // No rows for this year at all: it reads as missing, as a year with no
    // workbook file did.
    await expect(ledger.listMonth(YEAR, 3)).rejects.toMatchObject({ status: 404 });

    const result = await ledger.appendEntry({
      year: YEAR,
      month: 3,
      amount: 500,
      remarks: "First entry of a brand-new year",
      category: "rent",
      isCard: false,
    });
    expect(result).toMatchObject({ amount: 500 });

    // The year now exists: the entry is listed, and every other month reads
    // as empty rather than missing.
    expect((await ledger.listMonth(YEAR, 3)).map((e) => e.row)).toEqual([result.row]);
    expect(await ledger.listMonth(YEAR, 12)).toEqual([]);
  });

  it("does not throw for other years that still genuinely have no workbook", async () => {
    // listMonth/updateEntry/etc. are unaffected — only appendEntry auto-creates.
    await expect(ledger.listMonth(2098, 1)).rejects.toMatchObject({ status: 404 });
  });
});

describe("appendEntry", () => {
  const YEAR = 2092;
  let existingRow: number;

  beforeAll(async () => {
    const ids = await seedYear(YEAR, [
      { month: 1, entries: [{ amount: 100, remarks: "Existing entry", category: "food" }] },
      { month: 2, entries: [], locked: true },
    ]);
    existingRow = ids[1][0];
  });

  it("appends a cash entry with correct alignment, fill, and blank CC cell", async () => {
    const result = await ledger.appendEntry({
      year: YEAR,
      month: 1,
      amount: 42,
      remarks: "New cash entry",
      category: "transportation",
      isCard: false,
    });
    expect(result).toMatchObject({ amount: 42, remarks: "New cash entry", isCard: false });

    // Stored after the existing entry, with its category and no card note
    // (the Excel test's fill colour and blank CC cell).
    const entries = await ledger.listMonth(YEAR, 1);
    expect(entries.map((e) => e.row)).toEqual([existingRow, result.row]);
    expect(entries[1]).toEqual({
      row: result.row,
      amount: 42,
      remarks: "New cash entry",
      isCard: false,
      cardNote: null,
      category: "transportation",
    });
  });

  it("appends a card entry with a styled CC cell", async () => {
    const result = await ledger.appendEntry({
      year: YEAR,
      month: 1,
      amount: 15,
      remarks: "Card entry",
      category: "rent",
      isCard: true,
    });
    expect(result).toMatchObject({ isCard: true, cardNote: "CC", category: "rent" });
    const entries = await ledger.listMonth(YEAR, 1);
    expect(entries[2]).toMatchObject({ row: result.row, isCard: true, cardNote: "CC", category: "rent" });
  });

  it("rejects a non-positive amount", async () => {
    await expect(
      ledger.appendEntry({ year: YEAR, month: 1, amount: 0, remarks: "x", category: "food", isCard: false }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects blank remarks", async () => {
    await expect(
      ledger.appendEntry({ year: YEAR, month: 1, amount: 10, remarks: "   ", category: "food", isCard: false }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to write to a protected sheet", async () => {
    await expect(
      ledger.appendEntry({ year: YEAR, month: 2, amount: 10, remarks: "x", category: "food", isCard: false }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("updateEntry", () => {
  const YEAR = 2093;
  // Ids of January's entries, in order (the Excel test's rows 2..5), and of
  // February's one entry (in a locked month).
  let groceries: number, fuel: number, snacks: number, rent: number, lockedEntry: number;

  beforeAll(async () => {
    const ids = await seedYear(YEAR, [
      {
        month: 1,
        entries: [
          { amount: 100, remarks: "Groceries", category: "food" },
          { amount: 200, remarks: "Fuel", category: "transportation" },
          { amount: 50, remarks: "Snacks", category: "food" },
          { amount: 300, remarks: "Rent", category: "rent" },
        ],
      },
      { month: 2, entries: [{ amount: 10, remarks: "x", category: "food" }], locked: true },
    ]);
    [groceries, fuel, snacks, rent] = ids[1];
    lockedEntry = ids[2][0];
  });

  async function entry(row: number) {
    const found = (await ledger.listMonth(YEAR, 1)).find((e) => e.row === row);
    if (!found) throw new Error(`No entry ${row}`);
    return found;
  }

  it("updates amount, remarks, and category", async () => {
    const result = await ledger.updateEntry({
      year: YEAR,
      month: 1,
      row: groceries,
      amount: 150,
      remarks: "Groceries (updated)",
      category: "other",
      isCard: false,
    });
    expect(result).toMatchObject({ amount: 150, remarks: "Groceries (updated)", category: "other" });

    expect((await entry(groceries)).category).toBe("other");
  });

  it("does NOT change row 4's category, despite having shared row 2's style object before the edit — regression test for the shared-style-object bug", async () => {
    // Postgres has no shared style objects, but the behaviour still holds:
    // editing one entry must not touch any other, including one that had the
    // same category before the edit.
    expect((await entry(snacks)).category).toBe("food"); // still food

    expect((await entry(fuel)).category).toBe("transportation"); // still transportation

    // And the other direction: editing row 4 now must not re-corrupt row 2.
    await ledger.updateEntry({
      year: YEAR,
      month: 1,
      row: snacks,
      amount: 999,
      remarks: "Snacks (updated)",
      category: "rent",
      isCard: false,
    });
    expect((await entry(groceries)).category).toBe("other"); // still "other"
  });

  it("toggling isCard on adds a styled CC cell, toggling it off clears it", async () => {
    await ledger.updateEntry({
      year: YEAR,
      month: 1,
      row: rent,
      amount: 300,
      remarks: "Rent",
      category: "rent",
      isCard: true,
    });
    expect(await entry(rent)).toMatchObject({ isCard: true, cardNote: "CC" });

    await ledger.updateEntry({
      year: YEAR,
      month: 1,
      row: rent,
      amount: 300,
      remarks: "Rent",
      category: "rent",
      isCard: false,
    });
    expect(await entry(rent)).toMatchObject({ isCard: false, cardNote: null });
  });

  it("rejects editing a row that isn't a real entry", async () => {
    await expect(
      ledger.updateEntry({ year: YEAR, month: 1, row: MISSING_ID, amount: 10, remarks: "x", category: "food", isCard: false }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses to write to a protected sheet", async () => {
    await expect(
      ledger.updateEntry({ year: YEAR, month: 2, row: lockedEntry, amount: 10, remarks: "x", category: "food", isCard: false }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("deleteEntry", () => {
  const YEAR = 2094;
  let third: number, lockedEntry: number;

  beforeAll(async () => {
    const ids = await seedYear(YEAR, [
      {
        month: 1,
        entries: [
          { amount: 100, remarks: "First", category: "food" },
          { amount: 200, remarks: "Second", category: "food" },
          { amount: 300, remarks: "Third", category: "rent" },
        ],
      },
      { month: 2, entries: [{ amount: 10, remarks: "x", category: "food" }], locked: true },
    ]);
    third = ids[1][2];
    lockedEntry = ids[2][0];
  });

  it("removes the row and shifts everything below it up", async () => {
    await ledger.deleteEntry({ year: YEAR, month: 1, row: third }); // delete "Third" (the last row)
    const entries = await ledger.listMonth(YEAR, 1);
    expect(entries.map((e) => e.remarks)).toEqual(["First", "Second"]);
  });

  it("does not corrupt a row that shared a style with the new last row — regression test for the shared-style-object bug in fixClosingBorder", async () => {
    // Postgres has no shared styles or closing border, but the behaviour
    // still holds: the delete must leave the surviving entries' categories
    // alone, including "First", which had the same category as the new last.
    const entries = await ledger.listMonth(YEAR, 1);
    expect(entries.map((e) => [e.remarks, e.category])).toEqual([
      ["First", "food"],
      ["Second", "food"],
    ]);
  });

  it("rejects deleting a row that isn't a real entry", async () => {
    await expect(ledger.deleteEntry({ year: YEAR, month: 1, row: MISSING_ID })).rejects.toMatchObject({ status: 404 });
  });

  it("refuses to write to a protected sheet", async () => {
    await expect(ledger.deleteEntry({ year: YEAR, month: 2, row: lockedEntry })).rejects.toMatchObject({ status: 403 });
  });
});

describe("moveEntry", () => {
  const YEAR = 2095;
  let alphaRow: number, charlieRow: number;

  beforeAll(async () => {
    const ids = await seedYear(YEAR, [
      {
        month: 1,
        entries: [
          { amount: 10, remarks: "Alpha", category: "food" },
          { amount: 20, remarks: "Bravo", category: "transportation", isCard: true },
          { amount: 30, remarks: "Charlie", category: "rent" },
        ],
      },
    ]);
    [alphaRow, , charlieRow] = ids[1];
  });

  it("reorders entries and preserves each one's own category and card status", async () => {
    await ledger.moveEntry({ year: YEAR, month: 1, fromRow: alphaRow, toRow: charlieRow }); // Alpha to the end
    const entries = await ledger.listMonth(YEAR, 1);
    expect(entries.map((e) => e.remarks)).toEqual(["Bravo", "Charlie", "Alpha"]);

    const bravo = entries.find((e) => e.remarks === "Bravo")!;
    expect(bravo).toMatchObject({ category: "transportation", isCard: true });
    const charlie = entries.find((e) => e.remarks === "Charlie")!;
    expect(charlie).toMatchObject({ category: "rent", isCard: false });
    const alpha = entries.find((e) => e.remarks === "Alpha")!;
    expect(alpha).toMatchObject({ category: "food", isCard: false });
  });

  it("is a no-op when fromRow equals toRow", async () => {
    const before = await ledger.listMonth(YEAR, 1);
    await ledger.moveEntry({ year: YEAR, month: 1, fromRow: alphaRow, toRow: alphaRow });
    const after = await ledger.listMonth(YEAR, 1);
    expect(after).toEqual(before);
  });

  it("rejects an out-of-range target row", async () => {
    await expect(ledger.moveEntry({ year: YEAR, month: 1, fromRow: alphaRow, toRow: MISSING_ID })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("yearSummary", () => {
  const YEAR = 2096;

  beforeAll(async () => {
    await seedYear(YEAR, [
      {
        month: 1,
        entries: [
          { amount: 100, remarks: "a", category: "food" },
          { amount: 50, remarks: "b", category: "food" },
          { amount: 30, remarks: "c", category: "transportation" },
        ],
      },
      // February deliberately has no entries at all, so this also covers a
      // missing month gracefully.
    ]);
  });

  it("aggregates category totals per month", async () => {
    const summary = await ledger.yearSummary(YEAR);
    expect(summary).toHaveLength(12);
    expect(summary[0]).toMatchObject({
      month: 1,
      categoryTotals: { food: 150, transportation: 30, rent: 0, other: 0 },
      total: 180,
    });
  });

  it("degrades to a zero row for a month with no sheet, instead of throwing", async () => {
    const summary = await ledger.yearSummary(YEAR);
    expect(summary[1]).toMatchObject({
      month: 2,
      categoryTotals: { food: 0, transportation: 0, rent: 0, other: 0 },
      total: 0,
    });
  });
});

describe("isMonthLocked / setMonthLocked", () => {
  const YEAR = 2098;

  beforeAll(async () => {
    await seedYear(YEAR, [
      { month: 1, entries: [{ amount: 10, remarks: "x", category: "food" }] },
      // February locked directly in the table (the Postgres form of a sheet
      // locked by hand in Excel, or by an earlier app session, and what the
      // importer writes for a protected sheet) — isMonthLocked must
      // recognize it as locked without ever having called setMonthLocked.
      { month: 2, entries: [], locked: true },
    ]);
  });

  it("reports a fresh, never-locked month as unlocked", async () => {
    expect(await ledger.isMonthLocked(YEAR, 1)).toBe(false);
  });

  it("reports a pre-protected sheet (e.g. locked by hand in Excel) as locked", async () => {
    expect(await ledger.isMonthLocked(YEAR, 2)).toBe(true);
  });

  it("reports a month in a year with no workbook on disk yet as unlocked, not an error", async () => {
    expect(await ledger.isMonthLocked(2999, 1)).toBe(false);
  });

  it("locking a month makes it report locked and rejects further writes", async () => {
    await ledger.setMonthLocked(YEAR, 1, true);
    expect(await ledger.isMonthLocked(YEAR, 1)).toBe(true);
    await expect(
      ledger.appendEntry({ year: YEAR, month: 1, amount: 5, remarks: "blocked", category: "food", isCard: false }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("unlocking a month (including one pre-protected outside the app) restores writes", async () => {
    await ledger.setMonthLocked(YEAR, 1, false);
    expect(await ledger.isMonthLocked(YEAR, 1)).toBe(false);
    const added = await ledger.appendEntry({
      year: YEAR,
      month: 1,
      amount: 5,
      remarks: "allowed again",
      category: "food",
      isCard: false,
    });
    expect(added.remarks).toBe("allowed again");

    // The app's own unlock doesn't need to know how a month got locked, so
    // this also lifts the directly-locked February from the fixture just as
    // well as an app-locked one.
    await ledger.setMonthLocked(YEAR, 2, false);
    expect(await ledger.isMonthLocked(YEAR, 2)).toBe(false);
  });

  it("throws a 404 trying to lock a month in a year with no workbook", async () => {
    await expect(ledger.setMonthLocked(2999, 1, true)).rejects.toMatchObject({ status: 404 });
  });
});

// Regression test for a real lost-update bug: appendEntry used to read the
// sheet's current last row, compute rowNumber = lastRow + 1, then save —
// with no serialization, two overlapping requests (e.g. the phone and the
// desktop adding an expense in the same second) could both read the same
// "last row" and both write to the same new row, silently discarding
// whichever one saved second. The per-month advisory lock taken inside
// appendEntry's transaction now serializes the next-position read.
describe("concurrent writes to the same workbook", () => {
  const YEAR = 2099;

  it("appendEntry calls fired concurrently at the same month land on distinct rows, losing none", async () => {
    const count = 8;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        ledger.appendEntry({
          year: YEAR,
          month: 1,
          amount: i + 1,
          remarks: `Concurrent entry ${i}`,
          category: "food",
          isCard: false,
        }),
      ),
    );

    // Every call must have landed on its own row — no two entries collided
    // on the same row number (the exact failure mode this test guards
    // against).
    const rows = results.map((r) => r.row);
    expect(new Set(rows).size).toBe(count);

    // And every entry actually persisted — re-reading the month finds all
    // `count` remarks, not fewer.
    const entries = await ledger.listMonth(YEAR, 1);
    expect(entries).toHaveLength(count);
    const remarks = new Set(entries.map((e) => e.remarks));
    for (let i = 0; i < count; i++) {
      expect(remarks.has(`Concurrent entry ${i}`)).toBe(true);
    }
  });

  // The test above can't overlap anything: the store's pool has one
  // connection, so its transactions queue there with or without the lock.
  // This one writes from a second connection, as another server instance
  // would, while holding the month's advisory lock.
  it("an append waits for another connection's write to the same month, then lands after it", async () => {
    await seedYear(YEAR, []); // the default categories, for the direct insert below
    const other = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
    try {
      let append!: Promise<ledger.LedgerEntry>;
      await other.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext('expenses'), hashtext(${`${YEAR}-2`}))`;
        append = ledger.appendEntry({ year: YEAR, month: 2, amount: 2, remarks: "Waited", category: "food", isCard: false });
        append.catch(() => {}); // awaited below; don't report it as unhandled meanwhile

        // Only insert once the append is blocked on the lock, so without the
        // lock it would already have read the month's next position.
        const deadline = Date.now() + 5000;
        for (;;) {
          const [{ waiting }] = await tx<{ waiting: boolean }[]>`
            select exists (select 1 from pg_locks where locktype = 'advisory' and not granted) as waiting`;
          if (waiting) break;
          if (Date.now() > deadline) throw new Error("appendEntry never waited on the month's advisory lock");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await tx`
          insert into expenses (year, month, position, amount, remarks, category_id)
          values (${YEAR}, 2, 0, 1, 'Other connection', 'food')`;
      });

      const added = await append;
      const rows = await sql<{ id: number; position: number; remarks: string }[]>`
        select id, position, remarks from expenses where year = ${YEAR} and month = 2 order by position`;
      expect(rows.map((r) => [r.position, r.remarks])).toEqual([
        [0, "Other connection"],
        [1, "Waited"],
      ]);
      expect(rows[1].id).toBe(added.row);
    } finally {
      await other.end({ timeout: 5 });
    }
  });
});

// The Excel edition's workbook file outlived its rows: once a year had been
// written, deleting every entry left an empty workbook, not a missing one.
describe("a year stays created after its last entry is deleted", () => {
  const YEAR = 2087;

  it("lists the emptied month as [] and still allows locking it", async () => {
    const added = await ledger.appendEntry({ year: YEAR, month: 1, amount: 5, remarks: "Oops, wrong year", category: "food", isCard: false });
    await ledger.deleteEntry({ year: YEAR, month: 1, row: added.row });

    expect(await ledger.listMonth(YEAR, 1)).toEqual([]);
    expect(await ledger.listMonth(YEAR, 2)).toEqual([]);
    await ledger.setMonthLocked(YEAR, 1, true);
    expect(await ledger.isMonthLocked(YEAR, 1)).toBe(true);
    await ledger.setMonthLocked(YEAR, 1, false);
    expect(await ledger.isMonthLocked(YEAR, 1)).toBe(false);
  });
});

// The Excel edition loaded the year's workbook before looking at the month or
// the row, so a year nobody has written to failed the same way everywhere.
describe("a year with no workbook, checked before the month", () => {
  const NEVER = 2999;
  const noWorkbook = { status: 404, message: `No workbook found for year ${NEVER}` };

  it("update, delete and move 404 with the missing-workbook message, even with a bad month", async () => {
    for (const month of [1, 13]) {
      await expect(
        ledger.updateEntry({ year: NEVER, month, row: MISSING_ID, amount: 1, remarks: "x", category: "food", isCard: false }),
      ).rejects.toMatchObject(noWorkbook);
      await expect(ledger.deleteEntry({ year: NEVER, month, row: MISSING_ID })).rejects.toMatchObject(noWorkbook);
      await expect(ledger.moveEntry({ year: NEVER, month, fromRow: MISSING_ID, toRow: MISSING_ID })).rejects.toMatchObject(noWorkbook);
      await expect(ledger.listMonth(NEVER, month)).rejects.toMatchObject(noWorkbook);
      await expect(ledger.setMonthLocked(NEVER, month, true)).rejects.toMatchObject(noWorkbook);
    }
  });

  it("isMonthLocked is false for any month of it, and an existing year still rejects a bad month", async () => {
    expect(await ledger.isMonthLocked(NEVER, 13)).toBe(false);
    await ledger.appendEntry({ year: 2086, month: 1, amount: 1, remarks: "x", category: "food", isCard: false });
    await expect(ledger.isMonthLocked(2086, 13)).rejects.toMatchObject({ status: 400, message: "Invalid month: 13" });
    await expect(ledger.deleteEntry({ year: 2086, month: 13, row: MISSING_ID })).rejects.toMatchObject({
      status: 400,
      message: "Invalid month: 13",
    });
  });
});

describe("Postgres storage", () => {
  const YEAR = 2090;

  /** Each month's positions, in order — must always be 0..n-1. */
  async function positions(month: number): Promise<number[]> {
    const rows = await sql<{ position: number }[]>`
      select position from expenses where year = ${YEAR} and month = ${month} order by position`;
    return rows.map((r) => r.position);
  }

  it("keeps positions contiguous through appends, deletes and moves", async () => {
    const ids = await seedYear(YEAR, [
      {
        month: 1,
        entries: ["A", "B", "C", "D", "E"].map((remarks) => ({ amount: 1, remarks, category: "food" })),
      },
    ]);
    const [a, b, , d, e] = ids[1];

    await ledger.deleteEntry({ year: YEAR, month: 1, row: b }); // from the middle
    expect(await positions(1)).toEqual([0, 1, 2, 3]);

    await ledger.moveEntry({ year: YEAR, month: 1, fromRow: e, toRow: a }); // last to first (upward)
    expect((await ledger.listMonth(YEAR, 1)).map((x) => x.remarks)).toEqual(["E", "A", "C", "D"]);

    await ledger.moveEntry({ year: YEAR, month: 1, fromRow: a, toRow: d }); // downward
    expect((await ledger.listMonth(YEAR, 1)).map((x) => x.remarks)).toEqual(["E", "C", "D", "A"]);
    expect(await positions(1)).toEqual([0, 1, 2, 3]);

    const added = await ledger.appendEntry({ year: YEAR, month: 1, amount: 2, remarks: "F", category: "other", isCard: false });
    expect((await ledger.listMonth(YEAR, 1)).at(-1)!.row).toBe(added.row);
    expect(await positions(1)).toEqual([0, 1, 2, 3, 4]);
  });

  it("only touches the given month: an id from another month is a 404 there", async () => {
    const ids = await seedYear(YEAR, [{ month: 2, entries: [{ amount: 7, remarks: "Feb only", category: "food" }] }]);
    const febEntry = ids[2][0];
    await expect(
      ledger.updateEntry({ year: YEAR, month: 3, row: febEntry, amount: 1, remarks: "x", category: "food", isCard: false }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(ledger.deleteEntry({ year: YEAR, month: 3, row: febEntry })).rejects.toMatchObject({ status: 404 });
    await expect(ledger.moveEntry({ year: YEAR, month: 3, fromRow: febEntry, toRow: febEntry })).rejects.toMatchObject({
      status: 404,
    });
    expect(await ledger.listMonth(YEAR, 2)).toHaveLength(1);
  });

  it("a move keeps an imported card note; an update rewrites it as CC", async () => {
    const ids = await seedYear(YEAR, [
      {
        month: 4,
        entries: [
          { amount: 200, remarks: "Split bill", category: "food", isCard: true, cardNote: "CC (200)" },
          { amount: 5, remarks: "Other", category: "other" },
        ],
      },
    ]);
    const [split, other] = ids[4];
    await ledger.moveEntry({ year: YEAR, month: 4, fromRow: split, toRow: other });
    const moved = (await ledger.listMonth(YEAR, 4)).find((x) => x.row === split)!;
    expect(moved).toMatchObject({ isCard: true, cardNote: "CC (200)" });

    const updated = await ledger.updateEntry({
      year: YEAR,
      month: 4,
      row: split,
      amount: 200,
      remarks: "Split bill",
      category: "food",
      isCard: true,
    });
    expect(updated.cardNote).toBe("CC");
  });

  it("every write to a locked month is a 403 with the lock message, and changes nothing", async () => {
    const ids = await seedYear(YEAR, [
      { month: 5, entries: ["A", "B"].map((remarks) => ({ amount: 1, remarks, category: "food" })), locked: true },
    ]);
    const [a, b] = ids[5];
    const message =
      "May 2090 is locked. Unlock it first (from the app, or in Excel directly) if you really need to add an entry there.";
    const attempts = [
      () => ledger.appendEntry({ year: YEAR, month: 5, amount: 1, remarks: "x", category: "food", isCard: false }),
      () => ledger.updateEntry({ year: YEAR, month: 5, row: a, amount: 9, remarks: "x", category: "food", isCard: false }),
      () => ledger.deleteEntry({ year: YEAR, month: 5, row: a }),
      () => ledger.moveEntry({ year: YEAR, month: 5, fromRow: a, toRow: b }),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ status: 403, message });
    }
    expect((await ledger.listMonth(YEAR, 5)).map((x) => [x.row, x.remarks, x.amount])).toEqual([
      [a, "A", 1],
      [b, "B", 1],
    ]);
  });

  it("rejects column-breaking input with a 400 before writing", async () => {
    const base = { year: YEAR, month: 6, amount: 1, remarks: "x", category: "food", isCard: false };
    await expect(ledger.appendEntry({ ...base, remarks: "bad\u0000remark" })).rejects.toMatchObject({ status: 400 });
    await expect(ledger.appendEntry({ ...base, amount: 1e12 })).rejects.toMatchObject({ status: 400 });
    await expect(ledger.appendEntry({ ...base, amount: 0.001 })).rejects.toMatchObject({ status: 400 });
    await expect(ledger.appendEntry({ ...base, category: "nope" })).rejects.toMatchObject({
      status: 400,
      message: "Unknown category: nope",
    });
    await expect(ledger.appendEntry({ ...base, year: 2017 })).rejects.toMatchObject({ status: 400, message: "Invalid year: 2017" });
    await expect(ledger.appendEntry({ ...base, month: 13 })).rejects.toMatchObject({ status: 400, message: "Invalid month: 13" });
    expect(await ledger.listMonth(YEAR, 6)).toEqual([]);
  });

  it("stores amounts at 2 decimals and returns what was stored", async () => {
    const added = await ledger.appendEntry({ year: YEAR, month: 7, amount: 10.006, remarks: "  Rounded  ", category: "food", isCard: false });
    expect(added).toMatchObject({ amount: 10.01, remarks: "Rounded" });
  });

  it("yearExpenseTotals sums each month, zero where nothing was entered", async () => {
    await seedYear(2089, [
      { month: 3, entries: [{ amount: 10.25, remarks: "a", category: "food" }, { amount: 4.75, remarks: "b", category: "rent" }] },
      { month: 12, entries: [{ amount: 1, remarks: "c", category: "other" }] },
    ]);
    const totals = await ledger.yearExpenseTotals(2089);
    expect(totals).toHaveLength(13);
    expect(totals[3]).toBe(15);
    expect(totals[12]).toBe(1);
    expect(totals.filter((t) => t !== 0)).toHaveLength(2);
    expect(await ledger.yearExpenseTotals(2999)).toEqual(Array.from({ length: 13 }, () => 0));
  });
});
