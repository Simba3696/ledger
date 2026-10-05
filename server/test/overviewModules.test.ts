import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from "vitest";
// dbHelpers must be imported before any store module (it sets DATABASE_URL
// and refuses non-local hosts).
import { resetTables, closeSql } from "./dbHelpers.js";
import * as overview from "../src/store/overview.js";
import * as debts from "../src/store/debts.js";
import * as emi from "../src/store/emi.js";
import * as subscriptions from "../src/store/subscriptions.js";
import * as creditCardBills from "../src/store/creditCardBills.js";
import * as finances from "../src/store/finances.js";
import { MODULES, type ModuleName } from "../src/modules.js";

// dashboardOverview with only some modules enabled (ADR-0006). Every read it
// can make is wrapped in a spy that still calls the real store, so these
// cases prove a disabled module's store is never queried at all, not just
// that its figures come back empty.
vi.mock("../src/store/debts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/debts.js")>();
  return { ...actual, listDebts: vi.fn(actual.listDebts) };
});
vi.mock("../src/store/emi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/emi.js")>();
  return { ...actual, listEmis: vi.fn(actual.listEmis) };
});
vi.mock("../src/store/subscriptions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/subscriptions.js")>();
  return { ...actual, listSubscriptions: vi.fn(actual.listSubscriptions) };
});
vi.mock("../src/store/creditCardBills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/creditCardBills.js")>();
  return { ...actual, getMonthBills: vi.fn(actual.getMonthBills) };
});
vi.mock("../src/store/finances.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/finances.js")>();
  return { ...actual, financeSummary: vi.fn(actual.financeSummary), getMonthIncome: vi.fn(actual.getMonthIncome) };
});

const reads = {
  debts: [debts.listDebts],
  emi: [emi.listEmis],
  subscriptions: [subscriptions.listSubscriptions],
  "credit-cards": [creditCardBills.getMonthBills],
  finances: [finances.financeSummary, finances.getMonthIncome],
} satisfies Record<Exclude<ModuleName, "expenses">, unknown[]>;

function expectReadsOnly(enabled: ModuleName[]) {
  for (const [module, fns] of Object.entries(reads)) {
    for (const fn of fns) {
      if (enabled.includes(module as ModuleName)) expect(fn, module).toHaveBeenCalled();
      else expect(fn, module).not.toHaveBeenCalled();
    }
  }
}

// Mar 5 2026: inside the salary reminder's window, with February's salary
// left unlogged so the reminder fires when Finances is on.
const TODAY = new Date(2026, 2, 5);

beforeAll(async () => {
  await resetTables("debts", "emis", "subscriptions", "card_bills", "finance_months", "savings_balances", "expenses", "month_locks");
  await finances.setMonthIncome({ year: 2026, month: 3, salary: null, otherIncome: null, savings: [{ name: "PPF", amount: 40000 }] });
  await debts.addDebt({ name: "Alex", amount: 5000 });
  // "Card A" is also on this month's card bills, so it is billed there; "Car
  // Loan" isn't.
  await emi.addEmi(
    { cardOrBank: "Card A", emiAmount: 1000, dueDay: 10, totalAmount: 10000, remarks: "", remainingAsOf: 6000 },
    new Date(2026, 2, 1),
  );
  await emi.addEmi(
    { cardOrBank: "Car Loan", emiAmount: 2000, dueDay: 12, totalAmount: 20000, remarks: "", remainingAsOf: 8000 },
    new Date(2026, 2, 1),
  );
  await subscriptions.addSubscription(
    { service: "Streaming", amount: 499, duration: "Monthly", expiryAnchor: "2026-03-15", cardOrBank: "Card A" },
    new Date(2026, 2, 1),
  );
  await creditCardBills.setMonthBills({
    year: 2026,
    month: 3,
    cards: [{ name: "Card A", due: 3000, paid: 1000, dueDate: "2026-03-18", settled: false }],
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await resetTables("debts", "emis", "subscriptions", "card_bills", "finance_months", "savings_balances");
  await closeSql();
});

describe("dashboardOverview with ENABLED_MODULES", () => {
  it("defaults to every module, identical to naming them all", async () => {
    const byDefault = await overview.dashboardOverview(TODAY);
    expectReadsOnly([...MODULES]);
    const named = await overview.dashboardOverview(TODAY, [...MODULES]);
    expect(JSON.stringify(named)).toBe(JSON.stringify(byDefault));
    expect(byDefault).toEqual({
      netWorth: { currentSavings: 40000, totalDebt: 5000, emiRemaining: 14000, creditCardOutstanding: 2000, netWorth: 19000 },
      upcoming: [
        { source: "Salary", name: "February 2026", amount: 0, dueDate: "2026-02-01" },
        { source: "EMI", name: "Car Loan", amount: 2000, dueDate: "2026-03-12" },
        { source: "Subscription", name: "Streaming", amount: 499, dueDate: "2026-03-15" },
        { source: "Credit Card", name: "Card A", amount: 2000, dueDate: "2026-03-18" },
      ],
      emiFreeDate: expect.any(String),
    });
  });

  it("expenses-only reads no other module and yields nulls and no upcoming items", async () => {
    const result = await overview.dashboardOverview(TODAY, ["expenses"]);
    expectReadsOnly(["expenses"]);
    expect(result).toEqual({
      netWorth: { currentSavings: null, totalDebt: null, emiRemaining: null, creditCardOutstanding: null, netWorth: null },
      upcoming: [],
      emiFreeDate: null,
    });
  });

  it("computes each enabled figure but no Net Worth unless all four of its inputs are on", async () => {
    const result = await overview.dashboardOverview(TODAY, ["expenses", "finances", "debts", "emi"]);
    expectReadsOnly(["finances", "debts", "emi"]);
    expect(result.netWorth).toEqual({
      currentSavings: 40000,
      totalDebt: 5000,
      emiRemaining: 14000,
      creditCardOutstanding: null,
      netWorth: null,
    });
    expect(result.emiFreeDate).not.toBeNull();
  });

  it("lists Upcoming items only from enabled sources", async () => {
    const result = await overview.dashboardOverview(TODAY, ["subscriptions"]);
    expectReadsOnly(["subscriptions"]);
    expect(result.upcoming).toEqual([{ source: "Subscription", name: "Streaming", amount: 499, dueDate: "2026-03-15" }]);
    expect(result.emiFreeDate).toBeNull();
  });

  it("lists a card-billed EMI on its own when Credit Cards is off (no card entry to double up with)", async () => {
    const result = await overview.dashboardOverview(TODAY, ["emi"]);
    expectReadsOnly(["emi"]);
    expect(result.upcoming).toEqual([
      { source: "EMI", name: "Card A", amount: 1000, dueDate: "2026-03-10" },
      { source: "EMI", name: "Car Loan", amount: 2000, dueDate: "2026-03-12" },
    ]);
  });

  it("keeps the salary reminder with Finances and drops it without", async () => {
    const withFinances = await overview.dashboardOverview(TODAY, ["finances"]);
    expect(withFinances.upcoming.map((u) => u.source)).toEqual(["Salary"]);
    const without = await overview.dashboardOverview(TODAY, ["credit-cards"]);
    expect(without.upcoming.map((u) => u.source)).toEqual(["Credit Card"]);
  });
});
