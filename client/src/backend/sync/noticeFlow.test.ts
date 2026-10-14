import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../ApiError";
import { DocumentBackend } from "../document/DocumentBackend";
import { EPOCH, MemoryStore, device, edits, entry, expectConverged, quiesce, remarks, row, world, type Device, type DeviceOptions, type World } from "./cycleTestkit";
import { testKey } from "./localTestkit";
import { ADDED_BACK } from "./noticeActions";
import { NOTICE_CAP } from "./notices";
import { seal, unseal } from "./records";
import { genesisState, type Op } from "./state";
import { NOTICE_GONE, SyncEngine } from "./SyncEngine";
import { SyncedHost } from "./SyncedHost";
import { Replica, deviceId, emptyDocument } from "./testkit";

// Notices end to end (design sections 4, 4.1, 4.2 and 15 AC7): engines
// over the fake GitHub, joining each other's logs and snapshots in real
// cycles. The device whose concurrent write lost is told once, the notice
// survives a reload and is dismissed per device, and its action is a new
// write that reaches every device. Notices never change what any device
// shows: every scenario ends converged. Fictional data only.

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

async function open(options: DeviceOptions = {}): Promise<Device> {
  const d = await device(w, options);
  running.push(d.engine);
  return d;
}

/** A device whose requests fail while `offline.on` is set. */
function offlineSwitch() {
  const offline = { on: false };
  const wrapFetch = (inner: typeof fetch): typeof fetch => (input, request) => (offline.on ? Promise.reject(new TypeError("Failed to fetch")) : inner(input, request));
  return { offline, wrapFetch };
}

const amountOf = (d: Device, text: string) => (d.engine.current().expenses["2026-05"] ?? []).find((e) => e.remarks === text)?.amount;
const notices = (d: Device) => d.engine.notices();

/** a and b both show Groceries; then each edits its amount without seeing
 * the other's. Returns them as [loser, winner]. */
async function editClash(): Promise<[Device, Device]> {
  const a = await open({ login: "alex" });
  const b = await open({ login: "sam" });
  await a.backend.addEntry(entry("Groceries", 40));
  await quiesce(w, a, b);
  await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), edits("Groceries", 10));
  await b.backend.updateEntry(2026, 5, await row(b, "Groceries"), edits("Groceries", 12));
  await quiesce(w, a, b);
  expectConverged(a, b);
  return amountOf(a, "Groceries") === "12.00" ? [a, b] : [b, a];
}

describe("edit / edit through logs (section 4.2 rule 1, AC7)", () => {
  it("tells only the device whose value lost, once, with both values and Use mine", async () => {
    const [loser, winner] = await editClash();
    const mine = loser.login === "alex" ? "10.00" : "12.00";
    const theirs = mine === "10.00" ? "12.00" : "10.00";
    expect(winner.engine.getState().noticeCount).toBe(0);
    expect(loser.engine.getState().noticeCount).toBe(1);
    const [view] = notices(loser);
    expect(view.notice).toMatchObject({ kind: "overwrite", winner: { by: winner.login, device: winner.engine.deviceId }, registers: [{ theirs, mine }] });
    expect(view.actions).toEqual([{ kind: "useMine", writes: [{ key: expect.stringMatching(/\/amount$/), value: mine }], refused: null }]);
    // More cycles never tell it again.
    await quiesce(w, loser, winner);
    expect(loser.engine.getState().noticeCount).toBe(1);
  });

  it("Use mine writes my value again as a new op, the notice goes in the same transaction, and every device shows it with no new notice", async () => {
    const [loser, winner] = await editClash();
    const mine = loser.login === "alex" ? "10.00" : "12.00";
    const [view] = notices(loser);
    await loser.engine.noticeAction(view.key, "useMine");
    const saved = loser.store.mutations.at(-1)!;
    expect(saved.ownLog?.put).toHaveLength(1);
    expect(saved.notices?.delete).toEqual([view.key]);
    expect(loser.engine.getState().noticeCount).toBe(0);
    await quiesce(w, loser, winner);
    expectConverged(loser, winner);
    expect(amountOf(winner, "Groceries")).toBe(mine);
    // The winner's write was seen by the action: a causally later change.
    expect(winner.engine.getState().noticeCount).toBe(0);
    await expect(loser.engine.noticeAction(view.key, "useMine")).rejects.toEqual(new ApiError(404, NOTICE_GONE));
  });

  it("is kept across a reload, never told twice, and dismissed on this device only", async () => {
    const [loser, winner] = await editClash();
    loser.engine.stop();
    const again = await open({ login: loser.login, store: loser.store });
    expect(again.engine.getState().noticeCount).toBe(1);
    const [view] = notices(again);
    await quiesce(w, again, winner);
    expect(notices(again).map((n) => n.key)).toEqual([view.key]);
    await again.engine.dismissNotice(view.key);
    expect(again.engine.getState().noticeCount).toBe(0);
    expect((await again.store.load())!.notices).toEqual([]);
    // Dismissing twice is harmless; the document didn't change.
    await again.engine.dismissNotice(view.key);
    await quiesce(w, again, winner);
    expect(again.engine.getState().noticeCount).toBe(0);
    expectConverged(again, winner);
  });

  it("refuses its action on a locked month and keeps the notice; once unlocked it runs", async () => {
    const [loser, winner] = await editClash();
    const [view] = notices(loser);
    await loser.backend.setMonthLock(2026, 5, true);
    expect(notices(loser)[0].actions[0].refused).toEqual({ reason: "locked" });
    await expect(loser.engine.noticeAction(view.key, "useMine")).rejects.toMatchObject({ status: 403 });
    expect(loser.engine.getState().noticeCount).toBe(1);
    await loser.backend.setMonthLock(2026, 5, false);
    await loser.engine.noticeAction(view.key, "useMine");
    await quiesce(w, loser, winner);
    expectConverged(loser, winner);
  });
});

describe("edit / delete through logs (section 4.2 rule 2, D16)", () => {
  it("delete wins; the editing device is told, and Add it back makes a new entry on every device", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries", 40));
    await a.backend.addEntry(entry("Bus", 15));
    await quiesce(w, a, b);
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), edits("Groceries", 45));
    await b.backend.deleteEntry(2026, 5, await row(b, "Groceries"));
    await quiesce(w, a, b);
    expect(remarks(a)).toEqual(["Bus"]);
    expect(b.engine.getState().noticeCount).toBe(0);
    const [view] = notices(a);
    expect(view.notice).toMatchObject({ kind: "deleted", winner: { by: "sam" }, target: { coll: "e", month: "2026-05", name: "Groceries" } });
    expect(view.actions.map((x) => [x.kind, x.refused])).toEqual([["addBack", null]]);
    await a.engine.noticeAction(view.key, "addBack");
    await quiesce(w, a, b);
    expectConverged(a, b);
    expect(remarks(b)).toEqual(["Bus", "Groceries"]);
    expect(amountOf(b, "Groceries")).toBe("45.00");
    for (const d of [a, b]) expect(d.engine.getState().noticeCount).toBe(0);
  });
});

describe("Add it back on two told devices (F3)", () => {
  it("the first add-back settles the other device's notice; a second Add it back is refused, and there is one Groceries", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    const c = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries", 40));
    await a.backend.addEntry(entry("Bus", 15));
    await quiesce(w, a, b, c);
    // a and b each edit Groceries (different fields) while c deletes it.
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), edits("Groceries", 45));
    await b.backend.updateEntry(2026, 5, await row(b, "Groceries"), { amount: 40, remarks: "Groceries (veg)", category: "food", isCard: false });
    await c.backend.deleteEntry(2026, 5, await row(c, "Groceries"));
    await quiesce(w, a, b, c);
    const told = (d: Device) => notices(d).filter((v) => v.notice.kind === "deleted");
    expect(told(a)).toHaveLength(1);
    expect(told(b)).toHaveLength(1);
    const [onB] = told(b);
    await a.engine.noticeAction(told(a)[0].key, "addBack");
    // b hasn't joined the add-back yet: both buttons look live.
    expect(onB.actions[0].refused).toBeNull();
    await quiesce(w, a, b, c);
    expectConverged(a, b);
    expectConverged(a, c);
    // a's add-back had seen b's edit, so b's notice is settled.
    expect(told(b)).toEqual([]);
    await expect(b.engine.noticeAction(onB.key, "addBack")).rejects.toMatchObject({ status: 404 });
    expect(remarks(b)).toEqual(["Bus", "Groceries (veg)"]);
    expect(amountOf(b, "Groceries (veg)")).toBe("45.00");
  });

  it("an add-back that hadn't seen my edit leaves my notice, but its Add it back refuses: the record is back", async () => {
    const { offline, wrapFetch } = offlineSwitch();
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam", wrapFetch });
    const c = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries", 40));
    await quiesce(w, a, b, c);
    await c.backend.deleteEntry(2026, 5, await row(c, "Groceries"));
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), edits("Groceries", 45));
    // b edits offline; a and c sync, a is told and adds it back without b's edit.
    offline.on = true;
    await b.backend.updateEntry(2026, 5, await row(b, "Groceries"), { amount: 40, remarks: "Groceries (veg)", category: "food", isCard: false });
    await quiesce(w, a, c);
    const [onA] = notices(a).filter((v) => v.notice.kind === "deleted");
    await a.engine.noticeAction(onA.key, "addBack");
    await quiesce(w, a, c);
    offline.on = false;
    await quiesce(w, a, b, c);
    expectConverged(a, b);
    const [onB] = notices(b).filter((v) => v.notice.kind === "deleted");
    expect(onB.actions[0].refused).toEqual({ reason: "inEffect", detail: ADDED_BACK });
    await expect(b.engine.noticeAction(onB.key, "addBack")).rejects.toMatchObject({ status: 409 });
    await quiesce(w, a, b, c);
    expect(remarks(b)).toEqual(["Groceries"]);
  });
});

describe("whole units, a lock and a setting through logs (section 4 table)", () => {
  it("each clash tells its loser alone, and Use mine puts the whole value back everywhere", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries", 40));
    await quiesce(w, a, b);
    // a writes first, b after with greater Ls (b writes one more op first).
    await b.backend.addEntry(entry("Bus", 1));
    for (const d of [a, b]) {
      const mine = d === a;
      await d.backend.setMonthIncome(2026, 5, { salary: mine ? 60000 : 65000, otherIncome: null, savings: [] });
      await d.backend.setMonthBills(2026, 5, [{ name: "Card A", due: mine ? 100 : 120, paid: 0, dueDate: null, settled: false }]);
      // An unlock of an unlocked month changes nothing: b locks, then unlocks.
      await d.backend.setMonthLock(2026, 6, true);
      if (!mine) await d.backend.setMonthLock(2026, 6, false);
      await d.engine.amend((doc) => void (doc.settings.timeZone = mine ? "Asia/Kolkata" : "Europe/London"));
    }
    await quiesce(w, a, b);
    expectConverged(a, b);
    expect(b.engine.getState().noticeCount).toBe(0);
    const told = notices(a).map((v) => (v.notice.kind === "overwrite" ? v.notice.registers.map((r) => r.key) : []));
    expect(told.flat().sort()).toEqual(["cb/2026-05", "fm/2026-05", "lk/2026-06", "st/timeZone"]);
    for (const view of notices(a)) await a.engine.noticeAction(view.key, "useMine");
    await quiesce(w, a, b);
    expectConverged(a, b);
    const doc = b.engine.current();
    expect(doc.financeMonths["2026-05"].salary).toBe("60000.00");
    expect(doc.cardBills["2026-05"][0].due).toBe("100.00");
    expect(doc.monthLocks["2026-06"]).toBe(true);
    expect(doc.settings.timeZone).toBe("Asia/Kolkata");
    for (const d of [a, b]) expect(d.engine.getState().noticeCount).toBe(0);
  });
});

describe("payEmi / payEmi (D20)", () => {
  it("one payment is kept; the loser is told and Record again pays once more, everywhere", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEmi({ cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: null, foreclosureCharge: null });
    await quiesce(w, a, b);
    const emiRow = async (d: Device) => (await d.backend.getEmis())[0].row;
    await a.backend.payEmi(await emiRow(a), 1000);
    await b.backend.payEmi(await emiRow(b), 1000);
    await quiesce(w, a, b);
    const [loser, winner] = a.engine.getState().noticeCount === 1 ? [a, b] : [b, a];
    expect(winner.engine.getState().noticeCount).toBe(0);
    const [view] = notices(loser);
    expect(view.actions.map((x) => x.kind)).toEqual(["recordAgain", "useMine"]);
    expect(view.actions[0]).toMatchObject({ paid: "1000.00", refused: null });
    const before = Number(winner.engine.current().emis[0].remainingAsOf);
    await loser.engine.noticeAction(view.key, "recordAgain");
    await quiesce(w, a, b);
    expectConverged(a, b);
    expect(Number(winner.engine.current().emis[0].remainingAsOf)).toBeLessThan(before);
  });
});

describe("Record again across days (F5)", () => {
  it("a list left open past a due date shows what Record again writes now, and a stale button writes nothing", async () => {
    let clock = Date.UTC(2026, 5, 10, 9);
    const doc = emptyDocument();
    const g = new Replica(deviceId(0xf), doc, { actor: "alex", clock });
    await g.backend.addEmi({ cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: null, foreclosureCharge: null });
    const engine = new SyncEngine({ key: await testKey(), actor: "alex", store: new MemoryStore(), locks: null, log: () => {}, now: () => clock });
    running.push(engine);
    await engine.start();
    await engine.initialize(EPOCH, genesisState(g.doc));
    const backend = new DocumentBackend({ host: new SyncedHost(engine), now: () => clock, actor: "alex", newId: () => crypto.randomUUID() });
    const sam = new Replica(deviceId(0x5), g.doc, { actor: "sam", clock });
    await backend.payEmi((await backend.getEmis())[0].row, 1000);
    // Sam writes once more first, so Sam's payment has the greater L.
    await sam.backend.setMonthLock(2026, 1, true);
    await sam.backend.payEmi((await sam.backend.getEmis())[0].row, 1000);
    await engine.join({ ops: sam.ops.map((op): [string, Op] => [sam.device, op]) });
    const [view] = engine.notices();
    const shown = view.actions.find((x) => x.kind === "recordAgain")!;
    expect(shown.refused).toBeNull();

    // 90 days on, with nothing synced or written: the preview is worked out again.
    clock += 90 * 86_400_000;
    const [later] = engine.notices();
    expect(later).not.toBe(view);
    const now = later.actions.find((x) => x.kind === "recordAgain")!;
    expect(now.writes).not.toEqual(shown.writes);

    // The button still showing the old preview writes nothing, and the list moves on.
    const revision = engine.getState().noticeRevision;
    await expect(engine.noticeAction(view.key, "recordAgain", shown)).rejects.toMatchObject({ status: 409 });
    expect(engine.getState().noticeRevision).not.toBe(revision);
    expect(engine.getState().noticeCount).toBe(1);
    // What the button shows now is exactly what it writes.
    await engine.noticeAction(view.key, "recordAgain", now);
    const emi = engine.current().emis[0];
    expect(now.writes).toEqual([
      { key: `emi/${emi.id}/remainingAsOf`, value: emi.remainingAsOf },
      { key: `emi/${emi.id}/asOfDate`, value: emi.asOfDate },
    ]);
    expect(engine.getState().noticeCount).toBe(0);
  });
});

describe("through a snapshot (section 4.2)", () => {
  it("a write that reaches this device only in a snapshot is told, with no author", async () => {
    const { offline, wrapFetch } = offlineSwitch();
    const a = await open({ login: "alex", wrapFetch });
    const b = await open({ login: "sam", compaction: { logOps: 2 } });
    await a.backend.addEntry(entry("Groceries", 40));
    await quiesce(w, a, b);
    offline.on = true;
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), edits("Groceries", 10));
    // b's write wins (a later L) and is compacted away from its log.
    await b.backend.addEntry(entry("Bus", 1));
    await b.backend.updateEntry(2026, 5, await row(b, "Groceries"), edits("Groceries", 12));
    await quiesce(w, b);
    const log = (await unseal(w.fake.file("alex/ledger-data", `ledger/${EPOCH}.${b.engine.deviceId}.log.enc`)!.text, w.key)) as { ops: Op[]; snapThrough: number };
    expect(log.ops).toEqual([]);
    expect(log.snapThrough).toBeGreaterThan(0);
    offline.on = false;
    await quiesce(w, a, b);
    expectConverged(a, b);
    expect(amountOf(a, "Groceries")).toBe("12.00");
    const [view] = notices(a);
    expect(view.notice).toMatchObject({ kind: "overwrite", winner: { by: null, device: b.engine.deviceId }, registers: [{ theirs: "12.00", mine: "10.00" }] });
  });
});

describe("the cap and the order (section 4.2)", () => {
  it("keeps the newest 50, newest first, and stores no more", async () => {
    const store = new MemoryStore();
    const key = await testKey();
    const engine = new SyncEngine({ key, actor: "alex", store, locks: null, log: () => {} });
    running.push(engine);
    await engine.start();
    await engine.initialize(EPOCH, genesisState(emptyDocument()));
    const backend = new DocumentBackend({ host: new SyncedHost(engine), now: () => Date.UTC(2026, 4, 10), actor: "alex", newId: () => crypto.randomUUID() });
    const X = deviceId(0x5);
    const sam = new Replica(X, emptyDocument(), { actor: "sam" });
    const count = NOTICE_CAP + 5;
    for (let i = 0; i < count; i++) await backend.addEntry(entry(`E${i}`, 1));
    for (const op of engine.pushableOps()) sam.receive(engine.deviceId!, op);
    const rows = await backend.getMonth(2026, 5);
    for (const e of rows) await backend.updateEntry(2026, 5, e.row, edits(e.remarks, 2));
    // Sam is further ahead, so each of Sam's edits beats this device's.
    for (let i = 0; i < count + 2; i++) await sam.backend.setMonthLock(2026, 7, i % 2 === 0);
    const sams = await sam.backend.getMonth(2026, 5);
    for (const e of sams) await sam.backend.updateEntry(2026, 5, e.row, edits(e.remarks, 3));
    const edited = sam.ops.slice(-count);
    await engine.join({ ops: edited.slice(0, count - 1).map((op): [string, Op] => [X, op]) });
    expect(engine.getState().noticeCount).toBe(NOTICE_CAP);
    await engine.join({ ops: edited.slice(count - 1).map((op): [string, Op] => [X, op]) });
    expect(engine.getState().noticeCount).toBe(NOTICE_CAP);
    expect((await store.load())!.notices).toHaveLength(NOTICE_CAP);
    const views = engine.notices();
    // Newest first: the last edit joined is at the top, the earliest gone.
    const names = views.map((v) => (v.notice.kind === "overwrite" && v.notice.target.kind === "record" ? v.notice.target.name : null));
    expect(names[0]).toBe(`E${count - 1}`);
    expect(names).not.toContain("E0");
    expect(views.map((v) => v.notice.seq)).toEqual([...views.map((v) => v.notice.seq)].sort((p, q) => q - p));
    // The same array until something changes.
    expect(engine.notices()).toBe(views);
    await engine.dismissNotice(views[0].key);
    expect(engine.notices()).not.toBe(views);
    expect(engine.notices()).toHaveLength(NOTICE_CAP - 1);
    // About half a second alone, but past vitest's 5 s default about once in
    // five full parallel runs, beside the harness and the performance guard.
  }, 30_000);
});

describe("a stored notice this build can't read (D31)", () => {
  it("is kept byte for byte and not shown; the device loads, keeps its unpushed op and pushes it", async () => {
    const { offline, wrapFetch } = offlineSwitch();
    const a = await open({ login: "alex", wrapFetch });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries", 40));
    await a.backend.addEntry(entry("Bus", 15));
    await quiesce(w, a, b);
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), edits("Groceries", 10));
    await b.backend.updateEntry(2026, 5, await row(b, "Groceries"), edits("Groceries", 12));
    await quiesce(w, a, b);
    const loser = a.engine.getState().noticeCount === 1 ? a : b;
    expect(loser.engine.getState().noticeCount + (loser === a ? b : a).engine.getState().noticeCount).toBe(1);
    // a writes once more while offline: an op only this device holds.
    offline.on = true;
    await a.backend.updateEntry(2026, 5, await row(a, "Bus"), edits("Bus", 3));
    await quiesce(w, a);
    expect(a.engine.getState().pendingCount).toBe(1);
    a.engine.stop();
    // One of a's notice records is damaged (or a newer build's), and one is
    // a decryptable value that is no notice.
    const store = a.store;
    const damaged: [string, string][] = [
      ["5.dffffffffffffffff/4.d0000000000000001/overwrite/e/x", "not encrypted"],
      ["6.dffffffffffffffff/4.d0000000000000001/overwrite/e/x", (await store.load())!.base!],
    ];
    await store.mutate({ expect: (store.meta() as { writerToken: string }).writerToken, meta: store.meta(), notices: { put: damaged } });
    const before = new Map((await store.load())!.notices);
    offline.on = false;
    const again = await open({ login: "alex", store, wrapFetch });
    expect(again.engine.getState()).toMatchObject({ unreadable: null });
    expect(again.engine.getState().noticeCount).toBe(loser === a ? 1 : 0);
    expect(again.engine.notices().map((v) => v.key)).not.toContain(damaged[0][0]);
    expect(again.logs.some((line) => line.includes("a stored notice can't be read"))).toBe(true);
    await quiesce(w, again, b);
    expectConverged(again, b);
    expect(amountOf(b, "Bus")).toBe("3.00");
    expect(again.engine.getState().pendingCount).toBe(0);
    const after = new Map((await store.load())!.notices);
    for (const [key, text] of damaged) expect(after.get(key)).toBe(text);
    expect(after.get(damaged[0][0])).toBe(before.get(damaged[0][0]));
  });
});

describe("a key already stored is never stored again (section 4.2)", () => {
  /** An engine that edits Groceries, and Sam's edit of it that wins (a
   * greater L): the notice it raises has a key known in advance. */
  async function clash() {
    const store = new MemoryStore();
    const key = await testKey();
    const make = () => new SyncEngine({ key, actor: "alex", store, locks: null, log: () => {} });
    const engine = make();
    running.push(engine);
    await engine.start();
    await engine.initialize(EPOCH, genesisState(emptyDocument()));
    const backend = new DocumentBackend({ host: new SyncedHost(engine), now: () => Date.UTC(2026, 4, 10), actor: "alex", newId: () => crypto.randomUUID() });
    await backend.addEntry(entry("Groceries", 40)); // L 2
    const X = deviceId(0x5);
    const sam = new Replica(X, emptyDocument(), { actor: "sam" });
    for (const op of engine.pushableOps()) sam.receive(engine.deviceId!, op);
    await backend.updateEntry(2026, 5, (await backend.getMonth(2026, 5))[0].row, edits("Groceries", 10)); // L 3
    await sam.backend.setMonthLock(2026, 7, true); // L 3
    await sam.backend.updateEntry(2026, 5, (await sam.backend.getMonth(2026, 5))[0].row, edits("Groceries", 12)); // L 4
    const id = engine.current().expenses["2026-05"][0].id;
    const noticeKey = `4.${X}/3.${engine.deviceId}/overwrite/e/${id}`;
    engine.stop();
    const put = async (text: string) => store.mutate({ expect: (store.meta() as { writerToken: string }).writerToken, meta: store.meta(), notices: { put: [[noticeKey, text]] } });
    const reopen = async () => {
      const again = make();
      running.push(again);
      await again.start();
      return again;
    };
    return { store, key, sam, noticeKey, put, reopen, ops: sam.ops.map((op): [string, Op] => [X, op]) };
  }

  it("a readable notice stored under the key is left as it is when the same notice is told", async () => {
    const { store, key, noticeKey, put, reopen, ops } = await clash();
    const kept = { kind: "rehome", from: deviceId(0x1), to: deviceId(0x2), message: "Stored before.", seq: 7, at: 1 };
    const text = await seal(kept, key);
    await put(text);
    const engine = await reopen();
    expect(engine.getState().noticeCount).toBe(1);
    await engine.join({ ops });
    expect(engine.getState().noticeCount).toBe(1);
    expect(new Map((await store.load())!.notices).get(noticeKey)).toBe(text);
    expect(engine.notices()[0].notice).toMatchObject({ kind: "rehome", seq: 7 });
  });

  it("an unreadable record under the key is never written over (D31)", async () => {
    const { store, noticeKey, put, reopen, ops } = await clash();
    await put("not encrypted");
    const engine = await reopen();
    expect(engine.getState()).toMatchObject({ unreadable: null, noticeCount: 0 });
    await engine.join({ ops });
    expect(engine.getState().noticeCount).toBe(0);
    expect(new Map((await store.load())!.notices).get(noticeKey)).toBe("not encrypted");
  });
});
