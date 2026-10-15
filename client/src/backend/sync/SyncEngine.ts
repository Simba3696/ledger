import { ApiError } from "../ApiError";
import { InvalidFileError, WrongPassphraseError, deriveKey, parseHeader } from "../crypto";
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
import { BlobReads } from "./blobReads";
import { canonicalJson } from "./canonical";
import { CHAIN_START, FORMAT_VERSION, chainNext, checkRepoFile, encodeState, opHash, opProblem, vectorOf } from "./codec";
import { diffDocuments } from "./diff";
import { draftOf, settleDraft } from "./draft";
import { compareEpochKeys, epochCounted, epochJoined, epochMove, isEpochKey, nextEpochKey, parseRepoFileName, repoFileName, winningEpoch, type RepoFile } from "./epoch";
import { Fence, type FenceNotice } from "./fence";
import { checkGroup, inEffect, leftBehind, leftBehindItems, reapplyTo, splitFigures, withoutHeld, type LeftBehindGroup, type LeftBehindItem, type ReapplyResult } from "./leftBehind";
import { damagedFileMessage, damagedGenesis, forgetRestore, rememberRestore, winningEpochNow, writeGenesis, type DamagedFile, type EpochNow, type GenesisContent } from "./ledgerRepo";
import { materialize, readerOf, rematerialize } from "./materialize";
import { ShownChanged, actionDay, applyAction, noticeView, type NoticeActionKind, type NoticeView, type ShownAction } from "./noticeActions";
import { checkNotice, detectNotices, overCap, supersededNotices, type Arrivals, type Detected, type StoredNotice } from "./notices";
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
import { LamportExhausted, newDeviceId, nextLamport, randomHex, type Tag, type VersionVector } from "./tags";

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
/** "keyChanged": the device is sealed under another key than this tab's
 * (it joined a racing create's winner, D32): EngineState.keyNeeded says
 * which. */
export type UnreadableReason = "loadFailed" | "newer" | "undecryptable" | "malformed" | "keyChanged";

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
  /** Notices to review (section 4.2): notices(). */
  noticeCount: number;
  /** Changes whenever notices() may: a notice added, settled or dismissed,
   * or the document changed (what an action would write is worked out from
   * it). */
  noticeRevision: number;
  /** Groups of changes a restore left behind still to review (section 9.3):
   * every one shown, and of those this device's own (owner decision D18:
   * own prominently, other devices' in a collapsed list). */
  leftBehindCount: number;
  leftBehindOwnCount: number;
  /** The winning genesis is newer than this device's epoch and can't be
   * opened here (owner decision D26): sync stops, local writes go on, and
   * deleting this file on GitHub resumes it, or, for "joined", restoring
   * its previous version does (damagedFileMessage says how). Null
   * otherwise, a genesis too new for this build included, and while this
   * device's epoch is gone (epochGone): such a device may be the one that
   * lost, so it never advises deleting or rolling back the winner. */
  damagedFile: DamagedFile | null;
  /** This device's epoch no longer counts in two full listings in a row
   * (its genesis, or one below it, was deleted on GitHub; one listing may
   * be stale) and the winner is older, or newer but can't be opened here:
   * nothing the device can switch to. Sync stays pending, local writes go
   * on, a restore is refused (it would write past `winner`), and #8 offers
   * joining the ledger that's there now, or, with no winner (status
   * `missing` too), restoring this device's data into the empty repo or
   * creating a new ledger (epochGoneMessage). #8's join from here must
   * offer this device's own changes first (an export, or an own group
   * left behind with the cut {}): the join clears the sync state, and
   * nothing else keeps them (ADR-0008 STAGE-8). Every cycle lists
   * afresh meanwhile, and the first listing that counts the epoch again
   * clears it. Null otherwise. */
  epochGone: EpochGone | null;
  /** This device created its ledger at the same moment as another device,
   * whose create, under another passphrase's salt, won (ADR-0008, D32):
   * the winner's epoch. rekeyAndJoin() joins it with the household
   * passphrase. Null otherwise. */
  raceLost: RaceLost | null;
  /** With unreadable "keyChanged": the salt and iterations of the key the
   * device is sealed under (the household passphrase derives it with them,
   * offline). Null otherwise. */
  keyNeeded: { salt: string; iter: number } | null;
  /** A restore this tab started (restore()), once its genesis was sent:
   * "pending" while a PUT got no answer and no listing has settled it
   * ("unknown"), "landed" once its genesis is known to be in the repo
   * (clear the sync state and reload, section 9.2 step 7). Null when none
   * was, or a full listing showed the pending one never landed. */
  restore: RestoreState | null;
}

/** This device's epoch, gone from the repo, and the winner listed now
 * (EngineState.epochGone); `winner` is null when no epoch counts at all
 * (no genesis listed, or an empty repo): no ledger is in the repo. */
export interface EpochGone {
  epoch: string;
  winner: string | null;
}

/** EngineState.raceLost: the epoch-1 create that won the race, and whether
 * this device can join it (rekeyAndJoin): only when its own genesis is a
 * create. One started from a backup (a restore into an empty repo) holds
 * the backup's content, which the join never offers back, so its way on
 * is D35's: a backup of this device, then Forget and join. */
export interface RaceLost {
  winner: string;
  joinable: boolean;
}

/** What rekeyAndJoin() did (ADR-0008, D32). */
export type RekeyResult =
  /** Joined the winner: this device's state is sealed under `key`, the
   * household's key for the winner, which the caller keeps from now on
   * (the device store's key). This device's writes are its own group left
   * behind, to Re-apply. */
  | { kind: "joined"; epoch: string; key: DeviceKey }
  /** Not the loser of a racing create (any more): nothing done. */
  | { kind: "notRaceLost" }
  /** This device's ledger started from a backup: the join would lose what
   * the backup held, so nothing is done (D35's way on, RaceLost). */
  | { kind: "fromBackup"; epoch: string }
  /** The passphrase doesn't open the winner: nothing written. */
  | { kind: "wrongPassphrase"; epoch: string }
  /** The passphrase is this device's own, and the winner uses another:
   * nothing written. The way on is a backup of this device, then Forget
   * and join with the winner's passphrase (D35). */
  | { kind: "otherKey"; epoch: string }
  /** The repo couldn't be read whole, or another switch got there first. */
  | { kind: "unknown" }
  | { kind: "needsUpdate"; epoch: string }
  | { kind: "damaged"; epoch: string };

/** What to tell the person when this device's epoch is gone (EpochGone)
 * and another ledger is in the repo now. */
export const EPOCH_GONE =
  "This device's ledger version was removed from the GitHub repo, so it can't sync. Its changes are kept on this device. To go on, join the ledger that's there now; its passphrase may differ.";
/** The same when no ledger is in the repo now (`winner` null). */
export const EPOCH_GONE_EMPTY =
  "This device's ledger version was removed from the GitHub repo, and no ledger is in the repo now, so it can't sync. Its changes are kept on this device. To go on, export this device's data and restore it into the repo, or create a new ledger.";

/** EPOCH_GONE, or EPOCH_GONE_EMPTY when no ledger is in the repo. */
export function epochGoneMessage(gone: EpochGone): string {
  return gone.winner === null ? EPOCH_GONE_EMPTY : EPOCH_GONE;
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
  /** Another device already resolved this group (re-applied or discarded
   * it), but this device's own changes are not all in effect: shown until
   * this device resolves it too. */
  resolvedElsewhere: boolean;
  /** This device's month figures and settings from before it joined a
   * racing create's winner (D32): re-applying them replaces the winner's. */
  figures: boolean;
  /** A figures group whose entries group is still shown: it can't be
   * re-applied until that one is re-applied or discarded (ENTRIES_FIRST). */
  waitsForEntries: boolean;
  items: LeftBehindItem[];
}

/** What a restore did (section 9.2). */
/** What rejoin() did (#8, D34, D35). */
export type RejoinResult =
  | { kind: "joined"; epoch: string }
  | { kind: "notGone" }
  | { kind: "empty" }
  | { kind: "unknown" }
  | { kind: "otherKey"; epoch: string }
  | { kind: "needsUpdate"; epoch: string }
  | { kind: "damaged"; epoch: string };

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
   * genesis could be read (display only).
   * `damagedFile` (and then no `reason`, `by` or `at`): the winner is a
   * genesis this device can't open, which landed while the restore ran
   * (D26). The caller must not clear and reload yet, since the reload
   * would find only that file: show damagedFileMessage, and reload once
   * EngineState.damagedFile is null again (the file was deleted, or its
   * previous version restored), when the reload joins the winner, this
   * restore's epoch once that file is gone. */
  | { kind: "replaced"; epoch: string; winner: string; reason?: GenesisContent["reason"]; by?: string; at?: number; damagedFile?: DamagedFile }
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
   * deleting it on GitHub lets sync, and a restore, go on (D26).
   * `epochGone`: this device's epoch no longer counts in a full listing, so
   * a restore based on it would write past the epoch listed now; join that
   * ledger instead, or, with no winner, restore into the empty repo
   * (epochGoneMessage). */
  | { kind: "failed"; detail: string; damagedFile?: DamagedFile; epochGone?: EpochGone }
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

/** How much a log line matters: "info" for routine progress, "warn" for
 * something unusual the engine recovers from by itself (it tries again, or
 * goes on as a new device), "error" for a failure the person may have to
 * deal with (a file that can't be read or sent, a save that failed). Each
 * call site says which; an error object coming with a line doesn't decide
 * it. */
export type SyncLogLevel = "info" | "warn" | "error";

/** The engine's log when none is given: console.info, console.warn or
 * console.error by level, with the error when there is one (and nothing,
 * not "undefined", when there isn't). */
export function defaultSyncLog(level: SyncLogLevel, message: string, err?: unknown): void {
  const line = `ledger:sync: ${message}`;
  if (err === undefined) console[level](line);
  else console[level](line, err);
}

export interface SyncEngineOptions {
  key: DeviceKey;
  /** The signed-in login: each op's display `by`. */
  actor: string;
  store?: SyncStore;
  /** Web Locks; null runs without the one-tab lock. Default navigator.locks. */
  locks?: LockManager | null;
  now?: () => number;
  log?: (level: SyncLogLevel, message: string, err?: unknown) => void;
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
  `Ledger can't save more changes until sync resumes: it needs a new epoch to number them, and none can start while ${file.path} can't be opened. ${damagedFileMessage(file)}`;
/** Why a write is refused while a restore writes its genesis, and for good
 * once it landed: the caller clears this device's sync state and reloads
 * (section 9.2 step 7), so a write saved now would be lost with it. */
const RESTORING = "A backup is being restored. Try again once it finishes.";
export const RESTORED = "Ledger was restored from a backup. Reload to continue.";
/** Why a write is refused after a restore whose genesis PUT got no answer,
 * until a listing settles whether it landed. */
export const RESTORE_UNKNOWN = "A backup restore may still be on its way to GitHub. Try again once Ledger has synced.";
/** Why a notice's action or dismissal is refused: the notice is gone. */
export const NOTICE_GONE = "That notice was already dealt with.";
/** Why reapply() or discard() is refused: the group is gone. */
export const ALREADY_RESOLVED = "Those changes were already re-applied or discarded.";
/** Why a figures group (D32) waits: its entries group is still shown. */
export const ENTRIES_FIRST = "Re-apply or discard your entries first.";
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
  /** The epoch's genesis state, which every snap is checked against, read
   * through `blobs` if it has to be read. */
  genesis: (blobs: BlobReads) => Promise<SyncState>;
  /** The genesis version genesis() reads, when it reads one. */
  genesisRead?: { name: string; listed: Listed };
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
  /** Each snapshot joined, with the device whose snapshot it is. */
  states: { device: string; state: SyncState }[];
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
  notices: Map<string, StoredNotice>;
  /** Keys of notice records this build can't read: kept as they are (D31). */
  unreadNotices: Set<string>;
  old: string | null;
}

/** A restore genesis written (section 9.2), or why not. */
type RestoreWrite =
  | { kind: "written"; genesis: NewEpoch }
  | { kind: "tooLarge"; detail: string }
  | { kind: "failed"; detail: string; damagedFile?: DamagedFile; epochGone?: EpochGone; newer?: string; newerTooNew?: true }
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
  /** When it is based on an epoch other than the one switched from: the
   * cut each epoch further down its line was left behind with (the first
   * genesis in the line based on it), read from the listed geneses. A
   * device that skipped an epoch projects what it had with these exact
   * cuts instead of {} (stage 8a). */
  line?: ReadonlyMap<string, VersionVector>;
  /** #8's rejoin from a gone epoch (D34, D36): the gone epoch is offered
   * whole (cut {}, nothing filtered as held), groups shown now are
   * carried as they are, and no kept epoch is projected again: the winner
   * is a long-lived ledger, not a restore based on this device's line. */
  rejoin?: true;
  /** The racing-create join (D32): the household's key for the winner,
   * which everything this device keeps is sealed under in the switch's
   * own transaction, and which the engine uses from then on. */
  rekey?: DeviceKey;
}

/** What a write's commit does besides its op. `resolves`: a left-behind
 * group's marker, carried as the op's `ra` even when nothing else changes,
 * and the group is dropped from this device in the op's own transaction
 * (section 9.4). `settles`: a notice whose action this write is (section
 * 4.1), removed in the op's own transaction once the op holds something.
 * `addsBack`: the deleted record an "Add it back" re-makes, carried as the
 * op's `ab` (state.ts). */
interface CommitExtras {
  resolves?: string;
  settles?: string;
  addsBack?: string;
}

/** A notice as it is told, before it is numbered and stored. */
type NoticeBody = StoredNotice extends infer N ? (N extends StoredNotice ? Omit<N, "seq" | "at"> : never) : never;

/** A fence notice's key: (winner op, loser op), so each pair is stored
 * once. A join's notices add their kind and target (notices.ts), so no
 * fence key equals one of theirs. */
function fenceNoticeKey(notice: FenceNotice, mine: Tag): string {
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

/** The devices in `devices` with no file in `epoch` in `listing`. A
 * device's ops reach another only through its log, and nothing is ever
 * deleted, so every device an honest snapshot has seen has a file in any
 * listing that holds that snapshot. A cut listing proves no absence. */
function unlistedOf(listing: Listing, epoch: string): (devices: string[]) => string[] {
  const listed = new Set<string>();
  for (const { file } of listing.files.values()) if (file.kind !== "genesis" && file.epoch === epoch) listed.add(file.device);
  return (devices) => (listing.truncated ? [] : devices.filter((device) => !listed.has(device)));
}

export class SyncEngine {
  /** Replaced only by rekeyAndJoin (D32), once its switch is saved. */
  #key: DeviceKey;
  readonly #actor: string;
  readonly #store: SyncStore;
  readonly #locks: LockManager | null;
  readonly #now: () => number;
  readonly #log: (level: SyncLogLevel, message: string, err?: unknown) => void;
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
  /** Notices to show (section 4.2), by key, as stored. */
  #notices = new Map<string, StoredNotice>();
  /** Keys of stored notice records this build can't read (owner decision
   * D31): left in the store byte for byte, out of memory and the UI, and
   * never written over by a notice told under the same key. */
  #unreadNotices = new Set<string>();
  /** The greatest `seq` stored: the next notice is numbered after it. */
  #noticeSeq = 0;
  /** Bumped whenever the notices or the document change: what an action
   * previews may then differ (EngineState.noticeRevision). */
  #noticeRev = 0;
  /** The document the last emitted state was made with. */
  #emittedDoc: LedgerDocument | null = null;
  /** notices() as last built, for the revision and the day it was built
   * at: Record again's preview depends on today (section 4.1). */
  #noticeViews: { rev: number; day: string; views: NoticeView[] } | null = null;
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
  /** Own writes diffed and not yet saved (#commit, #commitOp). */
  #saving = 0;
  /** Write turns begun (#turn) and not yet ended. */
  #openTurns = 0;
  /** What joins brought in while an own write was diffed and not yet
   * saved, and the state before the first of them, under the identity
   * the write was diffed as: #commitOp tells that write's clashes with
   * them as a join after it would have (section 4.2). */
  #joinedWhileSaving: { epoch: string; device: string; pre: SyncState; source: SyncState; ops: [string, Op][]; states: Arrivals["states"][number][] } | null = null;
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
  /** This device's epoch no longer counts in a full listing (EpochGone),
   * as last decided by a listing that could tell. */
  #epochGone: EpochGone | null = null;
  /** EngineState.raceLost, the same object while it doesn't change. */
  #raceLost: RaceLost | null = null;
  /** #ownGenesisReason's answer for the own genesis's blob sha. */
  #ownReason: { sha: string; reason: GenesisContent["reason"] | null } | null = null;
  /** The key the saved state is sealed under, when it isn't this tab's
   * (unreadable "keyChanged"). */
  #keyNeeded: { salt: string; iter: number } | null = null;
  /** The epoch the last full listing didn't count, if it didn't: one such
   * listing may be stale, so epochGone waits for a second (#noteGone), and
   * every cycle lists again while this is set. */
  #goneSeen: string | null = null;
  /** Own log PUTs sent in the last hour, and when one last landed
   * (monotonic ms). */
  #putTimes: number[] = [];
  #lastLanded: number | null = null;
  /** The own log text for the latest own op, built once per content. */
  #logText: { key: string; value: Promise<LogText> } | null = null;
  /** The last own log text built, for a keepalive push on hidden or pagehide. */
  #logReady: LogText | null = null;
  /** The text a keepalive push last sent: each goes at most once, since a
   * page hidden and then closed fires both, and a second send of the same
   * text could only fail on its now stale sha. */
  #keepaliveSent: LogText | null = null;
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
    this.#log = options.log ?? defaultSyncLog;
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
   * saved, and the transaction itself refuses if anything was saved since.
   * `genesis` is the epoch's genesis the caller has just opened (#8's join:
   * openGenesis), by its blob sha and its state, which `state` holds: the
   * first cycle then doesn't read that version again. Without it, the first
   * cycle reads the listed genesis. */
  initialize(epochKey: string, state: SyncState, genesis?: { sha: string; state: SyncState }): Promise<void> {
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
        joined: genesis ? { [repoFileName({ kind: "genesis", epoch: epochKey })]: genesis.sha } : {},
        seen: vectorOf(state.seen),
        logReach: {},
        snapReach: {},
        lastSeenCommit: null,
        refEtag: null,
        writerToken: "",
      };
      const base = await seal(storedState(state), this.#key);
      await this.#mutate(meta, { base, clearChain: true });
      this.#adopt({ meta: this.#meta!, state: cloneState(state), doc: materialize(state), ownLog: [], chainHead: CHAIN_START, tailCount: 0, leftBehind: new Map(), notices: new Map(), unreadNotices: new Set(), old: null }, true);
      // What a snapshot is checked against (#epochGenesis), as if the cycle
      // had read it.
      if (genesis) this.#genesis = { name: repoFileName({ kind: "genesis", epoch: epochKey }), sha: genesis.sha, state: cloneState(genesis.state) };
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
    // The write's copy is made as the write reads it (draft.ts), and its
    // unread parts are current()'s own once settled: current() is never
    // changed, only replaced, and the diff passes over them by identity.
    return { ready: turn.ready, draft: draftOf, commit: (next) => turn.commit(settleDraft(next)), end: turn.end };
  }

  /** A write's turn (beginWrite), whose commit may also resolve a group a
   * restore left behind (reapply, discard) or settle a notice (its action). */
  #turn(): { ready: Promise<void>; commit: (next: LedgerDocument, extras?: CommitExtras) => Promise<void>; end: () => void } {
    const pin = this.#fence.pin();
    this.#openTurns++;
    let open = true;
    const ready = this.#writesSettled;
    let ended!: () => void;
    const end = new Promise<void>((resolve) => (ended = resolve));
    this.#writesSettled = ready.then(() => end);
    return {
      ready,
      commit: (next, extras) => {
        try {
          return this.#commit(next, pin.asOf, extras);
        } catch (err) {
          return Promise.reject(err);
        }
      },
      end: () => {
        if (open) {
          open = false;
          this.#openTurns--;
        }
        pin.release();
        ended();
      },
    };
  }

  /** A write is under way on this device: submitted and not yet settled,
   * or diffed and still being saved. A reload now could cut it off, so the
   * GitHub tree doesn't offer one (SectionLoadBoundary). */
  get writing(): boolean {
    return this.#openTurns > 0 || this.#saving > 0;
  }

  /** A write made directly on a copy of the document (notice actions and
   * re-apply, sections 4.1 and 9.4): DocumentBackend's pattern, taking its
   * turn among DocumentBackend's writes. At its turn, it clones current(),
   * runs `run` on the clone and commits it. `run` makes its own checks
   * (operations.ts). */
  amend(run: (doc: LedgerDocument) => void): Promise<void> {
    return this.#amend(run);
  }

  /** amend(), with `extras` (CommitExtras). */
  async #amend(run: (doc: LedgerDocument) => void, extras: CommitExtras = {}): Promise<void> {
    const write = this.#turn();
    try {
      await write.ready;
      const next = structuredClone(this.current());
      run(next);
      await write.commit(next, extras);
    } finally {
      write.end();
    }
  }

  /** `asOf`: the revision on screen when the write was submitted. */
  #commit(next: LedgerDocument, asOf: number, extras: CommitExtras = {}): Promise<void> {
    const { resolves } = extras;
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
      if (err instanceof LamportExhausted) return this.#renumber().then(() => this.#commit(next, asOf, extras));
      throw err;
    }
    const body = diffDocuments(state, this.#doc!, next, { L, device: meta.deviceId });
    if (!body && resolves === undefined) return Promise.resolve();
    const fenced = body ? this.#fence.apply(body, state, asOf) : { body: null, notices: [] };
    if (!fenced.body && fenced.notices.length === 0 && resolves === undefined) return Promise.resolve();
    this.#lastAllocated = L;
    let op: Op | null = null;
    if (fenced.body || resolves !== undefined) {
      const vv = { ...this.#fence.renderedSeen(state.seen, asOf) };
      if (meta.ownMaxL > 0) vv[meta.deviceId] = Math.max(vv[meta.deviceId] ?? 0, meta.ownMaxL);
      op = {
        L,
        at: this.#now(),
        by: this.#actor,
        vv,
        set: fenced.body?.set ?? [],
        del: fenced.body?.del ?? [],
        ...(resolves !== undefined ? { ra: [resolves] } : {}),
        ...(fenced.body && extras.addsBack !== undefined ? { ab: [extras.addsBack] } : {}),
      };
      const problem = opProblem(op);
      if (problem) throw new Error(`The fenced op is malformed: ${problem}`);
    }
    const writer = { epoch: meta.epochKey, device: meta.deviceId };
    if (op === null) return this.#enqueue(() => this.#commitOp(op, fenced.notices, L, writer, extras));
    this.#saving++;
    const saved = this.#enqueue(() => this.#commitOp(op, fenced.notices, L, writer, extras));
    const settle = () => {
      if (--this.#saving === 0) this.#joinedWhileSaving = null;
    };
    void saved.then(settle, settle);
    return saved;
  }

  async #commitOp(op: Op | null, notices: FenceNotice[], L: number, writer: { epoch: string; device: string }, { resolves, settles }: CommitExtras): Promise<void> {
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
    // The fence's notices (section 3.4), and the notice an action settles:
    // only once its write holds something (the fence may have dropped it all,
    // and then the remote value stands and the notice stays).
    const mine: Tag = [L, me];
    const fenceNotices = notices.map((n): [string, NoticeBody] => [fenceNoticeKey(n, mine), { kind: n.kind, theirs: n.theirs, mine, registers: n.registers }]);
    const settled = settles !== undefined && op !== null ? [settles] : [];
    // A join that ran after this op was diffed, and before this save, told
    // nothing about it: it wasn't applied yet. Its clashes with this op are
    // told now, as a join after the save would have told them (section 4.2;
    // harness seed 140353: an edit of a record another device's delete,
    // joined in between, removed was otherwise lost with no word).
    const between = op !== null && this.#joinedWhileSaving?.epoch === writer.epoch && this.#joinedWhileSaving.device === writer.device ? this.#joinedWhileSaving : null;
    let late: Detected[] = [];
    let afterOwn: SyncState | null = null;
    if (between !== null && op !== null) {
      afterOwn = cloneState(between.pre);
      applyOp(afterOwn, me, op);
      late = detectNotices(afterOwn, between.source, between, me).filter((notice) => notice.loser.L === op.L);
    }
    // That join told its clashes against an older own write, this one not
    // applied yet: what it told about a register this op wrote again, or a
    // clash this save tells again naming this op, is no longer so, as a
    // join after the save would show (#14). Such an older notice goes, or
    // keeps only its other registers, in its place in the list.
    // A winner arrived in that join only where the join changed something:
    // a register or deletion the state before it didn't already hold with
    // that tag. A snapshot carries every register its device holds, so it
    // carries again winners told long before; a notice of one of those is
    // no business of this save (a review of #14).
    const arrivedTags = new Set<string>();
    if (between !== null && op !== null) {
      const changed = (was: Tag | undefined, now: Tag) => (was === undefined || was[0] !== now[0] || was[1] !== now[1] ? arrivedTags.add(`${now[0]}.${now[1]}`) : undefined);
      for (const [rk, regs] of between.source.rec) for (const [field, reg] of regs) changed(between.pre.rec.get(rk)?.get(field)?.t, reg.t);
      for (const [key, reg] of between.source.unit) changed(between.pre.unit.get(key)?.t, reg.t);
      for (const [rk, deletion] of between.source.del) {
        const was = between.pre.del.get(rk);
        changed(was === undefined ? undefined : [was.L, was.by], [deletion.L, deletion.by]);
      }
    }
    const arrived = (winner: { L: number; device: string }) => arrivedTags.has(`${winner.L}.${winner.device}`);
    const superseded = between !== null && op !== null ? supersededNotices(this.#notices, { L: op.L, wrote: new Set(op.set.map(([key]) => key)) }, late, me, arrived) : { drop: [], keep: [] };
    const told = [...fenceNotices, ...late.map(({ key, ...body }): [string, NoticeBody] => [key, body])];
    const dropped = [...settled, ...superseded.drop];
    const noticeWrites = told.length > 0 || dropped.length > 0 ? await this.#noticeWrites(told, dropped, superseded.keep) : null;
    if (noticeWrites) writes.notices = noticeWrites.writes;
    if (resolves !== undefined) {
      writes.leftBehind = { delete: [resolves] };
      const old = await this.#oldKeeping([...this.#leftBehind.keys()].filter((marker) => marker !== resolves));
      if (old !== undefined) writes.old = old;
    }
    // A reload (stop) or a takeover while this was being sealed writes nothing.
    this.#assertWritable();
    await this.#mutate(nextMeta, writes);

    if (between !== null && afterOwn !== null) between.pre = afterOwn;
    if (op) {
      const changes = applyOp(this.#state!, me, op);
      this.#doc = rematerialize(this.#doc!, readerOf(this.#state!), changes);
      this.#ownLog.push(op);
      this.#chainHead = chain;
      this.#fence.wrote(this.#state!, me, op);
    }
    if (resolves !== undefined) {
      this.#leftBehind.delete(resolves);
      if (writes.old !== undefined) this.#oldText = writes.old;
    }
    if (noticeWrites) this.#keepNotices(noticeWrites.next);
    this.#refreshLeftBehind();
    this.#emit();
    if (op && !this.#stopped) {
      this.#onCommitted();
      this.#pushSoon();
    }
  }

  // --- Remote joins ---------------------------------------------------------

  /** Joins other devices' validated ops and/or validated states (snapshots,
   * each with the device whose snapshot it is, and an epoch's genesis, with
   * none): one transaction appends the delta to tail,
   * records `bookkeeping` in meta and stores the notices the join raises
   * (section 4.2), then the delta is joined through the fence. */
  join(delta: { ops?: [device: string, op: Op][]; states?: Arrivals["states"] }, bookkeeping: MetaPatch = {}): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertWritable();
      this.#assertCycleCurrent();
      const ops = delta.ops ?? [];
      const states = delta.states ?? [];
      let whole: SyncState | null = null;
      for (const part of states) joinInto((whole ??= emptyState()), part.state);
      const source = emptyState();
      if (whole) joinInto(source, whole);
      for (const [device, op] of ops) joinInto(source, opState(device, op));
      const text = await seal({ ops, ...(whole ? { state: storedState(whole) } : {}) } satisfies Delta, this.#key);
      const meta = this.#meta!;
      // Who is told (section 4.2), from the state before the join: nothing
      // else changes it until this task ends. A delete notice is settled
      // (or never stored) when an add-back of that record arrives in an op
      // that had seen my edit: the record is back, with my edit in it.
      const me = meta.deviceId;
      const addedBack = (notice: StoredNotice | Detected): boolean => {
        if (notice.kind !== "deleted") return false;
        const rk = `${notice.target.coll}/${notice.target.id}`;
        return ops.some(([, op]) => op.ab?.includes(rk) === true && (op.vv[me] ?? 0) >= notice.loser.L);
      };
      const found = detectNotices(this.#state!, source, { ops, states }, me).filter((notice) => !addedBack(notice));
      const settled = [...this.#notices].filter(([, notice]) => addedBack(notice)).map(([key]) => key);
      const notices =
        found.length > 0 || settled.length > 0
          ? await this.#noticeWrites(
              found.map(({ key, ...body }): [string, NoticeBody] => [key, body]),
              settled,
            )
          : null;
      const seen = new Map(this.#state!.seen);
      for (const [device, L] of source.seen) if (L > (seen.get(device) ?? 0)) seen.set(device, L);
      this.#assertWritable();
      this.#assertCycleCurrent();
      await this.#mutate({ ...meta, ...bookkeeping, maxL: Math.max(meta.maxL, source.maxL), seen: vectorOf(seen) }, { tail: [text], ...(notices ? { notices: notices.writes } : {}) });
      if (notices) this.#keepNotices(notices.next);

      if (this.#saving > 0) {
        const between = (this.#joinedWhileSaving ??= { epoch: meta.epochKey, device: meta.deviceId, pre: cloneState(this.#state!), source: emptyState(), ops: [], states: [] });
        joinInto(between.source, source);
        between.ops.push(...ops);
        between.states.push(...states);
      }
      const changes = this.#fence.join(this.#state!, source);
      this.#doc = rematerialize(this.#doc!, readerOf(this.#state!), changes);
      // A re-apply marker joined may resolve a group left behind here.
      this.#refreshLeftBehind();
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

  /** The ledger is loaded: fold a long saved tail into its base (section
   * 8.4), start listening for triggers, and sync now (the unlock trigger). */
  #begin(): void {
    if (this.#doc !== null && !this.#stopped && this.#tailCount > this.#compaction.tailEntries) this.#compactLocalSoon();
    if (!this.#canCycle()) return;
    this.#listen();
    void this.sync();
  }

  /** Triggers (section 7): visible again, back online, a 60 s poll while
   * visible, and a keepalive push on becoming hidden or on pagehide. A phone
   * that switches apps or locks (iOS: Safari, and Chrome on iOS) fires only
   * visibilitychange, then freezes the page: the debounced push never runs,
   * and pagehide may never come. A push sent on hidden whose page lives on
   * is settled by the next cycle, as a lost response is. */
  #listen(): void {
    if (this.#listening) return;
    this.#listening = true;
    const { document: doc, window: win } = this.#events;
    const visible = () => doc?.visibilityState === undefined || doc.visibilityState === "visible";
    if (doc) {
      const onVisibility = () => {
        if (visible()) void this.sync();
        else this.#keepalivePush();
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

  /** On becoming hidden or pagehide: the own log, sent with keepalive so the request can
   * outlive the page, its response never read. A lost response is what
   * step 5 settles on the next start. Only a text already built can go: the
   * page may not live long enough to encrypt one. */
  #keepalivePush(): void {
    if (!this.#canCycle() || this.#blocker !== null || this.#genesisBlocked || this.#rateLimited()) return;
    const meta = this.#meta!;
    const through = this.#ownLog.at(-1)?.L ?? meta.K;
    const ready = this.#logReady;
    if (!this.#logDue() || !ready || ready === this.#keepaliveSent || ready.through !== through || ready.K !== meta.K || ready.device !== meta.deviceId) return;
    const write = { path: repoPath(ready.file), text: ready.text, sha: meta.ownLogSha, message: deviceCommitMessage("Sync", ready.device) };
    // Measured as sent: a body the browser would refuse never goes, nor
    // counts against the hourly cap. The next start pushes it instead.
    if (new TextEncoder().encode(putFileBody(write)).length > SYNC_TIMING.keepaliveMaxBytes) return;
    this.#keepaliveSent = ready;
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
    // So is a device whose epoch the last full listing didn't count: a
    // 304 for the head it last handled would settle nothing (#noteGone).
    const relist = this.#restoreUnknown !== null || this.#goneSeen !== null;
    const ref = await this.#head(!relist);
    // The repo answered with this token: whatever stopped the last cycle at
    // the ref is gone. Anything later is found again below.
    this.#blocker = null;
    if (ref.kind === "empty") {
      // No ledger in this repo (section 9.5), so this device's epoch is
      // gone too, with nothing listed in its place (stage 6 final review).
      this.#damaged = null;
      this.#noteGone(this.#meta!.epochKey, null);
      this.#blocker = "missing";
      return false;
    }
    let listedOwn: string | undefined;
    if (ref.kind === "head") {
      const meta = this.#meta!;
      if (ref.commitSha !== meta.lastSeenCommit || relist) {
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
    if (listing.truncated) this.#log("warn", "GitHub cut the file listing short; files it left out are read once it lists them");
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
      this.#log("warn", "the cut listing doesn't name this device's epoch as the winner; trying again later");
      return null;
    }
    if (winner === null) {
      // No genesis listed: no ledger in this repo (section 9.5), and this
      // device's epoch is gone with nothing in its place.
      this.#damaged = null;
      this.#noteGone(epoch, null);
      this.#blocker = "missing";
      return null;
    }
    const move = epochMove(winner, epoch);
    if (move === "stale") {
      // A listing older than what this device has joined (section 9.1), or
      // this device's epoch is gone: its genesis (or one below it) was
      // deleted, perhaps on another device's word that it was a racing
      // create's (D26). A listing can't tell the two apart, and a stale one
      // passes with the next listing, so the cycle stays pending either
      // way; the state says the epoch no longer counts, so #8 can
      // offer joining the ledger that's there now, and a restore is refused.
      // (A cut listing never gets here: it stopped above.)
      this.#noteGone(epoch, winner);
      this.#log("info", `the repo listing is older than what this device has joined, or its epoch ${epoch} is gone (the winner is ${winner}); trying again later`);
      return null;
    }
    if (move === "switch") {
      // A restore won (section 9.3): switch to its epoch, then read that
      // epoch's files from this same listing. Nothing more is read from or
      // written to the old epoch. This device's epoch may be gone from this
      // full listing (a cut one stopped above) while a newer one wins: a
      // winner it can't open is then never named (stage 6 final review).
      const gone = !epochCounted(listing.files.keys(), epoch);
      if (!(await this.#switchToListed(listing, winner, gone))) return null;
      return this.#pull(listing);
    }
    this.#notGone();
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
      this.#log("warn", `this device's own snapshot in the repo is not its history (${snap.fork}); it syncs on as a new device`);
      await this.#rehome(listing);
      return { listedOwn: undefined };
    }
    if (snap.confirm) await this.#confirmSnap(snap.confirm.sha, snap.confirm.through);

    const ownName = repoFileName({ kind: "log", epoch, device: meta.deviceId });
    const listedOwn = listing.files.get(ownName);
    const own = await this.#ownCheck(ownName, listedOwn);
    if (own.fork !== undefined) {
      this.#log("warn", `this device's own log in the repo is not its history (${own.fork}); it syncs on as a new device`);
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
    // The genesis and every snapshot read join as one state; each is passed
    // on its own, since a snapshot's `seen` stands in for the vv of the
    // writes it holds when notices are worked out (section 4.2).
    const states = genesis.state ? [{ device: null, state: genesis.state }, ...others.states] : others.states;
    if (others.ops.length > 0 || states.length > 0) await this.join({ ops: others.ops, states }, patch);
    else await this.#record(patch);
    return { listedOwn: listedOwn?.sha };
  }

  /** A full listing doesn't count this device's epoch (`winner` is the
   * one it counts instead). A listing that lags a commit looks the same, so
   * epochGone is set only once the listing before it, the last this device
   * made, didn't count the epoch either (stage 6 final review); until a
   * listing counts it again, every cycle lists afresh. */
  #noteGone(epoch: string, winner: string | null): void {
    if (this.#goneSeen === epoch && (this.#epochGone?.epoch !== epoch || this.#epochGone.winner !== winner)) this.#epochGone = { epoch, winner };
    this.#goneSeen = epoch;
  }

  /** A listing counts this device's epoch, or can't tell: nothing is gone. */
  #notGone(): void {
    this.#goneSeen = null;
    this.#epochGone = null;
  }

  /** Whether a restore genesis whose PUT got no answer landed, as far as
   * `listing` tells: listed, it is a landed restore (writes stay refused
   * until the reload, as for "restored"); missing from a full listing, it
   * didn't land, and writes go on. A cut listing settles nothing. */
  #settleRestore(listing: Listing): void {
    const epoch = this.#restoreUnknown;
    if (epoch === null) return;
    if (listing.files.has(repoFileName({ kind: "genesis", epoch }))) {
      this.#log("info", `the restore's genesis ${epoch} landed after all`);
      this.#restoreUnknown = null;
      this.#restore = "written";
      this.#restoreState = { state: "landed", epoch };
    } else if (!listing.truncated) {
      this.#log("info", `the restore's genesis ${epoch} isn't in the repo; writes go on`);
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
    let genesisRead: StreamSource["genesisRead"];
    try {
      genesisRead = this.#genesisVersion(listing) ?? undefined;
    } catch {
      // Named by nothing: genesis() throws when a snapshot needs it.
    }
    const streams = await this.#readStreams({
      listing,
      genesis: (blobs) => this.#epochGenesis(listing, blobs),
      genesisRead,
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
   * inserted or changed there is joined, as a cold start joins it.
   *
   * The blobs it is sure to download are read ahead, BLOB_READS_AT_ONCE at
   * a time (design section 7), and each is handed over at its turn, so every
   * decision is taken in the same order on the same bytes as when they were
   * read one by one (#plannedReads). */
  async #readStreams(src: StreamSource): Promise<Streams> {
    const blobs = new BlobReads((sha) => this.#remote!.client.readBlob(sha));
    blobs.plan(this.#plannedReads(src));
    try {
      return await this.#joinStreams(src, blobs);
    } finally {
      blobs.close();
    }
  }

  /** The blobs #joinStreams is sure to download, in the order it downloads
   * them: only first attempts (a snapshot not joined at its first version
   * and not refused for the listing, the genesis its check reads first, a
   * log not joined and not waiting for its snapshot), and none that #read
   * refuses without downloading. A read it may or may not make (a later
   * version, a snapshot a gap needs again) is not planned: it is read when
   * asked for, so no request is made that reading one by one wouldn't. */
  #plannedReads(src: StreamSource): string[] {
    const unlistedIn = unlistedOf(src.listing, this.#meta!.epochKey);
    const downloads = (name: string, listed: Listed) => !this.#refused.has(`${name}@${listed.sha}`) && listed.size <= this.#bounds.read.bytes;
    const planned: string[] = [];
    let checksSnap = false;
    for (const name of src.snaps) {
      const first = src.versions(name)[0];
      if (!first || src.joined[name] === first.sha) continue;
      const named = this.#unlistedSeen.get(`${name}@${first.sha}`);
      if (named && unlistedIn(named).length > 0) continue;
      checksSnap = true;
      if (downloads(name, first)) planned.push(first.sha);
    }
    const genesis = src.genesisRead;
    if (checksSnap && genesis && downloads(genesis.name, genesis.listed)) planned.unshift(genesis.listed.sha);
    for (const name of src.logs) {
      const first = src.versions(name)[0];
      if (parseRepoFileName(name)?.kind !== "log" || !first || src.joined[name] === first.sha || this.#waitingLogs.has(`${name}@${first.sha}`)) continue;
      if (downloads(name, first)) planned.push(first.sha);
    }
    return planned;
  }

  /** #readStreams, its downloads read through `blobs`. */
  async #joinStreams(src: StreamSource, blobs: BlobReads): Promise<Streams> {
    const epoch = this.#meta!.epochKey;
    const out: Streams = {
      states: [],
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
    // A seen entry joined is carried in every later own op's vv and own
    // snapshot. Entries for devices with no file would let one small file
    // make every later own op too large to push. Whether a device has a
    // file depends on the listing, not on the snapshot's bytes, so this
    // refusal is never remembered as final (#refused): it is checked again
    // against every listing, and a device listed later lets every device
    // join the snapshot alike.
    const unlistedIn = unlistedOf(src.listing, epoch);
    const unlistedRefusal = (count: number) =>
      ({ ok: false, problem: "malformed", detail: `its seen names ${count} devices with no file in the repo` }) satisfies FileRead;

    const joinSnap = async (name: string, listed: Listed): Promise<FileRead> => {
      const at = `${name}@${listed.sha}`;
      const named = this.#unlistedSeen.get(at);
      if (named) {
        const still = unlistedIn(named);
        if (still.length > 0) return unlistedRefusal(still.length);
      }
      const read = await this.#read(name, listed, await src.genesis(blobs), undefined, blobs);
      if (!read.ok) return read;
      const { file, state } = read.read;
      if (!state || file.kind !== "snap") return { ok: false, problem: "malformed", detail: "it is not a snapshot" };
      const unlisted = unlistedIn([...state.seen.keys()].filter((device) => device !== file.device));
      if (unlisted.length > 0) {
        const refused = unlistedRefusal(unlisted.length);
        this.#unlistedSeen.set(at, unlisted);
        this.#log("error", `${name} can't be joined while the listing stays as it is (malformed): ${refused.detail}`);
        return refused;
      }
      this.#unlistedSeen.delete(at);
      out.states.push({ device: file.device, state });
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
        const read = this.#waitingLogs.get(at) ?? (await this.#read(name, version, undefined, undefined, blobs));
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
   * larger than `bounds` allow is refused without being downloaded. It is
   * downloaded through `blobs` when given (#readStreams). */
  async #read(name: string, listed: Listed, genesis?: SyncState, bounds: FileBounds = this.#bounds.read, blobs?: BlobReads): Promise<FileRead> {
    const at = bounds === this.#bounds.read ? `${name}@${listed.sha}` : `${name}@${listed.sha}@${bounds.bytes}`;
    const known = this.#refused.get(at);
    if (known) return known;
    const read: FileRead =
      listed.size > bounds.bytes
        ? { ok: false, problem: "malformed", detail: `the file is listed at ${listed.size} bytes, larger than ${bounds.bytes}` }
        : await openRepoFile(listed.file, await (blobs ? blobs.read(listed.sha) : this.#remote!.client.readBlob(listed.sha)), this.#key, genesis, bounds);
    if (!read.ok) {
      this.#refused.set(at, read);
      this.#log("error", `${name} can't be joined (${read.problem}): ${read.detail}`);
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
          this.#log("warn", `the repo refused ${MAX_PUTS} writes of this device's log in a row; trying again on the next trigger`);
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
          this.#log("warn", `this device's own log in the repo is not its history (${own.fork}); it syncs on as a new device`);
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
      this.#log("error", `this device's own log would be refused (${detail}); it is not sent`);
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
          this.#log("warn", `the repo refused ${MAX_PUTS} writes of this device's snapshot in a row; trying again on the next trigger`);
          return false;
        }
        await this.#sleep(SYNC_TIMING.retryMs[put - 1] + Math.floor(this.#random() * SYNC_TIMING.jitterMs));
        if (!this.#canCycle()) return false;
        if (err.reason === "branch-race") continue;
        const listing = await this.#relist();
        if (listing === null) return false;
        const check = await this.#ownSnapCheck(listing);
        if (check.fork !== undefined) {
          this.#log("warn", `this device's own snapshot in the repo is not its history (${check.fork}); it syncs on as a new device`);
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
        this.#log("error", `this device's snapshot would be refused (${detail}); its log is not compacted`);
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
  async #epochGenesis(listing?: Listing, blobs?: BlobReads): Promise<SyncState> {
    const version = this.#genesisVersion(listing);
    if (version === null) return this.#genesis!.state;
    const { name, listed } = version;
    const read = await this.#read(name, listed, undefined, undefined, blobs);
    if (!read.ok || read.read.file.kind !== "genesis") throw new Error(`The epoch's genesis can't be read${read.ok ? "" : `: ${read.detail}`}`);
    const state = genesisState(read.read.file.doc);
    this.#genesis = { name, sha: listed.sha, state };
    return state;
  }

  /** The version of the epoch's genesis #epochGenesis reads (the listed one,
   * or else the one this device joined), or null when the one it holds is
   * that version. Throws when this device names none. */
  #genesisVersion(listing?: Listing): { name: string; listed: Listed } | null {
    const meta = this.#meta!;
    const name = repoFileName({ kind: "genesis", epoch: meta.epochKey });
    const listed = listing?.files.get(name);
    const sha = listed?.sha ?? meta.joined[name];
    if (this.#genesis?.name === name && (sha === undefined || this.#genesis.sha === sha)) return null;
    if (sha === undefined) throw new Error("This device hasn't joined its epoch's genesis");
    return { name, listed: listed ?? { file: { kind: "genesis", epoch: meta.epochKey }, sha, size: 0 } };
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
      if (!(err instanceof GitHubNetworkError)) this.#log("error", "sync failed; it will be tried again", err);
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
          ...(r.ab ? { ab: r.ab } : {}),
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
        const notice = await this.#noticeWrites([[`rehome/${device}`, { kind: "rehome", from: meta.deviceId, to: device, message: REHOMED }]]);
        const base = await seal(storedState(next), this.#key);
        this.#assertWritable();
        await this.#mutate(nextMeta, {
          base,
          clearTail: true,
          ownLog: { dropThrough: Number.MAX_SAFE_INTEGER, put: ownLog },
          clearChain: true,
          chain: chainEntries,
          ...(notice ? { notices: notice.writes } : {}),
        });
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
        if (notice) this.#keepNotices(notice.next);
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
    for (const part of streams.states) joinInto(state, part.state);
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
        this.#log("warn", `the restore's genesis got no answer (${written.detail}); it may still land`);
        this.#restoreUnknown = written.epoch;
        this.#restoreState = { state: "pending", epoch: written.epoch };
        this.#emit();
        rememberRestore(written.epoch);
        return { kind: "unknown", epoch: written.epoch };
      }
      if (written.kind === "failed") {
        // A newer epoch listed is the caller's "failed"; which one is the
        // engine's own business.
        const { newer: _newer, newerTooNew: _newerTooNew, ...failed } = written;
        return failed;
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
        this.#log("warn", "the repo couldn't be listed after the restore landed; the reload finds the winner", err);
        return { kind: "restored", epoch, winnerUnknown: true };
      }
      if (now.winner !== null && compareEpochKeys(now.winner, epoch) > 0) {
        // One this device can't open (a file changed outside the app that
        // landed while this ran) is named, with no maker; named only from a
        // full listing, as the cycle does (D26).
        const damaged = now.truncated ? null : await this.#damagedWinner(now.winner, now.sha!, now.size!, now.files.keys());
        if (damaged !== null) {
          // The state says so at once: the caller reloads once it is null
          // again, and must not find it null before the next cycle.
          if (this.#damaged?.path !== damaged.path || this.#damaged.reason !== damaged.reason) this.#damaged = damaged;
          this.#emit();
          return { kind: "replaced", epoch, winner: now.winner, damagedFile: damaged };
        }
        return { kind: "replaced", epoch, winner: now.winner, ...(await this.#madeBy(now.winner, now.sha!)) };
      }
      // A cut listing may leave out a greater epoch (ADR-0008).
      if (now.truncated) {
        this.#log("warn", "GitHub cut the listing after the restore landed; the reload finds the winner");
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
      this.#log("error", "the winning restore's genesis couldn't be read", err);
      return {};
    }
  }

  /** #8's join from a gone epoch (ADR-0008 STAGE-8, owner decision D34):
   * this device's epoch was deleted on GitHub, so it can't sync, and the
   * cycle never moves it on its own (a listing that doesn't count it may
   * only be stale). Asked by the person, with a fresh listing, it switches
   * to the epoch that wins now as a restore's switch does, with the gone
   * epoch's cut {} (section 9.3): everything it held there that the winner
   * doesn't is left behind, this device's own changes as its own group,
   * shown first (D18), so Re-apply brings them in. Nothing is dropped and
   * nothing is written to GitHub but this device's first log in the
   * winner, once the cycle runs.
   * - "notGone": the epoch counts in the listing; nothing to do.
   * - "empty": no ledger in the repo; #8 offers to create one from this
   *   device (createLedger, reason "restore"), then rejoin.
   * - "unknown": GitHub cut the listing short, or a switch got there first;
   *   try again.
   * - "otherKey": the winner is under another passphrase's salt (a racing
   *   create's, or a changed passphrase). This device's records are sealed
   *   with its own key, so it can't carry them over (owner decision D35):
   *   #8 offers a backup of this device, then Forget and join.
   * - "needsUpdate" / "damaged": the winner can't be read here. */
  async rejoin(): Promise<RejoinResult> {
    if (this.#stopped || this.#superseded || !this.#lockHeld || this.#meta === null || this.#remote === null) return Promise.reject(new Error("This device can't join a ledger now"));
    const ref = await this.#head(false);
    if (ref.kind === "empty") return { kind: "empty" };
    if (ref.kind !== "head") return { kind: "unknown" };
    const listing = await this.#list(ref.commitSha, ref.etag);
    if (listing.truncated) return { kind: "unknown" };
    const from = this.#meta.epochKey;
    const names = [...listing.files.keys()];
    const winner = winningEpoch(names);
    if (winner === null) return { kind: "empty" };
    // Only once the cycle has said the epoch is gone (two full listings in
    // a row that don't count it): one listing may be stale, and a switch
    // from an epoch that still counts would leave its groups shown for good.
    if (epochCounted(names, from) || this.#epochGone?.epoch !== from) return { kind: "notGone" };
    const name = repoFileName({ kind: "genesis", epoch: winner });
    const read = await this.#read(name, listing.files.get(name)!);
    if (!read.ok || read.read.file.kind !== "genesis") {
      const problem = read.ok ? "malformed" : read.problem;
      if (problem === "needsUpdate") return { kind: "needsUpdate", epoch: winner };
      if (problem === "foreignKey") return { kind: "otherKey", epoch: winner };
      // Not named as a file to delete or roll back: the winner is the
      // household's ledger, and this device is the one that's gone (as
      // #switchToListed does for a gone device, stage 6).
      return { kind: "damaged", epoch: winner };
    }
    if (!(await this.#switchToListed(listing, winner, true, { rejoin: true }))) return { kind: "unknown" };
    void this.sync();
    return { kind: "joined", epoch: winner };
  }

  /** Whether this device lost a racing create to `winner` (ADR-0008, D32):
   * its own epoch and the winner are both epoch 1, the winner's key the
   * greater; this device never switched (its genesis is based on nothing:
   * a create, or a restore into an empty repo); and no device file of its
   * epoch is listed, so nobody, this device included, has written there. */
  #lostRaceTo(listing: Listing, winner: string): boolean {
    const meta = this.#meta!;
    const from = meta.epochKey;
    const first = (epoch: string) => epoch.startsWith("e000001-");
    return first(winner) && first(from) && compareEpochKeys(winner, from) > 0 && meta.basedOn === undefined && meta.prev === undefined && !epochJoined(listing.files.keys(), from);
  }

  /** Why this device's own genesis was written ("create", or "restore" for
   * a ledger started from a backup), as the listing has it, read once per
   * blob sha; null when it isn't listed or can't be read. */
  async #ownGenesisReason(listing: Listing): Promise<GenesisContent["reason"] | null> {
    const name = repoFileName({ kind: "genesis", epoch: this.#meta!.epochKey });
    const listed = listing.files.get(name);
    if (!listed) return null;
    if (this.#ownReason?.sha === listed.sha) return this.#ownReason.reason;
    const read = await this.#read(name, listed);
    const reason = read.ok && read.read.file.kind === "genesis" ? read.read.file.reason : null;
    this.#ownReason = { sha: listed.sha, reason };
    return reason;
  }

  /** The join of a racing create's winner (ADR-0008, owner decision D32,
   * option A). Two devices created a ledger at the same moment, each under
   * its own passphrase's salt, and this one's lost (EngineState.raceLost):
   * its writes are on this device only. With the household passphrase, the
   * winner's key is derived from the winner's own header (its salt and
   * iterations) and must open the winner's genesis before anything is
   * written. Then, in one transaction, the switch seals everything this
   * device keeps under that key (the new epoch's state, the previous one's
   * in `old`, the groups left behind, the notices) and joins the winner as
   * a rejoin does (D34, D36): every write of this device is offered back as
   * its own group left behind, with the cut {}. A failed transaction
   * changes nothing: the old key still reads the device. Only the tab
   * holding the lock does this; another tab, once it has the lock, can't
   * read the device with the old key (unreadable "undecryptable"), and
   * opens with the key the caller keeps from "joined".
   *
   * A passphrase that doesn't open the winner writes nothing: "otherKey"
   * when it is this device's own passphrase (the two creates used
   * different ones: the way on is a backup of this device, then Forget and
   * join, D35), else "wrongPassphrase". */
  async rekeyAndJoin(passphrase: string): Promise<RekeyResult> {
    if (this.#stopped || this.#superseded || !this.#lockHeld || this.#meta === null || this.#remote === null) return Promise.reject(new Error("This device can't join a ledger now"));
    const ref = await this.#head(false);
    if (ref.kind === "empty") return { kind: "notRaceLost" };
    if (ref.kind !== "head") return { kind: "unknown" };
    const listing = await this.#list(ref.commitSha, ref.etag);
    if (listing.truncated) return { kind: "unknown" };
    const from = this.#meta.epochKey;
    const winner = winningEpoch([...listing.files.keys()]);
    if (winner === null || !this.#lostRaceTo(listing, winner)) return { kind: "notRaceLost" };
    if ((await this.#ownGenesisReason(listing)) !== "create") return { kind: "fromBackup", epoch: winner };
    const name = repoFileName({ kind: "genesis", epoch: winner });
    const listed = listing.files.get(name)!;
    if (listed.size > this.#bounds.read.bytes) return { kind: "damaged", epoch: winner };
    const text = await this.#remote.client.readBlob(listed.sha);
    // Read with this device's key first: only a winner under another salt
    // is a racing create's to join this way.
    const mine = await openRepoFile(listed.file, text, this.#key, undefined, this.#bounds.read);
    if (mine.ok) return { kind: "notRaceLost" };
    if (mine.problem === "needsUpdate") return { kind: "needsUpdate", epoch: winner };
    if (mine.problem !== "foreignKey") return { kind: "damaged", epoch: winner };
    const header = parseHeader(text);
    const key: DeviceKey = { key: await deriveKey(passphrase, header.salt, header.iter), salt: header.salt, iter: header.iter };
    const read = await openRepoFile(listed.file, text, key, undefined, this.#bounds.read);
    if (!read.ok) {
      if (read.problem !== "undecryptable") return { kind: "damaged", epoch: winner };
      return (await this.#isOwnPassphrase(passphrase)) ? { kind: "otherKey", epoch: winner } : { kind: "wrongPassphrase", epoch: winner };
    }
    if (read.read.file.kind !== "genesis") return { kind: "damaged", epoch: winner };
    const file = read.read.file;
    const turn = this.#turn();
    try {
      await turn.ready;
      this.#assertWritable();
      const switched = await this.#switchEpoch(from, { epoch: winner, sha: listed.sha, state: genesisState(file.doc), basedOn: file.basedOn, by: file.by, at: file.at, rejoin: true, rekey: key });
      if (!switched) return { kind: "unknown" };
    } finally {
      turn.end();
    }
    this.#damaged = null;
    this.#raceLost = null;
    this.#notGone();
    this.#emit();
    void this.sync();
    return { kind: "joined", epoch: winner, key };
  }

  /** Whether `passphrase` is the one this device's key was derived from:
   * a probe sealed under the key it derives with this device's salt opens
   * with this device's key. */
  async #isOwnPassphrase(passphrase: string): Promise<boolean> {
    const own = this.#key;
    const candidate: DeviceKey = { key: await deriveKey(passphrase, own.salt, own.iter), salt: own.salt, iter: own.iter };
    try {
      await unseal(await seal({ probe: true }, candidate), own);
      return true;
    } catch {
      return false;
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
        figures: group.figures === true,
        waitsForEntries: this.#waitsForEntries(group, state),
        items: leftBehindItems(group),
      }));
  }

  /** What reapply(id) would apply and skip now, without writing anything. */
  previewReapply(id: string): ReapplyResult {
    const group = this.#leftBehind.get(id);
    if (!group) throw new ApiError(404, ALREADY_RESOLVED);
    return reapplyTo(structuredClone(this.current()), this.#state!, group, { at: this.#now(), by: this.#actor });
  }

  /** Re-apply (section 9.4): one write, at its turn, that puts the group's
   * changes back on the current document and carries its marker, which
   * resolves the group on every device. What can't be applied is skipped
   * and listed. */
  async reapply(id: string): Promise<ReapplyResult> {
    let result = undefined as ReapplyResult | undefined;
    await this.#amend((doc) => {
      const group = this.#leftBehind.get(id);
      if (!group) throw new ApiError(404, ALREADY_RESOLVED);
      // A lock or a module turned off among the figures would make the
      // entries skipped, and lost (D32, D28): the entries go first.
      if (this.#waitsForEntries(group, this.#state!)) throw new ApiError(409, ENTRIES_FIRST);
      result = reapplyTo(doc, this.#state!, group, { at: this.#now(), by: this.#actor });
    }, { resolves: id });
    return result!;
  }

  /** Whether `group` is a figures group (D32) whose entries group is still
   * shown. */
  #waitsForEntries(group: LeftBehindGroup, state: SyncState): boolean {
    if (group.waitsFor === undefined) return false;
    const entries = this.#leftBehind.get(group.waitsFor);
    return entries !== undefined && !this.#isHidden(entries, state);
  }

  /** Discard (section 9.4): an op with only the group's marker. */
  discard(id: string): Promise<void> {
    return this.#amend(() => {
      if (!this.#leftBehind.has(id)) throw new ApiError(404, ALREADY_RESOLVED);
    }, { resolves: id });
  }

  // --- Notices (section 4) -----------------------------------------------------

  /** The notices to review, newest first, each with what its actions would
   * write now (or why they can't): the same array until noticeRevision
   * changes or the day does (in the ledger's time zone). */
  notices(): NoticeView[] {
    const state = this.#state;
    const doc = this.#doc;
    if (state === null || doc === null) return [];
    const env = this.#actionEnv();
    const day = actionDay(env.now, doc.settings.timeZone);
    if (this.#noticeViews?.rev === this.#noticeRev && this.#noticeViews.day === day) return this.#noticeViews.views;
    const views = [...this.#notices]
      .sort(([ka, a], [kb, b]) => b.seq - a.seq || (ka < kb ? -1 : ka > kb ? 1 : 0))
      .map(([key, notice]) => noticeView(key, notice, doc, state, env));
    this.#noticeViews = { rev: this.#noticeRev, day, views };
    return views;
  }

  /** Dismisses a notice on this device (section 4.2). Resolves once it is
   * gone from the device's records, at once when it was already gone. */
  dismissNotice(key: string): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertWritable();
      if (!this.#notices.has(key)) return;
      const writes = await this.#noticeWrites([], [key]);
      if (writes === null) return;
      await this.#mutate(this.#meta!, { notices: writes.writes });
      this.#keepNotices(writes.next);
      this.#emit();
    });
  }

  /** A notice's action (section 4.1): one new write, at its turn, worked out
   * from the document as it is then, never from anything stored. It refuses
   * (an ApiError, nothing written) on a locked month, a module that is off,
   * a record that is deleted or gone ("Add it back" aside), or a ledger that
   * already holds what it would write; the notice then stays. Once the write
   * is saved the notice is gone, in the same transaction. `shown`, what the
   * button showed, must still be what it writes: otherwise it refuses
   * (ShownChanged, 409) and noticeRevision moves, so the list shows what
   * it would write now (a day passed, or the document changed). */
  noticeAction(key: string, kind: NoticeActionKind, shown?: ShownAction): Promise<void> {
    // An add-back records which deleted record it re-made (state.ts ab), so
    // another device told of the same delete doesn't make a second one.
    const told = this.#notices.get(key);
    const addsBack = kind === "addBack" && told?.kind === "deleted" ? `${told.target.coll}/${told.target.id}` : undefined;
    return this.#amend((doc) => {
      const notice = this.#notices.get(key);
      if (!notice) throw new ApiError(404, NOTICE_GONE);
      try {
        applyAction(notice, kind, doc, this.#state!, this.#actionEnv(), shown);
      } catch (err) {
        if (err instanceof ShownChanged) {
          this.#noticeRev++;
          this.#emit();
        }
        throw err;
      }
    }, { settles: key, ...(addsBack !== undefined ? { addsBack } : {}) });
  }

  #actionEnv() {
    return { now: this.#now(), actor: this.#actor, newId: () => crypto.randomUUID(), device: this.#meta!.deviceId };
  }

  /** The notice writes that store `added` (by key) and remove `drop` in a
   * mutation (and store `restored` again as they are, after `drop`): a key
   * already stored is left as it is (a pair is told once),
   * each new one is numbered after the last, and past the cap the oldest
   * go. Null when nothing changes; otherwise the writes, and the notices to
   * keep (#keepNotices) once they commit. */
  async #noticeWrites(added: [key: string, notice: NoticeBody][], drop: string[] = [], restored: [key: string, notice: StoredNotice][] = []): Promise<{ writes: NonNullable<Mutation["notices"]>; next: Map<string, StoredNotice> } | null> {
    const next = new Map(this.#notices);
    for (const key of drop) next.delete(key);
    // Stored again as they are, seq and at kept (a notice trimmed in place).
    for (const [key, notice] of restored) next.set(key, notice);
    let seq = this.#noticeSeq;
    const at = this.#now();
    const fresh: string[] = [];
    for (const [key, body] of added) {
      if (next.has(key) || this.#unreadNotices.has(key)) continue;
      next.set(key, { ...body, seq: ++seq, at } as StoredNotice);
      fresh.push(key);
    }
    const over = overCap(new Map([...next].map(([key, notice]) => [key, notice.seq])));
    for (const key of over) next.delete(key);
    const put = await Promise.all([...restored.map(([key]) => key), ...fresh].filter((key) => next.has(key)).map(async (key): Promise<[string, string]> => [key, await seal(next.get(key)!, this.#key)]));
    const remove = [...drop, ...over].filter((key) => this.#notices.has(key));
    if (put.length === 0 && remove.length === 0) return null;
    return { writes: { put, delete: remove }, next };
  }

  /** `notices` are this device's notices now. */
  #keepNotices(notices: Map<string, StoredNotice>): void {
    this.#notices = notices;
    for (const notice of notices.values()) this.#noticeSeq = Math.max(this.#noticeSeq, notice.seq);
    this.#noticeRev++;
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
   * device can't open it (owner decision D26): damaged outside the app, or
   * a racing create's under another salt, and nothing is written past it;
   * the result names the file (DamagedFile says what to do with it). Nor
   * when the
   * new genesis would fill the gap below such a genesis, which would then
   * count and win (the result names it too). Nor when this
   * device's epoch no longer counts in a full listing (`epochGone`): a
   * restore numbered after it would write past the epoch that won. */
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
    const cutDetail = "GitHub cut the file listing short, so the winning epoch is unknown; try again later";
    if (now.truncated && now.winner !== meta.epochKey) return { kind: "failed", detail: cutDetail };
    const listed = now.winner;
    // This device's epoch no longer counts: a restore based on it, numbered
    // after it, would write past the epoch listed now (a racing create's
    // flip-flop, D26). Join that ledger instead. Checked before a newer
    // winner is named: a device whose epoch is gone gives no advice to
    // delete or roll back the household's newer epoch (stage 6 final
    // review). A cut listing got here only showing this epoch winning.
    if (!now.truncated && !epochCounted(now.files.keys(), meta.epochKey)) {
      const epochGone = { epoch: meta.epochKey, winner: listed };
      return { kind: "failed", detail: epochGoneMessage(epochGone), epochGone };
    }
    if (listed !== null && compareEpochKeys(listed, meta.epochKey) > 0) {
      const damaged = await this.#winnerProblem(listed, now.sha!, now.size!, now.files.keys());
      if (damaged === "needsUpdate") return { kind: "failed", detail: `another restore (${listed}) replaced this device's epoch, and this version of Ledger is too old to read it; update the app`, newer: listed, newerTooNew: true };
      if (damaged !== null) return { kind: "failed", detail: damagedFileMessage(damaged), damagedFile: damaged };
      return { kind: "failed", detail: `another restore (${listed}) replaced this device's epoch; it switches on its next sync, and the restore can be tried again then`, newer: listed };
    }
    const epoch = nextEpochKey(meta.epochKey);
    // The new genesis may fill the gap below a genesis numbered past it,
    // which then counts and wins: one this device can't open would leave
    // the restore "replaced" by a file no device can open. Nothing is
    // written; that file counts for nothing now, so it is named to delete
    // (D26), and the restore goes on once it is gone.
    const after = winningEpoch([...now.files.keys(), repoFileName({ kind: "genesis", epoch })]);
    if (after !== null && after !== epoch) {
      // Nothing is named from a cut listing (ADR-0008), and the cut may
      // have left out what decides which genesis would count.
      if (now.truncated) return { kind: "failed", detail: cutDetail };
      const gap = now.files.get(repoFileName({ kind: "genesis", epoch: after }))!;
      const damaged = await this.#damagedWinner(after, gap.sha, gap.size, now.files.keys());
      if (damaged !== null) return { kind: "failed", detail: damagedFileMessage(damaged), damagedFile: damaged };
    }
    const content: GenesisContent = { epoch, reason: "restore", by: this.#actor, at: this.#now(), basedOn, doc };
    // Every PUT sent counts against the hourly cap, a second one after no
    // answer included (ADR-0008 stage 4).
    const written = await writeGenesis(remote, content, this.#key, this.#bounds.write, () => this.#putTimes.push(this.#monotonic()));
    if (written.kind === "unknown") return { kind: "unknown", epoch, detail: written.detail };
    if (written.kind !== "written") return written;
    return { kind: "written", genesis: { epoch, sha: written.sha, state: genesisState(doc), basedOn, by: content.by, at: content.at } };
  }

  /** Epoch `epoch`'s genesis, listed at blob `sha` in a full listing of
   * `names`, as a damaged file when this device can't open it (D26), else
   * null: it opens, it is too new for this build, or it couldn't be read
   * now. "joined" when a device file of the epoch is listed. A refusal is
   * remembered by name and sha (#read), so the cycle's read is not
   * repeated. */
  async #damagedWinner(epoch: string, sha: string, size: number, names: Iterable<string>): Promise<DamagedFile | null> {
    const problem = await this.#winnerProblem(epoch, sha, size, names);
    return problem === "needsUpdate" ? null : problem;
  }

  /** #damagedWinner, telling a genesis too new for this build apart
   * ("needsUpdate") from one that opens or couldn't be read now (null). */
  async #winnerProblem(epoch: string, sha: string, size: number, names: Iterable<string>): Promise<DamagedFile | "needsUpdate" | null> {
    try {
      const read = await this.#read(repoFileName({ kind: "genesis", epoch }), { file: { kind: "genesis", epoch }, sha, size });
      if (read.ok) return read.read.file.kind === "genesis" ? null : damagedGenesis(epoch, "malformed", epochJoined(names, epoch));
      return read.problem === "needsUpdate" ? "needsUpdate" : damagedGenesis(epoch, read.problem, epochJoined(names, epoch));
    } catch (err) {
      this.#log("error", `the winning genesis ${epoch} couldn't be read`, err);
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
        this.#log("warn", "no Lamport value is left in this epoch; the ledger is restored as the next one");
        let written: RestoreWrite;
        try {
          written = await this.#writeRestore(structuredClone(this.#doc!));
        } catch (err) {
          this.#log("error", "writing the next epoch failed", err);
          throw new ApiError(503, NEEDS_NEW_EPOCH);
        }
        // Not written, or no answer: if that genesis lands after all, the
        // next try finds it listed and the device switches to it first.
        if (written.kind !== "written") {
          this.#log("error", `writing the next epoch failed: ${written.detail}`);
          // No epoch is written past a genesis this device can't open
          // (D26): the write waits until the file is deleted.
          if (written.kind === "failed" && written.damagedFile) throw new ApiError(503, needsNewEpochPast(written.damagedFile));
          if (written.kind === "failed" && written.epochGone) throw new ApiError(503, epochGoneMessage(written.epochGone));
          // Another device already started a newer epoch (it ran out of L
          // too, or restored): the device is online, and switching is what
          // it needs. The switch takes a write turn, so it runs once this
          // write has ended; the next try commits there (stage 8a). Unless
          // this build is too old to read that epoch: it can't switch, and
          // updating the app is the way on (stage 8a review, E4).
          if (written.kind === "failed" && written.newerTooNew) throw new ApiError(503, LEDGER_UPDATED);
          if (written.kind === "failed" && written.newer !== undefined) {
            void this.sync();
            throw new ApiError(503, CHANGED_WHILE_SAVING);
          }
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
   * file is deleted on GitHub and a listing no longer counts it, or, when
   * a device file of that epoch is listed ("joined": deleting it would
   * strand that device), until its previous version is restored.
   *
   * `gone`: this device's own epoch doesn't count in the listing (its
   * genesis, or one below it, was deleted). A winner it can't open is then
   * not named: the device may be the one that lost (a racing create's
   * other creator, whose genesis was deleted), and the winner the
   * household's valid ledger, which no advice may delete or roll back. The
   * state says the epoch is gone (EpochGone) instead, and #8 offers to join
   * the winner. A winner it can open is switched to as always. */
  async #switchToListed(listing: Listing, winner: string, gone: boolean, { rejoin = false }: { rejoin?: boolean } = {}): Promise<boolean> {
    const name = repoFileName({ kind: "genesis", epoch: winner });
    const listed = listing.files.get(name)!;
    const read = await this.#read(name, listed);
    if (!read.ok || read.read.file.kind !== "genesis") {
      const problem = read.ok ? "malformed" : read.problem;
      if (gone) {
        const epoch = this.#meta!.epochKey;
        this.#noteGone(epoch, winner);
        this.#damaged = null;
        // A newer build may open it: updating the app is still a way on.
        if (problem === "needsUpdate") this.#blocker = "needsUpdate";
        this.#log("error", `this device's epoch ${epoch} is gone, and the winner ${winner} can't be read here (${problem}); nothing is named`);
        return false;
      }
      this.#notGone();
      this.#blocker = problem === "needsUpdate" ? "needsUpdate" : problem === "malformed" ? "needsAttention" : "needsPassphrase";
      // The other creator of a racing create won (D32): rekeyAndJoin can
      // join it with the household passphrase.
      const raced = problem === "foreignKey" && this.#lostRaceTo(listing, winner);
      const joinable = raced && (await this.#ownGenesisReason(listing)) === "create";
      if (!raced) this.#raceLost = null;
      else if (this.#raceLost?.winner !== winner || this.#raceLost.joinable !== joinable) this.#raceLost = { winner, joinable };
      // Another device already joined it: never named as one to delete.
      const damaged = problem === "needsUpdate" ? null : damagedGenesis(winner, problem, epochJoined(listing.files.keys(), winner));
      // The same object while nothing changes, so no listener is told again.
      if (damaged === null || this.#damaged?.path !== damaged.path || this.#damaged.reason !== damaged.reason) this.#damaged = damaged;
      this.#log("error", `a restore's epoch ${winner} can't be read (${problem}); this device stays where it is and sends nothing more`);
      return false;
    }
    this.#damaged = null;
    this.#notGone();
    const file = read.read.file;
    const from = this.#meta!.epochKey;
    // The line's cuts depend only on the listing and the geneses, so they
    // are read before the write turn: local writes never wait on these
    // GETs (stage 8a review, E3). A switch that happened meanwhile makes
    // #adoptEpoch answer false, as it would for any other.
    const basedOnFrom = this.#meta!.basedOn;
    const line = file.basedOn !== null && file.basedOn.epoch !== from ? await this.#lineCuts(listing, file.basedOn, basedOnFrom === undefined ? [from] : [from, basedOnFrom]) : undefined;
    const turn = this.#turn();
    try {
      await turn.ready;
      this.#assertWritable();
      const switched = await this.#switchEpoch(from, { epoch: winner, sha: listed.sha, state: genesisState(file.doc), basedOn: file.basedOn, by: file.by, at: file.at, ...(line ? { line } : {}), ...(rejoin ? { rejoin: true as const } : {}) });
      // The cycle reads and records for the epoch it switched to.
      // A rejoin's switch leaves a running cycle labelled with the epoch it
      // read, so nothing that cycle read is joined into the new one.
      if (switched && !rejoin && this.#cycleFor !== null) this.#cycleFor = this.#identity();
      return switched;
    } finally {
      turn.end();
    }
  }

  /** The cut each epoch in a restore's line was left behind with, walking
   * `basedOn` down through the listed geneses: `basedOn.epoch` with
   * `basedOn.seen`, then the epoch that one's genesis is based on with its
   * cut, and so on. A switch uses only the cuts of `needed` (the epoch it
   * switches from and meta.basedOn: the one that epoch is based on, or the
   * kept epoch standing for it), so the walk stops
   * once it reaches one of them (numbers fall down a line, so the other
   * can't follow: an epoch's base has a smaller number) or passes below
   * both. It also stops at a genesis that isn't listed or can't be read (a
   * needed cut not found then falls back to {}, which may offer more but
   * loses nothing), and after as many steps as geneses are listed. Read
   * only when a device switches to a restore not based on its own epoch:
   * one GET for each epoch in the line above the first needed one. */
  async #lineCuts(listing: Listing, basedOn: NonNullable<GenesisContent["basedOn"]>, needed: readonly string[]): Promise<Map<string, VersionVector>> {
    const cuts = new Map<string, VersionVector>();
    let next: GenesisContent["basedOn"] = basedOn;
    for (let steps = 0; next !== null && !cuts.has(next.epoch) && steps < listing.files.size; steps++) {
      const epoch = next.epoch;
      cuts.set(epoch, next.seen);
      if (needed.includes(epoch) || needed.every((e) => compareEpochKeys(epoch, e) < 0)) break;
      const name = repoFileName({ kind: "genesis", epoch });
      const listed = listing.files.get(name);
      if (!listed) break;
      try {
        const read = await this.#read(name, listed);
        if (!read.ok || read.read.file.kind !== "genesis") break;
        next = read.read.file.basedOn;
      } catch (err) {
        this.#log("warn", `the genesis of ${epoch} couldn't be read for its restore cut; what this device had there is offered with the cut {}`, err);
        break;
      }
    }
    return cuts;
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
   * effect there (the losing genesis included) is not in the winner. A
   * genesis based on an epoch this device skipped (neither `from` nor one
   * kept) re-projects the epoch `from` was based on with its cut in the
   * winner's line ({} when that can't be read), unless the line passes
   * through `from`. */
  async #adoptEpoch(from: string, genesis: NewEpoch): Promise<boolean> {
    this.#assertWritable();
    const meta = this.#meta!;
    if (meta.epochKey !== from) return false;
    const pre = this.#state!;
    const into = { epoch: genesis.epoch, by: genesis.by, at: genesis.at, state: genesis.state };
    const basedOn = genesis.basedOn;
    // Groups shown now are carried, less what the new genesis already holds
    // (the projection's rule): a marker joined here never reaches the new
    // epoch, so nothing else would hide one the genesis took in.
    const groups = new Map<string, LeftBehindGroup>();
    for (const [marker, group] of this.#leftBehind) {
      const carried = this.#isHidden(group, pre) ? null : genesis.rejoin ? group : withoutHeld(group, genesis.state);
      if (carried !== null) groups.set(marker, carried);
    }
    const kept = await this.#readOld();
    // The new genesis is based on an epoch this device never joined, nor
    // kept (E1 -> E2a, then E3 based on E2b, which beat E2a while this
    // device was away): what E2a's genesis held (E1's state at E2a's cut)
    // is projected nowhere else, and E2b's cut of E1 is unknown here. So
    // the epoch `from` was based on (meta.basedOn, kept in `old`) is
    // projected again with the cut {}: it may offer more than E2b left
    // out, but loses nothing (stage 6 final review).
    // Since stage 8a the cut is read from the skipped epoch's line when it
    // can be (genesis.line), and is {} only when it can't. meta.basedOn is
    // the anchor (below): when the switch into `from` skipped its base too,
    // the epoch this device kept in `from`'s line, not that base.
    // A winner whose line passes through `from` holds what `from`'s genesis
    // took in, so the epoch `from` was based on needs no new projection:
    // its groups were projected with that same cut on the switch into
    // `from`, and are carried (stage 8a review, E3; the line's walk stops
    // at `from`).
    const line = genesis.line ?? new Map<string, VersionVector>();
    const skipped = basedOn === null || (basedOn.epoch !== from && !kept.some((entry) => entry.epoch === basedOn.epoch));
    const fallback = skipped && !line.has(from) && !genesis.rejoin ? meta.basedOn : undefined;
    // A rejoin projects no kept epoch again (D36): what this device kept
    // from them stays as it was carried.
    const cutFor = (epoch: string): VersionVector | null => (genesis.rejoin ? null : basedOn !== null && basedOn.epoch === epoch ? basedOn.seen : epoch === fallback ? (line.get(epoch) ?? {}) : null);
    for (const entry of kept) {
      const cut = cutFor(entry.epoch);
      if (cut === null || entry.epoch === from) continue;
      // The winner's cut (or {}, for the epoch a skipped one was based
      // on) decides what of this epoch is left behind. Another
      // device's group the losing epoch resolved stays resolved. This
      // device's own group never is on that word alone: a group shown now
      // stays unless the projection decides it.
      // Never in place of this device's own group under the same marker
      // (its former device id, after a revisit): a projection of what the
      // repo has can hold less than what this device kept unpushed.
      const projected = leftBehind(entry.state, cut, into, { epoch: entry.epoch, me: entry.device })
        .filter((group) => group.own || !pre.ra.has(group.marker))
        .filter((group) => group.own || groups.get(group.marker)?.own !== true);
      const replaced = new Set(projected.map((group) => group.marker));
      // The projection decides this device's own group of the epoch when it
      // read the state that group came from (the same device id): that
      // state holds every own op there, unpushed ones included, so what it
      // no longer offers is under the winner's cut, held by the winner's
      // line. Offering it still would offer a change the restore already
      // took in, or superseded (#7 follow-up, harness seed 140010). An own
      // group under a former device id is decided by nothing here, and
      // stays.
      const decided = (group: LeftBehindGroup) => !group.own || replaced.has(group.marker) || group.device === entry.device;
      for (const [marker, group] of [...groups]) if (marker.startsWith(`${entry.epoch}/`) && decided(group)) groups.delete(marker);
      for (const group of projected) groups.set(group.marker, group);
    }
    for (const group of leftBehind(pre, genesis.rejoin ? {} : (cutFor(from) ?? line.get(from) ?? {}), into, { epoch: from, me: meta.deviceId }, { all: genesis.rejoin === true })) {
      if (!group.own && groups.get(group.marker)?.own === true) continue;
      // Joining a racing create's winner (D32): this device's month figures
      // and settings are a group of their own, so getting its entries back
      // never writes over the figures the winner has for those months.
      if (genesis.rekey && group.own) {
        const [entries, figures] = splitFigures(group, newDeviceId());
        if (entries) groups.set(entries.marker, entries);
        if (figures) groups.set(figures.marker, figures);
        continue;
      }
      groups.set(group.marker, group);
    }
    // The epoch switched from is kept even with no group: a restore that
    // raced this one, based on it with another cut, may leave something of
    // it behind. So is the anchor, for a restore of the same number based
    // on the same epoch with another cut (E1 -> E2a -> E2b -> E2c, all
    // based on E1). An earlier one is kept only while a group from it is.
    // The anchor (meta.basedOn from now on) is the epoch this device kept
    // that the new genesis's line reaches first: the one it is based on,
    // unless this device never joined that one. A device that skipped it
    // holds that line only through the epoch it just projected with the
    // line's cut: `from` when the line passes through it, else the
    // fallback. A racing restore based on the same skipped epoch leaves
    // behind what this one's genesis took in, so the anchor is projected
    // again then, as the fallback (#7 follow-up, harness seed 150178: named
    // after the skipped epoch, which is never in `old`, it projected
    // nothing, and an own change only the losing genesis held was offered
    // nowhere).
    const anchor = basedOn === null ? undefined : skipped && !genesis.rejoin ? (fallback ?? from) : basedOn.epoch;
    const hasGroups = (epoch: string) => [...groups.keys()].some((marker) => marker.startsWith(`${epoch}/`));
    const keep = (epoch: string) => epoch !== from && (epoch === anchor || hasGroups(epoch));
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
      ...(anchor !== undefined ? { basedOn: anchor } : {}),
      ...(genesis.rekey ? { sealedWith: { salt: genesis.rekey.salt, iter: genesis.rekey.iter } } : meta.sealedWith ? { sealedWith: meta.sealedWith } : {}),
    };
    // Rekeying (D32): everything kept is sealed under the new key in this
    // one transaction, the notices included; one this build can't read
    // stays as it is (it reads under no key here).
    const key = genesis.rekey ?? this.#key;
    const base = await seal(storedState(next), key);
    const oldText = olds.length > 0 ? await seal(storedOld(olds), key) : null;
    const put = await Promise.all([...groups.values()].map(async (group): Promise<[string, string]> => [group.marker, await seal(group, key)]));
    const remove = [...this.#leftBehind.keys()].filter((marker) => !groups.has(marker));
    const notices = genesis.rekey ? await Promise.all([...this.#notices].map(async ([id, notice]): Promise<[string, string]> => [id, await seal(notice, key)])) : [];
    this.#assertWritable();
    await this.#mutate(nextMeta, {
      base,
      clearTail: true,
      ownLog: { dropThrough: Number.MAX_SAFE_INTEGER },
      clearChain: true,
      old: oldText,
      leftBehind: { put, delete: remove },
      ...(notices.length > 0 ? { notices: { put: notices } } : {}),
    });
    if (genesis.rekey) {
      this.#key = genesis.rekey;
      // Refusals were judged under the old key.
      this.#refused.clear();
    }

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
    this.#log("info", `a restore started epoch ${genesis.epoch}; this device switched to it as a new device, with ${groups.size} groups of changes left behind`);
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
      this.#log("warn", "the previous epochs' saved states can't be read; their groups stay as they are", err);
      return null;
    }
  }

  /** The `old` record to keep once only the groups `markers` are left:
   * the epoch this device last switched from (meta.prev) and the one its
   * epoch's genesis is based on, or the anchor standing for it (meta.basedOn,
   * see #adoptEpoch), are kept even with no group,
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
   * never pushed. */
  #isHidden(group: LeftBehindGroup, state: SyncState): boolean {
    if (!state.ra.has(group.marker)) return false;
    return !group.own || inEffect(group, state);
  }

  /** Counts the groups shown, and (unless `tidy` is false) drops the
   * hidden ones from the device. */
  #refreshLeftBehind(tidy = true): void {
    const state = this.#state;
    let shown = 0;
    let own = 0;
    let hidden = false;
    if (state !== null) {
      for (const group of this.#leftBehind.values()) {
        if (this.#isHidden(group, state)) hidden = true;
        else {
          shown++;
          if (group.own) own++;
        }
      }
    }
    this.#leftBehindCount = shown;
    this.#leftBehindOwnCount = own;
    if (hidden && tidy) this.#tidyLeftBehind();
  }

  /** Drops the groups no longer shown, and the old states no group needs
   * (#oldKeeping), in one transaction. Housekeeping: a failure is only
   * logged, and the next refresh tries again. */
  #tidyLeftBehind(): void {
    if (this.#tidying) return;
    this.#tidying = true;
    this.#enqueue(async () => {
      try {
        this.#assertWritable();
        const state = this.#state!;
        const hidden = [...this.#leftBehind.values()].filter((group) => this.#isHidden(group, state)).map((group) => group.marker);
        if (hidden.length === 0) return;
        const old = await this.#oldKeeping([...this.#leftBehind.keys()].filter((marker) => !hidden.includes(marker)));
        this.#assertWritable();
        await this.#mutate(this.#meta!, { leftBehind: { delete: hidden }, ...(old !== undefined ? { old } : {}) }, true);
        for (const marker of hidden) this.#leftBehind.delete(marker);
        if (old !== undefined) this.#oldText = old;
      } finally {
        this.#tidying = false;
      }
    }).catch((err: unknown) => this.#log("warn", "tidying the changes restores left behind failed; it will be tried again", err));
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
      this.#log("error", "a save on this device failed; nothing from it was kept", err);
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
    }).catch((err: unknown) => this.#log("warn", "compacting this device's saved changes failed; it will be tried again", err));
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
        this.#log("error", "the saved sync state could not be loaded; it is kept as it is", err);
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
        this.#log("warn", "the saved sync state kept changing while it was loaded; it is kept as it is");
        this.#fail("loadFailed");
        return;
      }
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
      this.#log("error", "could not claim this device's sync state; writes are refused until a claim is saved", err);
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
    this.#unreadNotices = loaded.unreadNotices;
    this.#keepNotices(loaded.notices);
    // Counted only: hidden groups are dropped by the next refresh, once the
    // load has finished.
    this.#refreshLeftBehind(false);
    this.#needsInit = false;
    this.#unreadable = null;
    this.#setStatus("idle");
  }

  #fail(reason: UnreadableReason): void {
    this.#meta = this.#state = this.#doc = null;
    this.#leftBehind = new Map();
    this.#oldText = null;
    this.#unreadNotices = new Set();
    this.#keepNotices(new Map());
    this.#refreshLeftBehind(false);
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
    // Sealed under another key (a join of a racing create's winner, D32):
    // nothing is decrypted, and the state says which key it needs.
    const sealed = check.ok ? check.meta.sealedWith : undefined;
    if (sealed !== undefined && (sealed.salt !== this.#key.salt || sealed.iter !== this.#key.iter)) {
      this.#keyNeeded = { salt: sealed.salt, iter: sealed.iter };
      this.#log("error", "the saved sync state is sealed under another key than this tab's");
      return "keyChanged";
    }
    if (!check.ok) {
      this.#log("error", `the saved sync state can't be used: ${check.detail}`);
      return check.problem;
    }
    const meta = check.meta;
    const malformed = (detail: string): UnreadableReason => {
      this.#log("error", `the saved sync state can't be used: ${detail}`);
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
      // A notice this build can't read (a newer build's, or damaged) holds
      // no data: it is left in the store as it is, out of memory and the
      // UI, and the device loads (owner decision D31). A left-behind group
      // above holds changes, so it keeps the strict rule.
      const notices = new Map<string, StoredNotice>();
      const unreadNotices = new Set<string>();
      for (const [key, text] of records.notices) {
        let notice: StoredNotice | null = null;
        try {
          notice = checkNotice(await this.#open(text));
        } catch (err) {
          if (!(err instanceof Undecryptable)) throw err;
        }
        if (notice === null) {
          this.#log("warn", `a stored notice can't be read, so it is kept as it is and not shown: ${key}`);
          unreadNotices.add(key);
          continue;
        }
        notices.set(key, notice);
      }
      // The previous epochs' states are read now, like the groups: one that
      // can't be read is unreadable (section 12, B13), never dropped later
      // or written over by the next switch.
      if (records.old !== undefined) {
        const old = decodeOld(await this.#open(records.old));
        if (typeof old === "string") return malformed(old);
      }
      return { meta, state, doc: materialize(state), ownLog, chainHead, tailCount: records.tail.length, leftBehind, notices, unreadNotices, old: records.old ?? null };
    } catch (err) {
      if (err instanceof Undecryptable) {
        this.#log("error", "the saved sync state doesn't decrypt with this device's key", err);
        return "undecryptable";
      }
      this.#log("error", "the saved sync state can't be used", err);
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
          this.#log("error", "could not take the tab lock", err);
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
      noticeCount: this.#notices.size,
      noticeRevision: this.#noticeRev,
      leftBehindCount: this.#leftBehindCount,
      leftBehindOwnCount: this.#leftBehindOwnCount,
      damagedFile: this.#damaged,
      epochGone: this.#epochGone,
      raceLost: this.#damaged === null ? null : this.#raceLost,
      keyNeeded: this.#unreadable === "keyChanged" ? this.#keyNeeded : null,
      restore: this.#restoreState,
    };
  }

  #emit(): void {
    if (this.#doc !== this.#emittedDoc) {
      this.#emittedDoc = this.#doc;
      this.#noticeRev++;
    }
    const next = this.#makeSnapshot();
    const prev = this.#snapshot;
    if ((Object.keys(next) as (keyof EngineState)[]).every((key) => next[key] === prev[key])) return;
    this.#snapshot = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
