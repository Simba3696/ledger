import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";

// The Excel edition read LEDGER_DB_DIR once at startup. The importer instead
// points these readers at whichever folder it was given (--from), and its
// tests at several fixture folders in one process, so the folder is set
// explicitly rather than fixed at module load. Unset, every reader throws.
let dbDir: string | null = null;

export function setDbDir(dir: string): void {
  dbDir = path.resolve(dir);
}

export function getDbDir(): string {
  if (!dbDir) throw new Error("legacy-excel: call setDbDir(<folder>) before reading");
  return dbDir;
}

// Legacy copy for the Phase 4 importer (LLD §8). LedgerError is defined
// here rather than imported from server/src/errors.ts so this folder has no
// dependency on server code.
export class LedgerError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Row numbers below the header of `sheetName` in `fileName` (inside the
 * folder) that have anything in them, for the importer to spot rows a
 * reader skipped. `null` when the file doesn't exist; throws when the sheet
 * is missing, as each reader does. Read-only. */
export async function usedDataRows(fileName: string, sheetName: string): Promise<number[] | null> {
  const filePath = path.join(getDbDir(), fileName);
  if (!fs.existsSync(filePath)) return null;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new LedgerError(`${fileName} is missing its "${sheetName}" sheet`, 500);
  const rows: number[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = Array.isArray(row.values) ? row.values : Object.values(row.values);
    if (values.some((v) => v !== null && v !== undefined && !(typeof v === "string" && !v.trim()))) rows.push(rowNumber);
  });
  return rows;
}

const backedUpThisRun = new Set<string>();

/** Per-file chain of promises — every call for the same `filePath` runs
 * strictly after the previous one finishes, so two overlapping requests
 * against the same workbook (e.g. an add-expense from the phone and one from
 * the desktop landing in the same second) can never both read the same
 * pre-write state and then both save, silently dropping whichever one wrote
 * second. Without this, two concurrent `appendEntry` calls both compute the
 * same "next row number" and one entry is lost entirely.
 *
 * `filePath` is always an absolute, fully-resolved path (see each module's
 * own `workbookPath`/`FILE_PATH`), so the same workbook is never
 * accidentally tracked under two different map keys. Locks are per-process,
 * in-memory only — this doesn't protect against a second server process (or
 * Excel itself) writing concurrently, which `saveWorkbook`'s locked-file
 * detection and backup-on-write already cover. */
const fileLocks = new Map<string, Promise<unknown>>();

/** Runs `fn` only after every previously-queued call for this same
 * `filePath` has settled (succeeded or thrown) — the standard promise-chain
 * mutex pattern. Every exported read-modify-write function in the
 * `excel/*.ts` modules wraps its whole body (load, mutate, save) in this,
 * not just the final `saveWorkbook` call, since the race is between one
 * request's *read* and another's *write*, not just between two writes. */
export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(filePath) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Swallow rejection here so one failed call doesn't poison the chain for
  // every call after it — the caller of withFileLock still gets the real
  // rejection via `next` (or `result` below), this is only to keep the map's
  // stored promise itself always resolved.
  fileLocks.set(
    filePath,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** Per-file cap, not a time cutoff — a rarely-touched file (e.g. Debts, only
 * edited every few months) would otherwise lose its one and only backup to a
 * 30-day-style expiry despite never having accumulated any clutter at all. */
export const MAX_BACKUPS_PER_FILE = 10;

/** Keeps only the most recent MAX_BACKUPS_PER_FILE backups for this source
 * file — without this, the scheduled task restarting at every login means a
 * fresh backup per file per login, unbounded, forever (observed: ~90 files
 * in 11 days on real usage). Filenames sort chronologically since the
 * timestamp is ISO-formatted, so a plain string sort works. */
function pruneOldBackups(filePath: string) {
  const base = path.basename(filePath, ".xlsx");
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(getDbDir(), ".backups"));
  } catch {
    return;
  }
  const matches = entries.filter((name) => name.startsWith(`${base}.`) && name.endsWith(".xlsx")).sort();
  const excess = matches.length - MAX_BACKUPS_PER_FILE;
  for (let i = 0; i < excess; i++) {
    fs.rmSync(path.join(getDbDir(), ".backups", matches[i]), { force: true });
  }
}

function backupOnce(filePath: string) {
  if (!fs.existsSync(filePath)) return; // brand-new workbook — nothing to back up yet
  if (backedUpThisRun.has(filePath)) return;
  const backupDir = path.join(getDbDir(), ".backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(backupDir, `${path.basename(filePath, ".xlsx")}.${stamp}.xlsx`);
  fs.copyFileSync(filePath, dest);
  backedUpThisRun.add(filePath);
  pruneOldBackups(filePath);
}

/** Backs up the current file (once per process run), writes to a temp file, then
 * renames over the original only on success — avoids truncating the file if the
 * process dies mid-write, and surfaces a clear error if the file is locked open
 * in Excel rather than a raw stack trace. */
export async function saveWorkbook(workbook: ExcelJS.Workbook, filePath: string): Promise<void> {
  backupOnce(filePath);

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await workbook.xlsx.writeFile(tempPath);
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw new LedgerError(`Failed to write ${path.basename(filePath)}: ${(err as Error).message}`, 500);
  }

  try {
    fs.renameSync(tempPath, filePath);
  } catch {
    fs.rmSync(tempPath, { force: true });
    throw new LedgerError(
      `Could not save to ${path.basename(filePath)} — is it open in Excel? Close it and try again.`,
      409,
    );
  }
}
