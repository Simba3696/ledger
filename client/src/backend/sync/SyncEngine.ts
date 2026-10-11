import { ApiError } from "../ApiError";
import { InvalidFileError, WrongPassphraseError } from "../crypto";
import type { HostWrite } from "../document/DocumentBackend";
import type { LedgerDocument } from "../document/types";
import { CHAIN_START, chainNext, opHash, opProblem, vectorOf } from "./codec";
import { diffDocuments } from "./diff";
import { isEpochKey } from "./epoch";
import { Fence, type FenceNotice } from "./fence";
import { materialize, readerOf, rematerialize } from "./materialize";
import { LocalStateNewer, WriterTokenMismatch, openSyncStore, registerRunning, type Mutation, type StoredRecords, type SyncStore } from "./persist";
import { LOCAL_FORMAT_VERSION, checkMeta, decodeDelta, decodeStoredState, isChainValue, seal, storedState, unseal, type Delta, type DeviceKey, type SyncMeta } from "./records";
import { applyOp, cloneState, emptyState, joinInto, opState, type Op, type SyncState } from "./state";
import { LamportExhausted, newDeviceId, nextLamport, randomHex, type Tag } from "./tags";

// The sync engine's local half (design sections 3.4, 3.5, 10.1 and 10.2):
// the persisted state, the commit path and the stale-UI fence. The network
// cycle (section 7) builds on it.
//
// The commit path ("persist, then publish", section 3.5):
//   1. At the commit call, synchronously: diff current() against `next`,
//      apply the fence, allocate L (in memory only) and stamp vv.
//   2. Queue one IndexedDB transaction that appends the op to ownLog and to
//      tail, records it in meta and the chain, and checks the writer token.
//   3. Only after it commits: join the op into the state, rebuild current()
//      from the state (not from `next`, so a join that committed meanwhile
//      is kept), make the op pushable, and resolve.
//   4. If it fails, nothing changed in memory and commit rejects with
//      "This device couldn't save" (owner decision 5: a full device refuses
//      the write; nothing is held only in tab memory). The allocated L was
//      never persisted or pushed, so its reuse after a reload is harmless.
//
// Every mutation, a local op or a remote join, runs through one queue and
// is one transaction. A load that fails is never a first start: the engine
// shows `unreadable`, writes nothing, and leaves the records as they are.
//
// The writer token (section 10.2) is renewed by every mutation, so the
// token a tab expects names the exact records it last loaded or wrote. A
// load claims the device against the token it read: if anything was written
// after the read (a superseded tab that hasn't noticed yet), the claim
// writes nothing and the load reads again, so no resolved write is left out
// of what this tab shows and pushes, and no own L is allocated twice. Until
// a claim commits, nothing else is written.

/** The engine's status (section 11). Only some are set by this half. */
export type SyncStatus =
  | "idle"
  | "saving"
  | "pending"
  | "needsToken"
  | "needsPassphrase"
  | "missing"
  | "unreadable"
  | "needsUpdate"
  | "needsAttention"
  /** Another tab holds the sync lock, or has taken over writing. */
  | "locked";

/** Why the saved state can't be used: the store couldn't be read (worth
 * trying again), a newer build wrote it, it doesn't decrypt with this key,
 * or it is malformed. */
export type UnreadableReason = "loadFailed" | "newer" | "undecryptable" | "malformed";

export interface EngineState {
  status: SyncStatus;
  /** There is a document to show. */
  hasDocument: boolean;
  /** Nothing is saved on this device yet: a first start (initialize()). */
  needsInit: boolean;
  unreadable: UnreadableReason | null;
  /** The integration revision (section 3.4): SyncHost's key. Bumped only by
   * joins that change the document, never by this device's own writes. */
  revision: number;
  /** Own ops saved on this device and not yet known to be in the repo. */
  pendingCount: number;
  /** The last write on this device failed to save (and was refused). */
  deviceSaveFailed: boolean;
  /** Records go only to this tab's memory (IndexedDB never opened). */
  volatile: boolean;
  noticeCount: number;
  leftBehindCount: number;
}

/** The sync bookkeeping a remote join may record with its delta. */
export type MetaPatch = Partial<Pick<SyncMeta, "K" | "ownLogSha" | "lastSentLogSha" | "ownSnapSha" | "lastSentSnapSha" | "joined" | "lastSeenCommit" | "refEtag">>;

export interface SyncEngineOptions {
  key: DeviceKey;
  /** The signed-in login: each op's display `by`. */
  actor: string;
  store?: SyncStore;
  /** Web Locks; null runs without the one-tab lock. Default navigator.locks. */
  locks?: LockManager | null;
  now?: () => number;
  log?: (message: string, err?: unknown) => void;
  /** Called after each own op commits on the device: the push trigger. */
  onCommitted?: () => void;
}

export const DEVICE_SAVE_FAILED = "This device couldn't save. Free up storage and try again.";
export const OTHER_TAB = "Ledger is open in another tab. Close it there to use it here.";
const NOT_LOADED = "Your ledger hasn't loaded yet.";
const LOCK_NAME = "ledger:sync";
/** Loads before giving up when every claim finds the records changed. */
const MAX_LOADS = 5;

interface Loaded {
  meta: SyncMeta;
  state: SyncState;
  doc: LedgerDocument;
  ownLog: Op[];
  chainHead: string;
}

/** A notice's key: (winner op, loser op), so each pair is stored once. */
function noticeKey(notice: FenceNotice, mine: Tag): string {
  const id = (t: Tag) => `${t[0]}.${t[1]}`;
  return notice.kind === "kept" ? `${id(notice.theirs)}/${id(mine)}` : `${id(mine)}/${id(notice.theirs)}`;
}

/** A record didn't decrypt with this key or this build. */
class Undecryptable extends Error {}

export class SyncEngine {
  readonly #key: DeviceKey;
  readonly #actor: string;
  readonly #store: SyncStore;
  readonly #locks: LockManager | null;
  readonly #now: () => number;
  readonly #log: (message: string, err?: unknown) => void;
  readonly #onCommitted: () => void;

  #meta: SyncMeta | null = null;
  #state: SyncState | null = null;
  #doc: LedgerDocument | null = null;
  /** Own ops whose transaction committed, ascending: what a push may send. */
  #ownLog: Op[] = [];
  #chainHead = CHAIN_START;
  #lastAllocated = 0;
  readonly #fence = new Fence();

  /** The writer token the next mutation expects in meta (section 10.2):
   * the one this tab last wrote, or the one it loaded until its claim
   * commits; null when nothing is saved yet (a first start). */
  #expect: string | null = null;
  /** This tab has written the device's meta since loading it: a claim that
   * failed (a full device) is made again before the next write. */
  #claimed = false;
  /** The load in flight, so "Try again" twice runs one load. */
  #loading: Promise<void> | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  #status: SyncStatus = "idle";
  #unreadable: UnreadableReason | null = null;
  #needsInit = false;
  #deviceSaveFailed = false;
  #noticeCount = 0;
  #leftBehindCount = 0;
  #snapshot: EngineState;
  readonly #listeners = new Set<() => void>();

  #started = false;
  #stopped = false;
  #lockHeld = false;
  /** Another tab took over writing: read-only from now on. */
  #superseded = false;
  #releaseLock: (() => void) | null = null;
  #lockWait: AbortController | null = null;
  #unregister: (() => void) | null = null;

  constructor(options: SyncEngineOptions) {
    this.#key = options.key;
    this.#actor = options.actor;
    this.#store = options.store ?? openSyncStore();
    this.#locks = options.locks === undefined ? (globalThis.navigator?.locks ?? null) : options.locks;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((message, err) => console.error(`ledger:sync: ${message}`, err));
    this.#onCommitted = options.onCommitted ?? (() => {});
    this.#snapshot = this.#makeSnapshot();
  }

  // --- Lifecycle ------------------------------------------------------------

  /** Takes the one-tab lock and loads the saved state. Without the lock the
   * status is `locked`, and the engine starts when the other tab lets go. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#unregister = registerRunning(this);
    if (!(await this.#tryLock())) {
      this.#setStatus("locked");
      this.#waitForLock();
      return;
    }
    await this.#load();
  }

  /** Stops for good: nothing more is written, and the lock is released.
   * Reads keep working. Safe to call more than once. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#lockWait?.abort();
    this.#releaseLock?.();
    this.#releaseLock = null;
    this.#unregister?.();
    this.#emit();
  }

  /** "Try again" on `unreadable`: loads the saved state again. */
  async retry(): Promise<void> {
    if (this.#loading) return this.#loading;
    if (this.#unreadable === null || this.#stopped || !this.#lockHeld) return;
    await this.#load();
  }

  /** "Start as a new device" on `unreadable`: the saved records stay as they
   * are, as a raw backup, and this device starts over in a new store
   * (needsInit). The first start then mints a new device id, so nothing
   * can overwrite the old id's repo files. */
  async startAsNewDevice(): Promise<void> {
    if (this.#loading) return this.#loading;
    if (this.#unreadable === null || this.#stopped || !this.#lockHeld) return;
    await this.#load(() => this.#store.startNewGeneration());
  }

  /** A first start: saves `state` (a genesis or a cold join of the epoch)
   * as this device's base under a new device id. Refused unless nothing is
   * saved, and the transaction itself refuses if anything was saved since. */
  initialize(epochKey: string, state: SyncState): Promise<void> {
    if (!this.#needsInit || this.#stopped || this.#superseded || !this.#lockHeld) return Promise.reject(new Error("This device's sync state is not empty, or this tab can't write it"));
    if (!isEpochKey(epochKey)) return Promise.reject(new Error(`Not an epoch key: ${epochKey}`));
    return this.#enqueue(async () => {
      // A second call queued behind the first finds the state no longer empty.
      if (!this.#needsInit) throw new Error("This device's sync state is not empty");
      const meta: SyncMeta = {
        formatVersion: LOCAL_FORMAT_VERSION,
        deviceId: newDeviceId(),
        epochKey,
        maxL: state.maxL,
        ownMaxL: 0,
        K: 0,
        ownLogSha: null,
        lastSentLogSha: null,
        ownSnapSha: null,
        lastSentSnapSha: null,
        joined: {},
        seen: vectorOf(state.seen),
        lastSeenCommit: null,
        refEtag: null,
        writerToken: "",
      };
      const base = await seal(storedState(state), this.#key);
      await this.#mutate(meta, { base, clearChain: true });
      this.#adopt({ meta: this.#meta!, state: cloneState(state), doc: materialize(state), ownLog: [], chainHead: CHAIN_START }, true);
    });
  }

  // --- DocumentHost ----------------------------------------------------------

  /** The document, for SyncedHost.current(). */
  current(): LedgerDocument {
    if (this.#doc === null) throw new ApiError(503, this.#started && !this.#lockHeld ? OTHER_TAB : NOT_LOADED);
    return this.#doc;
  }

  /** Commits one write as one op (section 3.5). Resolves only once the op is
   * saved on this device; rejects with a 500 "couldn't save" when it isn't,
   * and the document is then unchanged. */
  commit(next: LedgerDocument): Promise<void> {
    try {
      return this.#commit(next, this.#fence.renderedRevision);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** A write submitted now, which commits later (SyncedHost.begin): the
   * fence judges it by the revision rendered at this call, not at its
   * commit (section 3.4). end() once it has settled. */
  beginWrite(): HostWrite {
    const pin = this.#fence.pin();
    return {
      commit: (next) => {
        try {
          return this.#commit(next, pin.asOf);
        } catch (err) {
          return Promise.reject(err);
        }
      },
      end: () => pin.release(),
    };
  }

  /** A write made directly on a copy of the document (notice actions and
   * re-apply, sections 4.1 and 9.4): the same synchronous pattern as
   * DocumentBackend's writes. `run` makes its own checks (operations.ts). */
  amend(run: (doc: LedgerDocument) => void): Promise<void> {
    try {
      const next = structuredClone(this.current());
      run(next);
      return this.#commit(next, this.#fence.renderedRevision);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** `asOf`: the revision on screen when the write was submitted. */
  #commit(next: LedgerDocument, asOf: number): Promise<void> {
    this.#assertWritable();
    const state = this.#state!;
    const meta = this.#meta!;
    let L: number;
    try {
      L = nextLamport(state.maxL, this.#lastAllocated);
    } catch (err) {
      // A new epoch would make room (ADR-0008); that comes with restore.
      if (err instanceof LamportExhausted) throw new ApiError(503, "Ledger can't number any more changes in this epoch.");
      throw err;
    }
    const body = diffDocuments(state, this.#doc!, next, { L, device: meta.deviceId });
    if (!body) return Promise.resolve();
    const fenced = this.#fence.apply(body, state, asOf);
    if (!fenced.body && fenced.notices.length === 0) return Promise.resolve();
    this.#lastAllocated = L;
    let op: Op | null = null;
    if (fenced.body) {
      const vv = { ...this.#fence.renderedSeen(state.seen, asOf) };
      if (meta.ownMaxL > 0) vv[meta.deviceId] = Math.max(vv[meta.deviceId] ?? 0, meta.ownMaxL);
      op = { L, at: this.#now(), by: this.#actor, vv, set: fenced.body.set, del: fenced.body.del };
      const problem = opProblem(op);
      if (problem) throw new Error(`The fenced op is malformed: ${problem}`);
    }
    return this.#enqueue(() => this.#commitOp(op, fenced.notices, L));
  }

  async #commitOp(op: Op | null, notices: FenceNotice[], L: number): Promise<void> {
    this.#assertWritable();
    const meta = this.#meta!;
    const me = meta.deviceId;
    const writes: Omit<Mutation, "expect" | "meta"> = {};
    let nextMeta = meta;
    let chain = this.#chainHead;
    if (op) {
      chain = await chainNext(this.#chainHead, await opHash(op));
      const text = await seal({ ops: [[me, op]] } satisfies Delta, this.#key);
      writes.tail = [text];
      writes.ownLog = { put: [[op.L, text]] };
      writes.chain = [[op.L, await seal(chain, this.#key)]];
      nextMeta = { ...meta, maxL: Math.max(meta.maxL, op.L), ownMaxL: op.L, seen: { ...meta.seen, [me]: op.L } };
    }
    if (notices.length > 0) {
      const mine: Tag = [L, me];
      writes.notices = { put: await Promise.all(notices.map(async (n): Promise<[string, string]> => [noticeKey(n, mine), await seal({ ...n, mine }, this.#key)])) };
    }
    // A reload (stop) or a takeover while this was being sealed writes nothing.
    this.#assertWritable();
    await this.#mutate(nextMeta, writes);

    if (op) {
      const changes = applyOp(this.#state!, me, op);
      this.#doc = rematerialize(this.#doc!, readerOf(this.#state!), changes);
      this.#ownLog.push(op);
      this.#chainHead = chain;
      this.#fence.wrote(this.#state!, me, op);
    }
    this.#noticeCount += notices.length;
    this.#emit();
    if (op && !this.#stopped) this.#onCommitted();
  }

  // --- Remote joins ---------------------------------------------------------

  /** Joins other devices' validated ops and/or a validated state (a
   * snapshot): one transaction appends the delta to tail and records
   * `bookkeeping` in meta, then the delta is joined through the fence. */
  join(delta: { ops?: [device: string, op: Op][]; state?: SyncState }, bookkeeping: MetaPatch = {}): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertWritable();
      const source = emptyState();
      if (delta.state) joinInto(source, delta.state);
      for (const [device, op] of delta.ops ?? []) joinInto(source, opState(device, op));
      const text = await seal({ ops: delta.ops ?? [], ...(delta.state ? { state: storedState(delta.state) } : {}) } satisfies Delta, this.#key);
      const meta = this.#meta!;
      const seen = new Map(this.#state!.seen);
      for (const [device, L] of source.seen) if (L > (seen.get(device) ?? 0)) seen.set(device, L);
      this.#assertWritable();
      await this.#mutate({ ...meta, ...bookkeeping, maxL: Math.max(meta.maxL, source.maxL), seen: vectorOf(seen) }, { tail: [text] });

      const changes = this.#fence.join(this.#state!, source);
      this.#doc = rematerialize(this.#doc!, readerOf(this.#state!), changes);
      this.#emit();
    });
  }

  // --- The fence (section 3.4) ----------------------------------------------

  /** SyncHost attaches once it shows the document, having rendered `rev`.
   * Returns the detach function. */
  attachView(rev: number): () => void {
    return this.#fence.attach(rev, vectorOf(this.#state?.seen ?? new Map()));
  }

  /** SyncHost has committed a tree keyed on `rev`. */
  rendered(rev: number): void {
    this.#fence.rendered(rev);
  }

  // --- What the network half reads ------------------------------------------

  /** Own ops whose transaction committed, ascending: the only ops a push
   * may send (section 3.5). */
  pushableOps(): readonly Op[] {
    return [...this.#ownLog];
  }

  get deviceId(): string | null {
    return this.#meta?.deviceId ?? null;
  }

  // --- Status ---------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The current state; the same object until something changes
   * (useSyncExternalStore). */
  readonly getState = (): EngineState => this.#snapshot;

  // --- Internals ------------------------------------------------------------

  #assertWritable(): void {
    if (this.#superseded || (this.#started && !this.#lockHeld)) throw new ApiError(503, OTHER_TAB);
    if (this.#stopped) throw new ApiError(503, "Ledger was closed in this tab. Reload to continue.");
    if (this.#loading || this.#doc === null || this.#meta === null || this.#state === null) throw new ApiError(503, NOT_LOADED);
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** One transaction: `writes` plus `meta` with a new writer token,
   * checked against the token expected. A tab whose claim failed claims
   * first, in a transaction of its own. A takeover, or a write made since
   * this tab loaded, makes it read-only; any other failure is a refused
   * write ("This device couldn't save"). */
  async #mutate(meta: SyncMeta, writes: Omit<Mutation, "expect" | "meta">): Promise<void> {
    if (!this.#claimed) await this.#write(this.#meta!, {});
    await this.#write(meta, writes);
  }

  async #write(meta: SyncMeta, writes: Omit<Mutation, "expect" | "meta">): Promise<void> {
    const nextMeta: SyncMeta = { ...meta, writerToken: randomHex(16) };
    try {
      await this.#store.mutate({ ...writes, expect: this.#expect, meta: nextMeta });
    } catch (err) {
      if (err instanceof WriterTokenMismatch) {
        this.#supersede();
        throw new ApiError(503, OTHER_TAB);
      }
      this.#log("a save on this device failed; nothing from it was kept", err);
      this.#deviceSaveFailed = true;
      this.#emit();
      throw new ApiError(500, DEVICE_SAVE_FAILED);
    }
    this.#expect = nextMeta.writerToken;
    this.#meta = nextMeta;
    this.#claimed = true;
    if (this.#deviceSaveFailed) {
      this.#deviceSaveFailed = false;
      this.#emit();
    }
  }

  #supersede(): void {
    if (this.#superseded) return;
    this.#superseded = true;
    this.#releaseLock?.();
    this.#releaseLock = null;
    this.#setStatus("locked");
  }

  /** Loads the saved state and claims it. One load at a time: a call while
   * one runs gets that one. `before` runs first, as part of it. */
  #load(before?: () => Promise<void>): Promise<void> {
    this.#loading ??= (async () => {
      try {
        await before?.();
        await this.#loadAndClaim();
      } finally {
        this.#loading = null;
      }
    })();
    return this.#loading;
  }

  async #loadAndClaim(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      let records: StoredRecords | null;
      try {
        records = await this.#store.load();
      } catch (err) {
        this.#log("the saved sync state could not be loaded; it is kept as it is", err);
        this.#fail(err instanceof LocalStateNewer ? "newer" : "loadFailed");
        return;
      }
      if (this.#stopped) return;
      if (records === null) {
        this.#meta = this.#state = this.#doc = null;
        // A first start's transaction checks that nothing was saved since.
        this.#expect = null;
        this.#claimed = true;
        this.#needsInit = true;
        this.#unreadable = null;
        this.#setStatus("idle");
        return;
      }
      const loaded = await this.#decode(records);
      if (this.#stopped) return;
      if (typeof loaded === "string") {
        this.#fail(loaded);
        return;
      }
      // Take over writing (section 10.2), against the records just read.
      const claim = await this.#enqueue(() => this.#claim(loaded.meta));
      if (this.#stopped) return;
      if (claim === "changed") {
        if (attempt < MAX_LOADS) continue;
        this.#log("the saved sync state kept changing while it was loaded; it is kept as it is");
        this.#fail("loadFailed");
        return;
      }
      this.#noticeCount = records.noticeCount;
      this.#leftBehindCount = records.leftBehindCount;
      this.#adopt(claim === "failed" ? loaded : { ...loaded, meta: claim }, claim !== "failed");
      return;
    }
  }

  /** Writes a new writer token into `meta` if the records are still the
   * ones loaded with it: the claimed meta, "changed" if something was
   * written since (read them again), or "failed" if the device couldn't
   * save it (writes are refused until a claim is saved). */
  async #claim(meta: SyncMeta): Promise<SyncMeta | "changed" | "failed"> {
    if (this.#stopped) return "failed";
    const claimed: SyncMeta = { ...meta, writerToken: randomHex(16) };
    try {
      await this.#store.mutate({ expect: meta.writerToken, meta: claimed });
    } catch (err) {
      if (err instanceof WriterTokenMismatch) return "changed";
      this.#log("could not claim this device's sync state; writes are refused until a claim is saved", err);
      return "failed";
    }
    return claimed;
  }

  /** Shows `loaded`. Unless `claimed`, the next mutation claims first,
   * expecting the token loaded. */
  #adopt(loaded: Loaded, claimed: boolean): void {
    this.#expect = loaded.meta.writerToken;
    this.#claimed = claimed;
    this.#deviceSaveFailed = !claimed;
    this.#meta = loaded.meta;
    this.#state = loaded.state;
    this.#doc = loaded.doc;
    this.#ownLog = loaded.ownLog;
    this.#chainHead = loaded.chainHead;
    this.#lastAllocated = 0;
    this.#needsInit = false;
    this.#unreadable = null;
    this.#setStatus("idle");
  }

  #fail(reason: UnreadableReason): void {
    this.#meta = this.#state = this.#doc = null;
    this.#needsInit = false;
    this.#unreadable = reason;
    this.#setStatus("unreadable");
  }

  async #open(text: string): Promise<unknown> {
    try {
      return await unseal(text, this.#key);
    } catch (err) {
      if (err instanceof WrongPassphraseError || err instanceof InvalidFileError) throw new Undecryptable(err.message, { cause: err });
      throw err;
    }
  }

  /** The saved records as the engine's state, or why they can't be used.
   * Reads only: whatever is wrong, the records are left as they are. */
  async #decode(records: StoredRecords): Promise<Loaded | UnreadableReason> {
    const check = checkMeta(records.meta);
    if (!check.ok) {
      this.#log(`the saved sync state can't be used: ${check.detail}`);
      return check.problem;
    }
    const meta = check.meta;
    const malformed = (detail: string): UnreadableReason => {
      this.#log(`the saved sync state can't be used: ${detail}`);
      return "malformed";
    };
    try {
      if (records.base === undefined) return malformed("there is no base");
      const state = decodeStoredState(await this.#open(records.base));
      if (typeof state === "string") return malformed(state);
      for (const text of records.tail) {
        const delta = decodeDelta(await this.#open(text));
        if (typeof delta === "string") return malformed(delta);
        if (delta.state) joinInto(state, delta.state);
        for (const [device, op] of delta.ops) applyOp(state, device, op);
      }
      const ownLog: Op[] = [];
      for (const [L, text] of records.ownLog) {
        const delta = decodeDelta(await this.#open(text));
        if (typeof delta === "string") return malformed(delta);
        const [entry] = delta.ops;
        if (delta.ops.length !== 1 || delta.state || entry[0] !== meta.deviceId || entry[1].L !== L) return malformed("an own log entry is not this device's op");
        ownLog.push(entry[1]);
      }
      // Every own op is in the state too: it went into tail in the same
      // transaction, and a local compaction folds tail into base.
      const own = state.seen.get(meta.deviceId) ?? 0;
      if (meta.ownMaxL > own || (ownLog.at(-1)?.L ?? 0) > meta.ownMaxL) return malformed("the own log and the state disagree");
      let chainHead = CHAIN_START;
      if (records.chainHead) {
        const value = await this.#open(records.chainHead[1]);
        if (!isChainValue(value)) return malformed("the chain is malformed");
        chainHead = value;
      }
      return { meta, state, doc: materialize(state), ownLog, chainHead };
    } catch (err) {
      if (err instanceof Undecryptable) {
        this.#log("the saved sync state doesn't decrypt with this device's key", err);
        return "undecryptable";
      }
      this.#log("the saved sync state can't be used", err);
      return "malformed";
    }
  }

  #tryLock(): Promise<boolean> {
    const locks = this.#locks;
    if (!locks) {
      this.#lockHeld = true;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      locks
        .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
          if (!lock || this.#stopped) {
            resolve(false);
            return undefined;
          }
          this.#lockHeld = true;
          resolve(true);
          return new Promise<void>((release) => {
            this.#releaseLock = release;
          });
        })
        .catch((err: unknown) => {
          this.#log("could not take the tab lock", err);
          resolve(false);
        });
    });
  }

  /** Queues for the lock; when the other tab lets go, this one loads. */
  #waitForLock(): void {
    const locks = this.#locks!;
    this.#lockWait = new AbortController();
    locks
      .request(LOCK_NAME, { signal: this.#lockWait.signal }, (lock) => {
        if (!lock || this.#stopped) return undefined;
        this.#lockHeld = true;
        void this.#load();
        return new Promise<void>((release) => {
          this.#releaseLock = release;
        });
      })
      .catch(() => undefined); // aborted by stop()
  }

  #setStatus(status: SyncStatus): void {
    this.#status = status;
    this.#emit();
  }

  #makeSnapshot(): EngineState {
    return {
      status: this.#status,
      hasDocument: this.#doc !== null,
      needsInit: this.#needsInit,
      unreadable: this.#unreadable,
      revision: this.#fence.revision,
      pendingCount: this.#ownLog.length,
      deviceSaveFailed: this.#deviceSaveFailed,
      volatile: this.#store.volatile(),
      noticeCount: this.#noticeCount,
      leftBehindCount: this.#leftBehindCount,
    };
  }

  #emit(): void {
    const next = this.#makeSnapshot();
    const prev = this.#snapshot;
    if ((Object.keys(next) as (keyof EngineState)[]).every((key) => next[key] === prev[key])) return;
    this.#snapshot = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
