import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "./createDocument";
import { DocumentBackend } from "./DocumentBackend";
import type { LedgerDocument } from "./types";
import { isWritableDocument } from "./validate";

// The deep document shape check GitHub mode applies to a document it did not
// just build: a genesis, a backup to restore, and sync's own self-check
// (ADR-0008). The SQL-store checks in validate.ts are held to the store by
// the backend parity suite instead.

const ID = "6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b";
const emptyDocument = () => createEmptyDocument({ modules: ["expenses", "debts"], timeZone: "UTC" });

describe("isWritableDocument", () => {
  const record = { id: ID, updatedAt: 1, updatedBy: "a", sortKey: "a0", amount: "1.00", remarks: "x", category: null, cardNote: null };
  const withExpenses = (expenses: Record<string, unknown>): LedgerDocument => ({ ...emptyDocument(), expenses } as LedgerDocument);

  it("accepts a document as the backend writes it", () => {
    expect(isWritableDocument(withExpenses({ "2026-05": [record] }))).toBe(true);
  });

  it("accepts every document DocumentBackend writes, every collection filled", async () => {
    let doc = createEmptyDocument({ modules: ["expenses", "finances", "debts", "emi", "credit-cards", "subscriptions"], timeZone: "UTC" });
    const host = { current: () => doc, commit: async (next: LedgerDocument) => void (doc = next) };
    const backend = new DocumentBackend({ host, now: () => Date.UTC(2026, 4, 10), actor: "alex", newId: () => crypto.randomUUID() });
    await backend.addEntry({ year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: true });
    await backend.setMonthLock(2026, 6, true);
    await backend.setMonthIncome(2026, 5, { salary: 50000, otherIncome: -0.5, savings: [{ name: "Fund A", amount: 1000 }] });
    await backend.addDebt({ name: "Sam", amount: -1.005 });
    await backend.setMonthBills(2026, 5, [{ name: "Card A", due: 900, paid: 0, dueDate: "2026-05-25", settled: false }]);
    await backend.addEmi({ cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: 9.5, foreclosureCharge: null, durationMonths: 12 });
    await backend.addSubscription({ service: "Music", amount: 199, duration: "Monthly", expiryAnchor: "2026-05-20", cardOrBank: "Card A" });
    await backend.deleteDebt((await backend.getDebts())[0].row);
    expect(doc.tombstones).toHaveLength(1);
    expect(isWritableDocument(doc)).toBe(true);
  });

  const bad: [string, unknown][] = [
    ["a record with an extra key", withExpenses({ "2026-05": [{ ...record, note: 1 }] })],
    ["a number for money", withExpenses({ "2026-05": [{ ...record, amount: 1 }] })],
    ["a month key that monthKey() would not write", withExpenses({ "2026-5": [record] })],
    ["one expense id in two months", withExpenses({ "2026-05": [record], "2026-06": [record] })],
    ["a record id that is not a uuid", withExpenses({ "2026-05": [{ ...record, id: "1" }] })],
    ["a lock that is not true", { ...emptyDocument(), monthLocks: { "2026-05": false } }],
    ["version 2", { ...emptyDocument(), version: 2 }],
    ["an unknown top-level key", { ...emptyDocument(), restoredAt: 1 }],
    ["two categories with one id", { ...emptyDocument(), categories: [...emptyDocument().categories, emptyDocument().categories[0]] }],
    ["a month's cards with one id twice", { ...emptyDocument(), cardBills: { "2026-05": [1, 2].map(() => ({ id: ID, updatedAt: 1, updatedBy: "a", name: "Card A", due: "1.00", paid: "0.00", dueDate: null, settled: false })) } }],
    ["a finance month missing savings", { ...emptyDocument(), financeMonths: { "2026-05": { salary: "1.00", otherIncome: null } } }],
    ["a missing collection", (({ debts: _debts, ...rest }) => rest)(emptyDocument())],
  ];
  for (const [name, doc] of bad) {
    it(`refuses ${name}`, () => {
      expect(isWritableDocument(doc)).toBe(false);
    });
  }
});
