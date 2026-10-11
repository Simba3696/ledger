import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "./createDocument";
import { DocumentBackend } from "./DocumentBackend";
import type { LedgerDocument } from "./types";
import { keyBetween, sequentialKeys } from "./sortKey";
import { RECORD_FIELDS, isWritableDocument } from "./validate";

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
    ["a time zone that is not a zone name", { ...emptyDocument(), settings: { modules: ["expenses"], timeZone: "0.zzz" } }],
    ["a subscription expiry that is not a calendar day", { ...emptyDocument(), subscriptions: [{ id: ID, updatedAt: 1, updatedBy: "a", service: "Music", amount: "1.00", duration: "Monthly", expiryAnchor: "2026-02-30", cardOrBank: "Card A" }] }],
    ["a sortKey whose integer part is too short (b0)", withExpenses({ "2026-05": [{ ...record, sortKey: "b0" }] })],
    ["a sortKey whose fraction ends in 0 (a10)", withExpenses({ "2026-05": [{ ...record, sortKey: "a10" }] })],
    ["the smallest integer as a sortKey", withExpenses({ "2026-05": [{ ...record, sortKey: `A${"0".repeat(26)}` }] })],
  ];
  for (const [name, doc] of bad) {
    it(`refuses ${name}`, () => {
      expect(isWritableDocument(doc)).toBe(false);
    });
  }
});

describe("the sortKey field check", () => {
  const isSortKeyField = RECORD_FIELDS.expenses.sortKey;
  const appendable = (key: string) => {
    try {
      keyBetween(key, null);
      keyBetween(null, key);
      return true;
    } catch {
      return false;
    }
  };

  it("accepts every key the backend makes", () => {
    const keys = sequentialKeys(400);
    for (const key of keys) expect(isSortKeyField(key)).toBe(true);
    for (let i = 1; i < keys.length; i += 37) expect(isSortKeyField(keyBetween(keys[i - 1], keys[i]))).toBe(true);
    expect(isSortKeyField(keyBetween(null, "a0"))).toBe(true);
  });

  it("accepts exactly the keys an append or a move can build on (B12: a remote key can't break a month)", () => {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const heads = "aAbBzZyY0";
    let seed = 7;
    const next = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    for (let i = 0; i < 4000; i++) {
      let key = heads[next(heads.length)];
      const length = next(6);
      for (let j = 0; j < length; j++) key += next(4) === 0 ? "0" : chars[next(chars.length)];
      expect(isSortKeyField(key), key).toBe(appendable(key));
    }
  });

  // A key the check accepts may come from another device, so the keys an
  // append or a move builds next to it must pass the check too: the diff
  // refuses an op holding any other, and the write would be a 500.
  it("builds a valid key on either side of every valid key, the integers next to the smallest and largest included", () => {
    const edges = [
      "A" + "0".repeat(25) + "1",
      "A" + "0".repeat(25) + "2",
      "A" + "0".repeat(26) + "1",
      "A" + "0".repeat(26) + "V",
      "Zz",
      "a0",
      "a0V",
      "z" + "z".repeat(26),
      "z" + "z".repeat(26) + "V",
    ];
    for (const key of edges) {
      expect(isSortKeyField(key), key).toBe(true);
      const below = keyBetween(null, key);
      const above = keyBetween(key, null);
      expect([isSortKeyField(below), below < key], `below ${key}: ${below}`).toEqual([true, true]);
      expect([isSortKeyField(above), above > key], `above ${key}: ${above}`).toEqual([true, true]);
    }
  });

  // The check sets no length limit (fv 1 checks may only be loosened), so
  // a remote key may be very long. Building a key next to one must not
  // recurse once per character, or a long run of "z" overflows the stack.
  it("builds a key between or after keys with a very long run of z, in constant stack depth", () => {
    const run = "z".repeat(100000);
    const cases: [string, string | null][] = [
      [`a0${run}`, "a1"],
      [`a0${run}`, null],
      [`${"z".repeat(27)}${run}`, null],
      [`a0${run}`, `a0${run}V`],
      [`a0${"y".repeat(50000)}${run}`, "a1"],
    ];
    for (const [a, b] of cases) {
      expect(isSortKeyField(a)).toBe(true);
      const key = keyBetween(a, b);
      expect([isSortKeyField(key), key > a, b === null || key < b], `${a.slice(0, 8)}…, ${b?.slice(0, 8)}`).toEqual([true, true, true]);
    }
  });
});
