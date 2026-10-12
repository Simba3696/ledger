import { InvalidFileError, WrongPassphraseError, decryptDocument, parseHeader } from "../crypto";
import type { LedgerDocument } from "../document/types";
import { isWritableDocument } from "../document/validate";
import {
  GitHubAuthError,
  GitHubForbiddenError,
  GitHubRateLimitError,
  RepoNotFoundError,
  ShaConflictError,
  gitBlobSha,
  type GitHubClient,
} from "../github/contents";
import { forgetDevice } from "../github/deviceStore";
import { FORMAT_VERSION, checkRepoFile } from "./codec";
import { compareEpochKeys, nextEpochKey, repoFileName, winningEpoch, type RepoFile } from "./epoch";
import { clearSyncState } from "./persist";
import { seal, type DeviceKey } from "./records";
import { LEDGER_DIR, READ_BOUNDS, openRepoFile, plainSize, repoPath, type FileBounds } from "./repoFiles";
import { genesisState, type SyncState } from "./state";
import type { VersionVector } from "./tags";

// The epoch hooks onboarding (#8) and backup (#9) call (design sections 9.2
// and 9.5), outside the sync engine:
//
//   - "Is there a ledger?" is a listing of ledger/ that holds a counted
//     genesis (findLedger). Join reads that genesis's header for the salt
//     and iterations to derive the key from the passphrase, then opens the
//     genesis with the key (openGenesis), which the engine's first start
//     takes as its state.
//   - Create is one genesis PUT for epoch 1 (createLedger), then a listing:
//     a racing create's greater epoch 1 wins, and is joined instead.
//     Restoring a backup into a repo with no ledger is the same PUT with
//     reason "restore". Restoring over an existing ledger is the engine's
//     (SyncEngine.restore), which needs what the device has seen.
//   - A genesis is written under a fresh random name, never over a file. A
//     lost answer is settled by listing the path: the sha of the bytes sent
//     there means it landed; otherwise it is sent once more, then reported
//     as failed (writeGenesis).
//   - Export is the current document sealed in the repo files' format; a
//     backup opens with the same key (readBackup).
//   - Forget this device clears the sync state and the device's key and
//     connection, and writes nothing to GitHub (forgetThisDevice). It
//     refuses, unless forced, while own changes are unsynced or own changes
//     a restore left behind are unresolved.

/** The repo as these hooks read and write it. */
interface Remote {
  client: Pick<GitHubClient, "getRef" | "listDir" | "readBlob" | "putFile">;
  /** The repo's default branch (verifyRepo). */
  branch: string;
}

/** What the repo holds. */
export type LedgerFound =
  /** No counted genesis: no ledger yet (an empty repo included). */
  | { kind: "none" }
  /** GitHub cut the listing short before any genesis: try again later. */
  | { kind: "unknown" }
  /** The winning epoch's genesis, as text, and the salt and iterations its
   * header names: what the passphrase is derived with. */
  | { kind: "ledger"; epoch: string; name: string; sha: string; text: string; salt: string; iter: number }
  /** The winning genesis has a header this build can't read: a newer
   * build wrote it ("needsUpdate"), or it is damaged ("malformed"). */
  | { kind: "needsUpdate" | "malformed"; epoch: string };

/** The listing of ledger/ at the branch head now, or null for an empty
 * repo. */
async function listNow(remote: Remote): Promise<{ names: string[]; files: Map<string, { sha: string; size: number }>; truncated: boolean } | null> {
  const ref = await remote.client.getRef(remote.branch, null);
  if (ref.kind !== "head") return null;
  const listing = await remote.client.listDir(ref.commitSha, LEDGER_DIR);
  const files = new Map(listing.files.map((f) => [f.name, { sha: f.sha, size: f.size }]));
  return { names: [...files.keys()], files, truncated: listing.truncated };
}

/** The winning epoch in a listing of the repo now (section 9.1). */
export interface EpochNow {
  /** The greatest counted epoch listed, or null when none is. */
  winner: string | null;
  /** GitHub cut the listing short: a greater epoch may be left out, so
   * `winner` alone decides nothing (ADR-0008). A greater one listed is
   * there all the same. */
  truncated: boolean;
}

/** The winning epoch in the repo now (section 9.1), and whether the
 * listing it comes from was cut. */
export async function winningEpochNow(remote: Remote): Promise<EpochNow> {
  const listing = await listNow(remote);
  if (listing === null) return { winner: null, truncated: false };
  return { winner: winningEpoch(listing.names), truncated: listing.truncated };
}

/** "Is there a ledger?" (#8): the winning genesis and its header. */
export async function findLedger(remote: Remote): Promise<LedgerFound> {
  const listing = await listNow(remote);
  if (listing === null) return { kind: "none" };
  const epoch = winningEpoch(listing.names);
  if (epoch === null) return listing.truncated ? { kind: "unknown" } : { kind: "none" };
  const name = repoFileName({ kind: "genesis", epoch });
  const { sha, size } = listing.files.get(name)!;
  if (size > READ_BOUNDS.bytes) return { kind: "malformed", epoch };
  const text = await remote.client.readBlob(sha);
  const newline = text.indexOf("\n");
  try {
    const raw = JSON.parse(newline < 0 ? text : text.slice(0, newline)) as { v?: unknown } | null;
    if (Number.isSafeInteger(raw?.v) && (raw!.v as number) > 1) return { kind: "needsUpdate", epoch };
    const header = parseHeader(text);
    return { kind: "ledger", epoch, name, sha, text, salt: header.salt, iter: header.iter };
  } catch {
    return { kind: "malformed", epoch };
  }
}

/** A genesis opened with a key, or why it can't be. */
export type GenesisOpen =
  | { ok: true; epoch: string; sha: string; state: SyncState; doc: LedgerDocument }
  | { ok: false; problem: "wrongPassphrase" | "needsUpdate" | "malformed" };

/** Opens the genesis findLedger found with the household key: the state a
 * first start begins from (SyncEngine.initialize). A key that doesn't fit
 * is a wrong passphrase, since only the genesis can say so (section 12). */
export async function openGenesis(found: Extract<LedgerFound, { kind: "ledger" }>, key: DeviceKey): Promise<GenesisOpen> {
  const read = await openRepoFile({ kind: "genesis", epoch: found.epoch }, found.text, key);
  if (!read.ok) {
    const problem = read.problem === "needsUpdate" || read.problem === "malformed" ? read.problem : "wrongPassphrase";
    return { ok: false, problem };
  }
  if (read.read.file.kind !== "genesis") return { ok: false, problem: "malformed" };
  const doc = read.read.file.doc;
  return { ok: true, epoch: found.epoch, sha: found.sha, state: genesisState(doc), doc };
}

/** A genesis file's content (section 6). */
export interface GenesisContent {
  epoch: string;
  reason: "create" | "restore";
  /** The login that wrote it, and when (display only). */
  by: string;
  at: number;
  /** The restore cut (section 9.2), or null for a create or a restore into
   * a repo with no ledger. */
  basedOn: { epoch: string; seen: VersionVector } | null;
  doc: LedgerDocument;
}

export type GenesisWrite =
  | { kind: "written"; sha: string }
  /** Past the bounds a device writes within: every reader would refuse it. */
  | { kind: "tooLarge"; detail: string }
  /** It didn't land (a 409 or 422, or no answer twice). */
  | { kind: "failed"; detail: string };

/** Half the read bounds, as for every file a device writes (ADR-0008). */
const WRITE_BOUNDS: FileBounds = { bytes: Math.floor(READ_BOUNDS.bytes / 2), plainBytes: Math.floor(READ_BOUNDS.plainBytes / 2) };

/** An answer that says the PUT was not applied and won't be on a retry:
 * the token or the repo, or a rate limit. Thrown to the caller. */
function isFinal(err: unknown): boolean {
  return err instanceof GitHubAuthError || err instanceof GitHubForbiddenError || err instanceof GitHubRateLimitError || err instanceof RepoNotFoundError;
}

/** Writes a new epoch's genesis (sections 9.2 step 5 and 9.5) under its
 * fresh name, with no sha, in the household key's salt and iterations.
 * Checked first with the validator every reader runs and against the write
 * bounds. A lost answer is settled by listing the path; a branch race or no
 * answer is sent once more; a stale-sha answer (the name is taken) is a
 * failure. Throws for a token, repo or rate-limit answer. */
export async function writeGenesis(remote: Remote, content: GenesisContent, key: DeviceKey, bounds: FileBounds = WRITE_BOUNDS): Promise<GenesisWrite> {
  const file: RepoFile = { kind: "genesis", epoch: content.epoch };
  const plain = { fv: FORMAT_VERSION, kind: "genesis", ...content };
  const check = checkRepoFile(file, plain);
  if (!check.ok) throw new Error(`The genesis would be refused: ${check.detail}`);
  const size = plainSize(plain);
  if (size > bounds.plainBytes) return { kind: "tooLarge", detail: `${size} bytes of JSON, more than ${bounds.plainBytes}` };
  const text = await seal(plain, key);
  if (text.length > bounds.bytes) return { kind: "tooLarge", detail: `${text.length} bytes, more than ${bounds.bytes}` };
  const sha = await gitBlobSha(text);
  const path = repoPath(file);
  const message = content.reason === "create" ? "Create ledger" : "Restore from backup";
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await remote.client.putFile({ path, text, sha: null, message });
      return { kind: "written", sha: res.sha };
    } catch (err) {
      if (isFinal(err)) throw err;
      // Did it land? Only these bytes can be there under this name.
      let listed: string | undefined;
      try {
        listed = (await listNow(remote))?.files.get(repoFileName(file))?.sha;
      } catch {
        listed = undefined;
      }
      if (listed === sha) return { kind: "written", sha };
      const detail = err instanceof Error ? err.message : String(err);
      if (attempt >= 2 || (err instanceof ShaConflictError && err.reason === "stale-sha")) return { kind: "failed", detail };
    }
  }
}

export type CreateResult =
  | { kind: "created"; epoch: string; sha: string; state: SyncState }
  /** The repo already holds a ledger (or one this build can't read): join
   * it instead. */
  | { kind: "exists" }
  /** Another device's create landed beside this one and wins (a greater
   * epoch 1 is listed after this one landed): join the winner instead
   * (findLedger). Nothing was started on this device. */
  | { kind: "replaced"; epoch: string; winner: string }
  /** A cut listing, or this create landed but the repo couldn't be listed
   * in full after it: try again later, and the next try joins what it
   * finds. */
  | { kind: "unknown" }
  | Exclude<GenesisWrite, { kind: "written" }>;

/** #8 Create, and #9's restore into a repo with no ledger: one genesis PUT
 * for epoch 1 (section 9.5), `doc` an empty document or the backup, under
 * `key` (the household's, or a backup's own salt and iterations). Returns
 * the state the engine's first start begins from. Two devices creating at
 * once each write their own epoch 1, and the greater key wins. Each derived
 * its key with a fresh salt, so a device started on the losing epoch could
 * never read the winner's files, nor offer its writes. So the repo is
 * listed again once the genesis lands (as a restore's step 6 does): a
 * greater epoch 1 listed is "replaced", and the caller joins the winner
 * before anything is written on this device. A create that listed before
 * the winner's landed is still told "created" (ADR-0008, design
 * questions). */
export async function createLedger(
  remote: Remote,
  key: DeviceKey,
  { doc, by, at, reason = "create" }: { doc: LedgerDocument; by: string; at: number; reason?: GenesisContent["reason"] },
): Promise<CreateResult> {
  if (!isWritableDocument(doc)) throw new Error("A ledger can only be created from a writable document");
  const found = await findLedger(remote);
  if (found.kind === "unknown") return found;
  if (found.kind !== "none") return { kind: "exists" };
  const epoch = nextEpochKey(null);
  const written = await writeGenesis(remote, { epoch, reason, by, at, basedOn: null, doc }, key);
  if (written.kind !== "written") return written;
  let now: EpochNow;
  try {
    now = await winningEpochNow(remote);
  } catch (err) {
    if (isFinal(err)) throw err;
    // It landed, but whether another create beat it is unknown: the next
    // try finds the ledger, this one or the winner, and joins it.
    return { kind: "unknown" };
  }
  if (now.winner !== null && compareEpochKeys(now.winner, epoch) > 0) return { kind: "replaced", epoch, winner: now.winner };
  // A cut listing may leave out a greater epoch 1 (ADR-0008): as unknown as
  // no listing at all.
  if (now.truncated) return { kind: "unknown" };
  return { kind: "created", epoch, sha: written.sha, state: genesisState(doc) };
}

/** What a backup file opens to. */
export type BackupOpen = { ok: true; doc: LedgerDocument } | { ok: false; problem: "wrongPassphrase" | "newer" | "damaged" };

/** Opens an exported backup (SyncEngine.exportBackup) with `key`: the
 * document, checked whole (isWritableDocument), ready to restore. */
export async function readBackup(text: string, key: CryptoKey): Promise<BackupOpen> {
  let doc: unknown;
  try {
    const newline = text.indexOf("\n");
    const raw = JSON.parse(newline < 0 ? text : text.slice(0, newline)) as { v?: unknown } | null;
    if (Number.isSafeInteger(raw?.v) && (raw!.v as number) > 1) return { ok: false, problem: "newer" };
    doc = await decryptDocument(text, key, { maxPlainBytes: READ_BOUNDS.plainBytes });
  } catch (err) {
    if (err instanceof WrongPassphraseError) return { ok: false, problem: "wrongPassphrase" };
    if (err instanceof InvalidFileError || err instanceof SyntaxError) return { ok: false, problem: "damaged" };
    throw err;
  }
  const version = (doc as { version?: unknown } | null)?.version;
  if (Number.isSafeInteger(version) && (version as number) > 1) return { ok: false, problem: "newer" };
  return isWritableDocument(doc) ? { ok: true, doc } : { ok: false, problem: "damaged" };
}

// --- After a restore -----------------------------------------------------------

/** sessionStorage key: the epoch this tab's restore wrote, so "Sam's restore
 * replaced yours" survives the reload after it (section 9.2 step 7). */
const RESTORED_KEY = "ledger:restored";

function session(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Remembers the epoch a restore wrote, for the reload after it. */
export function rememberRestore(epoch: string): void {
  try {
    session()?.setItem(RESTORED_KEY, epoch);
  } catch {
    // Storage refused: the message is lost, nothing else.
  }
}

/** The epoch a restore in this tab wrote before the reload, once: compare
 * it with the epoch the engine ends on (SyncEngine.epochKey) to tell "your
 * restore replaced the ledger" from "Sam's restore replaced yours". */
export function takeRestoredEpoch(): string | null {
  try {
    const storage = session();
    const epoch = storage?.getItem(RESTORED_KEY) ?? null;
    storage?.removeItem(RESTORED_KEY);
    return epoch;
  } catch {
    return null;
  }
}

// --- Forget this device ----------------------------------------------------------

/** What "Forget this device" needs from a running engine: its unsynced
 * count, its own groups a restore left behind, and a sync now. */
interface Syncing {
  syncNow(): Promise<void>;
  getState(): { pendingCount: number; leftBehindOwnCount: number };
}

/** "Forget this device" (section 9.5): with changes not yet in the repo, a
 * sync first, and if any are still unsynced, nothing is forgotten unless
 * `force` (the person chose to drop them). This device's own changes that a
 * restore left behind and that it hasn't re-applied or discarded hold it
 * back too: they are kept only on this device (owner decision D18), and no
 * sync sends them. Then this device's sync state, key and connection go.
 * Nothing is written to GitHub. */
export async function forgetThisDevice(
  engine: Syncing | null,
  { force = false }: { force?: boolean } = {},
): Promise<{ ok: true } | { ok: false; pendingCount: number; leftBehindOwnCount: number }> {
  if (engine && !force) {
    if (engine.getState().pendingCount > 0) await engine.syncNow();
    const { pendingCount, leftBehindOwnCount } = engine.getState();
    if (pendingCount > 0 || leftBehindOwnCount > 0) return { ok: false, pendingCount, leftBehindOwnCount };
  }
  await clearSyncState();
  await forgetDevice();
  return { ok: true };
}
