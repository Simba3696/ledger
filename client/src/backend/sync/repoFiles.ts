import { InvalidFileError, WrongPassphraseError, parseHeader } from "../crypto";
import { checkRepoFile, type FileCheck } from "./codec";
import { repoFileName, type RepoFile } from "./epoch";
import { unseal, type DeviceKey } from "./records";
import type { SyncState } from "./state";

// Reading a file from the data repo's ledger/ folder (design sections 6 and
// 12): the header first, then the key, then the content. Each step that
// fails names what it means for the cycle, and none throws for bad input:
//
//   - A header whose format version `v` is newer than this build's is
//     checked before parseHeader, so a newer file reads as "update the app",
//     never as a wrong passphrase (B18). So is a content `fv` above this
//     build's (codec.ts).
//   - Every file in an epoch uses its genesis's salt and iter (section 6),
//     which the device key was derived for. A file whose header names
//     others can't be one of the household's (`foreignKey`).
//   - A file the key can't decrypt is `undecryptable`. For another device's
//     file that halts its stream (needsAttention), never needsPassphrase:
//     only the genesis can say the stored key is wrong.
//   - Anything else wrong is `malformed`: a file is joined whole or not at
//     all (section 3.6). That includes a file larger than any real one, a
//     body that isn't gzip, and any throw while it is read: a file that
//     can't be classified would fail the cycle every time it is listed and
//     hold back this device's own pushes (ADR-0008, threat model).

/** The folder every sync file lives in, flat (section 6). */
export const LEDGER_DIR = "ledger";

/** The largest repo file read, in bytes as listed (base64 text). A
 * 10-year genesis or snapshot is about 330 KB; a file past this is refused
 * before it is downloaded. */
export const REPO_FILE_MAX_BYTES = 4 * 1024 * 1024;
/** The most a repo file may inflate to, in bytes of JSON. A 10-year
 * document is about 2.3 MB. gzip inflates about 1000:1, so without a bound
 * a small crafted file could take a tab's memory. Covers the largest file
 * REPO_FILE_MAX_BYTES lets through at JSON's usual ratio. */
export const REPO_FILE_MAX_PLAIN_BYTES = 32 * 1024 * 1024;

/** How large a repo file may be: as listed or downloaded (`bytes`, of
 * base64 text) and once inflated (`plainBytes`, of JSON). */
export interface FileBounds {
  bytes: number;
  plainBytes: number;
}

/** The bounds this build reads other devices' files within. A device
 * writes its own files within half of them, so a later build may raise
 * them (loosening is allowed within fv 1) before any writer reaches them,
 * and reads its own files back within twice them (ADR-0008). */
export const READ_BOUNDS: FileBounds = { bytes: REPO_FILE_MAX_BYTES, plainBytes: REPO_FILE_MAX_PLAIN_BYTES };

/** The bytes `content` inflates to when sealed: what a reader's
 * `plainBytes` bound counts (crypto.ts seals JSON.stringify's UTF-8). */
export function plainSize(content: unknown): number {
  return new TextEncoder().encode(JSON.stringify(content)).length;
}

/** Why a repo file can't be joined. */
type FileProblem = "needsUpdate" | "malformed" | "undecryptable" | "foreignKey";

type OpenedFile = Extract<FileCheck, { ok: true }>;

export type FileRead = { ok: true; read: OpenedFile } | { ok: false; problem: FileProblem; detail: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A file's path in the repo. */
export function repoPath(file: RepoFile): string {
  return `${LEDGER_DIR}/${repoFileName(file)}`;
}

/** Decrypts and checks the text listed as `name`, within `bounds`. A
 * snap is checked against `genesis`, its epoch's genesis state (codec.ts),
 * which a device always reads before any snap (section 8.3): reading one
 * without it is a caller error. */
export async function openRepoFile(name: RepoFile, text: string, key: DeviceKey, genesis?: SyncState, bounds: FileBounds = READ_BOUNDS): Promise<FileRead> {
  if (name.kind === "snap" && !genesis) throw new Error("A snap is checked against its epoch's genesis state");
  try {
    return await readRepoFile(name, text, key, genesis, bounds);
  } catch (err) {
    return { ok: false, problem: "malformed", detail: `the file can't be read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function readRepoFile(name: RepoFile, text: string, key: DeviceKey, genesis: SyncState | undefined, bounds: FileBounds): Promise<FileRead> {
  const refuse = (problem: FileProblem, detail: string): FileRead => ({ ok: false, problem, detail });
  if (text.length > bounds.bytes) return refuse("malformed", `the file is larger than ${bounds.bytes} bytes`);
  const newline = text.indexOf("\n");
  let raw: unknown;
  try {
    raw = JSON.parse(newline < 0 ? text : text.slice(0, newline));
  } catch {
    return refuse("malformed", "the file header is not JSON");
  }
  if (isPlainObject(raw) && Number.isSafeInteger(raw.v) && (raw.v as number) > 1) {
    return refuse("needsUpdate", `the file header is version ${String(raw.v)}`);
  }
  let header;
  try {
    header = parseHeader(text);
  } catch (err) {
    return refuse("malformed", err instanceof Error ? err.message : "the file header is malformed");
  }
  if (header.salt !== key.salt || header.iter !== key.iter) return refuse("foreignKey", "the file is not encrypted with the epoch's salt and iterations");
  let value: unknown;
  try {
    value = await unseal(text, key, { maxPlainBytes: bounds.plainBytes });
  } catch (err) {
    if (err instanceof WrongPassphraseError) return refuse("undecryptable", "the file does not decrypt with this key");
    if (err instanceof InvalidFileError) return refuse("malformed", err.message);
    throw err;
  }
  const check = checkRepoFile(name, value, genesis);
  if (!check.ok) return refuse(check.problem, check.detail);
  return { ok: true, read: check };
}
