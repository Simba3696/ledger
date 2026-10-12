import { ApiError } from "../ApiError";
import { InvalidFileError, WrongPassphraseError } from "../crypto";
import type { HostWrite } from "../document/DocumentBackend";
import type { LedgerDocument } from "../document/types";
import { isWritableDocument } from "../document/validate";
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
  putFileBody,
  type GitHubClient,
  type RefRead,
} from "../github/contents";
import { canonicalJson } from "./canonical";
import { CHAIN_START, FORMAT_VERSION, chainNext, checkRepoFile, encodeState, opHash, opProblem, vectorOf } from "./codec";
import { diffDocuments } from "./diff";
import { compareEpochKeys, epochMove, isEpochKey, nextEpochKey, parseRepoFileName, repoFileName, winningEpoch, type RepoFile } from "./epoch";
import { Fence, type FenceNotice } from "./fence";
import {
  appliedPart,
  checkGroup,
  inEffect,
  keptAfterChange,
  keptAfterJoin,
  keptAfterReapply,
  leftBehind,
  leftBehindItems,
  reapplyTo,
  registerAt,
  supersededByOwn,
  unkept,
  withoutHeld,
  type KeptJudge,
  type LeftBehindGroup,
  type LeftBehindItem,
  type ReapplyResult,
} from "./leftBehind";
import { damagedFileMessage, damagedGenesis, forgetRestore, rememberRestore, winningEpochNow, writeGenesis, type DamagedFile, type EpochNow, type GenesisContent } from "./ledgerRepo";
import { materialize, readerOf, rematerialize } from "./materialize";
import { LocalStateNewer, WriterTokenMismatch, openSyncStore, registerRunning, type Mutation, type StoredRecords, type SyncStore } from "./persist";
import {
  LOCAL_FORMAT_VERSION,
  checkMeta,
  decodeDelta,
  decodeOld,
  decodeStoredState,
  isChainValue,
  seal,
  storedOld,
  storedState,
  unseal,
  type Delta,
  type DeviceKey,
  type OldEpoch,
  type SyncMeta,
} from "./records";
import { rehomeReissue } from "./rehome";
import { LEDGER_DIR, READ_BOUNDS, openRepoFile, plainSize, repoPath, type FileBounds, type FileRead } from "./repoFiles";
import { applyOp, cloneState, emptyState, genesisState, holdsOp, joinInto, opState, type Op, type SyncState } from "./state";
import { LamportExhausted, compareTags, newDeviceId, nextLamport, randomHex, type Tag, type VersionVector } from "./tags";

// The sync engine (design sections 3.4, 3.5, 7, 8, 10, 11 and 12): the
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
//      joined ends the cycle. A newer epoch (a restore) wins outright: the
//      device projects its old-epoch state above the restore's cut into
//      groups of changes left behind, and in one transaction moves that
//      state aside and starts the new epoch from its genesis under a new
//      device id; then it reads the new epoch's files (section 9.3).
//   4. Read every other device's log whose listed sha this device hasn't
//      joined, by blob sha (never stale), and join each valid file whole;
//      a malformed one halts only its own stream (section 12), and its sha
//      is not recorded, so it is read again once its device writes anew. A
//      log whose snapshot point is past what this device holds from its
//      device's own files needs that device's snapshot first (section
//      8.2), a first start included (section 8.3). A snapshot vouches only
//      for its own device's ops: its `joined` and `seen` never stand in for
//      reading another file (owner decision D24).
//   5. Settle this device's own snap, then its own log, from the listed
//      sha alone: the sha it knows, the one it last sent (that send
//      landed), or anything else, which is read and either is this device's
//      history (confirmed) or is a fork, which rehomes the device under a
//      new id (section 10.3).
//   6. PUT the own log, every own op above K, if any is unconfirmed or K
//      moved: the sent sha is saved first, a 409 retries (at most 4 PUTs a
//      cycle), and an identical text is never sent again.
//   7. Once the own log is confirmed and long enough, PUT a snapshot of the
//      device's state at K, its greatest own L; once that is confirmed, drop
//      own ops at or below K and push the trimmed log (section 8.1).
// Only ops whose transaction committed are ever sent. The bookkeeping a
// cycle learns (files joined, the head handled, the own log confirmed) is
// saved with the ops it joined, in one transaction. A head is recorded as
// handled only when every file in it was joined, so a halted stream, a gap
// or a failed read is retried by the next cycle, and an idle device makes
// one uncounted request a poll. Nothing the cycle meets is fatal: any throw
// ends it with `pending`, and the next trigger tries again. A cycle reads
// and records for the epoch and device id it started with: when they change
// outside it (a new epoch at Lamport exhaustion), nothing it read is joined
// or recorded, and it runs again.
//
// Separately, the device folds its saved `tail` into `base` once it grows
// long (section 8.4), in one transaction.
//
// Epochs (section 9): restore() writes a backup as a new epoch's genesis,
// based on what this device has seen, and refuses own writes from then on
// until the reload that follows it; reapply() and discard() resolve a
// group of changes a restore left behind, with an op carrying its re-apply
// marker; exportBackup() seals the current document. When no Lamport value
// is left (a crafted file's L near 2^50), the device restores its current
// document as the next epoch and commits the write there.

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
  /** Groups of changes a restore left behind still to review (section 9.3):
   * every one shown, and of those this device's own (owner decision D18:
   * own prominently, other devices' in a collapsed list). */
  leftBehindCount: number;
  leftBehindOwnCount: number;
  /** The winning genesis is newer than this device's epoch and can't be
   * opened here (owner decision D26): sync stops, local writes go on, and
   * deleting this file on GitHub resumes it (damagedFileMessage says how).
   * Null otherwise, a genesis too new for this build included. */
  damagedFile: DamagedFile | null;
  /** A restore this tab started (restore()), once its genesis was sent:
   * "pending" while a PUT got no answer and no listing has settled it
   * ("unknown"), "landed" once its genesis is known to be in the repo
   * (clear the sync state and reload, section 9.2 step 7). Null when none
   * was, or a full listing showed the pending one never landed. */
  restore: RestoreState | null;
}

/** How a restore this tab started stands (EngineState.restore). */
export interface RestoreState {
  state: "pending" | "landed";
  /** The epoch its genesis is for. */
  epoch: string;
}

/** A group of changes a restore left behind, as the list shows it. */
export interface LeftBehindView {
  /** Its re-apply marker, "<oldEpoch>/<device>": what reapply() and
   * discard() take. */
  id: string;
  epoch: string;
  device: string;
  /** This device's own changes (shown prominently, D18). */
  own: boolean;
  /** A login on the device's changes, or null. */
  who: string | null;
  /** The restore that left them behind. */
  into: { epoch: string; by: string; at: number };
  /** The group's marker is joined (another device re-applied or discarded
   * it, or this device re-applied it and a re-apply from an older view set
   * some of it back), but this device's own changes are not all in effect:
   * shown until this device resolves it again. */
  resolvedElsewhere: boolean;
  items: LeftBehindItem[];
}

/** What a restore did (section 9.2). */
export type RestoreResult =
  /** The backup is the new epoch's genesis. Clear this device's sync
   * state and reload (#9): the device starts in it as a new device.
   * `winnerUnknown`: it landed, but the repo couldn't be listed after it,
   * or GitHub cut the listing short, so a racing restore may have won;
   * after the reload, takeRestoredEpoch() against epochKey still tells. */
  | { kind: "restored"; epoch: string; winnerUnknown?: true }
  /** It landed, but a greater epoch was already listed: "Sam's restore
   * replaced yours. [Restore again]". Clear and reload as for "restored".
   * `reason`, `by` and `at` say who made the winner and when, when its
   * genesis could be read (display only). */
  | { kind: "replaced"; epoch: string; winner: string; reason?: GenesisContent["reason"]; by?: string; at?: number }
  /** Own changes are not in the repo yet, or this device's own changes an
   * earlier restore left behind are not yet re-applied or discarded (they
   * are kept only on this device, D18): the reload after a restore would
   * lose them. "N changes on this device haven't synced. [Try again]
   * [Restore anyway]", and for the groups "[Review]". Nothing was
   * written. */
  | { kind: "unsynced"; pendingCount: number; leftBehindOwnCount: number }
  /** Not a document this build writes (isWritableDocument). */
  | { kind: "invalid" }
  /** Larger than every reader allows. Nothing was written. */
  | { kind: "tooLarge"; detail: string }
  /** Nothing was written, or every PUT of the genesis was answered with a
   * refusal: it didn't land, and nothing was replaced. Try again.
   * `damagedFile`: the listing's winner is newer than this device's epoch
   * and can't be opened here; nothing is ever written past it, and
   * deleting it on GitHub lets sync, and a restore, go on (D26). */
  | { kind: "failed"; detail: string; damagedFile?: DamagedFile }
  /** A PUT of `epoch`'s genesis got no answer, and the listing since didn't
   * show it: it may still land, and then it replaces the ledger like any
   * restore. Sync (or reload) before trying again. Own writes stay refused
   * until a listing settles it: one that shows the genesis makes this a
   * landed restore (reload to continue); a full one without it lets writes
   * go on, and a genesis that lands later still is switched to like any
   * other restore, own changes since offered (D18). The epoch is
   * remembered for the reload (rememberRestore), and forgotten once a full
   * listing shows it never landed (takeRestoredEpoch). */
  | { kind: "unknown"; epoch: string };

/** The sync bookkeeping a remote join may record with its delta. */
export type MetaPatch = Partial<
  Pick<
    SyncMeta,
    | "ownLogSha"
    | "ownLogThrough"
    | "ownLogK"
    | "lastSentLogSha"
    | "lastSentLogThrough"
    | "lastSentLogK"
    | "lastSentSnapSha"
    | "lastSentSnapThrough"
    | "joined"
    | "logReach"
    | "snapReach"
    | "lastSeenCommit"
    | "refEtag"
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
  /** When the device compacts. Default COMPACTION. */
  compaction?: Partial<CompactionLimits>;
  /** The bounds this build reads repo files within. Default READ_BOUNDS.
   * Own files are written within half of them and read back within twice
   * them (repoFiles.ts). */
  fileBounds?: FileBounds;
}

/** When the device compacts (design sections 8.1 and 8.4). Counts and
 * sizes only, never time. */
interface CompactionLimits {
  /** Snapshot once the own log holds this many ops... */
  logOps: number;
  /** ...or its text is this long: a re-PUT body then stays under about
   * 55 KB, and a keepalive push within SYNC_TIMING.keepaliveMaxBytes. */
  logBytes: number;
  /** Fold `tail` into `base` once it holds more entries than this. */
  tailEntries: number;
}

const COMPACTION: CompactionLimits = { logOps: 200, logBytes: 40 * 1024, tailEntries: 500 };

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
  /** The largest request body of a PUT sent on pagehide. Browsers refuse a
   * keepalive request whose body would take the page's keepalive bodies in
   * flight past 64 KiB. The body carries the log text as base64 inside JSON,
   * about 4/3 of the text, so this is about 45 KiB of text. */
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
/** Why a write is refused when no Lamport value is left in the epoch and
 * the next epoch can't be written now (ADR-0008: Lamport exhaustion). */
export const NEEDS_NEW_EPOCH = "Ledger needs to reach GitHub to save more changes. Try again when you're online.";
/** Why a write is refused when no Lamport value is left in the epoch and a
 * newer genesis this device can't open is listed: no epoch is written past
 * it (owner decision D26), so the write waits until it is deleted. */
const needsNewEpochPast = (file: DamagedFile) =>
  `Ledger can't save more changes until sync resumes: it needs a new epoch to number them, and none can start while ${file.path} is in the repo. ${damagedFileMessage(file)}`;
/** Why a write is refused while a restore writes its genesis, and for good
 * once it landed: the caller clears this device's sync state and reloads
 * (section 9.2 step 7), so a write saved now would be lost with it. */
const RESTORING = "A backup is being restored. Try again once it finishes.";
const RESTORED = "Ledger was restored from a backup. Reload to continue.";
/** Why a write is refused after a restore whose genesis PUT got no answer,
 * until a listing settles whether it landed. */
const RESTORE_UNKNOWN = "A backup restore may still be on its way to GitHub. Try again once Ledger has synced.";
/** Why reapply() or discard() is refused: the group is gone. */
export const ALREADY_RESOLVED = "Those changes were already re-applied or discarded.";
/** Why a write diffed in one epoch (or under one device id) is refused
 * when the epoch switched (or the device rehomed) before it was saved. */
const CHANGED_WHILE_SAVING = "Ledger changed while this was saving. Try again.";
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

/** What halts a device's stream (section 12). */
type Halt = "needsUpdate" | "needsAttention";

/** The epoch rebuilt by a rehome's cold join, with what it couldn't join:
 * listed files halted (by file name, with what halted each) and whether a
 * listed log waits for its snapshot. `complete` says every listed log was
 * joined at its listed sha. */
interface ColdJoin {
  state: SyncState;
  joined: Record<string, string>;
  logReach: VersionVector;
  snapReach: VersionVector;
  complete: boolean;
  halted: Map<string, Halt>;
  gap: boolean;
}

/** Where #readStreams reads the epoch's device streams from. */
interface StreamSource {
  listing: Listing;
  /** The epoch's genesis state, which every snap is checked against. */
  genesis: () => Promise<SyncState>;
  /** Per device, the last L of its log that the state being built holds,
   * and the `through` of the version of its snapshot last joined (the one
   * `joined` names), as read from that device's own files (meta.logReach
   * and meta.snapReach). */
  logReach: Map<string, number>;
  snapReach: Map<string, number>;
  /** The state the read's ops join into, if it holds anything yet: an op
   * at or below its log's logReach is left out only when joining it would
   * change nothing here. */
  held: SyncState | null;
  /** The file versions that state already includes. */
  joined: Readonly<Record<string, string>>;
  /** The device whose files are not read (this device, in a cycle). */
  skip: string | null;
  /** The logs to read, by name. */
  logs: string[];
  /** The snapshots to read whether or not a log needs them, by name. */
  snaps: string[];
  /** A file's versions to try, the listed one first. */
  versions: (name: string) => Listed[];
}

/** What #readStreams found: snapshots (as states) and ops to join, the file
 * versions they hold, and each stream's health. */
interface Streams {
  /** The snapshots joined, by the device whose snapshot each is. */
  snaps: [device: string, state: SyncState][];
  ops: [device: string, op: Op][];
  /** Files newly joined (each read here), name to blob sha. */
  joined: Record<string, string>;
  /** The source's reaches, raised by what was read. */
  logReach: Map<string, number>;
  snapReach: Map<string, number>;
  /** Listed files that can't be joined (a log, or a snap a log waits for),
   * and listed files found sound. */
  halted: Map<string, Halt>;
  healthy: Set<string>;
  /** A listed log waits for a snapshot not yet readable (section 8.2). */
  gap: boolean;
  /** Every log was joined at its first version. */
  complete: boolean;
}

/** The own log as text, ready to PUT. */
interface LogText {
  text: string;
  /** gitBlobSha(text): the file's sha once it lands. */
  sha: string;
  /** The greatest own L it holds (K when it holds no op). */
  through: number;
  /** Its snapThrough. */
  K: number;
  device: string;
  file: RepoFile;
}

/** The own snap as text, ready to PUT (section 8.1 step 2). */
interface SnapText {
  text: string;
  sha: string;
  /** K: the device's greatest own L when it was taken. */
  through: number;
  device: string;
  file: RepoFile;
}

/** What a cycle's own check found (section 7 step 5). */
type OwnCheck = { fork: string } | { fork?: undefined; patch: MetaPatch };

/** What the listed own snap says (section 8.1 step 3): a fork, a snapshot
 * of this device's confirmed through `through`, or nothing new. */
type SnapCheck = { fork: string } | { fork?: undefined; confirm?: { sha: string; through: number } };

const haltOf = (read: FileRead): Halt => (!read.ok && read.problem === "needsUpdate" ? "needsUpdate" : "needsAttention");

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
  /** Entries in `tail`. */
  tailCount: number;
  leftBehind: Map<string, LeftBehindGroup>;
  old: string | null;
}

/** A restore genesis written (section 9.2), or why not. */
type RestoreWrite =
  | { kind: "written"; genesis: NewEpoch }
  | { kind: "tooLarge"; detail: string }
  | { kind: "failed"; detail: string; damagedFile?: DamagedFile }
  | { kind: "unknown"; epoch: string; detail: string };

/** A new epoch's genesis, read or written, to switch to (section 9.3). */
interface NewEpoch {
  epoch: string;
  /** Its blob sha in the repo. */
  sha: string;
  state: SyncState;
  basedOn: GenesisContent["basedOn"];
  by: string;
  at: number;
}

/** A write that resolves a group a restore left behind (reapply, discard):
 * its marker, carried as the op's `ra`, and what the device keeps of the
 * group (an own group's re-applied part, which the op's own L then marks,
 * D27), or null to drop it in the op's own transaction. */
interface Resolves {
  marker: string;
  keep: LeftBehindGroup | null;
}

/** What a join knows beyond its ops (D27): the snapshots it joins, by
 * their device, and the devices with a file in the epoch (null for a cut
 * listing, which proves no absence). */
interface JoinContext {
  snaps: readonly [device: string, state: SyncState][];
  listed: ReadonlySet<string> | null;
}

/** Judges nothing as having seen a re-apply: a change whose source is
 * unknown (a rehome's rebuild) is set back, so it shows again rather than
 * being lost (D27). */
const UNSEEN: KeptJudge = { register: () => false, deletion: () => false };

/** A notice's key: (winner op, loser op), so each pair is stored once. */
function noticeKey(notice: FenceNotice, mine: Tag): string {
  const id = (t: Tag) => `${t[0]}.${t[1]}`;
  return notice.kind === "kept" ? `${id(notice.theirs)}/${id(mine)}` : `${id(mine)}/${id(notice.theirs)}`;
}

/** A record didn't decrypt with this key or this build. */
class Undecryptable extends Error {}

/** The own log is larger than every reader allows: it is never sent. */
class OwnLogTooLarge extends Error {}

/** The epoch switched (or the device rehomed) outside the running cycle,
 * as a new epoch at Lamport exhaustion does: what the cycle read and would
 * record belongs to the epoch and device id it started with. */
class IdentityChanged extends Error {}

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
  #leftBehindOwnCount = 0;
  /** Groups of changes restores left behind (section 9.3), by marker, as
   * stored: shown or not by #isHidden. */
  #leftBehind = new Map<string, LeftBehindGroup>();
  /** The `old` record's text as last loaded or written: the previous
   * epochs' states (records.ts OldEpoch), or null once none is kept. */
  #oldText: string | null = null;
  /** A tidy of hidden groups is queued. */
  #tidying = false;
  /** The queued tidy may drop hidden own groups too: a join (or a switch,
   * or a rehome) that found one asked for it since the last tidy began. */
  #tidyOwn = false;
  /** The next epoch being written because no Lamport value is left. */
  #renumbering: Promise<void> | null = null;
  /** restore() is writing its genesis ("writing"), or wrote it ("written",
   * for good): own writes are refused (RESTORING, RESTORED). */
  #restore: "writing" | "written" | null = null;
  /** The epoch of a restore genesis whose PUT got no answer (restore()'s
   * "unknown"): own writes are refused until a listing settles whether it
   * landed (#settleRestore). */
  #restoreUnknown: string | null = null;
  /** EngineState.restore, the same object while it doesn't change. */
  #restoreState: RestoreState | null = null;
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
  /** The epoch and device id the running cycle reads and records for, or
   * null when none runs. A switch or a rehome the cycle makes moves it on;
   * one made outside it (a new epoch at Lamport exhaustion) doesn't, and
   * the cycle's joins and bookkeeping are then refused (IdentityChanged). */
  #cycleFor: { epoch: string; device: string } | null = null;
  /** Set by a cycle that stops on something only a change outside it fixes. */
  #blocker: Blocker | null = null;
  /** The last cycle failed for a reason the next trigger may not meet
   * (offline, a 5xx, a rate limit, a stale listing, retries spent). */
  #trouble = false;
  /** Another device's log needs its snapshot first (section 8.2). */
  #gapWait = false;
  /** Halted streams: file name to what halted it (section 12). */
  readonly #halted = new Map<string, Halt>();
  /** Files that were read and refused, by `<name>@<blob sha>`. A blob
   * never changes, so it isn't read again in this tab; a new build reads it
   * afresh. The name is part of the key because the verdict depends on it:
   * a byte copy of a valid log under another device's name has the same
   * sha, and is refused only because its content doesn't match its name. */
  readonly #refused = new Map<string, Extract<FileRead, { ok: false }>>();
  /** Snapshots refused because their `seen` names devices with no file
   * listed, by `<name>@<blob sha>`, to those devices. Unlike #refused the
   * verdict depends on the listing, so it is checked again against every
   * listing; the snapshot is downloaded again only once all are listed. */
  readonly #unlistedSeen = new Map<string, string[]>();
  /** Logs read and found waiting for their snapshot (section 8.2), by
   * `<name>@<blob sha>`: each poll checks them again without downloading
   * them again. Dropped once joined or no longer listed at that sha. */
  readonly #waitingLogs = new Map<string, FileRead>();
  /** The epoch's genesis is newer than this build: writes are refused. */
  #genesisBlocked = false;
  /** The listing's winner, newer than this device's epoch, can't be opened
   * here (D26), as last decided by a listing that could tell. */
  #damaged: DamagedFile | null = null;
  /** Own log PUTs sent in the last hour, and when one last landed
   * (monotonic ms). */
  #putTimes: number[] = [];
  #lastLanded: number | null = null;
  /** The own log text for the latest own op, built once per content. */
  #logText: { key: string; value: Promise<LogText> } | null = null;
  /** The last own log text built, for a keepalive push on pagehide. */
  #logReady: LogText | null = null;
  /** The own snap text for the current own L, built once and reused by
   * every send of that snapshot. */
  #snapText: { key: string; value: Promise<SnapText | null> } | null = null;
  /** The epoch's genesis state, which every snap is checked against: read
   * once per tab, by its blob sha. */
  #genesis: { name: string; sha: string; state: SyncState } | null = null;
  readonly #compaction: CompactionLimits;
  /** Repo file bounds: for other devices' files, for the own files this
   * device writes, and for its own files read back (ADR-0008). */
  readonly #bounds: { read: FileBounds; write: FileBounds; own: FileBounds };
  /** Entries in `tail`, and whether a local compaction is queued. */
  #tailCount = 0;
  #compactingLocal = false;

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
    this.#compaction = { ...COMPACTION, ...options.compaction };
    const read = options.fileBounds ?? READ_BOUNDS;
    this.#bounds = {
      read,
      write: { bytes: Math.floor(read.bytes / 2), plainBytes: Math.floor(read.plainBytes / 2) },
      own: { bytes: read.bytes * 2, plainBytes: read.plainBytes * 2 },
    };
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
        ownLogK: 0,
        lastSentLogK: 0,
        ownSnapSha: null,
        lastSentSnapSha: null,
        lastSentSnapThrough: 0,
        joined: {},
        seen: vectorOf(state.seen),
        logReach: {},
        snapReach: {},
        lastSeenCommit: null,
        refEtag: null,
        writerToken: "",
      };
      const base = await seal(storedState(state), this.#key);
      await this.#mutate(meta, { base, clearChain: true });
      this.#adopt({ meta: this.#meta!, state: cloneState(state), doc: materialize(state), ownLog: [], chainHead: CHAIN_START, tailCount: 0, leftBehind: new Map(), old: null }, true);
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
    const turn = this.#turn();
    return { ready: turn.ready, commit: (next) => turn.commit(next), end: turn.end };
  }

  /** A write's turn (beginWrite), whose commit may also resolve a group a
   * restore left behind (reapply, discard). */
  #turn(): { ready: Promise<void>; commit: (next: LedgerDocument, resolves?: Resolves) => Promise<void>; end: () => void } {
    const pin = this.#fence.pin();
    const ready = this.#writesSettled;
    let ended!: () => void;
    const end = new Promise<void>((resolve) => (ended = resolve));
    this.#writesSettled = ready.then(() => end);
    return {
      ready,
      commit: (next, resolves) => {
        try {
          return this.#commit(next, pin.asOf, resolves);
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
  amend(run: (doc: LedgerDocument) => void): Promise<void> {
    return this.#amend(run);
  }

  /** amend(), and with `resolves` (read once `run` has run) the op carries
   * the group's marker as `ra` even when `run` changes nothing, and in the
   * op's own transaction the group is dropped from this device or, for an
   * own re-apply, kept as what was applied (section 9.4, D18). */
  async #amend(run: (doc: LedgerDocument) => void, resolves?: () => Resolves): Promise<void> {
    const write = this.#turn();
    try {
      await write.ready;
      const next = structuredClone(this.current());
      run(next);
      await write.commit(next, resolves?.());
    } finally {
      write.end();
    }
  }

  /** `asOf`: the revision on screen when the write was submitted.
   * `resolves`: a left-behind group's marker, carried as the op's `ra`. */
  #commit(next: LedgerDocument, asOf: number, resolves?: Resolves): Promise<void> {
    this.#assertWritable();
    this.#assertNotRestoring();
    // The epoch's genesis is a format this build can't read (section 12):
    // nothing is written until the app is updated.
    if (this.#genesisBlocked) throw new ApiError(503, LEDGER_UPDATED);
    const state = this.#state!;
    const meta = this.#meta!;
    let L: number;
    try {
      L = nextLamport(state.maxL, this.#lastAllocated);
    } catch (err) {
      // No L is left in this epoch: the next epoch makes room, and the
      // write commits there (ADR-0008). `next` was built from current(),
      // which reads the same in the new epoch.
      if (err instanceof LamportExhausted) return this.#renumber().then(() => this.#commit(next, asOf, resolves));
      throw err;
    }
    const body = diffDocuments(state, this.#doc!, next, { L, device: meta.deviceId });
    if (!body && resolves === undefined) return Promise.resolve();
    const fenced = body ? this.#fence.apply(body, state, asOf) : { body: null, notices: [] };
    if (!fenced.body && fenced.notices.length === 0 && resolves === undefined) return Promise.resolve();
    this.#lastAllocated = L;
    // An own re-apply's kept part is marked with the op's L (D27).
    if (resolves?.keep) resolves = { ...resolves, keep: keptAfterReapply(resolves.keep, { L, device: meta.deviceId }) };
    let op: Op | null = null;
    if (fenced.body || resolves !== undefined) {
      const vv = { ...this.#fence.renderedSeen(state.seen, asOf) };
      if (meta.ownMaxL > 0) vv[meta.deviceId] = Math.max(vv[meta.deviceId] ?? 0, meta.ownMaxL);
      op = { L, at: this.#now(), by: this.#actor, vv, set: fenced.body?.set ?? [], del: fenced.body?.del ?? [], ...(resolves !== undefined ? { ra: [resolves.marker] } : {}) };
      const problem = opProblem(op);
      if (problem) throw new Error(`The fenced op is malformed: ${problem}`);
    }
    const writer = { epoch: meta.epochKey, device: meta.deviceId };
    return this.#enqueue(() => this.#commitOp(op, fenced.notices, L, writer, resolves));
  }

  async #commitOp(op: Op | null, notices: FenceNotice[], L: number, writer: { epoch: string; device: string }, resolves?: Resolves): Promise<void> {
    this.#assertWritable();
    // Diffed before a restore took its turn (a direct commit()), but saved
    // after: the restore's cut may not hold it, and the reload after it
    // would lose it.
    this.#assertNotRestoring();
    const meta = this.#meta!;
    // Diffed in another epoch, or under the id a rehome retired: its L and
    // its diff mean nothing here.
    if (meta.epochKey !== writer.epoch || meta.deviceId !== writer.device) throw new ApiError(503, CHANGED_WHILE_SAVING);
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
    // The group this write resolves, and the kept groups it supersedes part
    // of (D27): a kept change whose register this write sets, or whose
    // record it deletes, is this device's newer word on it.
    const groups = new Map<string, LeftBehindGroup | null>();
    if (op) {
      for (const group of this.#leftBehind.values()) {
        if (group.applied === undefined || group.marker === resolves?.marker) continue;
        const next = supersededByOwn(group, op);
        if (next !== group) groups.set(group.marker, next);
      }
    }
    if (resolves !== undefined) groups.set(resolves.marker, resolves.keep);
    if (groups.size > 0) Object.assign(writes, await this.#groupWrites(groups));
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
    this.#applyGroups(groups, writes);
    this.#noticeCount += notices.length;
    // An own group this write put in effect stays stored until a join finds
    // it still in effect (#refreshLeftBehind).
    this.#refreshLeftBehind("others");
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
    return this.#join(delta, bookkeeping, null);
  }

  /** join(), with what the cycle knows of the files the delta came from:
   * the snapshots, by device, and the devices listed (D27). */
  #join(delta: { ops?: [device: string, op: Op][]; state?: SyncState }, bookkeeping: MetaPatch, context: JoinContext | null): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertWritable();
      this.#assertCycleCurrent();
      const source = emptyState();
      if (delta.state) joinInto(source, delta.state);
      for (const [device, op] of delta.ops ?? []) joinInto(source, opState(device, op));
      const text = await seal({ ops: delta.ops ?? [], ...(delta.state ? { state: storedState(delta.state) } : {}) } satisfies Delta, this.#key);
      const meta = this.#meta!;
      const seen = new Map(this.#state!.seen);
      for (const [device, L] of source.seen) if (L > (seen.get(device) ?? 0)) seen.set(device, L);
      // Kept own groups, judged against what this join does, in its own
      // transaction (D27).
      const groups = this.#keptAfterJoin(source, delta.ops ?? [], context);
      const writes: Omit<Mutation, "expect" | "meta"> = { tail: [text], ...(groups.size > 0 ? await this.#groupWrites(groups) : {}) };
      this.#assertWritable();
      this.#assertCycleCurrent();
      await this.#mutate({ ...meta, ...bookkeeping, maxL: Math.max(meta.maxL, source.maxL), seen: vectorOf(seen) }, writes);

      const changes = this.#fence.join(this.#state!, source);
      this.#doc = rematerialize(this.#doc!, readerOf(this.#state!), changes);
      this.#applyGroups(groups, writes);
      // A re-apply marker joined may resolve a group left behind here.
      this.#refreshLeftBehind();
      this.#emit();
    });
  }

  /** The kept own groups (D27) once `source`, from `ops` and the snapshots
   * in `context`, is joined: by marker, each changed group, or null for one
   * to drop. A change whose register (or record) the join hands to another
   * write is superseded when that write had seen the re-apply (an op's vv,
   * or the least `seen` of the snapshots holding it, names the re-apply's
   * L), and set back otherwise. A group with nothing set back is dropped
   * once every other device with a file in the epoch has shown it saw the
   * re-apply: its latest op here, or its snapshot. */
  #keptAfterJoin(source: SyncState, ops: readonly [string, Op][], context: JoinContext | null): Map<string, LeftBehindGroup | null> {
    const out = new Map<string, LeftBehindGroup | null>();
    const kept = [...this.#leftBehind.values()].filter((group) => group.applied !== undefined);
    if (kept.length === 0) return out;
    const before = this.#state!;
    const after = keptAfterJoin(kept, before, source);
    const byTag = new Map<string, Op>();
    const latest = new Map<string, Op>();
    for (const [device, op] of ops) {
      byTag.set(`${op.L}.${device}`, op);
      if ((latest.get(device)?.L ?? 0) < op.L) latest.set(device, op);
    }
    const me = this.#meta!.deviceId;
    for (const group of kept) {
      const { L, device: by } = group.applied!;
      const saw = (seen: number | undefined) => (seen ?? 0) >= L;
      const judge: KeptJudge = {
        register: (key, tag) => {
          // Lamport: a write that had seen the re-apply has a greater L.
          if (tag[0] <= L) return false;
          const op = byTag.get(`${tag[0]}.${tag[1]}`);
          if (op) return saw(op.vv[by]);
          // Through snapshots: what the least-seeing one holding it had seen.
          let least: number | null = null;
          for (const [, snap] of context?.snaps ?? []) {
            const reg = registerAt(snap, key);
            if (reg && compareTags(reg.t, tag) === 0) least = Math.min(least ?? Infinity, snap.seen.get(by) ?? 0);
          }
          return least !== null && least >= L;
        },
        deletion: (deletion) => deletion.L > L && saw(deletion.vv[by]),
      };
      let next = keptAfterChange(group, before, after, judge);
      if (next !== null && (next.setBack?.length ?? 0) === 0) {
        const seenBy = new Set(next.seenBy ?? []);
        for (const [device, op] of latest) if (saw(op.vv[by])) seenBy.add(device);
        for (const [device, snap] of context?.snaps ?? []) if (saw(snap.seen.get(by))) seenBy.add(device);
        const others = context?.listed ? [...context.listed].filter((device) => device !== me && device !== by) : null;
        if (others !== null && others.every((device) => seenBy.has(device))) next = null;
        else if (seenBy.size > (next.seenBy?.length ?? 0)) next = { ...next, seenBy: [...seenBy].sort() };
      }
      if (next !== group) out.set(group.marker, next);
    }
    return out;
  }

  /** The kept own groups after the state is replaced whole, from `before`
   * to `after` (a rehome, D27): a change another write now holds is set
   * back, since nothing says whether that write saw the re-apply. */
  #keptAfterReplace(before: SyncState, after: SyncState): Map<string, LeftBehindGroup | null> {
    const out = new Map<string, LeftBehindGroup | null>();
    for (const group of this.#leftBehind.values()) {
      if (group.applied === undefined) continue;
      const next = keptAfterChange(group, before, after, UNSEEN);
      if (next !== group) out.set(group.marker, next);
    }
    return out;
  }

  /** The records to write for `groups` (marker to group, or null to drop
   * it), with `old` trimmed when a dropped group was the last one an
   * earlier epoch's state was kept for. */
  async #groupWrites(groups: ReadonlyMap<string, LeftBehindGroup | null>): Promise<Pick<Mutation, "leftBehind" | "old">> {
    const put: [string, string][] = [];
    const remove: string[] = [];
    for (const [marker, group] of groups) {
      if (group === null) remove.push(marker);
      else put.push([marker, await seal(group, this.#key)]);
    }
    const writes: Pick<Mutation, "leftBehind" | "old"> = { leftBehind: { put, delete: remove } };
    if (remove.length > 0) {
      const old = await this.#oldKeeping([...this.#leftBehind.keys()].filter((marker) => groups.get(marker) !== null));
      if (old !== undefined) writes.old = old;
    }
    return writes;
  }

  /** `groups`, saved by `writes` (#groupWrites), as the device now holds them. */
  #applyGroups(groups: ReadonlyMap<string, LeftBehindGroup | null>, writes: Pick<Mutation, "old">): void {
    for (const [marker, group] of groups) {
      if (group === null) this.#leftBehind.delete(marker);
      else this.#leftBehind.set(marker, group);
    }
    if (writes.old !== undefined) this.#oldText = writes.old;
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

  /** The ledger is loaded: fold a long saved tail into its base (section
   * 8.4), start listening for triggers, and sync now (the unlock trigger). */
  #begin(): void {
    if (this.#doc !== null && !this.#stopped && this.#tailCount > this.#compaction.tailEntries) this.#compactLocalSoon();
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
    if (!this.#logDue() || !ready || ready.through !== through || ready.K !== meta.K || ready.device !== meta.deviceId) return;
    const write = { path: repoPath(ready.file), text: ready.text, sha: meta.ownLogSha, message: deviceCommitMessage("Sync", ready.device) };
    // Measured as sent: a body the browser would refuse never goes, nor
    // counts against the hourly cap. The next start pushes it instead.
    if (new TextEncoder().encode(putFileBody(write)).length > SYNC_TIMING.keepaliveMaxBytes) return;
    this.#putTimes.push(this.#monotonic());
    this.#remote!.client.putFile({ ...write, keepalive: true }).catch(() => undefined);
  }

  // --- The network half: the cycle ------------------------------------------

  async #cycle(): Promise<void> {
    if (this.#rateLimited()) {
      this.#trouble = true;
      this.#emit();
      return;
    }
    try {
      this.#cycleFor = this.#identity();
      if (await this.#run()) this.#trouble = false;
      else if (this.#blocker === null) this.#trouble = true;
    } catch (err) {
      this.#cycleFailed(err);
    } finally {
      this.#cycleFor = null;
      this.#emit();
    }
  }

  #identity(): { epoch: string; device: string } {
    const meta = this.#meta!;
    return { epoch: meta.epochKey, device: meta.deviceId };
  }

  /** Throws IdentityChanged when the running cycle's epoch or device id is
   * no longer this device's: nothing it read may be joined or recorded. */
  #assertCycleCurrent(): void {
    const at = this.#cycleFor;
    const meta = this.#meta;
    if (at !== null && meta !== null && (at.epoch !== meta.epochKey || at.device !== meta.deviceId)) {
      throw new IdentityChanged(`the device moved from ${at.epoch}/${at.device} while a sync cycle ran`);
    }
  }

  /** One cycle. True if it ended with nothing left to retry. */
  async #run(): Promise<boolean> {
    // A restore whose genesis may still land is settled by a listing, so
    // the head is read and listed even when nothing seems to have changed.
    const settling = this.#restoreUnknown !== null;
    const ref = await this.#head(!settling);
    // The repo answered with this token: whatever stopped the last cycle at
    // the ref is gone. Anything later is found again below.
    this.#blocker = null;
    if (ref.kind === "empty") {
      this.#damaged = null;
      this.#blocker = "missing";
      return false;
    }
    let listedOwn: string | undefined;
    if (ref.kind === "head") {
      const meta = this.#meta!;
      if (ref.commitSha !== meta.lastSeenCommit || settling) {
        const pulled = await this.#pull(await this.#list(ref.commitSha, ref.etag));
        if (pulled === null) return false;
        listedOwn = pulled.listedOwn;
      } else if (ref.etag !== meta.refEtag) {
        await this.#record({ refEtag: ref.etag });
      }
    }
    if (!(await this.#push(listedOwn))) return false;
    return this.#compact();
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
    this.#settleRestore(listing);
    const meta = this.#meta!;
    const epoch = meta.epochKey;
    const winner = winningEpoch([...listing.files.keys()]);
    if (listing.truncated && winner !== epoch) {
      // A cut listing can leave out any genesis, this epoch's included (a
      // device's file sorts before its epoch's genesis), so it can't say
      // there is no ledger, that the repo is older than what this device
      // joined, or which newer epoch wins. Pending: the next poll lists again.
      this.#log("the cut listing doesn't name this device's epoch as the winner; trying again later");
      return null;
    }
    if (winner === null) {
      // No genesis listed: no ledger in this repo (section 9.5).
      this.#damaged = null;
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
      // A restore won (section 9.3): switch to its epoch, then read that
      // epoch's files from this same listing. Nothing more is read from or
      // written to the old epoch.
      if (!(await this.#switchToListed(listing, winner))) return null;
      return this.#pull(listing);
    }
    // This device's epoch wins: nothing newer stands in the way (a damaged
    // genesis that did was deleted, D26).
    this.#damaged = null;

    const genesis = await this.#readGenesis(listing);
    if (genesis === null) return null;
    this.#genesisBlocked = false;

    // The own snap first (section 8.1 step 3): a snapshot that landed while
    // its answer was lost moves K, which the own log's check reads.
    const snap = await this.#ownSnapCheck(listing);
    if (snap.fork !== undefined) {
      this.#log(`this device's own snapshot in the repo is not its history (${snap.fork}); it syncs on as a new device`);
      await this.#rehome(listing);
      return { listedOwn: undefined };
    }
    if (snap.confirm) await this.#confirmSnap(snap.confirm.sha, snap.confirm.through);

    const ownName = repoFileName({ kind: "log", epoch, device: meta.deviceId });
    const listedOwn = listing.files.get(ownName);
    const own = await this.#ownCheck(ownName, listedOwn);
    if (own.fork !== undefined) {
      this.#log(`this device's own log in the repo is not its history (${own.fork}); it syncs on as a new device`);
      await this.#rehome(listing);
      return { listedOwn: undefined };
    }

    const others = await this.#readOthers(listing);
    const patch: MetaPatch = {
      ...own.patch,
      joined: { ...this.#meta!.joined, ...genesis.joined, ...others.joined },
      logReach: vectorOf(others.logReach),
      snapReach: vectorOf(others.snapReach),
    };
    if (others.complete && !listing.truncated) {
      patch.lastSeenCommit = listing.commit;
      patch.refEtag = listing.etag;
    }
    // The genesis and every snapshot read join as one state.
    const states = genesis.state ? [genesis.state, ...others.snaps.map(([, snap]) => snap)] : others.snaps.map(([, snap]) => snap);
    let state: SyncState | undefined;
    if (states.length > 0) {
      state = emptyState();
      for (const part of states) joinInto(state, part);
    }
    // The devices with a file in the epoch, for the kept groups (D27).
    let listed: Set<string> | null = null;
    if (!listing.truncated) {
      listed = new Set();
      for (const { file } of listing.files.values()) if (file.kind !== "genesis" && file.epoch === epoch) listed.add(file.device);
    }
    if (others.ops.length > 0 || state) await this.#join({ ops: others.ops, ...(state ? { state } : {}) }, patch, { snaps: others.snaps, listed });
    else await this.#record(patch);
    return { listedOwn: listedOwn?.sha };
  }

  /** Whether a restore genesis whose PUT got no answer landed, as far as
   * `listing` tells: listed, it is a landed restore (writes stay refused
   * until the reload, as for "restored"); missing from a full listing, it
   * didn't land, and writes go on. A cut listing settles nothing. */
  #settleRestore(listing: Listing): void {
    const epoch = this.#restoreUnknown;
    if (epoch === null) return;
    if (listing.files.has(repoFileName({ kind: "genesis", epoch }))) {
      this.#log(`the restore's genesis ${epoch} landed after all`);
      this.#restoreUnknown = null;
      this.#restore = "written";
      this.#restoreState = { state: "landed", epoch };
    } else if (!listing.truncated) {
      this.#log(`the restore's genesis ${epoch} isn't in the repo; writes go on`);
      this.#restoreUnknown = null;
      this.#restoreState = null;
      // The reload after it has no restore to report (takeRestoredEpoch).
      forgetRestore(epoch);
    }
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
    this.#genesis = { name, sha: listed.sha, state };
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
      return {
        patch: { ownLogSha: listed.sha, ownLogThrough: Math.max(meta.ownLogThrough, meta.lastSentLogThrough), ownLogK: Math.max(meta.ownLogK, meta.lastSentLogK) },
      };
    }
    // Neither: a send whose sha was overwritten by a later send, an older
    // version in a stale listing, or another instance of this device. Read
    // within the own bounds: a size says nothing about whose history it is.
    const read = await this.#read(name, listed, undefined, this.#bounds.own);
    if (!read.ok) return { fork: `it can't be read: ${read.detail}` };
    const file = read.read.file;
    if (file.kind !== "log") return { fork: "it is not a log" };
    const last = file.ops.at(-1)?.L ?? file.snapThrough;
    if (last > meta.ownMaxL) return { fork: `it holds L ${last}, past this device's ${meta.ownMaxL}` };
    if (file.snapThrough > meta.K) return { fork: "it names a snapshot this device never made" };
    const local = last === 0 ? CHAIN_START : await this.#chainAt(last);
    if (local !== file.chain) return { fork: `its chain at L ${last} differs` };
    // This device's own history: confirmed through its last L, unless it is
    // no newer than what was confirmed already (a stale listing). Versions
    // of the own log only ever grow in their last L and their snapThrough:
    // a trim (section 8.1 step 4) keeps the last L and raises snapThrough.
    const newer = last > meta.ownLogThrough || (last === meta.ownLogThrough && file.snapThrough > meta.ownLogK);
    if (meta.ownLogSha !== null && !newer) return { patch: {} };
    return { patch: { ownLogSha: listed.sha, ownLogThrough: last, ownLogK: file.snapThrough } };
  }

  /** This device's chain after its op at `L`, or undefined if it has none. */
  async #chainAt(L: number): Promise<string | undefined> {
    const text = await this.#store.chainEntry(L);
    if (text === undefined) return undefined;
    const value = await this.#open(text);
    return isChainValue(value) ? value : undefined;
  }

  /** Step 4: every other device's log and snapshot in the epoch that this
   * device hasn't joined at its listed sha, read by blob sha (sections 8.2
   * and 8.3; a first start is no different, owner decision D24). A log that
   * can't be read halts its stream (section 12), and so does a snapshot a
   * log needs; a log whose snapshot point is past what this device holds
   * from its device's own listed files waits for that snapshot. Neither is
   * joined in part, and neither sha is recorded, so the next cycle tries
   * again. `complete` says nothing was left out. */
  async #readOthers(listing: Listing): Promise<Streams> {
    const meta = this.#meta!;
    const logs: string[] = [];
    const snaps: string[] = [];
    for (const [name, { file }] of listing.files) {
      if (file.kind === "genesis" || file.epoch !== meta.epochKey || file.device === meta.deviceId) continue;
      if (file.kind === "log") logs.push(name);
      else if (file.kind === "snap") snaps.push(name);
    }
    const streams = await this.#readStreams({
      listing,
      genesis: () => this.#epochGenesis(listing),
      logReach: new Map(Object.entries(meta.logReach)),
      snapReach: new Map(Object.entries(meta.snapReach)),
      held: this.#state,
      joined: meta.joined,
      skip: meta.deviceId,
      logs,
      snaps,
      versions: (name) => {
        const listed = listing.files.get(name);
        return listed ? [listed] : [];
      },
    });
    // What was read belongs to the epoch the cycle started in.
    this.#assertCycleCurrent();
    for (const name of streams.healthy) this.#halted.delete(name);
    for (const [name, halt] of streams.halted) this.#halted.set(name, halt);
    // A halted file that is no longer listed in this epoch halts nothing.
    for (const name of this.#halted.keys()) if (!listing.files.has(name)) this.#halted.delete(name);
    // What was kept for a file version no longer listed is never asked for.
    for (const kept of [this.#unlistedSeen, this.#waitingLogs]) {
      for (const at of kept.keys()) {
        const [name, sha] = at.split("@");
        if (listing.files.get(name)?.sha !== sha) kept.delete(at);
      }
    }
    this.#gapWait = streams.gap;
    return streams;
  }

  /** Reads the epoch's device streams (sections 8.2 and 8.3). First every
   * snapshot in `snaps` not joined at its listed version, needed or not:
   * the first of its versions that can be joined. So every device that has
   * read a listing holds the same snapshot versions, whatever they hold,
   * and devices holding the same files converge (owner decision D24). One
   * that can't be read halts nothing unless a log needs it. Then, for each
   * log, the first of its versions that can be joined. A log whose
   * snapThrough is past what the state holds from its device's own files
   * needs that device's snapshot first, and is never joined across the gap:
   * its snap is read (each version not yet joined, in order) and joined,
   * and if none reaches the log's snapThrough (a stale read) the log waits.
   * A snapshot's coverage claims are never taken for correctness (D24): its
   * `joined` and its `seen` for other devices never mark a file joined, skip
   * a log's ops or close another device's gap, and its `through` closes only
   * its own device's gap, and only while that snapshot version is the
   * listed one or was joined in this read: an overwritten snapshot's word
   * closes no later log's gap. So every log whose version this device hasn't
   * joined is read and its ops joined, and the state is the join of the
   * files read. The only ops left out are those whose join would change
   * nothing in the state already held, looked for only at or below the last
   * L of the version of the same log joined before: an op a later version
   * inserted or changed there is joined, as a cold start joins it. */
  async #readStreams(src: StreamSource): Promise<Streams> {
    const epoch = this.#meta!.epochKey;
    const out: Streams = {
      snaps: [],
      ops: [],
      joined: {},
      logReach: src.logReach,
      snapReach: src.snapReach,
      halted: new Map(),
      healthy: new Set(),
      gap: false,
      complete: true,
    };
    const holds = (name: string, sha: string) => (out.joined[name] ?? src.joined[name]) === sha;
    const logOf = (device: string) => src.logReach.get(device) ?? 0;
    const isListed = (name: string, sha: string) => src.listing.files.get(name)?.sha === sha;
    // Devices with a snapshot version joined in this read: snapReach is then
    // the `through` of what this read joined, not an earlier read's.
    const snapJoinedNow = new Set<string>();
    // What the state holds of a device's ops from its own files. A
    // snapshot's `through` counts only while the version last joined is the
    // listed one, or was joined in this read: once its device lists another,
    // the old version's word (over-claimed, perhaps) closes no gap.
    const snapOf = (device: string) => {
      const snapName = repoFileName({ kind: "snap", epoch, device });
      const sha = out.joined[snapName] ?? src.joined[snapName];
      const current = snapJoinedNow.has(device) || (sha !== undefined && isListed(snapName, sha));
      return current ? (src.snapReach.get(device) ?? 0) : 0;
    };
    const heldOf = (device: string) => Math.max(logOf(device), snapOf(device));
    // The devices with a file in the epoch. A device's ops reach another
    // only through its log, and nothing is ever deleted, so every device an
    // honest snapshot has seen has a file in any listing that holds that
    // snapshot. A cut listing proves no absence.
    const listedDevices = new Set<string>();
    for (const { file } of src.listing.files.values()) if (file.kind !== "genesis" && file.epoch === epoch) listedDevices.add(file.device);

    // A seen entry joined is carried in every later own op's vv and own
    // snapshot. Entries for devices with no file would let one small file
    // make every later own op too large to push. Whether a device has a
    // file depends on the listing, not on the snapshot's bytes, so this
    // refusal is never remembered as final (#refused): it is checked again
    // against every listing, and a device listed later lets every device
    // join the snapshot alike.
    const unlistedIn = (devices: string[]) => (src.listing.truncated ? [] : devices.filter((device) => !listedDevices.has(device)));
    const unlistedRefusal = (count: number) =>
      ({ ok: false, problem: "malformed", detail: `its seen names ${count} devices with no file in the repo` }) satisfies FileRead;

    const joinSnap = async (name: string, listed: Listed): Promise<FileRead> => {
      const at = `${name}@${listed.sha}`;
      const named = this.#unlistedSeen.get(at);
      if (named) {
        const still = unlistedIn(named);
        if (still.length > 0) return unlistedRefusal(still.length);
      }
      const read = await this.#read(name, listed, await src.genesis());
      if (!read.ok) return read;
      const { file, state } = read.read;
      if (!state || file.kind !== "snap") return { ok: false, problem: "malformed", detail: "it is not a snapshot" };
      const unlisted = unlistedIn([...state.seen.keys()].filter((device) => device !== file.device));
      if (unlisted.length > 0) {
        const refused = unlistedRefusal(unlisted.length);
        this.#unlistedSeen.set(at, unlisted);
        this.#log(`${name} can't be joined while the listing stays as it is (malformed): ${refused.detail}`);
        return refused;
      }
      this.#unlistedSeen.delete(at);
      out.snaps.push([file.device, state]);
      // Its own device's ops through `through` (its seen for itself, which
      // the validator holds it to), and nothing about any other device's.
      // Every version joined in this read is in the state, so the greatest
      // of them counts; an earlier read's doesn't. A reach of 0 holds
      // nothing, so it is never stored: a snapshot at through 0 (valid,
      // though no honest device writes one) clears the entry instead.
      const before = snapJoinedNow.has(file.device) ? (src.snapReach.get(file.device) ?? 0) : 0;
      const reach = Math.max(before, file.through);
      if (reach > 0) src.snapReach.set(file.device, reach);
      else src.snapReach.delete(file.device);
      snapJoinedNow.add(file.device);
      out.joined[name] = listed.sha;
      return read;
    };

    // Every snapshot not joined at its listed version, whether a log needs
    // it or not (D24): a device that kept up then holds the same snapshot
    // versions as a cold start, so a value only a snapshot holds reaches
    // both. A refusal here halts nothing; a log that needs it halts below.
    for (const name of src.snaps) {
      for (const version of src.versions(name)) {
        if (holds(name, version.sha)) break;
        if ((await joinSnap(name, version)).ok) break;
      }
    }

    for (const name of src.logs) {
      const file = parseRepoFileName(name);
      if (file?.kind !== "log") continue;
      const device = file.device;
      const snapName = repoFileName({ kind: "snap", epoch, device });
      const versions = src.versions(name);
      let done = false;
      for (const version of versions) {
        const listed = isListed(name, version.sha);
        if (holds(name, version.sha)) {
          if (listed) for (const healthy of [name, snapName]) out.healthy.add(healthy);
          done = true;
          break;
        }
        const at = `${name}@${version.sha}`;
        const read = this.#waitingLogs.get(at) ?? (await this.#read(name, version));
        if (!read.ok || read.read.file.kind !== "log") {
          if (listed) out.halted.set(name, haltOf(read));
          continue;
        }
        const log = read.read.file;
        if (log.snapThrough > heldOf(device)) {
          for (const snap of src.versions(snapName)) {
            if (holds(snapName, snap.sha)) continue;
            const snapRead = await joinSnap(snapName, snap);
            if (!snapRead.ok) {
              if (listed && isListed(snapName, snap.sha)) out.halted.set(snapName, haltOf(snapRead));
              continue;
            }
            if (heldOf(device) >= log.snapThrough) break;
          }
          if (log.snapThrough > heldOf(device)) {
            // Not joined across the gap: a stale snap read waits for the
            // next cycle, and a snap that can't be read halts the stream.
            // The log is kept, so the next poll needn't download it again.
            if (listed && !out.halted.has(snapName)) out.gap = true;
            this.#waitingLogs.set(at, read);
            continue;
          }
        }
        this.#waitingLogs.delete(at);
        if (listed) {
          out.halted.delete(snapName);
          for (const healthy of [name, snapName]) out.healthy.add(healthy);
        }
        // An op at or below what the version joined before gave is left out
        // only when the state already holds it whole: a later version that
        // inserts or changes one there is joined, as a cold start joins it.
        for (const op of log.ops) if (op.L > logOf(device) || src.held === null || !holdsOp(src.held, device, op)) out.ops.push([device, op]);
        const last = log.ops.at(-1)?.L ?? 0;
        if (last > logOf(device)) src.logReach.set(device, last);
        out.joined[name] = version.sha;
        done = true;
        break;
      }
      if (!done || (out.joined[name] ?? src.joined[name]) !== versions[0]?.sha) out.complete = false;
    }
    return out;
  }

  /** Reads and checks the blob a listing names (a snap against `genesis`,
   * its epoch's genesis state), within `bounds`. A refused one is
   * remembered by name and sha (and the bounds it was read within): the
   * sha names its bytes for good, and the name is what they are checked
   * against (with the epoch's genesis, which the name fixes). One listed
   * larger than `bounds` allow is refused without being downloaded. */
  async #read(name: string, listed: Listed, genesis?: SyncState, bounds: FileBounds = this.#bounds.read): Promise<FileRead> {
    const at = bounds === this.#bounds.read ? `${name}@${listed.sha}` : `${name}@${listed.sha}@${bounds.bytes}`;
    const known = this.#refused.get(at);
    if (known) return known;
    const read: FileRead =
      listed.size > bounds.bytes
        ? { ok: false, problem: "malformed", detail: `the file is listed at ${listed.size} bytes, larger than ${bounds.bytes}` }
        : await openRepoFile(listed.file, await this.#remote!.client.readBlob(listed.sha), this.#key, genesis, bounds);
    if (!read.ok) {
      this.#refused.set(at, read);
      this.#log(`${name} can't be joined (${read.problem}): ${read.detail}`);
    }
    return read;
  }

  /** Whether the own log in the repo lacks something: an own op not yet
   * confirmed, or the snapshot point K, which a trim (section 8.1 step 4)
   * still has to publish. */
  #logDue(): boolean {
    const meta = this.#meta!;
    const through = this.#ownLog.at(-1)?.L ?? meta.K;
    return through > meta.ownLogThrough || meta.ownLogK < meta.K;
  }

  /** Step 6: PUTs the own log when it holds an op not yet confirmed, or K
   * changed. False when the cycle should be retried (section 12). */
  async #push(listedOwn: string | undefined): Promise<boolean> {
    if (!this.#logDue()) return true;
    const wait = this.#putWait();
    if (wait > 0) {
      this.#putLater(wait);
      return true;
    }
    let out: LogText;
    try {
      out = await this.#ownLogText();
    } catch (err) {
      if (!(err instanceof OwnLogTooLarge)) throw err;
      // Every reader would refuse it: nothing is sent, and the device
      // still pulls. Local writes go on (section 12: never a 500).
      this.#blocker = "needsAttention";
      return false;
    }
    const landed = () => this.#meta!.ownLogThrough >= out.through && this.#meta!.ownLogK >= out.K;
    // The repo holds these exact bytes: a PUT would only add an empty commit.
    if (out.sha === listedOwn) {
      const m = this.#meta!;
      await this.#record({ ownLogSha: out.sha, ownLogThrough: Math.max(m.ownLogThrough, out.through), ownLogK: Math.max(m.ownLogK, out.K) });
      return true;
    }
    // Saved before it is sent, so a lost response is settled by step 5.
    await this.#record({ lastSentLogSha: out.sha, lastSentLogThrough: out.through, lastSentLogK: out.K });
    const { client } = this.#remote!;
    let base = this.#meta!.ownLogSha;
    for (let put = 1; ; put++) {
      if (!this.#canCycle()) return false;
      this.#putTimes.push(this.#monotonic());
      try {
        const res = await client.putFile({ path: repoPath(out.file), text: out.text, sha: base, message: deviceCommitMessage("Sync", out.device) });
        this.#lastLanded = this.#monotonic();
        const m = this.#meta!;
        const patch: MetaPatch = { ownLogSha: res.sha, ownLogThrough: Math.max(m.ownLogThrough, out.through), ownLogK: Math.max(m.ownLogK, out.K) };
        Object.assign(patch, this.#handled(res.parentSha, res.commitSha));
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
        const listing = await this.#relist();
        if (listing === null) return false;
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
        if (landed()) return true;
        base = listed?.sha ?? this.#meta!.ownLogSha;
      }
    }
  }

  /** The bookkeeping for a PUT that landed as commit `commit` on `parent`:
   * when no other commit came between the head this device handled and
   * this one, this one is handled too. */
  #handled(parent: string | null, commit: string): MetaPatch {
    return parent !== null && parent === this.#meta!.lastSeenCommit ? { lastSeenCommit: commit, refEtag: null } : {};
  }

  /** Steps 1 and 2 again, after a stale-sha refusal (section 12): the
   * listing at the head now, or null when it can't be used here (an empty
   * repo, or another epoch winning), which ends the cycle. */
  async #relist(): Promise<Listing | null> {
    const ref = await this.#head(false);
    if (ref.kind !== "head") {
      if (ref.kind === "empty") this.#blocker = "missing";
      return null;
    }
    const listing = await this.#list(ref.commitSha, ref.etag);
    return winningEpoch([...listing.files.keys()]) === this.#meta!.epochKey ? listing : null;
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
    const K = meta.K;
    const through = ops.at(-1)?.L ?? K;
    const key = `${meta.epochKey}.${meta.deviceId}.${K}.${through}.${chain}`;
    if (this.#logText?.key === key) return this.#logText.value;
    const file: RepoFile = { kind: "log", epoch: meta.epochKey, device: meta.deviceId };
    // A device that switched to this epoch names the id it had before
    // (section 9.3 step 3).
    const prev = meta.prev ? { prev: meta.prev } : {};
    const content = { fv: FORMAT_VERSION, kind: "log", epoch: meta.epochKey, device: meta.deviceId, ...prev, snapThrough: K, chain, ops: [...ops] };
    // Never publish what every other device would refuse.
    const check = checkRepoFile(file, content);
    if (!check.ok) return Promise.reject(new Error(`This device's own log would be refused: ${check.detail}`));
    const bounds = this.#bounds.write;
    const tooLarge = (detail: string) => {
      this.#log(`this device's own log would be refused (${detail}); it is not sent`);
      return new OwnLogTooLarge(`This device's own log would be refused: ${detail}`);
    };
    let entry: { key: string; value: Promise<LogText> } | undefined;
    const value = (async (): Promise<LogText> => {
      const plain = plainSize(content);
      if (plain > bounds.plainBytes) throw tooLarge(`${plain} bytes of JSON, more than ${bounds.plainBytes}`);
      const text = await seal(content, this.#key);
      if (text.length > bounds.bytes) throw tooLarge(`${text.length} bytes, more than ${bounds.bytes}`);
      const built = { text, sha: await gitBlobSha(text), through, K, device: meta.deviceId, file };
      // Only the newest text is kept for pagehide.
      if (this.#logText === entry) this.#logReady = built;
      return built;
    })();
    entry = { key, value };
    this.#logText = entry;
    // A log too large stays refused for this content: it isn't sealed (or
    // logged) again each cycle.
    value.catch((err: unknown) => {
      if (this.#logText === entry && !(err instanceof OwnLogTooLarge)) this.#logText = null;
    });
    return value;
  }

  /** The own log text's length, for the compaction trigger. A confirmed
   * own log can be larger than this build writes (a build with larger
   * bounds sent it), which only makes it due: compaction is the one way
   * to shrink it, and the snapshot is measured on its own. */
  async #ownLogSize(): Promise<number> {
    try {
      return (await this.#ownLogText()).text.length;
    } catch (err) {
      if (err instanceof OwnLogTooLarge) return Infinity;
      throw err;
    }
  }

  // --- The network half: compaction (section 8.1) ---------------------------

  /** Step 7: compaction of the own log, with no agreement between devices.
   * Due once the own log holds COMPACTION.logOps ops or its text reaches
   * COMPACTION.logBytes (counts, never time), and only while the own log is
   * confirmed, so no rollover happens while a PUT is in doubt:
   *   2. PUT the own snap: the device's state at K = its greatest own L.
   *   3. Confirm it landed: a 2xx, the listed sha of the text sent, or a
   *      read-back that is this device's history at K or later.
   *   4. Only then drop own ops at or below K from ownLog (one transaction
   *      with K) and PUT the trimmed log, as step 6 does once spacing allows.
   * "Snapshot first, trim second" keeps invariant S1: the snap and the log
   * together hold every op this device pushed. A crash between leaves both
   * holding some ops, which the join makes harmless. False when the cycle
   * should be retried. */
  async #compact(): Promise<boolean> {
    if (!this.#canCycle() || this.#ownLog.length === 0 || this.#logDue()) return true;
    const limits = this.#compaction;
    if (this.#ownLog.length < limits.logOps && (await this.#ownLogSize()) < limits.logBytes) return true;
    const wait = this.#putWait();
    if (wait > 0) {
      this.#putLater(wait);
      return true;
    }
    const out = await this.#ownSnapText(await this.#epochGenesis());
    // A snapshot every reader would refuse is never published. The log
    // still syncs, only uncompacted; the reason was logged once.
    if (out === null || out.through <= this.#meta!.K) return true;
    // Saved before it is sent, so a lost response is settled by step 5.
    await this.#record({ lastSentSnapSha: out.sha, lastSentSnapThrough: out.through });
    const { client } = this.#remote!;
    let base = this.#meta!.ownSnapSha;
    for (let put = 1; ; put++) {
      if (!this.#canCycle()) return false;
      this.#putTimes.push(this.#monotonic());
      try {
        const res = await client.putFile({ path: repoPath(out.file), text: out.text, sha: base, message: deviceCommitMessage("Snapshot", out.device) });
        this.#lastLanded = this.#monotonic();
        await this.#confirmSnap(res.sha, out.through, this.#handled(res.parentSha, res.commitSha));
        return this.#push(undefined);
      } catch (err) {
        if (!(err instanceof ShaConflictError)) throw err;
        if (put >= MAX_PUTS) {
          this.#log(`the repo refused ${MAX_PUTS} writes of this device's snapshot in a row; trying again on the next trigger`);
          return false;
        }
        await this.#sleep(SYNC_TIMING.retryMs[put - 1] + Math.floor(this.#random() * SYNC_TIMING.jitterMs));
        if (!this.#canCycle()) return false;
        if (err.reason === "branch-race") continue;
        const listing = await this.#relist();
        if (listing === null) return false;
        const check = await this.#ownSnapCheck(listing);
        if (check.fork !== undefined) {
          this.#log(`this device's own snapshot in the repo is not its history (${check.fork}); it syncs on as a new device`);
          await this.#rehome(listing);
          this.#again = true;
          return true;
        }
        if (check.confirm) await this.#confirmSnap(check.confirm.sha, check.confirm.through);
        // It landed after all (a lost or late response).
        if (this.#meta!.K >= out.through) return this.#push(undefined);
        base = listing.files.get(repoFileName(out.file))?.sha ?? this.#meta!.ownSnapSha;
      }
    }
  }

  /** What the listed own snap says (section 8.1 step 3). The sha this
   * device knows, or none listed: nothing new. The sha it last sent: that
   * send landed. Anything else is read: a snapshot of this device's own
   * history (its chain at `through` matches) at K or later is confirmed, an
   * older one is a stale listing, and anything else is a fork (section
   * 10.3), as for the own log. */
  async #ownSnapCheck(listing: Listing): Promise<SnapCheck> {
    const meta = this.#meta!;
    const name = repoFileName({ kind: "snap", epoch: meta.epochKey, device: meta.deviceId });
    const listed = listing.files.get(name);
    if (!listed || listed.sha === meta.ownSnapSha) return {};
    if (listed.sha === meta.lastSentSnapSha) return { confirm: { sha: listed.sha, through: meta.lastSentSnapThrough } };
    const read = await this.#read(name, listed, await this.#epochGenesis(listing), this.#bounds.own);
    if (!read.ok) return { fork: `it can't be read: ${read.detail}` };
    const file = read.read.file;
    if (file.kind !== "snap") return { fork: "it is not a snapshot" };
    if (file.through > meta.ownMaxL) return { fork: `it holds L ${file.through}, past this device's ${meta.ownMaxL}` };
    const local = file.through === 0 ? CHAIN_START : await this.#chainAt(file.through);
    if (local !== file.chain) return { fork: `its chain at L ${file.through} differs` };
    if (file.through < meta.K) return {};
    return { confirm: { sha: listed.sha, through: file.through } };
  }

  /** The own snap at `sha`, through `through`, is in the repo: in one
   * transaction K becomes `through` and own ops at or below it leave
   * ownLog (section 8.1 step 4). The trimmed log goes out with the next
   * push, which K now makes due. */
  #confirmSnap(sha: string, through: number, patch: MetaPatch = {}): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertWritable();
      this.#assertCycleCurrent();
      const meta = this.#meta!;
      // An older snapshot than the one confirmed is never taken for it.
      if (through < meta.K) return;
      const K = through;
      await this.#mutate({ ...meta, ...patch, ownSnapSha: sha, K }, { ownLog: { dropThrough: K } });
      this.#ownLog = this.#ownLog.filter((op) => op.L > K);
      this.#emit();
    });
  }

  /** The own snap file (section 6) as text: the state, seen, maxL and chain
   * as of the device's greatest own L, taken between two mutations, with
   * the file versions that state holds. Built once per snapshot point and
   * reused, so every send of one snapshot is the same bytes. Checked with
   * every reader's validator, against the epoch's genesis, and against the
   * write bounds before it is published: null, remembered for that
   * snapshot point, when it would be refused. Null, not remembered, when an
   * own op is not yet in the confirmed log. */
  async #ownSnapText(genesis: SyncState): Promise<SnapText | null> {
    const view = await this.#enqueue(async () => {
      this.#assertWritable();
      this.#assertCycleCurrent();
      const meta = this.#meta!;
      // An own op committed since the trigger check (while the log text or
      // the genesis was read, or queued ahead of this view) is in no
      // published log. A snapshot holding it would reach only devices that
      // start from it, never those that joined the log, if the trim never
      // lands. So it waits: the push sends that op, and the next cycle
      // compacts. A snapshot never holds an own op its log doesn't.
      if (meta.ownMaxL !== meta.ownLogThrough || meta.ownLogK !== meta.K) return null;
      return { meta, state: cloneState(this.#state!), chain: this.#chainHead };
    });
    if (view === null) return null;
    const { meta, state, chain } = view;
    const through = meta.ownMaxL;
    const key = `${meta.epochKey}.${meta.deviceId}.${through}.${chain}`;
    if (this.#snapText?.key === key) return this.#snapText.value;
    const file: RepoFile = { kind: "snap", epoch: meta.epochKey, device: meta.deviceId };
    const joined: Record<string, string> = {};
    for (const [name, sha] of Object.entries(meta.joined)) if (parseRepoFileName(name)?.epoch === meta.epochKey) joined[name] = sha;
    // The confirmed own log holds own ops up to ownLogThrough, all in state.
    if (meta.ownLogSha !== null) joined[repoFileName({ kind: "log", epoch: meta.epochKey, device: meta.deviceId })] = meta.ownLogSha;
    const content = {
      fv: FORMAT_VERSION,
      kind: "snap",
      epoch: meta.epochKey,
      device: meta.deviceId,
      through,
      chain,
      seen: vectorOf(state.seen),
      maxL: state.maxL,
      joined,
      state: encodeState(state),
    };
    let entry: { key: string; value: Promise<SnapText | null> } | undefined;
    const value = (async (): Promise<SnapText | null> => {
      // Never publish what every other device would refuse: invalid, or
      // past the bounds this device writes within.
      const refused = (detail: string) => {
        this.#log(`this device's snapshot would be refused (${detail}); its log is not compacted`);
        return null;
      };
      const check = checkRepoFile(file, content, genesis);
      if (!check.ok) return refused(check.detail);
      const bounds = this.#bounds.write;
      const plain = plainSize(content);
      if (plain > bounds.plainBytes) return refused(`${plain} bytes of JSON, more than ${bounds.plainBytes}`);
      const text = await seal(content, this.#key);
      if (text.length > bounds.bytes) return refused(`${text.length} bytes, more than ${bounds.bytes}`);
      return { text, sha: await gitBlobSha(text), through, device: meta.deviceId, file };
    })();
    entry = { key, value };
    this.#snapText = entry;
    value.catch(() => {
      if (this.#snapText === entry) this.#snapText = null;
    });
    return value;
  }

  /** The epoch's genesis state, which every snap is checked against: the
   * one the cycle read, or else read once by its blob sha (listed, or the
   * one this device joined). Throws when it can't be read, which ends the
   * cycle as `pending`: the cycle already refused a genesis that can't be
   * joined, so this is a failed read. */
  async #epochGenesis(listing?: Listing): Promise<SyncState> {
    const meta = this.#meta!;
    const name = repoFileName({ kind: "genesis", epoch: meta.epochKey });
    const listed = listing?.files.get(name);
    const sha = listed?.sha ?? meta.joined[name];
    if (this.#genesis?.name === name && (sha === undefined || this.#genesis.sha === sha)) return this.#genesis.state;
    if (sha === undefined) throw new Error("This device hasn't joined its epoch's genesis");
    const read = await this.#read(name, listed ?? { file: { kind: "genesis", epoch: meta.epochKey }, sha, size: 0 });
    if (!read.ok || read.read.file.kind !== "genesis") throw new Error(`The epoch's genesis can't be read${read.ok ? "" : `: ${read.detail}`}`);
    const state = genesisState(read.read.file.doc);
    this.#genesis = { name, sha, state };
    return state;
  }

  /** Saves sync bookkeeping in meta alone, in one transaction. */
  #record(patch: MetaPatch): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertWritable();
      this.#assertCycleCurrent();
      const meta = this.#meta!;
      if ((Object.keys(patch) as (keyof MetaPatch)[]).every((key) => canonicalJson(patch[key]) === canonicalJson(meta[key]))) return;
      await this.#mutate({ ...meta, ...patch }, {});
      this.#emit();
    });
  }

  /** What a failed cycle means (section 12). Nothing is lost either way:
   * every own op stays in ownLog until the repo is known to hold it. */
  #cycleFailed(err: unknown): void {
    if (err instanceof IdentityChanged) {
      // Nothing of it was joined or recorded: run again, as the device is now.
      this.#again = true;
    } else if (err instanceof GitHubAuthError || err instanceof GitHubForbiddenError) {
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
    const { epochKey, deviceId } = this.#meta!;
    const turn = this.beginWrite();
    try {
      await turn.ready;
      this.#assertWritable();
      // The device switched epochs (or rehomed) while this waited: the fork
      // was found in a history it no longer writes.
      if (this.#meta!.epochKey !== epochKey || this.#meta!.deviceId !== deviceId) return;
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
          ownLogK: 0,
          lastSentLogK: 0,
          ownSnapSha: null,
          lastSentSnapSha: null,
          lastSentSnapThrough: 0,
          joined: rebuilt.joined,
          seen: vectorOf(next.seen),
          logReach: rebuilt.logReach,
          snapReach: rebuilt.snapReach,
          lastSeenCommit: rebuilt.complete ? listing.commit : null,
          refEtag: rebuilt.complete ? listing.etag : null,
        };
        const doc = materialize(next);
        const notice = await seal({ kind: "rehome", from: meta.deviceId, to: device, at, message: REHOMED }, this.#key);
        const base = await seal(storedState(next), this.#key);
        const groups = this.#keptAfterReplace(pre, next);
        const groupWrites = groups.size > 0 ? await this.#groupWrites(groups) : {};
        this.#assertWritable();
        await this.#mutate(nextMeta, {
          base,
          clearTail: true,
          ownLog: { dropThrough: Number.MAX_SAFE_INTEGER, put: ownLog },
          clearChain: true,
          chain: chainEntries,
          notices: { put: [[`rehome/${device}`, notice]] },
          ...groupWrites,
        });
        this.#applyGroups(groups, groupWrites);
        const before = this.#doc!;
        this.#fence.replace(pre, next, canonicalJson({ ...before, tombstones: [] }) !== canonicalJson({ ...doc, tombstones: [] }));
        this.#state = next;
        this.#doc = doc;
        this.#ownLog = ops;
        this.#chainHead = chain;
        // The streams as the cold join found them. The head it handled may
        // be recorded as handled, and then #readOthers, which settles these
        // otherwise, doesn't run again until another device commits.
        this.#halted.clear();
        for (const [name, problem] of rebuilt.halted) this.#halted.set(name, problem);
        this.#gapWait = rebuilt.gap;
        this.#noticeCount++;
        // The cycle that found the fork syncs on under the new id.
        if (this.#cycleFor !== null) this.#cycleFor = this.#identity();
        this.#refreshLeftBehind();
        this.#emit();
      });
    } finally {
      turn.end();
    }
  }

  /** The epoch rebuilt from its files (section 8.3): the genesis, every
   * snapshot, then every log (section 8.2), none skipped on another file's
   * word (D24). A version that can't be joined
   * now is replaced by the one this device joined before, which still reads
   * by its sha, so nothing this device had from another device is dropped.
   * A listed file that wasn't joined is reported as #readOthers would find
   * it: halted, with what halted it, or waiting for its snapshot. */
  async #coldJoin(listing: Listing): Promise<ColdJoin> {
    const meta = this.#meta!;
    const epoch = meta.epochKey;
    const versions = new Map<string, Listed[]>();
    for (const [name, listed] of listing.files) if (listed.file.epoch === epoch) versions.set(name, [listed]);
    for (const [name, sha] of Object.entries(meta.joined)) {
      const file = parseRepoFileName(name);
      if (!file || file.epoch !== epoch) continue;
      const list = versions.get(name) ?? [];
      if (!list.some((v) => v.sha === sha)) versions.set(name, [...list, { file, sha, size: 0 }]);
    }
    const genesisName = repoFileName({ kind: "genesis", epoch });
    let genesis: { sha: string; state: SyncState } | null = null;
    for (const listed of versions.get(genesisName) ?? []) {
      const read = await this.#read(genesisName, listed);
      if (!read.ok || read.read.file.kind !== "genesis") continue;
      genesis = { sha: listed.sha, state: genesisState(read.read.file.doc) };
      break;
    }
    if (genesis === null) throw new Error("The epoch's genesis can't be read, so this device can't rebuild its state");
    this.#genesis = { name: genesisName, ...genesis };
    const state = cloneState(genesis.state);
    const logs = [...versions.keys()].filter((name) => parseRepoFileName(name)?.kind === "log");
    const streams = await this.#readStreams({
      listing,
      genesis: async () => genesis.state,
      logReach: new Map(),
      snapReach: new Map(),
      held: null,
      joined: {},
      skip: null,
      logs,
      snaps: [...versions.keys()].filter((name) => parseRepoFileName(name)?.kind === "snap"),
      versions: (name) => versions.get(name) ?? [],
    });
    for (const [, part] of streams.snaps) joinInto(state, part);
    for (const [device, op] of streams.ops) applyOp(state, device, op);
    return {
      state,
      joined: { [genesisName]: genesis.sha, ...streams.joined },
      logReach: vectorOf(streams.logReach),
      snapReach: vectorOf(streams.snapReach),
      complete: !listing.truncated && streams.complete,
      halted: streams.halted,
      gap: streams.gap,
    };
  }

  // --- Epochs (section 9) ------------------------------------------------------

  /** The epoch this device syncs in, or null before a first start. After a
   * restore's reload, compare it with takeRestoredEpoch() (ledgerRepo.ts):
   * a greater one means another restore replaced this device's. */
  get epochKey(): string | null {
    return this.#meta?.epochKey ?? null;
  }

  /** Restore (#9, section 9.2): writes `doc`, a backup, as the genesis of
   * the epoch after the winning one, based on what this device has seen.
   * It runs one sync cycle first; if own changes are still not in the
   * repo, or own changes an earlier restore left behind are still shown, it
   * writes nothing and says how many, unless `discardUnsynced`.
   * It takes a write turn, so no write is saved while it runs. On
   * "restored" or "replaced" the caller clears this device's sync state
   * (clearSyncState) and reloads, and the device starts in the winning
   * epoch as a new device; the epoch written is remembered for the reload
   * (rememberRestore). From the turn on, own writes are refused, and once
   * the genesis has landed they stay refused, so nothing is saved into the
   * state the reload clears. On "unknown" (a genesis PUT got no answer) they
   * stay refused until a listing settles whether it landed. Throws for a
   * token, repo or rate-limit answer before any genesis PUT may have
   * landed; once one may have, it never throws. */
  async restore(doc: LedgerDocument, { discardUnsynced = false }: { discardUnsynced?: boolean } = {}): Promise<RestoreResult> {
    if (!isWritableDocument(doc)) return { kind: "invalid" };
    const remote = this.#remote;
    if (remote === null) throw new Error("This device has no repo to restore into");
    this.#assertWritable();
    await this.sync();
    const turn = this.#turn();
    try {
      await turn.ready;
      this.#assertWritable();
      this.#assertNotRestoring();
      this.#restore = "writing";
      const pendingCount = this.#pendingCount();
      const leftBehindOwnCount = this.#leftBehindOwnCount;
      if ((pendingCount > 0 || leftBehindOwnCount > 0) && !discardUnsynced) return { kind: "unsynced", pendingCount, leftBehindOwnCount };
      const written = await this.#writeRestore(structuredClone(doc));
      if (written.kind === "unknown") {
        this.#log(`the restore's genesis got no answer (${written.detail}); it may still land`);
        this.#restoreUnknown = written.epoch;
        this.#restoreState = { state: "pending", epoch: written.epoch };
        this.#emit();
        rememberRestore(written.epoch);
        return { kind: "unknown", epoch: written.epoch };
      }
      if (written.kind !== "written") return written;
      this.#restore = "written";
      const epoch = written.genesis.epoch;
      this.#restoreState = { state: "landed", epoch };
      this.#emit();
      rememberRestore(epoch);
      // Step 6: a restore that raced this one may have won. The genesis has
      // landed whatever this read says, so a failed read is no failure.
      let now: EpochNow;
      try {
        now = await winningEpochNow(remote);
      } catch (err) {
        this.#log("the repo couldn't be listed after the restore landed; the reload finds the winner", err);
        return { kind: "restored", epoch, winnerUnknown: true };
      }
      if (now.winner !== null && compareEpochKeys(now.winner, epoch) > 0) return { kind: "replaced", epoch, winner: now.winner, ...(await this.#madeBy(now.winner, now.sha!)) };
      // A cut listing may leave out a greater epoch (ADR-0008).
      if (now.truncated) {
        this.#log("GitHub cut the listing after the restore landed; the reload finds the winner");
        return { kind: "restored", epoch, winnerUnknown: true };
      }
      return { kind: "restored", epoch };
    } finally {
      if (this.#restore === "writing") this.#restore = null;
      turn.end();
    }
  }

  /** Who made epoch `epoch`'s genesis (blob `sha`) and when, for "Sam's
   * restore replaced yours"; nothing when it can't be read. Never throws:
   * display only, and asked once the restore has landed. */
  async #madeBy(epoch: string, sha: string): Promise<{ reason?: GenesisContent["reason"]; by?: string; at?: number }> {
    try {
      const read = await this.#read(repoFileName({ kind: "genesis", epoch }), { file: { kind: "genesis", epoch }, sha, size: 0 });
      if (!read.ok || read.read.file.kind !== "genesis") return {};
      const { reason, by, at } = read.read.file;
      return { reason, by, at };
    } catch (err) {
      this.#log("the winning restore's genesis couldn't be read", err);
      return {};
    }
  }

  /** Export (#9, section 9.5): the current document, sealed with the
   * household key in the repo files' format, the same as a genesis's
   * `doc`, so an export restores as it is (readBackup, restore). */
  exportBackup(): Promise<string> {
    try {
      return seal(structuredClone(this.current()), this.#key);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** The groups of changes restores left behind that are still to review
   * (section 9.3): this device's own first, shown prominently, then other
   * devices', for a collapsed list (owner decision D18). */
  leftBehind(): LeftBehindView[] {
    const state = this.#state;
    if (state === null) return [];
    return [...this.#leftBehind.values()]
      .filter((group) => !this.#isHidden(group, state))
      .sort((a, b) => Number(b.own) - Number(a.own) || compareEpochKeys(a.epoch, b.epoch) || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0))
      .map((group) => ({
        id: group.marker,
        epoch: group.epoch,
        device: group.device,
        own: group.own,
        who: group.who,
        into: group.into,
        resolvedElsewhere: state.ra.has(group.marker),
        items: leftBehindItems(group),
      }));
  }

  /** What reapply(id) would apply and skip now, without writing anything. */
  previewReapply(id: string): ReapplyResult {
    return reapplyTo(structuredClone(this.current()), this.#state!, this.#shownGroup(id), { at: this.#now(), by: this.#actor });
  }

  /** Re-apply (section 9.4): one write, at its turn, that puts the group's
   * changes back on the current document and carries its marker, which
   * resolves the group on every device. What can't be applied is skipped
   * and listed. This device's own group is kept as what was applied, with
   * the op's L, and hidden (owner decision D27): a write that hadn't seen
   * the re-apply (another device's re-apply from an older view) and sets
   * some of it back makes it show again (D18), while a later write that had
   * seen it, this device's own included, supersedes what it changes. It is
   * dropped once nothing is left, once every other device with a file in
   * the epoch has shown it saw the re-apply, or at the next switch. */
  async reapply(id: string): Promise<ReapplyResult> {
    let result = undefined as ReapplyResult | undefined;
    let group = undefined as LeftBehindGroup | undefined;
    await this.#amend(
      (doc) => {
        group = this.#shownGroup(id);
        result = reapplyTo(doc, this.#state!, group, { at: this.#now(), by: this.#actor });
      },
      () => ({ marker: id, keep: group!.own ? appliedPart(group!, result!.applied) : null }),
    );
    return result!;
  }

  /** Discard (section 9.4): an op with only the group's marker. */
  discard(id: string): Promise<void> {
    return this.#amend(
      () => void this.#shownGroup(id),
      () => ({ marker: id, keep: null }),
    );
  }

  /** The group `id` while it is shown; a 404 once it is resolved (gone, or
   * stored but hidden). */
  #shownGroup(id: string): LeftBehindGroup {
    const group = this.#leftBehind.get(id);
    if (!group || this.#isHidden(group, this.#state!)) throw new ApiError(404, ALREADY_RESOLVED);
    return group;
  }

  /** Section 9.2 steps 3 to 5: the genesis of the epoch after this device's
   * own, holding `doc`, based on what this device has seen with every own
   * op, written once. Nothing is written when a fresh listing's winner is
   * newer than this device's epoch: a restore based on an epoch another
   * restore already replaced would leave out, on every device, what the
   * winner holds and this device never joined (a device that resolved its
   * groups no longer offers it), so the device switches first, on its next
   * cycle, and the restore is tried again from there. Nor when this build
   * is too old to read it: updating the app is the fix. Nor when this
   * device can't open it (owner decision D26): the app never writes such a
   * genesis, and nothing is written past it; the result names the file,
   * whose deletion on GitHub lets sync and the restore go on. */
  async #writeRestore(doc: LedgerDocument): Promise<RestoreWrite> {
    const remote = this.#remote!;
    const meta = this.#meta!;
    const seen: VersionVector = { ...vectorOf(this.#state!.seen), [meta.deviceId]: meta.ownMaxL };
    const basedOn = { epoch: meta.epochKey, seen };
    const now = await winningEpochNow(remote);
    // A cut listing decides nothing (ADR-0008), unless it shows this
    // device's own epoch winning: the restore is then numbered from that
    // epoch, as a cycle on the same listing would go on syncing in it, and a
    // greater epoch the cut left out is a race step 6 reports.
    if (now.truncated && now.winner !== meta.epochKey) {
      return { kind: "failed", detail: "GitHub cut the file listing short, so the winning epoch is unknown; try again later" };
    }
    const listed = now.winner;
    if (listed !== null && compareEpochKeys(listed, meta.epochKey) > 0) {
      const damaged = await this.#damagedWinner(listed, now.sha!, now.size!);
      if (damaged !== null) return { kind: "failed", detail: damagedFileMessage(damaged), damagedFile: damaged };
      return { kind: "failed", detail: `another restore (${listed}) replaced this device's epoch; it switches on its next sync, and the restore can be tried again then` };
    }
    const epoch = nextEpochKey(meta.epochKey);
    const content: GenesisContent = { epoch, reason: "restore", by: this.#actor, at: this.#now(), basedOn, doc };
    // Every PUT sent counts against the hourly cap, a second one after no
    // answer included (ADR-0008 stage 4).
    const written = await writeGenesis(remote, content, this.#key, this.#bounds.write, () => this.#putTimes.push(this.#monotonic()));
    if (written.kind === "unknown") return { kind: "unknown", epoch, detail: written.detail };
    if (written.kind !== "written") return written;
    return { kind: "written", genesis: { epoch, sha: written.sha, state: genesisState(doc), basedOn, by: content.by, at: content.at } };
  }

  /** Epoch `epoch`'s genesis, listed at blob `sha`, as a damaged file when
   * this device can't open it (D26), else null: it opens, it is too new for
   * this build, or it couldn't be read now. A refusal is remembered by name
   * and sha (#read), so the cycle's read is not repeated. */
  async #damagedWinner(epoch: string, sha: string, size: number): Promise<DamagedFile | null> {
    try {
      const read = await this.#read(repoFileName({ kind: "genesis", epoch }), { file: { kind: "genesis", epoch }, sha, size });
      if (read.ok) return read.read.file.kind === "genesis" ? null : damagedGenesis(epoch, "malformed");
      return read.problem === "needsUpdate" ? null : damagedGenesis(epoch, read.problem);
    } catch (err) {
      this.#log(`the winning genesis ${epoch} couldn't be read`, err);
      return null;
    }
  }

  /** No Lamport value is left in this epoch (a file's L near 2^50): the
   * device restores its current document as the next epoch, based on
   * everything it has seen, and switches to it in place, as every other
   * device then does (ADR-0008). Its own groups left behind are empty: the
   * cut holds all it has. Needs the repo; without it the write is refused
   * with NEEDS_NEW_EPOCH, and the next one tries again. While a newer
   * genesis this device can't open is listed, no epoch is written past it
   * (owner decision D26): the write is refused with a message naming the
   * file, and goes through once it is deleted. */
  #renumber(): Promise<void> {
    this.#renumbering ??= (async () => {
      try {
        if (this.#remote === null) throw new ApiError(503, NEEDS_NEW_EPOCH);
        const from = this.#meta!.epochKey;
        this.#log("no Lamport value is left in this epoch; the ledger is restored as the next one");
        let written: RestoreWrite;
        try {
          written = await this.#writeRestore(structuredClone(this.#doc!));
        } catch (err) {
          this.#log("writing the next epoch failed", err);
          throw new ApiError(503, NEEDS_NEW_EPOCH);
        }
        // Not written, or no answer: if that genesis lands after all, the
        // next try finds it listed and the device switches to it first.
        if (written.kind !== "written") {
          this.#log(`writing the next epoch failed: ${written.detail}`);
          // No epoch is written past a genesis this device can't open
          // (D26): the write waits until the file is deleted.
          if (written.kind === "failed" && written.damagedFile) throw new ApiError(503, needsNewEpochPast(written.damagedFile));
          throw new ApiError(503, NEEDS_NEW_EPOCH);
        }
        if (!(await this.#switchEpoch(from, written.genesis))) throw new ApiError(503, CHANGED_WHILE_SAVING);
      } finally {
        this.#renumbering = null;
      }
    })();
    return this.#renumbering;
  }

  /** Section 9.3 step 1: reads the winning epoch's genesis from `listing`
   * and, at a write turn of its own, switches to it. A genesis that can't
   * be read keeps the device where it is, writing nothing more there:
   * needsUpdate for a newer format, needsPassphrase for a key that doesn't
   * fit, needsAttention for anything else (section 9.1). In the last two
   * cases the app never wrote it (owner decision D26): the device names it
   * (`damagedFile`) and stays stopped, its local writes kept, until the
   * file is deleted on GitHub and a listing no longer counts it. */
  async #switchToListed(listing: Listing, winner: string): Promise<boolean> {
    const name = repoFileName({ kind: "genesis", epoch: winner });
    const listed = listing.files.get(name)!;
    const read = await this.#read(name, listed);
    if (!read.ok || read.read.file.kind !== "genesis") {
      const problem = read.ok ? "malformed" : read.problem;
      this.#blocker = problem === "needsUpdate" ? "needsUpdate" : problem === "malformed" ? "needsAttention" : "needsPassphrase";
      const damaged = problem === "needsUpdate" ? null : damagedGenesis(winner, problem);
      // The same object while nothing changes, so no listener is told again.
      if (damaged === null || this.#damaged?.path !== damaged.path || this.#damaged.reason !== damaged.reason) this.#damaged = damaged;
      this.#log(`a restore's epoch ${winner} can't be read (${problem}); this device stays where it is and sends nothing more`);
      return false;
    }
    this.#damaged = null;
    const file = read.read.file;
    const from = this.#meta!.epochKey;
    const turn = this.#turn();
    try {
      await turn.ready;
      this.#assertWritable();
      const switched = await this.#switchEpoch(from, { epoch: winner, sha: listed.sha, state: genesisState(file.doc), basedOn: file.basedOn, by: file.by, at: file.at });
      // The cycle reads and records for the epoch it switched to.
      if (switched && this.#cycleFor !== null) this.#cycleFor = this.#identity();
      return switched;
    } finally {
      turn.end();
    }
  }

  /** Switches from epoch `from` to `genesis`'s, in the mutation queue;
   * false when the device is no longer on `from` (another switch got there
   * first). The caller holds a write turn, so no write is diffed across it. */
  #switchEpoch(from: string, genesis: NewEpoch): Promise<boolean> {
    return this.#enqueue(() => this.#adoptEpoch(from, genesis));
  }

  /** Section 9.3 steps 2 and 3. The old-epoch state, which holds every own
   * op, pushed or not, is projected above the restore's cut (its basedOn
   * when based on this epoch, else nothing) into groups left behind. In one
   * transaction the old state moves into `old`, the groups into
   * `leftBehind`, and the new epoch starts from its genesis under a new
   * device id, its first log naming the old one as `prev`. Two racing
   * restores: a device that switched to the losing one switches again, its
   * writes there all left behind (cut {}); the epoch both were based on is
   * projected again with the winner's cut, from the state kept in `old`,
   * leaving out other devices' groups resolved meanwhile. This device's own
   * group there is kept (D18): its marker joined in the losing epoch says
   * only that the group was resolved in an epoch that lost, and what was in
   * effect there (the losing genesis included) is not in the winner. */
  async #adoptEpoch(from: string, genesis: NewEpoch): Promise<boolean> {
    this.#assertWritable();
    const meta = this.#meta!;
    if (meta.epochKey !== from) return false;
    const pre = this.#state!;
    const into = { epoch: genesis.epoch, by: genesis.by, at: genesis.at, state: genesis.state };
    const basedOn = genesis.basedOn;
    const cutFor = (epoch: string): VersionVector | null => (basedOn !== null && basedOn.epoch === epoch ? basedOn.seen : null);
    // Groups shown now are carried, less what the new genesis already holds
    // (the projection's rule): a marker joined here never reaches the new
    // epoch, so nothing else would hide one the genesis took in. A group this
    // device re-applied is dropped while hidden, and carried as an ordinary
    // own group once set back: the re-apply's L means nothing there (D27).
    const groups = new Map<string, LeftBehindGroup>();
    for (const [marker, group] of this.#leftBehind) {
      const carried = this.#isHidden(group, pre) ? null : withoutHeld(unkept(group), genesis.state);
      if (carried !== null) groups.set(marker, carried);
    }
    const kept = await this.#readOld();
    for (const entry of kept) {
      const cut = cutFor(entry.epoch);
      if (cut === null || entry.epoch === from) continue;
      // The winner's cut decides what of this epoch is left behind. Another
      // device's group the losing epoch resolved stays resolved. This
      // device's own group never is on that word alone: only this device
      // holds its unpushed changes, and a group shown now stays unless the
      // projection replaces it under its marker.
      const projected = leftBehind(entry.state, cut, into, { epoch: entry.epoch, me: entry.device }).filter((group) => group.own || !pre.ra.has(group.marker));
      const replaced = new Set(projected.map((group) => group.marker));
      for (const [marker, group] of [...groups]) if (marker.startsWith(`${entry.epoch}/`) && !(group.own && !replaced.has(marker))) groups.delete(marker);
      for (const group of projected) groups.set(group.marker, group);
    }
    for (const group of leftBehind(pre, cutFor(from) ?? {}, into, { epoch: from, me: meta.deviceId })) groups.set(group.marker, group);
    // The epoch switched from is kept even with no group: a restore that
    // raced this one, based on it with another cut, may leave something of
    // it behind. So is the epoch this one is based on, for a restore of the
    // same number based on it with another cut (E1 -> E2a -> E2b -> E2c,
    // all based on E1). An earlier one is kept only while a group from it is.
    const hasGroups = (epoch: string) => [...groups.keys()].some((marker) => marker.startsWith(`${epoch}/`));
    const keep = (epoch: string) => epoch !== from && (epoch === basedOn?.epoch || hasGroups(epoch));
    const olds: OldEpoch[] = [...kept.filter((entry) => keep(entry.epoch)), { epoch: from, device: meta.deviceId, state: pre }];

    const device = newDeviceId();
    const next = cloneState(genesis.state);
    const genesisName = repoFileName({ kind: "genesis", epoch: genesis.epoch });
    const nextMeta: SyncMeta = {
      formatVersion: LOCAL_FORMAT_VERSION,
      deviceId: device,
      epochKey: genesis.epoch,
      maxL: next.maxL,
      ownMaxL: 0,
      K: 0,
      ownLogSha: null,
      ownLogThrough: 0,
      lastSentLogSha: null,
      lastSentLogThrough: 0,
      ownLogK: 0,
      lastSentLogK: 0,
      ownSnapSha: null,
      lastSentSnapSha: null,
      lastSentSnapThrough: 0,
      joined: { [genesisName]: genesis.sha },
      seen: vectorOf(next.seen),
      logReach: {},
      snapReach: {},
      lastSeenCommit: null,
      refEtag: null,
      writerToken: meta.writerToken,
      prev: { epoch: from, device: meta.deviceId },
      ...(basedOn !== null ? { basedOn: basedOn.epoch } : {}),
    };
    const base = await seal(storedState(next), this.#key);
    const oldText = olds.length > 0 ? await seal(storedOld(olds), this.#key) : null;
    const put = await Promise.all([...groups.values()].map(async (group): Promise<[string, string]> => [group.marker, await seal(group, this.#key)]));
    const remove = [...this.#leftBehind.keys()].filter((marker) => !groups.has(marker));
    this.#assertWritable();
    await this.#mutate(nextMeta, {
      base,
      clearTail: true,
      ownLog: { dropThrough: Number.MAX_SAFE_INTEGER },
      clearChain: true,
      old: oldText,
      leftBehind: { put, delete: remove },
    });

    const before = this.#doc!;
    const doc = materialize(next);
    this.#fence.switchEpoch(pre, next, canonicalJson({ ...before, tombstones: [] }) !== canonicalJson({ ...doc, tombstones: [] }));
    this.#state = next;
    this.#doc = doc;
    this.#ownLog = [];
    this.#chainHead = CHAIN_START;
    this.#lastAllocated = 0;
    this.#genesis = { name: genesisName, sha: genesis.sha, state: genesis.state };
    this.#halted.clear();
    this.#unlistedSeen.clear();
    this.#waitingLogs.clear();
    this.#gapWait = false;
    this.#genesisBlocked = false;
    this.#logText = null;
    this.#logReady = null;
    this.#snapText = null;
    this.#leftBehind = groups;
    this.#oldText = oldText;
    this.#refreshLeftBehind();
    this.#log(`a restore started epoch ${genesis.epoch}; this device switched to it as a new device, with ${groups.size} groups of changes left behind`);
    this.#emit();
    return true;
  }

  /** The previous epochs' states kept in `old`. A load reads them first, so
   * one that can't be read leaves the device unreadable; this is only a
   * fallback (logged and left out: the groups stay as they were). */
  async #readOld(): Promise<OldEpoch[]> {
    return (await this.#decodeOld()) ?? [];
  }

  /** `old` decoded, or null (logged) when it can't be read. */
  async #decodeOld(): Promise<OldEpoch[] | null> {
    if (this.#oldText === null) return [];
    try {
      const old = decodeOld(await this.#open(this.#oldText));
      if (typeof old === "string") throw new Error(old);
      return old;
    } catch (err) {
      this.#log("the previous epochs' saved states can't be read; their groups stay as they are", err);
      return null;
    }
  }

  /** The `old` record to keep once only the groups `markers` are left:
   * the epoch this device last switched from (meta.prev) and the one its
   * epoch's genesis is based on (meta.basedOn) are kept even with no group,
   * since a restore that raced the one switched to may be based on either
   * with another cut, until the device switches again; an earlier epoch
   * only while a group from it is left. Undefined when that changes
   * nothing, or when `old` can't be read (it is then left as it is). */
  async #oldKeeping(markers: readonly string[]): Promise<string | null | undefined> {
    if (this.#oldText === null) return undefined;
    const entries = await this.#decodeOld();
    if (entries === null) return undefined;
    const { prev, basedOn } = this.#meta!;
    const keep = entries.filter((entry) => entry.epoch === prev?.epoch || entry.epoch === basedOn || markers.some((marker) => marker.startsWith(`${entry.epoch}/`)));
    if (keep.length === entries.length) return undefined;
    return keep.length === 0 ? null : seal(storedOld(keep), this.#key);
  }

  /** Whether a group is no longer shown: its marker joined (another device
   * resolved it) and, for this device's own changes, every one of them is
   * in effect. Owner decision D18: a device sees its own changes until they
   * are in effect or it resolves them, since only it holds the ones it
   * never pushed. A group this device re-applied (D27) is hidden until a
   * write that hadn't seen the re-apply sets some of it back. */
  #isHidden(group: LeftBehindGroup, state: SyncState): boolean {
    if (group.applied !== undefined) return (group.setBack?.length ?? 0) === 0;
    if (!state.ra.has(group.marker)) return false;
    return !group.own || inEffect(group, state);
  }

  /** Counts the groups shown, and drops the hidden ones from the device:
   * every one for "all" (after a join, a switch or a rehome), other
   * devices' only for "others" (after an own write), none for "none". A
   * group this device re-applied is never dropped here: what the joins
   * tell of the re-apply drops it (#keptAfterJoin, D27). */
  #refreshLeftBehind(tidy: "all" | "others" | "none" = "all"): void {
    const state = this.#state;
    let shown = 0;
    let own = 0;
    let hidden = false;
    if (state !== null) {
      for (const group of this.#leftBehind.values()) {
        if (this.#isHidden(group, state)) hidden ||= group.applied === undefined && (tidy === "all" || !group.own);
        else {
          shown++;
          if (group.own) own++;
        }
      }
    }
    this.#leftBehindCount = shown;
    this.#leftBehindOwnCount = own;
    if (hidden && tidy !== "none") this.#tidyLeftBehind(tidy === "all");
  }

  /** Drops the groups no longer shown (this device's own only when a join
   * asked, #refreshLeftBehind), and the old states no group needs
   * (#oldKeeping), in one transaction. Housekeeping: a failure is only
   * logged, and the next refresh tries again. */
  #tidyLeftBehind(own: boolean): void {
    if (own) this.#tidyOwn = true;
    if (this.#tidying) return;
    this.#tidying = true;
    this.#enqueue(async () => {
      try {
        this.#assertWritable();
        const state = this.#state!;
        const own = this.#tidyOwn;
        this.#tidyOwn = false;
        const hidden = [...this.#leftBehind.values()].filter((group) => group.applied === undefined && this.#isHidden(group, state) && (own || !group.own)).map((group) => group.marker);
        if (hidden.length === 0) return;
        const old = await this.#oldKeeping([...this.#leftBehind.keys()].filter((marker) => !hidden.includes(marker)));
        this.#assertWritable();
        await this.#mutate(this.#meta!, { leftBehind: { delete: hidden }, ...(old !== undefined ? { old } : {}) }, true);
        for (const marker of hidden) this.#leftBehind.delete(marker);
        if (old !== undefined) this.#oldText = old;
      } finally {
        this.#tidying = false;
      }
    }).catch((err: unknown) => this.#log("tidying the changes restores left behind failed; it will be tried again", err));
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

  #assertNotRestoring(): void {
    if (this.#restore !== null) throw new ApiError(503, this.#restore === "written" ? RESTORED : RESTORING);
    if (this.#restoreUnknown !== null) throw new ApiError(503, RESTORE_UNKNOWN);
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
   * write ("This device couldn't save"), unless the mutation is the
   * engine's own `housekeeping` (a local compaction), which no user write
   * waits on: that failure is only logged. */
  async #mutate(meta: SyncMeta, writes: Omit<Mutation, "expect" | "meta">, housekeeping = false): Promise<void> {
    if (!this.#claimed) await this.#write(this.#meta!, {}, housekeeping);
    await this.#write(meta, writes, housekeeping);
  }

  async #write(meta: SyncMeta, writes: Omit<Mutation, "expect" | "meta">, housekeeping: boolean): Promise<void> {
    const nextMeta: SyncMeta = { ...meta, writerToken: randomHex(16) };
    try {
      await this.#store.mutate({ ...writes, expect: this.#expect, meta: nextMeta });
    } catch (err) {
      if (err instanceof WriterTokenMismatch) {
        this.#supersede();
        throw new ApiError(503, OTHER_TAB);
      }
      this.#log("a save on this device failed; nothing from it was kept", err);
      if (!housekeeping) {
        this.#deviceSaveFailed = true;
        this.#emit();
      }
      throw new ApiError(500, DEVICE_SAVE_FAILED);
    }
    this.#expect = nextMeta.writerToken;
    this.#meta = nextMeta;
    this.#claimed = true;
    this.#tailCount = (writes.clearTail ? 0 : this.#tailCount) + (writes.tail?.length ?? 0);
    if (this.#tailCount > this.#compaction.tailEntries) this.#compactLocalSoon();
    if (this.#deviceSaveFailed && !housekeeping) {
      this.#deviceSaveFailed = false;
      this.#emit();
    }
  }

  /** Local compaction (section 8.4), separate from the repo's: once `tail`
   * holds more entries than the limit, one transaction rewrites `base` as
   * the joined state and empties `tail`, so a load joins one record instead
   * of every delta since. It is queued behind the mutation that grew the
   * tail, and the state can't change while it runs: every change to it is a
   * queued mutation. A failure (a full device) is only logged; the next
   * mutation past the limit tries again. */
  #compactLocalSoon(): void {
    if (this.#compactingLocal) return;
    this.#compactingLocal = true;
    this.#enqueue(async () => {
      try {
        if (this.#tailCount <= this.#compaction.tailEntries) return;
        this.#assertWritable();
        const base = await seal(storedState(this.#state!), this.#key);
        this.#assertWritable();
        await this.#mutate(this.#meta!, { base, clearTail: true }, true);
      } finally {
        this.#compactingLocal = false;
      }
    }).catch((err: unknown) => this.#log("compacting this device's saved changes failed; it will be tried again", err));
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
    this.#tailCount = loaded.tailCount;
    this.#lastAllocated = 0;
    this.#leftBehind = loaded.leftBehind;
    this.#oldText = loaded.old;
    // Counted only: hidden groups are dropped by the next refresh, once the
    // load has finished.
    this.#refreshLeftBehind("none");
    this.#needsInit = false;
    this.#unreadable = null;
    this.#setStatus("idle");
  }

  #fail(reason: UnreadableReason): void {
    this.#meta = this.#state = this.#doc = null;
    this.#leftBehind = new Map();
    this.#oldText = null;
    this.#refreshLeftBehind("none");
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
      const leftBehind = new Map<string, LeftBehindGroup>();
      for (const [key, text] of records.leftBehind) {
        const group = checkGroup(await this.#open(text));
        if (group === null || group.marker !== key) return malformed("a group of changes left behind is malformed");
        leftBehind.set(key, group);
      }
      // The previous epochs' states are read now, like the groups: one that
      // can't be read is unreadable (section 12, B13), never dropped later
      // or written over by the next switch.
      if (records.old !== undefined) {
        const old = decodeOld(await this.#open(records.old));
        if (typeof old === "string") return malformed(old);
      }
      return { meta, state, doc: materialize(state), ownLog, chainHead, tailCount: records.tail.length, leftBehind, old: records.old ?? null };
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
      leftBehindOwnCount: this.#leftBehindOwnCount,
      damagedFile: this.#damaged,
      restore: this.#restoreState,
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
