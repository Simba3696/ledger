import { ApiError } from "../ApiError";
import { InvalidFileError, WrongPassphraseError } from "../crypto";
import type { HostWrite } from "../document/DocumentBackend";
import type { LedgerDocument } from "../document/types";
import {
  GitHubAuthError,
  GitHubError,
  GitHubForbiddenError,
  GitHubNetworkError,
  GitHubRateLimitError,
  RepoNotFoundError,
  ShaConflictError,
  deviceCommitMessage,
  gitBlobSha,
  type GitHubClient,
  type RefRead,
} from "../github/contents";
import { canonicalJson } from "./canonical";
import { CHAIN_START, FORMAT_VERSION, chainNext, checkRepoFile, opHash, opProblem, vectorOf } from "./codec";
import { diffDocuments } from "./diff";
import { epochMove, isEpochKey, parseRepoFileName, repoFileName, winningEpoch, type RepoFile } from "./epoch";
import { Fence, type FenceNotice } from "./fence";
import { materialize, readerOf, rematerialize } from "./materialize";
import { LocalStateNewer, WriterTokenMismatch, openSyncStore, registerRunning, type Mutation, type StoredRecords, type SyncStore } from "./persist";
import { LOCAL_FORMAT_VERSION, checkMeta, decodeDelta, decodeStoredState, isChainValue, seal, storedState, unseal, type Delta, type DeviceKey, type SyncMeta } from "./records";
import { rehomeReissue } from "./rehome";
import { LEDGER_DIR, openRepoFile, repoPath, type FileRead } from "./repoFiles";
import { applyOp, cloneState, emptyState, genesisState, joinInto, opState, type Op, type SyncState } from "./state";
import { LamportExhausted, newDeviceId, nextLamport, randomHex, type Tag } from "./tags";

// The sync engine (design sections 3.4, 3.5, 7, 10, 11 and 12): the
// persisted state, the commit path and the stale-UI fence (the local half),
// and the sync cycle against the household's GitHub repo (the network half,
// further down).
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
// Local writes, DocumentBackend's and amend()'s alike, take turns in the
// order they were submitted (beginWrite): each reads current() only once
// every earlier one has settled, so its diff holds them all. Step 1's diff
// is against current(), which shows an own op only after step 3, so two
// writes diffed at once would each carry a whole-unit register as it was
// before the other, and the later L would set the earlier write back.
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
//
// The network half runs one sync cycle at a time (section 7):
//   1. Poll the branch ref, conditional on its ETag: a 304 when nothing
//      changed, which GitHub doesn't count.
//   2. If the head is a commit this device hasn't fully handled, list
//      ledger/ at it (one git tree).
//   3. Pick the winning epoch. A listing older than what this device has
//      joined ends the cycle. A newer epoch (a restore) halts the cycle
//      until switching to it lands (restore, design step 6).
//   4. Read every other device's log whose listed sha this device hasn't
//      joined, by blob sha (never stale), and join each valid file whole;
//      a malformed one halts only its own stream (section 12), and its sha
//      is not recorded, so it is read again once its device writes anew.
//   5. Settle this device's own log from the listed sha alone: the sha it
//      knows, the one it last sent (that send landed), or anything else,
//      which is read and either is this device's history (confirmed) or is
//      a fork, which rehomes the device under a new id (section 10.3).
//   6. PUT the own log, every own op above K, if any is unconfirmed: the
//      sent sha is saved first, a 409 retries (at most 4 PUTs a cycle), and
//      an identical text is never sent again.
// Only ops whose transaction committed are ever sent. The bookkeeping a
// cycle learns (files joined, the head handled, the own log confirmed) is
// saved with the ops it joined, in one transaction. A head is recorded as
// handled only when every file in it was joined, so a halted stream, a gap
// or a failed read is retried by the next cycle, and an idle device makes
// one uncounted request a poll. Nothing the cycle meets is fatal: any throw
// ends it with `pending`, and the next trigger tries again.

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
  /** Records go only to this tab's memory (the browser refuses IndexedDB). */
  volatile: boolean;
  noticeCount: number;
  leftBehindCount: number;
}

/** The sync bookkeeping a remote join may record with its delta. */
export type MetaPatch = Partial<
  Pick<
    SyncMeta,
    "K" | "ownLogSha" | "ownLogThrough" | "lastSentLogSha" | "lastSentLogThrough" | "ownSnapSha" | "lastSentSnapSha" | "joined" | "lastSeenCommit" | "refEtag"
  >
>;

/** The household's repo, as the cycle reads and writes it. */
export interface SyncRemote {
  client: Pick<GitHubClient, "getRef" | "listDir" | "readBlob" | "putFile">;
  /** The repo's default branch (verifyRepo). */
  branch: string;
}

/** What the engine listens to for its triggers (section 7). */
export interface PageEvents {
  /** Fires `visibilitychange`; `visibilityState` says whether it's shown. */
  document?: EventTarget & { visibilityState?: string };
  /** Fires `online` and `pagehide`. */
  window?: EventTarget;
}

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
  /** The repo to sync with. Without one the engine is local only: no cycle
   * runs and nothing is sent. */
  remote?: SyncRemote;
  /** Default: the page's document and window. */
  events?: PageEvents;
  /** In [0, 1): the jitter on retry waits. Default Math.random. */
  random?: () => number;
  /** Waits between PUT retries. Default a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** A clock that never jumps, for the spacing of PUTs. Default
   * performance.now(). The wall clock (`now`) orders nothing. */
  monotonic?: () => number;
}

/** The engine's waits and limits (section 7 and 12). */
export const SYNC_TIMING = {
  /** Push this long after the last change. */
  debounceMs: 2000,
  /** Pull this often while the page is visible, never while hidden. */
  pollMs: 60_000,
  /** At least this long between own log PUTs that landed. */
  putGapMs: 5000,
  /** At most this many own log PUTs an hour. */
  putsPerHour: 120,
  /** Waits before each retry after a 409 or 422. */
  retryMs: [250, 500, 1000],
  /** Up to this much random extra on each retry wait. */
  jitterMs: 250,
  /** The wait after a rate limit whose reset is already past on this
   * device's clock (GitHub's clock is behind it). */
  rateLimitFloorMs: 60_000,
  /** The longest wait after a rate limit: GitHub's primary window. A reset
   * further off means this device's clock is behind GitHub's. */
  rateLimitCapMs: 60 * 60 * 1000,
  /** The largest own log text sent on pagehide: a keepalive request's body
   * must stay under 64 KiB. */
  keepaliveMaxBytes: 60 * 1024,
};

/** PUTs of the own log in one cycle, retries included (section 12). */
const MAX_PUTS = 4;
const HOUR_MS = 60 * 60 * 1000;

export const DEVICE_SAVE_FAILED = "This device couldn't save. Free up storage and try again.";
export const OTHER_TAB = "Ledger is open in another tab. Close it there to use it here.";
/** Why a write is refused while the epoch's genesis is newer than this build. */
export const LEDGER_UPDATED = "Ledger was updated on another device. Reload to get the new version.";
/** The notice after a rehome (section 10.3). */
export const REHOMED = "This device's sync identity was in use elsewhere; it now syncs as a new device. Nothing was lost.";
const NOT_LOADED = "Your ledger hasn't loaded yet.";
const LOCK_NAME = "ledger:sync";
/** Loads before giving up when every claim finds the records changed. */
const MAX_LOADS = 5;

/** A status that stops the cycle until something outside it changes. */
type Blocker = "needsToken" | "missing" | "needsPassphrase" | "needsUpdate" | "needsAttention";

/** One sync file in a listing. */
interface Listed {
  file: RepoFile;
  sha: string;
  size: number;
}

/** ledger/ at one commit: its sync files by name. */
interface Listing {
  commit: string;
  /** The ref ETag the commit came with, to send on the next poll. */
  etag: string | null;
  files: Map<string, Listed>;
  /** GitHub cut the listing short: no absence may be read into it. */
  truncated: boolean;
}

/** The own log as text, ready to PUT. */
interface LogText {
  text: string;
  /** gitBlobSha(text): the file's sha once it lands. */
  sha: string;
  /** The greatest own L it holds (K when it holds no op). */
  through: number;
  device: string;
  file: RepoFile;
}

/** What a cycle's own check found (section 7 step 5). */
type OwnCheck = { fork: string } | { fork?: undefined; patch: MetaPatch };

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A 404 from the ref or the listing: the repo is gone, or the token can no
 * longer reach it. A 404 for a listed blob is not (a lagging replica). */
function repoGone(err: unknown): unknown {
  return err instanceof GitHubError && !(err instanceof RepoNotFoundError) && err.status === 404 ? new RepoNotFoundError() : err;
}

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
  /** Settles once every write begun so far has ended (beginWrite). */
  #writesSettled: Promise<void> = Promise.resolve();

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

  // The network half.
  readonly #remote: SyncRemote | null;
  readonly #events: PageEvents;
  readonly #random: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #monotonic: () => number;
  #listening = false;
  #cleanups: (() => void)[] = [];
  #debounce: ReturnType<typeof setTimeout> | null = null;
  /** A cycle put off by the PUT spacing or the hourly cap. */
  #putTimer: ReturnType<typeof setTimeout> | null = null;
  /** The wait after a rate limit, and its timer. */
  #rateLimit: { at: number; delay: number } | null = null;
  #rateTimer: ReturnType<typeof setTimeout> | null = null;
  /** The running cycle loop, and whether a trigger asked for another. */
  #loop: Promise<void> | null = null;
  #again = false;
  /** Set by a cycle that stops on something only a change outside it fixes. */
  #blocker: Blocker | null = null;
  /** The last cycle failed for a reason the next trigger may not meet
   * (offline, a 5xx, a rate limit, a stale listing, retries spent). */
  #trouble = false;
  /** Another device's log needs its snapshot first (section 8.2). */
  #gapWait = false;
  /** Halted streams: file name to what halted it (section 12). */
  readonly #halted = new Map<string, "needsUpdate" | "needsAttention">();
  /** Blob shas that were read and refused. A blob never changes, so it
   * isn't read again in this tab; a new build reads it afresh. */
  readonly #refused = new Map<string, Extract<FileRead, { ok: false }>>();
  /** The epoch's genesis is newer than this build: writes are refused. */
  #genesisBlocked = false;
  /** Own log PUTs sent in the last hour, and when one last landed
   * (monotonic ms). */
  #putTimes: number[] = [];
  #lastLanded: number | null = null;
  /** The own log text for the latest own op, built once per content. */
  #logText: { key: string; value: Promise<LogText> } | null = null;
  /** The last own log text built, for a keepalive push on pagehide. */
  #logReady: LogText | null = null;

  constructor(options: SyncEngineOptions) {
    this.#key = options.key;
    this.#actor = options.actor;
    this.#store = options.store ?? openSyncStore();
    this.#locks = options.locks === undefined ? (globalThis.navigator?.locks ?? null) : options.locks;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((message, err) => console.error(`ledger:sync: ${message}`, err));
    this.#onCommitted = options.onCommitted ?? (() => {});
    this.#remote = options.remote ?? null;
    this.#events = options.events ?? {
      document: typeof document === "undefined" ? undefined : document,
      window: typeof window === "undefined" ? undefined : window,
    };
    this.#random = options.random ?? Math.random;
    this.#sleep = options.sleep ?? realSleep;
    this.#monotonic = options.monotonic ?? (() => performance.now());
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
    this.#quiet();
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
        ownLogThrough: 0,
        lastSentLogSha: null,
        lastSentLogThrough: 0,
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
    }).then(() => this.#begin());
  }

  // --- DocumentHost ----------------------------------------------------------

  /** The document, for SyncedHost.current(). */
  current(): LedgerDocument {
    if (this.#doc === null) throw new ApiError(503, this.#started && !this.#lockHeld ? OTHER_TAB : NOT_LOADED);
    return this.#doc;
  }

  /** Commits one write as one op (section 3.5). Resolves only once the op is
   * saved on this device; rejects with a 500 "couldn't save" when it isn't,
   * and the document is then unchanged. It diffs at the call and takes no
   * turn (beginWrite), so it is for a caller with no other write saving;
   * DocumentBackend's writes and amend() take turns. */
  commit(next: LedgerDocument): Promise<void> {
    try {
      return this.#commit(next, this.#fence.renderedRevision);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** A write submitted now, which commits later (SyncedHost.begin): the
   * fence judges it by the revision rendered at this call, not at its
   * commit (section 3.4). It may read the document once `ready` settles,
   * when every write begun before it has ended; end() once it has settled.
   * Writes take turns in the order they were begun, whichever path they
   * came by (DocumentBackend or amend), so each one is diffed against a
   * document that holds every earlier one. Diffed alongside an earlier
   * write still saving, a whole-unit register would carry the unit as it
   * was before that write, and win with the later L. */
  beginWrite(): HostWrite & { ready: Promise<void> } {
    const pin = this.#fence.pin();
    const ready = this.#writesSettled;
    let ended!: () => void;
    const end = new Promise<void>((resolve) => (ended = resolve));
    this.#writesSettled = ready.then(() => end);
    return {
      ready,
      commit: (next) => {
        try {
          return this.#commit(next, pin.asOf);
        } catch (err) {
          return Promise.reject(err);
        }
      },
      end: () => {
        pin.release();
        ended();
      },
    };
  }

  /** A write made directly on a copy of the document (notice actions and
   * re-apply, sections 4.1 and 9.4): DocumentBackend's pattern, taking its
   * turn among DocumentBackend's writes. At its turn, it clones current(),
   * runs `run` on the clone and commits it. `run` makes its own checks
   * (operations.ts). */
  async amend(run: (doc: LedgerDocument) => void): Promise<void> {
    const write = this.beginWrite();
    try {
      await write.ready;
      const next = structuredClone(this.current());
      run(next);
      await write.commit(next);
    } finally {
      write.end();
    }
  }

  /** `asOf`: the revision on screen when the write was submitted. */
  #commit(next: LedgerDocument, asOf: number): Promise<void> {
    this.#assertWritable();
    // The epoch's genesis is a format this build can't read (section 12):
    // nothing is written until the app is updated.
    if (this.#genesisBlocked) throw new ApiError(503, LEDGER_UPDATED);
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
    if (op && !this.#stopped) {
      this.#onCommitted();
      this.#pushSoon();
    }
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

  // --- The network half: triggers -------------------------------------------

  /** Runs a sync cycle now, and one more if a trigger fires meanwhile;
   * resolves when none is left to run. Never rejects. */
  sync(): Promise<void> {
    if (!this.#canCycle()) return this.#loop ?? Promise.resolve();
    this.#again = true;
    this.#loop ??= (async () => {
      try {
        while (this.#again && this.#canCycle()) {
          this.#again = false;
          await this.#cycle();
        }
      } finally {
        this.#loop = null;
      }
    })();
    return this.#loop;
  }

  /** "Try again": a cycle now. A rate limit's wait still holds (section
   * 12), so a tap can't turn it into a request loop. */
  syncNow(): Promise<void> {
    return this.sync();
  }

  #canCycle(): boolean {
    return this.#remote !== null && !this.#stopped && !this.#superseded && this.#lockHeld && !this.#loading && this.#doc !== null && this.#meta !== null;
  }

  /** The ledger is loaded: start listening for triggers, and sync now (the
   * unlock trigger). */
  #begin(): void {
    if (!this.#canCycle()) return;
    this.#listen();
    void this.sync();
  }

  /** Triggers (section 7): visible again, back online, a 60 s poll while
   * visible, and a keepalive push on pagehide. */
  #listen(): void {
    if (this.#listening) return;
    this.#listening = true;
    const { document: doc, window: win } = this.#events;
    const visible = () => doc?.visibilityState === undefined || doc.visibilityState === "visible";
    if (doc) {
      const onVisibility = () => {
        if (visible()) void this.sync();
      };
      doc.addEventListener("visibilitychange", onVisibility);
      this.#cleanups.push(() => doc.removeEventListener("visibilitychange", onVisibility));
    }
    if (win) {
      const onOnline = () => void this.sync();
      const onPageHide = () => this.#keepalivePush();
      win.addEventListener("online", onOnline);
      win.addEventListener("pagehide", onPageHide);
      this.#cleanups.push(() => {
        win.removeEventListener("online", onOnline);
        win.removeEventListener("pagehide", onPageHide);
      });
    }
    const poll = setInterval(() => {
      if (visible()) void this.sync();
    }, SYNC_TIMING.pollMs);
    this.#cleanups.push(() => clearInterval(poll));
  }

  /** Stops every timer and listener: nothing more is triggered. */
  #quiet(): void {
    for (const timer of [this.#debounce, this.#putTimer, this.#rateTimer]) if (timer !== null) clearTimeout(timer);
    this.#debounce = this.#putTimer = this.#rateTimer = null;
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
  }

  /** An own op committed: push it 2 s after the last change, or at once
   * when only this tab's memory holds it (section 12). The text a keepalive
   * push would send is built now, while there is time. */
  #pushSoon(): void {
    if (!this.#canCycle()) return;
    void this.#ownLogText().catch(() => undefined);
    if (this.#store.volatile()) {
      void this.sync();
      return;
    }
    if (this.#debounce !== null) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      void this.sync();
    }, SYNC_TIMING.debounceMs);
  }

  /** On pagehide: the own log, sent with keepalive so the request can
   * outlive the page, its response never read. A lost response is what
   * step 5 settles on the next start. Only a text already built can go: the
   * page may not live long enough to encrypt one. */
  #keepalivePush(): void {
    if (!this.#canCycle() || this.#blocker !== null || this.#genesisBlocked || this.#rateLimited()) return;
    const meta = this.#meta!;
    const through = this.#ownLog.at(-1)?.L ?? meta.K;
    const ready = this.#logReady;
    if (through <= meta.ownLogThrough || !ready || ready.through !== through || ready.device !== meta.deviceId) return;
    if (ready.text.length > SYNC_TIMING.keepaliveMaxBytes) return;
    this.#putTimes.push(this.#monotonic());
    this.#remote!.client.putFile({ path: repoPath(ready.file), text: ready.text, sha: meta.ownLogSha, message: deviceCommitMessage("Sync", ready.device), keepalive: true }).catch(
      () => undefined,
    );
  }

  // --- The network half: the cycle ------------------------------------------

  async #cycle(): Promise<void> {
    if (this.#rateLimited()) {
      this.#trouble = true;
      this.#emit();
      return;
    }
    try {
      if (await this.#run()) this.#trouble = false;
      else if (this.#blocker === null) this.#trouble = true;
    } catch (err) {
      this.#cycleFailed(err);
    } finally {
      this.#emit();
    }
  }

  /** One cycle. True if it ended with nothing left to retry. */
  async #run(): Promise<boolean> {
    const ref = await this.#head(true);
    // The repo answered with this token: whatever stopped the last cycle at
    // the ref is gone. Anything later is found again below.
    this.#blocker = null;
    if (ref.kind === "empty") {
      this.#blocker = "missing";
      return false;
    }
    let listedOwn: string | undefined;
    if (ref.kind === "head") {
      const meta = this.#meta!;
      if (ref.commitSha !== meta.lastSeenCommit) {
        const pulled = await this.#pull(await this.#list(ref.commitSha, ref.etag));
        if (pulled === null) return false;
        listedOwn = pulled.listedOwn;
      } else if (ref.etag !== meta.refEtag) {
        await this.#record({ refEtag: ref.etag });
      }
    }
    return this.#push(listedOwn);
  }

  /** Step 1: the branch head, conditional on the ETag of the last head
   * this device fully handled. */
  async #head(conditional: boolean): Promise<RefRead> {
    const { client, branch } = this.#remote!;
    try {
      return await client.getRef(branch, conditional ? this.#meta!.refEtag : null);
    } catch (err) {
      throw repoGone(err);
    }
  }

  /** Step 2: the sync files in ledger/ at `commit`. */
  async #list(commit: string, etag: string | null): Promise<Listing> {
    let listing;
    try {
      listing = await this.#remote!.client.listDir(commit, LEDGER_DIR);
    } catch (err) {
      throw repoGone(err);
    }
    const files = new Map<string, Listed>();
    for (const { name, sha, size } of listing.files) {
      const file = parseRepoFileName(name);
      if (file) files.set(name, { file, sha, size });
    }
    if (listing.truncated) this.#log("GitHub cut the file listing short; files it left out are read once it lists them");
    return { commit, etag, files, truncated: listing.truncated };
  }

  /** Steps 3 to 5 for a head this device hasn't handled: the epoch, the
   * genesis, the own log, and every other device's log, then one
   * transaction that joins what was read and records it. Null when the
   * cycle stops here. */
  async #pull(listing: Listing): Promise<{ listedOwn: string | undefined } | null> {
    const meta = this.#meta!;
    const epoch = meta.epochKey;
    const winner = winningEpoch([...listing.files.keys()]);
    if (winner === null) {
      // No genesis listed: no ledger in this repo (section 9.5).
      this.#blocker = "missing";
      return null;
    }
    const move = epochMove(winner, epoch);
    if (move === "stale") {
      // A listing older than what this device has joined (section 9.1).
      this.#log("the repo listing is older than what this device has joined; trying again later");
      return null;
    }
    if (move === "switch") {
      // A restore won (section 9.3). Switching to its epoch comes with
      // restore; until then nothing more is read or written here.
      this.#blocker = "needsAttention";
      this.#log(`a newer epoch (${winner}) is in the repo; this build can't switch to it yet`);
      return null;
    }

    const genesis = await this.#readGenesis(listing);
    if (genesis === null) return null;
    this.#genesisBlocked = false;

    const ownName = repoFileName({ kind: "log", epoch, device: meta.deviceId });
    const listedOwn = listing.files.get(ownName);
    const own = await this.#ownCheck(ownName, listedOwn);
    if (own.fork !== undefined) {
      this.#log(`this device's own log in the repo is not its history (${own.fork}); it syncs on as a new device`);
      await this.#rehome(listing);
      return { listedOwn: undefined };
    }

    const others = await this.#readOthers(listing);
    const patch: MetaPatch = { ...own.patch, joined: { ...meta.joined, ...genesis.joined, ...others.joined } };
    if (others.complete && !listing.truncated) {
      patch.lastSeenCommit = listing.commit;
      patch.refEtag = listing.etag;
    }
    if (others.ops.length > 0 || genesis.state) await this.join({ ops: others.ops, ...(genesis.state ? { state: genesis.state } : {}) }, patch);
    else await this.#record(patch);
    return { listedOwn: listedOwn?.sha };
  }

  /** The epoch's genesis, read once (it never changes): its state when it
   * holds anything this device's state lacks, and the sha to record. Null,
   * with the cycle stopped and nothing written, when it can't be read
   * (section 12): a newer format is needsUpdate (and writes are refused), a
   * key that doesn't fit is needsPassphrase, anything else needsAttention. */
  async #readGenesis(listing: Listing): Promise<{ state?: SyncState; joined: Record<string, string> } | null> {
    const name = repoFileName({ kind: "genesis", epoch: this.#meta!.epochKey });
    const listed = listing.files.get(name)!;
    if (this.#meta!.joined[name] === listed.sha) return { joined: {} };
    const read = await this.#read(name, listed);
    if (!read.ok || read.read.file.kind !== "genesis") {
      const problem = read.ok ? "malformed" : read.problem;
      this.#blocker = problem === "needsUpdate" ? "needsUpdate" : problem === "malformed" ? "needsAttention" : "needsPassphrase";
      this.#genesisBlocked = problem === "needsUpdate";
      return null;
    }
    const state = genesisState(read.read.file.doc);
    const probe = cloneState(this.#state!);
    const changes = joinInto(probe, state);
    const adds = changes.records.size > 0 || changes.units.size > 0;
    return { ...(adds ? { state } : {}), joined: { [name]: listed.sha } };
  }

  /** Step 5: what the listed own log sha says (section 7). */
  async #ownCheck(name: string, listed: Listed | undefined): Promise<OwnCheck> {
    const meta = this.#meta!;
    // No file yet, or a listing from before it.
    if (!listed || listed.sha === meta.ownLogSha) return { patch: {} };
    if (listed.sha === meta.lastSentLogSha) {
      return { patch: { ownLogSha: listed.sha, ownLogThrough: Math.max(meta.ownLogThrough, meta.lastSentLogThrough) } };
    }
    // Neither: a send whose sha was overwritten by a later send, an older
    // version in a stale listing, or another instance of this device.
    const read = await this.#read(name, listed);
    if (!read.ok) return { fork: `it can't be read: ${read.detail}` };
    const file = read.read.file;
    if (file.kind !== "log") return { fork: "it is not a log" };
    const last = file.ops.at(-1)?.L ?? file.snapThrough;
    if (last > meta.ownMaxL) return { fork: `it holds L ${last}, past this device's ${meta.ownMaxL}` };
    if (file.snapThrough > meta.K) return { fork: "it names a snapshot this device never made" };
    const local = last === 0 ? CHAIN_START : await this.#chainAt(last);
    if (local !== file.chain) return { fork: `its chain at L ${last} differs` };
    // This device's own history: confirmed through its last L, unless it is
    // older than what was confirmed already (a stale listing).
    if (meta.ownLogSha !== null && last <= meta.ownLogThrough) return { patch: {} };
    return { patch: { ownLogSha: listed.sha, ownLogThrough: last } };
  }

  /** This device's chain after its op at `L`, or undefined if it has none. */
  async #chainAt(L: number): Promise<string | undefined> {
    const text = await this.#store.chainEntry(L);
    if (text === undefined) return undefined;
    const value = await this.#open(text);
    return isChainValue(value) ? value : undefined;
  }

  /** Step 4: every other device's log in the epoch that this device hasn't
   * joined at its listed sha, read by blob sha. A file that can't be read
   * halts its stream (section 12); one whose snapshot point is past what
   * this device has seen from it waits for that snapshot (section 8.2).
   * Neither is joined in part, and neither sha is recorded, so the next
   * cycle tries again. `complete` says nothing was left out. */
  async #readOthers(listing: Listing): Promise<{ ops: [string, Op][]; joined: Record<string, string>; complete: boolean }> {
    const meta = this.#meta!;
    const ops: [string, Op][] = [];
    const joined: Record<string, string> = {};
    let complete = true;
    let gap = false;
    for (const [name, listed] of listing.files) {
      const { file } = listed;
      if (file.kind !== "log" || file.epoch !== meta.epochKey || file.device === meta.deviceId) continue;
      if (meta.joined[name] === listed.sha) {
        this.#halted.delete(name);
        continue;
      }
      const read = await this.#read(name, listed);
      if (!read.ok || read.read.file.kind !== "log") {
        this.#halted.set(name, !read.ok && read.problem === "needsUpdate" ? "needsUpdate" : "needsAttention");
        complete = false;
        continue;
      }
      const log = read.read.file;
      const seen = this.#state!.seen.get(file.device) ?? 0;
      if (log.snapThrough > seen) {
        gap = true;
        complete = false;
        continue;
      }
      this.#halted.delete(name);
      // Logs are cumulative and joined whole, so every op at or below what
      // this device has seen from that device is already in its state.
      for (const op of log.ops) if (op.L > seen) ops.push([file.device, op]);
      joined[name] = listed.sha;
    }
    // A halted file that is no longer listed in this epoch halts nothing.
    for (const name of this.#halted.keys()) if (!listing.files.has(name)) this.#halted.delete(name);
    this.#gapWait = gap;
    return { ops, joined, complete };
  }

  /** Reads and checks the blob a listing names. A refused one is
   * remembered by sha, which names its bytes for good. */
  async #read(name: string, listed: Listed): Promise<FileRead> {
    const known = this.#refused.get(listed.sha);
    if (known) return known;
    const text = await this.#remote!.client.readBlob(listed.sha);
    const read = await openRepoFile(listed.file, text, this.#key);
    if (!read.ok) {
      this.#refused.set(listed.sha, read);
      this.#log(`${name} can't be joined (${read.problem}): ${read.detail}`);
    }
    return read;
  }

  /** Step 6: PUTs the own log when it holds an op not yet confirmed. False
   * when the cycle should be retried (section 12). */
  async #push(listedOwn: string | undefined): Promise<boolean> {
    const meta = this.#meta!;
    const through = this.#ownLog.at(-1)?.L ?? meta.K;
    if (through <= meta.ownLogThrough) return true;
    const wait = this.#putWait();
    if (wait > 0) {
      this.#putLater(wait);
      return true;
    }
    const out = await this.#ownLogText();
    // The repo holds these exact bytes: a PUT would only add an empty commit.
    if (out.sha === listedOwn) {
      await this.#record({ ownLogSha: out.sha, ownLogThrough: Math.max(this.#meta!.ownLogThrough, out.through) });
      return true;
    }
    // Saved before it is sent, so a lost response is settled by step 5.
    await this.#record({ lastSentLogSha: out.sha, lastSentLogThrough: out.through });
    const { client } = this.#remote!;
    let base = this.#meta!.ownLogSha;
    for (let put = 1; ; put++) {
      if (!this.#canCycle()) return false;
      this.#putTimes.push(this.#monotonic());
      try {
        const res = await client.putFile({ path: repoPath(out.file), text: out.text, sha: base, message: deviceCommitMessage("Sync", out.device) });
        this.#lastLanded = this.#monotonic();
        const m = this.#meta!;
        const patch: MetaPatch = { ownLogSha: res.sha, ownLogThrough: Math.max(m.ownLogThrough, out.through) };
        // No other commit came between the head this device handled and
        // this one, so this one is handled too.
        if (res.parentSha !== null && res.parentSha === m.lastSeenCommit) Object.assign(patch, { lastSeenCommit: res.commitSha, refEtag: null });
        await this.#record(patch);
        return true;
      } catch (err) {
        if (!(err instanceof ShaConflictError)) throw err;
        if (put >= MAX_PUTS) {
          this.#log(`the repo refused ${MAX_PUTS} writes of this device's log in a row; trying again on the next trigger`);
          return false;
        }
        await this.#sleep(SYNC_TIMING.retryMs[put - 1] + Math.floor(this.#random() * SYNC_TIMING.jitterMs));
        if (!this.#canCycle()) return false;
        // Another commit moved the branch: the same PUT may go again.
        if (err.reason === "branch-race") continue;
        // The sha is stale: run steps 1, 2 and 5 again (section 12).
        const ref = await this.#head(false);
        if (ref.kind !== "head") {
          if (ref.kind === "empty") this.#blocker = "missing";
          return false;
        }
        const listing = await this.#list(ref.commitSha, ref.etag);
        const winner = winningEpoch([...listing.files.keys()]);
        if (winner !== this.#meta!.epochKey) return false;
        const name = repoFileName(out.file);
        const listed = listing.files.get(name);
        const own = await this.#ownCheck(name, listed);
        if (own.fork !== undefined) {
          this.#log(`this device's own log in the repo is not its history (${own.fork}); it syncs on as a new device`);
          await this.#rehome(listing);
          this.#again = true;
          return true;
        }
        if (Object.keys(own.patch).length > 0) await this.#record(own.patch);
        // It landed after all (a lost or late response).
        if (this.#meta!.ownLogThrough >= out.through) return true;
        base = listed?.sha ?? this.#meta!.ownLogSha;
      }
    }
  }

  /** How long until an own log PUT may go: at least SYNC_TIMING.putGapMs
   * after the last that landed, and no more than putsPerHour an hour. 0
   * when it may go now. */
  #putWait(): number {
    const now = this.#monotonic();
    this.#putTimes = this.#putTimes.filter((t) => now - t < HOUR_MS);
    let wait = this.#lastLanded === null ? 0 : this.#lastLanded + SYNC_TIMING.putGapMs - now;
    if (this.#putTimes.length >= SYNC_TIMING.putsPerHour) wait = Math.max(wait, this.#putTimes[0] + HOUR_MS - now);
    return Math.max(0, wait);
  }

  #putLater(ms: number): void {
    if (this.#putTimer !== null) return;
    this.#putTimer = setTimeout(() => {
      this.#putTimer = null;
      void this.sync();
    }, ms);
  }

  /** The own log file (section 6) for the own ops committed now, as text.
   * Built once per content and reused, so a text sent again is the same
   * bytes and a sha that lands is recognised whichever send it was. */
  #ownLogText(): Promise<LogText> {
    const meta = this.#meta!;
    const ops = this.#ownLog;
    const chain = this.#chainHead;
    const through = ops.at(-1)?.L ?? meta.K;
    const key = `${meta.epochKey}.${meta.deviceId}.${meta.K}.${through}.${chain}`;
    if (this.#logText?.key === key) return this.#logText.value;
    const file: RepoFile = { kind: "log", epoch: meta.epochKey, device: meta.deviceId };
    const content = { fv: FORMAT_VERSION, kind: "log", epoch: meta.epochKey, device: meta.deviceId, snapThrough: meta.K, chain, ops: [...ops] };
    // Never publish what every other device would refuse.
    const check = checkRepoFile(file, content);
    if (!check.ok) return Promise.reject(new Error(`This device's own log would be refused: ${check.detail}`));
    let entry: { key: string; value: Promise<LogText> } | undefined;
    const value = (async (): Promise<LogText> => {
      const text = await seal(content, this.#key);
      const built = { text, sha: await gitBlobSha(text), through, device: meta.deviceId, file };
      // Only the newest text is kept for pagehide.
      if (this.#logText === entry) this.#logReady = built;
      return built;
    })();
    entry = { key, value };
    this.#logText = entry;
    value.catch(() => {
      if (this.#logText === entry) this.#logText = null;
    });
    return value;
  }

  /** Saves sync bookkeeping in meta alone, in one transaction. */
  #record(patch: MetaPatch): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertWritable();
      const meta = this.#meta!;
      if ((Object.keys(patch) as (keyof MetaPatch)[]).every((key) => canonicalJson(patch[key]) === canonicalJson(meta[key]))) return;
      await this.#mutate({ ...meta, ...patch }, {});
      this.#emit();
    });
  }

  /** What a failed cycle means (section 12). Nothing is lost either way:
   * every own op stays in ownLog until the repo is known to hold it. */
  #cycleFailed(err: unknown): void {
    if (err instanceof GitHubAuthError || err instanceof GitHubForbiddenError) {
      this.#blocker = "needsToken";
    } else if (err instanceof RepoNotFoundError) {
      this.#blocker = "missing";
    } else if (err instanceof GitHubRateLimitError) {
      this.#waitUntil(Date.parse(err.resetAt ?? ""));
      this.#trouble = true;
    } else if (this.#stopped || this.#superseded) {
      // Closed or taken over mid-cycle: nothing more to do here.
    } else {
      if (!(err instanceof GitHubNetworkError)) this.#log("sync failed; it will be tried again", err);
      this.#trouble = true;
    }
  }

  /** No cycle before `at` (a rate limit's reset), and one then. A reset
   * already past on this device's clock waits the floor instead, so a clock
   * ahead of GitHub's can't turn the wait into a request loop (B6), and
   * none waits longer than the cap, so a clock behind GitHub's can't block
   * syncing for hours (B14). */
  #waitUntil(at: number): void {
    const now = this.#now();
    const delay = at > now ? Math.min(at - now, SYNC_TIMING.rateLimitCapMs) : SYNC_TIMING.rateLimitFloorMs;
    this.#rateLimit = { at: now, delay };
    if (this.#rateTimer !== null) clearTimeout(this.#rateTimer);
    this.#rateTimer = setTimeout(() => {
      this.#rateTimer = null;
      this.#rateLimit = null;
      void this.sync();
    }, delay);
  }

  /** Whether the wait after a rate limit is still on. It ends when its timer
   * fires (timers don't follow the wall clock), when this device's clock
   * says the delay has passed, or when that clock was set back past the
   * time the limit was hit, since it can then no longer tell how long has
   * passed (B27). Never an absolute time on the clock. */
  #rateLimited(): boolean {
    const limit = this.#rateLimit;
    if (limit === null) return false;
    const now = this.#now();
    if (now >= limit.at && now - limit.at < limit.delay) return true;
    this.#rateLimit = null;
    return false;
  }

  // --- The network half: rehome (section 10.3) -------------------------------

  /** The own log in the repo is not this device's history: a cloned
   * profile, an IndexedDB restored from a backup, or a tab that bypassed
   * the lock. The device stops writing its old id's files, rebuilds its
   * state from the epoch's files as they are now (the old id's included,
   * as any other device's), and re-issues under a new id, at their original
   * L, the writes of its old id that the rebuilt state lacks. One
   * transaction replaces the state; the next push publishes the new log. It
   * takes a write turn, so no write is diffed across the change of id. */
  async #rehome(listing: Listing): Promise<void> {
    const turn = this.beginWrite();
    try {
      await turn.ready;
      this.#assertWritable();
      const rebuilt = await this.#coldJoin(listing);
      await this.#enqueue(async () => {
        this.#assertWritable();
        const pre = this.#state!;
        const meta = this.#meta!;
        const device = newDeviceId();
        const vv = vectorOf(rebuilt.state.seen);
        const at = this.#now();
        const ops: Op[] = rehomeReissue(pre, rebuilt.state, meta.deviceId).map((r) => ({
          L: r.L,
          at,
          by: this.#actor,
          vv,
          set: r.set,
          del: r.del,
          ...(r.ra ? { ra: r.ra } : {}),
        }));
        const next = cloneState(rebuilt.state);
        let chain = CHAIN_START;
        const ownLog: [number, string][] = [];
        const chainEntries: [number, string][] = [];
        for (const op of ops) {
          const problem = opProblem(op);
          if (problem) throw new Error(`A re-issued op is malformed: ${problem}`);
          applyOp(next, device, op);
          chain = await chainNext(chain, await opHash(op));
          ownLog.push([op.L, await seal({ ops: [[device, op]] } satisfies Delta, this.#key)]);
          chainEntries.push([op.L, await seal(chain, this.#key)]);
        }
        const nextMeta: SyncMeta = {
          ...meta,
          deviceId: device,
          maxL: next.maxL,
          ownMaxL: ops.at(-1)?.L ?? 0,
          K: 0,
          ownLogSha: null,
          ownLogThrough: 0,
          lastSentLogSha: null,
          lastSentLogThrough: 0,
          ownSnapSha: null,
          lastSentSnapSha: null,
          joined: rebuilt.joined,
          seen: vectorOf(next.seen),
          lastSeenCommit: rebuilt.complete ? listing.commit : null,
          refEtag: rebuilt.complete ? listing.etag : null,
        };
        const doc = materialize(next);
        const notice = await seal({ kind: "rehome", from: meta.deviceId, to: device, at, message: REHOMED }, this.#key);
        const base = await seal(storedState(next), this.#key);
        this.#assertWritable();
        await this.#mutate(nextMeta, {
          base,
          clearTail: true,
          ownLog: { dropThrough: Number.MAX_SAFE_INTEGER, put: ownLog },
          clearChain: true,
          chain: chainEntries,
          notices: { put: [[`rehome/${device}`, notice]] },
        });
        const before = this.#doc!;
        this.#fence.replace(pre, next, canonicalJson({ ...before, tombstones: [] }) !== canonicalJson({ ...doc, tombstones: [] }));
        this.#state = next;
        this.#doc = doc;
        this.#ownLog = ops;
        this.#chainHead = chain;
        this.#noticeCount++;
        this.#emit();
      });
    } finally {
      turn.end();
    }
  }

  /** The epoch rebuilt from its files (section 8.3; snapshots come with
   * design step 5): the genesis, then every log. A version that can't be
   * joined now is replaced by the one this device joined before, which
   * still reads by its sha, so nothing this device had from another device
   * is dropped. */
  async #coldJoin(listing: Listing): Promise<{ state: SyncState; joined: Record<string, string>; complete: boolean }> {
    const meta = this.#meta!;
    const epoch = meta.epochKey;
    const versions = new Map<string, Listed[]>();
    for (const [name, listed] of listing.files) if (listed.file.epoch === epoch && listed.file.kind !== "snap") versions.set(name, [listed]);
    for (const [name, sha] of Object.entries(meta.joined)) {
      const file = parseRepoFileName(name);
      if (!file || file.epoch !== epoch || file.kind === "snap") continue;
      const list = versions.get(name) ?? [];
      if (!list.some((v) => v.sha === sha)) versions.set(name, [...list, { file, sha, size: 0 }]);
    }
    const genesisName = repoFileName({ kind: "genesis", epoch });
    let state: SyncState | null = null;
    const joined: Record<string, string> = {};
    let complete = !listing.truncated;
    for (const listed of versions.get(genesisName) ?? []) {
      const read = await this.#read(genesisName, listed);
      if (!read.ok || read.read.file.kind !== "genesis") continue;
      state = genesisState(read.read.file.doc);
      joined[genesisName] = listed.sha;
      break;
    }
    if (state === null) throw new Error("The epoch's genesis can't be read, so this device can't rebuild its state");
    for (const [name, list] of versions) {
      if (name === genesisName) continue;
      let done = false;
      for (const listed of list) {
        const read = await this.#read(name, listed);
        if (!read.ok || read.read.file.kind !== "log" || listed.file.kind !== "log") continue;
        const log = read.read.file;
        if (log.snapThrough > (state.seen.get(listed.file.device) ?? 0)) continue;
        for (const op of log.ops) applyOp(state, listed.file.device, op);
        joined[name] = listed.sha;
        done = true;
        break;
      }
      if (!done || joined[name] !== list[0].sha) complete = false;
    }
    return { state, joined, complete };
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
    this.#quiet();
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
      this.#begin();
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

  /** Own ops not yet known to be in the repo: those above the confirmed
   * own log's last L. */
  #pendingCount(): number {
    const through = this.#meta?.ownLogThrough ?? 0;
    let n = 0;
    for (let i = this.#ownLog.length - 1; i >= 0 && this.#ownLog[i].L > through; i--) n++;
    return n;
  }

  /** Section 11. The local half's states come first (another tab, saved
   * state this build can't read), then whatever stops the cycle, then a
   * cycle that failed (`pending`, retried on the next trigger), then work
   * under way (`saving`: own ops not yet confirmed, or a gap to wait out),
   * then streams that halted, which the device syncs around. */
  #currentStatus(): SyncStatus {
    if (this.#status !== "idle") return this.#status;
    if (this.#blocker !== null) return this.#blocker;
    if (this.#remote === null || this.#doc === null) return "idle";
    if (this.#trouble) return "pending";
    if (this.#gapWait || this.#pendingCount() > 0) return "saving";
    if (this.#halted.size > 0) return [...this.#halted.values()].includes("needsUpdate") ? "needsUpdate" : "needsAttention";
    return "idle";
  }

  #makeSnapshot(): EngineState {
    return {
      status: this.#currentStatus(),
      hasDocument: this.#doc !== null,
      needsInit: this.#needsInit,
      unreadable: this.#unreadable,
      revision: this.#fence.revision,
      pendingCount: this.#pendingCount(),
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
