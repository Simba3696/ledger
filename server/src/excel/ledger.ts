import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { Category, CATEGORY_COLORS, colorToCategory } from "./categoryColors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DB_DIR = process.env.LEDGER_DB_DIR
  ? path.resolve(process.env.LEDGER_DB_DIR)
  : path.resolve(__dirname, "../../../db");

const BACKUP_DIR = path.join(DB_DIR, ".backups");

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const FALLBACK_AMOUNT_NUMFMT =
  '_ [$₹-4009]\\ * #,##0.00_ ;_ [$₹-4009]\\ * \\-#,##0.00_ ;_ [$₹-4009]\\ * "-"??_ ;_ @_ ';

export class LedgerError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

function workbookPath(year: number): string {
  return path.join(DB_DIR, `Expenses (${year}).xlsx`);
}

function monthName(month: number): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new LedgerError(`Invalid month: ${month}`, 400);
  }
  return MONTH_NAMES[month - 1];
}

async function loadWorkbook(year: number): Promise<ExcelJS.Workbook> {
  const filePath = workbookPath(year);
  if (!fs.existsSync(filePath)) {
    throw new LedgerError(`No workbook found for year ${year}`, 404);
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (err) {
    throw new LedgerError(`Could not read ${path.basename(filePath)}: ${(err as Error).message}`, 500);
  }
  return workbook;
}

function getSheet(workbook: ExcelJS.Workbook, year: number, month: number): ExcelJS.Worksheet {
  const name = monthName(month);
  const sheet = workbook.getWorksheet(name);
  if (!sheet) {
    throw new LedgerError(`No "${name}" sheet found in Expenses (${year}).xlsx`, 404);
  }
  return sheet;
}

// ExcelJS happily writes through an Excel "Protect Sheet" password lock (it edits the
// raw XML, so the password is never checked) and even re-saves the hash intact — meaning
// a write would silently succeed while the file still *looks* protected in Excel. Since
// these locks are placed intentionally on past years to prevent edits, treat them as
// read-only from this app too rather than bypassing them.
function assertWritable(sheet: ExcelJS.Worksheet, year: number, month: number) {
  if ((sheet as unknown as { sheetProtection?: unknown }).sheetProtection) {
    throw new LedgerError(
      `${monthName(month)} ${year} is protected/locked in Excel. Unprotect the sheet first if you really need to add an entry there.`,
      403,
    );
  }
}

/** Last row (1-based) that has a numeric Amount value in column A. */
function lastDataRow(sheet: ExcelJS.Worksheet): number {
  let last = 1; // header row
  sheet.eachRow((row, rowNumber) => {
    if (typeof row.getCell(1).value === "number") {
      last = Math.max(last, rowNumber);
    }
  });
  return last;
}

function findAmountNumFmt(sheet: ExcelJS.Worksheet): string {
  let found: string | undefined;
  sheet.eachRow((row) => {
    if (found) return;
    const cell = row.getCell(1);
    if (typeof cell.value === "number" && cell.numFmt) {
      found = cell.numFmt;
    }
  });
  return found ?? FALLBACK_AMOUNT_NUMFMT;
}

export interface LedgerEntry {
  row: number;
  amount: number; // positive rupee amount
  remarks: string;
  isCard: boolean;
  cardNote: string | null;
  category: Category | null;
}

export async function listMonth(year: number, month: number): Promise<LedgerEntry[]> {
  const workbook = await loadWorkbook(year);
  const sheet = getSheet(workbook, year, month);

  const entries: LedgerEntry[] = [];
  sheet.eachRow((row, rowNumber) => {
    const amountValue = row.getCell(1).value;
    if (typeof amountValue !== "number") return; // header / spacer / non-transaction row

    const remarksValue = row.getCell(2).value;
    const remarks = typeof remarksValue === "string" ? remarksValue : String(remarksValue ?? "");

    const ccValue = row.getCell(3).value;
    const ccText = typeof ccValue === "string" ? ccValue.trim() : "";

    const fill = row.getCell(1).fill;
    const argb = fill && fill.type === "pattern" ? fill.fgColor?.argb : undefined;

    entries.push({
      row: rowNumber,
      amount: Math.abs(amountValue),
      remarks,
      isCard: ccText.length > 0,
      cardNote: ccText.length > 0 ? ccText : null,
      category: colorToCategory(argb),
    });
  });

  return entries;
}

let backedUpThisRun = new Set<string>();

function backupOnce(filePath: string) {
  if (backedUpThisRun.has(filePath)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(BACKUP_DIR, `${path.basename(filePath, ".xlsx")}.${stamp}.xlsx`);
  fs.copyFileSync(filePath, dest);
  backedUpThisRun.add(filePath);
}

export interface AppendEntryInput {
  year: number;
  month: number;
  amount: number;
  remarks: string;
  category: Category;
  isCard: boolean;
}

export async function appendEntry(input: AppendEntryInput): Promise<LedgerEntry> {
  const { year, month, amount, remarks, category, isCard } = input;

  if (!(amount > 0)) throw new LedgerError("Amount must be a positive number", 400);
  if (!remarks || !remarks.trim()) throw new LedgerError("Remarks are required", 400);
  if (!CATEGORY_COLORS[category]) throw new LedgerError(`Unknown category: ${category}`, 400);

  const filePath = workbookPath(year);
  const workbook = await loadWorkbook(year);
  const sheet = getSheet(workbook, year, month);
  assertWritable(sheet, year, month);

  const numFmt = findAmountNumFmt(sheet);
  const rowNumber = lastDataRow(sheet) + 1;
  const fill: ExcelJS.Fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: CATEGORY_COLORS[category] },
  };

  const row = sheet.getRow(rowNumber);
  row.getCell(1).value = -Math.abs(amount);
  row.getCell(1).numFmt = numFmt;
  row.getCell(1).fill = fill;

  row.getCell(2).value = remarks.trim();
  row.getCell(2).fill = fill;

  row.getCell(3).value = isCard ? "CC" : "";
  row.getCell(3).fill = fill;
  row.commit();

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
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
    throw new LedgerError(
      `Could not save to ${path.basename(filePath)} — is it open in Excel? Close it and try again.`,
      409,
    );
  }

  return {
    row: rowNumber,
    amount: Math.abs(amount),
    remarks: remarks.trim(),
    isCard,
    cardNote: isCard ? "CC" : null,
    category,
  };
}
