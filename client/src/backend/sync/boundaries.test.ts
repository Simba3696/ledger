import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../ApiError";
import type { LedgerBackend } from "../LedgerBackend";
import { EPOCH, cycle, device, entry, expectConverged, logFile, plant, quiesce, remarks, world, type Device, type DeviceOptions, type World } from "./cycleTestkit";
import { findLedger, openGenesis } from "./ledgerRepo";
import type { SyncEngine } from "./SyncEngine";
import { MAX_L } from "./tags";
import { Replica, deviceId, docText } from "./testkit";

// Stage 8a boundary hardening (issue #7's "Stage 1 merged" comment and the
// stage 6 notes): each class the earlier stages tracked, tested at its
// boundary through real engines over the fake GitHub. A clean refusal (a
// 400 or 409 with a message) is fine; a crash, a 500 or a permanent block
// is not. Fictional data only.

const running: SyncEngine[] = [];
let w: World;
const X = deviceId(0xc);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  w = await world();
});

afterEach(() => {
  for (const engine of running.splice(0)) engine.stop();
  vi.useRealTimers();
});

async function open(options: DeviceOptions = {}): Promise<Device> {
  const d = await device(w, options);
  running.push(d.engine);
  return d;
}

/** After a restore: cleared and reloaded, joining the winning epoch. */
async function rejoin(d: Device): Promise<Device> {
  d.engine.stop();
  const found = await findLedger({ client: d.client, branch: "main" });
  if (found.kind !== "ledger") throw new Error(`no ledger: ${found.kind}`);
  const opened = await openGenesis(found, w.key);
  if (!opened.ok) throw new Error(opened.problem);
  return open({ login: d.login, init: { epoch: opened.epoch, state: opened.state } });
}

/** A valid log from X whose one op is a "Planted" entry at `L`. */
async function plantAt(L: number): Promise<void> {
  const r = new Replica(X, w.doc, { actor: "sam" });
  await r.backend.addEntry(entry("Planted"));
  await plant(w, { kind: "log", epoch: EPOCH, device: X }, logFile(X, [{ ...r.ops[0], L }]));
}

/** Every one of the 14 reads, each answered (a refusal of a bad argument
 * is an answer; a 500 is not). */
async function everyRead(b: LedgerBackend, year: number, month: number): Promise<void> {
  const reads: [string, () => Promise<unknown>][] = [
    ["getConfig", () => b.getConfig()],
    ["getCategories", () => b.getCategories()],
    ["getMonth", () => b.getMonth(year, month)],
    ["getMonthLock", () => b.getMonthLock(year, month)],
    ["getYearSummary", () => b.getYearSummary(year)],
    ["getMonthIncome", () => b.getMonthIncome(year, month)],
    ["getFinanceSummary", () => b.getFinanceSummary(year)],
    ["getDebts", () => b.getDebts()],
    ["getMonthBills", () => b.getMonthBills(year, month)],
    ["getCreditCardBillsSummary", () => b.getCreditCardBillsSummary(year)],
    ["getEmis", () => b.getEmis()],
    ["getEmiMonthlyProjection", () => b.getEmiMonthlyProjection("auto")],
    ["getSubscriptions", () => b.getSubscriptions()],
    ["getOverview", () => b.getOverview()],
  ];
  for (const [name, read] of reads) {
    await read().catch((err: unknown) => {
      if (!(err instanceof ApiError) || err.status >= 500) throw new Error(`${name} failed: ${String(err)}`, { cause: err });
    });
  }
}

describe("Lamport values at the top of the range (2^50 - 1)", () => {
  it("two devices that both run out at once each start a next epoch: the greater wins, and the other's write is offered on its own device", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await plantAt(MAX_L - 1);
    await cycle(w, a, b);
    // Neither has seen the other's next epoch: both write one.
    await Promise.all([a.backend.addEntry(entry("Rent")), b.backend.addEntry(entry("Taxi"))]);
    const epochs = [a.engine.epochKey!, b.engine.epochKey!];
    expect(epochs.every((e) => e.startsWith("e000002-"))).toBe(true);
    expect(epochs[0]).not.toBe(epochs[1]);
    await quiesce(w, a, b);
    expect(a.engine.epochKey).toBe(b.engine.epochKey);
    const loser = epochs[0] > epochs[1] ? b : a;
    const lost = loser === a ? "Rent" : "Taxi";
    expect(remarks(loser)).not.toContain(lost);
    const [group] = loser.engine.leftBehind();
    expect(group).toMatchObject({ own: true, items: [{ kind: "add", record: { remarks: lost } }] });
    await loser.engine.reapply(group.id);
    await quiesce(w, a, b);
    for (const d of [a, b]) expect(remarks(d).sort()).toEqual(["Planted", "Rent", "Taxi"]);
    expectConverged(a, b);
    expect(w.fake.violations).toEqual([]);
  });

  it("a cloned profile writing the last L there is: the fork rehomes, re-issuing at that L, and the next write starts a next epoch", async () => {
    const a = await open({ login: "alex" });
    await plantAt(MAX_L - 2);
    await cycle(w, a);
    const twin = await open({ login: "alex", store: a.store.clone() });
    expect(twin.engine.deviceId).toBe(a.engine.deviceId);
    await a.backend.addEntry(entry("Rent")); // L = 2^50 - 1
    await cycle(w, a);
    await twin.backend.addEntry(entry("Taxi")); // the same L, other content
    await quiesce(w, a, twin);
    expect(twin.engine.deviceId).not.toBe(a.engine.deviceId);
    for (const d of [a, twin]) expect(remarks(d).sort()).toEqual(["Planted", "Rent", "Taxi"]);
    // No L is left: the next write on either starts a next epoch.
    await twin.backend.addEntry(entry("Bus"));
    expect(twin.engine.epochKey).toMatch(/^e000002-/);
    await quiesce(w, a, twin);
    for (const d of [a, twin]) expect(remarks(d).sort()).toEqual(["Bus", "Planted", "Rent", "Taxi"]);
    for (const d of [a, twin]) expect(d.engine.leftBehind()).toEqual([]);
    expectConverged(a, twin);
  });

  it("a device that compacts at the top of the range: its snapshot is published and read by a fresh device", async () => {
    const a = await open({ login: "alex", compaction: { logOps: 1 } });
    await plantAt(MAX_L - 3);
    await cycle(w, a);
    await a.backend.addEntry(entry("Rent")); // MAX_L - 2
    await quiesce(w, a);
    expect(w.fake.commits.some((c) => c.message.startsWith("Snapshot"))).toBe(true);
    const fresh = await open({ login: "sam" });
    await quiesce(w, a, fresh);
    expect(remarks(fresh).sort()).toEqual(["Planted", "Rent"]);
    expectConverged(a, fresh);
  });
});

describe("dates at the ends of the calendar (0001 and 9999)", () => {
  /** A remote log holding every kind of date at `day`, in month `month`. */
  async function plantDates(day: string, year: number, month: number): Promise<void> {
    const r = new Replica(X, w.doc, { actor: "sam", clock: Date.parse(`${day}T12:00:00Z`) });
    await r.backend.addEntry({ year, month, amount: 5, remarks: "Edge", category: "food", isCard: true });
    await r.backend.setMonthLock(year, month, true);
    await r.backend.setMonthIncome(year, month, { salary: 100, otherIncome: null, savings: [{ name: "Fund A", amount: 5 }] });
    await r.backend.setMonthBills(year, month, [{ name: "Card A", due: 10, paid: 0, dueDate: day, settled: false }]);
    await r.backend.addSubscription({ service: "Music", amount: 199, duration: "Yearly", expiryAnchor: day, cardOrBank: "Card A" });
    // An EMI whose term ends on the last day there is (or starts on the first).
    if (year === 9999) r.clock = Date.parse("9999-01-31T12:00:00Z");
    await r.backend.addEmi({ cardOrBank: "Car Loan", emiAmount: 100, dueDay: 31, totalAmount: 1200, remarks: "", remainingAsOf: 900, interestRate: 9.5, foreclosureCharge: null, durationMonths: year === 9999 ? 11 : 12 });
    await r.backend.addDebt({ name: "Sam", amount: 50 });
    expect(r.ops.length).toBe(7);
    await plant(w, { kind: "log", epoch: EPOCH, device: X }, logFile(X, r.ops));
  }

  for (const [day, year, month] of [["9999-12-31", 9999, 12], ["0001-01-01", 2026, 5]] as const) {
    it(`records dated ${day}: every read answers, on a device whose clock is now and one whose clock is ${day}, and writes go on`, async () => {
      await plantDates(day, year, month);
      const now = await open({ login: "alex" });
      const late = await open({ login: "sam", now: () => Date.parse(`${day}T23:59:59Z`) });
      await cycle(w, now, late);
      for (const d of [now, late]) {
        expect(d.engine.getState().status).toBe("idle");
        await everyRead(d.backend, year, month);
        await everyRead(d.backend, 2026, 5);
      }
      // Writes on each kind still answer: a payment past year 9999 is a 400.
      for (const d of [now, late]) {
        const [emi] = (await d.backend.getEmis()).filter((e) => e.cardOrBank === "Car Loan");
        await d.backend.payEmi(emi.row, 100).catch((err: unknown) => expect(err).toMatchObject({ status: 400 }));
        const [sub] = await d.backend.getSubscriptions();
        await expect(d.backend.updateSubscription(sub.row, { service: "Music", amount: 299, duration: "Yearly", expiryAnchor: day, cardOrBank: "Card A" })).resolves.toBeDefined();
        await expect(d.backend.setMonthLock(year, month, false)).resolves.toBeDefined();
      }
      await quiesce(w, now, late);
      expectConverged(now, late);
      for (const d of [now, late]) expect(d.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    });
  }
});

describe("an EMI term that would end past 9999-12-31", () => {
  it("adding or editing an EMI with a duration on a device whose clock is late in 9999 is refused with a 400, and nothing is written", async () => {
    const a = await open({ login: "alex", now: () => Date.parse("9999-12-31T12:00:00Z") });
    const emi = { cardOrBank: "Car Loan", emiAmount: 100, dueDay: 31, totalAmount: 1200, remarks: "", remainingAsOf: 900, interestRate: 9.5, foreclosureCharge: null };
    const before = docText(a.engine.current());
    await expect(a.backend.addEmi({ ...emi, durationMonths: 12 })).rejects.toMatchObject({ status: 400 });
    expect(docText(a.engine.current())).toBe(before);
    expect(a.engine.getState()).toMatchObject({ pendingCount: 0, deviceSaveFailed: false });
    // Without a duration it is added; an edit that sets one is refused too.
    const [added] = [await a.backend.addEmi({ ...emi, durationMonths: null })];
    await expect(a.backend.updateEmi(added.row, { ...emi, durationMonths: 3 })).rejects.toMatchObject({ status: 400 });
    expect(a.engine.current().emis.map((e) => e.untilTarget)).toEqual([null]);
    await quiesce(w, a);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
  });
});

describe("sort keys and order keys at their limits", () => {
  it("an expense keyed with a 100,000-character run of z, from another device: appends, moves, snapshots and a cold start all work", async () => {
    const r = new Replica(X, w.doc, { actor: "sam" });
    await r.backend.addEntry(entry("Long"));
    const op = r.ops[0];
    const key = "z".repeat(27) + "z".repeat(100_000);
    const set = op.set.map(([k, v]): [string, unknown] => (k.endsWith("/sortKey") ? [k, key] : [k, v]));
    await plant(w, { kind: "log", epoch: EPOCH, device: X }, logFile(X, [{ ...op, set }]));
    const a = await open({ login: "alex", compaction: { logOps: 2 } });
    await a.backend.addEntry(entry("After"));
    await a.backend.addEntry(entry("Before"));
    const rows = await a.backend.getMonth(2026, 5);
    expect(rows.map((e) => e.remarks)).toEqual(["Long", "After", "Before"]);
    await a.backend.moveEntry(2026, 5, rows[2].row, rows[0].row);
    await a.backend.moveEntry(2026, 5, rows[0].row, rows[2].row);
    await quiesce(w, a);
    expect(w.fake.commits.some((c) => c.message.startsWith("Snapshot"))).toBe(true);
    const fresh = await open({ login: "sam" });
    await quiesce(w, a, fresh);
    expectConverged(a, fresh);
    expect(remarks(fresh)).toEqual(remarks(a));
  });

  it("a list record created at the last L: its order key names 2^50 - 1, and later adds still list after it", async () => {
    const r = new Replica(X, w.doc, { actor: "sam" });
    r.state.maxL = MAX_L - 2;
    await r.backend.addDebt({ name: "Top", amount: 5 });
    expect(r.ops[0].L).toBe(MAX_L - 1);
    await plant(w, { kind: "log", epoch: EPOCH, device: X }, logFile(X, r.ops));
    const a = await open({ login: "alex" });
    await a.backend.addDebt({ name: "Next", amount: 6 }); // a next epoch
    await a.backend.addDebt({ name: "Last", amount: 7 });
    expect((await a.backend.getDebts()).map((d) => d.name)).toEqual(["Top", "Next", "Last"]);
    const b = await open({ login: "sam" });
    await quiesce(w, a, b);
    expectConverged(a, b);
  });
});

describe("rehome re-issue at scale", () => {
  it("a cloned profile that wrote 1,500 changes the repo never saw re-issues them all under its new id, and every device gets them", async () => {
    const a = await open({ login: "alex" });
    const twin = await open({ login: "alex", store: a.store.clone() });
    await a.backend.addEntry(entry("First"));
    await cycle(w, a);
    // The twin, offline, writes 1,500 month locks: one op each.
    for (let i = 0; i < 1500; i++) await twin.backend.setMonthLock(2030 + Math.floor(i / 12), (i % 12) + 1, true);
    await quiesce(w, a, twin);
    expect(twin.engine.deviceId).not.toBe(a.engine.deviceId);
    expectConverged(a, twin);
    expect(Object.keys(a.engine.current().monthLocks)).toHaveLength(1500);
    expect(remarks(a)).toEqual(["First"]);
    // The new id's files hold them all (its log, or its snapshot once it
    // compacted).
    const fresh = await open({ login: "sam" });
    await quiesce(w, a, twin, fresh);
    expect(Object.keys(fresh.engine.current().monthLocks)).toHaveLength(1500);
  }, 120_000);
});

describe("rare legitimate flows: re-apply after a restore, and rehome after a fork", () => {
  it("both instances of a cloned profile re-apply the same left-behind group: the fork rehomes, nothing doubles, and every device converges", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a, b);
    const backup = structuredClone(a.engine.current());
    await b.backend.addDebt({ name: "Sam", amount: 5 }); // never pushed
    expect((await a.engine.restore(backup)).kind).toBe("restored");
    const a2 = await rejoin(a);
    await cycle(w, b);
    const [group] = b.engine.leftBehind();
    expect(group).toMatchObject({ own: true });
    const twin = await open({ login: "sam", store: b.store.clone() });
    expect(twin.engine.leftBehind().map((g) => g.id)).toEqual([group.id]);
    // The twin makes one change of its own first, so the two histories
    // differ (identical histories are not a fork), then both re-apply.
    await twin.backend.addEntry(entry("Tea"));
    await b.engine.reapply(group.id);
    await twin.engine.reapply(group.id);
    await quiesce(w, a2, b, twin);
    expect(twin.engine.deviceId).not.toBe(b.engine.deviceId);
    for (const d of [a2, b, twin]) {
      expect(d.engine.current().debts.map((x) => x.name)).toEqual(["Sam"]);
      expect(remarks(d)).toEqual(["Groceries", "Tea"]);
      expect(d.engine.leftBehind()).toEqual([]);
    }
    expectConverged(a2, b, twin);
    expect(docText(a2.engine.current())).toBe(docText(b.engine.current()));
  });
});
