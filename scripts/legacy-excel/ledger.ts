import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { colorToCategory } from "./categoryColors.js";
import type { Category, CategoryConfig } from "./categoryColors.js";
import { loadCategoryConfig } from "./categoryColors.js";
import { getDbDir, LedgerError } from "./workbookIO.js";

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function workbookPath(year: number): string {
  return path.join(getDbDir(), `Expenses (${year}).xlsx`);
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

/** Whether a month is currently locked — the real Excel sheet protection
 * the Excel edition used as its per-month lock. A month whose year
 * workbook doesn't exist on disk yet (e.g. browsing to a future year
 * before adding anything) is never locked; there's nothing to lock. */
export async function isMonthLocked(year: number, month: number): Promise<boolean> {
  let workbook: ExcelJS.Workbook;
  try {
    workbook = await loadWorkbook(year);
  } catch {
    return false;
  }
  const sheet = getSheet(workbook, year, month);
  return !!(sheet as unknown as { sheetProtection?: unknown }).sheetProtection;
}

export interface LedgerEntry {
  row: number;
  amount: number; // positive rupee amount
  remarks: string;
  isCard: boolean;
  cardNote: string | null;
  category: Category | null;
}

/** An entry as listMonth reads it, plus the raw Amount-cell fill colour the
 * category came from (the importer reports one that matches no category). */
interface LedgerEntryWithFill extends LedgerEntry {
  fillArgb: string | null;
}

/** listMonth's row parsing, shared with readYearForImport so the importer
 * sees exactly the entries the Excel edition showed. */
function readEntries(sheet: ExcelJS.Worksheet, categories: CategoryConfig[]): LedgerEntryWithFill[] {
  const entries: LedgerEntryWithFill[] = [];
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
      category: colorToCategory(argb, categories),
      fillArgb: argb ?? null,
    });
  });
  return entries;
}

export async function listMonth(year: number, month: number): Promise<LedgerEntry[]> {
  const workbook = await loadWorkbook(year);
  const sheet = getSheet(workbook, year, month);
  const categories = await loadCategoryConfig();
  return readEntries(sheet, categories).map(({ fillArgb: _fillArgb, ...entry }) => entry);
}

interface ImportMonth {
  month: number;
  sheetName: string;
  /** Protected sheet = the month is locked (see isMonthLocked). */
  locked: boolean;
  entries: LedgerEntryWithFill[];
  /** Rows below the header with something in columns A-C that listMonth
   * skips (no numeric Amount, e.g. a formula or text), so the Excel edition
   * never showed them either. */
  ignoredRows: Array<{ row: number; reason: string }>;
}

export interface ImportYear {
  year: number;
  /** One per month sheet present, in calendar order. */
  months: ImportMonth[];
  /** Sheets that aren't a month name, which the Excel edition never read. */
  otherSheets: string[];
}

/** Everything the importer needs from one year's workbook, read once rather
 * than once per month: each month sheet's entries (parsed exactly as
 * listMonth does), its lock state (as isMonthLocked) and the rows the Excel
 * edition ignored. Read-only. */
export async function readYearForImport(year: number, categories: CategoryConfig[]): Promise<ImportYear> {
  const workbook = await loadWorkbook(year);
  const months: ImportMonth[] = [];
  for (let month = 1; month <= 12; month++) {
    const sheet = workbook.getWorksheet(MONTH_NAMES[month - 1]);
    if (!sheet) continue;
    const entries = readEntries(sheet, categories);
    const ignoredRows: ImportMonth["ignoredRows"] = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const amount = row.getCell(1).value;
      if (typeof amount === "number") return;
      const used = [1, 2, 3].some((c) => {
        const v = row.getCell(c).value;
        return v !== null && v !== undefined && !(typeof v === "string" && !v.trim());
      });
      if (!used) return;
      const reason =
        amount === null || amount === undefined
          ? "no Amount"
          : typeof amount === "object" && "formula" in amount
            ? "the Amount is a formula"
            : "the Amount isn't a number";
      ignoredRows.push({ row: rowNumber, reason });
    });
    months.push({
      month,
      sheetName: sheet.name,
      locked: !!(sheet as unknown as { sheetProtection?: unknown }).sheetProtection,
      entries,
      ignoredRows,
    });
  }
  const otherSheets = workbook.worksheets.map((s) => s.name).filter((name) => !MONTH_NAMES.includes(name));
  return { year, months, otherSheets };
}

export interface MonthSummary {
  month: number; // 1-12
  /** Keyed by category id — always has every currently-configured category
   * present (0 if unused that month), same "always present" shape the
   * fixed-field version used to have, just with a dynamic key set. */
  categoryTotals: Record<string, number>;
  total: number;
}

/** Category totals for every month of a year, for the dashboard. Reuses
 * listMonth rather than re-reading the sheet directly, so it stays in sync
 * with whatever listMonth considers a real entry. A missing month sheet
 * (e.g. 2018 only has Sep-Dec) degrades to a zero row instead of failing
 * the whole year. */
export async function yearSummary(year: number): Promise<MonthSummary[]> {
  const categories = await loadCategoryConfig();
  const emptyTotals = () => Object.fromEntries(categories.map((c) => [c.id, 0]));
  const months: MonthSummary[] = [];

  for (let month = 1; month <= 12; month++) {
    const summary: MonthSummary = { month, categoryTotals: emptyTotals(), total: 0 };

    let entries: LedgerEntry[];
    try {
      entries = await listMonth(year, month);
    } catch {
      months.push(summary);
      continue;
    }

    for (const entry of entries) {
      if (entry.category) summary.categoryTotals[entry.category] = (summary.categoryTotals[entry.category] ?? 0) + entry.amount;
      summary.total += entry.amount;
    }
    months.push(summary);
  }

  return months;
}

/** Flat per-month expense totals for a year — like yearSummary but without the
 * category breakdown, and reads the workbook once instead of once per month
 * (yearSummary calls listMonth 12x, which reopens the file each time; fine for
 * a single year, but wasteful when a caller needs many years' totals at once,
 * e.g. an all-time running total). Index 0 is unused; 1-12 are the months. A
 * missing workbook or sheet degrades to zero, matching yearSummary. */
export async function yearExpenseTotals(year: number): Promise<number[]> {
  const totals = Array.from({ length: 13 }, () => 0);

  let workbook: ExcelJS.Workbook;
  try {
    workbook = await loadWorkbook(year);
  } catch {
    return totals;
  }

  for (let month = 1; month <= 12; month++) {
    let sheet: ExcelJS.Worksheet;
    try {
      sheet = getSheet(workbook, year, month);
    } catch {
      continue;
    }
    let total = 0;
    sheet.eachRow((row) => {
      const value = row.getCell(1).value;
      if (typeof value === "number") total += Math.abs(value);
    });
    totals[month] = total;
  }

  return totals;
}
