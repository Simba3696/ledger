import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../ApiError";
import { DocumentBackend } from "../document/DocumentBackend";
import { isWritableDocument } from "../document/validate";
import { CHAIN_START, chainNext, opHash, opProblem } from "./codec";
import { FakeLocks, deferred, dumpDatabase, faultyIndexedDB, hookedStore, tamper, testKey } from "./localTestkit";
import { clearSyncState, openSyncStore, type SyncStore } from "./persist";
import { decodeDelta, seal, unseal, type DeviceKey } from "./records";
import { genesisState } from "./state";
import { DEVICE_SAVE_FAILED, OTHER_TAB, SyncEngine, defaultSyncLog, type EngineState, type SyncEngineOptions } from "./SyncEngine";
import { SyncedHost } from "./SyncedHost";
import { Replica, deviceId, docText, emptyDocument } from "./testkit";

// The engine's local half against fake-indexeddb (design sections 3.5, 10.1,
// 10.2 and 12): a write resolves only after its transaction committed, and
// only then is it shown and pushable; a failed transaction (a full quota, an
// abort) refuses the write and changes nothing (owner decision 5); a reload
// at either side of the transaction loses nothing that resolved; saved state
// this build can't read is never treated as empty or written over; and only
// one tab writes. Fictional data only.

const EPOCH = "e000001-0000000a";
const X = deviceId(0xb);
const ENTRY = { year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false };
const noWait = { sleep: async () => {} };
let key: DeviceKey;
let factory: IDBFactory;

beforeAll(async () => {
  key = await testKey();
});

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.stubGlobal("indexedDB", factory);
  await clearSyncState();
  vi.unstubAllGlobals();
});

interface Device {
  engine: SyncEngine;
  backend: DocumentBackend;
  host: SyncedHost;
}

/** An engine as the app runs one: started (and on a first start
 * initialised from the genesis), with a DocumentBackend over SyncedHost. */
async function device(options: Partial<SyncEngineOptions> & { store?: SyncStore } = {}): Promise<Device> {
  const engine = new SyncEngine({ key, actor: "alex", locks: null, log: () => {}, store: openSyncStore(noWait), ...options });
  await engine.start();
  if (engine.getState().needsInit) await engine.initialize(EPOCH, genesisState(emptyDocument()));
  const host = new SyncedHost(engine);
  const backend = new DocumentBackend({ host, now: () => Date.UTC(2026, 4, 10), actor: "alex", newId: () => crypto.randomUUID() });
  return { engine, backend, host };
}

/** "Reload": stop this tab's engine and start another on the same device. */
async function reload(d: Device, options: Partial<SyncEngineOptions> = {}): Promise<Device> {
  d.engine.stop();
  return device(options);
}

/** What the device has saved, read back from IndexedDB and decrypted. */
async function saved() {
  const records = (await openSyncStore(noWait).load())!;
  const ownLog = await Promise.all(records.ownLog.map(async ([, text]) => decodeDelta(await unseal(text, key))));
  return {
    records,
    meta: records.meta as Record<string, unknown>,
    ownOps: ownLog.map((delta) => (typeof delta === "string" ? delta : delta.ops[0][1])),
    chainHead: records.chainHead ? await unseal(records.chainHead[1], key) : null,
  };
}

/** A store that, while `held.on`, stops each mutation `where` ("before"
 * the transaction starts, or "after" it committed) until released. */
function holdingStore(where: "before" | "after") {
  const held = { on: false, reached: deferred(), release: deferred() };
  const hold = () => {
    if (!held.on) return Promise.resolve();
    held.reached.resolve();
    return held.release.promise;
  };
  return { ...hookedStore(openSyncStore(noWait), { [where]: hold }), held };
}

/** Resolves once `engine`'s state satisfies `predicate`. */
function until(engine: SyncEngine, predicate: (state: EngineState) => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (predicate(engine.getState())) return resolve();
    const stop = engine.subscribe(() => {
      if (!predicate(engine.getState())) return;
      stop();
      resolve();
    });
  });
}

const remarks = (d: Device) => (d.engine.current().expenses["2026-05"] ?? []).map((e) => e.remarks);


describe("writing", () => {
  it("is true from a write's submission until it has settled, so a reload can't cut it off", async () => {
    let gate = deferred();
    let holding = false;
    const { store } = hookedStore(openSyncStore(noWait), { before: async () => (holding ? gate.promise : undefined) });
    const d = await device({ store });
    expect(d.engine.writing).toBe(false);

    // Begun, waiting for its turn: nothing diffed or saved yet.
    const turn = d.engine.beginWrite();
    expect(d.engine.writing).toBe(true);
    turn.end();
    turn.end();
    expect(d.engine.writing).toBe(false);

    // Diffed and being saved on the device.
    holding = true;
    const adding = d.backend.addEntry(ENTRY);
    expect(d.engine.writing).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(d.engine.writing).toBe(true);
    gate.resolve();
    await adding;
    expect(d.engine.writing).toBe(false);

    // A direct commit (no turn) counts too while it saves.
    gate = deferred();
    const next = structuredClone(d.engine.current());
    next.settings.timeZone = "Europe/London";
    const committing = d.engine.commit(next);
    expect(d.engine.writing).toBe(true);
    gate.resolve();
    await committing;
    expect(d.engine.writing).toBe(false);
    d.engine.stop();
  });
});

describe("commit path (section 3.5)", () => {
  it("resolves a write only after its transaction commits; until then nothing is shown or pushable", async () => {
    const { store, calls, held } = holdingStore("before");
    const d = await device({ store });
    held.on = true;
    let resolved = false;
    const write = d.backend.addEntry(ENTRY).then(() => (resolved = true));
    await held.reached.promise;
    expect(calls.started - calls.committed).toBe(1);
    expect(resolved).toBe(false);
    expect(remarks(d)).toEqual([]);
    expect(d.engine.pushableOps()).toEqual([]);

    held.release.resolve();
    await write;
    expect(remarks(d)).toEqual(["Groceries"]);
    const [op] = d.engine.pushableOps();
    expect(op).toMatchObject({ L: 2, by: "alex" });
    expect(opProblem(op)).toBeNull();
    expect(d.engine.getState()).toMatchObject({ pendingCount: 1, deviceSaveFailed: false, revision: 0 });
  });

  it("persists each op to ownLog, tail, meta and the chain in one transaction, and a reload loads all of it back", async () => {
    const one = await device();
    const a = await one.backend.addEntry(ENTRY);
    await one.backend.addEntry({ ...ENTRY, remarks: "Rent" });
    await one.backend.updateEntry(2026, 5, a.row, { ...ENTRY, amount: 12 });
    await one.backend.setMonthLock(2026, 5, true);
    const ops = one.engine.pushableOps();
    const doc = docText(one.engine.current());

    const { meta, ownOps, chainHead, records } = await saved();
    expect(ownOps).toEqual(ops);
    expect(records.tail).toHaveLength(ops.length);
    expect(meta).toMatchObject({ deviceId: one.engine.deviceId, epochKey: EPOCH, ownMaxL: ops.at(-1)!.L, maxL: ops.at(-1)!.L });
    let chain = CHAIN_START;
    for (const op of ops) chain = await chainNext(chain, await opHash(op));
    expect(chainHead).toBe(chain);

    const two = await reload(one);
    expect(two.engine.deviceId).toBe(one.engine.deviceId);
    expect(docText(two.engine.current())).toBe(doc);
    expect(two.engine.pushableOps()).toEqual(ops);
    // L continues above everything persisted.
    await two.backend.setMonthLock(2026, 5, false);
    expect(two.engine.pushableOps().at(-1)!.L).toBe(ops.at(-1)!.L + 1);
  });

  it("makes no transaction for a no-op save or a stamp-only change", async () => {
    const { store, calls } = hookedStore(openSyncStore(noWait));
    const d = await device({ store });
    const a = await d.backend.addEntry(ENTRY);
    const before = calls.started;
    await d.backend.updateEntry(2026, 5, a.row, ENTRY);
    await d.host.amend((doc) => {
      doc.expenses["2026-05"][0].updatedAt += 1000;
    });
    expect(calls.started).toBe(before);
    expect(d.engine.pushableOps()).toHaveLength(1);
  });

  it("fails closed: a change no op can represent rejects with a 500 and saves nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, calls } = hookedStore(openSyncStore(noWait));
    const d = await device({ store });
    const before = calls.started;
    await expect(
      d.host.amend((doc) => {
        doc.categories = [];
      }),
    ).rejects.toThrow(/categories/);
    expect(calls.started).toBe(before);
  });

  it("a first start saves the genesis once: a second initialize, even one queued behind the first, is refused", async () => {
    const engine = new SyncEngine({ key, actor: "alex", locks: null, log: () => {}, store: openSyncStore(noWait) });
    await engine.start();
    expect(engine.getState()).toMatchObject({ needsInit: true, hasDocument: false });
    const genesis = genesisState(emptyDocument());
    const [first, second] = await Promise.allSettled([engine.initialize(EPOCH, genesis), engine.initialize(EPOCH, genesis)]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    await expect(engine.initialize(EPOCH, genesis)).rejects.toThrow(/not empty/);
    expect(engine.getState()).toMatchObject({ needsInit: false, hasDocument: true, status: "idle" });
  });

  it("amend() commits a direct edit as one op", async () => {
    const d = await device();
    await d.host.amend((doc) => {
      doc.monthLocks["2026-05"] = true;
    });
    expect(d.engine.pushableOps().map((op) => op.set)).toEqual([[["lk/2026-05", true]]]);
    expect(d.engine.current().monthLocks).toEqual({ "2026-05": true });
  });

  describe("amend() and a DocumentBackend write to one whole-unit register, submitted while the other saves, end as if made one after the other", () => {
    let row = 0;
    const cases = [
      {
        unit: "a month's income (fm)",
        setup: async (d: Device) => {
          await d.backend.setMonthIncome(2026, 5, { salary: 1000, otherIncome: null, savings: [] });
        },
        write: (d: Device) => d.backend.setMonthIncome(2026, 5, { salary: 2000, otherIncome: null, savings: [] }),
        amend: (d: Device) =>
          d.host.amend((doc) => {
            doc.financeMonths["2026-05"].otherIncome = "50.00";
          }),
        pick: (d: Device) => d.engine.current().financeMonths["2026-05"],
      },
      {
        unit: "a month's card bills (cb)",
        setup: async (d: Device) => {
          await d.backend.setMonthBills(2026, 5, [{ name: "Card A", due: 900, paid: 0, dueDate: "2026-05-25", settled: false }]);
        },
        write: (d: Device) => d.backend.setMonthBills(2026, 5, [{ name: "Card A", due: 950, paid: 0, dueDate: "2026-05-25", settled: false }]),
        amend: (d: Device) =>
          d.host.amend((doc) => {
            doc.cardBills["2026-05"][0].settled = true;
          }),
        pick: (d: Device) => d.engine.current().cardBills["2026-05"].map(({ name, due, settled }) => ({ name, due, settled })),
      },
      {
        unit: "an EMI's balance pair",
        setup: async (d: Device) => {
          row = (await d.backend.addEmi({ cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: 9.5, foreclosureCharge: null })).row;
        },
        write: (d: Device) => d.backend.payEmi(row, 1000),
        amend: (d: Device) =>
          d.host.amend((doc) => {
            doc.emis[0].remainingAsOf = "7000.00";
          }),
        pick: (d: Device) => d.engine.current().emis.map(({ remainingAsOf, asOfDate }) => ({ remainingAsOf, asOfDate })),
      },
    ];

    for (const { unit, setup, write, amend, pick } of cases) {
      for (const order of ["write first", "amend first"] as const) {
        it(`${unit}, ${order}`, async () => {
          const [one, two] = order === "write first" ? [write, amend] : [amend, write];

          // The same two writes, one after the other, on a device of its own.
          vi.stubGlobal("indexedDB", new IDBFactory());
          const reference = await device();
          await setup(reference);
          await one(reference);
          await two(reference);
          const expected = pick(reference);
          reference.engine.stop();
          vi.stubGlobal("indexedDB", factory);

          const { store, held } = holdingStore("before");
          const d = await device({ store });
          await setup(d);
          expect(pick(d)).not.toEqual(expected);
          held.on = true;
          const first = one(d);
          await held.reached.promise;
          held.on = false;
          // Submitted while the first one's transaction is still open.
          const second = two(d);
          held.release.resolve();
          await Promise.all([first, second]);

          expect(pick(d)).toEqual(expected);
          const Ls = d.engine.pushableOps().map((op) => op.L);
          expect(Ls).toEqual([...Ls].sort((a, b) => a - b));
          expect(pick(await reload(d))).toEqual(expected);
        });
      }
    }
  });

  it("amend() runs at its turn, on what earlier writes committed, and one that its run refuses still ends its turn", async () => {
    const d = await device();
    const write = d.backend.addEntry(ENTRY);
    let seen: string[] = [];
    await d.host.amend((doc) => {
      seen = doc.expenses["2026-05"].map((e) => e.remarks);
      doc.monthLocks["2026-05"] = true;
    });
    await write;
    expect(seen).toEqual(["Groceries"]);
    await expect(d.host.amend(() => {
      throw new Error("refused by run");
    })).rejects.toThrow("refused by run");
    // A refused amend ends its turn: later writes still run.
    await d.backend.setMonthLock(2026, 5, false);
    expect(d.engine.current().monthLocks["2026-05"]).toBeUndefined();
  });

  it("builds current() from the state, so a remote join that commits while a write is in flight is kept", async () => {
    const { store, held } = holdingStore("before");
    const d = await device({ store });
    const sam = new Replica(X, emptyDocument(), { actor: "sam" });
    await sam.backend.addEntry({ ...ENTRY, remarks: "Sam's lunch" });

    held.on = true;
    const mine = d.backend.addEntry(ENTRY);
    await held.reached.promise;
    held.on = false;
    const theirs = d.engine.join({ ops: [[X, sam.ops[0]]] });
    held.release.resolve();
    await Promise.all([mine, theirs]);
    expect(remarks(d).sort()).toEqual(["Groceries", "Sam's lunch"]);
    expect(isWritableDocument(d.engine.current())).toBe(true);
    // The remote change bumped the revision; the own write didn't.
    expect(d.engine.getState().revision).toBe(1);
  });

  it("tells the device whose edit a delete joined after its diff, and before its save, removed (harness seed 140353)", async () => {
    // The write is diffed while a join of Sam's delete waits in the
    // mutation queue, so it is saved after that join: the same clash as
    // when the delete arrives after the save, and told the same way
    // (section 4.2 rule 2), never silently lost.
    const { store, held } = holdingStore("before");
    const d = await device({ store });
    const sam = new Replica(X, emptyDocument(), { actor: "sam" });
    await sam.backend.addEntry(ENTRY);
    await d.engine.join({ ops: [[X, sam.ops[0]]] });
    const [groceries] = await d.backend.getMonth(2026, 5);
    await sam.backend.deleteEntry(2026, 5, (await sam.backend.getMonth(2026, 5))[0].row);

    held.on = true;
    const theirs = d.engine.join({ ops: [[X, sam.ops[1]]] });
    await held.reached.promise;
    held.on = false;
    const mine = d.backend.updateEntry(2026, 5, groceries.row, { ...ENTRY, amount: 45 });
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => (globalThis as unknown as { setImmediate(fn: () => void): void }).setImmediate(resolve));
    held.release.resolve();
    await Promise.all([mine, theirs]);

    expect(remarks(d)).toEqual([]);
    expect(d.engine.notices().map((v) => v.notice)).toEqual([expect.objectContaining({ kind: "deleted", winner: expect.objectContaining({ device: X }), target: expect.objectContaining({ coll: "e", month: "2026-05", name: "Groceries" }) })]);
  });

  it("tells a delete once when the join between a newer write's diff and its save already told it for an older edit of the same record (#14)", async () => {
    // Alex's older edit (45) is saved; Sam deletes Groceries without having
    // seen it; the join of that delete waits in the mutation queue while
    // Alex's newer edit (50) is diffed, so the join tells the delete against
    // the older edit and the save tells it again against the newer one.
    // Joined after the save, the delete is told once, naming the newer
    // edit: so it must be here (one clash, one notice).
    const { store, held } = holdingStore("before");
    const d = await device({ store });
    const sam = new Replica(X, emptyDocument(), { actor: "sam" });
    await sam.backend.addEntry(ENTRY);
    await d.engine.join({ ops: [[X, sam.ops[0]]] });
    const [groceries] = await d.backend.getMonth(2026, 5);
    await d.backend.updateEntry(2026, 5, groceries.row, { ...ENTRY, amount: 45 });
    await sam.backend.deleteEntry(2026, 5, (await sam.backend.getMonth(2026, 5))[0].row);

    held.on = true;
    const theirs = d.engine.join({ ops: [[X, sam.ops[1]]] });
    await held.reached.promise;
    held.on = false;
    const mine = d.backend.updateEntry(2026, 5, groceries.row, { ...ENTRY, amount: 50 });
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => (globalThis as unknown as { setImmediate(fn: () => void): void }).setImmediate(resolve));
    held.release.resolve();
    await Promise.all([mine, theirs]);

    const newer = d.engine.pushableOps().at(-1)!;
    expect(remarks(d)).toEqual([]);
    expect(d.engine.notices().map((v) => v.notice)).toEqual([expect.objectContaining({ kind: "deleted", winner: expect.objectContaining({ device: X }), loser: { L: newer.L, device: d.engine.deviceId } })]);
    // And so it stays after a reload.
    const two = await reload(d);
    expect(two.engine.notices().map((v) => v.notice)).toEqual([expect.objectContaining({ kind: "deleted", loser: { L: newer.L, device: two.engine.deviceId } })]);
  });

  it("tells an overwrite once, with the newer value as mine, when the join between a newer write's diff and its save already told it for an older edit (#14)", async () => {
    // The same window as above, for rule 1: Sam's edit (60) beats both of
    // Alex's (45, saved, then 50, diffed while the join waits). Joined
    // after the save, it is told once, "mine" being 50; "Use mine" on a
    // second notice naming 45 would set back a value Alex had replaced.
    const { store, held } = holdingStore("before");
    const d = await device({ store });
    const sam = new Replica(X, emptyDocument(), { actor: "sam" });
    await sam.backend.addEntry(ENTRY);
    await d.engine.join({ ops: [[X, sam.ops[0]]] });
    const [groceries] = await d.backend.getMonth(2026, 5);
    await d.backend.updateEntry(2026, 5, groceries.row, { ...ENTRY, amount: 45 });
    // Sam's edit gets an L above both of Alex's, never having seen either.
    for (const remarks of ["Bus", "Rent", "Tea"]) await sam.backend.addEntry({ ...ENTRY, remarks });
    await sam.backend.updateEntry(2026, 5, (await sam.backend.getMonth(2026, 5)).find((e) => e.remarks === "Groceries")!.row, { ...ENTRY, amount: 60 });
    const edit = sam.ops.at(-1)!;

    held.on = true;
    const theirs = d.engine.join({ ops: [[X, edit]] });
    await held.reached.promise;
    held.on = false;
    const mine = d.backend.updateEntry(2026, 5, groceries.row, { ...ENTRY, amount: 50 });
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => (globalThis as unknown as { setImmediate(fn: () => void): void }).setImmediate(resolve));
    held.release.resolve();
    await Promise.all([mine, theirs]);

    const newer = d.engine.pushableOps().at(-1)!;
    expect(newer.L).toBeLessThan(edit.L);
    expect(d.engine.current().expenses["2026-05"].map((e) => e.amount)).toEqual(["60.00"]);
    expect(d.engine.notices().map((v) => v.notice)).toEqual([
      expect.objectContaining({ kind: "overwrite", winner: expect.objectContaining({ L: edit.L, device: X }), loser: { L: newer.L, device: d.engine.deviceId }, registers: [expect.objectContaining({ theirs: "60.00", mine: "50.00" })] }),
    ]);
  });

  it("leaves no stale overwrite notice when the newer write, saved after the join, beats the winner the join told against an older edit (#14 review)", async () => {
    const { store, held } = holdingStore("before");
    const d = await device({ store });
    const sam = new Replica(X, emptyDocument(), { actor: "sam" });
    await sam.backend.addEntry(ENTRY);
    await d.engine.join({ ops: [[X, sam.ops[0]]] });
    const [groceries] = await d.backend.getMonth(2026, 5);
    await d.backend.updateEntry(2026, 5, groceries.row, { ...ENTRY, amount: 45 });
    const m1 = d.engine.pushableOps().at(-1)!;
    for (const remarks of ["A", "B", "C", "D", "E"]) await d.backend.addEntry({ ...ENTRY, remarks });
    // Sam's edit: an L between M1 and M2, never having seen M1.
    for (const remarks of ["Bus", "Rent"]) await sam.backend.addEntry({ ...ENTRY, remarks });
    await sam.backend.updateEntry(2026, 5, (await sam.backend.getMonth(2026, 5)).find((e) => e.remarks === "Groceries")!.row, { ...ENTRY, amount: 60 });
    const edit = sam.ops.at(-1)!;

    held.on = true;
    const theirs = d.engine.join({ ops: [[X, sam.ops[1]], [X, sam.ops[2]], [X, edit]] });
    await held.reached.promise;
    held.on = false;
    const mine = d.backend.updateEntry(2026, 5, (await d.backend.getMonth(2026, 5)).find((e) => e.remarks === "Groceries")!.row, { ...ENTRY, amount: 50 });
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => (globalThis as unknown as { setImmediate(fn: () => void): void }).setImmediate(resolve));
    held.release.resolve();
    await Promise.all([mine, theirs]);
    const m2 = d.engine.pushableOps().at(-1)!;
    expect({ m1: m1.L, w: edit.L, m2: m2.L }).toEqual({ m1: m1.L, w: edit.L, m2: m2.L });
    expect(m1.L < edit.L && edit.L < m2.L).toBe(true);
    expect(d.engine.current().expenses["2026-05"].filter((e) => e.remarks === "Groceries").map((e) => e.amount)).toEqual(["50.00"]);
    // Joined after the save, Sam's edit replaces nothing of Alex's (M2 beats it): no notice.
    expect(d.engine.notices().map((v) => ({ notice: v.notice, actions: v.actions }))).toEqual([]);
  });

  it("keeps no register in an older notice that the newer write rewrote, even to the winner's value (#14 review)", async () => {
    const { store, held } = holdingStore("before");
    const d = await device({ store });
    const sam = new Replica(X, emptyDocument(), { actor: "sam" });
    await sam.backend.addEntry(ENTRY);
    await d.engine.join({ ops: [[X, sam.ops[0]]] });
    const [groceries] = await d.backend.getMonth(2026, 5);
    await d.backend.updateEntry(2026, 5, groceries.row, { ...ENTRY, amount: 45, remarks: "x" });
    for (const remarks of ["Bus", "Rent", "Tea"]) await sam.backend.addEntry({ ...ENTRY, remarks });
    await sam.backend.updateEntry(2026, 5, (await sam.backend.getMonth(2026, 5)).find((e) => e.remarks === "Groceries")!.row, { ...ENTRY, amount: 60, remarks: "y" });
    const edit = sam.ops.at(-1)!;

    held.on = true;
    const theirs = d.engine.join({ ops: [[X, edit]] });
    await held.reached.promise;
    held.on = false;
    const mine = d.backend.updateEntry(2026, 5, groceries.row, { ...ENTRY, amount: 60, remarks: "z" });
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => (globalThis as unknown as { setImmediate(fn: () => void): void }).setImmediate(resolve));
    held.release.resolve();
    await Promise.all([mine, theirs]);
    // Joined after the save: one notice, remarks only (amount 60 = 60 tells no one).
    expect(d.engine.notices().map((v) => v.notice.kind === "overwrite" ? v.notice.registers.map((r) => `${r.key.split("/").at(-1)} theirs=${String(r.theirs)} mine=${String(r.mine)}`) : v.notice.kind)).toEqual([["remarks theirs=y mine=z"]]);
  });

  it("an older notice the newer write only partly rewrote keeps the rest, and its place in the list (#14 review)", async () => {
    const { store, held } = holdingStore("before");
    const d = await device({ store });
    const sam = new Replica(X, emptyDocument(), { actor: "sam" });
    await sam.backend.addEntry(ENTRY);
    await d.engine.join({ ops: [[X, sam.ops[0]]] });
    const [groceries] = await d.backend.getMonth(2026, 5);
    await d.backend.updateEntry(2026, 5, groceries.row, { ...ENTRY, amount: 45, remarks: "x" });
    for (const remarks of ["Bus", "Rent", "Tea"]) await sam.backend.addEntry({ ...ENTRY, remarks });
    await sam.backend.updateEntry(2026, 5, (await sam.backend.getMonth(2026, 5)).find((e) => e.remarks === "Groceries")!.row, { ...ENTRY, amount: 60, remarks: "y" });
    const edit = sam.ops.at(-1)!;

    held.on = true;
    const theirs = d.engine.join({ ops: [[X, edit]] });
    await held.reached.promise;
    held.on = false;
    // The newer write rewrites the amount only (Sam's edit still beats it).
    const mine = d.backend.updateEntry(2026, 5, groceries.row, { ...ENTRY, amount: 50, remarks: "x" });
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => (globalThis as unknown as { setImmediate(fn: () => void): void }).setImmediate(resolve));
    held.release.resolve();
    await Promise.all([mine, theirs]);

    // As if joined after the save: remarks against the older edit, amount
    // against the newer one; the older notice was told first and stays first.
    const told = d.engine.notices().map((v) => v.notice as Extract<typeof v.notice, { kind: "overwrite" }>);
    const byField = Object.fromEntries(told.map((n) => [n.registers.map((r) => r.key.split("/").at(-1)).join(","), n]));
    expect(Object.keys(byField).sort()).toEqual(["amount", "remarks"]);
    expect(byField.amount.registers[0]).toMatchObject({ theirs: "60.00", mine: "50.00" });
    expect(byField.remarks.registers[0]).toMatchObject({ theirs: "y", mine: "x" });
    expect(byField.remarks.seq).toBe(1);
    expect(byField.amount.seq).toBe(2);
  });

  it("persists a remote join and its bookkeeping in one transaction", async () => {
    const one = await device();
    const sam = new Replica(X, emptyDocument(), { actor: "sam" });
    await sam.backend.addEntry({ ...ENTRY, remarks: "Sam's lunch" });
    const name = `${EPOCH}.${X}.log.enc`;
    await one.engine.join({ ops: [[X, sam.ops[0]]] }, { joined: { [name]: "a".repeat(40) } });
    expect((await saved()).meta).toMatchObject({ joined: { [name]: "a".repeat(40) }, seen: { [X]: 2 }, maxL: 2 });
    const two = await reload(one);
    expect(remarks(two)).toEqual(["Sam's lunch"]);
    // Own L allocation stays above every L joined.
    await two.backend.addEntry(ENTRY);
    expect(two.engine.pushableOps()[0].L).toBe(3);
  });
});

describe("device storage failures (owner decision 5, B8, B17)", () => {
  /** Makes `put` on store `name` throw QuotaExceededError while `on.full`. */
  function quotaOn(name: string) {
    const on = { full: true };
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (on.full && this.name === name) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return put.apply(this, args);
    });
    return on;
  }

  it("B8: a full device refuses the write with 'This device couldn't save': nothing changes in memory or on the device, nothing is pushable, and the next write succeeds (never memory for good)", async () => {
    const d = await device();
    await d.backend.addEntry(ENTRY);
    const before = await dumpDatabase();
    const doc = docText(d.engine.current());
    const quota = quotaOn("chain");

    await expect(d.backend.addEntry({ ...ENTRY, remarks: "Rent" })).rejects.toEqual(new ApiError(500, DEVICE_SAVE_FAILED));
    expect(docText(d.engine.current())).toBe(doc);
    expect(d.engine.pushableOps()).toHaveLength(1);
    expect(d.engine.getState().deviceSaveFailed).toBe(true);
    expect(await dumpDatabase()).toBe(before);

    quota.full = false;
    await d.backend.addEntry({ ...ENTRY, remarks: "Bus" });
    expect(d.engine.getState().deviceSaveFailed).toBe(false);
    expect(remarks(d)).toEqual(["Groceries", "Bus"]);
    const ops = d.engine.pushableOps();
    expect(ops.map((op) => op.L)).toEqual([2, 4]);

    // A reload has exactly the writes that resolved, and the refused one's
    // L, never persisted or pushed, is free again.
    const two = await reload(d);
    expect(remarks(two)).toEqual(["Groceries", "Bus"]);
    expect(two.engine.pushableOps()).toEqual(ops);
    expect(JSON.stringify(two.engine.pushableOps())).not.toContain("Rent");
  });

  it("a transaction aborted after its writes were issued refuses the write and keeps none of it", async () => {
    const d = await device();
    const before = await dumpDatabase();
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      const request = put.apply(this, args);
      if (this.name === "chain") this.transaction.abort();
      return request;
    });
    await expect(d.backend.addEntry(ENTRY)).rejects.toEqual(new ApiError(500, DEVICE_SAVE_FAILED));
    expect(await dumpDatabase()).toBe(before);
    expect(remarks(d)).toEqual([]);
    expect(d.engine.pushableOps()).toEqual([]);
  });

  it("a refused remote join keeps the document as it was; the delta is joined when it is offered again", async () => {
    const d = await device();
    const sam = new Replica(X, emptyDocument(), { actor: "sam" });
    await sam.backend.addEntry({ ...ENTRY, remarks: "Sam's lunch" });
    const quota = quotaOn("meta");
    await expect(d.engine.join({ ops: [[X, sam.ops[0]]] })).rejects.toEqual(new ApiError(500, DEVICE_SAVE_FAILED));
    expect(remarks(d)).toEqual([]);
    expect(d.engine.getState().revision).toBe(0);
    quota.full = false;
    await d.engine.join({ ops: [[X, sam.ops[0]]] });
    expect(remarks(d)).toEqual(["Sam's lunch"]);
  });
});

describe("reload mid-commit", () => {
  it("before the transaction: the write rejects, nothing is saved, and the next start reuses its L harmlessly", async () => {
    const { store, calls, held } = holdingStore("before");
    const d = await device({ store });
    await d.backend.addEntry(ENTRY);
    held.on = true;
    const write = d.backend.addEntry({ ...ENTRY, remarks: "Rent" });
    await held.reached.promise;
    d.engine.stop(); // the page goes away
    const two = await device();
    expect(remarks(two)).toEqual(["Groceries"]);
    // Should the held transaction still run, the new tab's writer token
    // refuses it: it writes nothing over the new tab's records.
    held.release.resolve();
    await expect(write).rejects.toEqual(new ApiError(503, OTHER_TAB));
    expect(calls.committed).toBe(calls.started - 1);
    await two.backend.addEntry({ ...ENTRY, remarks: "Bus" });
    expect(two.engine.pushableOps().map((op) => op.L)).toEqual([2, 3]);
    expect(remarks(await reload(two))).toEqual(["Groceries", "Bus"]);
  });

  it("after the transaction committed: the op is loaded back and the write resolves", async () => {
    const { store, held } = holdingStore("after");
    const d = await device({ store });
    held.on = true;
    const write = d.backend.addEntry(ENTRY);
    await held.reached.promise;
    d.engine.stop();
    const two = await device();
    expect(remarks(two)).toEqual(["Groceries"]);
    expect(two.engine.pushableOps()).toHaveLength(1);
    held.release.resolve();
    await write;
  });
});

describe("saved state this build can't read (section 12, B13, B22)", () => {
  /** Expects `d` unreadable for `reason`, refusing writes, with the saved
   * records still byte for byte `before`. */
  async function expectUnreadable(d: Device, reason: string, before: string | null) {
    expect(d.engine.getState()).toMatchObject({ status: "unreadable", unreadable: reason, hasDocument: false, needsInit: false });
    expect(() => d.engine.current()).toThrow(ApiError);
    await expect(d.engine.commit(emptyDocument())).rejects.toBeInstanceOf(ApiError);
    await expect(d.engine.initialize(EPOCH, genesisState(emptyDocument()))).rejects.toThrow();
    expect(await dumpDatabase()).toBe(before);
  }

  async function savedDevice(): Promise<Device> {
    const d = await device();
    await d.backend.addEntry(ENTRY);
    d.engine.stop();
    return d;
  }

  it("a meta written by a newer build is unreadable ('newer'), and stays byte-identical", async () => {
    await savedDevice();
    await tamper("ledger:sync", "meta", (s) => {
      const req = s.get("meta");
      req.onsuccess = () => s.put({ ...req.result, formatVersion: 2 }, "meta");
    });
    const before = await dumpDatabase();
    const d = await device();
    await expectUnreadable(d, "newer", before);
    await d.engine.retry();
    await expectUnreadable(d, "newer", before);
  });

  it("a database a newer build upgraded is unreadable ('newer'), never memory", async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.open("ledger:sync", 2);
      req.onupgradeneeded = () => req.result.createObjectStore("everything");
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
    });
    const before = await dumpDatabase();
    const d = await device();
    await expectUnreadable(d, "newer", before);
    expect(d.engine.getState().volatile).toBe(false);
  });

  it("records that don't decrypt with this key are unreadable ('undecryptable'), never needsPassphrase", async () => {
    await savedDevice();
    const before = await dumpDatabase();
    const d = await device({ key: await testKey() });
    await expectUnreadable(d, "undecryptable", before);
  });

  it("a malformed record is unreadable ('malformed'), never partly loaded", async () => {
    await savedDevice();
    const bad = await seal({ ops: [[X, { L: 1 }]] }, key);
    await tamper("ledger:sync", "tail", (s) => s.add(bad));
    const before = await dumpDatabase();
    const d = await device();
    await expectUnreadable(d, "malformed", before);
  });

  it("a previous epochs' state (`old`) that is malformed or doesn't decrypt is unreadable, never dropped or written over later", async () => {
    await savedDevice();
    await tamper("ledger:sync", "old", (s) => s.put("not a sealed record", "old"));
    let before = await dumpDatabase();
    await expectUnreadable(await device(), "undecryptable", before);
    const malformed = await seal({ entries: [{ epoch: "nope" }] }, key);
    await tamper("ledger:sync", "old", (s) => s.put(malformed, "old"));
    before = await dumpDatabase();
    await expectUnreadable(await device(), "malformed", before);
    const foreign = await seal({ entries: [] }, await testKey());
    await tamper("ledger:sync", "old", (s) => s.put(foreign, "old"));
    before = await dumpDatabase();
    await expectUnreadable(await device(), "undecryptable", before);
  });

  it("an own log that disagrees with the state is unreadable", async () => {
    await savedDevice();
    await tamper("ledger:sync", "tail", (s) => s.clear());
    const before = await dumpDatabase();
    await expectUnreadable(await device(), "malformed", before);
  });

  it("a read that keeps failing is unreadable ('loadFailed'); Try again loads every saved write", async () => {
    await savedDevice();
    const before = await dumpDatabase();
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(() => {
      throw new DOMException("Connection to Indexed Database server lost", "UnknownError");
    });
    const d = await device();
    expect(d.engine.getState()).toMatchObject({ status: "unreadable", unreadable: "loadFailed", hasDocument: false, needsInit: false });
    await expect(d.backend.addEntry(ENTRY)).rejects.toBeInstanceOf(ApiError);
    getAll.mockRestore();
    expect(await dumpDatabase()).toBe(before);
    await d.engine.retry();
    expect(d.engine.getState()).toMatchObject({ status: "idle", hasDocument: true, unreadable: null });
    expect(remarks(d)).toEqual(["Groceries"]);
    await d.backend.addEntry({ ...ENTRY, remarks: "Rent" });
    expect(remarks(await reload(d))).toEqual(["Groceries", "Rent"]);
  });

  it("an open that fails once is retried (B22): the saved writes load, and new ones are saved on the device", async () => {
    await savedDevice();
    const real = globalThis.indexedDB;
    let fail = true;
    vi.stubGlobal(
      "indexedDB",
      new Proxy(real, {
        get(target, prop) {
          if (prop === "open" && fail) {
            fail = false;
            return () => {
              throw new DOMException("Connection to Indexed Database server lost", "UnknownError");
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
    const d = await device();
    expect(remarks(d)).toEqual(["Groceries"]);
    expect(d.engine.getState().volatile).toBe(false);
    await d.backend.addEntry({ ...ENTRY, remarks: "Rent" });
    vi.stubGlobal("indexedDB", factory);
    expect(remarks(await reload(d))).toEqual(["Groceries", "Rent"]);
  });

  it("an IndexedDB that never opens runs from tab memory and says so (volatile)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const real = globalThis.indexedDB;
    vi.stubGlobal(
      "indexedDB",
      new Proxy(real, {
        get(target, prop) {
          if (prop === "open") {
            return () => {
              throw new DOMException("The user denied permission to access the database.", "SecurityError");
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
    const d = await device();
    await d.backend.addEntry(ENTRY);
    expect(d.engine.getState()).toMatchObject({ volatile: true, hasDocument: true, deviceSaveFailed: false });
    expect(remarks(d)).toEqual(["Groceries"]);
  });

  const quota = () => new DOMException("The quota has been exceeded.", "QuotaExceededError");

  it("a full device that can't create the next generation's probe still loads the saved records (D19)", async () => {
    const old = await savedDevice();
    vi.stubGlobal("indexedDB", faultyIndexedDB(factory, (name) => (name === "ledger:sync:2" ? quota() : null)));
    const d = await device();
    expect(d.engine.getState()).toMatchObject({ status: "idle", needsInit: false, volatile: false, unreadable: null });
    expect(d.engine.deviceId).toBe(old.engine.deviceId);
    expect(remarks(d)).toEqual(["Groceries"]);
    expect(d.engine.pushableOps()).toHaveLength(1);
    await d.backend.addEntry({ ...ENTRY, remarks: "Rent" });
    vi.stubGlobal("indexedDB", factory);
    expect(remarks(await reload(d))).toEqual(["Groceries", "Rent"]);
  });

  it("without indexedDB.databases(), a probe that fails is unknown, not absent: unreadable, never memory, writes refused", async () => {
    await savedDevice();
    const before = await dumpDatabase();
    vi.stubGlobal("indexedDB", faultyIndexedDB(factory, (name) => (name === "ledger:sync:2" ? quota() : null), { databases: false }));
    const d = await device();
    await expectUnreadable(d, "loadFailed", before);
    expect(d.engine.getState().volatile).toBe(false);
    await expect(d.backend.addEntry({ ...ENTRY, remarks: "Rent" })).rejects.toBeInstanceOf(ApiError);
    expect(await dumpDatabase()).toBe(before);

    // Once the probe works again, Try again finds every saved write.
    vi.stubGlobal("indexedDB", faultyIndexedDB(factory, () => null, { databases: false }));
    await d.engine.retry();
    expect(remarks(d)).toEqual(["Groceries"]);
  });

  it("a database that keeps failing to open with anything but a refusal is unreadable, never memory: a full quota or a corrupt store", async () => {
    await savedDevice();
    const before = await dumpDatabase();
    vi.stubGlobal("indexedDB", faultyIndexedDB(factory, () => new DOMException("Internal error opening backing store for indexedDB.open.", "UnknownError")));
    const corrupt = await device();
    vi.stubGlobal("indexedDB", factory);
    await expectUnreadable(corrupt, "loadFailed", before);
    expect(corrupt.engine.getState().volatile).toBe(false);
    await clearSyncState();

    // A first start on a full device: nothing can be stored, so nothing is
    // accepted into tab memory either.
    vi.stubGlobal("indexedDB", faultyIndexedDB(factory, quota));
    const full = await device();
    expect(full.engine.getState()).toMatchObject({ status: "unreadable", unreadable: "loadFailed", needsInit: false, volatile: false });
    await expect(full.backend.addEntry(ENTRY)).rejects.toBeInstanceOf(ApiError);
    expect(await factory.databases()).toEqual([]);
  });

  it("a refusal from a database indexedDB.databases() lists is unreadable, never memory", async () => {
    await savedDevice();
    const before = await dumpDatabase();
    vi.stubGlobal("indexedDB", faultyIndexedDB(factory, () => new DOMException("A mutation operation was attempted on a database that did not allow mutations.", "InvalidStateError")));
    const d = await device();
    vi.stubGlobal("indexedDB", factory);
    await expectUnreadable(d, "loadFailed", before);
    expect(d.engine.getState().volatile).toBe(false);
  });

  it("Start as a new device keeps the old records as a raw backup and starts over under a new device id", async () => {
    const old = await savedDevice();
    await tamper("ledger:sync", "meta", (s) => {
      const req = s.get("meta");
      req.onsuccess = () => s.put({ ...req.result, formatVersion: 2 }, "meta");
    });
    const before = await dumpDatabase();
    const engine = new SyncEngine({ key, actor: "alex", locks: null, log: () => {}, store: openSyncStore(noWait) });
    await engine.start();
    expect(engine.getState().unreadable).toBe("newer");
    await engine.startAsNewDevice();
    expect(engine.getState()).toMatchObject({ status: "idle", needsInit: true, unreadable: null });
    await engine.initialize(EPOCH, genesisState(emptyDocument()));
    expect(engine.deviceId).not.toBe(old.engine.deviceId);
    const host = new SyncedHost(engine);
    await new DocumentBackend({ host, now: Date.now, actor: "alex", newId: () => crypto.randomUUID() }).addEntry({ ...ENTRY, remarks: "Rent" });
    expect(await dumpDatabase()).toBe(before);

    // A reload reads the new generation, not the old one.
    engine.stop();
    const next = await device();
    expect(next.engine.deviceId).toBe(engine.deviceId);
    expect(remarks(next)).toEqual(["Rent"]);
  });
});

describe("multi-tab (section 10.2)", () => {
  it("a second tab can't start while the first holds the Web Lock, and starts with every saved write once it lets go", async () => {
    const locks = new FakeLocks().asLockManager();
    const a = await device({ locks });
    await a.backend.addEntry(ENTRY);
    const b = await device({ locks });
    expect(b.engine.getState()).toMatchObject({ status: "locked", hasDocument: false });
    expect(() => b.engine.current()).toThrow(ApiError);
    await expect(b.backend.addEntry(ENTRY)).rejects.toEqual(new ApiError(503, OTHER_TAB));

    a.engine.stop();
    await until(b.engine, (state) => state.hasDocument);
    expect(b.engine.getState()).toMatchObject({ status: "idle", hasDocument: true });
    expect(remarks(b)).toEqual(["Groceries"]);
    await b.backend.addEntry({ ...ENTRY, remarks: "Rent" });
    expect(remarks(b)).toEqual(["Groceries", "Rent"]);
  });

  it("a tab another tab superseded (bfcache, a bypassed lock) writes nothing and goes read-only", async () => {
    const a = await device();
    await a.backend.addEntry(ENTRY);
    const b = await device(); // no lock: takes the writer token
    const before = await dumpDatabase();
    await expect(a.backend.addEntry({ ...ENTRY, remarks: "Rent" })).rejects.toEqual(new ApiError(503, OTHER_TAB));
    expect(await dumpDatabase()).toBe(before);
    expect(a.engine.getState().status).toBe("locked");
    expect(a.engine.pushableOps()).toHaveLength(1);
    expect(remarks(a)).toEqual(["Groceries"]); // reads still work
    await expect(a.backend.addEntry(ENTRY)).rejects.toEqual(new ApiError(503, OTHER_TAB));

    await b.backend.addEntry({ ...ENTRY, remarks: "Bus" });
    expect(remarks(await reload(b))).toEqual(["Groceries", "Bus"]);
  });

  it("a write the previous writer makes between this tab's load and its claim is loaded, never forked over", async () => {
    const z = await device();
    await z.backend.addEntry(ENTRY);
    const inner = openSyncStore(noWait);
    let zWrite: Promise<unknown> | null = null;
    const store: SyncStore = {
      async load() {
        const records = await inner.load();
        // Z, superseded but not yet told, saves once more after this read.
        if (!zWrite) await (zWrite = z.backend.addEntry({ ...ENTRY, remarks: "Rent" }));
        return records;
      },
      mutate: (m) => inner.mutate(m),
      chainEntry: (L) => inner.chainEntry(L),
      startNewGeneration: () => inner.startNewGeneration(),
      volatile: () => inner.volatile(),
    };
    const a = await device({ store });
    await zWrite;
    expect(a.engine.getState().status).toBe("idle");
    expect(remarks(a)).toEqual(["Groceries", "Rent"]);
    await expect(z.backend.addEntry({ ...ENTRY, remarks: "Taxi" })).rejects.toEqual(new ApiError(503, OTHER_TAB));
    await a.backend.addEntry({ ...ENTRY, remarks: "Bus" });
    expect(a.engine.pushableOps().map((op) => op.L)).toEqual([2, 3, 4]);

    const a2 = await reload(a);
    expect(remarks(a2)).toEqual(["Groceries", "Rent", "Bus"]);
    expect(a2.engine.pushableOps().map((op) => op.L)).toEqual([2, 3, 4]);
    expect(JSON.stringify(a2.engine.pushableOps())).toContain("Rent");
  });

  it("a claim the device can't save refuses writes until one commits; a write made after another writer's refuses and goes read-only", async () => {
    const z = await device();
    await z.backend.addEntry(ENTRY);
    const on = { full: true };
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (on.full && this.name === "meta") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return put.apply(this, args);
    });
    const a = await device();
    expect(a.engine.getState()).toMatchObject({ status: "idle", hasDocument: true, deviceSaveFailed: true });
    expect(remarks(a)).toEqual(["Groceries"]);
    await expect(a.backend.addEntry({ ...ENTRY, remarks: "Rent" })).rejects.toEqual(new ApiError(500, DEVICE_SAVE_FAILED));
    on.full = false;
    // The claim is made before the write, against the records as loaded.
    await a.backend.addEntry({ ...ENTRY, remarks: "Bus" });
    expect(a.engine.getState().deviceSaveFailed).toBe(false);
    await expect(z.backend.addEntry({ ...ENTRY, remarks: "Taxi" })).rejects.toEqual(new ApiError(503, OTHER_TAB));
    expect(remarks(await reload(a))).toEqual(["Groceries", "Bus"]);

    // Unclaimed again, and the old writer saves in between: the claim
    // finds the records changed, writes nothing and goes read-only.
    on.full = true;
    const b = await device();
    on.full = false;
    const c = await device();
    await c.backend.addEntry({ ...ENTRY, remarks: "Tea" });
    const before = await dumpDatabase();
    await expect(b.backend.addEntry({ ...ENTRY, remarks: "Taxi" })).rejects.toEqual(new ApiError(503, OTHER_TAB));
    expect(b.engine.getState().status).toBe("locked");
    expect(await dumpDatabase()).toBe(before);
  });

  it("two quick 'Try again' taps run one load: the tab stays the writer and keeps what it wrote", async () => {
    const seed = await device();
    await seed.backend.addEntry(ENTRY);
    seed.engine.stop();
    const inner = openSyncStore(noWait);
    let calls = 0;
    const store: SyncStore = {
      async load() {
        calls++;
        if (calls === 1) throw new Error("transient");
        return inner.load();
      },
      mutate: (m) => inner.mutate(m),
      chainEntry: (L) => inner.chainEntry(L),
      startNewGeneration: () => inner.startNewGeneration(),
      volatile: () => inner.volatile(),
    };
    const d = await device({ store });
    expect(d.engine.getState().unreadable).toBe("loadFailed");
    const one = d.engine.retry();
    const two = d.engine.retry();
    const three = d.engine.startAsNewDevice();
    await one;
    await d.backend.addEntry({ ...ENTRY, remarks: "Rent" });
    await Promise.all([two, three]);
    expect(calls).toBe(2);
    expect(d.engine.getState()).toMatchObject({ status: "idle", unreadable: null });
    expect(remarks(d)).toEqual(["Groceries", "Rent"]);
    await d.backend.addEntry({ ...ENTRY, remarks: "Bus" });
    expect(remarks(await reload(d))).toEqual(["Groceries", "Rent", "Bus"]);
  });

  it("clearSyncState() stops the running engine first: it writes nothing more", async () => {
    const d = await device();
    await clearSyncState();
    await expect(d.backend.addEntry(ENTRY)).rejects.toBeInstanceOf(ApiError);
    expect(await dumpDatabase()).toBeNull();
  });
});

describe("nothing on the device is plaintext (AC15)", () => {
  it("no stored value holds a remark, from an own write or a joined one; meta holds only ids, counters and shas", async () => {
    const REMARK = "Birthday gift for Alex, test remark 7f3c";
    const d = await device();
    await d.backend.addEntry({ ...ENTRY, remarks: REMARK });
    const sam = new Replica(X, emptyDocument(), { actor: "sam" });
    await sam.backend.addEntry({ ...ENTRY, remarks: `${REMARK} from Sam` });
    await d.engine.join({ ops: [[X, sam.ops[0]]] });
    const dump = (await dumpDatabase())!;
    expect(dump).not.toContain("7f3c");
    expect(dump).not.toContain("Birthday");
    expect(dump).not.toContain("Groceries");
    const { meta } = await saved();
    expect(Object.keys(meta).sort()).toEqual(
      [
        "K",
        "deviceId",
        "epochKey",
        "formatVersion",
        "joined",
        "lastSeenCommit",
        "lastSentLogSha",
        "lastSentLogK",
        "lastSentLogThrough",
        "lastSentSnapSha",
        "lastSentSnapThrough",
        "maxL",
        "ownLogK",
        "ownLogSha",
        "ownLogThrough",
        "ownMaxL",
        "ownSnapSha",
        "logReach",
        "snapReach",
        "refEtag",
        "seen",
        "writerToken",
      ].sort(),
    );
  });
});

describe("the default log", () => {
  function spies() {
    return {
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  }

  it("sends routine progress to console.info only, with no 'undefined' after it", () => {
    const { info, warn, error } = spies();
    defaultSyncLog("info", "the restore's genesis e000002-0000000b landed after all");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(info.mock.calls).toEqual([["ledger:sync: the restore's genesis e000002-0000000b landed after all"]]);
  });

  it("sends a warning to console.warn, and a failure to console.error, whether or not an error object comes with it", () => {
    const { info, warn, error } = spies();
    defaultSyncLog("warn", "the repo refused 4 writes of this device's log in a row; trying again on the next trigger");
    defaultSyncLog("error", "this device's own log would be refused (too large); it is not sent");
    const err = new Error("boom");
    defaultSyncLog("error", "sync failed; it will be tried again", err);
    expect(info).not.toHaveBeenCalled();
    expect(warn.mock.calls).toEqual([["ledger:sync: the repo refused 4 writes of this device's log in a row; trying again on the next trigger"]]);
    expect(error.mock.calls).toEqual([["ledger:sync: this device's own log would be refused (too large); it is not sent"], ["ledger:sync: sync failed; it will be tried again", err]]);
  });
});

describe("a save after a join that re-carries an old winner (#14 review, round 2)", () => {
  /** Sam's edit (60) beat Alex's 45 and was told in an ordinary join.
   * Alex then edits the amount again (50, after seeing 60), while a join of
   * Sam's snapshot, which carries the same register still tagged with
   * Sam's edit, runs before the save (`window`) or before the diff. */
  async function scenario(window: boolean) {
    const { store, held } = holdingStore("before");
    const d = await device({ store });
    const sam = new Replica(X, emptyDocument(), { actor: "sam" });
    await sam.backend.addEntry(ENTRY);
    await d.engine.join({ ops: [[X, sam.ops[0]]] });
    const [groceries] = await d.backend.getMonth(2026, 5);
    await d.backend.updateEntry(2026, 5, groceries.row, { ...ENTRY, amount: 45 });
    for (const remarks of ["Bus", "Rent", "Tea"]) await sam.backend.addEntry({ ...ENTRY, remarks });
    await sam.backend.updateEntry(2026, 5, (await sam.backend.getMonth(2026, 5)).find((e) => e.remarks === "Groceries")!.row, { ...ENTRY, amount: 60 });
    // An ordinary join, no write in flight: told W/M1.
    await d.engine.join({ ops: sam.ops.slice(1).map((op) => [X, op] as [string, typeof op]) });
    const toldFirst = d.engine.notices().map((v) => v.key);
    // Later the person edits the amount again (after seeing 60). Meanwhile Sam's snapshot (unchanged amount, tagged W) joins.
    if (window) held.on = true;
    const theirs = d.engine.join({ states: [{ device: X, state: sam.state }] });
    if (window) {
      await held.reached.promise;
      held.on = false;
    } else await theirs;
    const mine = d.backend.updateEntry(2026, 5, groceries.row, { ...ENTRY, amount: 50 });
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => (globalThis as unknown as { setImmediate(fn: () => void): void }).setImmediate(resolve));
    held.release.resolve();
    await Promise.all([mine, theirs]);
    return { toldFirst, now: d.engine.notices().map((v) => v.key) };
  }
  it("keeps a notice whose winner the join only carried again, unchanged, as it keeps it when that join runs before the diff", async () => {
    const without = await scenario(false);
    await clearSyncState();
    factory = new IDBFactory();
    vi.stubGlobal("indexedDB", factory);
    const withWindow = await scenario(true);
    expect({ without: without.now.length, withWindow: withWindow.now.length, toldFirst: without.toldFirst.length }).toEqual({ without: 1, withWindow: 1, toldFirst: 1 });
  });
});
