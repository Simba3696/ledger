import { describe, expect } from "vitest";
import type { EmiEdits } from "../../../client/src/api";
import { parity } from "./harness";
import type { Fixture } from "./seed";

// server/test/overview.test.ts against both backends. Every store case
// starts from the salaries its beforeAll seeds (so the salary reminder only
// fires where a case means it to); "today" is moved with at().

const salaries: Fixture["financeMonths"] = [
  { year: 2025, month: 12, salary: 50000 },
  { year: 2026, month: 2, salary: 50000 },
  { year: 2026, month: 6, salary: 50000 },
  { year: 2026, month: 7, salary: 50000 },
];
const base: Fixture = { financeMonths: salaries };
/** What the second case leaves behind: January's savings snapshot. */
const withJanuarySavings: Fixture = {
  financeMonths: [...salaries, { year: 2026, month: 1, savings: [{ name: "PPF", amount: 50000 }] }],
};

function loan(cardOrBank: string, emiAmount: number, dueDay: number, totalAmount: number, remainingAsOf: number): EmiEdits {
  return { cardOrBank, emiAmount, dueDay, totalAmount, remarks: "", remainingAsOf } as EmiEdits;
}

describe("dashboardOverview", () => {
  parity("returns zeroed net worth and no upcoming items when nothing is tracked yet", base, async (b, { at }) => {
    at("2026-01-01");
    await b.getOverview();
  });

  parity(
    "computes net worth as savings minus debts minus EMI remaining minus this month's unpaid credit card bills",
    base,
    async (b, { at }) => {
      at("2026-01-01");
      await b.setMonthIncome(2026, 1, { salary: null, otherIncome: null, savings: [{ name: "PPF", amount: 50000 }] });
      await b.addDebt({ name: "Umma", amount: 10000 });
      await b.addDebt({ name: "Anandu", amount: -3000 });
      const addedEmi = await b.addEmi(loan("Coral", 1000, 15, 20000, 8000));
      await b.setMonthBills(2026, 1, [{ name: "OneCard", due: 5000, paid: 2000, dueDate: "2026-01-20", settled: false }]);
      const result = await b.getOverview();
      expect(result.netWorth).toEqual({ currentSavings: 50000, totalDebt: 7000, emiRemaining: 8000, creditCardOutstanding: 3000, netWorth: 32000 });

      await b.deleteEmi(addedEmi.row);
      for (const debt of await b.getDebts()) await b.deleteDebt(debt.row);
      await b.setMonthBills(2026, 1, []);
      await b.getOverview();
    },
  );

  parity("does not let a positive+negative debt mix hide a real net liability", withJanuarySavings, async (b, { at }) => {
    at("2026-01-01");
    await b.addDebt({ name: "Owed by me", amount: 5000 });
    await b.addDebt({ name: "Owed to me", amount: -5000 });
    expect((await b.getOverview()).netWorth.totalDebt).toBe(0);
    for (const debt of await b.getDebts()) await b.deleteDebt(debt.row);
  });

  parity("includes an EMI due within the next 14 days, excludes one further out and one already paid off", withJanuarySavings, async (b, { at }) => {
    at("2026-03-01");
    const soon = await b.addEmi(loan("Due Soon", 1500, 10, 5000, 5000));
    const later = await b.addEmi(loan("Due Later", 1500, 28, 5000, 5000));
    const paidOff = await b.addEmi(loan("Already Done", 1500, 5, 1500, 0));
    await b.getOverview();
    await b.deleteEmi(paidOff.row);
    await b.deleteEmi(later.row);
    await b.deleteEmi(soon.row);
  });

  parity(
    "recording a payment for the current cycle advances Upcoming to the next one, instead of re-showing the one just paid",
    withJanuarySavings,
    async (b, { at }) => {
      at("2026-07-28");
      const added = await b.addEmi(loan("Kreditbee", 5502, 8, 58000, 10000));
      at("2026-07-30");
      await b.getOverview();
      at("2026-08-08");
      await b.payEmi(added.row, 5502);
      at("2026-07-30");
      expect((await b.getOverview()).upcoming).toEqual([]);
      at("2026-08-26");
      await b.getOverview();
      await b.deleteEmi(added.row);
    },
  );

  parity(
    "re-anchors a stale asOfDate to today, instead of surfacing an already-passed due date as still upcoming",
    withJanuarySavings,
    async (b, { at }) => {
      at("2026-01-01");
      const added = await b.addEmi(loan("Stale Loan", 1000, 10, 20000, 10000));
      at("2026-03-05");
      await b.getOverview();
      await b.deleteEmi(added.row);
    },
  );

  parity(
    "excludes an EMI from Upcoming when its card also has its own Credit Card Bill entry (already counted there), but keeps a standalone loan",
    withJanuarySavings,
    async (b, { at }) => {
      at("2026-03-01");
      await b.setMonthBills(2026, 3, [{ name: "Coral", due: 2000, paid: 0, dueDate: "2026-03-07", settled: false }]);
      const cardLinked = await b.addEmi(loan("Coral", 612, 7, 12000, 8000));
      const standalone = await b.addEmi(loan("Kreditbee", 5502, 8, 58000, 52000));
      await b.getOverview();
      await b.deleteEmi(standalone.row);
      await b.deleteEmi(cardLinked.row);
      await b.setMonthBills(2026, 3, []);
    },
  );

  parity("includes a subscription renewal within the next 14 days, excludes one further out", withJanuarySavings, async (b, { at }) => {
    at("2026-03-01");
    const soon = await b.addSubscription({ service: "Renews Soon", amount: 649, duration: "Monthly", expiryAnchor: "2026-03-08", cardOrBank: "" });
    const later = await b.addSubscription({ service: "Renews Later", amount: 199, duration: "Monthly", expiryAnchor: "2026-03-25", cardOrBank: "" });
    await b.getOverview();
    await b.deleteSubscription(later.row);
    await b.deleteSubscription(soon.row);
  });

  parity(
    "includes an outstanding credit card bill within the window, excludes one already fully paid and one with no due date",
    withJanuarySavings,
    async (b, { at }) => {
      at("2026-03-01");
      await b.setMonthBills(2026, 3, [
        { name: "Still Owing", due: 5000, paid: 2000, dueDate: "2026-03-07", settled: false },
        { name: "Fully Paid", due: 5000, paid: 5000, dueDate: "2026-03-07", settled: false },
        { name: "No Due Date", due: 5000, paid: 0, dueDate: null, settled: false },
      ]);
      await b.getOverview();
      await b.setMonthBills(2026, 3, []);
    },
  );

  parity(
    "treats a card marked Settled as fully resolved, both in Net Worth and Upcoming, regardless of its raw (due - paid) gap",
    withJanuarySavings,
    async (b, { at }) => {
      at("2026-03-01");
      await b.setMonthBills(2026, 3, [{ name: "Settled", due: 5000, paid: 4990, dueDate: "2026-03-07", settled: true }]);
      await b.getOverview();
    },
  );

  parity("still counts an unsettled card's full gap as real debt, even a small one", withJanuarySavings, async (b, { at }) => {
    at("2026-03-01");
    await b.setMonthBills(2026, 3, [{ name: "Not Yet Settled", due: 5000, paid: 4999, dueDate: "2026-03-07", settled: false }]);
    await b.getOverview();
  });

  parity("leaves an overpaid, unsettled card's credit untouched — negative gap, not clamped away", withJanuarySavings, async (b, { at }) => {
    at("2026-03-01");
    await b.setMonthBills(2026, 3, [{ name: "Overpaid", due: 5000, paid: 5100, dueDate: "2026-03-07", settled: false }]);
    await b.getOverview();
  });

  parity("a settled card's credit contributes exactly 0, even if it was overpaid on paper", withJanuarySavings, async (b, { at }) => {
    at("2026-03-01");
    await b.setMonthBills(2026, 3, [{ name: "Settled Overpaid", due: 5000, paid: 5100, dueDate: "2026-03-07", settled: true }]);
    await b.getOverview();
  });

  parity("picks up next month's credit card due date too, when it falls inside the window", withJanuarySavings, async (b, { at }) => {
    await b.setMonthBills(2026, 4, [{ name: "Early Next Month", due: 4000, paid: 0, dueDate: "2026-04-02", settled: false }]);
    at("2026-03-25");
    await b.getOverview();
  });

  parity("sorts mixed upcoming items by due date, soonest first", withJanuarySavings, async (b, { at }) => {
    at("2026-03-01");
    await b.addEmi(loan("Later EMI", 1000, 12, 5000, 5000));
    await b.addSubscription({ service: "Earlier Sub", amount: 100, duration: "Monthly", expiryAnchor: "2026-03-03", cardOrBank: "" });
    expect((await b.getOverview()).upcoming.map((u) => u.dueDate)).toEqual(["2026-03-03", "2026-03-12"]);
  });
});

describe("dashboardOverview salary reminder", () => {
  parity(
    "shows a reminder when last month has no salary on record, sorting first regardless of other items' due dates",
    withJanuarySavings,
    async (b, { at }) => {
      at("2026-10-01");
      await b.addEmi(loan("Due Soon", 1500, 10, 5000, 5000));
      await b.getOverview();
    },
  );

  parity("shows no reminder once last month's salary is on record", withJanuarySavings, async (b, { at }) => {
    await b.setMonthIncome(2026, 9, { salary: 60000, otherIncome: null, savings: [] });
    at("2026-10-01");
    await b.getOverview();
  });

  parity(
    "stops showing the reminder after the first two weeks of the new month, even with last month's salary still missing",
    withJanuarySavings,
    async (b, { at }) => {
      at("2026-11-20");
      await b.getOverview();
    },
  );
});

describe("document parity: overview", () => {
  parity(
    "sums debts, EMIs and cards from stored decimals, and reads today in the document's time zone",
    {
      // No salaries on record, so the reminder shows which month "today" is.
      debts: [
        { name: "A", amount: 0.1 },
        { name: "B", amount: 0.2 },
        { name: "C", amount: -1.005 },
      ],
      emis: [{ cardOrBank: "Loan", emiAmount: 333.33, dueDay: 31, totalAmount: 1000, remainingAsOf: 999.99, asOfDate: "2026-01-31" }],
      cardBills: [{ year: 2026, month: 2, cards: [{ name: "Card A", due: 0.1, paid: 0.3, dueDate: "2026-02-28", settled: false }] }],
    },
    async (b, { at }) => {
      at("2026-02-14");
      await b.getOverview();
      at("2026-02-28");
      await b.getOverview();
      // 20:00 UTC on the 28th is already 1 March in Asia/Kolkata.
      at("2026-02-28T20:00:00Z");
      expect((await b.getOverview()).upcoming.some((u) => u.source === "Salary" && u.name === "February 2026")).toBe(true);
    },
  );
});
