import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../ApiError";
import { bytesToBase64 } from "../base64";
import { newSalt } from "../crypto";
import {
  ENTRY,
  EPOCH,
  FULL,
  MemoryStore,
  cycle,
  device,
  edits,
  entry,
  expectConverged,
  logFile,
  nextTask,
  plant,
  puts,
  quiesce,
  remarks,
  repoOps,
  row,
  since,
  world,
  type Device,
  type World,
} from "./cycleTestkit";
import { testKey } from "./localTestkit";
import { REPO_FILE_MAX_BYTES, REPO_FILE_MAX_PLAIN_BYTES, repoPath } from "./repoFiles";
import type { Op } from "./state";
import { LEDGER_UPDATED, REHOMED, SYNC_TIMING, type SyncEngine } from "./SyncEngine";
import { MAX_L } from "./tags";
import { deviceId } from "./testkit";

// The cycle's failure handling (design section 12), forks and rehome
// (section 10.3), and the old engine's catalogue of bugs (section 13) as
// named regressions, against the fake GitHub. Each section 12 row says what
// a failure costs: never a committed local change, never a write the user
// was told was saved, never convergence. Fictional data only.

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

async function open(options: Parameters<typeof device>[1] = {}): Promise<Device> {
  const d = await device(w, options);
  running.push(d.engine);
  return d;
}

/** Waits, without moving the fake clock, until `condition` holds. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; !condition(); i++) {
    if (i > 10_000) throw new Error("timed out waiting");
    await nextTask();
  }
}

const status = (d: Device) => d.engine.getState().status;
const ownLog = (d: Device) => `${EPOCH}.${d.engine.deviceId}.log.enc`;

/** `plain` encrypted under the household key as a repo file, as is: a
 * build that skips or garbles the gzip step can write this. */
async function sealPlain(plain: Uint8Array<ArrayBuffer>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = JSON.stringify({ v: 1, kdf: "PBKDF2-SHA256", iter: w.key.iter, salt: w.key.salt, iv: bytesToBase64(iv), alg: "AES-GCM-256", z: "gzip" });
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(header) }, w.key.key, plain);
  return `${header}
${bytesToBase64(new Uint8Array(cipher))}`;
}

/** `text` gzipped, as encryptDocument compresses a document. */
async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

/** A valid op from a real write, to plant in crafted files. */
async function someOp(remark = "Planted"): Promise<Op> {
  const scratch = await open({ login: "sam" });
  await scratch.backend.addEntry(entry(remark));
  const [op] = scratch.engine.pushableOps();
  scratch.engine.stop();
  return structuredClone(op);
}

describe("failure handling (section 12)", () => {
  it("a PUT whose response is lost is settled from the listed sha alone: not read, not sent again (AC11)", async () => {
    const a = await open();
    await a.backend.addEntry(ENTRY);
    w.fake.landThenDropResponse({ method: "PUT" });
    await cycle(w, a);
    expect(a.engine.getState()).toMatchObject({ status: "pending", pendingCount: 1 });
    const from = w.fake.requests.length;
    await cycle(w, a);
    expect(since(w, from).map((r) => r.method)).toEqual(["GET", "GET"]); // the ref and the listing
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    expect(puts(w)).toHaveLength(1);
  });

  it("a lost response survives a reload: the landed write is recognised after the tab closes", async () => {
    const store = new MemoryStore();
    const a = await open({ store });
    await a.backend.addEntry(ENTRY);
    w.fake.landThenDropResponse({ method: "PUT" });
    await cycle(w, a);
    a.engine.stop();
    const again = await open({ store });
    expect(again.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    expect(puts(w)).toHaveLength(1);
  });

  it("a duplicated PUT: the copy's 409 is recognised as the first copy landing (AC11)", async () => {
    const a = await open();
    await a.backend.addEntry(ENTRY);
    await cycle(w, a);
    await a.backend.addEntry(entry("Rent"));
    w.fake.duplicateRequest({ method: "PUT" });
    await cycle(w, a);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    expect(puts(w)).toHaveLength(2);
    expect(await repoOps(w, a)).toEqual([2, 3]);
  });

  it("a 409 on the first PUT, then success: 2 PUTs, the change saved, status idle", async () => {
    const a = await open();
    await a.backend.addEntry(ENTRY);
    w.fake.failNext({ method: "PUT", status: 409 });
    await cycle(w, a);
    expect(puts(w)).toHaveLength(2);
    expect(a.delays).toEqual([SYNC_TIMING.retryMs[0] + 125]);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
  });

  it("four 409/422 answers in a row: exactly 4 PUTs with 250/500/1000 ms waits plus jitter, then pending with the change kept; the next trigger saves it", async () => {
    const a = await open();
    await a.backend.addEntry(ENTRY);
    w.fake.failNext({ method: "PUT", status: 409 });
    w.fake.failNext({ method: "PUT", status: 422 });
    w.fake.failNext({ method: "PUT", status: 409 });
    w.fake.failNext({ method: "PUT", status: 409, message: `ledger/${ownLog(a)} does not match ${"a".repeat(40)}` });
    await cycle(w, a);
    expect(puts(w)).toHaveLength(4);
    expect(a.delays).toEqual([375, 625, 1125]);
    expect(a.engine.getState()).toMatchObject({ status: "pending", pendingCount: 1 });
    await cycle(w, a);
    expect(puts(w)).toHaveLength(5);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
  });

  it("a stale own sha (422 'sha wasn't supplied' after a lost create) re-runs steps 1, 2 and 5 and lands once", async () => {
    const a = await open();
    await a.backend.addEntry(ENTRY);
    w.fake.landThenDropResponse({ method: "PUT" });
    await cycle(w, a);
    await a.backend.addEntry(entry("Rent"));
    // A ref read that still shows the head before the lost create: the
    // next PUT omits the sha and gets 422.
    w.fake.staleReads(1);
    await cycle(w, a);
    w.fake.staleReads(0);
    await cycle(w, a);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    expect(await repoOps(w, a)).toEqual([2, 3]);
  });

  it("concurrent PUTs to different paths: the branch-race loser sends the same PUT again and lands", async () => {
    w = await world({ fake: { putLatencyMs: 30 } });
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await b.backend.addEntry(entry("Bus"));
    w.clock.mono += 10_000;
    const both = Promise.all([a.engine.sync(), b.engine.sync()]);
    let done = false;
    void both.then(() => (done = true));
    // Both PUTs are in flight against the same head before either lands.
    await until(() => puts(w).length === 2);
    while (!done) await vi.advanceTimersByTimeAsync(30);
    expect(puts(w).length).toBe(3);
    expect(w.fake.commits).toHaveLength(2);
    await quiesce(w, a, b);
    expectConverged(a, b);
    expect(remarks(a).sort()).toEqual(["Bus", "Groceries"]);
  });

  it("a branch-race 409 whose response is lost: the loser finds its file unchanged and sends again (AC11)", async () => {
    w = await world({ fake: { putLatencyMs: 30 } });
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await b.backend.addEntry(entry("Bus"));
    w.fake.landThenDropResponse({ method: "PUT", path: ownLog(a) });
    w.clock.mono += 10_000;
    // B's PUT is in flight first, then A's, against the same head.
    const bSync = b.engine.sync();
    await until(() => puts(w).length === 1);
    const both = Promise.all([bSync, a.engine.sync()]);
    let done = false;
    void both.then(() => (done = true));
    await until(() => puts(w).length === 2);
    while (!done) await vi.advanceTimersByTimeAsync(30);
    // B's landed first; A's lost the race, and its 409 never arrived.
    expect(w.fake.commits.map((c) => c.path)).toEqual([`ledger/${ownLog(b)}`]);
    expect(status(a)).toBe("pending");
    let quiet = false;
    const settled = quiesce(w, a, b).then(() => (quiet = true));
    while (!quiet) await vi.advanceTimersByTimeAsync(30);
    await settled;
    expectConverged(a, b);
    expect(remarks(b).sort()).toEqual(["Bus", "Groceries"]);
  });

  it("a network failure is pending ('offline'), keeps the change, and the next trigger saves it", async () => {
    const a = await open();
    await a.backend.addEntry(ENTRY);
    w.fake.failNext({ network: true });
    await cycle(w, a);
    expect(a.engine.getState()).toMatchObject({ status: "pending", pendingCount: 1 });
    await cycle(w, a);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
  });

  it("a 5xx is pending, and the next trigger saves", async () => {
    const a = await open();
    await a.backend.addEntry(ENTRY);
    w.fake.failNext({ method: "PUT", status: 500 });
    await cycle(w, a);
    expect(status(a)).toBe("pending");
    await cycle(w, a);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
  });

  it("401 and a 403 that is not a rate limit ask for a token; everything local is kept, and syncing resumes (B8)", async () => {
    const a = await open();
    await a.backend.addEntry(ENTRY);
    w.fake.failNext({ status: 401 });
    await cycle(w, a);
    expect(a.engine.getState()).toMatchObject({ status: "needsToken", pendingCount: 1 });
    await a.backend.addEntry(entry("Rent"));
    w.fake.failNext({ status: 403 });
    await cycle(w, a);
    expect(status(a)).toBe("needsToken");
    await cycle(w, a);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    expect(await repoOps(w, a)).toEqual([2, 3]);
  });

  it("a repo that is gone, or empty, is missing; nothing is written", async () => {
    const a = await open();
    await a.backend.addEntry(ENTRY);
    w.fake.failNext({ path: "/git/ref/", status: 404 });
    await cycle(w, a);
    expect(status(a)).toBe("missing");
    w.fake.failNext({ path: "/git/ref/", status: 409, message: "Git Repository is empty." });
    await cycle(w, a);
    expect(status(a)).toBe("missing");
    expect(puts(w)).toHaveLength(0);
    await cycle(w, a);
    expect(status(a)).toBe("idle");
  });

  describe("rate limits (B6, B14, B27)", () => {
    it("waits for the reset before trying again, and 'Try again' respects the wait", async () => {
      w.clock.wall = Date.now();
      const a = await open();
      await a.backend.addEntry(ENTRY);
      w.fake.failNext({ method: "PUT", status: 403, rateLimit: "secondary" });
      await cycle(w, a);
      expect(status(a)).toBe("pending");
      const from = w.fake.requests.length;
      w.clock.wall += 30_000;
      await a.engine.syncNow();
      expect(since(w, from)).toHaveLength(0);
      // GitHub said 60 s, from when it answered.
      await vi.advanceTimersByTimeAsync(61_000);
      await a.engine.sync();
      expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    });

    it("B6: a reset already past on this device's clock still waits the 60 s floor, instead of looping", async () => {
      w.clock.wall = Date.now() + 10 * 60_000;
      const a = await open();
      await a.backend.addEntry(ENTRY);
      w.fake.failNext({ method: "PUT", status: 403, rateLimit: "primary" });
      await cycle(w, a);
      const from = w.fake.requests.length;
      for (let i = 0; i < 5; i++) await a.engine.syncNow();
      expect(since(w, from)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(SYNC_TIMING.rateLimitFloorMs - 1);
      expect(since(w, from)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(a.engine.getState().pendingCount).toBe(0));
    });

    it("B14: the wait is capped at an hour, so a device clock behind GitHub's doesn't block syncing for hours", async () => {
      w.clock.wall = Date.now() - 3 * 60 * 60_000;
      const a = await open();
      await a.backend.addEntry(ENTRY);
      w.fake.failNext({ method: "PUT", status: 403, rateLimit: "primary" });
      await cycle(w, a);
      const from = w.fake.requests.length;
      await vi.advanceTimersByTimeAsync(SYNC_TIMING.rateLimitCapMs - 1);
      expect(since(w, from)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(a.engine.getState().pendingCount).toBe(0));
    });

    it("B27: a clock set back after a rate limit doesn't hold syncing until the old clock's wait is over", async () => {
      w.clock.wall = Date.now();
      const a = await open();
      await a.backend.addEntry(ENTRY);
      w.fake.failNext({ method: "PUT", status: 429 });
      await cycle(w, a);
      expect(status(a)).toBe("pending");
      w.clock.wall -= 24 * 60 * 60_000;
      await a.engine.syncNow();
      expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    });
  });

  describe("another device's file that can't be joined halts only its stream (B12, B18, B23, AC16, AC17)", () => {
    const cases: [string, (op: Op) => Promise<unknown>][] = [
      ["a bad shape", async () => ({ fv: 1, kind: "log", epoch: EPOCH, device: X })],
      ["a duplicate record (B23)", async (op) => logFile(X, [op, { ...structuredClone(op), L: op.L + 1 }])],
      ["a tag at 2^50", async (op) => logFile(X, [{ ...op, L: MAX_L }])],
      ["content that doesn't match its name", async (op) => logFile(deviceId(0xd), [op])],
      ["a create missing a field", async (op) => logFile(X, [{ ...op, set: op.set.filter(([key]) => !key.endsWith("/amount")) }])],
      // Decrypts with the household key, but the plaintext isn't gzip.
      ["a body that isn't gzip", async (op) => sealPlain(new TextEncoder().encode(JSON.stringify(logFile(X, [op]))))],
      // A small blob that would inflate past what any real file holds.
      ["a body that inflates past the bound", async (op) => sealPlain(await gzip(" ".repeat(REPO_FILE_MAX_PLAIN_BYTES) + JSON.stringify(logFile(X, [op]))))],
    ];
    for (const [name, make] of cases) {
      it(`${name}: needsAttention, nothing joined, the sha not recorded; other devices keep syncing`, async () => {
        const op = await someOp("Planted");
        const a = await open({ login: "alex" });
        const b = await open({ login: "sam" });
        await plant(w, { kind: "log", epoch: EPOCH, device: X }, await make(op));
        await b.backend.addEntry(entry("Bus"));
        await cycle(w, b, a);
        expect(status(a)).toBe("needsAttention");
        expect(remarks(a)).toEqual(["Bus"]);
        expect(a.store.meta().joined).not.toHaveProperty(`${EPOCH}.${X}.log.enc`);
        // Own writes carry on, and the next head is listed again.
        await a.backend.addEntry(entry("Groceries"));
        await cycle(w, a, b);
        expect(remarks(b).sort()).toEqual(["Bus", "Groceries"]);
        expect(status(a)).toBe("needsAttention");
        expect(a.engine.getState().pendingCount).toBe(0);
        // Robustness, not speed: building and inflating the 32 MiB body
        // takes about a second alone, and past vitest's 5 s default when the
        // whole suite runs at once on a loaded machine.
      }, 30_000);
    }

    it("a listed file larger than any real one is refused without being downloaded", async () => {
      const a = await open();
      const sha = await plant(w, { kind: "log", epoch: EPOCH, device: X }, `{"v":1}
${"A".repeat(REPO_FILE_MAX_BYTES)}`);
      await cycle(w, a);
      expect(status(a)).toBe("needsAttention");
      expect(w.fake.requests.filter((r) => r.path.endsWith(`/git/blobs/${sha}`))).toEqual([]);
      await a.backend.addEntry(entry("Groceries"));
      await cycle(w, a);
      expect(a.engine.getState().pendingCount).toBe(0);
    });

    it("a byte copy of a valid log under another device's name halts only the copy: the original is still joined, and devices converge", async () => {
      const b = await open({ login: "sam" });
      const c = await open({ login: "alex" });
      await b.backend.addEntry(entry("Bus"));
      await cycle(w, b, c);
      expect(remarks(c)).toEqual(["Bus"]);
      b.engine.stop();
      // The copy's name sorts before the original's, so it is read first.
      const original = w.fake.file(FULL, repoPath({ kind: "log", epoch: EPOCH, device: b.engine.deviceId! }))!;
      await plant(w, { kind: "log", epoch: EPOCH, device: deviceId(0) }, original.text);
      const fresh = await open({ login: "alex" });
      await cycle(w, fresh, c);
      expect(remarks(fresh)).toEqual(["Bus"]);
      expect(remarks(c)).toEqual(["Bus"]);
      for (const d of [fresh, c]) expect(status(d)).toBe("needsAttention");
      expectConverged(fresh, c);
    });

    it("a stream heals once its device writes a valid file", async () => {
      const op = await someOp("Planted");
      const a = await open();
      await plant(w, { kind: "log", epoch: EPOCH, device: X }, logFile(X, [{ ...op, L: MAX_L }]));
      await cycle(w, a);
      expect(status(a)).toBe("needsAttention");
      await plant(w, { kind: "log", epoch: EPOCH, device: X }, logFile(X, [op]));
      await cycle(w, a);
      expect(status(a)).toBe("idle");
      expect(remarks(a)).toEqual(["Planted"]);
    });

    it("a file encrypted with another key, or with another salt and iterations: needsAttention, never needsPassphrase (B18)", async () => {
      const op = await someOp();
      const other = await testKey();
      const a = await open();
      await plant(w, { kind: "log", epoch: EPOCH, device: X }, logFile(X, [op]), { ...other, salt: w.key.salt, iter: w.key.iter });
      await cycle(w, a);
      expect(status(a)).toBe("needsAttention");
      await plant(w, { kind: "log", epoch: EPOCH, device: X }, logFile(X, [op]), { ...w.key, salt: bytesToBase64(newSalt()) });
      await cycle(w, a);
      expect(status(a)).toBe("needsAttention");
      expect(remarks(a)).toEqual([]);
    });

    it("a newer header version or format on another device's file: needsUpdate, only that stream halts, own writes still go out (AC16)", async () => {
      const op = await someOp();
      const a = await open({ login: "alex" });
      await plant(w, { kind: "log", epoch: EPOCH, device: X }, '{"v":2,"kdf":"Argon2id"}\nAAAA');
      await cycle(w, a);
      expect(status(a)).toBe("needsUpdate");
      await plant(w, { kind: "log", epoch: EPOCH, device: X }, { ...logFile(X, [op]), fv: 2 });
      await a.backend.addEntry(entry("Groceries"));
      await cycle(w, a);
      expect(status(a)).toBe("needsUpdate");
      const b = await open({ login: "sam" });
      expect(remarks(b)).toEqual(["Groceries"]);
    });

    it("a log whose snapshot point is past what this device has seen waits for that snapshot: saving, nothing joined (section 8.2)", async () => {
      const op = await someOp();
      const a = await open();
      await plant(w, { kind: "log", epoch: EPOCH, device: X }, logFile(X, [{ ...op, L: 9 }], { snapThrough: 8 }));
      await cycle(w, a);
      expect(status(a)).toBe("saving");
      expect(remarks(a)).toEqual([]);
      expect(a.store.meta().joined).not.toHaveProperty(`${EPOCH}.${X}.log.enc`);
    });
  });

  describe("the epoch's genesis (section 12, AC5, AC16)", () => {
    it("undecryptable with the stored key: needsPassphrase, and no PUT", async () => {
      const a = await open({ noSettle: true });
      a.engine.stop();
      const other = await testKey();
      await plant(w, { kind: "genesis", epoch: EPOCH }, { fv: 1, kind: "genesis", epoch: EPOCH, reason: "create", by: "alex", at: 1, basedOn: null, doc: w.doc }, { ...other, salt: w.key.salt, iter: w.key.iter });
      const b = await open();
      await b.backend.addEntry(ENTRY);
      await cycle(w, b);
      expect(status(b)).toBe("needsPassphrase");
      expect(puts(w)).toHaveLength(0);
    });

    it("one that decrypts but isn't gzip: needsAttention, no PUT, and it is read once", async () => {
      const sha = await plant(w, { kind: "genesis", epoch: EPOCH }, await sealPlain(new TextEncoder().encode(JSON.stringify({ fv: 1, kind: "genesis", epoch: EPOCH, reason: "create", by: "alex", at: 1, basedOn: null, doc: w.doc }))));
      const a = await open();
      await a.backend.addEntry(ENTRY);
      for (let i = 0; i < 3; i++) await cycle(w, a);
      expect(status(a)).toBe("needsAttention");
      expect(puts(w)).toHaveLength(0);
      expect(w.fake.requests.filter((r) => r.path.endsWith(`/git/blobs/${sha}`))).toHaveLength(1);
    });

    it("a newer format: needsUpdate, no PUT, and writes are refused with a 503", async () => {
      await plant(w, { kind: "genesis", epoch: EPOCH }, { fv: 2, kind: "genesis", epoch: EPOCH });
      const a = await open();
      expect(status(a)).toBe("needsUpdate");
      await expect(a.backend.addEntry(ENTRY)).rejects.toEqual(new ApiError(503, LEDGER_UPDATED));
      expect(puts(w)).toHaveLength(0);
    });
  });

  it("saved state this build can't read: unreadable, and the engine sends no request (B13)", async () => {
    const store = new MemoryStore();
    const a = await open({ store });
    a.engine.stop();
    store.tamperMeta((meta) => (meta.formatVersion = 2));
    const from = w.fake.requests.length;
    const again = await open({ store });
    expect(again.engine.getState()).toMatchObject({ status: "unreadable", unreadable: "newer" });
    await again.engine.sync();
    expect(since(w, from)).toHaveLength(0);
  });

  it("stale reads of the ref and the listing are harmless: nothing lost or undone, own confirmations never go back", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await cycle(w, a);
    await b.backend.addEntry(entry("Bus"));
    await cycle(w, b);
    for (const lag of [1, 2, 3]) {
      w.fake.staleReads(lag);
      await cycle(w, a, b);
      expect(a.engine.getState().pendingCount).toBe(0);
    }
    w.fake.staleReads(0);
    const before = puts(w).length;
    await quiesce(w, a, b);
    expect(puts(w).length).toBe(before);
    expectConverged(a, b);
    expect(remarks(a).sort()).toEqual(["Bus", "Groceries"]);
  });

  it("an unexpected throw ends the cycle as pending, never stuck at saving, and the next trigger recovers (B12)", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await b.backend.addEntry(entry("Bus"));
    await cycle(w, b);
    await a.backend.addEntry(ENTRY);
    vi.spyOn(a.client, "listDir").mockRejectedValueOnce(new RangeError("boom"));
    await cycle(w, a);
    expect(status(a)).toBe("pending");
    expect(a.logs.some((line) => line.startsWith("sync failed"))).toBe(true);
    await cycle(w, a);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    expect(remarks(a).sort()).toEqual(["Bus", "Groceries"]);
  });

  it("a newer epoch in the repo stops the cycle until switching epochs lands (restore): nothing more is written here", async () => {
    const a = await open();
    await plant(w, { kind: "genesis", epoch: "e000002-0000000b" }, { fv: 1, kind: "genesis", epoch: "e000002-0000000b", reason: "restore", by: "sam", at: 2, basedOn: null, doc: w.doc });
    await a.backend.addEntry(ENTRY);
    await cycle(w, a);
    expect(status(a)).toBe("needsAttention");
    expect(puts(w)).toHaveLength(0);
    expect(a.engine.getState().pendingCount).toBe(1);
  });

  it("idle devices make no PUT over 50 polls under ±30 days of clock skew, and each idle poll is one request (AC9, B3)", async () => {
    const day = 24 * 60 * 60_000;
    const a = await open({ login: "alex", now: () => w.clock.wall + 30 * day });
    const b = await open({ login: "sam", now: () => w.clock.wall - 30 * day });
    await a.backend.addEntry(entry("Groceries"));
    const added = await b.backend.addEntry(entry("Bus"));
    await b.backend.deleteEntry(2026, 5, added.row);
    await quiesce(w, a, b);
    const before = { puts: puts(w).length, requests: w.fake.requests.length };
    for (let round = 0; round < 50; round++) await cycle(w, a, b);
    expect(puts(w).length).toBe(before.puts);
    expect(w.fake.requests.length - before.requests).toBe(100);
  });
});

describe("forks and rehome (section 10.3, AC19)", () => {
  it("a cloned profile: the copy whose PUT is refused finds the fork, rehomes under a new id, and nothing is lost", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Before the copy"));
    await cycle(w, a);
    const twin = await open({ login: "alex", store: a.store.clone() });
    expect(twin.engine.deviceId).toBe(a.engine.deviceId);
    const old = a.engine.deviceId;
    await a.backend.addEntry(entry("On the original"));
    await twin.backend.addEntry(entry("On the copy"));
    await cycle(w, a, twin);
    expect(twin.engine.deviceId).not.toBe(old);
    expect(a.engine.deviceId).toBe(old);
    expect(twin.engine.getState().noticeCount).toBe(1);
    expect(await twin.store.notices(w.key)).toEqual([expect.objectContaining({ kind: "rehome", from: old, to: twin.engine.deviceId, message: REHOMED })]);
    const b = await open({ login: "sam" });
    await quiesce(w, a, twin, b);
    expectConverged(a, twin, b);
    expect(remarks(b).sort()).toEqual(["Before the copy", "On the copy", "On the original"]);
    expect(w.fake.violations).toEqual([]);
    for (const d of [a, twin, b]) expect(d.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
  });

  it("re-issues the copy's own writes at their original L under the new id, edits and deletes included", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Lunch"));
    await a.backend.addEntry(entry("Tea"));
    await cycle(w, a);
    const twin = await open({ login: "alex", store: a.store.clone() });
    await a.backend.addEntry(entry("Original"));
    await cycle(w, a);
    await twin.backend.updateEntry(2026, 5, await row(twin, "Lunch"), edits("Lunch", 99));
    await twin.backend.deleteEntry(2026, 5, await row(twin, "Tea"));
    await cycle(w, twin);
    expect(await repoOps(w, twin)).toEqual([4, 5]);
    expect(twin.engine.getState().noticeCount).toBe(1);
    await quiesce(w, a, twin);
    expectConverged(a, twin);
    expect(remarks(a)).toEqual(["Lunch", "Original"]);
    expect((await a.backend.getMonth(2026, 5)).find((e) => e.remarks === "Lunch")!.amount).toBe(99);
  });

  it("an IndexedDB rolled back below its own repo file rehomes, keeps the repo's later writes and loses nothing", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("One"));
    await cycle(w, a);
    const backup = a.store.clone();
    await a.backend.addEntry(entry("Two"));
    await a.backend.addEntry(entry("Three"));
    await cycle(w, a);
    a.engine.stop();
    const restored = await open({ login: "alex", store: backup });
    expect(restored.engine.getState().noticeCount).toBe(1);
    expect(remarks(restored)).toEqual(["One", "Two", "Three"]);
    await restored.backend.addEntry(entry("Four"));
    const b = await open({ login: "sam" });
    await quiesce(w, restored, b);
    expectConverged(restored, b);
    expect(remarks(b)).toEqual(["One", "Two", "Three", "Four"]);
    expect(w.fake.violations).toEqual([]);
  });

  it("a write submitted while a rehome rebuilds the state waits its turn, then commits under the new id and is pushed", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Before the copy"));
    await cycle(w, a);
    const twin = await open({ login: "alex", store: a.store.clone() });
    await a.backend.addEntry(entry("On the original"));
    await cycle(w, a);
    await twin.backend.addEntry(entry("On the copy"));
    // Hold the twin's blob reads after the one that finds the fork.
    let reads = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const read = twin.client.readBlob.bind(twin.client);
    vi.spyOn(twin.client, "readBlob").mockImplementation(async (sha) => {
      if (++reads > 1) await held;
      return read(sha);
    });
    const old = twin.engine.deviceId;
    w.clock.mono += 10_000;
    const syncing = twin.engine.sync();
    await until(() => reads > 1);
    const during = twin.backend.addEntry(entry("During the rehome"));
    release();
    await during;
    await syncing;
    expect(twin.engine.deviceId).not.toBe(old);
    expect(twin.engine.pushableOps().at(-1)!.L).toBeGreaterThan(3);
    await quiesce(w, a, twin);
    expectConverged(a, twin);
    expect(remarks(a).sort()).toEqual(["Before the copy", "During the rehome", "On the copy", "On the original"]);
  });
  describe("a rehome settles which streams are halted or waiting from its cold join", () => {
    /** a halts X's stream; a clone of a's profile pushes under a's id, so
     * a's next cycle finds the fork and rehomes. `heal` runs just before
     * that cycle, in the repo. */
    async function forkWhileHalted(broken: unknown, heal: () => Promise<void>): Promise<{ a: Device; twin: Device }> {
      const a = await open();
      await a.backend.addEntry(entry("Groceries"));
      await cycle(w, a);
      await plant(w, { kind: "log", epoch: EPOCH, device: X }, broken);
      await cycle(w, a);
      const twin = await open({ store: a.store.clone(), login: "sam" });
      await twin.backend.addEntry(entry("Tea"));
      await cycle(w, twin);
      await heal();
      await cycle(w, a);
      expect(a.logs.some((l) => l.includes("syncs on as a new device"))).toBe(true);
      return { a, twin };
    }

    it("a stream that healed before the rehome no longer halts the device, before or after its next push", async () => {
      const { a, twin } = await forkWhileHalted({ fv: 1, kind: "log", epoch: EPOCH, device: X }, () => plant(w, { kind: "log", epoch: EPOCH, device: X }, logFile(X, [])).then(() => undefined));
      for (let i = 0; i < 5; i++) await cycle(w, a, twin);
      expectConverged(a, twin);
      expect(remarks(a).sort()).toEqual(["Groceries", "Tea"]);
      for (const d of [a, twin]) expect(d.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    });

    it("a stream on a newer format that healed before the rehome no longer asks for an update", async () => {
      const op = await someOp("Planted");
      const { a } = await forkWhileHalted({ ...logFile(X, [op]), fv: 2 }, () => plant(w, { kind: "log", epoch: EPOCH, device: X }, logFile(X, [op])).then(() => undefined));
      for (let i = 0; i < 5; i++) await cycle(w, a);
      expect(remarks(a).sort()).toEqual(["Groceries", "Planted", "Tea"]);
      expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    });

    it("a log that waited for its snapshot and was rewritten before the rehome no longer keeps the device saving", async () => {
      const op = await someOp("Planted");
      const { a } = await forkWhileHalted(logFile(X, [{ ...op, L: 9 }], { snapThrough: 8 }), () => plant(w, { kind: "log", epoch: EPOCH, device: X }, logFile(X, [op])).then(() => undefined));
      for (let i = 0; i < 5; i++) await cycle(w, a);
      expect(remarks(a).sort()).toEqual(["Groceries", "Planted", "Tea"]);
      expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    });

    it("a stream still broken at the rehome stays halted after it, and heals when its device writes a valid file", async () => {
      const op = await someOp("Planted");
      const { a } = await forkWhileHalted({ ...logFile(X, [op]), fv: 2 }, async () => {});
      expect(a.engine.getState()).toMatchObject({ status: "needsUpdate", pendingCount: 0 });
      await cycle(w, a);
      expect(status(a)).toBe("needsUpdate");
      await plant(w, { kind: "log", epoch: EPOCH, device: X }, logFile(X, [op]));
      await cycle(w, a);
      expect(remarks(a).sort()).toEqual(["Groceries", "Planted", "Tea"]);
      expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    });
  });
});

describe("more failure points", () => {
  it("a tab closed mid-PUT writes nothing more, and the next start settles whatever landed", async () => {
    const store = new MemoryStore();
    const a = await open({ store });
    await a.backend.addEntry(ENTRY);
    w.fake.landLater(1, { method: "PUT" });
    const syncing = cycle(w, a);
    a.engine.stop();
    await syncing;
    const mutations = store.mutations.length;
    await a.engine.sync();
    expect(store.mutations.length).toBe(mutations);
    w.fake.landPending();
    const again = await open({ store });
    expect(again.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    expect(await repoOps(w, again)).toEqual([2]);
  });

  it("a truncated listing is never read as an absence: the device's own file is written with the sha it knows", async () => {
    w = await world({ fake: { treeEntryLimit: 2 } });
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await cycle(w, a);
    await a.backend.addEntry(entry("Rent"));
    await cycle(w, a);
    expect(a.engine.getState()).toMatchObject({ pendingCount: 0 });
    expect(await repoOps(w, a)).toEqual([2, 3]);
    expect(puts(w)).toHaveLength(2);
    expect(remarks(a)).toEqual(["Groceries", "Rent"]);
  });

  it("a truncated listing that leaves out the genesis is pending, never missing: nothing is read into what it left out", async () => {
    // Device files ("<epoch>.d…") sort before the genesis ("<epoch>.genesis…"),
    // so a tree cut short drops the genesis first.
    w = await world({ fake: { treeEntryLimit: 3 } });
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await cycle(w, a);
    await b.backend.addEntry(entry("Bus"));
    await cycle(w, b);
    await cycle(w, a);
    expect(status(a)).toBe("pending");
    expect(a.engine.getState().pendingCount).toBe(0);
    await a.backend.addEntry(entry("Rent"));
    await cycle(w, a);
    expect(status(a)).toBe("pending");
    expect(remarks(a)).toEqual(["Groceries", "Rent"]);
  });
});

describe("old catalogue (section 13)", () => {
  it("B2, B25: delete wins over a concurrent offline edit on every device; the edit stays recoverable in state", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    const c = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a, b, c);
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), edits("Groceries", 99));
    await b.backend.deleteEntry(2026, 5, await row(b, "Groceries"));
    await quiesce(w, a, b, c);
    for (const d of [a, b, c]) expect(remarks(d)).toEqual([]);
    expectConverged(a, b, c);
  });

  it("B4: no answer is stored for later: after a failed cycle, a later remote edit simply wins by its tag", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries", 10));
    await quiesce(w, a, b);
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), edits("Groceries", 20));
    w.fake.failNext({ network: true });
    await cycle(w, a);
    await cycle(w, a);
    await cycle(w, b);
    await b.backend.updateEntry(2026, 5, await row(b, "Groceries"), edits("Groceries", 30));
    await quiesce(w, a, b);
    for (const d of [a, b]) expect((await d.backend.getMonth(2026, 5))[0].amount).toBe(30);
  });

  it("B10, B19: a save that changes nothing makes no op, and a later stamp from a fast clock doesn't beat a delete", async () => {
    const a = await open({ login: "alex", now: () => w.clock.wall + 3_600_000 });
    const b = await open({ login: "sam" });
    await b.backend.addEntry(entry("Groceries"));
    await quiesce(w, a, b);
    const before = puts(w).length;
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), edits("Groceries", 10));
    expect(a.engine.getState().pendingCount).toBe(0);
    await cycle(w, a);
    expect(puts(w).length).toBe(before);
    // Concurrent: an edit stamped an hour later, and a delete.
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), edits("Groceries", 12));
    await b.backend.deleteEntry(2026, 5, await row(b, "Groceries"));
    await quiesce(w, a, b);
    for (const d of [a, b]) expect(remarks(d)).toEqual([]);
  });

  it("B16: after a lost PUT response, another device's later revert is not undone by the next sync", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries", 10));
    await quiesce(w, a, b);
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), edits("Groceries", 99));
    w.fake.landThenDropResponse({ method: "PUT" });
    await cycle(w, a);
    await cycle(w, b);
    await b.backend.updateEntry(2026, 5, await row(b, "Groceries"), edits("Groceries", 10));
    await quiesce(w, a, b);
    for (const d of [a, b]) expect((await d.backend.getMonth(2026, 5))[0].amount).toBe(10);
  });

  it("B16: after a lost PUT response, another device's later month unlock is not undone", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.setMonthLock(2026, 5, true);
    w.fake.landThenDropResponse({ method: "PUT" });
    await cycle(w, a);
    await cycle(w, b);
    expect((await b.backend.getMonthLock(2026, 5)).locked).toBe(true);
    await b.backend.setMonthLock(2026, 5, false);
    await quiesce(w, a, b);
    for (const d of [a, b]) expect((await d.backend.getMonthLock(2026, 5)).locked).toBe(false);
  });

  it("B26: a PUT that times out but lands after the next read doesn't undo a later edit that sets the value back", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries", 10));
    await quiesce(w, a, b);
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), edits("Groceries", 99));
    w.fake.landLater(2, { method: "PUT" });
    await cycle(w, a);
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), edits("Groceries", 10));
    await quiesce(w, a, b);
    w.fake.landPending();
    await quiesce(w, a, b);
    for (const d of [a, b]) expect((await d.backend.getMonth(2026, 5))[0].amount).toBe(10);
    expectConverged(a, b);
  });

  it("B26: a month unlock made after a timed-out lock isn't undone when the lock lands late, across a reload", async () => {
    const store = new MemoryStore();
    const a = await open({ login: "alex", store });
    const b = await open({ login: "sam" });
    await a.backend.setMonthLock(2026, 5, true);
    w.fake.landLater(3, { method: "PUT" });
    await cycle(w, a);
    await a.backend.setMonthLock(2026, 5, false);
    a.engine.stop();
    const again = await open({ login: "alex", store });
    w.fake.landPending();
    await quiesce(w, again, b);
    for (const d of [again, b]) expect((await d.backend.getMonthLock(2026, 5)).locked).toBe(false);
  });

  it("B26: of two timed-out PUTs, the earlier landing late is recognised as this device's own write", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    w.fake.landLater(50, { method: "PUT" });
    await cycle(w, a);
    await a.backend.addEntry(entry("Rent"));
    w.fake.landLater(50, { method: "PUT" });
    await cycle(w, a);
    // Only the first lands.
    const held = w.fake.requests.filter((r) => r.method === "PUT");
    expect(held).toHaveLength(2);
    w.fake.landPending();
    await cycle(w, a, a);
    expect(a.engine.getState()).toMatchObject({ status: "idle", pendingCount: 0 });
    expect(await repoOps(w, a)).toEqual([2, 3]);
    expect(a.engine.getState().noticeCount).toBe(0);
  });

  it("B28: a PUT refused by another device's commit, whose answer is lost, is not taken as landed: the expense is kept", async () => {
    w = await world({ fake: { putLatencyMs: 30 } });
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await b.backend.addEntry(entry("Bus"));
    w.fake.landThenDropResponse({ method: "PUT", path: ownLog(a) });
    w.clock.mono += 10_000;
    // B's PUT is in flight first, then A's, against the same head.
    const bSync = b.engine.sync();
    await until(() => puts(w).length === 1);
    const both = Promise.all([bSync, a.engine.sync()]);
    let done = false;
    void both.then(() => (done = true));
    await until(() => puts(w).length === 2);
    while (!done) await vi.advanceTimersByTimeAsync(30);
    // B's landed first; A's lost the race, and its 409 never arrived.
    expect(w.fake.commits.map((c) => c.path)).toEqual([`ledger/${ownLog(b)}`]);
    expect(a.engine.getState().pendingCount).toBe(1);
    let quiet = false;
    const settled = quiesce(w, a, b).then(() => (quiet = true));
    while (!quiet) await vi.advanceTimersByTimeAsync(30);
    await settled;
    expect(remarks(b).sort()).toEqual(["Bus", "Groceries"]);
  });

  it("an offline delete holds against another device's move away and back to the same place", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    for (const text of ["Lunch", "Bus", "Tea"]) await a.backend.addEntry(entry(text));
    await quiesce(w, a, b);
    await a.backend.deleteEntry(2026, 5, await row(a, "Bus"));
    await b.backend.moveEntry(2026, 5, await row(b, "Bus"), await row(b, "Lunch"));
    await b.backend.moveEntry(2026, 5, await row(b, "Bus"), await row(b, "Tea"));
    await quiesce(w, a, b);
    for (const d of [a, b]) expect(remarks(d)).toEqual(["Lunch", "Tea"]);
  });
});

// --- Every interleaving of two devices' requests (section 16.2) -------------

/** Holds each device's requests until the schedule lets one through. */
class Gate {
  on = false;
  readonly waiting = new Map<string, () => void>();
  wrap(label: string): (fetch: typeof globalThis.fetch) => typeof globalThis.fetch {
    return (inner) => async (input, init) => {
      if (this.on) await new Promise<void>((resolve) => this.waiting.set(label, resolve));
      return inner(input, init);
    };
  }
  release(label: string): void {
    const go = this.waiting.get(label)!;
    this.waiting.delete(label);
    go();
  }
}

/** A's and B's cycles run at once over three offline writes each; at every
 * step where both wait, `prefix` (then A) picks whose request goes next.
 * Returns every choice made. */
async function runSchedule(prefix: number[]) {
  w = await world();
  const gate = new Gate();
  const a = await open({ login: "alex", wrapFetch: gate.wrap("A") });
  const b = await open({ login: "sam", wrapFetch: gate.wrap("B") });
  for (const text of ["Lunch", "Bus", "Tea"]) await a.backend.addEntry(entry(text));
  await quiesce(w, a, b);

  await a.backend.addEntry(entry("Groceries"));
  await a.backend.updateEntry(2026, 5, await row(a, "Lunch"), edits("Lunch", 99));
  await a.backend.setMonthLock(2026, 6, true);
  await b.backend.addEntry(entry("Snacks"));
  await b.backend.moveEntry(2026, 5, await row(b, "Tea"), await row(b, "Lunch"));
  await b.backend.deleteEntry(2026, 5, await row(b, "Bus"));

  gate.on = true;
  w.clock.mono += 10_000;
  const done = { A: false, B: false };
  const choices: number[] = [];
  // Two cycles each, so each also reads what the other wrote.
  const twice = async (d: Device) => {
    await d.engine.sync();
    await d.engine.sync();
  };
  const flights = [twice(a).then(() => (done.A = true)), twice(b).then(() => (done.B = true))];
  for (;;) {
    while (!((gate.waiting.has("A") || done.A) && (gate.waiting.has("B") || done.B))) await nextTask();
    if (done.A && done.B) break;
    const ready = [...gate.waiting.keys()].sort();
    let pick = ready[0];
    if (ready.length === 2) {
      const choice = prefix[choices.length] ?? 0;
      choices.push(choice);
      pick = choice === 0 ? "A" : "B";
    }
    gate.release(pick);
  }
  await Promise.all(flights);
  gate.on = false;
  await quiesce(w, a, b);
  for (const d of [a, b]) d.engine.stop();
  running.length = 0;
  return { a, b, choices };
}

describe("every interleaving of two devices' concurrent cycles (section 16.2)", () => {
  it("converges with every offline write applied, each PUT one commit, and both devices idle", async () => {
    const stack: number[][] = [[]];
    let schedules = 0;
    while (stack.length > 0) {
      const prefix = stack.pop()!;
      const { a, b, choices } = await runSchedule(prefix);
      for (let k = prefix.length; k < choices.length; k++) stack.push([...choices.slice(0, k), 1]);
      schedules++;
      const where = `schedule ${choices.join("")}`;
      expectConverged(a, b);
      expect([...remarks(a)].sort(), where).toEqual(["Groceries", "Lunch", "Snacks", "Tea"]);
      expect(remarks(a).slice(0, 2), where).toEqual(["Tea", "Lunch"]);
      expect((await a.backend.getMonth(2026, 5)).find((e) => e.remarks === "Lunch")!.amount, where).toBe(99);
      expect((await b.backend.getMonthLock(2026, 6)).locked, where).toBe(true);
      for (const d of [a, b]) expect(d.engine.getState(), where).toMatchObject({ status: "idle", pendingCount: 0, noticeCount: 0 });
      expect(w.fake.commits.length, where).toBe(puts(w).length);
      expect(w.fake.violations, where).toEqual([]);
    }
    expect(schedules).toBeGreaterThan(20);
  }, 120_000);
});
