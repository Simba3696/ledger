import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../ApiError";
import { sequentialKeys } from "../document/sortKey";
import type { LedgerDocument } from "../document/types";
import { diffDocuments, UnrepresentableChange } from "./diff";
import { createOrderKey } from "./keys";
import type { Op } from "./state";
import { Replica, deviceId, emptyDocument, fingerprint } from "./testkit";

// The diff (design sections 3.2 and 3.3): each write through DocumentBackend
// becomes exactly the op section 3.2 lists, a write that changes nothing (or
// only stamps) makes none, and any difference an op can't represent throws
// instead of being dropped. Replica checks AC3 after every commit: the state
// with the op joined materialises to exactly the document the write made.

const A = deviceId(0xa);
const ENTRY = { year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false };
const EMI = { cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: 9.5, foreclosureCharge: null };
const SUB = { service: "Music", amount: 199, duration: "Monthly" as const, expiryAnchor: "2026-05-20", cardOrBank: "Card A" };

afterEach(() => {
  vi.restoreAllMocks();
});

function replica(doc: LedgerDocument = emptyDocument()): Replica {
  return new Replica(A, doc);
}

/** The op the next write makes. */
async function opOf(r: Replica, write: () => Promise<unknown>): Promise<Op | undefined> {
  const before = r.ops.length;
  await write();
  expect(r.ops.length - before).toBeLessThanOrEqual(1);
  return r.ops[before];
}

function keysOf(op: Op | undefined): string[] {
  return (op?.set ?? []).map(([key]) => key);
}

describe("each write yields exactly its op (section 3.2)", () => {
  it("addEntry: the create marker with the month, every field, the sortKey and the stamp", async () => {
    const r = replica();
    r.clock = 1234;
    const op = await opOf(r, () => r.backend.addEntry(ENTRY));
    const id = r.doc.expenses["2026-05"][0].id;
    expect(op?.set).toEqual([
      [`e/${id}/_c`, { m: "2026-05" }],
      [`e/${id}/sortKey`, "a0"],
      [`e/${id}/amount`, "40.00"],
      [`e/${id}/remarks`, "Groceries"],
      [`e/${id}/category`, "food"],
      [`e/${id}/cardNote`, null],
      [`e/${id}/_s`, { at: 1234, by: "alex" }],
    ]);
    expect(op?.del).toEqual([]);
    expect(op?.L).toBe(2);
  });

  it("updateEntry: only the changed fields plus the stamp; nothing at all when no field changed", async () => {
    const r = replica();
    const entry = await r.backend.addEntry(ENTRY);
    const id = r.doc.expenses["2026-05"][0].id;
    r.clock += 1000;
    const op = await opOf(r, () => r.backend.updateEntry(2026, 5, entry.row, { amount: 12, remarks: "Groceries", category: "food", isCard: true }));
    expect(op?.set).toEqual([
      [`e/${id}/amount`, "12.00"],
      [`e/${id}/cardNote`, "CC"],
      [`e/${id}/_s`, { at: r.clock, by: "alex" }],
    ]);
    r.clock += 1000;
    expect(await opOf(r, () => r.backend.updateEntry(2026, 5, entry.row, { amount: 12, remarks: "Groceries", category: "food", isCard: true }))).toBeUndefined();
  });

  it("deleteEntry: one deletion and no registers", async () => {
    const r = replica();
    const entry = await r.backend.addEntry(ENTRY);
    const id = r.doc.expenses["2026-05"][0].id;
    const op = await opOf(r, () => r.backend.deleteEntry(2026, 5, entry.row));
    expect(op).toMatchObject({ set: [], del: [`e/${id}`] });
    expect(r.doc.expenses).toEqual({});
    expect(r.state.del.get(`e/${id}`)).toEqual({ by: A, L: op!.L, vv: op!.vv });
  });

  it("moveEntry: the moved record's sortKey and stamp", async () => {
    const r = replica();
    const first = await r.backend.addEntry(ENTRY);
    await r.backend.addEntry({ ...ENTRY, remarks: "Bus" });
    const third = await r.backend.addEntry({ ...ENTRY, remarks: "Rent" });
    const id = r.doc.expenses["2026-05"][2].id;
    const op = await opOf(r, () => r.backend.moveEntry(2026, 5, third.row, first.row));
    expect(keysOf(op)).toEqual([`e/${id}/sortKey`, `e/${id}/_s`]);
    expect(r.doc.expenses["2026-05"].map((e) => e.remarks)).toEqual(["Rent", "Groceries", "Bus"]);
  });

  it("moveEntry that re-keys the month: every re-keyed record's sortKey and stamp", async () => {
    // Two records sharing a key, as two devices' concurrent appends leave them.
    const doc = emptyDocument();
    const stamp = { updatedAt: 1, updatedBy: "sam" };
    const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
    doc.expenses["2026-05"] = ids.map((id, i) => ({ id, ...stamp, sortKey: i < 2 ? "a0" : "a5", amount: "1.00", remarks: `R${i}`, category: "food", cardNote: null }));
    const r = replica(doc);
    const rows = await r.backend.getMonth(2026, 5);
    // R2 goes between R0 and R1, which share a key: the month is re-keyed.
    const op = await opOf(r, () => r.backend.moveEntry(2026, 5, rows[2].row, rows[1].row));
    const keys = sequentialKeys(3);
    expect(r.doc.expenses["2026-05"].map((e) => [e.remarks, e.sortKey])).toEqual([["R0", keys[0]], ["R2", keys[1]], ["R1", keys[2]]]);
    // R0 keeps a0; R2 and R1 are re-keyed, each with its stamp.
    expect(keysOf(op)).toEqual([`e/${ids[2]}/sortKey`, `e/${ids[2]}/_s`, `e/${ids[1]}/sortKey`, `e/${ids[1]}/_s`]);
  });

  it("setMonthLock: lk/<month> true, then false (an unlock is a write too)", async () => {
    const r = replica();
    expect((await opOf(r, () => r.backend.setMonthLock(2026, 5, true)))?.set).toEqual([["lk/2026-05", true]]);
    expect((await opOf(r, () => r.backend.setMonthLock(2026, 5, false)))?.set).toEqual([["lk/2026-05", false]]);
    expect(await opOf(r, () => r.backend.setMonthLock(2026, 5, false))).toBeUndefined();
  });

  it("setMonthIncome: the whole month as one value", async () => {
    const r = replica();
    const op = await opOf(r, () => r.backend.setMonthIncome(2026, 5, { salary: 50000, otherIncome: null, savings: [{ name: "Fund A", amount: 1000 }] }));
    expect(op?.set).toEqual([["fm/2026-05", { salary: "50000.00", otherIncome: null, savings: [{ name: "Fund A", amount: "1000.00" }] }]]);
  });

  it("addDebt / updateDebt / deleteDebt: create with an order key, changed fields, deletion", async () => {
    const r = replica();
    const add = await opOf(r, () => r.backend.addDebt({ name: "Sam", amount: 500 }));
    const id = r.doc.debts[0].id;
    expect(add?.set[0]).toEqual([`debt/${id}/_c`, { o: createOrderKey(2, A) }]);
    expect(keysOf(add)).toEqual([`debt/${id}/_c`, `debt/${id}/name`, `debt/${id}/amount`, `debt/${id}/_s`]);
    const update = await opOf(r, () => r.backend.updateDebt(1, { name: "Sam", amount: 250 }));
    expect(keysOf(update)).toEqual([`debt/${id}/amount`, `debt/${id}/_s`]);
    const remove = await opOf(r, () => r.backend.deleteDebt(1));
    expect(remove).toMatchObject({ set: [], del: [`debt/${id}`] });
  });

  it("setMonthBills: the whole array, and null when the month is emptied", async () => {
    const r = replica();
    const op = await opOf(r, () => r.backend.setMonthBills(2026, 5, [{ name: "Card A", due: 900, paid: 0, dueDate: "2026-05-25", settled: false }]));
    expect(op?.set).toEqual([["cb/2026-05", r.doc.cardBills["2026-05"]]]);
    const cleared = await opOf(r, () => r.backend.setMonthBills(2026, 5, []));
    expect(cleared?.set).toEqual([["cb/2026-05", null]]);
    expect(r.doc.cardBills).toEqual({});
  });

  it("addEmi / updateEmi / payEmi / deleteEmi", async () => {
    const r = replica();
    const add = await opOf(r, () => r.backend.addEmi(EMI));
    const id = r.doc.emis[0].id;
    expect(keysOf(add)).toHaveLength(1 + 10 + 1);
    const update = await opOf(r, () => r.backend.updateEmi(1, { ...EMI, remarks: "Bank B" }));
    expect(keysOf(update)).toEqual([`emi/${id}/remarks`, `emi/${id}/_s`]);
    r.clock = Date.UTC(2026, 5, 10, 6, 0);
    const pay = await opOf(r, () => r.backend.payEmi(1, 1000));
    expect(keysOf(pay)).toEqual(expect.arrayContaining([`emi/${id}/remainingAsOf`, `emi/${id}/_s`]));
    expect(keysOf(pay).every((k) => ["remainingAsOf", "asOfDate", "_s"].includes(k.split("/")[2]))).toBe(true);
    expect(await opOf(r, () => r.backend.deleteEmi(1))).toMatchObject({ set: [], del: [`emi/${id}`] });
  });

  it("addSubscription / updateSubscription / deleteSubscription", async () => {
    const r = replica();
    const add = await opOf(r, () => r.backend.addSubscription(SUB));
    const id = r.doc.subscriptions[0].id;
    expect(keysOf(add)).toHaveLength(1 + 5 + 1);
    const update = await opOf(r, () => r.backend.updateSubscription(1, { ...SUB, duration: "Yearly" }));
    expect(keysOf(update)).toEqual([`sub/${id}/duration`, `sub/${id}/_s`]);
    expect(await opOf(r, () => r.backend.deleteSubscription(1))).toMatchObject({ set: [], del: [`sub/${id}`] });
  });

  it("settings (#8's updateSettings): st/modules and/or st/timeZone", () => {
    const r = replica();
    expect(r.amend((doc) => (doc.settings.modules = ["expenses"]))?.set).toEqual([["st/modules", ["expenses"]]]);
    expect(r.amend((doc) => (doc.settings.timeZone = "Asia/Kolkata"))?.set).toEqual([["st/timeZone", "Asia/Kolkata"]]);
  });

  it("new list records sort after every record the device had seen, as push() does", async () => {
    const r = replica();
    for (const name of ["Sam", "Alex", "Card A"]) await r.backend.addDebt({ name, amount: 1 });
    expect(r.doc.debts.map((d) => d.name)).toEqual(["Sam", "Alex", "Card A"]);
  });
});

describe("no op", () => {
  it("a change to the stamps alone produces nothing (the old B19 class)", async () => {
    const r = replica();
    await r.backend.addEntry(ENTRY);
    await r.backend.addDebt({ name: "Sam", amount: 1 });
    const before = fingerprint(r.state);
    expect(
      r.amend((doc) => {
        doc.expenses["2026-05"][0].updatedAt += 99;
        doc.debts[0].updatedBy = "sam";
      }),
    ).toBeNull();
    expect(fingerprint(r.state)).toBe(before);
  });

  it("tombstones are ignored", () => {
    const r = replica();
    expect(r.amend((doc) => doc.tombstones.push({ id: "x", deletedAt: 1 }))).toBeNull();
  });
});

describe("fail closed", () => {
  async function seeded(): Promise<Replica> {
    const r = replica();
    await r.backend.addEntry(ENTRY);
    await r.backend.addDebt({ name: "Sam", amount: 1 });
    await r.backend.addDebt({ name: "Alex", amount: 2 });
    return r;
  }

  const cases: [string, (doc: LedgerDocument) => void][] = [
    ["a changed version", (doc) => ((doc as { version: number }).version = 2)],
    ["changed categories", (doc) => (doc.categories[0].label = "Groceries")],
    ["an unknown document key", (doc) => ((doc as unknown as Record<string, unknown>).restoredAt = 1)],
    ["an unknown settings key", (doc) => ((doc.settings as unknown as Record<string, unknown>).theme = "dark")],
    ["an unknown record key", (doc) => ((doc.debts[0] as unknown as Record<string, unknown>).note = "x")],
    ["an expense moved between months", (doc) => {
      doc.expenses["2026-06"] = doc.expenses["2026-05"];
      delete doc.expenses["2026-05"];
    }],
    ["an emptied month left as an empty list", (doc) => (doc.expenses["2026-05"] = [])],
    ["a reorder with no field change", (doc) => doc.debts.reverse()],
    ["two creates in one list", (doc) => {
      doc.debts.push({ ...doc.debts[0], id: "00000000-0000-4000-8000-0000000000ab" });
      doc.debts.push({ ...doc.debts[0], id: "00000000-0000-4000-8000-0000000000ac" });
    }],
    ["a record id that is not a uuid", (doc) => doc.debts.push({ ...doc.debts[0], id: "debt-1" })],
    ["a malformed amount", (doc) => (doc.debts[0].amount = "1")],
    ["a lock that is not true", (doc) => ((doc.monthLocks as Record<string, unknown>)["2026-05"] = "yes")],
    ["a month value left as null", (doc) => ((doc.financeMonths as Record<string, unknown>)["2026-05"] = null)],
    ["a record listed twice", (doc) => doc.expenses["2026-05"].push(doc.expenses["2026-05"][0])],
  ];
  for (const [name, change] of cases) {
    it(`rejects ${name}, leaving the state and document untouched`, async () => {
      const r = await seeded();
      const [state, doc, ops] = [fingerprint(r.state), r.doc, r.ops.length];
      expect(() => r.amend(change)).toThrow(UnrepresentableChange);
      expect([fingerprint(r.state), r.doc, r.ops.length]).toEqual([state, doc, ops]);
    });
  }

  it("rejects a deleted id coming back", async () => {
    const r = await seeded();
    const debt = structuredClone(r.doc.debts[0]);
    await r.backend.deleteDebt((await r.backend.getDebts())[0].row);
    expect(() => r.amend((doc) => doc.debts.push(debt))).toThrow(/deleted id never comes back/);
  });

  it("reaches DocumentBackend as a 500, with the document untouched", async () => {
    const r = await seeded();
    const doc = r.doc;
    // A host whose commit sees a write that the diff can't represent.
    const commit = r.commit.bind(r);
    r.commit = (next) => commit({ ...next, categories: [] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(r.backend.addDebt({ name: "Card A", amount: 2 })).rejects.toEqual(new ApiError(500, "Internal server error"));
    expect(r.doc).toBe(doc);
  });

  it("is a pure function: the same inputs give the same op, and inputs are not changed", async () => {
    const r = await seeded();
    const next = structuredClone(r.doc);
    next.debts[0].amount = "7.00";
    const state = fingerprint(r.state);
    const a = diffDocuments(r.state, r.doc, next, { L: 9, device: A });
    const b = diffDocuments(r.state, r.doc, next, { L: 9, device: A });
    expect(a).toEqual(b);
    expect(fingerprint(r.state)).toBe(state);
  });
});
