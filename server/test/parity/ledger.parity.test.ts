import { describe, expect } from "vitest";
import type { EntryEdits, NewEntry } from "../../../client/src/api";
import { MISSING_ID, parity } from "./harness";
import type { SeedEntry } from "./seed";

// server/test/ledger.test.ts against both backends, one parity case per
// store case (same describe and title). The store cases share state within
// a describe; each case here plants what its predecessors left as a fixture
// or replays it. Sheet-era assertions (positions, ids) become getMonth
// listings, which is what the API shows of them.

function entry(year: number, month: number, amount: number, remarks: string, category: string, isCard = false): NewEntry {
  return { year, month, amount, remarks, category, isCard };
}

function edits(amount: number, remarks: string, category: string, isCard = false): EntryEdits {
  return { amount, remarks, category, isCard };
}

const food = (remarks: string, amount = 1): SeedEntry => ({ amount, remarks, category: "food" });

describe("listMonth", () => {
  const YEAR = 2091;
  const fixture = {
    expenses: [
      {
        year: YEAR,
        month: 1,
        entries: [
          { amount: 100, remarks: "Lunch", category: "food" },
          { amount: 50, remarks: "Bus fare", category: "transportation", isCard: true },
        ],
      },
    ],
  };

  parity("reads entries with correct amount, category, and card status", fixture, async (b) => {
    await b.getMonth(YEAR, 1);
  });

  parity("lists a month of a year with no entries as empty", fixture, async (b) => {
    await b.getMonth(2999, 1);
  });

  parity("rejects a year or month outside the column's range with a 400", fixture, async (b) => {
    await b.getMonth(2017, 1);
    await b.getMonth(Number.NaN, 1);
    await b.getMonth(YEAR, 13);
  });
});

describe("appendEntry into a year nobody has written to", () => {
  const YEAR = 2097;

  parity("adds the entry, with no setup step for the year", {}, async (b) => {
    await b.getMonth(YEAR, 3);
    await b.addEntry(entry(YEAR, 3, 500, "First entry of a brand-new year", "rent"));
    await b.getMonth(YEAR, 3);
    await b.getMonth(YEAR, 12);
  });

  parity("leaves other years that still have no entries listing as empty", {}, async (b) => {
    await b.addEntry(entry(YEAR, 3, 500, "First entry of a brand-new year", "rent"));
    await b.getMonth(2098, 1);
  });
});

describe("appendEntry", () => {
  const YEAR = 2092;
  const seeded = (extra: SeedEntry[] = []) => ({
    expenses: [
      { year: YEAR, month: 1, entries: [{ amount: 100, remarks: "Existing entry", category: "food" }, ...extra] },
      { year: YEAR, month: 2, entries: [], locked: true },
    ],
  });

  parity("appends a cash entry with correct alignment, fill, and blank CC cell", seeded(), async (b) => {
    await b.addEntry(entry(YEAR, 1, 42, "New cash entry", "transportation"));
    await b.getMonth(YEAR, 1);
  });

  parity(
    "appends a card entry with a styled CC cell",
    seeded([{ amount: 42, remarks: "New cash entry", category: "transportation" }]),
    async (b) => {
      await b.addEntry(entry(YEAR, 1, 15, "Card entry", "rent", true));
      await b.getMonth(YEAR, 1);
    },
  );

  parity("rejects a non-positive amount", seeded(), async (b) => {
    await b.addEntry(entry(YEAR, 1, 0, "x", "food"));
    await b.addEntry(entry(YEAR, 1, -5, "x", "food"));
  });

  parity("rejects blank remarks", seeded(), async (b) => {
    await b.addEntry(entry(YEAR, 1, 10, "   ", "food"));
    await b.addEntry(entry(YEAR, 1, 10, "", "food"));
  });

  parity("refuses to write to a protected sheet", seeded(), async (b) => {
    await b.addEntry(entry(YEAR, 2, 10, "x", "food"));
    await b.getMonth(YEAR, 2);
  });
});

describe("updateEntry", () => {
  const YEAR = 2093;
  const seeded = (january: SeedEntry[]) => ({
    expenses: [
      { year: YEAR, month: 1, entries: january },
      { year: YEAR, month: 2, entries: [food("x", 10)], locked: true },
    ],
  });
  const original: SeedEntry[] = [
    { amount: 100, remarks: "Groceries", category: "food" },
    { amount: 200, remarks: "Fuel", category: "transportation" },
    { amount: 50, remarks: "Snacks", category: "food" },
    { amount: 300, remarks: "Rent", category: "rent" },
  ];
  const afterFirstEdit: SeedEntry[] = [{ amount: 150, remarks: "Groceries (updated)", category: "other" }, ...original.slice(1)];

  parity("updates amount, remarks, and category", seeded(original), async (b, { ids }) => {
    await b.updateEntry(YEAR, 1, ids.expense(YEAR, 1, 0), edits(150, "Groceries (updated)", "other"));
    await b.getMonth(YEAR, 1);
  });

  parity(
    "does NOT change row 4's category, despite having shared row 2's style object before the edit — regression test for the shared-style-object bug",
    seeded(afterFirstEdit),
    async (b, { ids }) => {
      await b.getMonth(YEAR, 1);
      await b.updateEntry(YEAR, 1, ids.expense(YEAR, 1, 2), edits(999, "Snacks (updated)", "rent"));
      await b.getMonth(YEAR, 1);
    },
  );

  parity("toggling isCard on adds a styled CC cell, toggling it off clears it", seeded(original), async (b, { ids }) => {
    const rent = ids.expense(YEAR, 1, 3);
    await b.updateEntry(YEAR, 1, rent, edits(300, "Rent", "rent", true));
    await b.getMonth(YEAR, 1);
    await b.updateEntry(YEAR, 1, rent, edits(300, "Rent", "rent", false));
    await b.getMonth(YEAR, 1);
  });

  parity("rejects editing a row that isn't a real entry", seeded(original), async (b) => {
    await b.updateEntry(YEAR, 1, MISSING_ID, edits(10, "x", "food"));
  });

  parity("refuses to write to a protected sheet", seeded(original), async (b, { ids }) => {
    await b.updateEntry(YEAR, 2, ids.expense(YEAR, 2, 0), edits(10, "x", "food"));
    await b.getMonth(YEAR, 2);
  });
});

describe("deleteEntry", () => {
  const YEAR = 2094;
  const fixture = {
    expenses: [
      {
        year: YEAR,
        month: 1,
        entries: [food("First", 100), food("Second", 200), { amount: 300, remarks: "Third", category: "rent" }],
      },
      { year: YEAR, month: 2, entries: [food("x", 10)], locked: true },
    ],
  };

  parity("removes the row and shifts everything below it up", fixture, async (b, { ids }) => {
    await b.deleteEntry(YEAR, 1, ids.expense(YEAR, 1, 2));
    await b.getMonth(YEAR, 1);
  });

  parity(
    "does not corrupt a row that shared a style with the new last row — regression test for the shared-style-object bug in fixClosingBorder",
    fixture,
    async (b, { ids }) => {
      await b.deleteEntry(YEAR, 1, ids.expense(YEAR, 1, 2));
      await b.getMonth(YEAR, 1);
      await b.getYearSummary(YEAR);
    },
  );

  parity("rejects deleting a row that isn't a real entry", fixture, async (b) => {
    await b.deleteEntry(YEAR, 1, MISSING_ID);
  });

  parity("refuses to write to a protected sheet", fixture, async (b, { ids }) => {
    await b.deleteEntry(YEAR, 2, ids.expense(YEAR, 2, 0));
    await b.getMonth(YEAR, 2);
  });
});

describe("moveEntry", () => {
  const YEAR = 2095;
  const fixture = {
    expenses: [
      {
        year: YEAR,
        month: 1,
        entries: [
          { amount: 10, remarks: "Alpha", category: "food" },
          { amount: 20, remarks: "Bravo", category: "transportation", isCard: true },
          { amount: 30, remarks: "Charlie", category: "rent" },
        ],
      },
    ],
  };

  parity("reorders entries and preserves each one's own category and card status", fixture, async (b, { ids }) => {
    await b.moveEntry(YEAR, 1, ids.expense(YEAR, 1, 0), ids.expense(YEAR, 1, 2));
    await b.getMonth(YEAR, 1);
  });

  parity("is a no-op when fromRow equals toRow", fixture, async (b, { ids }) => {
    await b.moveEntry(YEAR, 1, ids.expense(YEAR, 1, 0), ids.expense(YEAR, 1, 2));
    await b.getMonth(YEAR, 1);
    await b.moveEntry(YEAR, 1, ids.expense(YEAR, 1, 0), ids.expense(YEAR, 1, 0));
    await b.getMonth(YEAR, 1);
  });

  parity("rejects an out-of-range target row", fixture, async (b, { ids }) => {
    await b.moveEntry(YEAR, 1, ids.expense(YEAR, 1, 0), MISSING_ID);
    await b.getMonth(YEAR, 1);
  });
});

describe("yearSummary", () => {
  const YEAR = 2096;
  const fixture = {
    expenses: [
      {
        year: YEAR,
        month: 1,
        entries: [food("a", 100), food("b", 50), { amount: 30, remarks: "c", category: "transportation" }],
      },
    ],
  };

  parity("aggregates category totals per month", fixture, async (b) => {
    const summary = await b.getYearSummary(YEAR);
    expect(summary[0]).toEqual({ month: 1, categoryTotals: { food: 150, transportation: 30, rent: 0, other: 0 }, total: 180 });
  });

  parity("degrades to a zero row for a month with no sheet, instead of throwing", fixture, async (b) => {
    await b.getYearSummary(YEAR);
  });
});

describe("isMonthLocked / setMonthLocked", () => {
  const YEAR = 2098;
  const fixture = (januaryLocked = false) => ({
    expenses: [
      { year: YEAR, month: 1, entries: [food("x", 10)], locked: januaryLocked },
      { year: YEAR, month: 2, entries: [], locked: true },
    ],
  });

  parity("reports a fresh, never-locked month as unlocked", fixture(), async (b) => {
    await b.getMonthLock(YEAR, 1);
  });

  parity("reports a pre-protected sheet (e.g. locked by hand in Excel) as locked", fixture(), async (b) => {
    await b.getMonthLock(YEAR, 2);
  });

  parity("reports a month in a year nobody has written to as unlocked, not an error", fixture(), async (b) => {
    await b.getMonthLock(2999, 1);
  });

  parity("locking a month makes it report locked and rejects further writes", fixture(), async (b) => {
    await b.setMonthLock(YEAR, 1, true);
    await b.getMonthLock(YEAR, 1);
    await b.addEntry(entry(YEAR, 1, 5, "blocked", "food"));
    await b.getMonth(YEAR, 1);
  });

  parity("unlocking a month (including one pre-protected outside the app) restores writes", fixture(true), async (b) => {
    await b.setMonthLock(YEAR, 1, false);
    await b.getMonthLock(YEAR, 1);
    await b.addEntry(entry(YEAR, 1, 5, "allowed again", "food"));
    await b.setMonthLock(YEAR, 2, false);
    await b.getMonthLock(YEAR, 2);
    await b.getMonth(YEAR, 1);
  });

  parity("locks and unlocks an empty month in a year nobody has written to", fixture(), async (b) => {
    const NEVER_WRITTEN = 2998;
    await b.setMonthLock(NEVER_WRITTEN, 1, true);
    await b.getMonthLock(NEVER_WRITTEN, 1);
    await b.getMonth(NEVER_WRITTEN, 1);
    await b.addEntry(entry(NEVER_WRITTEN, 1, 5, "blocked", "food"));
    await b.setMonthLock(NEVER_WRITTEN, 1, false);
    await b.getMonthLock(NEVER_WRITTEN, 1);
  });
});

describe("concurrent writes to the same workbook", () => {
  const YEAR = 2099;

  parity("appendEntry calls fired concurrently at the same month land on distinct rows, losing none", {}, async (b, { note, quietly }) => {
    // Which append commits first isn't defined on the SQL side, so the
    // comparison is on what the store case checks: every call gets its own
    // row and every entry is listed.
    const count = 8;
    const results = await quietly(() =>
      Promise.all(Array.from({ length: count }, (_, i) => b.addEntry(entry(YEAR, 1, i + 1, `Concurrent entry ${i}`, "food")))),
    );
    note("results in call order, rows aside", results.map(({ row: _row, ...rest }) => rest));
    note("distinct rows", new Set(results.map((r) => r.row)).size);
    const listed = await quietly(() => b.getMonth(YEAR, 1));
    note("listed", listed.length);
    note("listed remarks", listed.map((e) => e.remarks).sort());
    note("listed rows are the returned rows", new Set([...listed.map((e) => e.row), ...results.map((r) => r.row)]).size);
  });
});

describe("a year whose last entry is deleted", () => {
  const YEAR = 2087;

  parity("lists the emptied month as [] and still allows locking it", {}, async (b) => {
    const added = await b.addEntry(entry(YEAR, 1, 5, "Oops, wrong year", "food"));
    await b.deleteEntry(YEAR, 1, added.row);
    await b.getMonth(YEAR, 1);
    await b.getMonth(YEAR, 2);
    await b.setMonthLock(YEAR, 1, true);
    await b.getMonthLock(YEAR, 1);
    await b.setMonthLock(YEAR, 1, false);
    await b.getMonthLock(YEAR, 1);
  });
});

describe("a year nobody has written to behaves like an empty one", () => {
  const NEVER = 2999;

  parity("lists as empty, reports unlocked, and sums to zero", {}, async (b) => {
    await b.getMonth(NEVER, 1);
    await b.getMonthLock(NEVER, 1);
    await b.getYearSummary(NEVER);
  });

  parity("update, delete and move of a missing id are the ordinary 404 for a missing entry", {}, async (b) => {
    await b.updateEntry(NEVER, 1, MISSING_ID, edits(1, "x", "food"));
    await b.deleteEntry(NEVER, 1, MISSING_ID);
    await b.moveEntry(NEVER, 1, MISSING_ID, MISSING_ID);
  });

  parity("rejects a bad month with a 400 everywhere, as an existing year does", {}, async (b) => {
    for (const year of [NEVER, 2086]) {
      if (year === 2086) await b.addEntry(entry(year, 1, 1, "x", "food"));
      await b.getMonth(year, 13);
      await b.getMonthLock(year, 13);
      await b.setMonthLock(year, 13, true);
      await b.updateEntry(year, 13, MISSING_ID, edits(1, "x", "food"));
      await b.deleteEntry(year, 13, MISSING_ID);
      await b.moveEntry(year, 13, MISSING_ID, MISSING_ID);
    }
  });

  parity("rejects a year the column can't hold with a 400 everywhere", {}, async (b) => {
    await b.getMonth(2017, 1);
    await b.getMonthLock(2017, 1);
    await b.setMonthLock(2017, 1, true);
    await b.updateEntry(2017, 1, MISSING_ID, edits(1, "x", "food"));
    await b.deleteEntry(2017, 1, MISSING_ID);
    await b.moveEntry(2017, 1, MISSING_ID, MISSING_ID);
  });
});

describe("Postgres storage", () => {
  const YEAR = 2090;

  parity(
    "keeps positions contiguous through appends, deletes and moves",
    { expenses: [{ year: YEAR, month: 1, entries: ["A", "B", "C", "D", "E"].map((r) => food(r)) }] },
    async (b, { ids }) => {
      const [a, bRow, , d, e] = [0, 1, 2, 3, 4].map((i) => ids.expense(YEAR, 1, i));
      await b.deleteEntry(YEAR, 1, bRow);
      await b.getMonth(YEAR, 1);
      await b.moveEntry(YEAR, 1, e, a); // last to first (upward)
      expect((await b.getMonth(YEAR, 1)).map((x) => x.remarks)).toEqual(["E", "A", "C", "D"]);
      await b.moveEntry(YEAR, 1, a, d); // downward
      expect((await b.getMonth(YEAR, 1)).map((x) => x.remarks)).toEqual(["E", "C", "D", "A"]);
      await b.addEntry(entry(YEAR, 1, 2, "F", "other"));
      await b.getMonth(YEAR, 1);
    },
  );

  parity(
    "only touches the given month: an id from another month is a 404 there",
    { expenses: [{ year: YEAR, month: 2, entries: [food("Feb only", 7)] }] },
    async (b, { ids }) => {
      const febEntry = ids.expense(YEAR, 2, 0);
      await b.updateEntry(YEAR, 3, febEntry, edits(1, "x", "food"));
      await b.deleteEntry(YEAR, 3, febEntry);
      await b.moveEntry(YEAR, 3, febEntry, febEntry);
      await b.getMonth(YEAR, 2);
    },
  );

  parity(
    "a move keeps an imported card note; an update rewrites it as CC",
    {
      expenses: [
        {
          year: YEAR,
          month: 4,
          entries: [
            { amount: 200, remarks: "Split bill", category: "food", isCard: true, cardNote: "CC (200)" },
            { amount: 5, remarks: "Other", category: "other" },
          ],
        },
      ],
    },
    async (b, { ids }) => {
      const [split, other] = [ids.expense(YEAR, 4, 0), ids.expense(YEAR, 4, 1)];
      await b.moveEntry(YEAR, 4, split, other);
      await b.getMonth(YEAR, 4);
      await b.updateEntry(YEAR, 4, split, edits(200, "Split bill", "food", true));
      await b.getMonth(YEAR, 4);
    },
  );

  parity(
    "every write to a locked month is a 403 with the lock message, and changes nothing",
    { expenses: [{ year: YEAR, month: 5, entries: [food("A"), food("B")], locked: true }] },
    async (b, { ids }) => {
      const [a, bRow] = [ids.expense(YEAR, 5, 0), ids.expense(YEAR, 5, 1)];
      await b.addEntry(entry(YEAR, 5, 1, "x", "food"));
      await b.updateEntry(YEAR, 5, a, edits(9, "x", "food"));
      await b.deleteEntry(YEAR, 5, a);
      await b.moveEntry(YEAR, 5, a, bRow);
      await b.getMonth(YEAR, 5);
    },
  );

  parity("rejects column-breaking input with a 400 before writing", {}, async (b) => {
    const base = entry(YEAR, 6, 1, "x", "food");
    await b.addEntry({ ...base, remarks: "bad\u0000remark" });
    await b.addEntry({ ...base, amount: 1e12 });
    await b.addEntry({ ...base, amount: 0.001 });
    await b.addEntry({ ...base, category: "nope" });
    await b.addEntry({ ...base, year: 2017 });
    await b.addEntry({ ...base, month: 13 });
    await b.getMonth(YEAR, 6);
  });

  parity("stores amounts at 2 decimals and returns what was stored", {}, async (b) => {
    const added = await b.addEntry(entry(YEAR, 7, 10.006, "  Rounded  ", "food"));
    expect(added).toMatchObject({ amount: 10.01, remarks: "Rounded" });
    await b.getMonth(YEAR, 7);
  });
});

describe("document parity: expenses", () => {
  const YEAR = 2085;

  parity("addEntry with 1.005 returns and lists 1.01", {}, async (b) => {
    const added = await b.addEntry(entry(YEAR, 1, 1.005, "Half a paisa up", "food"));
    expect(added.amount).toBe(1.01);
    expect((await b.getMonth(YEAR, 1))[0].amount).toBe(1.01);
    await b.addEntry(entry(YEAR, 1, 2.675, "Another binary half", "food"));
    await b.getMonth(YEAR, 1);
  });

  parity(
    "amounts 0.1 and 0.2 in one month give a getYearSummary total of exactly 0.3",
    {
      expenses: [
        { year: YEAR, month: 1, entries: [food("a", 0.1), food("b", 0.2)] },
        // Across categories the store adds the per-category sums in JS, so
        // this month's total is 0.1 + 0.2 there too.
        { year: YEAR, month: 2, entries: [food("a", 0.1), { amount: 0.2, remarks: "b", category: "rent" }] },
      ],
    },
    async (b) => {
      const summary = await b.getYearSummary(YEAR);
      expect(summary[0].total).toBe(0.3);
      expect(summary[0].categoryTotals.food).toBe(0.3);
    },
  );

  parity(
    "locked month: add, update, delete and move each return 403 with the exact ledger.ts:133-136 message",
    { expenses: [{ year: YEAR, month: 3, entries: [food("A"), food("B")], locked: true }] },
    async (b, { ids, lastError }) => {
      const locked = {
        status: 403,
        message: `March ${YEAR} is locked. Unlock it first from the app if you really need to add an entry there.`,
      };
      const [a, bRow] = [ids.expense(YEAR, 3, 0), ids.expense(YEAR, 3, 1)];
      await b.addEntry(entry(YEAR, 3, 1, "x", "food"));
      expect(lastError()).toEqual(locked);
      await b.updateEntry(YEAR, 3, a, edits(9, "x", "food"));
      expect(lastError()).toEqual(locked);
      await b.deleteEntry(YEAR, 3, a);
      expect(lastError()).toEqual(locked);
      await b.moveEntry(YEAR, 3, a, bRow);
      expect(lastError()).toEqual(locked);
      // The lock is checked before the row, so a missing row is the 403 too.
      await b.deleteEntry(YEAR, 3, MISSING_ID);
      expect(lastError()).toEqual(locked);
      await b.getMonth(YEAR, 3);
    },
  );

  parity("validation order: appendEntry with an invalid amount and an invalid year reports the amount error", {}, async (b, { lastError }) => {
    await b.addEntry(entry(2017, 1, 0, "x", "food"));
    expect(lastError()).toEqual({ status: 400, message: "Amount must be a positive number" });
    await b.addEntry(entry(2017, 13, 5, "   ", "food"));
    await b.addEntry(entry(2017, 13, 5, "x", "nope"));
    await b.addEntry(entry(2017, 13, 5, "x\u0000", "food"));
    await b.addEntry(entry(2017, 13, 5, "x", "food"));
    await b.addEntry(entry(YEAR, 13, 1e12, "x", "food"));
    await b.updateEntry(2017, 13, MISSING_ID, edits(-1, "x", "food"));
    await b.updateEntry(2017, 13, MISSING_ID, edits(1, "x", "food"));
    await b.updateEntry(YEAR, 13, MISSING_ID, edits(1, "x", "food"));
    await b.moveEntry(2017, 13, MISSING_ID, MISSING_ID);
  });

  parity(
    "after a delete and after a move in both directions, getMonth order equals the SQL order",
    { expenses: [{ year: YEAR, month: 4, entries: ["A", "B", "C", "D", "E", "F"].map((r) => food(r)) }] },
    async (b, { ids }) => {
      const row = (i: number) => ids.expense(YEAR, 4, i);
      await b.deleteEntry(YEAR, 4, row(2));
      await b.getMonth(YEAR, 4);
      await b.moveEntry(YEAR, 4, row(0), row(4)); // down, to just after E
      await b.getMonth(YEAR, 4);
      await b.moveEntry(YEAR, 4, row(5), row(1)); // up, to just before B
      await b.getMonth(YEAR, 4);
      await b.moveEntry(YEAR, 4, row(3), row(5)); // up, to the very start
      await b.getMonth(YEAR, 4);
      await b.moveEntry(YEAR, 4, row(3), row(0)); // down, to the very end
      await b.getMonth(YEAR, 4);
      await b.moveEntry(YEAR, 4, row(1), row(4)); // down by one
      await b.getMonth(YEAR, 4);
      await b.addEntry(entry(YEAR, 4, 3, "G", "food"));
      await b.moveEntry(YEAR, 4, row(4), row(1)); // up by one
      await b.deleteEntry(YEAR, 4, row(3));
      await b.getMonth(YEAR, 4);
    },
  );

  parity("an unknown category is a 400", { expenses: [{ year: YEAR, month: 5, entries: [food("A")] }] }, async (b, { ids }) => {
    await b.addEntry(entry(YEAR, 5, 1, "x", "nope"));
    await b.addEntry({ ...entry(YEAR, 5, 1, "x", "food"), category: null as unknown as string });
    await b.addEntry({ ...entry(YEAR, 5, 1, "x", "food"), category: 7 as unknown as string });
    await b.addEntry({ year: YEAR, month: 5, amount: 1, remarks: "x", isCard: false } as NewEntry);
    await b.updateEntry(YEAR, 5, ids.expense(YEAR, 5, 0), edits(1, "A", "Food"));
    await b.getMonth(YEAR, 5);
  });

  parity(
    "an imported uncategorised entry lists with a null category and counts toward the total only",
    {
      expenses: [
        { year: YEAR, month: 6, entries: [{ amount: 12.5, remarks: "Imported", category: null }, food("Lunch", 7.25)] },
      ],
    },
    async (b, { ids }) => {
      await b.getMonth(YEAR, 6);
      await b.getYearSummary(YEAR);
      await b.updateEntry(YEAR, 6, ids.expense(YEAR, 6, 0), edits(12.5, "Imported", "other"));
      await b.getMonth(YEAR, 6);
    },
  );

  parity("arguments make the HTTP round trip: NaN, numeric strings, truthy flags and odd rows", { expenses: [{ year: YEAR, month: 7, entries: [food("A"), food("B")] }] }, async (b, { ids }) => {
    await b.addEntry(entry(YEAR, 7, Number.NaN, "x", "food"));
    await b.addEntry({ ...entry(YEAR, 7, 1, "x", "food"), amount: "12.5" as unknown as number });
    await b.addEntry({ ...entry(YEAR, 7, 1, "x", "food"), isCard: "yes" as unknown as boolean });
    await b.addEntry({ ...entry(YEAR, 7, 1, "x", "food"), remarks: 42 as unknown as string });
    await b.addEntry({ ...entry(YEAR, 7, 1, "x", "food"), year: `${YEAR}` as unknown as number, month: "7" as unknown as number });
    await b.addEntry({ ...entry(YEAR, 7, 1, "x", "food"), amount: Number.POSITIVE_INFINITY });
    await b.moveEntry(YEAR, 7, ids.expense(YEAR, 7, 0), Number.NaN);
    for (const row of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await b.updateEntry(YEAR, 7, row, edits(1, "x", "food"));
      await b.deleteEntry(YEAR, 7, row);
      await b.moveEntry(YEAR, 7, row, ids.expense(YEAR, 7, 0));
      await b.moveEntry(YEAR, 7, ids.expense(YEAR, 7, 0), row);
    }
    await b.getMonth(YEAR, 7.5);
    await b.getMonth(2147483647, 12);
    await b.getMonth(2147483648, 1);
    await b.getMonthLock(YEAR, 0);
    await b.getMonth(YEAR, 7);
  });

  parity(
    "a target from another month is an invalid target, and a month's own move leaves other months alone",
    {
      expenses: [
        { year: YEAR, month: 8, entries: [food("A"), food("B")] },
        { year: YEAR, month: 9, entries: [food("C")] },
      ],
    },
    async (b, { ids }) => {
      await b.moveEntry(YEAR, 8, ids.expense(YEAR, 8, 0), ids.expense(YEAR, 9, 0));
      await b.moveEntry(YEAR, 8, ids.expense(YEAR, 8, 1), ids.expense(YEAR, 8, 0));
      await b.getMonth(YEAR, 8);
      await b.getMonth(YEAR, 9);
    },
  );

  parity("year summaries for years the column can't hold are all zeros", {}, async (b) => {
    await b.getYearSummary(2017);
    await b.getYearSummary(Number.NaN);
    await b.getYearSummary(2147483648);
    await b.getYearSummary(1e21);
  });

  parity("setMonthLock coerces its flag and locking twice is still locked", {}, async (b) => {
    await b.setMonthLock(YEAR, 10, "no" as unknown as boolean);
    await b.getMonthLock(YEAR, 10);
    await b.setMonthLock(YEAR, 10, true);
    await b.setMonthLock(YEAR, 10, true);
    await b.getMonthLock(YEAR, 10);
    await b.setMonthLock(YEAR, 10, 0 as unknown as boolean);
    await b.getMonthLock(YEAR, 10);
  });

  parity("a fresh ledger lists the default categories", {}, async (b) => {
    await b.getCategories();
    await b.getConfig();
  });

  parity(
    "custom categories list by position with a derived fg, and are what entries and summaries accept",
    {
      categories: [
        { id: "travel", label: "Travel", bg: "#00B0F0", fg: null },
        { id: "food", label: "Food", bg: "#FFFF00", fg: "#3d3d00" },
      ],
      expenses: [{ year: YEAR, month: 11, entries: [{ amount: 3, remarks: "Taxi", category: "travel" }] }],
    },
    async (b) => {
      await b.getCategories();
      await b.addEntry(entry(YEAR, 11, 1, "x", "rent"));
      await b.addEntry(entry(YEAR, 11, 1, "x", "food"));
      await b.getYearSummary(YEAR);
    },
  );
});
