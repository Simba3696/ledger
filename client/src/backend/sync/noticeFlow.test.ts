import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../ApiError";
import { DocumentBackend } from "../document/DocumentBackend";
import { EPOCH, MemoryStore, device, edits, entry, expectConverged, quiesce, remarks, row, world, type Device, type DeviceOptions, type World } from "./cycleTestkit";
import { testKey } from "./localTestkit";
import { NOTICE_CAP } from "./notices";
import { unseal } from "./records";
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
  });
});

describe("a stored notice this build can't read", () => {
  it("leaves the device unreadable, its records untouched (section 12)", async () => {
    const [loser] = await editClash();
    loser.engine.stop();
    const records = (await loser.store.load())!;
    const [[noticeKey]] = records.notices;
    const tampered = loser.store.clone();
    await tampered.mutate({ expect: (tampered.meta() as { writerToken: string }).writerToken, meta: tampered.meta(), notices: { put: [[noticeKey, (await loser.store.load())!.base!]] } });
    const again = await open({ login: loser.login, store: tampered, noSettle: true });
    expect(again.engine.getState()).toMatchObject({ status: "unreadable", unreadable: "malformed" });
  });
});
