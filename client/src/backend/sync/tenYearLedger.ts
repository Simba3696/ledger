import { vi } from "vitest";
import { LedgerError } from "@ledger/shared/errors";
import { RowHandles } from "../document/handles";
import type { LedgerDocument } from "../document/types";
import { device, expectConverged, quiesce, world, type Device, type World } from "./cycleTestkit";
import { Rng } from "./rng";
import type { SyncEngine } from "./SyncEngine";
import { Replica } from "./testkit";
import { CREATES, DAY, MINUTE, PLAN_DEVICES, holds, runEvent, writeContext, type Made, type Plan, type PlanEvent } from "./tenYearPlan";

export { PHONE_S, PLAN_DEVICES, planBurst, planLedger, runOnDocument, type Made } from "./tenYearPlan";

// Test support for the performance run (design section 16.5, AC7 in section
// 15 item 14): the 10-year plan of tenYearPlan.ts, and two ways to carry it
// out.
//
//   - runOnEngines: three real SyncEngines (two phones and a laptop, two
//     logins) on the fake GitHub, each write committed through the engine
//     (diff, fence, op, device store), each session ending in a real sync
//     cycle, compaction at its default limits. The logs, snapshots and repo
//     history are the engine's own, not hand-made.
//   - runOnDocument: the same writes applied in place to one document, with
//     no sync at all: a quick 10-year document for the normal suite's
//     regression guard.
//
// Writes run operations.ts, the code DocumentBackend runs for each write,
// on a copy of the document. The engine run copies only the month a write
// touches instead of the whole document (DocumentBackend's structuredClone),
// which would cost tens of ms per write at 10 years and make the run take
// many minutes; the document the engine diffs is the one DocumentBackend
// would hand it. Fictional data only.

/** One device's writes between two sync cycles: writes less than 45
 * minutes apart. */
interface Session {
  device: number;
  events: PlanEvent[];
}

function sessionsOf(events: readonly PlanEvent[]): Session[] {
  const open = new Map<number, Session>();
  const sessions: Session[] = [];
  for (const event of events) {
    const current = open.get(event.device);
    if (current && event.at - current.events.at(-1)!.at < 45 * MINUTE) {
      current.events.push(event);
      continue;
    }
    const session = { device: event.device, events: [event] };
    open.set(event.device, session);
    sessions.push(session);
  }
  return sessions;
}

/** The document a write runs on: `current` with the parts a write changes
 * copied. Every expense month but `month` is shared with `current`, which
 * no write changes in place; DocumentBackend clones it all. */
function draftOf(current: LedgerDocument, month: string): LedgerDocument {
  const { expenses, ...rest } = current;
  const draft = structuredClone(rest) as Omit<LedgerDocument, "expenses">;
  const copied = { ...expenses };
  if (expenses[month]) copied[month] = structuredClone(expenses[month]);
  return { ...draft, expenses: copied };
}

/** Where planned writes commit: a login, row handles, and a commit of the
 * next document built from the current one. */
export interface Writer {
  login: string;
  handles: RowHandles;
  commit(build: (current: LedgerDocument) => LedgerDocument): Promise<void>;
}

/** An engine's write path, as SyncedHost gives it to DocumentBackend: a
 * turn, the current document at that turn, then commit. */
export function engineWriter(engine: SyncEngine, login: string): Writer {
  return {
    login,
    handles: new RowHandles(),
    async commit(build) {
      const turn = engine.beginWrite();
      try {
        await turn.ready;
        await turn.commit(build(engine.current()));
      } finally {
        turn.end();
      }
    },
  };
}

/** A Replica's write path (testkit.ts): the diff, the join and incremental
 * materialisation, with no device store or network. */
export function replicaWriter(replica: Replica): Writer {
  return {
    login: replica.actor,
    handles: new RowHandles(),
    async commit(build) {
      replica.commitNow(build(replica.doc));
    },
  };
}

/** Commits one planned write through `writer`, as `device`, at `now`.
 * Records it creates are entered in `made`. False when the app refused it
 * (a LedgerError). */
export async function writePlanned(writer: Writer, event: PlanEvent, made: Map<string, Made>, device: number, now: number, newId: () => string): Promise<boolean> {
  try {
    await writer.commit((current) => {
      const draft = draftOf(current, event.month);
      runEvent(event, writeContext(draft, writer.handles, now, writer.login, newId), made, device);
      return draft;
    });
    return true;
  } catch (err) {
    if (err instanceof LedgerError) return false;
    throw err;
  }
}

/** A request the engines sent, as the run counts it. */
interface RequestRecord {
  device: string;
  method: string;
  /** "ref", "listing" (the tree), "blob", "repo", "put:log", "put:snap",
   * "put:genesis" or "other". */
  kind: string;
  status: number;
  /** For a PUT: the file text's length in bytes. */
  bytes: number;
  /** The plan's clock when it was sent. */
  at: number;
}

/** Counts requests by kind and the most in flight at once. */
class RequestMeter {
  readonly records: RequestRecord[] = [];
  inFlight = 0;
  peak = 0;
  readonly #clock: () => number;

  constructor(clock: () => number) {
    this.#clock = clock;
  }

  wrap(device: () => string): (inner: typeof fetch) => typeof fetch {
    return (inner) => async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      this.inFlight++;
      this.peak = Math.max(this.peak, this.inFlight);
      try {
        const res = await inner(input, init);
        this.records.push({ device: device(), method, kind: kindOf(method, url), status: res.status, bytes: method === "PUT" ? putBytes(init?.body) : 0, at: this.#clock() });
        return res;
      } finally {
        this.inFlight--;
      }
    };
  }

  /** Requests since index `from`, counted by kind. */
  countsSince(from = 0): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const r of this.records.slice(from)) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    return counts;
  }
}

function kindOf(method: string, url: string): string {
  const path = url.replace(/^https:\/\/api\.github\.com/, "").split("?")[0];
  if (method === "PUT") return path.endsWith(".genesis.enc") ? "put:genesis" : path.endsWith(".snap.enc") ? "put:snap" : path.endsWith(".log.enc") ? "put:log" : "put:other";
  if (path.includes("/git/ref/")) return "ref";
  if (path.includes("/git/blobs/")) return "blob";
  if (path.includes("/git/trees/")) return "listing";
  if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return "repo";
  return "other";
}

/** The file text's length in a contents PUT body (base64 inside JSON). */
function putBytes(body: unknown): number {
  if (typeof body !== "string") return 0;
  const { content } = JSON.parse(body) as { content: string };
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  return (content.length * 3) / 4 - padding;
}

export interface EngineRun {
  w: World;
  devices: Device[];
  writers: Writer[];
  meter: RequestMeter;
  plan: Plan;
  /** Writes each device committed, and writes refused (none expected). */
  writes: number[];
  refused: number;
  /** Writes moved to the device that made the record, because the planned
   * device didn't hold it yet. */
  rerouted: number;
  cycles: number;
  /** Real time the run took, and the part of it spent in writes and in
   * sync cycles, in ms. */
  elapsedMs: number;
  writeMs: number;
  syncMs: number;
  /** Commits more planned writes on `device`, without syncing. */
  write(device: number, events: readonly PlanEvent[]): Promise<void>;
  /** Restores the platform's randomness. */
  restore: () => void;
}

/** Replaces the platform's randomness with the seed's (device ids, writer
 * tokens, IVs), as harness.test.ts does: sizes and request counts repeat
 * from run to run. */
function seedCrypto(seed: number): () => void {
  const rng = new Rng(seed ^ 0x5bd1e995);
  const values = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    if (array) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = rng.int(256);
    }
    return array;
  });
  const uuids = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => rng.uuid() as `${string}-${string}-${string}-${string}-${string}`);
  return () => {
    values.mockRestore();
    uuids.mockRestore();
  };
}

/** The plan carried out by three real engines on the fake GitHub. Each
 * session (a device's writes less than 45 minutes apart) starts with a
 * sync cycle (the app opening) and ends with one (the debounced push);
 * compaction runs at its default limits. The test must fake the timers
 * (setTimeout and setInterval), so the engines' own debounce and poll
 * timers never fire: every cycle is one the run starts. At the end every
 * device cycles until the repo is quiet, and all must show one document. */
export async function runOnEngines(plan: Plan, { seed = 7, onProgress }: { seed?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<EngineRun> {
  const restore = seedCrypto(seed);
  const began = performance.now();
  const clock = { wall: plan.start, mono: 1_000_000 };
  const w = await world({ fake: { now: () => clock.wall } });
  // One clock for the engines, the fake and the run.
  w.clock = clock;
  const meter = new RequestMeter(() => clock.wall);
  const devices: Device[] = [];
  for (const { login } of PLAN_DEVICES) {
    const index = devices.length;
    devices.push(await device(w, { login, wrapFetch: meter.wrap(() => devices[index]?.engine.deviceId ?? "new") }));
  }
  const writers = devices.map((d) => engineWriter(d.engine, d.login));
  const rng = new Rng(seed ^ 0x2545f491);
  const newId = () => rng.uuid();
  const made = new Map<string, Made>();
  const writes = devices.map(() => 0);
  let refused = 0;
  let rerouted = 0;
  let cycles = 0;
  let writeMs = 0;
  let syncMs = 0;
  const at = (time: number) => {
    clock.wall = time;
    clock.mono = Math.max(clock.mono + 1, time - plan.start + 1_000_000);
  };
  const sync = async (d: Device) => {
    const t = performance.now();
    await d.engine.sync();
    syncMs += performance.now() - t;
    cycles++;
  };
  const write = async (on: number, event: PlanEvent) => {
    const t = performance.now();
    if (await writePlanned(writers[on], event, made, on, clock.wall, newId)) writes[on]++;
    else refused++;
    writeMs += performance.now() - t;
  };

  const sessions = sessionsOf(plan.events);
  let done = 0;
  for (const session of sessions) {
    at(session.events[0].at);
    const d = devices[session.device];
    await sync(d);
    let last = session.events[0].at;
    for (const [i, event] of session.events.entries()) {
      // A write takes a person at least 20 s.
      last = Math.max(event.at, last + (i === 0 ? 0 : 20_000));
      at(last);
      let on = session.device;
      if (!CREATES.has(event.kind) && !holds(devices[on].engine.current(), event, made)) {
        on = made.get(event.key)!.device;
        rerouted++;
        if (!holds(devices[on].engine.current(), event, made)) throw new Error(`plan event ${event.kind} ${event.key}: no device holds the record`);
      }
      await write(on, event);
      // A write that went to the record's own device is pushed from there.
      if (on !== session.device) await sync(devices[on]);
    }
    // The debounced push, 2 s after the last write.
    at(last + 2000);
    await sync(d);
    // Keep memory flat: the fake's and the stores' request and mutation
    // logs hold every body sent.
    (w.fake.requests as unknown[]).length = 0;
    for (const dev of devices) dev.store.mutations.length = 0;
    onProgress?.(++done, sessions.length);
  }
  at(plan.start + plan.days * DAY);
  await quiesce(w, ...devices);
  expectConverged(...devices);
  const burstMade = new Map<string, Made>();
  return {
    w,
    devices,
    writers,
    meter,
    plan,
    writes,
    refused,
    rerouted,
    cycles,
    elapsedMs: performance.now() - began,
    writeMs,
    syncMs,
    async write(on, events) {
      for (const event of events) {
        at(Math.max(clock.wall + 20_000, event.at));
        if (!(await writePlanned(writers[on], event, burstMade, on, clock.wall, newId))) throw new Error(`plan event ${event.kind} ${event.key} was refused`);
      }
    },
    restore,
  };
}

// --- Timing ------------------------------------------------------------------

export interface Timing {
  runs: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

/** Times `run` `runs` times after `warmup` untimed runs; `prepare` runs
 * before each, untimed. Milliseconds. */
export function time<T>(run: (input: T) => unknown, { runs = 50, warmup = 5, prepare }: { runs?: number; warmup?: number; prepare?: () => T } = {}): Timing {
  const samples: number[] = [];
  for (let i = 0; i < warmup + runs; i++) {
    const input = prepare ? prepare() : (undefined as T);
    const t = performance.now();
    run(input);
    const ms = performance.now() - t;
    if (i >= warmup) samples.push(ms);
  }
  return summarize(samples);
}

/** The same for an async `run`. */
export async function timeAsync<T>(run: (input: T) => Promise<unknown>, { runs = 20, warmup = 2, prepare }: { runs?: number; warmup?: number; prepare?: () => Promise<T> | T } = {}): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < warmup + runs; i++) {
    const input = prepare ? await prepare() : (undefined as T);
    const t = performance.now();
    await run(input);
    const ms = performance.now() - t;
    if (i >= warmup) samples.push(ms);
  }
  return summarize(samples);
}

function summarize(samples: number[]): Timing {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const round = (ms: number) => Math.round(ms * 100) / 100;
  return { runs: sorted.length, median: round(at(0.5)), p95: round(at(0.95)), min: round(sorted[0]), max: round(sorted.at(-1)!) };
}
