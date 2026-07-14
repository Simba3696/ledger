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

// Observed border scheme (Amount/Remarks columns form one boxed table: medium
// left/right edges running the full height, thin borders between rows, and a
// medium bottom border on whichever row is currently last, closing the box.
// The CC column is individually boxed — medium top/right/bottom — on every
// row regardless of position, which is what reads as "thick borders ... for
// the CC cell").
const BORDER_FALLBACK = {
  a: { left: { style: "medium" }, right: { style: "medium" }, top: { style: "thin" }, bottom: { style: "thin" } },
  b: { left: { style: "medium" }, right: { style: "medium" }, top: { style: "thin" }, bottom: { style: "thin" } },
  c: { right: { style: "medium" }, top: { style: "medium" }, bottom: { style: "medium" } },
  closingBottom: { style: "medium", color: { argb: "FF000000" } },
} satisfies { a: Partial<ExcelJS.Borders>; b: Partial<ExcelJS.Borders>; c: Partial<ExcelJS.Borders>; closingBottom: Partial<ExcelJS.Border> };

interface RowBorderTemplate {
  a: Partial<ExcelJS.Borders>;
  b: Partial<ExcelJS.Borders>;
  c: Partial<ExcelJS.Borders>;
  closingBottom: Partial<ExcelJS.Border>;
}

// Amount is right-aligned, Remarks is left-aligned, both vertically centered
// — every existing data row uses this. Without it, ExcelJS defaults to
// bottom alignment, which is what caused new rows to look misaligned.
const AMOUNT_ALIGNMENT: Partial<ExcelJS.Alignment> = { horizontal: "right", vertical: "middle" };
const REMARKS_ALIGNMENT: Partial<ExcelJS.Alignment> = { horizontal: "left", vertical: "middle" };

function cloneBorder<T>(border: T): T {
  return structuredClone(border);
}

/** Border pattern for a "normal" (non-last) row, derived from the sheet's own
 * existing formatting where possible so any manual tweaks the user made are
 * respected, falling back to the observed default for a brand-new sheet.
 * The CC column's border never varies by row position (only by whether that
 * row is actually a card transaction), so it's always the fixed pattern. */
function getBorderTemplate(sheet: ExcelJS.Worksheet, previousLastRow: number): RowBorderTemplate {
  if (previousLastRow < 2) return cloneBorder(BORDER_FALLBACK);

  const lastRow = sheet.getRow(previousLastRow);
  const a = cloneBorder((lastRow.getCell(1).border ?? {}) as Partial<ExcelJS.Borders>);
  const b = cloneBorder((lastRow.getCell(2).border ?? {}) as Partial<ExcelJS.Borders>);

  // Strip the closing bottom border — the row we cloned from was last, but won't be anymore.
  a.bottom = cloneBorder(BORDER_FALLBACK.a.bottom);
  b.bottom = cloneBorder(BORDER_FALLBACK.b.bottom);

  return { a, b, c: cloneBorder(BORDER_FALLBACK.c), closingBottom: cloneBorder(BORDER_FALLBACK.closingBottom) };
}

// ExcelJS caches ONE shared style object per style index when reading a file
// and hands out that SAME reference to every cell that already has an
// identical combined style (normal XLSX-format deduplication — lots of cells
// legitimately share a style index). But `cell.fill =`, `.border =`, etc. all
// mutate that object IN PLACE (`this.style.fill = value`) rather than
// replacing it. Without detaching first, editing one cell silently corrupts
// every other cell that happened to share its style — which is exactly what
// caused categories to cascade across unrelated rows. Cloning (not resetting)
// preserves whatever the cell already had while breaking the shared reference,
// so every cell this module writes to must be detached first.
function detachStyle(cell: ExcelJS.Cell) {
  cell.style = structuredClone(cell.style ?? {});
}

/** The CC cell only ever gets a fill/border when it's an actual card
 * transaction — a non-card row's CC cell is left completely blank (no
 * value, no fill, no border), matching the existing sheets exactly. */
function applyCcCell(cell: ExcelJS.Cell, isCard: boolean, fill: ExcelJS.Fill, border: Partial<ExcelJS.Borders>) {
  // A full reset (not detachStyle's preserve-and-clone) since a non-card cell
  // must end up with no fill/border at all, not whatever it had before.
  cell.style = {};
  cell.value = null;
  if (isCard) {
    cell.value = "CC";
    cell.fill = fill;
    cell.border = border;
  }
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

async function saveWorkbook(workbook: ExcelJS.Workbook, filePath: string): Promise<void> {
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

/** Throws unless `row` is an existing transaction row (a real Amount value), not
 * the header, a spacer row, or a row past the end of the data. */
function assertRealEntryRow(sheet: ExcelJS.Worksheet, row: number, year: number, month: number) {
  if (!Number.isInteger(row) || row < 2 || typeof sheet.getRow(row).getCell(1).value !== "number") {
    throw new LedgerError(`No entry found at row ${row} in ${monthName(month)} ${year}`, 404);
  }
}

/** Re-applies the closing (thick) bottom border to whichever row is now last.
 * Needed after a delete, since the row that ends up last may not be the one
 * that used to carry that border. */
function fixClosingBorder(sheet: ExcelJS.Worksheet) {
  const last = lastDataRow(sheet);
  if (last < 2) return;
  const row = sheet.getRow(last);
  const cell1 = row.getCell(1);
  const cell2 = row.getCell(2);
  detachStyle(cell1);
  detachStyle(cell2);
  cell1.border = { ...cloneBorder((cell1.border ?? {}) as Partial<ExcelJS.Borders>), bottom: cloneBorder(BORDER_FALLBACK.closingBottom) };
  cell2.border = { ...cloneBorder((cell2.border ?? {}) as Partial<ExcelJS.Borders>), bottom: cloneBorder(BORDER_FALLBACK.closingBottom) };
  row.commit();
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
  const previousLastRow = lastDataRow(sheet);
  const rowNumber = previousLastRow + 1;
  const borders = getBorderTemplate(sheet, previousLastRow);
  const row = sheet.getRow(rowNumber);
  const cell1 = row.getCell(1);
  detachStyle(cell1);
  cell1.value = -Math.abs(amount);
  cell1.numFmt = numFmt;
  cell1.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CATEGORY_COLORS[category] } };
  cell1.border = { ...borders.a, bottom: borders.closingBottom };
  cell1.alignment = AMOUNT_ALIGNMENT;

  const cell2 = row.getCell(2);
  detachStyle(cell2);
  cell2.value = remarks.trim();
  cell2.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CATEGORY_COLORS[category] } };
  cell2.border = { ...borders.b, bottom: borders.closingBottom };
  cell2.alignment = REMARKS_ALIGNMENT;

  applyCcCell(row.getCell(3), isCard, { type: "pattern", pattern: "solid", fgColor: { argb: CATEGORY_COLORS[category] } }, borders.c);
  row.commit();

  // The row we just displaced as "last" needs its closing bottom border
  // demoted back to the normal interior pattern.
  if (previousLastRow >= 2) {
    const oldLastRow = sheet.getRow(previousLastRow);
    const oldCell1 = oldLastRow.getCell(1);
    const oldCell2 = oldLastRow.getCell(2);
    detachStyle(oldCell1);
    detachStyle(oldCell2);
    oldCell1.border = borders.a;
    oldCell2.border = borders.b;
    oldLastRow.commit();
  }

  await saveWorkbook(workbook, filePath);

  return {
    row: rowNumber,
    amount: Math.abs(amount),
    remarks: remarks.trim(),
    isCard,
    cardNote: isCard ? "CC" : null,
    category,
  };
}

export interface UpdateEntryInput {
  year: number;
  month: number;
  row: number;
  amount: number;
  remarks: string;
  category: Category;
  isCard: boolean;
}

export async function updateEntry(input: UpdateEntryInput): Promise<LedgerEntry> {
  const { year, month, row: rowNumber, amount, remarks, category, isCard } = input;

  if (!(amount > 0)) throw new LedgerError("Amount must be a positive number", 400);
  if (!remarks || !remarks.trim()) throw new LedgerError("Remarks are required", 400);
  if (!CATEGORY_COLORS[category]) throw new LedgerError(`Unknown category: ${category}`, 400);

  const filePath = workbookPath(year);
  const workbook = await loadWorkbook(year);
  const sheet = getSheet(workbook, year, month);
  assertWritable(sheet, year, month);
  assertRealEntryRow(sheet, rowNumber, year, month);

  // Editing never changes position, so the Amount/Remarks borders are left
  // untouched. The CC cell's border is tied to isCard rather than position
  // though, so it still needs to be (re)applied or cleared via applyCcCell.
  const row = sheet.getRow(rowNumber);

  const cell1 = row.getCell(1);
  detachStyle(cell1); // preserves cell1's existing border (untouched by design) while breaking any shared reference
  cell1.value = -Math.abs(amount);
  cell1.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CATEGORY_COLORS[category] } };
  cell1.alignment = AMOUNT_ALIGNMENT;

  const cell2 = row.getCell(2);
  detachStyle(cell2);
  cell2.value = remarks.trim();
  cell2.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CATEGORY_COLORS[category] } };
  cell2.alignment = REMARKS_ALIGNMENT;

  const cell3 = row.getCell(3);
  applyCcCell(cell3, isCard, { type: "pattern", pattern: "solid", fgColor: { argb: CATEGORY_COLORS[category] } }, cloneBorder(BORDER_FALLBACK.c));
  row.commit();

  await saveWorkbook(workbook, filePath);

  return {
    row: rowNumber,
    amount: Math.abs(amount),
    remarks: remarks.trim(),
    isCard,
    cardNote: isCard ? "CC" : null,
    category,
  };
}

export interface DeleteEntryInput {
  year: number;
  month: number;
  row: number;
}

export async function deleteEntry(input: DeleteEntryInput): Promise<void> {
  const { year, month, row: rowNumber } = input;

  const filePath = workbookPath(year);
  const workbook = await loadWorkbook(year);
  const sheet = getSheet(workbook, year, month);
  assertWritable(sheet, year, month);
  assertRealEntryRow(sheet, rowNumber, year, month);

  sheet.spliceRows(rowNumber, 1); // shifts every row below up by one, carrying its formatting with it
  fixClosingBorder(sheet);

  await saveWorkbook(workbook, filePath);
}

export interface MoveEntryInput {
  year: number;
  month: number;
  fromRow: number;
  toRow: number;
}

interface RowSnapshot {
  amount: number;
  remarks: string;
  ccValue: string | null;
  fill?: ExcelJS.Fill;
  numFmt: string;
}

/** Moves an entry to a different position within the same month (drag-to-reorder).
 * Rather than juggle splice/insert index math, this snapshots every data row's
 * content in order, reorders that array in memory, then rewrites rows 2..last
 * from it — simpler to get right, and the row count here is always small. */
export async function moveEntry(input: MoveEntryInput): Promise<void> {
  const { year, month, fromRow, toRow } = input;

  const filePath = workbookPath(year);
  const workbook = await loadWorkbook(year);
  const sheet = getSheet(workbook, year, month);
  assertWritable(sheet, year, month);
  assertRealEntryRow(sheet, fromRow, year, month);

  const last = lastDataRow(sheet);
  if (!Number.isInteger(toRow) || toRow < 2 || toRow > last) {
    throw new LedgerError(`Invalid target row: ${toRow}`, 400);
  }
  if (fromRow === toRow) return;

  const snapshots: RowSnapshot[] = [];
  for (let r = 2; r <= last; r++) {
    const row = sheet.getRow(r);
    const amount = row.getCell(1).value;
    if (typeof amount !== "number") {
      throw new LedgerError(`Unexpected non-entry row at ${r}; reordering aborted`, 500);
    }
    const remarksValue = row.getCell(2).value;
    const ccValue = row.getCell(3).value;
    snapshots.push({
      amount,
      remarks: typeof remarksValue === "string" ? remarksValue : String(remarksValue ?? ""),
      ccValue: typeof ccValue === "string" && ccValue.trim() ? ccValue : null,
      fill: cloneBorder(row.getCell(1).fill),
      numFmt: row.getCell(1).numFmt ?? FALLBACK_AMOUNT_NUMFMT,
    });
  }

  const [moved] = snapshots.splice(fromRow - 2, 1);
  snapshots.splice(toRow - 2, 0, moved);

  snapshots.forEach((snap, i) => {
    const row = sheet.getRow(i + 2);
    const fill = snap.fill ?? { type: "pattern", pattern: "none" };

    // Every property is rewritten from the snapshot regardless of what this
    // row position previously held, so a full style reset (rather than
    // detachStyle's preserve-and-clone) is correct here.
    const cell1 = row.getCell(1);
    cell1.style = {};
    cell1.value = snap.amount;
    cell1.numFmt = snap.numFmt;
    cell1.fill = fill;
    cell1.alignment = AMOUNT_ALIGNMENT;
    cell1.border = cloneBorder(BORDER_FALLBACK.a);

    const cell2 = row.getCell(2);
    cell2.style = {};
    cell2.value = snap.remarks;
    cell2.fill = fill;
    cell2.alignment = REMARKS_ALIGNMENT;
    cell2.border = cloneBorder(BORDER_FALLBACK.b);

    applyCcCell(row.getCell(3), !!snap.ccValue, fill, cloneBorder(BORDER_FALLBACK.c));
    if (snap.ccValue) row.getCell(3).value = snap.ccValue; // preserve notes like "CC (200)"

    row.commit();
  });

  fixClosingBorder(sheet);

  await saveWorkbook(workbook, filePath);
}
