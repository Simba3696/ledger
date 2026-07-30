import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Same pattern as every other module's test file: LEDGER_DB_DIR must be set
// before any of these modules' top-level DB_DIR evaluates, so they're all
// imported dynamically after the env var is set.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-overview-test-"));
process.env.LEDGER_DB_DIR = scratchDir;

const overview = await import("../src/excel/overview.js");
const debts = await import("../src/excel/debts.js");
const emi = await import("../src/excel/emi.js");
const subscriptions = await import("../src/excel/subscriptions.js");
const creditCardBills = await import("../src/excel/creditCardBills.js");
const finances = await import("../src/excel/finances.js");

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe("dashboardOverview", () => {
  it("returns zeroed net worth and no upcoming items when nothing is tracked yet", async () => {
    const result = await overview.dashboardOverview(new Date(2026, 0, 1));
    expect(result.netWorth).toEqual({
      currentSavings: 0,
      totalDebt: 0,
      emiRemaining: 0,
      creditCardOutstanding: 0,
      netWorth: 0,
    });
    expect(result.upcoming).toEqual([]);
  });

  it("computes net worth as savings minus debts minus EMI remaining minus this month's unpaid credit card bills", async () => {
    await finances.setMonthIncome({
      year: 2026,
      month: 1,
      salary: null,
      otherIncome: null,
      savings: [{ name: "PPF", amount: 50000 }],
    });
    await debts.addDebt({ name: "Umma", amount: 10000 }); // you owe
    await debts.addDebt({ name: "Anandu", amount: -3000 }); // owed to you — nets against the above
    const addedEmi = await emi.addEmi(
      { cardOrBank: "Coral", emiAmount: 1000, dueDay: 15, totalAmount: 20000, remarks: "", remainingAsOf: 8000 },
      new Date(2026, 0, 1),
    );
    await creditCardBills.setMonthBills({
      year: 2026,
      month: 1,
      cards: [{ name: "OneCard", due: 5000, paid: 2000, dueDate: "2026-01-20", settled: false }],
    });

    const result = await overview.dashboardOverview(new Date(2026, 0, 1));
    expect(result.netWorth).toEqual({
      currentSavings: 50000,
      totalDebt: 7000, // 10000 - 3000
      emiRemaining: 8000,
      creditCardOutstanding: 3000, // 5000 - 2000
      netWorth: 50000 - 7000 - 8000 - 3000, // 32000
    });

    // Clean up the EMI/debts/credit-card entries so later "upcoming" checks
    // in this file start from a known-empty state — Current Savings has no
    // due date of its own, so it's harmless to leave behind. Deletes shift
    // every later row up, so repeatedly removing whatever's first is the
    // only safe way to clear a list — deleting a stale snapshot's row
    // numbers in order would hit already-shifted (or now-missing) rows.
    await emi.deleteEmi(addedEmi.row);
    while ((await debts.listDebts()).length > 0) {
      await debts.deleteDebt((await debts.listDebts())[0].row);
    }
    await creditCardBills.setMonthBills({ year: 2026, month: 1, cards: [] });
  });

  it("does not let a positive+negative debt mix hide a real net liability", async () => {
    await debts.addDebt({ name: "Owed by me", amount: 5000 });
    await debts.addDebt({ name: "Owed to me", amount: -5000 });
    const result = await overview.dashboardOverview(new Date(2026, 0, 1));
    expect(result.netWorth.totalDebt).toBe(0); // nets to exactly zero, not omitted
    while ((await debts.listDebts()).length > 0) {
      await debts.deleteDebt((await debts.listDebts())[0].row);
    }
  });

  it("includes an EMI due within the next 14 days, excludes one further out and one already paid off", async () => {
    const soon = await emi.addEmi(
      { cardOrBank: "Due Soon", emiAmount: 1500, dueDay: 10, totalAmount: 5000, remarks: "", remainingAsOf: 5000 },
      new Date(2026, 2, 1), // Mar 1 — due Mar 10, within 14 days
    );
    const later = await emi.addEmi(
      { cardOrBank: "Due Later", emiAmount: 1500, dueDay: 28, totalAmount: 5000, remarks: "", remainingAsOf: 5000 },
      new Date(2026, 2, 1), // due Mar 28 — outside the 14-day window from Mar 1
    );
    const paidOff = await emi.addEmi(
      { cardOrBank: "Already Done", emiAmount: 1500, dueDay: 5, totalAmount: 1500, remarks: "", remainingAsOf: 0 },
      new Date(2026, 2, 1), // due Mar 5, within window, but isPaidOff
    );

    const result = await overview.dashboardOverview(new Date(2026, 2, 1));
    expect(result.upcoming).toEqual([
      { source: "EMI", name: "Due Soon", amount: 1500, dueDate: "2026-03-10" },
    ]);

    // Reverse row order — deleting shifts every later row up, so removing
    // the highest row first keeps the other captured row numbers valid.
    await emi.deleteEmi(paidOff.row);
    await emi.deleteEmi(later.row);
    await emi.deleteEmi(soon.row);
  });

  it("recording a payment for the current cycle advances Upcoming to the next one, instead of re-showing the one just paid", async () => {
    // Reproduces a real user report: paying this month's Kreditbee
    // installment via "Paid this month" still showed the same due date in
    // Upcoming afterward — because the due date was being recomputed purely
    // from dueDay + today, never looking at whether the EMI's own anchor had
    // already moved past it.
    const added = await emi.addEmi(
      { cardOrBank: "Kreditbee", emiAmount: 5502, dueDay: 8, totalAmount: 58000, remarks: "", remainingAsOf: 10000 },
      new Date(2026, 6, 28), // Jul 28 — due Aug 8, within 14 days
    );

    const before = await overview.dashboardOverview(new Date(2026, 6, 30)); // Jul 30
    expect(before.upcoming).toEqual([
      { source: "EMI", name: "Kreditbee", amount: 5502, dueDate: "2026-08-08" },
    ]);

    await emi.recordEmiPayment(added.row, 5502, new Date(2026, 7, 8)); // paid on Aug 8 itself

    // Sep 8 is more than 14 days out from Jul 30/Aug 8, so it should now
    // disappear from Upcoming entirely — not linger on Aug 8.
    const afterFar = await overview.dashboardOverview(new Date(2026, 6, 30));
    expect(afterFar.upcoming).toEqual([]);

    // Closer to Sep 8, it should reappear with the *new* cycle's date.
    const afterNear = await overview.dashboardOverview(new Date(2026, 7, 26)); // Aug 26
    expect(afterNear.upcoming).toEqual([
      { source: "EMI", name: "Kreditbee", amount: 5502, dueDate: "2026-09-08" },
    ]);

    await emi.deleteEmi(added.row);
  });

  it("excludes an EMI from Upcoming when its card also has its own Credit Card Bill entry (already counted there), but keeps a standalone loan", async () => {
    // Converting a purchase to EMI on a real credit card bills it through
    // that card's own monthly bill, not separately — so "Coral" the EMI
    // shouldn't also show up as its own Upcoming line once "Coral" the
    // credit card is on record for the same month. "Kreditbee" has no
    // matching Credit Card Bill entry, so it's a standalone loan and must
    // still show normally.
    await creditCardBills.setMonthBills({
      year: 2026,
      month: 3,
      cards: [{ name: "Coral", due: 2000, paid: 0, dueDate: "2026-03-07", settled: false }],
    });
    const cardLinked = await emi.addEmi(
      { cardOrBank: "Coral", emiAmount: 612, dueDay: 7, totalAmount: 12000, remarks: "", remainingAsOf: 8000 },
      new Date(2026, 2, 1),
    );
    const standalone = await emi.addEmi(
      { cardOrBank: "Kreditbee", emiAmount: 5502, dueDay: 8, totalAmount: 58000, remarks: "", remainingAsOf: 52000 },
      new Date(2026, 2, 1),
    );

    const result = await overview.dashboardOverview(new Date(2026, 2, 1));
    expect(result.upcoming).toEqual([
      { source: "Credit Card", name: "Coral", amount: 2000, dueDate: "2026-03-07" },
      { source: "EMI", name: "Kreditbee", amount: 5502, dueDate: "2026-03-08" },
    ]);

    await emi.deleteEmi(standalone.row);
    await emi.deleteEmi(cardLinked.row);
    await creditCardBills.setMonthBills({ year: 2026, month: 3, cards: [] });
  });

  it("includes a subscription renewal within the next 14 days, excludes one further out", async () => {
    const soon = await subscriptions.addSubscription(
      { service: "Renews Soon", amount: 649, duration: "Monthly", expiryAnchor: "2026-03-08", cardOrBank: "" },
      new Date(2026, 2, 1),
    );
    const later = await subscriptions.addSubscription(
      { service: "Renews Later", amount: 199, duration: "Monthly", expiryAnchor: "2026-03-25", cardOrBank: "" },
      new Date(2026, 2, 1),
    );

    const result = await overview.dashboardOverview(new Date(2026, 2, 1));
    expect(result.upcoming).toEqual([
      { source: "Subscription", name: "Renews Soon", amount: 649, dueDate: "2026-03-08" },
    ]);

    await subscriptions.deleteSubscription(later.row); // reverse row order, same reasoning as above
    await subscriptions.deleteSubscription(soon.row);
  });

  it("includes an outstanding credit card bill within the window, excludes one already fully paid and one with no due date", async () => {
    await creditCardBills.setMonthBills({
      year: 2026,
      month: 3,
      cards: [
        { name: "Still Owing", due: 5000, paid: 2000, dueDate: "2026-03-07", settled: false }, // outstanding, within window
        { name: "Fully Paid", due: 5000, paid: 5000, dueDate: "2026-03-07", settled: false }, // nothing outstanding
        { name: "No Due Date", due: 5000, paid: 0, dueDate: null, settled: false }, // can't be "upcoming" without a date
      ],
    });

    const result = await overview.dashboardOverview(new Date(2026, 2, 1));
    expect(result.upcoming).toEqual([
      { source: "Credit Card", name: "Still Owing", amount: 3000, dueDate: "2026-03-07" },
    ]);

    await creditCardBills.setMonthBills({ year: 2026, month: 3, cards: [] });
  });

  it("treats a card marked Settled as fully resolved, both in Net Worth and Upcoming, regardless of its raw (due - paid) gap", async () => {
    // A user checks "Settled" once they've paid a bill through an app like
    // CRED, even if a rupee or two of rounding is technically still unpaid —
    // that leftover isn't real debt, and shouldn't show as owed or due.
    await creditCardBills.setMonthBills({
      year: 2026,
      month: 3,
      cards: [{ name: "Settled", due: 5000, paid: 4990, dueDate: "2026-03-07", settled: true }],
    });

    const result = await overview.dashboardOverview(new Date(2026, 2, 1));
    expect(result.netWorth.creditCardOutstanding).toBe(0);
    expect(result.upcoming).toEqual([]);

    await creditCardBills.setMonthBills({ year: 2026, month: 3, cards: [] });
  });

  it("still counts an unsettled card's full gap as real debt, even a small one", async () => {
    // With the old rounding-threshold heuristic, a ₹1 gap would have been
    // silently zeroed out — now there's no threshold, only the explicit
    // Settled flag decides that, so an unsettled card's gap always counts.
    await creditCardBills.setMonthBills({
      year: 2026,
      month: 3,
      cards: [{ name: "Not Yet Settled", due: 5000, paid: 4999, dueDate: "2026-03-07", settled: false }],
    });

    const result = await overview.dashboardOverview(new Date(2026, 2, 1));
    expect(result.netWorth.creditCardOutstanding).toBe(1);
    expect(result.upcoming).toEqual([
      { source: "Credit Card", name: "Not Yet Settled", amount: 1, dueDate: "2026-03-07" },
    ]);

    await creditCardBills.setMonthBills({ year: 2026, month: 3, cards: [] });
  });

  it("leaves an overpaid, unsettled card's credit untouched — negative gap, not clamped away", async () => {
    await creditCardBills.setMonthBills({
      year: 2026,
      month: 3,
      cards: [{ name: "Overpaid", due: 5000, paid: 5100, dueDate: "2026-03-07", settled: false }], // paid 100 extra
    });

    const result = await overview.dashboardOverview(new Date(2026, 2, 1));
    // The overpayment nets against net worth as a negative contribution,
    // floored at 0 overall (no other card exists to offset it here).
    expect(result.netWorth.creditCardOutstanding).toBe(0);

    await creditCardBills.setMonthBills({ year: 2026, month: 3, cards: [] });
  });

  it("a settled card's credit contributes exactly 0, even if it was overpaid on paper", async () => {
    await creditCardBills.setMonthBills({
      year: 2026,
      month: 3,
      cards: [{ name: "Settled Overpaid", due: 5000, paid: 5100, dueDate: "2026-03-07", settled: true }],
    });

    const result = await overview.dashboardOverview(new Date(2026, 2, 1));
    expect(result.netWorth.creditCardOutstanding).toBe(0);
    expect(result.upcoming).toEqual([]);

    await creditCardBills.setMonthBills({ year: 2026, month: 3, cards: [] });
  });

  it("picks up next month's credit card due date too, when it falls inside the window", async () => {
    // Today is Mar 25; the window runs through Apr 8, so a due date of Apr 2
    // (next month) must be picked up, not just the current month's bills.
    await creditCardBills.setMonthBills({
      year: 2026,
      month: 4,
      cards: [{ name: "Early Next Month", due: 4000, paid: 0, dueDate: "2026-04-02", settled: false }],
    });

    const result = await overview.dashboardOverview(new Date(2026, 2, 25));
    expect(result.upcoming).toEqual([
      { source: "Credit Card", name: "Early Next Month", amount: 4000, dueDate: "2026-04-02" },
    ]);

    await creditCardBills.setMonthBills({ year: 2026, month: 4, cards: [] });
  });

  it("sorts mixed upcoming items by due date, soonest first", async () => {
    const emiEntry = await emi.addEmi(
      { cardOrBank: "Later EMI", emiAmount: 1000, dueDay: 12, totalAmount: 5000, remarks: "", remainingAsOf: 5000 },
      new Date(2026, 2, 1), // due Mar 12
    );
    const sub = await subscriptions.addSubscription(
      { service: "Earlier Sub", amount: 100, duration: "Monthly", expiryAnchor: "2026-03-03", cardOrBank: "" },
      new Date(2026, 2, 1), // due Mar 3
    );

    const result = await overview.dashboardOverview(new Date(2026, 2, 1));
    expect(result.upcoming.map((u) => u.dueDate)).toEqual(["2026-03-03", "2026-03-12"]);

    await emi.deleteEmi(emiEntry.row);
    await subscriptions.deleteSubscription(sub.row);
  });
});
