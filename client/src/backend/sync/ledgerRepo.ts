import { InvalidFileError, WrongPassphraseError, decryptDocument, parseHeader } from "../crypto";
import type { LedgerDocument } from "../document/types";
import { isWritableDocument } from "../document/validate";
import {
  GitHubAuthError,
  GitHubError,
  GitHubForbiddenError,
  GitHubRateLimitError,
  RepoNotFoundError,
  ShaConflictError,
  gitBlobSha,
  type GitHubClient,
} from "../github/contents";
import { forgetDevice } from "../github/deviceStore";
import { FORMAT_VERSION, checkRepoFile } from "./codec";
import { compareEpochKeys, epochJoined, nextEpochKey, repoFileName, winningEpoch, type RepoFile } from "./epoch";
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
//     a greater epoch listed (a racing create's) wins, and is joined
//     instead.
//     Restoring a backup into a repo with no ledger is the same PUT with
//     reason "restore". Restoring over an existing ledger is the engine's
//     (SyncEngine.restore), which needs what the device has seen.
//   - A winning genesis that can't be opened is never written past (owner
//     decision D26): findLedger, openGenesis and createLedger name it
//     (DamagedFile), and deleting it on GitHub lets them go on. One whose
//     epoch some device already joined (a log or snap of it is listed) is
//     named as "joined" instead: deleting it would strand those devices, so
//     its previous version is restored from the repo's history.
//   - A genesis is written under a fresh random name, never over a file. A
//     lost answer is settled by listing the path: the sha of the bytes sent
//     there means it landed; otherwise it is sent once more. An answer that
//     says it wasn't applied is a failure; a PUT that got no answer may
//     still land, so it is reported as unknown (writeGenesis).
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
   * header names: what the passphrase is derived with. `joined`: a log or
   * snap of the epoch is listed, so a device already joined it (D26). */
  | { kind: "ledger"; epoch: string; name: string; sha: string; text: string; salt: string; iter: number; joined: boolean }
  /** The winning genesis has a header this build can't read: a newer
   * build wrote it. */
  | { kind: "needsUpdate"; epoch: string }
  /** The winning genesis is damaged: its header doesn't parse, or it is
   * larger than any real one. Nothing can join or be written past it until
   * it is deleted (D26, damagedFileMessage). */
  | { kind: "malformed"; epoch: string; damagedFile: DamagedFile };

/** The listing of ledger/ at the branch head now, or null for an empty
 * repo. */
async function listNow(remote: Remote): Promise<{ names: string[]; files: Map<string, { sha: string; size: number }>; truncated: boolean } | null> {
  const ref = await remote.client.getRef(remote.branch, null);
  if (ref.kind !== "head") return null;
  const listing = await remote.client.listDir(ref.commitSha, LEDGER_DIR);
  const files = new Map(listing.files.map((f) => [f.name, { sha: f.sha, size: f.size }]));
  return { names: [...files.keys()], files, truncated: listing.truncated };
}

/** A winning genesis this device can't open (owner decision D26): one the
 * app never writes, so a git client, a manual edit or a bad commit put it
 * there. `malformed`: it doesn't parse or open as a genesis.
 * `undecryptable`: it names the household's salt and iterations and still
 * doesn't decrypt (AES-GCM can't tell an altered body from another key, but
 * under the household's own salt only damage explains it). `foreignKey`: it
 * is sealed under another salt and iterations, another passphrase's. Sync
 * stops, with nothing lost, until the file is deleted on GitHub; nothing is
 * ever written past it. `joined`, whatever is wrong with it: a log or snap
 * of its epoch is listed, so another device already uses that epoch, and
 * deleting the genesis would leave the epoch uncounted and strand that
 * device; its previous version is restored from the repo's history
 * instead. */
export interface DamagedFile {
  /** Its path in the repo, "ledger/<epoch>.genesis.enc". */
  path: string;
  epoch: string;
  reason: "malformed" | "undecryptable" | "foreignKey" | "joined";
}

/** Epoch `epoch`'s genesis as a damaged file, for `reason`, or "joined"
 * when `joined` (a device file of the epoch is listed, epochJoined). */
export function damagedGenesis(epoch: string, reason: Exclude<DamagedFile["reason"], "joined">, joined: boolean): DamagedFile {
  return { path: repoPath({ kind: "genesis", epoch }), epoch, reason: joined ? "joined" : reason };
}

/** What to tell the person about a damaged genesis: which file to delete,
 * where, and that deleting it resumes sync (D26); or, for one another
 * device already uses, not to delete it but to restore its previous
 * version. */
export function damagedFileMessage(file: DamagedFile): string {
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  if (file.reason === "joined") {
    return `Sync is paused: the file ${file.path} in your GitHub repo can't be opened on this device, and another device is already using this ledger version, so don't delete it: that would cut that device off. Restore the file's previous version from the repo's history instead: on GitHub, open the repo, then the ${LEDGER_DIR} folder, then ${name}, then its History, open the version before the change, and commit that version back as the file. Sync then resumes, and nothing on this device is lost. If the household passphrase was changed, join the ledger with the new passphrase instead.`;
  }
  const how = `on GitHub, open the repo, then the ${LEDGER_DIR} folder, then ${name}, and delete the file.`;
  if (file.reason === "foreignKey") {
    // Ledger does write such a file: another device's create that raced
    // this one, under its own passphrase's salt.
    return `Sync is paused: the file ${file.path} in your GitHub repo can't be opened on this device: it is sealed with a different passphrase. It may be another device's ledger created at the same time, or the household passphrase changed; deleting it removes that ledger. To keep this device's ledger, delete it, and sync resumes with nothing on this device lost: ${how} To use that ledger instead, join it with its passphrase.`;
  }
  const why = file.reason === "undecryptable" ? "it doesn't decrypt with the household passphrase, so it was changed after it was written" : "it is damaged";
  return `Sync is paused: the file ${file.path} in your GitHub repo can't be opened on this device (${why}). Ledger never writes a file like it. Deleting it resumes sync, and nothing on this device is lost: ${how}`;
}

/** The winning epoch in a listing of the repo now (section 9.1). */
export interface EpochNow {
  /** The greatest counted epoch listed, or null when none is. */
  winner: string | null;
  /** The winner's genesis blob sha and listed size, or null when there is
   * no winner. */
  sha: string | null;
  size: number | null;
  /** GitHub cut the listing short: a greater epoch may be left out, so
   * `winner` alone decides nothing (ADR-0008). A greater one listed is
   * there all the same. */
  truncated: boolean;
  /** Every file the listing holds, by name, with its blob sha and size. */
  files: ReadonlyMap<string, { sha: string; size: number }>;
}

/** The winning epoch in the repo now (section 9.1), and whether the
 * listing it comes from was cut. */
export async function winningEpochNow(remote: Remote): Promise<EpochNow> {
  const listing = await listNow(remote);
  if (listing === null) return { winner: null, sha: null, size: null, truncated: false, files: new Map() };
  const winner = winningEpoch(listing.names);
  const listed = winner === null ? null : listing.files.get(repoFileName({ kind: "genesis", epoch: winner }))!;
  return { winner, sha: listed?.sha ?? null, size: listed?.size ?? null, truncated: listing.truncated, files: listing.files };
}

/** "Is there a ledger?" (#8): the winning genesis and its header. */
export async function findLedger(remote: Remote): Promise<LedgerFound> {
  return findIn(remote, await listNow(remote));
}

/** findLedger on a listing already made: the winner's genesis, or `at`'s
 * (a genesis listed in it) when given. */
async function findIn(remote: Remote, listing: Awaited<ReturnType<typeof listNow>>, at?: string): Promise<LedgerFound> {
  if (listing === null) return { kind: "none" };
  const epoch = at ?? winningEpoch(listing.names);
  if (epoch === null) return listing.truncated ? { kind: "unknown" } : { kind: "none" };
  const name = repoFileName({ kind: "genesis", epoch });
  const { sha, size } = listing.files.get(name)!;
  // A damaged winner is named only from a full listing: a cut one may have
  // left out a greater epoch, and deleting a genesis under it would leave
  // that epoch uncounted (the counted-run rule).
  const joined = epochJoined(listing.names, epoch);
  const damaged = listing.truncated ? ({ kind: "unknown" } as const) : ({ kind: "malformed", epoch, damagedFile: damagedGenesis(epoch, "malformed", joined) } as const);
  if (size > READ_BOUNDS.bytes) return damaged;
  const text = await remote.client.readBlob(sha);
  const newline = text.indexOf("\n");
  try {
    const raw = JSON.parse(newline < 0 ? text : text.slice(0, newline)) as { v?: unknown } | null;
    if (Number.isSafeInteger(raw?.v) && (raw!.v as number) > 1) return { kind: "needsUpdate", epoch };
    const header = parseHeader(text);
    return { kind: "ledger", epoch, name, sha, text, salt: header.salt, iter: header.iter, joined };
  } catch {
    return damaged;
  }
}

/** A genesis opened with a key, or why it can't be. `reason`, `by` and
 * `at` say who made it and when (display only): "Sam's restore replaced
 * yours" (section 9.2 step 7). */
export type GenesisOpen =
  | { ok: true; epoch: string; sha: string; state: SyncState; doc: LedgerDocument; reason: GenesisContent["reason"]; by: string; at: number }
  | { ok: false; problem: "wrongPassphrase" | "needsUpdate" }
  /** It decrypts but isn't a genesis this build would write: damaged, and
   * named so it can be deleted (D26). */
  | { ok: false; problem: "malformed"; damagedFile: DamagedFile };

/** Opens the genesis findLedger found with the household key: the state a
 * first start begins from (SyncEngine.initialize). A key that doesn't fit
 * is a wrong passphrase, since only the genesis can say so (section 12):
 * a key derived from the genesis's own salt can't tell an altered body
 * from a wrong passphrase. */
export async function openGenesis(found: Extract<LedgerFound, { kind: "ledger" }>, key: DeviceKey): Promise<GenesisOpen> {
  const read = await openRepoFile({ kind: "genesis", epoch: found.epoch }, found.text, key);
  const malformed = { ok: false, problem: "malformed", damagedFile: damagedGenesis(found.epoch, "malformed", found.joined) } as const;
  if (!read.ok) {
    if (read.problem === "malformed") return malformed;
    return { ok: false, problem: read.problem === "needsUpdate" ? "needsUpdate" : "wrongPassphrase" };
  }
  const file = read.read.file;
  if (file.kind !== "genesis") return malformed;
  return { ok: true, epoch: found.epoch, sha: found.sha, state: genesisState(file.doc), doc: file.doc, reason: file.reason, by: file.by, at: file.at };
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
  /** It didn't land: every PUT sent was answered, and each answer says it
   * wasn't applied (a 409 or 422). */
  | { kind: "failed"; detail: string }
  /** A PUT got no answer (offline, a timeout, a 5xx), and no listing since
   * showed the genesis: it may still land. */
  | { kind: "unknown"; detail: string };

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
 * answer is sent once more; a stale-sha answer (the name is taken) ends it.
 * Whatever ends it, a PUT that got no answer may still land, so the result
 * is then "unknown", never "failed". Throws for a token, repo or rate-limit
 * answer when no earlier PUT went unanswered. `onPut` is called before
 * each PUT is sent (the engine counts each against its hourly cap,
 * ADR-0008 stage 4). */
export async function writeGenesis(
  remote: Remote,
  content: GenesisContent,
  key: DeviceKey,
  bounds: FileBounds = WRITE_BOUNDS,
  onPut: () => void = () => {},
): Promise<GenesisWrite> {
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
  /** A PUT sent so far got no answer, so it may still land. */
  let unanswered = false;
  for (let attempt = 1; ; attempt++) {
    try {
      onPut();
      const res = await remote.client.putFile({ path, text, sha: null, message });
      return { kind: "written", sha: res.sha };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (isFinal(err)) {
        if (unanswered) return { kind: "unknown", detail };
        throw err;
      }
      // A 4xx answer says this PUT wasn't applied; anything else (no
      // response, a timeout, a 5xx) doesn't.
      if (!(err instanceof GitHubError && err.status >= 400 && err.status < 500)) unanswered = true;
      // Did it land? Only these bytes can be there under this name.
      let listed: string | undefined;
      try {
        listed = (await listNow(remote))?.files.get(repoFileName(file))?.sha;
      } catch {
        listed = undefined;
      }
      if (listed === sha) return { kind: "written", sha };
      if (attempt >= 2 || (err instanceof ShaConflictError && err.reason === "stale-sha")) return { kind: unanswered ? "unknown" : "failed", detail };
    }
  }
}

export type CreateResult =
  | { kind: "created"; epoch: string; sha: string; state: SyncState }
  /** The repo already holds a ledger (or one this build can't read, or
   * this key can't open): join it instead. Nothing was written.
   * `damagedFile`: the winning genesis is one the app never writes (D26);
   * nothing is written past it, and deleting it on GitHub lets the create
   * or restore go on (damagedFileMessage). */
  | { kind: "exists"; damagedFile?: DamagedFile }
  /** Another device's create landed beside this one and wins (a greater
   * epoch is listed after this one landed): join the winner instead
   * (findLedger). Nothing was started on this device. */
  | { kind: "replaced"; epoch: string; winner: string }
  /** A cut listing, this create landed but the repo couldn't be listed in
   * full after it, or its PUT got no answer and may still land: try again
   * later, and the next try joins what it finds. */
  | { kind: "unknown" }
  /** It didn't land (GenesisWrite's "failed"), or, with `damagedFile`,
   * nothing was written: its epoch 1 would fill the gap below a genesis
   * numbered past it that can't be opened, which would then count and win.
   * That file counts for nothing now, so deleting it is safe (D26), and
   * the create or restore then goes on. */
  | { kind: "failed"; detail: string; damagedFile?: DamagedFile }
  | Exclude<GenesisWrite, { kind: "written" | "failed" }>;

/** #8 Create, and #9's restore into a repo with no ledger: one genesis PUT
 * for epoch 1 (section 9.5), `doc` an empty document or the backup, under
 * `key` (the household's, or a backup's own salt and iterations). Returns
 * the state the engine's first start begins from. Any listed genesis is
 * "exists", and nothing is written: a damaged one too (D26), which is named
 * (damagedWinner) so the person can delete it, after which the create or
 * restore goes on. Two devices creating at once each write their own
 * epoch 1, and the greater key wins. Each derived
 * its key with a fresh salt, so a device started on the losing epoch could
 * never read the winner's files, nor offer its writes. So the repo is
 * listed again once the genesis lands (as a restore's step 6 does): a
 * greater epoch listed is "replaced", and the caller joins the winner
 * before anything is written on this device. A create that listed before
 * the winner's landed is still told "created" (ADR-0008, design
 * questions). */
export async function createLedger(
  remote: Remote,
  key: DeviceKey,
  { doc, by, at, reason = "create" }: { doc: LedgerDocument; by: string; at: number; reason?: GenesisContent["reason"] },
): Promise<CreateResult> {
  if (!isWritableDocument(doc)) throw new Error("A ledger can only be created from a writable document");
  const listing = await listNow(remote);
  const found = await findIn(remote, listing);
  if (found.kind === "unknown") return found;
  if (found.kind !== "none") {
    const damagedFile = await damagedWinner(found, key, reason);
    if (damagedFile === null) return { kind: "exists" };
    // Named only from a full listing, as findLedger does.
    return listing!.truncated ? { kind: "unknown" } : { kind: "exists", damagedFile };
  }
  const epoch = nextEpochKey(null);
  // Epoch 1 may fill the gap below a genesis numbered past it, which would
  // then count and win: one that can't be opened would leave this create
  // "replaced" by a ledger no device can join. Nothing is written; the file
  // counts for nothing now, so it is named to delete (D26).
  const after = listing === null ? null : winningEpoch([...listing.names, repoFileName({ kind: "genesis", epoch })]);
  if (after !== null && after !== epoch) {
    const gap = await findIn(remote, listing, after);
    if (gap.kind !== "none" && gap.kind !== "unknown") {
      const damagedFile = await damagedWinner(gap, key, reason);
      if (damagedFile !== null) return { kind: "failed", detail: damagedFileMessage(damagedFile), damagedFile };
    }
  }
  const written = await writeGenesis(remote, { epoch, reason, by, at, basedOn: null, doc }, key);
  // It may still land: the next try finds it, or not, and goes on from there.
  if (written.kind === "unknown") return { kind: "unknown" };
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
  // A cut listing may leave out a greater epoch (ADR-0008): as unknown as
  // no listing at all.
  if (now.truncated) return { kind: "unknown" };
  return { kind: "created", epoch, sha: written.sha, state: genesisState(doc) };
}

/** A listed genesis (the winner, or one a new epoch 1 would make count) as
 * a damaged file, as far as `key` can tell (D26),
 * else null. One whose header doesn't parse is damaged whatever the key. A
 * restore's key is the household's (the backup opened with it), so it
 * tells the rest as the engine does: a genesis that decrypts but isn't a
 * ledger is `malformed`; one under the key's own salt and iterations that
 * doesn't decrypt is `undecryptable` (AES-GCM can't tell an altered body
 * from a wrong key, but under the same salt only damage explains it); one
 * under another salt is `foreignKey`, which may mean the household
 * passphrase changed. A create's key is new, drawn with a fresh salt, so
 * every genesis is under another salt to it: a ledger to join, not damage.
 * One this build is too old to read is fixed by updating. */
async function damagedWinner(found: Exclude<LedgerFound, { kind: "none" | "unknown" }>, key: DeviceKey, reason: GenesisContent["reason"]): Promise<DamagedFile | null> {
  if (found.kind === "malformed") return found.damagedFile;
  if (found.kind !== "ledger" || reason !== "restore") return null;
  const opened = await openGenesis(found, key);
  if (opened.ok || opened.problem === "needsUpdate") return null;
  if (opened.problem === "malformed") return opened.damagedFile;
  return damagedGenesis(found.epoch, found.salt === key.salt && found.iter === key.iter ? "undecryptable" : "foreignKey", found.joined);
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

/** Forgets the epoch a restore remembered (rememberRestore), if it is still
 * `epoch`: a full listing showed its genesis never landed (the engine's
 * #settleRestore), so the reload after it has nothing to report. */
export function forgetRestore(epoch: string): void {
  try {
    const storage = session();
    if (storage?.getItem(RESTORED_KEY) === epoch) storage.removeItem(RESTORED_KEY);
  } catch {
    // Storage refused: the reload may report a restore that didn't land.
  }
}

/** The epoch a restore in this tab wrote before the reload, once. Compare
 * it with the epoch the engine ends on (SyncEngine.epochKey):
 *   - equal: "your restore replaced the ledger";
 *   - the engine's is greater: "Sam's restore replaced yours";
 *   - the engine's is older: it hasn't landed. Its genesis PUT got no
 *     answer (restore() said "unknown") and the reload came before any
 *     full listing settled it. If it lands later the device switches to it
 *     like any restore; once a full listing shows it never landed, the
 *     engine forgets it (forgetRestore), and this is null.
 * Null when no restore is remembered. */
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
