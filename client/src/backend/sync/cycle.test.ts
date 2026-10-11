import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../ApiError";
import { parseHeader } from "../crypto";
import { ENTRY, EPOCH, FULL, GENESIS, MemoryStore, cycle, device, entry, expectConverged, nextTask, puts, remarks, repoOps, sentOps, since, world, type Device, type World } from "./cycleTestkit";
import { repoFileName } from "./epoch";
import { FakeLocks } from "./localTestkit";
import { clearSyncState } from "./persist";
import { SYNC_TIMING, type SyncEngine } from "./SyncEngine";

// The sync cycle (design section 7) against the fake GitHub: what each
// cycle reads and writes, its triggers and its spacing. Failure handling,
// forks and the old catalogue are in cycleFailures.test.ts. Fictional data
// only.

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

/** Lets work in flight (encryption, a triggered cycle) run to its end;
 * the fake timers don't move. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await nextTask();
}

const ownLogName = (d: Device) => repoFileName({ kind: "log", epoch: EPOCH, device: d.engine.deviceId! });

describe("the sync cycle (section 7)", () => {
  it("two devices each push their own log and join the other's: both show both expenses, in the same order, with no notice (AC6)", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await b.backend.addEntry(entry("Bus"));
    await cycle(w, a, b, a, b);
    expect(remarks(a).sort()).toEqual(["Bus", "Groceries"]);
    expectConverged(a, b);
    for (const d of [a, b]) expect(d.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0, noticeCount: 0 });
    expect(w.fake.violations).toEqual([]);
  });

  it("an idle visible cycle is exactly one request, a 304 GitHub doesn't count (AC9)", async () => {
    const a = await open();
    await cycle(w, a);
    const from = w.fake.requests.length;
    await cycle(w, a);
    const sent = since(w, from);
    expect(sent.map((r) => `${r.method} ${r.path.split("?")[0]}`)).toEqual([`GET /repos/${FULL}/git/ref/heads/main`]);
    expect(sent[0].headers["if-none-match"]).toBeDefined();
  });

  it("an edit costs one PUT; the next poll recognises the device's own commit with one ref GET and lists nothing", async () => {
    const a = await open();
    await a.backend.addEntry(ENTRY);
    let from = w.fake.requests.length;
    await cycle(w, a);
    expect(since(w, from).map((r) => r.method)).toEqual(["GET", "PUT"]);
    expect(await repoOps(w, a)).toEqual([2]);
    from = w.fake.requests.length;
    await cycle(w, a);
    expect(since(w, from).map((r) => r.path.split("?")[0])).toEqual([`/repos/${FULL}/git/ref/heads/main`]);
    from = w.fake.requests.length;
    await cycle(w, a);
    expect(since(w, from)).toHaveLength(1);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
  });

  it("another device's change costs a ref GET, one listing and one blob GET; the genesis is read only once", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await b.backend.addEntry(entry("Bus"));
    await cycle(w, b);
    const from = w.fake.requests.length;
    await cycle(w, a);
    const paths = since(w, from).map((r) => r.path.split("?")[0].replace(`/repos/${FULL}`, ""));
    expect(paths[0]).toBe("/git/ref/heads/main");
    expect(paths[1]).toMatch(/^\/git\/trees\/[0-9a-f]{40}$/);
    expect(paths.slice(2)).toHaveLength(1);
    expect(paths[2]).toMatch(/^\/git\/blobs\//);
    expect(remarks(a)).toEqual(["Bus"]);
    const genesisSha = w.fake.file(FULL, `ledger/${GENESIS}`)!.sha;
    const genesisReads = w.fake.requests.filter((r) => r.path.endsWith(genesisSha));
    expect(genesisReads.length).toBe(2); // once per device, ever
  });

  it("sends only ops whose transaction committed: a write still saving is not in the PUT (section 3.5)", async () => {
    const store = new MemoryStore();
    const a = await open({ store });
    await a.backend.addEntry(entry("Groceries"));
    let release!: () => void;
    store.hold = new Promise<void>((resolve) => (release = resolve));
    const saving = a.backend.addEntry(entry("Rent"));
    // The cycle's own bookkeeping waits behind the held write too.
    const syncing = cycle(w, a);
    await settle();
    expect(puts(w)).toHaveLength(0);
    release();
    store.hold = null;
    await saving;
    await syncing;
    await cycle(w, a);
    expect(await sentOps(w, puts(w)[0])).toEqual([2]);
    expect(await repoOps(w, a)).toEqual([2, 3]);
  });

  it("a no-op save and a stamp-only change make no op and no PUT (B19)", async () => {
    const a = await open();
    const added = await a.backend.addEntry(ENTRY);
    await cycle(w, a);
    const before = puts(w).length;
    await a.backend.updateEntry(2026, 5, added.row, { amount: 40, remarks: "Groceries", category: "food", isCard: false });
    await cycle(w, a);
    expect(puts(w).length).toBe(before);
    expect(a.engine.getState().pendingCount).toBe(0);
  });

  it("writes only the device's own files and never deletes anything (AC10)", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    for (const d of [a, b]) await d.backend.addEntry(entry(`From ${d.login}`));
    await cycle(w, a, b, a, b);
    expect(w.fake.violations).toEqual([]);
    expect(w.fake.requests.some((r) => r.method === "DELETE")).toBe(false);
    for (const put of puts(w)) {
      expect([a, b].some((d) => put.path.endsWith(`/ledger/${ownLogName(d)}`))).toBe(true);
      expect(JSON.parse(put.body!).message).toMatch(/^Sync [0-9a-f]{8}$/);
    }
  });

  it("status says saving while own ops are unconfirmed, then idle; pendingCount counts only unconfirmed ops (section 11)", async () => {
    const a = await open();
    await a.backend.addEntry(entry("Groceries"));
    await a.backend.addEntry(entry("Rent"));
    expect(a.engine.getState()).toMatchObject({ status: "saving", pendingCount: 2 });
    await cycle(w, a);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    await a.backend.addEntry(entry("Bus"));
    expect(a.engine.getState()).toMatchObject({ status: "saving", pendingCount: 1 });
  });

  it("a write made while a cycle is in flight is kept, and the next cycle pushes it (B5, B21)", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await b.backend.addEntry(entry("Bus"));
    await cycle(w, b);
    await a.backend.addEntry(entry("Groceries"));
    const syncing = cycle(w, a);
    const added = a.backend.addEntry(entry("Rent"));
    await syncing;
    await added;
    await cycle(w, a, b);
    expect(remarks(a).sort()).toEqual(["Bus", "Groceries", "Rent"]);
    expectConverged(a, b);
    expect(a.engine.getState().pendingCount).toBe(0);
  });

  it("persists across a reload: the next start loads the unsent change and pushes it", async () => {
    const store = new MemoryStore();
    const a = await open({ store });
    await a.backend.addEntry(entry("Groceries"));
    a.engine.stop();
    expect(puts(w)).toHaveLength(0);
    const again = await open({ store });
    expect(again.engine.getState().pendingCount).toBe(0);
    expect(puts(w)).toHaveLength(1);
    const b = await open({ login: "sam" });
    expect(remarks(b)).toEqual(["Groceries"]);
  });
});

describe("the engine around the cycle", () => {
  it("encrypts the own log with the genesis's salt and iterations: only the IV differs (section 6)", async () => {
    const a = await open();
    await a.backend.addEntry(ENTRY);
    await cycle(w, a);
    const header = (name: string) => parseHeader(w.fake.file(FULL, `ledger/${name}`)!.text);
    const [own, genesis] = [header(ownLogName(a)), header(GENESIS)];
    expect({ salt: own.salt, iter: own.iter }).toEqual({ salt: genesis.salt, iter: genesis.iter });
    expect(own.iv).not.toBe(genesis.iv);
  });

  it("a remote change re-keys the view (revision); this device's own write and its push don't", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    const before = a.engine.getState().revision;
    await a.backend.addEntry(entry("Groceries"));
    await cycle(w, a, a);
    expect(a.engine.getState().revision).toBe(before);
    await b.backend.addEntry(entry("Bus"));
    await cycle(w, b, a);
    expect(a.engine.getState().revision).toBe(before + 1);
  });

  it("a second tab can't get the lock: it is locked and sends nothing (section 10.2)", async () => {
    const locks = new FakeLocks().asLockManager();
    await open({ locks });
    const from = w.fake.requests.length;
    const second = await open({ locks, noSettle: true });
    await second.engine.sync();
    expect(second.engine.getState().status).toBe("locked");
    expect(since(w, from)).toHaveLength(0);
  });

  it("clearSyncState() stops the running engine: a push it had scheduled makes no PUT", async () => {
    const a = await open();
    await a.backend.addEntry(ENTRY);
    await clearSyncState();
    await vi.advanceTimersByTimeAsync(SYNC_TIMING.debounceMs + SYNC_TIMING.pollMs);
    await a.engine.sync();
    expect(puts(w)).toHaveLength(0);
  });
});

describe("triggers and spacing (section 7)", () => {
  it("five changes within 2 s make one PUT, 2 s after the last", async () => {
    const a = await open();
    for (const text of ["A", "B", "C", "D", "E"]) {
      await a.backend.addEntry(entry(text));
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(puts(w)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(SYNC_TIMING.debounceMs - 300 - 1);
    expect(puts(w)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(puts(w)).toHaveLength(1));
    await a.engine.sync();
    expect(await repoOps(w, a)).toEqual([2, 3, 4, 5, 6]);
  });

  it("pulls on online, on becoming visible, and every 60 s while visible; never while hidden", async () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const win = new EventTarget();
    await open({ events: { document: page, window: win } });
    const refs = () => w.fake.requests.filter((r) => r.path.includes("/git/ref/")).length;
    let n = refs();
    win.dispatchEvent(new Event("online"));
    await settle();
    expect(refs()).toBe(n + 1);
    n = refs();
    await vi.advanceTimersByTimeAsync(SYNC_TIMING.pollMs);
    await settle();
    expect(refs()).toBe(n + 1);
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    n = refs();
    await vi.advanceTimersByTimeAsync(SYNC_TIMING.pollMs * 5);
    expect(refs()).toBe(n);
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(refs()).toBe(n + 1);
  });

  it("own log PUTs that land are at least 5 s apart; one due sooner waits for its turn", async () => {
    const a = await open();
    await a.backend.addEntry(entry("Groceries"));
    await cycle(w, a);
    await a.backend.addEntry(entry("Rent"));
    w.clock.mono += 1000;
    await a.engine.sync();
    expect(puts(w)).toHaveLength(1);
    expect(a.engine.getState().status).toBe("saving");
    w.clock.mono += SYNC_TIMING.putGapMs;
    await vi.advanceTimersByTimeAsync(SYNC_TIMING.putGapMs);
    await a.engine.sync();
    expect(puts(w)).toHaveLength(2);
  });

  it("no more than 120 own log PUTs go in an hour", async () => {
    // GitHub's own secondary limit (80 writes a minute) is kept out of the
    // way by moving its clock a second per write.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const a = await open();
    for (let i = 0; i < SYNC_TIMING.putsPerHour; i++) {
      await a.backend.addEntry(entry(`E${i}`));
      w.clock.mono += SYNC_TIMING.putGapMs;
      vi.setSystemTime(Date.now() + 1000);
      await a.engine.sync();
    }
    expect(puts(w)).toHaveLength(SYNC_TIMING.putsPerHour);
    await a.backend.addEntry(entry("One more"));
    w.clock.mono += SYNC_TIMING.putGapMs;
    await a.engine.sync();
    expect(puts(w)).toHaveLength(SYNC_TIMING.putsPerHour);
    w.clock.mono += 60 * 60 * 1000;
    await a.engine.sync();
    expect(puts(w)).toHaveLength(SYNC_TIMING.putsPerHour + 1);
  }, 60_000);

  it("a device whose records live only in tab memory pushes with no debounce", async () => {
    const a = await open({ store: new MemoryStore({ volatile: true }) });
    await a.backend.addEntry(ENTRY);
    await vi.waitFor(() => expect(puts(w)).toHaveLength(1));
    expect(a.engine.getState().volatile).toBe(true);
  });

  it("a keepalive push on pagehide sends the built log text, and the next start settles it from the listing alone", async () => {
    const win = new EventTarget();
    const store = new MemoryStore();
    const a = await open({ store, events: { window: win } });
    await a.backend.addEntry(ENTRY);
    expect(a.engine.getState().pendingCount).toBe(1);
    // The text is built after the commit, in the background.
    await settle();
    win.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(puts(w)).toHaveLength(1);
    expect(puts(w)[0].keepalive).toBe(true);
    a.engine.stop();
    const again = await open({ store });
    expect(again.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    expect(puts(w)).toHaveLength(1);
  });

  it("pagehide sends no keepalive PUT whose request body would pass the 64 KiB keepalive limit; the next cycle pushes it", async () => {
    // The log text is built in the background, its blob sha last: wait for
    // that hash of a large text, so pagehide finds the text built.
    let hashed!: () => void;
    const built = new Promise<void>((resolve) => (hashed = resolve));
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const done = await digest(algorithm, data);
      if (algorithm === "SHA-1" && data.byteLength > 50_000) hashed();
      return done;
    });
    try {
      const win = new EventTarget();
      const a = await open({ events: { window: win } });
      // Random hex compresses poorly: a log text of about 58 KB, under the
      // 60 KiB of text the engine once checked, whose base64-in-JSON body
      // is about 78 KB.
      const bytes = crypto.getRandomValues(new Uint8Array(40_000));
      await a.backend.addEntry(entry([...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")));
      await built;
      await settle();
      win.dispatchEvent(new Event("pagehide"));
      await settle();
      expect(puts(w)).toEqual([]);
      await cycle(w, a);
      const [put] = puts(w);
      expect(put.keepalive).toBeUndefined();
      const content = (JSON.parse(put.body!) as { content: string }).content;
      expect((content.length / 4) * 3).toBeLessThan(60 * 1024);
      expect(new TextEncoder().encode(put.body!).length).toBeGreaterThan(64 * 1024);
      expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    } finally {
      spy.mockRestore();
    }
  });

  it("a failed write is never pushed: only ops on the device go out (B17)", async () => {
    const store = new MemoryStore();
    const a = await open({ store });
    store.failNext = 1;
    await expect(a.backend.addEntry(entry("Lost"))).rejects.toEqual(new ApiError(500, "This device couldn't save. Free up storage and try again."));
    await a.backend.addEntry(entry("Kept"));
    await cycle(w, a);
    const b = await open({ login: "sam" });
    expect(remarks(b)).toEqual(["Kept"]);
    expect(await repoOps(w, a)).toEqual([3]);
  });
});
