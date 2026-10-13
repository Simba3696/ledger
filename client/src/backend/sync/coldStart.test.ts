import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubClient } from "../github/contents";
import { FORMAT_VERSION } from "./codec";
import { EPOCH, FULL, cycle, device, entry, logFile, plant, world, type Device, type World } from "./cycleTestkit";
import { findLedger, openGenesis } from "./ledgerRepo";
import { repoPath } from "./repoFiles";
import type { SyncEngine } from "./SyncEngine";
import { deviceId } from "./testkit";

// A cold start (design section 8.3, owner decision D24): a new device joins
// a ledger that three devices have written to, each with a snapshot and a
// log, as #8's join does it (check the repo, find the ledger, open its
// genesis, initialise), then runs its first cycle. Every request is sent
// after a simulated network delay, so reads that overlap finish in an order
// of the delays' choosing. Fictional data only.

/** The timer the delays use: the tests fake setTimeout for the engine's own
 * timers, which then fire only when a test moves them. Taken before any
 * test installs the fake. */
const realSetTimeout = globalThis.setTimeout;

const running: SyncEngine[] = [];
let w: World;
const X = deviceId(0xc);
const Y = deviceId(0xd);

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

interface Sent {
  kind: string;
  path: string;
}

/** Counts what a device sends, and the most blob reads in flight at once. */
class Network {
  readonly sent: Sent[] = [];
  inFlight = 0;
  peak = 0;
  #blobs = 0;
  readonly delay: (kind: string, nth: number) => number;

  /** `delay(kind, nth)`: the milliseconds before a request is sent, where
   * `nth` counts this device's blob reads from 0. */
  constructor(delay: (kind: string, nth: number) => number) {
    this.delay = delay;
  }

  wrap = (inner: typeof fetch): typeof fetch => {
    return async (input, init) => {
      const path = String(input).replace(/^https:\/\/api\.github\.com/, "").split("?")[0];
      const method = init?.method ?? "GET";
      const kind = method !== "GET" ? method : path.includes("/git/blobs/") ? "blob" : path.includes("/git/ref/") ? "ref" : path.includes("/git/trees/") ? "listing" : "repo";
      this.sent.push({ kind, path });
      const ms = this.delay(kind, kind === "blob" ? this.#blobs++ : -1);
      if (kind === "blob") {
        this.inFlight++;
        this.peak = Math.max(this.peak, this.inFlight);
      }
      try {
        await new Promise((resolve) => realSetTimeout(resolve, ms));
        return await inner(input, init);
      } finally {
        if (kind === "blob") this.inFlight--;
      }
    };
  };

  count(kind: string): number {
    return this.sent.filter((s) => s.kind === kind).length;
  }

  reads(sha: string): number {
    return this.sent.filter((s) => s.kind === "blob" && s.path.endsWith(`/${sha}`)).length;
  }
}

/** Three devices on two logins, each with a snapshot and a log holding ops
 * past it, and two streams that can't be joined: a malformed log (X) and
 * one written by a newer build (Y). */
async function ledgerOfThree(): Promise<Device[]> {
  const devices = [await open({ login: "alex", compaction: { logOps: 2 } }), await open({ login: "sam", compaction: { logOps: 2 } }), await open({ login: "alex", compaction: { logOps: 2 } })];
  for (const [i, d] of devices.entries()) {
    for (let n = 0; n < 5; n++) {
      await d.backend.addEntry(entry(`Device ${i} entry ${n}`, 10 + n));
      for (let c = 0; c < 3; c++) await cycle(w, d);
    }
  }
  for (const d of devices) {
    expect(w.fake.file(FULL, repoPath({ kind: "snap", epoch: EPOCH, device: d.engine.deviceId! }))).not.toBeNull();
    expect(w.fake.file(FULL, repoPath({ kind: "log", epoch: EPOCH, device: d.engine.deviceId! }))).not.toBeNull();
  }
  await plant(w, { kind: "log", epoch: EPOCH, device: X }, { ...logFile(X, []), surprise: true });
  await plant(w, { kind: "log", epoch: EPOCH, device: Y }, logFile(Y, [], { fv: FORMAT_VERSION + 1 }));
  for (const d of devices) await cycle(w, d);
  return devices;
}

/** A new device joining as #8 does, over `net`; `handOver` passes the
 * genesis it opened on to initialize. */
async function coldStart(net: Network, { handOver = true }: { handOver?: boolean } = {}): Promise<Device> {
  const client = createGitHubClient({ owner: "alex", repo: "ledger-data", token: "github_pat_sam", fetch: net.wrap(w.fake.fetchAs("dnone")) });
  await client.verifyRepo();
  const found = await findLedger({ client, branch: "main" });
  if (found.kind !== "ledger") throw new Error(`no ledger found: ${found.kind}`);
  const opened = await openGenesis(found, w.key);
  if (!opened.ok) throw new Error(`the genesis can't be opened: ${opened.problem}`);
  return open({ login: "sam", init: { epoch: opened.epoch, state: opened.state, ...(handOver ? { sha: opened.sha } : {}) }, wrapFetch: net.wrap });
}

/** What a cold start joined and recorded, without the device's own id. */
function outcome(d: Device) {
  const meta = d.store.meta();
  return {
    doc: d.engine.current(),
    status: d.engine.getState().status,
    joined: meta.joined as Record<string, string>,
    logReach: meta.logReach,
    snapReach: meta.snapReach,
    seen: meta.seen,
    maxL: meta.maxL,
    lastSeenCommit: meta.lastSeenCommit,
    refused: d.logs.filter((line) => line.includes("can't be joined")).sort(),
  };
}

describe("cold start (section 8.3)", () => {
  it("joins the same files to the same result whatever order its reads finish in", async () => {
    const devices = await ledgerOfThree();
    // Reads answered in the order they were sent, and in reverse: the
    // first blob read waits longest.
    const inOrder = await coldStart(new Network(() => 1));
    const reversed = await coldStart(new Network((kind, nth) => (kind === "blob" ? Math.max(1, 40 - 5 * nth) : 1)));
    const a = outcome(inOrder);
    expect(outcome(reversed)).toEqual(a);
    // Both hold what the devices hold, and each unreadable stream halted
    // only itself.
    expect(a.doc).toEqual(devices[0].engine.current());
    expect(Object.values(a.doc.expenses).flat()).toHaveLength(15);
    expect(a.refused).toHaveLength(2);
    expect(a.refused.some((line) => line.includes(X) && line.includes("(malformed)"))).toBe(true);
    expect(a.refused.some((line) => line.includes(Y) && line.includes("(needsUpdate)"))).toBe(true);
    for (const d of devices) expect(Object.keys(a.joined)).toContain(`${EPOCH}.${d.engine.deviceId}.log.enc`);
    expect(w.fake.violations).toEqual([]);
  }, 30_000);

  it("reads the genesis once: the join hands the version it opened to initialize", async () => {
    await ledgerOfThree();
    const genesisSha = w.fake.file(FULL, repoPath({ kind: "genesis", epoch: EPOCH }))!.sha;
    const before = new Network(() => 1);
    const without = outcome(await coldStart(before, { handOver: false }));
    const after = new Network(() => 1);
    const handed = outcome(await coldStart(after));
    expect(before.reads(genesisSha)).toBe(2);
    expect(after.reads(genesisSha)).toBe(1);
    expect(after.count("blob")).toBe(before.count("blob") - 1);
    expect(after.sent.length).toBe(before.sent.length - 1);
    // Nothing else changes: the genesis is recorded as joined either way.
    expect(handed).toEqual(without);
    expect(handed.joined).toHaveProperty(`${EPOCH}.genesis.enc`, genesisSha);
  }, 30_000);

  it("reads the other devices' files 4 at a time, each once, with no request it didn't need before", async () => {
    await ledgerOfThree();
    const net = new Network((kind) => (kind === "blob" ? 20 : 1));
    const d = await coldStart(net);
    // #8: the repo, the ref, the tree and the genesis. The first cycle: the
    // ref, the tree, and three snapshots and five logs (two of them refused
    // once read); then the settling cycle's ref and tree (a halted stream
    // keeps the head unhandled, so each poll lists again), and no blob: a
    // refused version is never downloaded again.
    expect({ repo: net.count("repo"), ref: net.count("ref"), listing: net.count("listing"), blob: net.count("blob") }).toEqual({ repo: 1, ref: 3, listing: 3, blob: 9 });
    const blobs = net.sent.filter((s) => s.kind === "blob").map((s) => s.path);
    expect(new Set(blobs).size).toBe(blobs.length);
    expect(net.peak).toBe(4);
    expect(d.engine.current()).toEqual(outcome(d).doc);
    // A cycle with nothing new downloads nothing.
    const before = net.sent.length;
    await cycle(w, d);
    expect(net.sent.slice(before).map((s) => s.kind)).toEqual(["ref", "listing"]);
  }, 30_000);
});
