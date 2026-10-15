import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64 } from "../base64";
import { CHAIN_START, FORMAT_VERSION, checkRepoFile, encodeState } from "./codec";
import { EPOCH, FULL, GENESIS, MemoryStore, cycle, device, edits, entry, expectConverged, logFile, nextTask, plant, puts, quiesce, remarks, row, since, world, type Device, type World } from "./cycleTestkit";
import type { RepoFile } from "./epoch";
import { unseal } from "./records";
import { repoPath } from "./repoFiles";
import { genesisState, type Op } from "./state";
import type { SyncEngine } from "./SyncEngine";
import { Rng, deviceId, testEnv } from "./testkit";

// Compaction, the gap check and cold start (design section 8), against the
// fake GitHub: a device snapshots its own log with no agreement between
// devices (8.1), a reader never joins a log across a snapshot it hasn't read
// (8.2), every device reads every log and snapshot it hasn't joined at its
// listed version, never taking a snapshot's coverage claims on its word
// (8.3, owner decision D24), and the device folds its saved tail into its
// base (8.4). Acceptance item 12: no op is lost for any reader at any point, and
// a device offline past several compactions catches up and publishes its
// own offline writes. Fictional data only.

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

async function open(options: Parameters<typeof device>[1] = {}): Promise<Device> {
  const d = await device(w, options);
  running.push(d.engine);
  return d;
}

/** Compacts once the own log holds `ops` ops. */
const every = (ops: number) => ({ compaction: { logOps: ops } });

const file = (d: Device, kind: "log" | "snap"): RepoFile => ({ kind, epoch: EPOCH, device: d.engine.deviceId! });
const stored = (d: Device, kind: "log" | "snap") => w.fake.file(FULL, repoPath(file(d, kind)));

interface LogContent {
  snapThrough: number;
  ops: Op[];
}

interface SnapContent {
  through: number;
  seen: Record<string, number>;
  joined: Record<string, string>;
}

async function repoLog(d: Device): Promise<LogContent> {
  return (await unseal(stored(d, "log")!.text, w.key)) as LogContent;
}

async function repoSnap(d: Device): Promise<SnapContent | null> {
  const snap = stored(d, "snap");
  return snap ? ((await unseal(snap.text, w.key)) as SnapContent) : null;
}

async function write(d: Device, ...texts: string[]): Promise<void> {
  for (const text of texts) await d.backend.addEntry(entry(text));
}

/** Cycles `d` until its log is trimmed to its snapshot point (a log PUT,
 * then the snap, then the trimmed log: section 7 steps 6 and 7, each a
 * PUT spaced from the last). */
async function compactNow(d: Device): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await cycle(w, d);
    const meta = d.store.meta();
    if ((meta.K as number) > 0 && meta.ownLogK === meta.K && (await d.store.load())!.ownLog.length === 0) return;
  }
  throw new Error("the device did not compact");
}

/** Lets queued work (a local compaction) run until `condition` holds; the
 * fake timers don't move. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; !(await condition()); i++) {
    if (i > 10_000) throw new Error("timed out waiting");
    await nextTask();
  }
}

const blobReads = (from: number) => since(w, from).filter((r) => r.method === "GET" && r.path.includes("/git/blobs/"));
const readsOf = (from: number, sha: string) => blobReads(from).filter((r) => r.path.endsWith(sha)).length;
const status = (d: Device) => d.engine.getState().status;

describe("compaction: own log only, with no agreement between devices (section 8.1)", () => {
  it("snapshots once the log holds the op limit: the snap first, then the log trimmed to it, each its own PUT", async () => {
    const a = await open(every(3));
    await write(a, "One", "Two", "Three");
    await cycle(w, a);
    expect(stored(a, "snap")).toBeNull();
    await cycle(w, a);
    // The snap is in; the log still holds the ops it covers (S1 duplicates).
    const snap = (await repoSnap(a))!;
    expect(snap.through).toBe(4);
    expect(snap.seen[a.engine.deviceId!]).toBe(4);
    expect((await repoLog(a)).ops.map((op) => op.L)).toEqual([2, 3, 4]);
    expect(a.store.meta()).toMatchObject({ K: 4, ownSnapSha: stored(a, "snap")!.sha });
    expect((await a.store.load())!.ownLog).toEqual([]);
    await cycle(w, a);
    expect(await repoLog(a)).toMatchObject({ snapThrough: 4, ops: [] });
    const dev8 = a.engine.deviceId!.slice(1, 9);
    expect(w.fake.commits.map((c) => c.message)).toEqual([`Sync ${dev8}`, `Snapshot ${dev8}`, `Sync ${dev8}`]);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    // Idle again: no further snapshot or PUT.
    const before = puts(w).length;
    await cycle(w, a, a, a);
    expect(puts(w).length).toBe(before);
    expect(w.fake.violations).toEqual([]);
    expect(w.fake.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("snapshots once the log's text reaches the size limit, though it holds few ops", async () => {
    const a = await open({ compaction: { logOps: 1000, logBytes: 1 } });
    await write(a, "One");
    await compactNow(a);
    expect((await repoSnap(a))!.through).toBe(2);
    expect(remarks(await open({ login: "sam" }))).toEqual(["One"]);
  });

  it("the snapshot is the device's whole state at K: other devices' data and the files it holds, checked as every reader checks it", async () => {
    const b = await open({ login: "sam" });
    await write(b, "From Sam");
    await cycle(w, b);
    const a = await open(every(2));
    await write(a, "One", "Two");
    await compactNow(a);
    const snapText = stored(a, "snap")!.text;
    expect(snapText).not.toContain("From Sam");
    const snap = (await unseal(snapText, w.key)) as SnapContent & Record<string, unknown>;
    expect(snap.joined).toMatchObject({ [GENESIS]: w.fake.file(FULL, `ledger/${GENESIS}`)!.sha, [`${EPOCH}.${b.engine.deviceId}.log.enc`]: stored(b, "log")!.sha });
    expect(checkRepoFile(file(a, "snap"), snap, genesisState(w.doc)).ok).toBe(true);
    expect((snap.state as { rec: { e: unknown[] } }).rec.e).toHaveLength(3);
  });

  it("never snapshots while an own op is unconfirmed: a push that fails, or is refused 4 times, holds the snapshot back", async () => {
    const a = await open(every(1));
    await write(a, "One");
    w.fake.failNext({ method: "PUT", network: true });
    await cycle(w, a);
    for (let i = 0; i < 4; i++) w.fake.failNext({ method: "PUT", status: 409, message: "is at 0000000000000000000000000000000000000000 but expected 1111111111111111111111111111111111111111" });
    await cycle(w, a);
    expect(a.engine.getState()).toMatchObject({ status: "pending", pendingCount: 1 });
    expect(stored(a, "snap")).toBeNull();
    expect(puts(w).filter((r) => r.path.endsWith(".snap.enc"))).toHaveLength(0);
    await compactNow(a);
    expect((await repoSnap(a))!.through).toBe(2);
  });

  it("a branch-race 409 on the snapshot PUT sends the same snapshot again, and it lands once", async () => {
    const a = await open(every(1));
    await write(a, "One");
    await cycle(w, a);
    w.fake.failNext({ method: "PUT", path: /\.snap\.enc$/, status: 409, message: "is at 0000000000000000000000000000000000000000 but expected 1111111111111111111111111111111111111111" });
    await compactNow(a);
    const sent = puts(w).filter((r) => r.path.endsWith(".snap.enc"));
    expect(sent).toHaveLength(2);
    expect(sent[1].body).toBe(sent[0].body);
    expect(w.fake.commits.filter((c) => c.message.startsWith("Snapshot"))).toHaveLength(1);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
  });

  it("writes made while the snapshot is in flight stay in the log above K and are pushed", async () => {
    const a = await open(every(2));
    await write(a, "One", "Two");
    await cycle(w, a);
    // "Three" commits after the snapshot was taken, before it is confirmed.
    const put = a.client.putFile.bind(a.client);
    vi.spyOn(a.client, "putFile").mockImplementation(async (write_) => {
      if (write_.path.endsWith(".snap.enc")) await write(a, "Three");
      return put(write_);
    });
    await cycle(w, a);
    expect(a.store.meta().K).toBe(3);
    expect((await a.store.load())!.ownLog.map(([L]) => L)).toEqual([4]);
    expect(a.engine.getState().pendingCount).toBe(1);
    await cycle(w, a);
    expect(await repoLog(a)).toMatchObject({ snapThrough: 3, ops: [expect.objectContaining({ L: 4 })] });
    const b = await open({ login: "sam" });
    expect(remarks(b)).toEqual(["One", "Two", "Three"]);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
  });

  it("an op committed while the snapshot is being taken waits for the next cycle: a snapshot never holds an own op no published log holds", async () => {
    const a = await open(every(2));
    const r = await open({ login: "sam" });
    await write(a, "One", "Two");
    await cycle(w, a); // the log [2, 3] lands; compaction waits out the PUT spacing
    await a.engine.sync();
    await cycle(w, r);
    let release!: () => void;
    a.store.hold = new Promise<void>((resolve) => (release = resolve));
    // "Three"'s transaction is in flight when the compaction checks the log.
    const three = a.backend.addEntry(entry("Three"));
    for (let i = 0; i < 50; i++) await nextTask();
    w.clock.mono += 10_000;
    const sync = a.engine.sync();
    for (let i = 0; i < 50; i++) await nextTask();
    a.store.hold = null;
    release();
    await sync;
    await three;
    const snap = await repoSnap(a);
    const log = await repoLog(a);
    expect(snap === null || snap.through <= (log.ops.at(-1)?.L ?? log.snapThrough)).toBe(true);
    expect(a.engine.getState().pendingCount).toBe(1);
    // Closed before anything more is sent: every reader, old or new, holds
    // the same history from it.
    a.engine.stop();
    const c = await open({ login: "sam" });
    await quiesce(w, r, c);
    expectConverged(r, c);
    expect(remarks(c)).toEqual(["One", "Two"]);
    // Back again, it publishes "Three", then compacts.
    const again = await open({ ...every(2), store: a.store });
    await compactNow(again);
    await quiesce(w, r, c, again);
    expectConverged(r, c, again);
    expect(remarks(c)).toEqual(["One", "Two", "Three"]);
  });

  it("an op committed while a reloaded tab reads the genesis for its snapshot waits for the next cycle", async () => {
    const a = await open({ compaction: { logOps: 1000 } });
    await write(a, "One", "Two");
    await cycle(w, a);
    const b = await open({ login: "sam" });
    expect(remarks(b)).toEqual(["One", "Two"]);
    a.engine.stop();
    const genesisSha = w.fake.file(FULL, `ledger/${GENESIS}`)!.sha;
    let ready!: (d: Device) => void;
    const opened = new Promise<Device>((resolve) => (ready = resolve));
    let armed = true;
    const wrapFetch =
      (inner: typeof fetch): typeof fetch =>
      async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (armed && (init?.method ?? "GET") === "GET" && url.includes("/git/blobs/") && url.endsWith(genesisSha)) {
          armed = false;
          await write(await opened, "Three");
        }
        return inner(input, init);
      };
    w.clock.mono += 10_000;
    const a2 = await open({ store: a.store, ...every(2), wrapFetch, noSettle: true });
    ready(a2);
    await a2.engine.sync();
    expect(armed).toBe(false);
    const snap = await repoSnap(a2);
    const log = await repoLog(a2);
    expect(snap === null || snap.through <= (log.ops.at(-1)?.L ?? log.snapThrough)).toBe(true);
    // Retired now: whatever it published, old and new readers hold the same.
    a2.engine.stop();
    const c = await open({ login: "sam" });
    await quiesce(w, b, c);
    expectConverged(b, c);
  });
});

describe("compaction crash points: no reader ever loses an op (AC12)", () => {
  /** A device that has seen nothing of `a` yet, and a fresh one: both
   * must show everything `a` has published so far. */
  async function readersSee(texts: string[]): Promise<void> {
    const fresh = await open({ login: "sam" });
    expect(remarks(fresh)).toEqual(texts);
  }

  it("the snap lands but its answer is lost and the tab closes: the next start confirms it by its listed sha, then trims", async () => {
    const store = new MemoryStore();
    const behind = await open({ login: "sam" });
    const a = await open({ ...every(3), store });
    await write(a, "One", "Two", "Three");
    await cycle(w, a);
    w.fake.landThenDropResponse({ method: "PUT", path: /\.snap\.enc$/ });
    await cycle(w, a);
    expect(stored(a, "snap")).not.toBeNull();
    expect(store.meta()).toMatchObject({ K: 0, lastSentSnapSha: stored(a, "snap")!.sha, lastSentSnapThrough: 4 });
    await readersSee(["One", "Two", "Three"]);
    a.engine.stop();
    const again = await open({ ...every(3), store });
    await cycle(w, again);
    expect(store.meta()).toMatchObject({ K: 4, ownSnapSha: stored(again, "snap")!.sha });
    expect(await repoLog(again)).toMatchObject({ snapThrough: 4, ops: [] });
    // One snapshot PUT in all: the confirmation needed no second one.
    expect(puts(w).filter((r) => r.path.endsWith(".snap.enc"))).toHaveLength(1);
    await readersSee(["One", "Two", "Three"]);
    await cycle(w, behind);
    expect(remarks(behind)).toEqual(["One", "Two", "Three"]);
  });

  it("a snap that landed unseen, whose send a reload then replaced, is confirmed by reading it back: its chain is this device's", async () => {
    const store = new MemoryStore();
    const a = await open({ ...every(3), store });
    await write(a, "One", "Two", "Three");
    await cycle(w, a);
    w.fake.landThenDropResponse({ method: "PUT", path: /\.snap\.enc$/ });
    await cycle(w, a);
    const landed = stored(a, "snap")!.sha;
    a.engine.stop();
    // Reads by branch lag one commit: the new tab doesn't see the snap, and
    // sends a snapshot of its own (new bytes), which the repo refuses.
    w.fake.staleReads(1);
    const again = await open({ ...every(3), store });
    await cycle(w, again);
    expect(store.meta()).toMatchObject({ K: 0 });
    expect(store.meta().lastSentSnapSha).not.toBe(landed);
    w.fake.staleReads(0);
    await cycle(w, again, again);
    expect(store.meta()).toMatchObject({ K: 4, ownSnapSha: landed });
    expect(stored(again, "snap")!.sha).toBe(landed);
    expect(await repoLog(again)).toMatchObject({ snapThrough: 4, ops: [] });
    expect(again.engine.deviceId).toBe(a.engine.deviceId);
    await readersSee(["One", "Two", "Three"]);
  });

  it("the snap never lands and the tab closes: the next start sends it again", async () => {
    const store = new MemoryStore();
    const a = await open({ ...every(3), store });
    await write(a, "One", "Two", "Three");
    await cycle(w, a);
    w.fake.failNext({ method: "PUT", path: /\.snap\.enc$/, network: true });
    await cycle(w, a);
    expect(stored(a, "snap")).toBeNull();
    a.engine.stop();
    const again = await open({ ...every(3), store });
    await compactNow(again);
    await readersSee(["One", "Two", "Three"]);
  });

  it("killed after the snap is confirmed, before the trim: the next start sends the trimmed log", async () => {
    const store = new MemoryStore();
    const behind = await open({ login: "sam" });
    const a = await open({ ...every(3), store });
    await write(a, "One", "Two", "Three");
    await cycle(w, a, a);
    expect(store.meta().K).toBe(4);
    expect((await repoLog(a)).snapThrough).toBe(0);
    await readersSee(["One", "Two", "Three"]);
    a.engine.stop();
    const again = await open({ ...every(3), store });
    await cycle(w, again);
    expect(await repoLog(again)).toMatchObject({ snapThrough: 4, ops: [] });
    await readersSee(["One", "Two", "Three"]);
    await cycle(w, behind);
    expect(remarks(behind)).toEqual(["One", "Two", "Three"]);
  });

  it("the trim lands but its answer is lost: the next cycle recognises it, and nothing is sent again", async () => {
    const a = await open(every(3));
    await write(a, "One", "Two", "Three");
    await cycle(w, a, a);
    w.fake.landThenDropResponse({ method: "PUT", path: /\.log\.enc$/ });
    await cycle(w, a);
    expect(await repoLog(a)).toMatchObject({ snapThrough: 4, ops: [] });
    const before = puts(w).length;
    await cycle(w, a, a);
    expect(puts(w).length).toBe(before);
    expect(a.store.meta()).toMatchObject({ ownLogK: 4, ownLogSha: stored(a, "log")!.sha });
    await readersSee(["One", "Two", "Three"]);
  });

  it("a trim that landed unseen, whose send a reload then replaced, is recognised by reading it back: its snapThrough is newer", async () => {
    const store = new MemoryStore();
    const a = await open({ ...every(3), store });
    await write(a, "One", "Two", "Three");
    await cycle(w, a, a);
    w.fake.landThenDropResponse({ method: "PUT", path: /\.log\.enc$/ });
    await cycle(w, a);
    const trimmed = stored(a, "log")!.sha;
    expect(store.meta()).toMatchObject({ ownLogK: 0, lastSentLogSha: trimmed });
    a.engine.stop();
    // The new tab doesn't see the trim, and sends one of its own (new
    // bytes, the same ops and snapThrough), which the repo refuses.
    w.fake.staleReads(1);
    const again = await open({ ...every(3), store });
    expect(store.meta().lastSentLogSha).not.toBe(trimmed);
    w.fake.staleReads(0);
    await cycle(w, again);
    expect(store.meta()).toMatchObject({ ownLogSha: trimmed, ownLogThrough: 4, ownLogK: 4 });
    // Settled: nothing more is sent.
    const before = puts(w).length;
    await cycle(w, again, again);
    expect(puts(w).length).toBe(before);
    expect(again.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    await readersSee(["One", "Two", "Three"]);
  });

  it("after the trim, a reload changes nothing and readers see everything", async () => {
    const store = new MemoryStore();
    const a = await open({ ...every(3), store });
    await write(a, "One", "Two", "Three");
    await compactNow(a);
    a.engine.stop();
    const before = puts(w).length;
    const again = await open({ ...every(3), store });
    await cycle(w, again);
    expect(puts(w).length).toBe(before);
    expect(remarks(again)).toEqual(["One", "Two", "Three"]);
    await write(again, "Four");
    await cycle(w, again);
    expect(await repoLog(again)).toMatchObject({ snapThrough: 4, ops: [expect.objectContaining({ L: 5 })] });
    await readersSee(["One", "Two", "Three", "Four"]);
  });
});

describe("the gap check (section 8.2)", () => {
  it("a reader behind K reads the snapshot first, then the log above it", async () => {
    const a = await open(every(3));
    const b = await open({ login: "sam" });
    await write(a, "One", "Two", "Three");
    await compactNow(a);
    await write(a, "Four");
    await cycle(w, a);
    const from = w.fake.requests.length;
    await cycle(w, b);
    expect(readsOf(from, stored(a, "snap")!.sha)).toBe(1);
    expect(remarks(b)).toEqual(["One", "Two", "Three", "Four"]);
    expect(b.engine.getState()).toMatchObject({ status: "idle" });
    expect(b.store.meta().joined).toMatchObject({ [`${EPOCH}.${a.engine.deviceId}.snap.enc`]: stored(a, "snap")!.sha });
  });

  it("a reader already past K doesn't need the snapshot to join the log, but reads it once, so it holds what a cold start holds (D24)", async () => {
    const a = await open(every(3));
    const b = await open({ login: "sam" });
    await write(a, "One", "Two", "Three");
    await cycle(w, a);
    await cycle(w, b);
    await compactNow(a);
    await write(a, "Four");
    await cycle(w, a);
    let from = w.fake.requests.length;
    await cycle(w, b);
    expect(readsOf(from, stored(a, "snap")!.sha)).toBe(1);
    expect(remarks(b)).toEqual(["One", "Two", "Three", "Four"]);
    await write(a, "Five");
    await cycle(w, a);
    from = w.fake.requests.length;
    await cycle(w, b);
    expect(readsOf(from, stored(a, "snap")!.sha)).toBe(0);
    expect(remarks(b)).toEqual(["One", "Two", "Three", "Four", "Five"]);
  });

  it("a snapshot older than the log's snapThrough (a stale read) is joined, the log waits, saving, until the newer snapshot is read", async () => {
    const a = await open(every(2));
    const b = await open({ login: "sam" });
    await write(a, "One", "Two");
    await compactNow(a);
    const older = stored(a, "snap")!.text;
    await write(a, "Three", "Four");
    await compactNow(a);
    const newer = stored(a, "snap")!.text;
    await plant(w, file(a, "snap"), older);
    await cycle(w, b);
    expect(status(b)).toBe("saving");
    expect(remarks(b)).toEqual(["One", "Two"]);
    // The listed log is not joined across the gap.
    const joined = b.store.meta().joined as Record<string, string>;
    expect(joined[`${EPOCH}.${a.engine.deviceId}.log.enc`]).not.toBe(stored(a, "log")!.sha);
    await cycle(w, b);
    expect(status(b)).toBe("saving");
    await plant(w, file(a, "snap"), newer);
    await cycle(w, b);
    expect(remarks(b)).toEqual(["One", "Two", "Three", "Four"]);
    expect(b.engine.getState()).toMatchObject({ status: "idle" });
    // The device whose snapshot was set back is not misled by it.
    await cycle(w, a);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
  });

  it("a snapshot that can't be read halts only its stream; it heals once a valid one is listed", async () => {
    const a = await open(every(2));
    const c = await open({ login: "sam" });
    const b = await open({ login: "sam" });
    await write(a, "One", "Two");
    await compactNow(a);
    const good = stored(a, "snap")!.text;
    await plant(w, file(a, "snap"), { fv: 1, kind: "snap", epoch: EPOCH, device: a.engine.deviceId });
    await write(c, "From c");
    await cycle(w, c);
    await cycle(w, b);
    expect(status(b)).toBe("needsAttention");
    expect(remarks(b)).toEqual(["From c"]);
    await plant(w, file(a, "snap"), good);
    await cycle(w, b);
    expect(remarks(b).sort()).toEqual(["From c", "One", "Two"]);
    expect(status(b)).toBe("idle");
  });

  it("a log waiting on a snapshot that can't be read is downloaded once, not on every poll, and is joined once a valid one is listed", async () => {
    const a = await open(every(2));
    const b = await open({ login: "sam" });
    await write(a, "One", "Two");
    await compactNow(a);
    const good = stored(a, "snap")!.text;
    await plant(w, file(a, "snap"), { fv: 1, kind: "snap", epoch: EPOCH, device: a.engine.deviceId });
    await cycle(w, b);
    expect(status(b)).toBe("needsAttention");
    const logSha = stored(a, "log")!.sha;
    const from = w.fake.requests.length;
    await cycle(w, b);
    await cycle(w, b);
    await cycle(w, b);
    // Each poll lists again (the head isn't handled), and reads nothing.
    expect(readsOf(from, logSha)).toBe(0);
    expect(blobReads(from)).toEqual([]);
    expect(since(w, from).filter((r) => r.method === "GET" && r.path.includes("/git/trees/")).length).toBe(3);
    await plant(w, file(a, "snap"), good);
    await cycle(w, b);
    expect(remarks(b)).toEqual(["One", "Two"]);
    expect(status(b)).toBe("idle");
  });
});

describe("cold start and offline catch-up (section 8.3)", () => {
  it("a snapshot no listed log needs is still read, once (D24), and a garbage one halts nothing", async () => {
    const a = await open(every(2));
    await write(a, "One", "Two");
    await compactNow(a);
    // Larger than a's (random padding doesn't compress), and no log names it.
    const X = deviceId(0xc);
    const padding = bytesToBase64(crypto.getRandomValues(new Uint8Array(20_000)));
    const garbage = await plant(w, { kind: "snap", epoch: EPOCH, device: X }, { fv: 1, kind: "snap", epoch: EPOCH, device: X, padding });
    let from = w.fake.requests.length;
    const fresh = await open({ login: "sam" });
    expect(readsOf(from, garbage)).toBe(1);
    expect(readsOf(from, stored(a, "snap")!.sha)).toBe(1);
    expect(remarks(fresh)).toEqual(["One", "Two"]);
    expect(fresh.engine.getState()).toMatchObject({ status: "idle" });
    // Its refusal is remembered by sha: it isn't read again.
    await write(a, "Three");
    await cycle(w, a);
    from = w.fake.requests.length;
    await cycle(w, fresh);
    expect(readsOf(from, garbage)).toBe(0);
    expect(remarks(fresh)).toEqual(["One", "Two", "Three"]);
    expect(fresh.engine.getState()).toMatchObject({ status: "idle" });
  });

  it("a device offline past 5 compactions catches up, and its offline writes are published (AC12)", async () => {
    const a = await open(every(2));
    const b = await open({ login: "sam" });
    await write(b, "Offline 1");
    for (let round = 1; round <= 5; round++) {
      await write(a, `Round ${round}a`, `Round ${round}b`);
      await compactNow(a);
    }
    expect(w.fake.commits.filter((c) => c.message.startsWith("Snapshot")).length).toBe(5);
    await write(b, "Offline 2");
    await quiesce(w, a, b);
    expectConverged(a, b);
    expect(remarks(a)).toEqual(expect.arrayContaining(["Offline 1", "Offline 2", "Round 1a", "Round 5b"]));
    expect(remarks(a)).toHaveLength(12);
    for (const d of [a, b]) expect(d.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    expect(w.fake.violations).toEqual([]);
  });

  it("two devices both compacting converge, each joining the other through its snapshot when behind", async () => {
    const a = await open({ ...every(2), login: "alex" });
    const b = await open({ ...every(2), login: "sam" });
    for (let round = 1; round <= 3; round++) {
      await write(a, `A${round}x`, `A${round}y`);
      await write(b, `B${round}x`, `B${round}y`);
      await compactNow(a);
      await compactNow(b);
    }
    await quiesce(w, a, b);
    expectConverged(a, b);
    expect(remarks(a)).toHaveLength(12);
    const fresh = await open({ login: "sam" });
    expectConverged(a, fresh);
  });
});

describe("forks across compaction (section 10.3)", () => {
  it("a clone that compacts under the shared id: the original finds the fork from the snapshot, rehomes through it, and nothing is lost", async () => {
    const a = await open(every(2));
    await write(a, "Before");
    await cycle(w, a);
    const twin = await open({ ...every(2), store: a.store.clone() });
    await write(twin, "Copy 1", "Copy 2");
    await compactNow(twin);
    const old = a.engine.deviceId;
    await write(a, "Original");
    await cycle(w, a);
    expect(a.engine.deviceId).not.toBe(old);
    expect(a.logs.some((l) => l.includes("own snapshot in the repo is not its history"))).toBe(true);
    const b = await open({ login: "sam" });
    await quiesce(w, a, twin, b);
    expectConverged(a, twin, b);
    expect(remarks(b).sort()).toEqual(["Before", "Copy 1", "Copy 2", "Original"]);
    expect(w.fake.violations).toEqual([]);
  });

  it("a device that compacted and is then cloned: the rehome's cold join reads the old id's snapshot, so only the forked op is re-issued", async () => {
    const a = await open(every(2));
    await write(a, "One", "Two");
    await compactNow(a);
    const twin = await open({ ...every(2), store: a.store.clone() });
    await write(a, "Original");
    await cycle(w, a);
    await write(twin, "Copy");
    await cycle(w, twin);
    expect(twin.engine.deviceId).not.toBe(a.engine.deviceId);
    const reissued = await repoLog(twin);
    // Only the copy's own op at L 4 differs from the rebuilt state; the
    // compacted ops at L 2 and 3 came back through the snapshot.
    expect(reissued.ops.map((op) => op.L)).toEqual([4]);
    await quiesce(w, a, twin);
    expectConverged(a, twin);
    expect(remarks(a).sort()).toEqual(["Copy", "One", "Original", "Two"]);
  });
  it("a clone's op under the shared id, carried in a third device's snapshot, is found as a fork before that snapshot is joined: the original's own write at the same L is kept", async () => {
    const a = await open({ login: "alex" });
    await write(a, "Before");
    await cycle(w, a);
    const twin = await open({ login: "alex", store: a.store.clone() });
    await write(twin, "Copy");
    await cycle(w, twin);
    const x = await open({ ...every(1), login: "sam" });
    await write(x, "From x");
    await compactNow(x);
    expect(JSON.stringify((await repoSnap(x))!.seen)).toContain(a.engine.deviceId!);
    // The original writes at the same L as the clone did: an equal tag.
    await write(a, "Original");
    expect(a.engine.pushableOps().at(-1)!.L).toBe(twin.engine.pushableOps().at(-1)!.L);
    await cycle(w, a);
    expect(a.logs.some((l) => l.includes("syncs on as a new device"))).toBe(true);
    expect(a.logged.find((l) => l.message.includes("syncs on as a new device"))?.level).toBe("warn");
    await quiesce(w, a, twin, x);
    expectConverged(a, twin, x);
    expect(remarks(x).sort()).toEqual(["Before", "Copy", "From x", "Original"]);
  });
});

describe("file bounds: a device never publishes an own file every reader would refuse", () => {
  /** `n` characters that don't compress, so a file's size follows them. */
  function noise(n: number): string {
    const abc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    let out = "";
    for (const b of bytes) out += abc[b % 62];
    return out;
  }
  /** A build that reads repo files up to 80 KB: it writes its own up to
   * 40 KB, and reads its own back up to 160 KB. */
  const small = { fileBounds: { bytes: 80_000, plainBytes: 640_000 } };

  it("a snapshot past the bound is not published and the log not trimmed: a new device still gets every op", async () => {
    const a = await open({ ...small, ...every(1) });
    await write(a, "Big1 " + noise(25_000));
    await compactNow(a);
    const first = stored(a, "snap")!;
    const K = a.store.meta().K;
    await write(a, "Big2 " + noise(20_000), "Small");
    for (let i = 0; i < 6; i++) await cycle(w, a);
    // The state now holds more than a snapshot may: the log stays as it is.
    expect(stored(a, "snap")!.sha).toBe(first.sha);
    expect(a.store.meta().K).toBe(K);
    expect((await repoLog(a)).ops).toHaveLength(2);
    expect(a.logs.some((l) => l.includes("snapshot would be refused"))).toBe(true);
    // A real failure: logged as an error, never as routine progress.
    expect(a.logged.filter((l) => l.message.includes("snapshot would be refused")).map((l) => l.level)).toEqual(["error"]);
    for (const kind of ["log", "snap"] as const) expect(stored(a, kind)!.text.length).toBeLessThanOrEqual(40_000);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    const c = await open({ ...small, login: "sam" });
    expect(remarks(c).map((r) => r.split(" ")[0])).toEqual(["Big1", "Big2", "Small"]);
    expect(c.engine.getState()).toMatchObject({ status: "idle" });
  });

  it("an own log past the bound is never sent: needsAttention, local writes go on, and other devices' changes still arrive", async () => {
    const a = await open(small);
    const r = await open({ ...small, login: "sam" });
    await write(a, "Huge " + noise(50_000));
    const before = puts(w).length;
    await cycle(w, a);
    expect(puts(w).length).toBe(before);
    expect(stored(a, "log")).toBeNull();
    expect(a.engine.getState()).toMatchObject({ status: "needsAttention", pendingCount: 1 });
    expect(a.logs.some((l) => l.includes("own log would be refused"))).toBe(true);
    expect(new Set(a.logged.filter((l) => l.message.includes("own log would be refused")).map((l) => l.level))).toEqual(new Set(["error"]));
    await write(a, "Still saved");
    await write(r, "From sam");
    await cycle(w, r, a);
    expect(remarks(a).map((x) => x.split(" ")[0]).sort()).toEqual(["From", "Huge", "Still"]);
    expect(a.engine.getState()).toMatchObject({ status: "needsAttention", pendingCount: 2 });
    expect(puts(w).length).toBe(before + 1);
  });

  it("an own snapshot larger than this build reads, sent by a build that writes larger ones, is read back as its own: no rehome", async () => {
    const store = new MemoryStore();
    const a = await open({ ...every(1), store });
    await write(a, "Big " + noise(30_000));
    await cycle(w, a);
    w.fake.landThenDropResponse({ method: "PUT", path: /\.snap\.enc$/ });
    await cycle(w, a);
    const landed = stored(a, "snap")!;
    expect(landed.text.length).toBeGreaterThan(24_000);
    const id = a.engine.deviceId;
    a.engine.stop();
    // A reload that doesn't see it sends a snapshot of its own (new bytes),
    // which the repo refuses.
    w.fake.staleReads(1);
    const again = await open({ ...every(1), store });
    expect(store.meta().lastSentSnapSha).not.toBe(landed.sha);
    again.engine.stop();
    w.fake.staleReads(0);
    // Then a build that reads files only up to 24 KB.
    const older = await open({ ...every(1), store, fileBounds: { bytes: 24_000, plainBytes: 640_000 } });
    await cycle(w, older);
    expect(older.engine.deviceId).toBe(id);
    expect(store.meta()).toMatchObject({ K: 2, ownSnapSha: landed.sha });
    expect(older.logs.some((l) => l.includes("not its history"))).toBe(false);
  });

  it("an own log larger than this build reads, sent by a build that writes larger ones, is read back as its own: no rehome", async () => {
    const store = new MemoryStore();
    const off = { compaction: { logOps: 1000, logBytes: 10_000_000 } };
    const a = await open({ ...off, store });
    await write(a, "Big " + noise(30_000));
    w.fake.landThenDropResponse({ method: "PUT", path: /\.log\.enc$/ });
    await cycle(w, a);
    const landed = stored(a, "log")!;
    expect(landed.text.length).toBeGreaterThan(24_000);
    const id = a.engine.deviceId;
    a.engine.stop();
    w.fake.staleReads(1);
    const again = await open({ ...off, store });
    expect(store.meta().lastSentLogSha).not.toBe(landed.sha);
    again.engine.stop();
    w.fake.staleReads(0);
    const older = await open({ ...off, store, fileBounds: { bytes: 24_000, plainBytes: 640_000 } });
    await cycle(w, older);
    expect(older.engine.deviceId).toBe(id);
    expect(store.meta()).toMatchObject({ ownLogSha: landed.sha, ownLogThrough: 2 });
    expect(older.engine.getState()).toMatchObject({ pendingCount: 0 });
  });

  it("a confirmed own log past this build's write bound is due for compaction, not a failed cycle: a snapshot past it too leaves the device idle", async () => {
    const store = new MemoryStore();
    const a = await open({ store, compaction: { logOps: 1000, logBytes: 10_000_000 } });
    await write(a, "Big " + noise(30_000));
    await cycle(w, a);
    expect(stored(a, "log")!.text.length).toBeGreaterThan(24_000);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    a.engine.stop();
    // A build that writes files only up to 24 KB, with the default limits.
    const older = await open({ store, fileBounds: { bytes: 48_000, plainBytes: 640_000 } });
    for (let i = 0; i < 3; i++) await cycle(w, older);
    expect(older.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    expect(older.logs.some((l) => l.includes("sync failed"))).toBe(false);
    expect(older.logs.filter((l) => l.includes("snapshot would be refused"))).toHaveLength(1);
    expect(stored(a, "snap")).toBeNull();
  });

  it("a confirmed own log past this build's write bound is compacted when its snapshot fits: the log is trimmed", async () => {
    const store = new MemoryStore();
    const a = await open({ store, compaction: { logOps: 1000, logBytes: 10_000_000 } });
    await write(a, "Note");
    for (let i = 0; i < 3; i++) await a.backend.updateEntry(2026, 5, await row(a, remarks(a)[0]), edits(`Note ${i} ${noise(12_000)}`, 10));
    await cycle(w, a);
    expect(stored(a, "log")!.text.length).toBeGreaterThan(24_000);
    const last = store.meta().ownLogThrough;
    a.engine.stop();
    const older = await open({ store, fileBounds: { bytes: 48_000, plainBytes: 640_000 } });
    for (let i = 0; i < 6; i++) await cycle(w, older);
    expect(older.logs.some((l) => l.includes("sync failed"))).toBe(false);
    expect(store.meta()).toMatchObject({ K: last, ownLogK: last, ownLogThrough: last });
    expect((await repoLog(older)).ops).toHaveLength(0);
    expect(stored(older, "snap")!.text.length).toBeLessThanOrEqual(24_000);
    expect(older.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    const c = await open({ login: "sam" });
    expect(remarks(c)).toEqual(remarks(older));
  });
});

describe("a snapshot's seen and joined name only devices and files the repo lists", () => {
  const hex = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

  /** Plants `x`'s snapshot again under the name of a device `z`, changed by
   * `edit`, with a log for `z` trimmed to it: a snapshot every reader's gap
   * check (section 8.2) reads. */
  async function plantFromSnap(x: Device, edit: (snap: SnapContent & Record<string, unknown>) => void): Promise<string> {
    const snap = (await unseal(stored(x, "snap")!.text, w.key)) as SnapContent & Record<string, unknown>;
    const z = `d${hex()}`;
    snap.device = z;
    snap.seen[z] = snap.through;
    edit(snap);
    snap.seen = Object.fromEntries(Object.entries(snap.seen).sort(([a], [b]) => (a < b ? -1 : 1)));
    await plant(w, { kind: "snap", epoch: EPOCH, device: z }, snap);
    await plant(w, { kind: "log", epoch: EPOCH, device: z }, logFile(z, [], { snapThrough: snap.through, chain: snap.chain }));
    return z;
  }

  it("a snapshot whose seen names thousands of devices with no file is refused: a reader's later writes still push", async () => {
    const x = await open({ ...every(1), login: "sam" });
    await write(x, "From x");
    await compactNow(x);
    const z = await plantFromSnap(x, (snap) => {
      for (let i = 0; i < 5200; i++) snap.seen[`d${hex()}`] = 1;
    });
    const planted = w.fake.file(FULL, repoPath({ kind: "snap", epoch: EPOCH, device: z }))!;
    expect(planted.text.length).toBeLessThan(80_000);
    // A build that reads files up to 80 KB, so every reader could read it.
    const r = await open({ fileBounds: { bytes: 80_000, plainBytes: 640_000 }, login: "alex" });
    expect(remarks(r)).toEqual(["From x"]);
    const before = puts(w).length;
    await write(r, "Mine");
    await cycle(w, r);
    await cycle(w, r);
    expect(puts(w).length).toBeGreaterThan(before);
    // Only z's stream halts, on the snapshot its log needs.
    expect(r.engine.getState()).toMatchObject({ status: "needsAttention", pendingCount: 0 });
    const s = await open({ login: "sam" });
    expect(remarks(s).sort()).toEqual(["From x", "Mine"]);
    expect(r.logs.some((l) => l.includes("no file in the repo"))).toBe(true);
  });

  it("a snapshot refused because its seen names a device with no file is checked again against every listing: once that device is listed, a tab that refused it joins it as a cold start does", async () => {
    const x = await open({ ...every(1), login: "sam" });
    await write(x, "From x");
    await compactNow(x);
    const q = await open({ login: "alex" }); // no file yet
    const snap = (await unseal(stored(x, "snap")!.text, w.key)) as SnapContent & { device: string; state: { rec: { e: { v: Record<string, unknown> }[] } } };
    const z = `d${hex()}`;
    snap.device = z;
    snap.seen[z] = snap.through;
    snap.seen[q.engine.deviceId!] = 1;
    snap.seen = Object.fromEntries(Object.entries(snap.seen).sort(([a], [b]) => (a < b ? -1 : 1)));
    snap.state.rec.e.find((rec) => rec.v.remarks === "From x")!.v.remarks = "~forged";
    const zSnap: RepoFile = { kind: "snap", epoch: EPOCH, device: z };
    expect(checkRepoFile(zSnap, snap, genesisState(w.doc)).ok).toBe(true);
    // No log needs it.
    await plant(w, zSnap, snap);
    const zSha = w.fake.file(FULL, repoPath(zSnap))!.sha;
    const r = await open({ login: "sam" });
    expect(r.logs.some((l) => l.includes("no file in the repo"))).toBe(true);
    expect(remarks(r)).toEqual(["From x"]);
    expect(status(r)).toBe("idle");
    // Another commit while q is still unlisted: checked again, not downloaded again.
    await write(x, "More");
    await cycle(w, x);
    let from = w.fake.requests.length;
    await cycle(w, r);
    expect(readsOf(from, zSha)).toBe(0);
    expect(remarks(r).sort()).toEqual(["From x", "More"]);
    // q's file is listed: the snapshot now passes, and r joins it.
    await write(q, "From q");
    await cycle(w, q);
    from = w.fake.requests.length;
    await cycle(w, r);
    expect(readsOf(from, zSha)).toBe(1);
    const c = await open({ login: "sam" }); // cold start
    await quiesce(w, x, q, r, c);
    for (const d of [x, q, r, c]) expect(status(d)).toBe("idle");
    expect(remarks(c)).toContain("~forged");
    expectConverged(r, c);
    expectConverged(x, q, c);
    // A reload changes nothing.
    r.engine.stop();
    const again = await open({ store: r.store, login: "sam" });
    await quiesce(w, again, c);
    expectConverged(again, c);
  });

  it("a snapshot's joined map is never taken: names no file lists never reach the reader's meta or its own snapshot", async () => {
    const x = await open({ ...every(1), login: "sam" });
    await write(x, "From x");
    await compactNow(x);
    const phantoms = Array.from({ length: 50 }, () => `${EPOCH}.d${hex()}.log.enc`);
    await plantFromSnap(x, (snap) => {
      for (const name of phantoms) snap.joined[name] = "0".repeat(40);
    });
    const r = await open({ ...every(1), login: "alex" });
    expect(remarks(r)).toEqual(["From x"]);
    expect(Object.keys(r.store.meta().joined as Record<string, string>).filter((name) => phantoms.includes(name))).toEqual([]);
    await write(r, "Mine");
    await compactNow(r);
    expect(Object.keys((await repoSnap(r))!.joined).filter((name) => phantoms.includes(name))).toEqual([]);
  });
});

describe("a snapshot's coverage claims are never trusted (owner decision D24)", () => {
  const logName = (d: Device) => `${EPOCH}.${d.engine.deviceId}.log.enc`;

  /** Re-plants `author`'s snapshot (validly encrypted, and valid to every
   * check a reader runs) claiming coverage of `other`'s ops that its state
   * doesn't hold: `seen` through `other`'s greatest L, and/or `other`'s
   * listed log as joined. */
  async function overClaim(author: Device, other: Device, claims: { seen?: boolean; joined?: boolean }): Promise<void> {
    const snap = (await unseal(stored(author, "snap")!.text, w.key)) as SnapContent & { maxL: number };
    const L = other.store.meta().ownMaxL as number;
    if (claims.seen) {
      snap.seen[other.engine.deviceId!] = L;
      snap.seen = Object.fromEntries(Object.entries(snap.seen).sort(([a], [b]) => (a < b ? -1 : 1)));
      snap.maxL = Math.max(snap.maxL, L);
    }
    if (claims.joined) snap.joined[logName(other)] = stored(other, "log")!.sha;
    expect(checkRepoFile(file(author, "snap"), snap, genesisState(w.doc)).ok).toBe(true);
    await plant(w, file(author, "snap"), snap);
  }

  it.each([
    ["seen", { seen: true }],
    ["joined", { joined: true }],
    ["seen and joined", { seen: true, joined: true }],
  ])("a snapshot over-claiming %s for another device's log: a cold start still reads that log, and the devices converge", async (_, claims) => {
    const y = await open({ ...every(1), login: "sam" });
    await write(y, "From y");
    await compactNow(y);
    y.engine.stop();
    const x = await open({ login: "alex" });
    await write(x, "From x 1", "From x 2");
    await cycle(w, x);
    await overClaim(y, x, claims);
    const fresh = await open({ login: "sam" });
    expect(remarks(fresh).sort()).toEqual(["From x 1", "From x 2", "From y"]);
    await quiesce(w, x, fresh);
    expectConverged(x, fresh);
    expect(fresh.engine.getState()).toMatchObject({ status: "idle" });
  });

  it("a snapshot over-claiming seen, read to close its own device's gap, can't make a device back from offline skip another device's snapshot", async () => {
    const r = await open({ login: "alex" });
    const pair = [await open({ ...every(2), login: "sam" }), await open({ ...every(2), login: "sam" })];
    // y's log is read before x's: the listing is in name order.
    const [y, x] = pair.sort((a, b) => (a.engine.deviceId! < b.engine.deviceId! ? -1 : 1));
    await write(x, "X early");
    await cycle(w, x);
    await cycle(w, r);
    expect(remarks(r)).toEqual(["X early"]);
    // r is offline from here on.
    await write(y, "Y 1", "Y 2");
    await compactNow(y);
    y.engine.stop();
    await write(x, "X late 1", "X late 2");
    await compactNow(x);
    // y's snapshot claims x's ops through x's snapshot point; its state
    // holds only "X early".
    await overClaim(y, x, { seen: true });
    const from = w.fake.requests.length;
    await cycle(w, r);
    expect(readsOf(from, stored(x, "snap")!.sha)).toBe(1);
    expect(remarks(r).sort()).toEqual(["X early", "X late 1", "X late 2", "Y 1", "Y 2"]);
    await quiesce(w, r, x);
    expectConverged(r, x);
    expect(r.engine.getState()).toMatchObject({ status: "idle" });
  });

  it("a snapshot over-claiming its own through closes its log's gap, but never leaves out that log's ops", async () => {
    const r = await open({ login: "sam" });
    const x = await open(every(3));
    await write(x, "One", "Two", "Three");
    await compactNow(x);
    await write(x, "Four", "Five");
    await cycle(w, x);
    const log = await repoLog(x);
    expect(log.ops.map((op) => op.L)).toEqual([log.snapThrough + 1, log.snapThrough + 2]);
    await cycle(w, r);
    x.engine.stop();
    // x's snapshot claims x's ops through the log's last L; its state holds
    // only those through the log's snapThrough.
    const snap = (await unseal(stored(x, "snap")!.text, w.key)) as SnapContent & { maxL: number };
    const last = log.snapThrough + 2;
    snap.through = last;
    snap.seen[x.engine.deviceId!] = last;
    snap.maxL = Math.max(snap.maxL, last);
    expect(checkRepoFile(file(x, "snap"), snap, genesisState(w.doc)).ok).toBe(true);
    await plant(w, file(x, "snap"), snap);
    const fresh = await open({ login: "sam" });
    expect(remarks(fresh)).toEqual(["One", "Two", "Three", "Four", "Five"]);
    expectConverged(r, fresh);
    expect(fresh.engine.getState()).toMatchObject({ status: "idle" });
  });

  it("a snapshot holding a value no log holds reaches every device, not only those that read it cold: a device that kept up and a cold start converge", async () => {
    const x = await open({ login: "alex" });
    await write(x, "From x");
    await cycle(w, x);
    const r = await open({ login: "alex" }); // keeps up
    const y = await open({ ...every(1), login: "sam" });
    await write(y, "From y");
    await cycle(w, y); // y's log, untrimmed
    await cycle(w, r); // r joins y's op from the log, so no log ever needs y's snapshot for r
    await compactNow(y);
    y.engine.stop();
    await cycle(w, r);
    // y's snapshot is re-planted with x's record's value changed at the same
    // tag: no log holds that value.
    const snap = (await unseal(stored(y, "snap")!.text, w.key)) as { state: { rec: { e: { v: Record<string, unknown> }[] } } };
    const xs = snap.state.rec.e.find((rec) => rec.v.remarks === "From x")!;
    xs.v.remarks = "~forged";
    expect(checkRepoFile(file(y, "snap"), snap, genesisState(w.doc)).ok).toBe(true);
    await plant(w, file(y, "snap"), snap);
    const c = await open({ login: "sam" }); // cold start
    await quiesce(w, x, r, c);
    for (const d of [x, r, c]) expect(status(d)).toBe("idle");
    expectConverged(r, c);
    expectConverged(x, c);
  });

  it("a snapshot over-claiming its own through, once overwritten, never closes a later log's gap: a device offline across the next compaction still reads the new snapshot", async () => {
    const x = await open(every(3));
    await write(x, "One", "Two", "Three");
    await compactNow(x);
    const honest = stored(x, "snap")!;
    const snap = (await unseal(honest.text, w.key)) as SnapContent & { maxL: number };
    snap.through = 50;
    snap.seen[x.engine.deviceId!] = 50;
    snap.maxL = Math.max(snap.maxL, 50);
    expect(checkRepoFile(file(x, "snap"), snap, genesisState(w.doc)).ok).toBe(true);
    await plant(w, file(x, "snap"), snap);
    const r = await open({ login: "sam" });
    expect(remarks(r)).toEqual(["One", "Two", "Three"]);
    // The honest snapshot back, at the same sha: x never sees a fork.
    expect(await w.fake.seedFile(FULL, repoPath(file(x, "snap")), honest.text)).toBe(honest.sha);
    // r is offline while x writes and compacts again.
    await write(x, "Four", "Five", "Six");
    await compactNow(x);
    await write(x, "Seven");
    await cycle(w, x);
    expect(x.engine.getState()).toMatchObject({ status: "idle" });
    const fresh = await open({ login: "sam" });
    expect(remarks(fresh)).toEqual(["One", "Two", "Three", "Four", "Five", "Six", "Seven"]);
    await cycle(w, r);
    await cycle(w, r);
    expect(status(r)).toBe("idle");
    expect(remarks(r)).toEqual(remarks(fresh));
  });

  it("a snapshot over-claiming its own through, once overwritten by one that can't be read, leaves the next log waiting: it is never joined across the gap", async () => {
    const x = await open(every(3));
    await write(x, "One", "Two", "Three");
    await compactNow(x);
    const honest = stored(x, "snap")!;
    const snap = (await unseal(honest.text, w.key)) as SnapContent & { maxL: number };
    snap.through = 50;
    snap.seen[x.engine.deviceId!] = 50;
    snap.maxL = Math.max(snap.maxL, 50);
    await plant(w, file(x, "snap"), snap);
    const r = await open({ login: "sam" });
    await w.fake.seedFile(FULL, repoPath(file(x, "snap")), honest.text);
    await write(x, "Four", "Five", "Six");
    await compactNow(x);
    await write(x, "Seven");
    await cycle(w, x);
    const good = stored(x, "snap")!.text;
    await plant(w, file(x, "snap"), { fv: 1, kind: "snap", epoch: EPOCH, device: x.engine.deviceId });
    await cycle(w, r);
    expect(status(r)).toBe("needsAttention");
    expect(remarks(r)).toEqual(["One", "Two", "Three"]);
    await w.fake.seedFile(FULL, repoPath(file(x, "snap")), good);
    await cycle(w, r);
    expect(status(r)).toBe("idle");
    expect(remarks(r)).toEqual(["One", "Two", "Three", "Four", "Five", "Six", "Seven"]);
  });

  it("an op that the current version of a log holds below the last L an earlier version gave is joined: a device that read the earlier version converges with a cold start", async () => {
    // Valid ops at L 2, 3 and 4, made in a scratch world.
    const scratch = await world();
    const src = await device(scratch, { login: "alex" });
    running.push(src.engine);
    await write(src, "One", "Two", "Three");
    await cycle(scratch, src);
    const ops = ((await unseal(scratch.fake.file(FULL, repoPath(file(src, "log")))!.text, scratch.key)) as LogContent).ops;
    src.engine.stop();
    expect(ops.map((op) => op.L)).toEqual([2, 3, 4]);
    const z = `d${"ab".repeat(8)}`;
    const zLog: RepoFile = { kind: "log", epoch: EPOCH, device: z };
    // Lamport gaps are normal: L 2 and 4 first.
    await plant(w, zLog, logFile(z, [ops[0], ops[2]]));
    const r = await open({ login: "sam" });
    expect(remarks(r).sort()).toEqual(["One", "Three"]);
    await plant(w, zLog, logFile(z, ops));
    await cycle(w, r);
    const c = await open({ login: "sam" });
    await quiesce(w, r, c);
    expect(r.store.meta().joined).toMatchObject({ [`${EPOCH}.${z}.log.enc`]: w.fake.file(FULL, repoPath(zLog))!.sha });
    expect(remarks(r).sort()).toEqual(["One", "Three", "Two"]);
    expectConverged(r, c);
    for (const d of [r, c]) expect(status(d)).toBe("idle");
  });

  // Owner decision D25 (ADR-0008): guarantee 3 holds for devices that have
  // joined the same file versions, and the app never drops content from a
  // file it overwrites. A key holder overwriting a file with a version that
  // drops content is insider rewriting, out of scope: the device that read
  // the earlier version keeps what it joined, a cold start never sees it,
  // and each stays consistent with what it joined (both idle, nothing
  // halted). The accepted behaviour, pinned so a change to it is a decision.
  it("D25: content only in an overwritten version of a log stays with the device that read it, and a cold start never sees it", async () => {
    const scratch = await world();
    const src = await device(scratch, { login: "alex" });
    running.push(src.engine);
    await write(src, "One", "Two", "Three");
    await cycle(scratch, src);
    const ops = ((await unseal(scratch.fake.file(FULL, repoPath(file(src, "log")))!.text, scratch.key)) as LogContent).ops;
    src.engine.stop();
    const z = `d${"ab".repeat(8)}`;
    const zLog: RepoFile = { kind: "log", epoch: EPOCH, device: z };
    await plant(w, zLog, logFile(z, ops));
    const r = await open({ login: "sam" });
    expect(remarks(r).sort()).toEqual(["One", "Three", "Two"]);
    // A key holder replaces the log with one that drops the op at L 3.
    await plant(w, zLog, logFile(z, [ops[0], ops[2]]));
    const c = await open({ login: "sam" });
    await quiesce(w, r, c);
    for (const d of [r, c]) expect(d.engine.getState()).toMatchObject({ status: "idle", unreadable: null });
    // Both hold the listed version; r also joined the one it replaced.
    const listed = w.fake.file(FULL, repoPath(zLog))!.sha;
    for (const d of [r, c]) expect(d.store.meta().joined).toMatchObject({ [`${EPOCH}.${z}.log.enc`]: listed });
    expect(remarks(r).sort()).toEqual(["One", "Three", "Two"]);
    expect(remarks(c).sort()).toEqual(["One", "Three"]);
    // Each is consistent with what it joined: a reload shows the same.
    for (const d of [r, c]) d.engine.stop();
    const r2 = await open({ login: "sam", store: r.store });
    const c2 = await open({ login: "sam", store: c.store });
    await quiesce(w, r2, c2);
    expect(remarks(r2).sort()).toEqual(["One", "Three", "Two"]);
    expect(remarks(c2).sort()).toEqual(["One", "Three"]);
    // And a write on either still reaches the other.
    await write(c2, "After");
    await quiesce(w, r2, c2);
    expect(remarks(r2).sort()).toEqual(["After", "One", "Three", "Two"]);
    expect(remarks(c2).sort()).toEqual(["After", "One", "Three"]);
  });

  /** Plants a snapshot under `device`, which has no other file, at `through`
   * 0 with the genesis state: valid to every check a reader runs. */
  async function plantZeroSnap(device: string): Promise<void> {
    const snapFile: RepoFile = { kind: "snap", epoch: EPOCH, device };
    const g = genesisState(w.doc);
    const snap = { fv: FORMAT_VERSION, kind: "snap", epoch: EPOCH, device, through: 0, chain: CHAIN_START, seen: {}, maxL: 1, joined: {}, state: encodeState(g) };
    expect(checkRepoFile(snapFile, snap, g)).toMatchObject({ ok: true });
    await plant(w, snapFile, snap);
  }

  it("a snapshot at through 0 never leaves a 0 reach in meta: the device that joined it still loads after a reload", async () => {
    const X = deviceId(0xc);
    await plantZeroSnap(X);
    const r = await open({ login: "sam" });
    await r.backend.addEntry(entry("Mine"));
    await cycle(w, r);
    expect(r.store.meta().joined).toHaveProperty(`${EPOCH}.${X}.snap.enc`);
    expect(r.store.meta().snapReach).not.toHaveProperty(X);
    r.engine.stop();
    const again = await open({ login: "sam", store: r.store });
    expect(again.engine.getState()).toMatchObject({ status: "idle", unreadable: null });
    expect(remarks(again)).toEqual(["Mine"]);
  });

  it("a rehome's cold join that joins a snapshot at through 0 leaves no 0 reach in meta: the rehomed device still loads after a reload", async () => {
    const X = deviceId(0xc);
    await plantZeroSnap(X);
    const a = await open({ login: "alex" });
    await write(a, "Before");
    await cycle(w, a);
    const twin = await open({ login: "alex", store: a.store.clone() });
    await write(twin, "Copy");
    await cycle(w, twin);
    const old = a.engine.deviceId;
    await write(a, "Original");
    await cycle(w, a);
    expect(a.engine.deviceId).not.toBe(old);
    expect(a.store.meta().joined).toHaveProperty(`${EPOCH}.${X}.snap.enc`);
    expect(a.store.meta().snapReach).not.toHaveProperty(X);
    a.engine.stop();
    const again = await open({ login: "alex", store: a.store });
    expect(again.engine.getState()).toMatchObject({ unreadable: null });
    expect(remarks(again).sort()).toEqual(["Before", "Copy", "Original"]);
  });

  it("a meta holding a 0 reach, as a stage 5 build before this fix saved it, still loads", async () => {
    const r = await open({ login: "sam" });
    await r.backend.addEntry(entry("Mine"));
    await cycle(w, r);
    r.engine.stop();
    r.store.tamperMeta((meta) => {
      meta.logReach = { [deviceId(0xb)]: 0 };
      meta.snapReach = { [deviceId(0xc)]: 0 };
    });
    const again = await open({ login: "sam", store: r.store });
    expect(again.engine.getState()).toMatchObject({ status: "idle", unreadable: null });
    expect(remarks(again)).toEqual(["Mine"]);
  });

  it("a cold start reads every listed log and snapshot once; catch-up reads only the files changed since", async () => {
    const retired = await open({ ...every(1), login: "sam" });
    await write(retired, "Retired");
    await compactNow(retired);
    retired.engine.stop();
    const b = await open({ login: "sam" });
    await write(b, "From b");
    await cycle(w, b);
    const a = await open(every(2));
    await write(a, "One", "Two");
    await compactNow(a);
    await write(a, "Three");
    await cycle(w, a);
    // a's snapshot names every other log as joined: a cold start reads them anyway.
    const claimed = (await repoSnap(a))!.joined;
    expect(claimed).toMatchObject({ [logName(retired)]: stored(retired, "log")!.sha, [logName(b)]: stored(b, "log")!.sha });
    const genesis = w.fake.file(FULL, `ledger/${GENESIS}`)!.sha;
    const logs = [a, b, retired].map((d) => stored(d, "log")!.sha);
    // b never compacted, so b has no snapshot to read.
    const snaps = [a, retired].map((d) => stored(d, "snap")!.sha);
    let from = w.fake.requests.length;
    const fresh = await open({ login: "sam" });
    expect(blobReads(from).map((r) => r.path.split("/").at(-1)).sort()).toEqual([genesis, ...logs, ...snaps].sort());
    expect(remarks(fresh).sort()).toEqual(["From b", "One", "Retired", "Three", "Two"]);
    expectConverged(a, fresh);
    // Catch-up: one log changed, so one read.
    await write(b, "Later");
    await cycle(w, b);
    from = w.fake.requests.length;
    await cycle(w, fresh);
    expect(blobReads(from).map((r) => r.path.split("/").at(-1))).toEqual([stored(b, "log")!.sha]);
    // Nothing changed: no read at all.
    from = w.fake.requests.length;
    await cycle(w, fresh);
    expect(blobReads(from)).toEqual([]);
    expect(fresh.engine.getState()).toMatchObject({ status: "idle" });
  });
});

describe("local compaction (section 8.4)", () => {
  it("folds the tail into the base once it passes the limit, in one transaction; a reload shows the same document", async () => {
    const store = new MemoryStore();
    const a = await open({ store, compaction: { tailEntries: 3 } });
    await write(a, "One", "Two", "Three", "Four");
    const folds = () => store.mutations.filter((m) => m.clearTail && m.base !== undefined);
    await until(() => folds().length > 0);
    expect(folds()).toHaveLength(1);
    expect((await store.load())!.tail).toHaveLength(0);
    await write(a, "Five");
    expect((await store.load())!.tail).toHaveLength(1);
    a.engine.stop();
    const again = await open({ store, compaction: { tailEntries: 3 } });
    expect(remarks(again)).toEqual(["One", "Two", "Three", "Four", "Five"]);
  });

  it("a long tail saved by an earlier build is folded on load", async () => {
    const store = new MemoryStore();
    const a = await open({ store });
    await write(a, "One", "Two", "Three");
    a.engine.stop();
    const again = await open({ store, compaction: { tailEntries: 2 } });
    await until(async () => (await store.load())!.tail.length === 0);
    expect(remarks(again)).toEqual(["One", "Two", "Three"]);
  });

  it("a fold that fails only waits for the next one: no write was refused, so the device isn't flagged", async () => {
    const store = new MemoryStore();
    const a = await open({ store, compaction: { tailEntries: 2 } });
    const mutate = store.mutate.bind(store);
    let failed = 0;
    vi.spyOn(store, "mutate").mockImplementation(async (m) => {
      if (m.clearTail && failed++ === 0) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return mutate(m);
    });
    await write(a, "One", "Two", "Three");
    await until(() => failed === 1 && a.logs.some((l) => l.includes("will be tried again")));
    expect(a.engine.getState().deviceSaveFailed).toBe(false);
    expect((await store.load())!.tail).toHaveLength(3);
    await write(a, "Four");
    await until(async () => (await store.load())!.tail.length === 0);
    a.engine.stop();
    const again = await open({ store });
    expect(remarks(again)).toEqual(["One", "Two", "Three", "Four"]);
  });
});

describe("randomised: compaction, catch-up and local folds under faults and reloads", () => {
  // Seeded schedules of three devices that compact every few ops and fold
  // their tail often: random adds, edits and deletes, cycles, lost or failed
  // PUTs (snapshots and trims included), and reloads at rest. At quiescence
  // every device, and a device started afresh, shows exactly the entries
  // added and not deleted. The seed is in every failure message.
  const SEEDS = Number(testEnv("LEDGER_COMPACTION_SEEDS") ?? 12);
  const STEPS = 40;

  it(`converges with nothing lost over ${SEEDS} seeds x ${STEPS} steps`, async () => {
    // What the schedules exercised, so the test can't pass vacuously.
    const seen = { snapshots: 0, snapReads: 0, folds: 0 };
    for (let seed = 1; seed <= SEEDS; seed++) {
      for (const engine of running.splice(0)) engine.stop();
      w = await world();
      const rng = new Rng(seed);
      const where = `seed ${seed}`;
      const options = (login: string) => ({ login, compaction: { logOps: 2 + rng.int(3), tailEntries: 3 + rng.int(5) } });
      const logins = ["alex", "sam", "alex"];
      const devices: Device[] = [];
      for (const login of logins) devices.push(await open(options(login)));
      const added = new Set<string>();
      const deleted = new Set<string>();
      let n = 0;
      for (let step = 0; step < STEPS; step++) {
        const i = rng.int(devices.length);
        const d = devices[i];
        const roll = rng.next();
        if (roll < 0.35) {
          const text = `S${seed}-${n++}`;
          await write(d, text);
          added.add(text);
        } else if (roll < 0.45 && remarks(d).length > 0) {
          const text = remarks(d)[rng.int(remarks(d).length)];
          await d.backend.updateEntry(2026, 5, (await d.backend.getMonth(2026, 5)).find((e) => e.remarks === text)!.row, { amount: 1 + rng.int(90), remarks: text, category: "food", isCard: false });
        } else if (roll < 0.52 && remarks(d).length > 0) {
          const text = remarks(d)[rng.int(remarks(d).length)];
          await d.backend.deleteEntry(2026, 5, (await d.backend.getMonth(2026, 5)).find((e) => e.remarks === text)!.row);
          deleted.add(text);
        } else if (roll < 0.58) {
          w.fake.landThenDropResponse({ method: "PUT" });
        } else if (roll < 0.62) {
          w.fake.failNext({ method: "PUT", network: true });
        } else if (roll < 0.67) {
          d.engine.stop();
          devices[i] = await open({ ...options(d.login), store: d.store });
        } else {
          await cycle(w, d);
        }
      }
      w.fake.landPending();
      await quiesce(w, ...devices);
      const expected = [...added].filter((text) => !deleted.has(text)).sort();
      expectConverged(...devices);
      expect([...remarks(devices[0])].sort(), where).toEqual(expected);
      const fresh = await open({ login: "sam" });
      expect([...remarks(fresh)].sort(), where).toEqual(expected);
      for (const d of devices) expect(d.engine.getState(), where).toMatchObject({ status: "idle", pendingCount: 0 });
      expect(w.fake.violations, where).toEqual([]);
      const snapShas = new Set(w.fake.commits.filter((c) => c.message.startsWith("Snapshot")).map((c) => c.sha));
      seen.snapshots += snapShas.size;
      seen.snapReads += w.fake.requests.filter((r) => r.path.includes("/git/blobs/") && snapShas.has(r.path.split("/").at(-1)!)).length;
      seen.folds += devices.reduce((sum, d) => sum + d.store.mutations.filter((m) => m.clearTail && m.base !== undefined).length, 0);
    }
    expect(seen.snapshots).toBeGreaterThan(SEEDS);
    expect(seen.snapReads).toBeGreaterThan(0);
    expect(seen.folds).toBeGreaterThan(SEEDS);
  }, 300_000);
});
