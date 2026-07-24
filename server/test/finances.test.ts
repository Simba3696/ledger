import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildFixtureWorkbook } from "./fixtures.js";

// Same pattern as ledger.test.ts: LEDGER_DB_DIR must be set before finances.ts's
// (and ledger.ts's) top-level DB_DIR evaluates, so both are imported dynamically
// after the env var is set rather than via a static top-level import.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-finance-test-"));
process.env.LEDGER_DB_DIR = scratchDir;

const finances = await import("../src/excel/finances.js");

function workbookPath(year: number): string {
  return path.join(scratchDir, `Expenses (${year}).xlsx`);
}

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe("getMonthIncome / setMonthIncome", () => {
  it("returns all-null for a month that was never entered", async () => {
    const income = await finances.getMonthIncome(2094, 6);
    expect(income).toEqual({ year: 2094, month: 6, salary: null, otherIncome: null, currentSavings: null });
  });

  it("round-trips a saved entry", async () => {
    await finances.setMonthIncome({ year: 2094, month: 6, salary: 50000, otherIncome: 2000, currentSavings: 90000 });
    const income = await finances.getMonthIncome(2094, 6);
    expect(income).toEqual({ year: 2094, month: 6, salary: 50000, otherIncome: 2000, currentSavings: 90000 });
  });

  it("overwrites an existing entry rather than duplicating a row", async () => {
    await finances.setMonthIncome({ year: 2094, month: 6, salary: 51000, otherIncome: null, currentSavings: null });
    const income = await finances.getMonthIncome(2094, 6);
    expect(income).toEqual({ year: 2094, month: 6, salary: 51000, otherIncome: null, currentSavings: null });
  });

  it("rejects a year before EARLIEST_YEAR", async () => {
    await expect(
      finances.setMonthIncome({ year: 2000, month: 1, salary: 1000, otherIncome: null, currentSavings: null }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an out-of-range month", async () => {
    await expect(
      finances.setMonthIncome({ year: 2094, month: 13, salary: 1000, otherIncome: null, currentSavings: null }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a non-finite amount", async () => {
    await expect(
      finances.setMonthIncome({ year: 2094, month: 7, salary: NaN, otherIncome: null, currentSavings: null }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("financeSummary", () => {
  const YEAR = 2093;

  beforeAll(async () => {
    await buildFixtureWorkbook(workbookPath(YEAR), [
      {
        name: "January",
        entries: [
          { amount: 12000, remarks: "Rent", category: "rent" },
          { amount: 8000, remarks: "Groceries", category: "food" },
        ],
      },
      {
        name: "February",
        entries: [{ amount: 25000, remarks: "Misc", category: "other" }],
      },
      // No March sheet at all — exercises the "missing sheet degrades to zero" path.
    ]);

    await finances.setMonthIncome({ year: YEAR, month: 1, salary: 50000, otherIncome: 5000, currentSavings: 100000 });
    await finances.setMonthIncome({ year: YEAR, month: 2, salary: 52000, otherIncome: null, currentSavings: null });
    await finances.setMonthIncome({ year: YEAR, month: 3, salary: null, otherIncome: 2000, currentSavings: 110000 });
    // Month 4 intentionally left with no entry at all.
  });

  it("computes a full 12-month year with the correct January-April figures", async () => {
    const summary = await finances.financeSummary(YEAR, 12);
    expect(summary).toHaveLength(12);
    const [jan, feb, mar, apr] = summary;

    // January: no prior month's income on record at all — treated as zero
    // (a real deficit), not an unknown.
    expect(jan).toMatchObject({
      month: 1,
      salary: 50000,
      otherIncome: 5000,
      expenses: 20000,
      balance: -20000,
      cumulative: -20000,
      minimumSavings: 8250, // ceil(0.15 * 55000)
      moneyEarned: 55000,
      moneySpent: 20000,
      currentSavings: 100000,
    });

    // February: balance = January's total income, salary + other income
    // (50000 + 5000) - February's expenses (25000).
    expect(feb).toMatchObject({
      month: 2,
      salary: 52000,
      otherIncome: null,
      expenses: 25000,
      balance: 30000,
      cumulative: 10000, // -20000 + 30000
      minimumSavings: 7800, // ceil(0.15 * 52000)
      moneyEarned: 107000,
      moneySpent: 45000,
      currentSavings: 100000, // carried forward — not re-entered this month
    });

    // March: balance = February's total income (52000 + 0) - March's
    // expenses (0, no sheet).
    expect(mar).toMatchObject({
      month: 3,
      salary: null,
      otherIncome: 2000,
      expenses: 0,
      balance: 52000,
      cumulative: 62000, // 10000 + 52000
      minimumSavings: 300, // ceil(0.15 * 2000), salary absent this month
      moneyEarned: 109000,
      moneySpent: 45000,
      currentSavings: 110000, // freshly re-entered this month
    });

    // April: no entry at all. Balance = March's total income (0 salary + 2000
    // other income) - April's expenses (0) — other income alone is enough to
    // carry a balance into the next month, same as salary would. cumulative/
    // moneyEarned/moneySpent/currentSavings hold steady otherwise, since
    // they're running totals / carried snapshots.
    expect(apr).toMatchObject({
      month: 4,
      salary: null,
      otherIncome: null,
      expenses: 0,
      balance: 2000,
      cumulative: 64000, // 62000 + 2000
      minimumSavings: null,
      moneyEarned: 109000,
      moneySpent: 45000,
      currentSavings: 110000,
    });
  });
});
