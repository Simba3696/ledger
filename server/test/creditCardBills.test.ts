import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";

// Same pattern as ledger.test.ts / finances.test.ts / debts.test.ts:
// LEDGER_DB_DIR must be set before creditCardBills.ts's top-level DB_DIR
// evaluates, so it's imported dynamically after the env var is set rather
// than via a static top-level import.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-ccbills-test-"));
process.env.LEDGER_DB_DIR = scratchDir;

const ccBills = await import("../src/excel/creditCardBills.js");

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe("getMonthBills / setMonthBills", () => {
  it("returns an empty card list for a month that was never entered", async () => {
    expect(await ccBills.getMonthBills(2094, 6)).toEqual({ year: 2094, month: 6, cards: [] });
  });

  it("round-trips a saved entry with multiple cards", async () => {
    const cards = [
      { name: "Coral", due: 5000, paid: 4990, dueDate: "2094-07-07", settled: false },
      { name: "OneCard", due: 3000, paid: 3000, dueDate: "2094-07-09", settled: true },
    ];
    await ccBills.setMonthBills({ year: 2094, month: 6, cards });
    expect(await ccBills.getMonthBills(2094, 6)).toEqual({ year: 2094, month: 6, cards });
  });

  it("defaults a legacy entry with no settled field (pre-dating the field) to false rather than rejecting it", async () => {
    // Simulates data written before `settled` existed: write the raw cell
    // JSON directly (bypassing setMonthBills, which now requires the field),
    // then confirm the real getMonthBills path still reads it back cleanly.
    const billsPath = path.join(scratchDir, "CreditCardBills.xlsx");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(billsPath);
    const sheet = workbook.getWorksheet("Bills")!;
    const row = sheet.getRow(sheet.rowCount + 1);
    row.getCell(1).value = 2094;
    row.getCell(2).value = 8;
    row.getCell(3).value = JSON.stringify([{ name: "Coral", due: 5000, paid: 4990, dueDate: "2094-07-07" }]);
    row.commit();
    await workbook.xlsx.writeFile(billsPath);

    expect(await ccBills.getMonthBills(2094, 8)).toEqual({
      year: 2094,
      month: 8,
      cards: [{ name: "Coral", due: 5000, paid: 4990, dueDate: "2094-07-07", settled: false }],
    });
  });

  it("rejects a non-boolean settled flag", async () => {
    await expect(
      ccBills.setMonthBills({
        year: 2094,
        month: 7,
        // @ts-expect-error - deliberately wrong type to exercise validation
        cards: [{ name: "Coral", due: 100, paid: 100, dueDate: null, settled: "yes" }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("overwrites an existing entry (including clearing to empty) rather than duplicating a row", async () => {
    await ccBills.setMonthBills({ year: 2094, month: 6, cards: [] });
    expect(await ccBills.getMonthBills(2094, 6)).toEqual({ year: 2094, month: 6, cards: [] });
  });

  it("rejects a year before EARLIEST_YEAR", async () => {
    await expect(ccBills.setMonthBills({ year: 2000, month: 1, cards: [] })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an out-of-range month", async () => {
    await expect(ccBills.setMonthBills({ year: 2094, month: 13, cards: [] })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a card with no name", async () => {
    await expect(
      ccBills.setMonthBills({
        year: 2094,
        month: 7,
        cards: [{ name: "", due: 100, paid: 100, dueDate: null, settled: false }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a non-finite due/paid amount", async () => {
    await expect(
      ccBills.setMonthBills({
        year: 2094,
        month: 7,
        cards: [{ name: "Coral", due: NaN, paid: 100, dueDate: null, settled: false }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a malformed due date", async () => {
    await expect(
      ccBills.setMonthBills({
        year: 2094,
        month: 7,
        cards: [{ name: "Coral", due: 100, paid: 100, dueDate: "07/09/2094", settled: false }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("yearBillsSummary", () => {
  const YEAR = 2093;

  beforeAll(async () => {
    await ccBills.setMonthBills({
      year: YEAR,
      month: 1,
      cards: [
        // Settled: its own (due - paid) gap counts toward overpaidOrSaved.
        { name: "Coral", due: 5000, paid: 4990, dueDate: "2093-01-07", settled: true },
        // Unsettled: paid *more* than due (a real -50 gap), but since this
        // bill isn't marked Settled yet, that gap must NOT count — an
        // in-progress bill shouldn't move the Saved/Overpaid figure.
        { name: "OneCard", due: 3000, paid: 3050, dueDate: "2093-01-09", settled: false },
      ],
    });
    await ccBills.setMonthBills({
      year: YEAR,
      month: 2,
      // Unsettled with a real due/paid gap (100) — must contribute 0.
      cards: [{ name: "Coral", due: 1000, paid: 900, dueDate: null, settled: false }],
    });
    // Month 3 intentionally left with no entry at all.
  });

  it("returns exactly 12 months, computing totals/earliest-date/overpaid independently per month", async () => {
    const summary = await ccBills.yearBillsSummary(YEAR);
    expect(summary).toHaveLength(12);
    const [jan, feb, mar] = summary;

    // Jan: totalDue = 5000+3000 = 8000, totalPaid = 4990+3050 = 8040 — these
    // sum every card regardless of settled status. overpaidOrSaved, though,
    // only counts Coral (settled): 5000-4990 = 10. OneCard's -50 gap is
    // real (it was paid more than due) but doesn't count since it isn't
    // settled — the naive totalDue-totalPaid would give -40 here instead.
    // Earliest due date = min(Jan 7, Jan 9) = Jan 7, unaffected by settled.
    expect(jan).toMatchObject({
      month: 1,
      totalDue: 8000,
      totalPaid: 8040,
      earliestDueDate: "2093-01-07",
      overpaidOrSaved: 10,
    });

    // Feb: single unsettled card with a real 100 gap — contributes 0 to
    // overpaidOrSaved even though totalDue/totalPaid still reflect it.
    // No due date entered at all -> earliestDueDate null.
    expect(feb).toMatchObject({
      month: 2,
      totalDue: 1000,
      totalPaid: 900,
      earliestDueDate: null,
      overpaidOrSaved: 0,
    });

    // Mar: no entry at all -> zeroed out, not omitted.
    expect(mar).toMatchObject({
      month: 3,
      cards: [],
      totalDue: 0,
      totalPaid: 0,
      earliestDueDate: null,
      overpaidOrSaved: 0,
    });
  });
});
