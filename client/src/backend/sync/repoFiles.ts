import { InvalidFileError, WrongPassphraseError, parseHeader } from "../crypto";
import { checkRepoFile, type FileCheck } from "./codec";
import { repoFileName, type RepoFile } from "./epoch";
import { unseal, type DeviceKey } from "./records";

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
//     all (section 3.6).

/** The folder every sync file lives in, flat (section 6). */
export const LEDGER_DIR = "ledger";

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

/** Decrypts and checks the text listed as `name`. */
export async function openRepoFile(name: RepoFile, text: string, key: DeviceKey): Promise<FileRead> {
  const refuse = (problem: FileProblem, detail: string): FileRead => ({ ok: false, problem, detail });
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
    value = await unseal(text, key);
  } catch (err) {
    if (err instanceof WrongPassphraseError) return refuse("undecryptable", "the file does not decrypt with this key");
    if (err instanceof InvalidFileError) return refuse("malformed", err.message);
    throw err;
  }
  // checkRepoFile needs the epoch's genesis state to check a snap, and the
  // cycle reads none yet (the gap check and cold start read them, design
  // step 5): asking for one is a caller error.
  if (name.kind === "snap") throw new Error("A snap is checked against its epoch's genesis state");
  const check = checkRepoFile(name, value);
  if (!check.ok) return refuse(check.problem, check.detail);
  return { ok: true, read: check };
}
