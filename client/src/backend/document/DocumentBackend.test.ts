import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../ApiError";
import type { LedgerBackend } from "../LedgerBackend";
import { createEmptyDocument } from "./createDocument";
import { DocumentBackend, type DocumentHost } from "./DocumentBackend";
import { keyBetween, sequentialKeys } from "./sortKey";
import { monthKey, type ExpenseRecord, type LedgerDocument } from "./types";

// Document-only invariants of DocumentBackend: what the parity suite
// (server/test/parity/) can't see because the SQL store has no document.
// The parity suite holds every result and error to the SQL store's.

const ALL = ["expenses", "finances", "debts", "emi", "credit-cards", "subscriptions"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const START = Date.UTC(2026, 4, 10, 6, 0); // 10 May 2026, 11:30 in Asia/Kolkata

class TestHost implements DocumentHost {
  doc: LedgerDocument;
  commits = 0;
  /** Set to make the next commit wait, or fail. */
  commitDelay = 0;
  failCommit = false;
  #committing = false;
  overlapped = false;

  constructor(doc: LedgerDocument) {
    this.doc = doc;
  }
  current(): LedgerDocument {
    return this.doc;
  }
  async commit(next: LedgerDocument): Promise<void> {
    if (this.#committing) this.overlapped = true;
    this.#committing = true;
    try {
      if (this.commitDelay) await new Promise((resolve) => setTimeout(resolve, this.commitDelay));
      if (this.failCommit) throw new Error("disk full");
      this.commits++;
      this.doc = next;
    } finally {
      this.#committing = false;
    }
  }
}

function setup(doc: LedgerDocument = createEmptyDocument({ modules: [...ALL], timeZone: "Asia/Kolkata" })) {
  const host = new TestHost(doc);
  const clock = { now: START };
  const backend = new DocumentBackend({ host, now: () => clock.now, actor: "alex", newId: () => crypto.randomUUID() });
  return { host, clock, backend };
}

const entry = (remarks: string, amount = 10, month = 5) => ({ year: 2026, month, amount, remarks, category: "food", isCard: false });
const emiEdits = { cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: 9.5, foreclosureCharge: null };
const subscription = { service: "Music", amount: 199, duration: "Monthly" as const, expiryAnchor: "2026-05-20", cardOrBank: "Card A" };

/** Some of everything, written through the backend. */
async function populate(backend: LedgerBackend) {
  const a = await backend.addEntry(entry("Lunch", 120.5));
  const b = await backend.addEntry(entry("Bus", 1.005));
  await backend.setMonthIncome(2026, 5, { salary: 50000.555, otherIncome: -0.5, savings: [{ name: "Fund A", amount: 1000.1 }] });
  const debt = await backend.addDebt({ name: "Alex", amount: -1.005 });
  const emi = await backend.addEmi({ ...emiEdits, interestRate: 12.0005 });
  const sub = await backend.addSubscription(subscription);
  await backend.setMonthBills(2026, 5, [{ name: "Card A", due: 900.999, paid: 0.1, dueDate: "2026-05-25", settled: false }]);
  return { a, b, debt, emi, sub };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createEmptyDocument", () => {
  it("is version 1 with the 4 default categories at positions 0-3, fg included, and every collection empty", () => {
    const doc = createEmptyDocument({ modules: ["expenses"], timeZone: "UTC" });
    expect(doc).toEqual({
      version: 1,
      settings: { modules: ["expenses"], timeZone: "UTC" },
      categories: [
        { id: "food", label: "Food", bg: "#FFFF00", fg: "#3d3d00", position: 0 },
        { id: "transportation", label: "Transportation", bg: "#00B0F0", fg: "#00303d", position: 1 },
        { id: "rent", label: "Rent", bg: "#FFC000", fg: "#4d3300", position: 2 },
        { id: "other", label: "Other", bg: "#FF0000", fg: "#ffffff", position: 3 },
      ],
      expenses: {},
      monthLocks: {},
      financeMonths: {},
      debts: [],
      emis: [],
      subscriptions: [],
      cardBills: {},
      tombstones: [],
    });
  });
});

describe("DocumentBackend writes", () => {
  it("commits nothing and leaves the document untouched when a mutating call is rejected", async () => {
    const { host, backend } = setup();
    const { a, debt, emi, sub } = await populate(backend);
    await backend.setMonthLock(2026, 6, true);
    const before = JSON.stringify(host.current());
    const commits = host.commits;

    const rejected: [string, () => Promise<unknown>][] = [
      ["addEntry", () => backend.addEntry(entry("", 1))],
      ["addEntry locked", () => backend.addEntry(entry("x", 1, 6))],
      ["updateEntry", () => backend.updateEntry(2026, 5, a.row, { amount: 0, remarks: "x", category: "food", isCard: false })],
      ["updateEntry missing", () => backend.updateEntry(2026, 5, 999, { amount: 1, remarks: "x", category: "food", isCard: false })],
      ["deleteEntry", () => backend.deleteEntry(2026, 4, a.row)],
      ["moveEntry", () => backend.moveEntry(2026, 5, a.row, 999)],
      ["setMonthLock", () => backend.setMonthLock(2017, 1, true)],
      ["setMonthIncome", () => backend.setMonthIncome(2026, 5, { salary: 1e12, otherIncome: null, savings: [] })],
      ["addDebt", () => backend.addDebt({ name: " ", amount: 1 })],
      ["updateDebt", () => backend.updateDebt(debt.row, { name: "Alex", amount: 1e12 })],
      ["deleteDebt", () => backend.deleteDebt(a.row)],
      ["setMonthBills", () => backend.setMonthBills(2026, 5, [{ name: "", due: 1, paid: 1, dueDate: null, settled: false }])],
      ["addEmi", () => backend.addEmi({ ...emiEdits, dueDay: 32 })],
      ["updateEmi", () => backend.updateEmi(emi.row, { ...emiEdits, interestRate: 101 })],
      ["deleteEmi", () => backend.deleteEmi(debt.row)],
      ["payEmi", () => backend.payEmi(emi.row, -1)],
      ["addSubscription", () => backend.addSubscription({ ...subscription, expiryAnchor: "2026-02-30" })],
      ["updateSubscription", () => backend.updateSubscription(sub.row, { ...subscription, amount: 0 })],
      ["deleteSubscription", () => backend.deleteSubscription(0)],
    ];
    for (const [name, call] of rejected) {
      await expect(call(), name).rejects.toBeInstanceOf(ApiError);
      expect(JSON.stringify(host.current()), name).toBe(before);
    }
    expect(host.commits).toBe(commits);
  });

  it("commits nothing when the host refuses the commit, and reports a 500 tagged for the console", async () => {
    const { host, backend } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = JSON.stringify(host.current());
    host.failCommit = true;
    await expect(backend.addDebt({ name: "Alex", amount: 1 })).rejects.toEqual(new ApiError(500, "Internal server error"));
    expect(JSON.stringify(host.current())).toBe(before);
    expect(error).toHaveBeenCalledWith("ledger:document-backend", expect.objectContaining({ message: "disk full" }));
  });

  it("stamps created and changed records with a uuid, the injected clock and the actor, and leaves unchanged ones alone", async () => {
    const { host, clock, backend } = setup();
    const { a, b, debt } = await populate(backend);
    const doc = host.current();
    const records = [...Object.values(doc.expenses).flat(), ...doc.debts, ...doc.emis, ...doc.subscriptions, ...Object.values(doc.cardBills).flat()];
    expect(records).toHaveLength(6);
    for (const r of records) expect(r).toMatchObject({ id: expect.stringMatching(UUID), updatedAt: START, updatedBy: "alex" });

    clock.now = START + 60_000;
    await backend.updateEntry(2026, 5, a.row, { amount: 99, remarks: "Lunch", category: "food", isCard: false });
    await backend.updateEntry(2026, 5, b.row, { amount: 1.01, remarks: " Bus ", category: "food", isCard: false }); // same fields once stored
    await backend.updateDebt(debt.row, { name: "Alex", amount: -1.01 }); // ditto
    await backend.setMonthBills(2026, 5, [{ name: "Card A", due: 902, paid: 0.1, dueDate: "2026-05-25", settled: false }]);
    const after = host.current();
    const [lunch, bus] = after.expenses[monthKey(2026, 5)];
    expect(lunch).toMatchObject({ amount: "99.00", updatedAt: START + 60_000 });
    expect(bus.updatedAt).toBe(START);
    expect(after.debts[0].updatedAt).toBe(START);
    // A card saved again at the same position under the same name keeps its id.
    expect(after.cardBills[monthKey(2026, 5)][0]).toMatchObject({ id: doc.cardBills[monthKey(2026, 5)][0].id, updatedAt: START + 60_000 });
  });

  it("writes one tombstone per deleted expense, debt, EMI and subscription, and none for card bills or finances", async () => {
    const { host, clock, backend } = setup();
    const { a, debt, emi, sub } = await populate(backend);
    const doc = host.current();
    const ids = [doc.expenses[monthKey(2026, 5)][0].id, doc.debts[0].id, doc.emis[0].id, doc.subscriptions[0].id];
    clock.now = START + 5_000;
    await backend.deleteEntry(2026, 5, a.row);
    await backend.deleteDebt(debt.row);
    await backend.deleteEmi(emi.row);
    await backend.deleteSubscription(sub.row);
    await backend.setMonthBills(2026, 5, []);
    await backend.setMonthIncome(2026, 5, { salary: null, otherIncome: null, savings: [] });
    expect(host.current().tombstones).toEqual(ids.map((id) => ({ id, deletedAt: START + 5_000 })));
    expect(host.current().cardBills).toEqual({});
  });

  it("stores money as 2-decimal strings and rates as 3-decimal strings, rounded half away from zero", async () => {
    const { host, backend } = setup();
    await populate(backend);
    await backend.payEmi((await backend.getEmis())[0].row, 333.335);
    const doc = host.current();
    const money: (string | null)[] = [
      ...Object.values(doc.expenses).flat().map((r) => r.amount),
      ...doc.debts.map((r) => r.amount),
      ...doc.emis.flatMap((r) => [r.emiAmount, r.totalAmount, r.remainingAsOf]),
      ...doc.subscriptions.map((r) => r.amount),
      ...Object.values(doc.cardBills).flat().flatMap((r) => [r.due, r.paid]),
      ...Object.values(doc.financeMonths).flatMap((m) => [m.salary, m.otherIncome, ...m.savings.map((s) => s.amount)]),
    ];
    for (const value of money) expect(value).toMatch(/^-?\d+\.\d{2}$/);
    for (const r of doc.emis) expect(r.interestRate).toMatch(/^\d+\.\d{3}$/);
    expect(doc.expenses[monthKey(2026, 5)][1].amount).toBe("1.01");
    expect(doc.debts[0].amount).toBe("-1.01");
    expect(doc.emis[0].interestRate).toBe("12.001");
    expect(doc.financeMonths[monthKey(2026, 5)]).toEqual({ salary: "50000.56", otherIncome: "-0.50", savings: [{ name: "Fund A", amount: "1000.10" }] });
    expect(doc.cardBills[monthKey(2026, 5)][0].due).toBe("901.00");
  });

  it("runs 20 concurrent appends to one month one at a time, in call order, with one commit each", async () => {
    const { host, backend } = setup();
    host.commitDelay = 2;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => backend.addEntry(entry(`#${i}`, i + 1))));
    expect(host.commits).toBe(20);
    expect(host.overlapped).toBe(false);
    const listed = await backend.getMonth(2026, 5);
    expect(listed.map((e) => e.remarks)).toEqual(results.map((_, i) => `#${i}`));
    expect(listed.map((e) => e.row)).toEqual(results.map((r) => r.row));
    // Positions are the index in (sortKey, id) order: strictly increasing keys.
    const keys = host.current().expenses[monthKey(2026, 5)].map((r) => r.sortKey);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(20);
  });
});

describe("DocumentBackend order and handles", () => {
  it("generates keys strictly between their neighbours, short ones for appends", () => {
    const keys = sequentialKeys(200);
    expect([...keys].sort()).toEqual(keys);
    expect(keys[0]).toBe("a0");
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(3);
    let low = "a0";
    let high = "a1";
    for (let i = 0; i < 50; i++) {
      const mid = keyBetween(low, high);
      expect(low < mid && mid < high).toBe(true);
      if (i % 2) low = mid;
      else high = mid;
    }
    expect(keyBetween(null, "a0") < "a0").toBe(true);
    expect(() => keyBetween("a1", "a0")).toThrow();
  });

  it("lists a month by (sortKey, id) and re-keys the month when a move lands between two tied keys", async () => {
    const doc = createEmptyDocument({ modules: [...ALL], timeZone: "UTC" });
    const record = (id: string, sortKey: string, remarks: string): ExpenseRecord => ({
      id,
      updatedAt: 0,
      updatedBy: "seed",
      sortKey,
      amount: "1.00",
      remarks,
      category: "food",
      cardNote: null,
    });
    // Two devices appended with the same key; a sync kept both.
    doc.expenses[monthKey(2026, 5)] = [record("c", "a2", "C"), record("b", "a1", "B2"), record("a", "a1", "B1"), record("d", "a0", "A")];
    const { host, backend } = setup(doc);
    expect((await backend.getMonth(2026, 5)).map((e) => e.remarks)).toEqual(["A", "B1", "B2", "C"]);

    const rows = (await backend.getMonth(2026, 5)).map((e) => e.row);
    await backend.moveEntry(2026, 5, rows[3], rows[1]); // C up, to just before B1: room between A and B1
    expect((await backend.getMonth(2026, 5)).map((e) => e.remarks)).toEqual(["A", "C", "B1", "B2"]);
    await backend.moveEntry(2026, 5, rows[0], rows[1]); // A down, to just after B1: between the tied keys
    expect((await backend.getMonth(2026, 5)).map((e) => e.remarks)).toEqual(["C", "B1", "A", "B2"]);
    const keys = host.current().expenses[monthKey(2026, 5)].map((r) => r.sortKey);
    expect(new Set(keys).size).toBe(4);
  });

  it("rewrites only the moved record's key and stamps on a move, and nothing on a move onto itself", async () => {
    const { host, clock, backend } = setup();
    const rows = [];
    for (const remarks of ["A", "B", "C", "D"]) rows.push((await backend.addEntry(entry(remarks))).row);
    const before = structuredClone(host.current().expenses[monthKey(2026, 5)]);

    clock.now = START + 1_000;
    await backend.moveEntry(2026, 5, rows[0], rows[2]); // A down, to just after C
    const after = host.current().expenses[monthKey(2026, 5)];
    expect(after.map((r) => r.remarks)).toEqual(["B", "C", "A", "D"]);
    const changed = after.filter((r) => JSON.stringify(r) !== JSON.stringify(before.find((b) => b.id === r.id)));
    expect(changed).toEqual([expect.objectContaining({ remarks: "A", updatedAt: START + 1_000, updatedBy: "alex" })]);

    const unchanged = JSON.stringify(host.current());
    await backend.moveEntry(2026, 5, rows[1], rows[1]);
    expect(JSON.stringify(host.current())).toBe(unchanged);
  });

  it("keeps row handles across a host document replacement, and never reuses one", async () => {
    const { host, backend } = setup();
    const lunch = await backend.addEntry(entry("Lunch"));
    const debt = await backend.addDebt({ name: "Alex", amount: 5 });

    // A sync replaces the document: same records (new objects), plus one
    // another device added, which gets a fresh handle when first listed.
    const synced = structuredClone(host.current());
    synced.expenses[monthKey(2026, 5)].unshift({ ...synced.expenses[monthKey(2026, 5)][0], id: crypto.randomUUID(), sortKey: "Zz", remarks: "Remote" });
    host.doc = synced;

    const listed = await backend.getMonth(2026, 5);
    expect(listed.map((e) => e.remarks)).toEqual(["Remote", "Lunch"]);
    expect(listed[1].row).toBe(lunch.row);
    expect(new Set([lunch.row, debt.row, listed[0].row]).size).toBe(3);
    await expect(backend.updateEntry(2026, 5, lunch.row, { amount: 12, remarks: "Lunch", category: "food", isCard: false })).resolves.toMatchObject({
      row: lunch.row,
      amount: 12,
    });
    await expect(backend.updateDebt(debt.row, { name: "Alex", amount: 6 })).resolves.toMatchObject({ row: debt.row });
    // A handle of another kind, or one never issued, is the store's 404,
    // and like every rejected write it commits nothing.
    const before = JSON.stringify(host.current());
    const commits = host.commits;
    await expect(backend.updateEntry(2026, 5, debt.row, { amount: 1, remarks: "x", category: "food", isCard: false })).rejects.toMatchObject({
      status: 404,
      message: `No entry found at row ${debt.row} in May 2026`,
    });
    await expect(backend.deleteDebt(1.5)).rejects.toMatchObject({ status: 404, message: "No debt entry at row 1.5" });
    expect(JSON.stringify(host.current())).toBe(before);
    expect(host.commits).toBe(commits);
  });

  it("returns fresh copies: mutating a result changes nothing stored", async () => {
    const { host, backend } = setup();
    await populate(backend);
    const before = JSON.stringify(host.current());
    const results: unknown[] = [
      await backend.getMonth(2026, 5),
      await backend.getCategories(),
      await backend.getMonthIncome(2026, 5),
      await backend.getDebts(),
      await backend.getEmis(),
      await backend.getSubscriptions(),
      await backend.getMonthBills(2026, 5),
      await backend.getConfig(),
      await backend.getOverview(),
    ];
    const vandalise = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(vandalise);
        value.push("junk");
      } else if (value !== null && typeof value === "object") {
        for (const key of Object.keys(value)) {
          vandalise((value as Record<string, unknown>)[key]);
          (value as Record<string, unknown>)[key] = "junk";
        }
      }
    };
    results.forEach(vandalise);
    expect(JSON.stringify(host.current())).toBe(before);
    expect((await backend.getMonth(2026, 5))[0].remarks).toBe("Lunch");
  });
});

describe("DocumentBackend gate and errors", () => {
  it("404s a disabled module's calls with its label and lists enabled modules in canonical order", async () => {
    // The class is the LedgerBackend and nothing more: its 31 methods.
    const methods = Object.getOwnPropertyNames(DocumentBackend.prototype).filter((name) => name !== "constructor");
    expect(methods).toHaveLength(31);

    const doc = createEmptyDocument({ modules: ["subscriptions", "expenses"], timeZone: "UTC" });
    const { host, backend } = setup(doc);
    await expect(backend.getConfig()).resolves.toEqual({ modules: ["expenses", "subscriptions"] });
    const before = JSON.stringify(host.current());
    await expect(backend.addDebt({ name: "Alex", amount: 1 })).rejects.toEqual(new ApiError(404, "Debts is not enabled on this deployment"));
    // The gate rejects before the write starts: nothing committed.
    expect(JSON.stringify(host.current())).toBe(before);
    expect(host.commits).toBe(0);
    await expect(backend.getMonthBills(2017, 13)).rejects.toEqual(new ApiError(404, "Credit Cards is not enabled on this deployment"));
    await expect(backend.getEmiMonthlyProjection(12)).rejects.toEqual(new ApiError(404, "EMI is not enabled on this deployment"));
    await expect(backend.getOverview()).resolves.toMatchObject({ netWorth: { netWorth: null, totalDebt: null } });
    await expect(backend.addEntry(entry("Lunch"))).resolves.toMatchObject({ remarks: "Lunch" });
  });

  it("maps an unexpected failure to a 500 and logs it with the ledger:document-backend tag", async () => {
    const doc = createEmptyDocument({ modules: [...ALL], timeZone: "Not/AZone" });
    const { backend } = setup(doc);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = backend.getOverview();
    await expect(failure).rejects.toBeInstanceOf(ApiError);
    await expect(failure).rejects.toMatchObject({ status: 500, message: "Internal server error" });
    expect(error).toHaveBeenCalledWith("ledger:document-backend", expect.any(RangeError));
    // A store-style failure is not logged.
    error.mockClear();
    await expect(backend.getMonth(2017, 1)).rejects.toEqual(new ApiError(400, "Invalid year: 2017"));
    expect(error).not.toHaveBeenCalled();
  });
});

describe("DocumentBackend performance", () => {
  it("answers the year summary, finance summary and overview for a 10-year, 12,000-expense document in under 1 s each", async () => {
    const doc = createEmptyDocument({ modules: [...ALL], timeZone: "Asia/Kolkata" });
    const keys = sequentialKeys(100);
    const categories = ["food", "transportation", "rent", "other"];
    let n = 0;
    for (let year = 2018; year <= 2027; year++) {
      for (let month = 1; month <= 12; month++) {
        doc.expenses[monthKey(year, month)] = keys.map((sortKey, i) => ({
          id: `e-${++n}`,
          updatedAt: 0,
          updatedBy: "seed",
          sortKey,
          amount: `${(i * 7) % 900}.${String(i % 100).padStart(2, "0")}`,
          remarks: `Expense ${i}`,
          category: categories[i % 4],
          cardNote: i % 3 ? null : "CC",
        }));
        doc.financeMonths[monthKey(year, month)] = { salary: "85000.00", otherIncome: null, savings: [{ name: "Fund A", amount: `${year * 10}.00` }] };
      }
    }
    const count = Object.values(doc.expenses).reduce((sum, records) => sum + records.length, 0);
    expect(count).toBe(12_000);
    const { backend } = setup(doc);

    const timings: Record<string, number> = {};
    for (const [name, call] of [
      ["getYearSummary", () => backend.getYearSummary(2026)],
      ["getFinanceSummary", () => backend.getFinanceSummary(2026)],
      ["getOverview", () => backend.getOverview()],
    ] as const) {
      const start = performance.now();
      await call();
      timings[name] = Math.round(performance.now() - start);
    }
    console.log(`DocumentBackend over ${count} expenses: ${JSON.stringify(timings)} (ms)`);
    for (const ms of Object.values(timings)) expect(ms).toBeLessThan(1000);
  });
});
