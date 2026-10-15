import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerBackend } from "../LedgerBackend";
import type { LedgerDocument } from "../document/types";
import { ENTRY, device, edits, entry, world, type Device, type World } from "./cycleTestkit";
import type { SyncEngine } from "./SyncEngine";
import { docText } from "./testkit";

// DocumentBackend over SyncedHost keeps what it stores to itself (design
// section 3.5; the #5 contract): a write works on its own copy of the
// document and commits it whole or not at all, the values a call returns
// are the caller's own, and a write never changes a document current()
// handed out before it. Fictional data only.

const running: SyncEngine[] = [];
let w: World;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  w = await world();
});

afterEach(() => {
  for (const engine of running.splice(0)) engine.stop();
  vi.useRealTimers();
});

async function open(): Promise<Device> {
  const d = await device(w);
  running.push(d.engine);
  return d;
}

/** Changes everything reachable from `value` in place. */
function vandalise(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(vandalise);
    value.push("junk");
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      vandalise((value as Record<string, unknown>)[key]);
      (value as Record<string, unknown>)[key] = "junk";
    }
  }
}

const EMI = { cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: 9.5, foreclosureCharge: null };
const SUB = { service: "Music", amount: 199, duration: "Monthly" as const, expiryAnchor: "2026-05-20", cardOrBank: "Card A" };

/** Every kind of write, and the reads of what they wrote, keeping each
 * result. `seen` is called with current() before each write. */
async function everyCall(b: LedgerBackend, seen: () => void): Promise<unknown[]> {
  const results: unknown[] = [];
  const write = async <T>(call: () => Promise<T>): Promise<T> => {
    seen();
    const value = await call();
    results.push(value);
    return value;
  };
  const one = await write(() => b.addEntry(entry("One")));
  const two = await write(() => b.addEntry(entry("Two", 20)));
  await write(() => b.addEntry({ ...ENTRY, month: 6, remarks: "June" }));
  await write(() => b.updateEntry(2026, 5, one.row, edits("One, edited", 12)));
  await write(() => b.moveEntry(2026, 5, two.row, one.row));
  await write(() => b.deleteEntry(2026, 5, two.row));
  await write(() => b.setMonthLock(2026, 4, true));
  await write(() => b.setMonthIncome(2026, 5, { salary: 50000, otherIncome: 100, savings: [{ name: "Fund A", amount: 2000 }] }));
  await write(() => b.setMonthBills(2026, 5, [{ name: "Card A", due: 900, paid: 0, dueDate: "2026-06-25", settled: false }]));
  const debt = await write(() => b.addDebt({ name: "Sam", amount: 500 }));
  await write(() => b.updateDebt(debt.row, { name: "Sam", amount: 400 }));
  const emi = await write(() => b.addEmi(EMI));
  await write(() => b.updateEmi(emi.row, { ...EMI, remarks: "Fixed rate" }));
  await write(() => b.payEmi(emi.row, 1000));
  const sub = await write(() => b.addSubscription(SUB));
  await write(() => b.updateSubscription(sub.row, { ...SUB, amount: 249 }));
  const gone = await write(() => b.addDebt({ name: "Alex", amount: 50 }));
  await write(() => b.deleteDebt(gone.row));
  const emi2 = await write(() => b.addEmi({ ...EMI, cardOrBank: "Card B" }));
  await write(() => b.deleteEmi(emi2.row));
  const sub2 = await write(() => b.addSubscription({ ...SUB, service: "Video" }));
  await write(() => b.deleteSubscription(sub2.row));
  results.push(
    await b.getMonth(2026, 5),
    await b.getMonthLock(2026, 4),
    await b.getYearSummary(2026),
    await b.getMonthIncome(2026, 5),
    await b.getFinanceSummary(2026),
    await b.getDebts(),
    await b.getMonthBills(2026, 5),
    await b.getCreditCardBillsSummary(2026),
    await b.getEmis(),
    await b.getEmiMonthlyProjection(12),
    await b.getSubscriptions(),
    await b.getCategories(),
    await b.getConfig(),
    await b.getOverview(),
  );
  return results;
}

describe("DocumentBackend over SyncedHost: what it stores stays its own", () => {
  it("returns values the caller owns: changing them changes nothing stored or read later", async () => {
    const d = await open();
    const results = await everyCall(d.backend, () => {});
    const text = docText(d.engine.current());
    const again = JSON.stringify(await everyRead(d.backend));
    results.forEach(vandalise);
    expect(docText(d.engine.current())).toBe(text);
    expect(JSON.stringify(await everyRead(d.backend))).toBe(again);
  });

  it("never changes a document current() handed out before a write", async () => {
    const d = await open();
    const handedOut: [LedgerDocument, string][] = [];
    await everyCall(d.backend, () => {
      const doc = d.engine.current();
      handedOut.push([doc, JSON.stringify(doc)]);
    });
    expect(handedOut).toHaveLength(22);
    for (const [doc, text] of handedOut) expect(JSON.stringify(doc)).toBe(text);
  });

  it("commits a write whole or not at all: one the device can't save leaves the document as it was", async () => {
    const d = await open();
    await everyCall(d.backend, () => {});
    const before = d.engine.current();
    const text = JSON.stringify(before);
    d.store.failNext = 1;
    await expect(d.backend.addEntry(entry("Never saved"))).rejects.toMatchObject({ status: 500 });
    expect(d.engine.current()).toBe(before);
    expect(JSON.stringify(before)).toBe(text);
    // Refused by the store's checks: the same.
    const [first] = await d.backend.getMonth(2026, 5);
    await expect(d.backend.moveEntry(2026, 5, first.row, 999_999)).rejects.toMatchObject({ status: 400 });
    await expect(d.backend.addEntry({ ...ENTRY, month: 4, remarks: "Locked month" })).rejects.toMatchObject({ status: 403 });
    expect(d.engine.current()).toBe(before);
    expect(JSON.stringify(before)).toBe(text);
    // And the next write goes through.
    await d.backend.addEntry(entry("Saved"));
    expect(d.engine.current().expenses["2026-05"].map((e) => e.remarks)).toContain("Saved");
  });
});

/** The reads, for comparing before and after. */
async function everyRead(b: LedgerBackend): Promise<unknown[]> {
  return [
    await b.getMonth(2026, 5),
    await b.getMonth(2026, 6),
    await b.getYearSummary(2026),
    await b.getMonthIncome(2026, 5),
    await b.getDebts(),
    await b.getMonthBills(2026, 5),
    await b.getEmis(),
    await b.getSubscriptions(),
    await b.getOverview(),
  ];
}
