import { describe, expect } from "vitest";
import type { ModuleName } from "../../../client/src/api";
import type { LedgerBackend } from "../../../client/src/backend/LedgerBackend";
import { MISSING_ID, parity } from "./harness";
import { ALL_MODULES, type Fixture } from "./seed";

// server/test/overviewModules.test.ts against both backends: the overview
// with only some modules enabled (ENABLED_MODULES on the SQL side,
// settings.modules on the document). The store cases also spy on which
// store reads run; over the API, what the comparison sees is the result.

const fixture: Fixture = {
  today: "2026-03-05",
  financeMonths: [{ year: 2026, month: 3, savings: [{ name: "PPF", amount: 40000 }] }],
  debts: [{ name: "Alex", amount: 5000 }],
  emis: [
    { cardOrBank: "Card A", emiAmount: 1000, dueDay: 10, totalAmount: 10000, remainingAsOf: 6000, asOfDate: "2026-03-01" },
    { cardOrBank: "Car Loan", emiAmount: 2000, dueDay: 12, totalAmount: 20000, remainingAsOf: 8000, asOfDate: "2026-03-01" },
  ],
  subscriptions: [{ service: "Streaming", amount: 499, duration: "Monthly", expiryAnchor: "2026-03-15", cardOrBank: "Card A" }],
  cardBills: [{ year: 2026, month: 3, cards: [{ name: "Card A", due: 3000, paid: 1000, dueDate: "2026-03-18", settled: false }] }],
};

const only = (modules: ModuleName[]): Fixture => ({ ...fixture, modules });

describe("dashboardOverview with ENABLED_MODULES", () => {
  parity("defaults to every module, identical to naming them all", fixture, async (b, { setModules }) => {
    const byDefault = await b.getOverview();
    await setModules([...ALL_MODULES]);
    expect(await b.getOverview()).toEqual(byDefault);
    expect(byDefault.netWorth).toEqual({ currentSavings: 40000, totalDebt: 5000, emiRemaining: 14000, creditCardOutstanding: 2000, netWorth: 19000 });
  });

  parity("expenses-only reads no other module and yields nulls and no upcoming items", only(["expenses"]), async (b) => {
    await b.getOverview();
  });

  parity(
    "computes each enabled figure but no Net Worth unless all four of its inputs are on",
    only(["expenses", "finances", "debts", "emi"]),
    async (b) => {
      await b.getOverview();
    },
  );

  parity("lists Upcoming items only from enabled sources", only(["subscriptions"]), async (b) => {
    await b.getOverview();
  });

  parity("lists a card-billed EMI on its own when Credit Cards is off (no card entry to double up with)", only(["emi"]), async (b) => {
    await b.getOverview();
  });

  parity("keeps the salary reminder with Finances and drops it without", fixture, async (b, { setModules }) => {
    await setModules(["finances"]);
    await b.getOverview();
    await setModules(["credit-cards"]);
    await b.getOverview();
  });
});

/** Every method of each module, with arguments its store would reject: the
 * gate answers first, so they're the 404 regardless. */
const MODULE_CALLS: Record<ModuleName, ((b: LedgerBackend) => Promise<unknown>)[]> = {
  expenses: [
    (b) => b.getMonth(2017, 13),
    (b) => b.addEntry({ year: 2026, month: 3, amount: 0, remarks: "", category: "nope", isCard: false }),
    (b) => b.updateEntry(2026, 3, MISSING_ID, { amount: 1, remarks: "x", category: "food", isCard: false }),
    (b) => b.deleteEntry(2026, 3, MISSING_ID),
    (b) => b.moveEntry(2026, 3, MISSING_ID, MISSING_ID),
    (b) => b.getMonthLock(2026, 3),
    (b) => b.setMonthLock(2026, 3, true),
    (b) => b.getYearSummary(2026),
  ],
  finances: [
    (b) => b.getMonthIncome(2026, 3),
    (b) => b.setMonthIncome(2026, 3, { salary: 1, otherIncome: null, savings: [] }),
    (b) => b.getFinanceSummary(2026),
  ],
  debts: [
    (b) => b.getDebts(),
    (b) => b.addDebt({ name: "", amount: 1 }),
    (b) => b.updateDebt(MISSING_ID, { name: "x", amount: 1 }),
    (b) => b.deleteDebt(MISSING_ID),
  ],
  emi: [
    (b) => b.getEmis(),
    (b) => b.addEmi({ cardOrBank: "", emiAmount: 1, dueDay: 1, totalAmount: 1, remarks: "", remainingAsOf: 1, interestRate: null, foreclosureCharge: null }),
    (b) => b.updateEmi(MISSING_ID, { cardOrBank: "x", emiAmount: 1, dueDay: 1, totalAmount: 1, remarks: "", remainingAsOf: 1, interestRate: null, foreclosureCharge: null }),
    (b) => b.deleteEmi(MISSING_ID),
    (b) => b.payEmi(MISSING_ID, -1),
    (b) => b.getEmiMonthlyProjection(12),
  ],
  "credit-cards": [
    (b) => b.getMonthBills(2026, 3),
    (b) => b.setMonthBills(2026, 3, []),
    (b) => b.getCreditCardBillsSummary(2026),
  ],
  subscriptions: [
    (b) => b.getSubscriptions(),
    (b) => b.addSubscription({ service: "", amount: 1, duration: "Monthly", expiryAnchor: "2026-01-01", cardOrBank: "" }),
    (b) => b.updateSubscription(MISSING_ID, { service: "x", amount: 1, duration: "Monthly", expiryAnchor: "2026-01-01", cardOrBank: "" }),
    (b) => b.deleteSubscription(MISSING_ID),
  ],
};

describe("document parity: module gate", () => {
  parity("each disabled module's methods return the 404 with the label from modules.ts:17-24", fixture, async (b, { setModules, lastError }) => {
    const labels: Record<ModuleName, string> = {
      expenses: "Expenses",
      finances: "Finances",
      debts: "Debts",
      emi: "EMI",
      "credit-cards": "Credit Cards",
      subscriptions: "Subscriptions",
    };
    expect(Object.values(MODULE_CALLS).flat().length + 3).toBe(31);
    for (const module of ALL_MODULES) {
      await setModules(ALL_MODULES.filter((m) => m !== module));
      for (const call of MODULE_CALLS[module]) {
        await call(b);
        expect(lastError()).toEqual({ status: 404, message: `${labels[module]} is not enabled on this deployment` });
      }
      // Categories, config and the overview are always on.
      await b.getCategories();
      await b.getConfig();
      await b.getOverview();
    }
  });

  parity("getConfig lists the enabled modules in canonical order", only(["subscriptions", "expenses", "debts"]), async (b, { setModules }) => {
    await b.getConfig();
    await setModules(["credit-cards", "emi", "finances"]);
    await b.getConfig();
    await setModules(undefined);
    await b.getConfig();
  });
});
