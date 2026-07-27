import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
      { name: "Coral", due: 5000, paid: 4990, dueDate: "2094-07-07" },
      { name: "OneCard", due: 3000, paid: 3000, dueDate: "2094-07-09" },
    ];
    await ccBills.setMonthBills({ year: 2094, month: 6, cards });
    expect(await ccBills.getMonthBills(2094, 6)).toEqual({ year: 2094, month: 6, cards });
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
      ccBills.setMonthBills({ year: 2094, month: 7, cards: [{ name: "", due: 100, paid: 100, dueDate: null }] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a non-finite due/paid amount", async () => {
    await expect(
      ccBills.setMonthBills({ year: 2094, month: 7, cards: [{ name: "Coral", due: NaN, paid: 100, dueDate: null }] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a malformed due date", async () => {
    await expect(
      ccBills.setMonthBills({
        year: 2094,
        month: 7,
        cards: [{ name: "Coral", due: 100, paid: 100, dueDate: "07/09/2094" }],
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
        { name: "Coral", due: 5000, paid: 4990, dueDate: "2093-01-07" },
        { name: "OneCard", due: 3000, paid: 3050, dueDate: "2093-01-09" },
      ],
    });
    await ccBills.setMonthBills({
      year: YEAR,
      month: 2,
      cards: [{ name: "Coral", due: 1000, paid: 1000, dueDate: null }],
    });
    // Month 3 intentionally left with no entry at all.
  });

  it("returns exactly 12 months, computing totals/earliest-date/overpaid independently per month", async () => {
    const summary = await ccBills.yearBillsSummary(YEAR);
    expect(summary).toHaveLength(12);
    const [jan, feb, mar] = summary;

    // Jan: totalDue = 5000+3000 = 8000, totalPaid = 4990+3050 = 8040.
    // overpaidOrSaved = due - paid = 8000-8040 = -40 (negative = overpaid,
    // since Coral was paid less but OneCard was paid *more* than due, net
    // more was paid overall). Earliest due date = min(Jan 7, Jan 9) = Jan 7.
    expect(jan).toMatchObject({
      month: 1,
      totalDue: 8000,
      totalPaid: 8040,
      earliestDueDate: "2093-01-07",
      overpaidOrSaved: -40,
    });

    // Feb: single card, no due date entered at all -> earliestDueDate null.
    expect(feb).toMatchObject({
      month: 2,
      totalDue: 1000,
      totalPaid: 1000,
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
