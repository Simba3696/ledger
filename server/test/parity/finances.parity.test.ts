import { describe, expect } from "vitest";
import type { IncomeEdits } from "../../../client/src/api";
import { parity } from "./harness";
import type { Fixture } from "./seed";

// server/test/finances.test.ts against both backends. The store cases share
// one database in order; each case here plants what it relies on.

function income(salary: number | null, otherIncome: number | null, savings: { name: string; amount: number }[] = []): IncomeEdits {
  return { salary, otherIncome, savings };
}

describe("getMonthIncome / setMonthIncome", () => {
  const savings = [
    { name: "PPF", amount: 34100 },
    { name: "NPS", amount: 9652.1 },
  ];

  parity("returns all-empty for a month that was never entered", {}, async (b) => {
    await b.getMonthIncome(2094, 6);
  });

  parity("round-trips a saved entry, including a multi-scheme savings breakdown", {}, async (b) => {
    await b.setMonthIncome(2094, 6, income(50000, 2000, savings));
    expect(await b.getMonthIncome(2094, 6)).toEqual({ year: 2094, month: 6, salary: 50000, otherIncome: 2000, savings, previousSavings: [] });
  });

  parity(
    "overwrites an existing entry (including clearing savings) rather than duplicating a row",
    { financeMonths: [{ year: 2094, month: 6, salary: 50000, otherIncome: 2000, savings }] },
    async (b) => {
      await b.setMonthIncome(2094, 6, income(51000, null));
      await b.getMonthIncome(2094, 6);
    },
  );

  parity("rejects a year before EARLIEST_YEAR", {}, async (b) => {
    await b.setMonthIncome(2000, 1, income(1000, null));
    await b.getMonthIncome(2000, 1);
  });

  parity("rejects an out-of-range month", {}, async (b) => {
    await b.setMonthIncome(2094, 13, income(1000, null));
    await b.setMonthIncome(2094, 0, income(1000, null));
  });

  parity("rejects a non-finite amount", {}, async (b) => {
    // NaN is null on the wire, so this one saves a blank salary.
    await b.setMonthIncome(2094, 7, income(Number.NaN, null));
    await b.setMonthIncome(2094, 7, income("abc" as unknown as number, null));
    await b.setMonthIncome(2094, 7, income(null, "abc" as unknown as number));
    await b.getMonthIncome(2094, 7);
  });

  parity("rejects a savings entry with no name or a non-finite amount", {}, async (b) => {
    await b.setMonthIncome(2094, 8, income(null, null, [{ name: "", amount: 100 }]));
    await b.setMonthIncome(2094, 8, income(null, null, [{ name: "   ", amount: 100 }]));
    await b.setMonthIncome(2094, 8, income(null, null, [{ name: "PPF", amount: Number.NaN }]));
    await b.setMonthIncome(2094, 8, income(null, null, [{ name: "PPF" } as { name: string; amount: number }]));
    await b.getMonthIncome(2094, 8);
  });
});

describe("previousSavings (baseline the client computes deposit/withdrawal deltas against)", () => {
  const YEAR = 2095;

  parity("is empty for the very first month EARLIEST_YEAR has no possible prior month", {}, async (b) => {
    await b.getMonthIncome(2018, 1);
  });

  parity("carries the last non-empty snapshot forward, skipping months left untouched", {}, async (b) => {
    await b.setMonthIncome(YEAR, 1, income(null, null, [{ name: "PPF", amount: 1000 }]));
    await b.getMonthIncome(YEAR, 2);
    await b.setMonthIncome(YEAR, 3, income(null, null, [{ name: "PPF", amount: 1300 }]));
    await b.getMonthIncome(YEAR, 4);
  });

  const earlier: Fixture["financeMonths"] = [
    { year: YEAR, month: 1, savings: [{ name: "PPF", amount: 1000 }] },
    { year: YEAR, month: 3, savings: [{ name: "PPF", amount: 1300 }] },
  ];

  parity("carries forward across a year boundary", { financeMonths: earlier }, async (b) => {
    await b.setMonthIncome(YEAR, 12, income(null, null, [{ name: "PPF", amount: 2000 }]));
    await b.getMonthIncome(YEAR + 1, 1);
  });

  parity(
    "reflects on setMonthIncome's own response too, not just getMonthIncome",
    { financeMonths: [...earlier, { year: YEAR, month: 12, savings: [{ name: "PPF", amount: 2000 }] }] },
    async (b) => {
      await b.setMonthIncome(YEAR + 1, 2, income(null, null));
    },
  );
});

describe("financeSummary", () => {
  const YEAR = 2093;

  parity(
    "computes a full 12-month year with the correct January-April figures",
    {
      expenses: [
        {
          year: YEAR,
          month: 1,
          entries: [
            { amount: 12000, remarks: "Rent", category: "rent" },
            { amount: 8000, remarks: "Groceries", category: "food" },
          ],
        },
        { year: YEAR, month: 2, entries: [{ amount: 25000, remarks: "Misc", category: "other" }] },
      ],
      financeMonths: [
        {
          year: YEAR,
          month: 1,
          salary: 50000,
          otherIncome: 5000,
          savings: [
            { name: "PPF", amount: 60000 },
            { name: "NPS", amount: 40000 },
          ],
        },
        { year: YEAR, month: 2, salary: 52000 },
        {
          year: YEAR,
          month: 3,
          otherIncome: 2000,
          savings: [
            { name: "PPF", amount: 70000 },
            { name: "NPS", amount: 40000 },
          ],
        },
      ],
    },
    async (b) => {
      const summary = await b.getFinanceSummary(YEAR);
      expect(summary).toHaveLength(12);
      expect(summary[3]).toMatchObject({ month: 4, balance: 2000, cumulative: 64000, moneyEarned: 109000, currentSavings: 110000 });
    },
  );
});

describe("Postgres storage", () => {
  const YEAR = 2097;
  const schemes = ["Zeta", "Alpha", "Mid"].map((name, i) => ({ name, amount: 100 * (i + 1) }));

  parity(
    "keeps savings schemes in the order they were saved, and a resave with fewer schemes drops the rest",
    {
      financeMonths: [
        {
          year: 2093,
          month: 1,
          salary: 50000,
          savings: [
            { name: "PPF", amount: 60000 },
            { name: "NPS", amount: 40000 },
          ],
        },
      ],
    },
    async (b) => {
      await b.setMonthIncome(YEAR, 1, income(1000, null, schemes));
      await b.getMonthIncome(YEAR, 1);
      await b.setMonthIncome(YEAR, 1, income(1000, null, [schemes[2], schemes[0]]));
      await b.getMonthIncome(YEAR, 1);
      await b.getMonthIncome(2093, 1);
    },
  );

  parity(
    "treats a month whose savings were cleared as not entered, so the baseline skips back past it",
    { financeMonths: [{ year: YEAR, month: 1, salary: 1000, savings: [schemes[2], schemes[0]] }] },
    async (b) => {
      await b.setMonthIncome(YEAR, 2, income(null, null, [{ name: "PPF", amount: 5 }]));
      await b.setMonthIncome(YEAR, 2, income(2000, null));
      await b.getMonthIncome(YEAR, 3);
    },
  );

  parity("still accepts negative income and savings amounts, as the Excel edition did", {}, async (b) => {
    await b.setMonthIncome(YEAR, 4, income(-100, -0.5, [{ name: "Loan", amount: -2500.25 }]));
    await b.getMonthIncome(YEAR, 4);
  });

  parity("names the field in a too-large rejection", {}, async (b) => {
    const savings = [{ name: "PPF", amount: 1 }];
    await b.setMonthIncome(YEAR, 5, income(1e12, null, savings));
    await b.setMonthIncome(YEAR, 5, income(100, -1e12, savings));
    await b.setMonthIncome(YEAR, 5, income(100, null, [{ name: "PPF", amount: 1e12 }]));
  });

  parity("rejects values the database columns can't hold with a 400, not a database error", {}, async (b) => {
    const savings = [{ name: "PPF", amount: 1 }];
    await b.setMonthIncome(YEAR, 5, income(1e12, null, savings));
    await b.setMonthIncome(YEAR, 5, income(100, -1e12, savings));
    await b.setMonthIncome(YEAR, 5, income(100, null, [{ name: "PPF", amount: 1e12 }]));
    await b.setMonthIncome(YEAR, 5, income(100, null, [{ name: "P\u0000PF", amount: 1 }]));
    await b.getMonthIncome(YEAR, 5);
    await b.setMonthIncome(YEAR, 5, income(999999999999.99, null, [{ name: "PPF", amount: 10.006 }]));
    await b.getMonthIncome(YEAR, 5);
  });

  parity("rejects a year past four digits with the store's own 400 (#12)", {}, async (b) => {
    await b.getMonthIncome(10000, 1);
    await b.setMonthIncome(10000, 1, income(1, null));
  });

  parity("lets overlapping saves to the same month both succeed, the last one winning", {}, async (b, { note, quietly }) => {
    const a = [
      { name: "A1", amount: 1 },
      { name: "A2", amount: 2 },
    ];
    const bSavings = [{ name: "B1", amount: 3 }];
    // Each call's own result is defined; which commits last isn't, on the
    // SQL side, so the end state is compared on what the store case checks.
    await Promise.all([b.setMonthIncome(YEAR, 6, income(1, null, a)), b.setMonthIncome(YEAR, 6, income(2, null, bSavings))]);
    const after = await quietly(() => b.getMonthIncome(YEAR, 6));
    note(
      "one of the two saves won whole",
      [
        { salary: 1, savings: a },
        { salary: 2, savings: bSavings },
      ].some((s) => JSON.stringify(s) === JSON.stringify({ salary: after.salary, savings: after.savings })),
    );
  });
});

describe("document parity: finances", () => {
  parity(
    "sums each month's expenses exactly and rounds income half away from zero",
    {
      expenses: [
        {
          year: 2026,
          month: 1,
          entries: [
            { amount: 0.1, remarks: "a", category: "food" },
            { amount: 0.2, remarks: "b", category: "rent" },
          ],
        },
        { year: 2026, month: 2, entries: [{ amount: 1234.56, remarks: "c", category: null }] },
        { year: 2019, month: 7, entries: [{ amount: 99.99, remarks: "d", category: "other" }] },
      ],
      financeMonths: [{ year: 2025, month: 12, salary: 1000.5 }],
    },
    async (b) => {
      await b.setMonthIncome(2026, 1, income(1.005, -1.005, [{ name: "  Fund A  ", amount: 0.005 }]));
      const summary = await b.getFinanceSummary(2026);
      expect(summary[0].expenses).toBe(0.3);
      await b.getFinanceSummary(2019);
      await b.getMonthIncome(2026, 2);
    },
  );

  parity("coerces the body as routes.ts does and names each field it rejects", {}, async (b) => {
    await b.setMonthIncome(2026, 3, { salary: "", otherIncome: "12.5", savings: "none" } as unknown as IncomeEdits);
    await b.setMonthIncome(2026, 3, { savings: [{ name: 7, amount: "3" }, null] } as unknown as IncomeEdits);
    await b.setMonthIncome(2026, 3, income(null, null, [{ name: "PPF", amount: "lots" as unknown as number }]));
    await b.setMonthIncome(2026, 3, income(null, null, [{ name: "P\u0000PF", amount: 1 }]));
    await b.setMonthIncome(2026, 3, income(Number.POSITIVE_INFINITY, null));
    await b.setMonthIncome(2026, 3.5, income(1, null));
    await b.setMonthIncome(Number.NaN, 3, income(1, null));
    await b.getMonthIncome(2026, 3);
  });

  parity("a finance summary for a year the column can't hold is a 400", {}, async (b) => {
    await b.getFinanceSummary(2017);
    await b.getFinanceSummary(Number.NaN);
    await b.getFinanceSummary(2018.5);
    await b.getFinanceSummary(2018);
  });

  // #12: the summary walks every month from EARLIEST_YEAR up to the year
  // asked for, so an unbounded year ran out of memory. Four digits keep the
  // walk to under 100,000 months.
  parity("a finance summary past four digits is a 400 at once, and 9999 still answers (#12)", {}, async (b) => {
    await b.getFinanceSummary(2_000_000_000);
    await b.getFinanceSummary(10000);
    await b.getFinanceSummary(9999);
  });
});
