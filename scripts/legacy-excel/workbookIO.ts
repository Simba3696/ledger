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
// here rather than imported from shared/src/errors.ts so this folder has no
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
