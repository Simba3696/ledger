import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";
import { buildFixtureWorkbook } from "./fixtures.js";

// LEDGER_DB_DIR must be set before ledger.ts's top-level `const DB_DIR = ...`
// evaluates, so the module is imported dynamically after the env var is set
// rather than via a static top-level import.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
process.env.LEDGER_DB_DIR = scratchDir;

const ledger = await import("../src/excel/ledger.js");

function workbookPath(year: number): string {
  return path.join(scratchDir, `Expenses (${year}).xlsx`);
}

async function readCell(year: number, sheetName: string, row: number, col: number) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath(year));
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`Sheet ${sheetName} not found in ${year}`);
  return sheet.getRow(row).getCell(col);
}

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe("listMonth", () => {
  const YEAR = 2091;

  beforeAll(async () => {
    await buildFixtureWorkbook(workbookPath(YEAR), [
      {
        name: "January",
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

describe("appendEntry", () => {
  const YEAR = 2092;

  beforeAll(async () => {
    await buildFixtureWorkbook(workbookPath(YEAR), [
      { name: "January", entries: [{ amount: 100, remarks: "Existing entry", category: "food" }] },
      { name: "February", entries: [], protect: true },
    ]);
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
    expect(result).toMatchObject({ row: 3, amount: 42, remarks: "New cash entry", isCard: false });

    const cell1 = await readCell(YEAR, "January", 3, 1);
    expect(cell1.value).toBe(-42);
    expect(cell1.alignment).toMatchObject({ horizontal: "right", vertical: "middle" });
    expect((cell1.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FF00B0F0"); // transportation

    const cell2 = await readCell(YEAR, "January", 3, 2);
    expect(cell2.alignment).toMatchObject({ horizontal: "left", vertical: "middle" });

    const cell3 = await readCell(YEAR, "January", 3, 3);
    expect(cell3.value).toBeNull();
    expect(cell3.fill).toBeUndefined();
    expect(cell3.border).toBeUndefined();
  });

  it("appends a card entry with a styled CC cell", async () => {
    await ledger.appendEntry({
      year: YEAR,
      month: 1,
      amount: 15,
      remarks: "Card entry",
      category: "rent",
      isCard: true,
    });
    const cell3 = await readCell(YEAR, "January", 4, 3);
    expect(cell3.value).toBe("CC");
    expect((cell3.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFC000"); // rent
    expect(cell3.border).toMatchObject({ right: { style: "medium" }, top: { style: "medium" }, bottom: { style: "medium" } });
  });

  it("moves the closing (medium) bottom border to the new last row and demotes the old one", async () => {
    // After the two appends above, row 4 is last and should carry the closing
    // border; row 3 (the old last row) should be back to a plain thin bottom.
    const newLast = await readCell(YEAR, "January", 4, 1);
    expect(newLast.border?.bottom).toMatchObject({ style: "medium" });

    const oldLast = await readCell(YEAR, "January", 3, 1);
    expect(oldLast.border?.bottom).toMatchObject({ style: "thin" });
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

  beforeAll(async () => {
    await buildFixtureWorkbook(workbookPath(YEAR), [
      {
        name: "January",
        // Rows 2 and 4 are both "food" and both non-last rows, so they end up
        // with an IDENTICAL combined style (fill+border+alignment+numFmt) —
        // this is the exact condition (normal XLSX-format style dedup) that
        // makes ExcelJS hand back a SHARED style object for both when the
        // file is read back. Row 3 is filler; row 5 is last (unique border).
        entries: [
          { amount: 100, remarks: "Groceries", category: "food" }, // row 2
          { amount: 200, remarks: "Fuel", category: "transportation" }, // row 3
          { amount: 50, remarks: "Snacks", category: "food" }, // row 4 — shares row 2's style
          { amount: 300, remarks: "Rent", category: "rent" }, // row 5 — last row
        ],
      },
      { name: "February", entries: [{ amount: 10, remarks: "x", category: "food" }], protect: true },
    ]);
  });

  it("updates amount, remarks, and category", async () => {
    const result = await ledger.updateEntry({
      year: YEAR,
      month: 1,
      row: 2,
      amount: 150,
      remarks: "Groceries (updated)",
      category: "other",
      isCard: false,
    });
    expect(result).toMatchObject({ amount: 150, remarks: "Groceries (updated)", category: "other" });

    const cell1 = await readCell(YEAR, "January", 2, 1);
    expect((cell1.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFF0000"); // other
  });

  it("does NOT change row 4's category, despite having shared row 2's style object before the edit — regression test for the shared-style-object bug", async () => {
    // ExcelJS shares one style object across cells with the same style index
    // (normal XLSX dedup), and its `.fill =`/`.border =` setters mutate that
    // object in place rather than replacing it. Editing row 2 above (which
    // shared its pre-edit style with row 4) must not have cascaded into row 4
    // — this is exactly the bug that shipped and corrupted a real month.
    const row4 = await readCell(YEAR, "January", 4, 1);
    expect((row4.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFFF00"); // still food

    const row3 = await readCell(YEAR, "January", 3, 1);
    expect((row3.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FF00B0F0"); // still transportation

    // And the other direction: editing row 4 now must not re-corrupt row 2.
    await ledger.updateEntry({
      year: YEAR,
      month: 1,
      row: 4,
      amount: 999,
      remarks: "Snacks (updated)",
      category: "rent",
      isCard: false,
    });
    const row2AfterSecondEdit = await readCell(YEAR, "January", 2, 1);
    expect((row2AfterSecondEdit.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFF0000"); // still "other"
  });

  it("toggling isCard on adds a styled CC cell, toggling it off clears it", async () => {
    await ledger.updateEntry({
      year: YEAR,
      month: 1,
      row: 5,
      amount: 300,
      remarks: "Rent",
      category: "rent",
      isCard: true,
    });
    let cell3 = await readCell(YEAR, "January", 5, 3);
    expect(cell3.value).toBe("CC");
    expect(cell3.fill).toBeDefined();

    await ledger.updateEntry({
      year: YEAR,
      month: 1,
      row: 5,
      amount: 300,
      remarks: "Rent",
      category: "rent",
      isCard: false,
    });
    cell3 = await readCell(YEAR, "January", 5, 3);
    expect(cell3.value).toBeNull();
    expect(cell3.fill).toBeUndefined();
    expect(cell3.border).toBeUndefined();
  });

  it("rejects editing a row that isn't a real entry", async () => {
    await expect(
      ledger.updateEntry({ year: YEAR, month: 1, row: 1, amount: 10, remarks: "x", category: "food", isCard: false }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses to write to a protected sheet", async () => {
    await expect(
      ledger.updateEntry({ year: YEAR, month: 2, row: 2, amount: 10, remarks: "x", category: "food", isCard: false }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("deleteEntry", () => {
  const YEAR = 2094;

  beforeAll(async () => {
    await buildFixtureWorkbook(workbookPath(YEAR), [
      {
        name: "January",
        // Rows 2 and 3 are both "food" and both non-last, so they share a
        // style object when read back — deleting row 4 promotes row 3 to
        // last, exercising fixClosingBorder's detach-before-mutate path
        // right next to a row (2) that shared its pre-fix style.
        entries: [
          { amount: 100, remarks: "First", category: "food" }, // row 2
          { amount: 200, remarks: "Second", category: "food" }, // row 3 — shares row 2's style
          { amount: 300, remarks: "Third", category: "rent" }, // row 4 — last row, will be deleted
        ],
      },
      { name: "February", entries: [{ amount: 10, remarks: "x", category: "food" }], protect: true },
    ]);
  });

  it("removes the row and shifts everything below it up", async () => {
    await ledger.deleteEntry({ year: YEAR, month: 1, row: 4 }); // delete "Third" (the last row)
    const entries = await ledger.listMonth(YEAR, 1);
    expect(entries.map((e) => e.remarks)).toEqual(["First", "Second"]);
  });

  it("re-applies the closing border to whichever row ends up last", async () => {
    const newLast = await readCell(YEAR, "January", 3, 1); // "Second" is now last
    expect(newLast.border?.bottom).toMatchObject({ style: "medium" });
  });

  it("does not corrupt a row that shared a style with the new last row — regression test for the shared-style-object bug in fixClosingBorder", async () => {
    const row2 = await readCell(YEAR, "January", 2, 1); // "First" — shared row 3's pre-fix style
    expect((row2.fill as ExcelJS.FillPattern).fgColor?.argb).toBe("FFFFFF00"); // still food
    expect(row2.border?.bottom).toMatchObject({ style: "thin" }); // still interior, not closing
  });

  it("rejects deleting a row that isn't a real entry", async () => {
    await expect(ledger.deleteEntry({ year: YEAR, month: 1, row: 99 })).rejects.toMatchObject({ status: 404 });
  });

  it("refuses to write to a protected sheet", async () => {
    await expect(ledger.deleteEntry({ year: YEAR, month: 2, row: 2 })).rejects.toMatchObject({ status: 403 });
  });
});

describe("moveEntry", () => {
  const YEAR = 2095;

  beforeAll(async () => {
    await buildFixtureWorkbook(workbookPath(YEAR), [
      {
        name: "January",
        entries: [
          { amount: 10, remarks: "Alpha", category: "food" },
          { amount: 20, remarks: "Bravo", category: "transportation", isCard: true },
          { amount: 30, remarks: "Charlie", category: "rent" },
        ],
      },
    ]);
  });

  it("reorders entries and preserves each one's own category and card status", async () => {
    await ledger.moveEntry({ year: YEAR, month: 1, fromRow: 2, toRow: 4 }); // Alpha to the end
    const entries = await ledger.listMonth(YEAR, 1);
    expect(entries.map((e) => e.remarks)).toEqual(["Bravo", "Charlie", "Alpha"]);

    const bravo = entries.find((e) => e.remarks === "Bravo")!;
    expect(bravo).toMatchObject({ category: "transportation", isCard: true });
    const charlie = entries.find((e) => e.remarks === "Charlie")!;
    expect(charlie).toMatchObject({ category: "rent", isCard: false });
    const alpha = entries.find((e) => e.remarks === "Alpha")!;
    expect(alpha).toMatchObject({ category: "food", isCard: false });
  });

  it("migrates the closing border to the new last row", async () => {
    const newLast = await readCell(YEAR, "January", 4, 1); // "Alpha" is now last
    expect(newLast.border?.bottom).toMatchObject({ style: "medium" });
  });

  it("is a no-op when fromRow equals toRow", async () => {
    const before = await ledger.listMonth(YEAR, 1);
    await ledger.moveEntry({ year: YEAR, month: 1, fromRow: 2, toRow: 2 });
    const after = await ledger.listMonth(YEAR, 1);
    expect(after).toEqual(before);
  });

  it("rejects an out-of-range target row", async () => {
    await expect(ledger.moveEntry({ year: YEAR, month: 1, fromRow: 2, toRow: 99 })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("yearSummary", () => {
  const YEAR = 2096;

  beforeAll(async () => {
    await buildFixtureWorkbook(workbookPath(YEAR), [
      {
        name: "January",
        entries: [
          { amount: 100, remarks: "a", category: "food" },
          { amount: 50, remarks: "b", category: "food" },
          { amount: 30, remarks: "c", category: "transportation" },
        ],
      },
      // February deliberately has no sheet at all — the fixture only defines
      // January — so this also covers a missing month gracefully.
    ]);
  });

  it("aggregates category totals per month", async () => {
    const summary = await ledger.yearSummary(YEAR);
    expect(summary).toHaveLength(12);
    expect(summary[0]).toMatchObject({ month: 1, food: 150, transportation: 30, rent: 0, other: 0, total: 180 });
  });

  it("degrades to a zero row for a month with no sheet, instead of throwing", async () => {
    const summary = await ledger.yearSummary(YEAR);
    expect(summary[1]).toMatchObject({ month: 2, food: 0, transportation: 0, rent: 0, other: 0, total: 0 });
  });
});
