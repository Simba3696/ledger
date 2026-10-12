import { expect } from "vitest";
import { base64ToBytes } from "../base64";
import { encryptDocument } from "../crypto";
import { DocumentBackend } from "../document/DocumentBackend";
import type { LedgerDocument } from "../document/types";
import { createGitHubClient, type GitHubClient } from "../github/contents";
import { createFakeGitHub, type FakeGitHub } from "../github/fakeGitHub";
import { FORMAT_VERSION } from "./codec";
import { repoFileName, type RepoFile } from "./epoch";
import { testKey } from "./localTestkit";
import { WriterTokenMismatch, type Mutation, type StoredRecords, type SyncStore } from "./persist";
import { seal, unseal, type DeviceKey } from "./records";
import { repoPath } from "./repoFiles";
import { genesisState, type Op, type SyncState } from "./state";
import { SyncEngine, type PageEvents, type SyncEngineOptions } from "./SyncEngine";
import { SyncedHost } from "./SyncedHost";
import { docText, emptyDocument } from "./testkit";

// Test support for the sync cycle (design section 16.2): engines over a
// shared fake GitHub (fakeGitHub.ts, which models GitHub as recorded in
// github-api-behaviour.md), each with its own in-memory device store, so a
// test can run several devices, clone one's records (a forked profile) or
// roll them back (an OS backup). Imported only by tests, which fake the
// timers: debounce, poll and wait timers fire only when a test advances
// them. Fictional data only.

const OWNER = "alex";
const REPO = "ledger-data";
export const FULL = `${OWNER}/${REPO}`;
export const EPOCH = "e000001-0000000a";
export const GENESIS = repoFileName({ kind: "genesis", epoch: EPOCH });

interface MemoryRecords {
  meta?: object;
  base?: string;
  tail: string[];
  ownLog: Map<number, string>;
  chain: Map<number, string>;
  notices: Map<string, string>;
  old?: string;
  leftBehind: Map<string, string>;
}

/** ledger:sync in memory, with persist.ts's semantics: one mutation is one
 * all-or-nothing step, checked against the writer token. `failNext` fails
 * the next mutation (a full quota) and `hold` keeps mutations from starting
 * until released. `clone()` copies every record: a cloned profile, or a
 * backup to roll back to. */
export class MemoryStore implements SyncStore {
  #records: MemoryRecords = { tail: [], ownLog: new Map(), chain: new Map(), notices: new Map(), leftBehind: new Map() };
  #volatile: boolean;
  failNext = 0;
  hold: Promise<void> | null = null;
  readonly mutations: Mutation[] = [];

  constructor({ volatile = false }: { volatile?: boolean } = {}) {
    this.#volatile = volatile;
  }

  async load(): Promise<StoredRecords | null> {
    const r = this.#records;
    if (r.meta === undefined) return null;
    const ascending = (map: Map<number, string>) => [...map].sort(([a], [b]) => a - b);
    return {
      meta: structuredClone(r.meta),
      base: r.base,
      tail: [...r.tail],
      ownLog: ascending(r.ownLog),
      chainHead: ascending(r.chain).at(-1) ?? null,
      noticeCount: r.notices.size,
      leftBehind: [...r.leftBehind].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      old: r.old,
    };
  }

  async mutate(m: Mutation): Promise<void> {
    if (this.hold) await this.hold;
    if (this.failNext > 0) {
      this.failNext--;
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    }
    const r = this.#records;
    const meta = r.meta as { writerToken?: unknown } | undefined;
    const holds = m.expect === null ? meta === undefined : meta?.writerToken === m.expect;
    if (!holds) throw new WriterTokenMismatch("Another tab has taken over this device's sync state");
    const next: MemoryRecords = {
      ...r,
      tail: m.clearTail ? [] : [...r.tail],
      ownLog: new Map(r.ownLog),
      chain: m.clearChain ? new Map() : new Map(r.chain),
      notices: new Map(r.notices),
      leftBehind: new Map(r.leftBehind),
    };
    next.meta = structuredClone(m.meta);
    if (m.base !== undefined) next.base = m.base;
    next.tail.push(...(m.tail ?? []));
    const dropThrough = m.ownLog?.dropThrough;
    if (dropThrough !== undefined) for (const L of [...next.ownLog.keys()]) if (L <= dropThrough) next.ownLog.delete(L);
    for (const [L, text] of m.ownLog?.put ?? []) next.ownLog.set(L, text);
    for (const [L, text] of m.chain ?? []) next.chain.set(L, text);
    for (const key of m.notices?.delete ?? []) next.notices.delete(key);
    for (const [key, text] of m.notices?.put ?? []) next.notices.set(key, text);
    if (m.old === null) delete next.old;
    else if (m.old !== undefined) next.old = m.old;
    for (const key of m.leftBehind?.delete ?? []) next.leftBehind.delete(key);
    for (const [key, text] of m.leftBehind?.put ?? []) next.leftBehind.set(key, text);
    this.#records = next;
    this.mutations.push(m);
  }

  async chainEntry(L: number): Promise<string | undefined> {
    return this.#records.chain.get(L);
  }

  async startNewGeneration(): Promise<void> {
    this.#records = { tail: [], ownLog: new Map(), chain: new Map(), notices: new Map(), leftBehind: new Map() };
  }

  volatile(): boolean {
    return this.#volatile;
  }

  /** The stored meta, as plain JSON. */
  meta(): Record<string, unknown> {
    return structuredClone(this.#records.meta) as Record<string, unknown>;
  }

  /** Rewrites the stored meta: records a build like this one would never
   * write. */
  tamperMeta(change: (meta: Record<string, unknown>) => void): void {
    const meta = structuredClone(this.#records.meta) as Record<string, unknown>;
    change(meta);
    this.#records = { ...this.#records, meta };
  }

  /** The notices stored, decrypted. */
  async notices(key: DeviceKey): Promise<unknown[]> {
    return Promise.all([...this.#records.notices.values()].map((text) => unseal(text, key)));
  }

  /** A copy of every record, as a separate store. */
  clone(): MemoryStore {
    const copy = new MemoryStore({ volatile: this.#volatile });
    const r = this.#records;
    copy.#records = {
      ...r,
      meta: structuredClone(r.meta),
      tail: [...r.tail],
      ownLog: new Map(r.ownLog),
      chain: new Map(r.chain),
      notices: new Map(r.notices),
      leftBehind: new Map(r.leftBehind),
    };
    return copy;
  }
}

/** A clock a test moves by hand: `wall` is Date.now's stand-in (it may jump
 * either way), `mono` the monotonic one. */
interface Clock {
  wall: number;
  mono: number;
}

export interface World {
  fake: FakeGitHub;
  key: DeviceKey;
  doc: LedgerDocument;
  clock: Clock;
}

/** A fake repo holding one epoch's genesis (an empty ledger with every
 * module), encrypted with a test key. */
export async function world(options: { fake?: Parameters<typeof createFakeGitHub>[0]; doc?: LedgerDocument } = {}): Promise<World> {
  const fake = createFakeGitHub({
    repos: [{ owner: OWNER, name: REPO, private: true }],
    tokens: {
      github_pat_alex: { login: "alex", repos: [FULL], permission: "write" },
      github_pat_sam: { login: "sam", repos: [FULL], permission: "write" },
    },
    ...options.fake,
  });
  const key = await testKey();
  const doc = options.doc ?? emptyDocument();
  const genesis = { fv: FORMAT_VERSION, kind: "genesis", epoch: EPOCH, reason: "create", by: "alex", at: Date.UTC(2026, 4, 1), basedOn: null, doc };
  await fake.seedFile(FULL, `ledger/${GENESIS}`, await seal(genesis, key));
  return { fake, key, doc, clock: { wall: Date.UTC(2026, 4, 10, 9), mono: 1_000_000 } };
}

export interface Device {
  engine: SyncEngine;
  backend: DocumentBackend;
  host: SyncedHost;
  store: MemoryStore;
  client: GitHubClient;
  /** Every wait between PUT retries. */
  delays: number[];
  logs: string[];
  login: string;
}

export type DeviceOptions = Partial<SyncEngineOptions> & {
  store?: MemoryStore;
  login?: string;
  events?: PageEvents;
  /** Wraps the fetch the engine's client uses. */
  wrapFetch?: (inner: typeof fetch) => typeof fetch;
  /** Don't settle the first cycle. */
  noSettle?: boolean;
  /** The epoch and state a first start begins from (default: the world's
   * genesis), as #8 join finds them (findLedger, openGenesis). */
  init?: { epoch: string; state: SyncState };
};

/** An engine as the app runs one, over the world's repo: started (and on a
 * first start initialised from the genesis), with a DocumentBackend over
 * SyncedHost, its requests tagged with its current device id so the fake
 * asserts it writes only its own files. Its first cycle has run. */
export async function device(w: World, { store = new MemoryStore(), login = "alex", wrapFetch, noSettle, init, ...options }: DeviceOptions = {}): Promise<Device> {
  const delays: number[] = [];
  const logs: string[] = [];
  let engine: SyncEngine | null = null;
  const tagged: typeof fetch = (input, request) => w.fake.fetchAs(engine?.deviceId ?? "dnone")(input, request);
  const client = createGitHubClient({ owner: OWNER, repo: REPO, token: `github_pat_${login}`, fetch: wrapFetch ? wrapFetch(tagged) : tagged });
  engine = new SyncEngine({
    key: w.key,
    actor: login,
    store,
    locks: null,
    log: (message) => logs.push(message),
    remote: { client, branch: "main" },
    events: {},
    random: () => 0.5,
    sleep: async (ms) => {
      delays.push(ms);
    },
    monotonic: () => w.clock.mono,
    now: () => w.clock.wall,
    ...options,
  });
  await engine.start();
  if (engine.getState().needsInit) await engine.initialize(init?.epoch ?? EPOCH, init?.state ?? genesisState(w.doc));
  if (!noSettle) await engine.sync();
  const host = new SyncedHost(engine);
  const backend = new DocumentBackend({ host, now: options.now ?? (() => w.clock.wall), actor: login, newId: () => crypto.randomUUID() });
  return { engine, backend, host, store, client, delays, logs, login };
}

/** Lets the event loop turn once without moving the fake timers, so
 * encryption and requests in flight make progress. */
export function nextTask(): Promise<void> {
  return new Promise((resolve) => (globalThis as unknown as { setImmediate(fn: () => void): void }).setImmediate(resolve));
}

/** One sync cycle, past the PUT spacing (the monotonic clock moves on). */
export async function cycle(w: World, ...devices: Device[]): Promise<void> {
  for (const d of devices) {
    w.clock.mono += 10_000;
    await d.engine.sync();
  }
}

/** Cycles every device until two rounds change nothing in the repo. */
export async function quiesce(w: World, ...devices: Device[]): Promise<void> {
  let quiet = 0;
  for (let round = 0; quiet < 2; round++) {
    if (round > 20) throw new Error("the devices did not quiesce");
    const commits = w.fake.commits.length;
    await cycle(w, ...devices);
    quiet = w.fake.commits.length === commits ? quiet + 1 : 0;
  }
}

/** Every device shows the same document. */
export function expectConverged(...devices: Device[]): void {
  const [first, ...rest] = devices;
  for (const d of rest) expect(docText(d.engine.current())).toBe(docText(first.engine.current()));
}

export const ENTRY = { year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false };
export const entry = (remarks: string, amount = 10) => ({ ...ENTRY, amount, remarks });
export const edits = (remarks: string, amount: number) => ({ amount, remarks, category: "food", isCard: false });

/** The May remarks a device shows, in order. */
export function remarks(d: Device): string[] {
  return (d.engine.current().expenses["2026-05"] ?? []).map((e) => e.remarks);
}

/** The row handle of the May expense with `text`. */
export async function row(d: Device, text: string): Promise<number> {
  return (await d.backend.getMonth(2026, 5)).find((e) => e.remarks === text)!.row;
}

export const puts = (w: World) => w.fake.requests.filter((r) => r.method === "PUT");

/** The L of every op in the log a PUT request sent. */
export async function sentOps(w: World, put: { body?: string }): Promise<number[]> {
  const { content } = JSON.parse(put.body!) as { content: string };
  const log = (await unseal(new TextDecoder().decode(base64ToBytes(content)), w.key)) as { ops: Op[] };
  return log.ops.map((op) => op.L);
}

/** The L of every op in `d`'s log as the repo holds it. */
export async function repoOps(w: World, d: Device): Promise<number[]> {
  const file = w.fake.file(FULL, repoPath({ kind: "log", epoch: EPOCH, device: d.engine.deviceId! }));
  if (!file) return [];
  const log = (await unseal(file.text, w.key)) as { ops: Op[] };
  return log.ops.map((op) => op.L);
}

/** Requests sent from index `from` on. */
export const since = (w: World, from: number) => w.fake.requests.slice(from);

/** Plants a file in the repo as one commit, without a request: a file
 * another (perhaps broken or newer) build wrote. */
export async function plant(w: World, file: RepoFile, content: unknown, key: DeviceKey = w.key): Promise<string> {
  const text = typeof content === "string" ? content : await encryptDocument(content, key.key, { salt: key.salt, iter: key.iter });
  return w.fake.seedFile(FULL, repoPath(file), text);
}

/** A device's log file content, as section 6 lays it out. */
export function logFile(device: string, ops: Op[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { fv: FORMAT_VERSION, kind: "log", epoch: EPOCH, device, snapThrough: 0, chain: "0".repeat(16), ops, ...extra };
}
