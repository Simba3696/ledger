import { deriveKey, InvalidFileError, parseHeader } from "../backend/crypto";
import type { LedgerDocument } from "../backend/document/types";
import { readBackup } from "../backend/sync/ledgerRepo";
import type { DeviceKey } from "../backend/sync/records";

// Backup files of GitHub mode (#9, amended for the redesigned sync): the
// engine seals a device's current document with the household key
// (SyncEngine.exportBackup), and this saves it as a file, reads one back
// with the right key (this device's, or one derived from the file's own
// header and its passphrase), and summarises it before a restore. Nothing
// here writes to GitHub: restoring is the engine's (restore) or #8's
// create (createLedger with reason "restore").

/** Every backup file's name starts with this. A string literal, so it
 * survives minification as check:isolation's sentinel. */
const BACKUP_FILE_PREFIX = "ledger-backup-";
/** Larger than any real backup: refused before it is read. */
export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

export const NOT_A_BACKUP = "This isn't a Ledger backup file.";
export const TOO_LARGE = "This file is too large to be a Ledger backup.";
export const DAMAGED = "This backup file is damaged.";
export const WRONG_PASSPHRASE = "Wrong passphrase";
export const NEWER = "This backup was made by a newer version of Ledger. Update the app and try again.";

/** `ledger-backup-YYYY-MM-DD.enc`, by the device's local date. */
export function backupFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${BACKUP_FILE_PREFIX}${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.enc`;
}

/** Saves `text` as a file the browser downloads. */
export function downloadFile(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** What a backup holds, to show before it replaces anything. */
export interface BackupSummary {
  expenses: number;
  /** The first and last month with an expense, "YYYY-MM", or null. */
  from: string | null;
  to: string | null;
  debts: number;
  emis: number;
  subscriptions: number;
}

export function summarize(doc: LedgerDocument): BackupSummary {
  const months = Object.keys(doc.expenses)
    .filter((m) => doc.expenses[m].length > 0)
    .sort();
  return {
    expenses: months.reduce((n, m) => n + doc.expenses[m].length, 0),
    from: months[0] ?? null,
    to: months.at(-1) ?? null,
    debts: doc.debts.length,
    emis: doc.emis.length,
    subscriptions: doc.subscriptions.length,
  };
}

export type BackupRead =
  | { ok: true; doc: LedgerDocument; key: DeviceKey; summary: BackupSummary }
  /** Its key isn't this device's: ask for the passphrase it was made with. */
  | { ok: false; needsPassphrase: true }
  | { ok: false; needsPassphrase?: false; message: string };

/** Reads a backup file: refused over 25 MB before reading; then opened
 * with this device's key when the file was sealed under it, else with a
 * key derived from the file's own salt and iterations and `passphrase`
 * (a backup made under another passphrase opens with that one, D35).
 * Without a passphrase when one is needed, it says so and reads nothing
 * more. Writes nothing. */
export async function readBackupFile(file: Blob, deviceKey: DeviceKey | null, passphrase?: string): Promise<BackupRead> {
  if (file.size > MAX_BACKUP_BYTES) return { ok: false, message: TOO_LARGE };
  if (file.size === 0) return { ok: false, message: NOT_A_BACKUP };
  const text = await file.text();
  // A newer format says so (update the app), before the header check
  // refuses it as unknown.
  const newline = text.indexOf("\n");
  let raw: unknown;
  try {
    raw = JSON.parse(newline < 0 ? text : text.slice(0, newline));
  } catch {
    return { ok: false, message: NOT_A_BACKUP };
  }
  const v = (raw as { v?: unknown } | null)?.v;
  if (Number.isSafeInteger(v) && (v as number) > 1) return { ok: false, message: NEWER };
  let header;
  try {
    header = parseHeader(text);
  } catch (err) {
    if (err instanceof InvalidFileError) return { ok: false, message: NOT_A_BACKUP };
    throw err;
  }
  let key: DeviceKey;
  if (deviceKey && deviceKey.salt === header.salt && deviceKey.iter === header.iter) key = deviceKey;
  else if (passphrase === undefined) return { ok: false, needsPassphrase: true };
  else key = { key: await deriveKey(passphrase, header.salt, header.iter), salt: header.salt, iter: header.iter };
  const opened = await readBackup(text, key.key);
  if (!opened.ok) {
    // This device's key failing on its own salt is damage, not a passphrase.
    if (opened.problem === "wrongPassphrase") return key === deviceKey ? { ok: false, message: DAMAGED } : { ok: false, message: WRONG_PASSPHRASE };
    return { ok: false, message: opened.problem === "newer" ? NEWER : DAMAGED };
  }
  return { ok: true, doc: opened.doc, key, summary: summarize(opened.doc) };
}
