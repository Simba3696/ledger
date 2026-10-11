import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentBackend } from "../document/DocumentBackend";
import { Fence } from "./fence";
import { testKey } from "./localTestkit";
import { clearSyncState, openSyncStore } from "./persist";
import { unseal, type DeviceKey } from "./records";
import { applyOp, cloneState, genesisState, opState, type Op } from "./state";
import { SyncEngine } from "./SyncEngine";
import { SyncedHost } from "./SyncedHost";
import { Replica, deviceId, emptyDocument } from "./testkit";

// The stale-UI fence (design section 3.4, AC8). A form submits every field;
// after a remote change that was joined but not rendered, an untouched field
// would set it back. With a view attached (SyncHost), such a field is
// dropped from the op and the remote value stands; a field the user changed
// is applied; both make a notice, saved with the op. Without a view (unit
// tests, the engine alone) every revision counts as rendered.

const EPOCH = "e000001-0000000a";
const X = deviceId(0xb);
const ENTRY = { year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false };
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

/** This device (with an expense, its row handle and, unless `view` is
 * false, an attached view) and Sam, who has joined it. */
async function world(view = true) {
  const engine = new SyncEngine({ key, actor: "alex", locks: null, log: () => {}, store: openSyncStore({ sleep: async () => {} }) });
  await engine.start();
  await engine.initialize(EPOCH, genesisState(emptyDocument()));
  const backend = new DocumentBackend({ host: new SyncedHost(engine), now: () => Date.UTC(2026, 4, 10), actor: "alex", newId: () => crypto.randomUUID() });
  const entry = await backend.addEntry(ENTRY);
  const sam = new Replica(X, emptyDocument(), { actor: "sam" });
  for (const op of engine.pushableOps()) sam.receive(engine.deviceId!, op);
  if (view) engine.attachView(engine.getState().revision);
  /** Sam's next write, joined here and not rendered. */
  const samWrites = async (write: (b: DocumentBackend, row: number) => Promise<unknown>): Promise<Op> => {
    const [samsEntry] = await sam.backend.getMonth(2026, 5);
    await write(sam.backend, samsEntry.row);
    const op = sam.ops.at(-1)!;
    await engine.join({ ops: [[X, op]] });
    return op;
  };
  const amount = () => engine.current().expenses["2026-05"][0].amount;
  const lastOp = () => engine.pushableOps().at(-1)!;
  const notices = async () => {
    const records = (await openSyncStore().load())!;
    expect(records.noticeCount).toBe(engine.getState().noticeCount);
    return records;
  };
  return { engine, backend, row: entry.row, sam, samWrites, amount, lastOp, notices };
}

describe("an unrendered remote change", () => {
  it("is kept when the user's form left that field as it was: the field is dropped from the op, with a 'kept' notice", async () => {
    const w = await world();
    await w.samWrites((b, row) => b.updateEntry(2026, 5, row, { ...ENTRY, amount: 12 }));
    expect(w.engine.getState().revision).toBe(1);
    const before = w.engine.pushableOps().length;
    // The form still shows 40.00, and the user changed only the remarks.
    await w.backend.updateEntry(2026, 5, w.row, { ...ENTRY, remarks: "Groceries, weekly" });
    expect(w.amount()).toBe("12.00");
    expect(w.engine.current().expenses["2026-05"][0].remarks).toBe("Groceries, weekly");
    expect(w.engine.pushableOps()).toHaveLength(before + 1);
    expect(w.lastOp().set.map(([k]) => k.split("/")[2])).toEqual(["remarks", "_s"]);
    expect(w.engine.getState().noticeCount).toBe(1);
    await w.notices();
  });

  it("is replaced when the user typed a new value, with a 'replaced' notice", async () => {
    const w = await world();
    await w.samWrites((b, row) => b.updateEntry(2026, 5, row, { ...ENTRY, amount: 12 }));
    await w.backend.updateEntry(2026, 5, w.row, { ...ENTRY, amount: 15 });
    expect(w.amount()).toBe("15.00");
    expect(w.lastOp().set.map(([k]) => k.split("/")[2])).toEqual(["amount", "_s"]);
    const records = await w.notices();
    expect(records.noticeCount).toBe(1);
  });

  it("leaves no op at all when only untouched fields remain (stamps alone say nothing), but still saves the notice", async () => {
    const w = await world();
    await w.samWrites((b, row) => b.updateEntry(2026, 5, row, { ...ENTRY, amount: 12 }));
    const ops = w.engine.pushableOps().length;
    await w.backend.updateEntry(2026, 5, w.row, ENTRY);
    expect(w.amount()).toBe("12.00");
    expect(w.engine.pushableOps()).toHaveLength(ops);
    expect(w.engine.getState().noticeCount).toBe(1);
    const stored = (await w.notices()).noticeCount;
    expect(stored).toBe(1);
  });

  it("stops being fenced once rendered: the user's value is then a deliberate edit", async () => {
    const w = await world();
    await w.samWrites((b, row) => b.updateEntry(2026, 5, row, { ...ENTRY, amount: 12 }));
    w.engine.rendered(w.engine.getState().revision);
    await w.backend.updateEntry(2026, 5, w.row, ENTRY);
    expect(w.amount()).toBe("40.00");
    expect(w.engine.getState().noticeCount).toBe(0);
  });

  it("isn't fenced without a view: every revision counts as rendered", async () => {
    const w = await world(false);
    await w.samWrites((b, row) => b.updateEntry(2026, 5, row, { ...ENTRY, amount: 12 }));
    await w.backend.updateEntry(2026, 5, w.row, ENTRY);
    expect(w.amount()).toBe("40.00");
    expect(w.engine.getState().noticeCount).toBe(0);
  });

  it("guards a whole unit: a stale setMonthIncome that changes nothing the user saw keeps the remote month", async () => {
    const w = await world();
    await w.backend.setMonthIncome(2026, 5, { salary: 100, otherIncome: null, savings: [] });
    for (const op of w.engine.pushableOps().slice(-1)) w.sam.receive(w.engine.deviceId!, op);
    await w.samWrites((b) => b.setMonthIncome(2026, 5, { salary: 250, otherIncome: null, savings: [] }));
    await w.backend.setMonthIncome(2026, 5, { salary: 100, otherIncome: null, savings: [] });
    expect(w.engine.current().financeMonths["2026-05"].salary).toBe("250.00");
    await w.backend.setMonthIncome(2026, 5, { salary: 300, otherIncome: null, savings: [] });
    expect(w.engine.current().financeMonths["2026-05"].salary).toBe("300.00");
    expect(w.engine.getState().noticeCount).toBe(2);
  });

  it("stamps vv with what was rendered, so the remote author still gets an edit/edit notice", async () => {
    const w = await world();
    const samsOp = await w.samWrites((b) => b.setMonthLock(2026, 6, true));
    await w.backend.updateEntry(2026, 5, w.row, { ...ENTRY, amount: 15 });
    expect(w.lastOp().vv[X]).toBeUndefined();
    w.engine.rendered(w.engine.getState().revision);
    await w.backend.updateEntry(2026, 5, w.row, { ...ENTRY, amount: 16 });
    expect(w.lastOp().vv[X]).toBe(samsOp.L);
    // The device's own ops are always seen.
    expect(w.lastOp().vv[w.engine.deviceId!]).toBe(w.lastOp().L - 1);
  });

  it("a delete joined but not rendered can't be undone: the update is a 404 and makes no op", async () => {
    const w = await world();
    await w.samWrites((b, row) => b.deleteEntry(2026, 5, row));
    const ops = w.engine.pushableOps().length;
    await expect(w.backend.updateEntry(2026, 5, w.row, ENTRY)).rejects.toMatchObject({ status: 404 });
    expect(w.engine.pushableOps()).toHaveLength(ops);
    expect(w.engine.current().expenses["2026-05"]).toBeUndefined();
  });

  it("an own write supersedes the unseen value: a later stale submit of that field is an edit", async () => {
    const w = await world();
    await w.samWrites((b, row) => b.updateEntry(2026, 5, row, { ...ENTRY, amount: 12 }));
    await w.backend.updateEntry(2026, 5, w.row, { ...ENTRY, amount: 15 });
    await w.backend.updateEntry(2026, 5, w.row, ENTRY);
    expect(w.amount()).toBe("40.00");
  });

  it("an own write that lost to the unseen value supersedes nothing: a later stale submit of that field is still fenced", async () => {
    const w = await world();
    const groceries = () => w.engine.current().expenses["2026-05"].find((e) => e.remarks.startsWith("Groceries"))!;
    // Sam's change gets a later L than this device's next write: Sam adds an
    // entry first, then sets the amount to 12.00.
    await w.sam.backend.addEntry({ ...ENTRY, remarks: "Bus" });
    const [samsRow] = (await w.sam.backend.getMonth(2026, 5)).filter((e) => e.remarks === "Groceries");
    await w.sam.backend.updateEntry(2026, 5, samsRow.row, { ...ENTRY, amount: 12 });
    const joining = w.engine.join({ ops: w.sam.ops.slice(-2).map((op): [string, Op] => [X, op]) });
    // This device sets the amount to 15.00, diffed before Sam's join lands
    // and committed after it. Sam's tag wins, and nothing renders it.
    const next = structuredClone(w.engine.current());
    next.expenses["2026-05"][0].amount = "15.00";
    const mine = w.engine.commit(next);
    await Promise.all([joining, mine]);
    expect(groceries().amount).toBe("12.00");
    expect(w.engine.getState().revision).toBe(1);

    // A form still showing 40.00, where the user changed only the remarks.
    const before = w.engine.getState().noticeCount;
    await w.backend.updateEntry(2026, 5, w.row, { ...ENTRY, remarks: "Groceries, weekly" });
    expect(groceries()).toMatchObject({ amount: "12.00", remarks: "Groceries, weekly" });
    expect(w.engine.getState().noticeCount - before).toBe(1);
  });

  it("is fenced by what was rendered when the write was submitted, though it runs after a later render", async () => {
    const w = await world();
    // SyncHost: the layout effect reports the revision once the re-keyed
    // tree has committed, a moment after the join is shown.
    w.engine.subscribe(() => queueMicrotask(() => w.engine.rendered(w.engine.getState().revision)));
    const [samsEntry] = await w.sam.backend.getMonth(2026, 5);
    await w.sam.backend.updateEntry(2026, 5, samsEntry.row, { ...ENTRY, amount: 12 });
    const join = w.engine.join({ ops: [[X, w.sam.ops.at(-1)!]] });
    // Two saves from the screen that still shows 40.00; the second waits
    // behind the first in DocumentBackend's queue, past the render.
    const first = w.backend.addEntry({ ...ENTRY, remarks: "Bus" });
    const second = w.backend.updateEntry(2026, 5, w.row, { ...ENTRY, remarks: "Groceries, weekly" });
    await Promise.all([join, first, second]);
    expect(w.engine.getState().revision).toBe(1);
    const groceries = w.engine.current().expenses["2026-05"].find((e) => e.remarks.startsWith("Groceries"))!;
    expect(groceries).toMatchObject({ amount: "12.00", remarks: "Groceries, weekly" });
    expect(w.engine.getState().noticeCount).toBe(1);
    expect(w.lastOp().vv[X]).toBeUndefined();

    // A save submitted after that render is a deliberate edit.
    await w.backend.updateEntry(2026, 5, w.row, { ...ENTRY, remarks: "Groceries, weekly" });
    expect(w.amount()).toBe("40.00");
  });

  it("saves fence notices encrypted, keyed by (winner op, loser op)", async () => {
    const w = await world();
    const samsOp = await w.samWrites((b, row) => b.updateEntry(2026, 5, row, { ...ENTRY, amount: 12 }));
    await w.backend.updateEntry(2026, 5, w.row, { ...ENTRY, remarks: "Groceries, weekly" });
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open("ledger:sync");
      req.onsuccess = () => resolve(req.result);
    });
    const [keys, values] = await new Promise<[IDBValidKey[], string[]]>((resolve) => {
      const store = db.transaction("notices").objectStore("notices");
      const k = store.getAllKeys();
      const v = store.getAll();
      v.onsuccess = () => resolve([k.result, v.result]);
    });
    db.close();
    const mine = w.lastOp().L;
    expect(keys).toEqual([`${samsOp.L}.${X}/${mine}.${w.engine.deviceId}`]);
    expect(values[0]).not.toContain("12.00");
    expect(await unseal(values[0], key)).toMatchObject({ kind: "kept", theirs: [samsOp.L, X], registers: [{ theirs: "12.00", mine: "40.00" }] });
  });
});

describe("Fence (pure)", () => {
  it("drops a field group (an EMI's balance pair) whole, or keeps it whole", async () => {
    const id = "00000000-0000-4000-8000-000000000e01";
    const rk = `emi/${id}`;
    const state = genesisState(emptyDocument());
    const create: Op = {
      L: 2,
      at: 0,
      by: "alex",
      vv: {},
      del: [],
      set: [
        [`${rk}/_c`, { o: `1.${"2".padStart(16, "0")}.${deviceId(1)}` }],
        [`${rk}/cardOrBank`, "Car Loan"],
        [`${rk}/emiAmount`, "1000.00"],
        [`${rk}/dueDay`, 5],
        [`${rk}/totalAmount`, "12000.00"],
        [`${rk}/remarks`, ""],
        [`${rk}/remainingAsOf`, "9000.00"],
        [`${rk}/asOfDate`, "2026-05-01"],
        [`${rk}/untilTarget`, null],
        [`${rk}/interestRate`, null],
        [`${rk}/foreclosureCharge`, null],
        [`${rk}/_s`, { at: 0, by: "alex" }],
      ],
    };
    applyOp(state, deviceId(1), create);
    const fence = new Fence();
    fence.attach(0, {});
    const paid: Op = { L: 3, at: 0, by: "sam", vv: {}, del: [], set: [[`${rk}/remainingAsOf`, "8000.00"], [`${rk}/asOfDate`, "2026-06-05"], [`${rk}/_s`, { at: 1, by: "sam" }]] };
    fence.join(state, opState(X, paid));
    expect(fence.revision).toBe(1);

    const stale = (remainingAsOf: string) => ({
      set: [
        [`${rk}/remarks`, "Car"],
        [`${rk}/remainingAsOf`, remainingAsOf],
        [`${rk}/asOfDate`, "2026-05-01"],
        [`${rk}/_s`, { at: 2, by: "alex" }],
      ] as [string, unknown][],
      del: [],
    });
    const untouched = fence.apply(stale("9000.00"), cloneState(state));
    expect(untouched.body?.set.map(([k]) => k)).toEqual([`${rk}/remarks`, `${rk}/_s`]);
    expect(untouched.notices).toMatchObject([{ kind: "kept", theirs: [3, X] }]);
    expect(untouched.notices[0].registers.map((r) => r.key)).toEqual([`${rk}/remainingAsOf`, `${rk}/asOfDate`]);

    const typed = fence.apply(stale("7000.00"), cloneState(state));
    expect(typed.body?.set.map(([k]) => k)).toEqual([`${rk}/remarks`, `${rk}/remainingAsOf`, `${rk}/asOfDate`, `${rk}/_s`]);
    expect(typed.notices).toMatchObject([{ kind: "replaced" }]);

    fence.rendered(1);
    expect(fence.apply(stale("9000.00"), state).notices).toEqual([]);
  });

  it("keeps the oldest pre-image since the last render, and never fences a create", () => {
    const state = genesisState(emptyDocument());
    const fence = new Fence();
    fence.attach(0, {});
    const lock = (L: number, v: boolean): Op => ({ L, at: 0, by: "sam", vv: {}, del: [], set: [["lk/2026-05", v]] });
    fence.join(state, opState(X, lock(2, true)));
    fence.join(state, opState(X, lock(3, false)));
    fence.join(state, opState(X, lock(4, true)));
    // The user last saw the month unlocked: an untouched "unlock" is dropped.
    expect(fence.apply({ set: [["lk/2026-05", false]], del: [] }, state).body).toBeNull();

    const id = "00000000-0000-4000-8000-000000000e02";
    const add = { set: [[`e/${id}/_c`, { m: "2026-05" }], [`e/${id}/amount`, "1.00"]] as [string, unknown][], del: [] };
    expect(fence.apply(add, state).body).toEqual(add);
  });

  it("keeps the pre-images and seen vectors a pinned write needs until it is released, and for each revision what it replaced", () => {
    const state = genesisState(emptyDocument());
    const fence = new Fence();
    fence.attach(0, {});
    const lock = (L: number, v: boolean): Op => ({ L, at: 0, by: "sam", vv: {}, del: [], set: [["lk/2026-05", v]] });
    const unlock = { set: [["lk/2026-05", false]] as [string, unknown][], del: [] };
    const relock = { set: [["lk/2026-05", true]] as [string, unknown][], del: [] };
    const atZero = fence.pin();
    fence.join(state, opState(X, lock(2, true)));
    fence.rendered(1);
    const atOne = fence.pin();
    fence.join(state, opState(X, lock(3, false)));
    fence.rendered(2);
    expect(fence.renderedRevision).toBe(2);
    // Submitted at 0, the user saw it unlocked: an untouched unlock is dropped.
    expect(fence.apply(unlock, state, atZero.asOf).body).toBeNull();
    expect(fence.renderedSeen(state.seen, atZero.asOf)).toEqual({});
    // Submitted at 1, the user saw it locked: an untouched relock is dropped.
    expect(fence.apply(relock, state, atOne.asOf).body).toBeNull();
    expect(fence.renderedSeen(state.seen, atOne.asOf)).toEqual({ [X]: 2 });
    // As of now, it is a deliberate edit.
    expect(fence.apply(relock, state).body).toEqual(relock);
    atZero.release();
    expect(fence.apply(relock, state, atOne.asOf).body).toBeNull();
    atOne.release();
    atOne.release();
    expect(fence.apply(relock, state, atOne.asOf).body).toEqual(relock);
  });

  it("forgets everything on detach", () => {
    const state = genesisState(emptyDocument());
    const fence = new Fence();
    const detach = fence.attach(0, {});
    fence.join(state, opState(X, { L: 2, at: 0, by: "sam", vv: {}, del: [], set: [["lk/2026-05", true]] }));
    detach();
    expect(fence.renderedRevision).toBe(fence.revision);
    expect(fence.apply({ set: [["lk/2026-05", false]], del: [] }, state).notices).toEqual([]);
  });
});



