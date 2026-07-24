import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DB_DIR = process.env.LEDGER_DB_DIR
  ? path.resolve(process.env.LEDGER_DB_DIR)
  : path.resolve(__dirname, "../../../db");

const BACKUP_DIR = path.join(DB_DIR, ".backups");

export class LedgerError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const backedUpThisRun = new Set<string>();

function backupOnce(filePath: string) {
  if (!fs.existsSync(filePath)) return; // brand-new workbook — nothing to back up yet
  if (backedUpThisRun.has(filePath)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(BACKUP_DIR, `${path.basename(filePath, ".xlsx")}.${stamp}.xlsx`);
  fs.copyFileSync(filePath, dest);
  backedUpThisRun.add(filePath);
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
