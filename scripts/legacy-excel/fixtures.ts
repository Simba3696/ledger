import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { categoryArgb, DEFAULT_CATEGORIES, type Category, type CategoryConfig } from "./categoryColors.js";

// Mirrors the real sheets' conventions (verified against the user's actual
// workbooks during development) so tests exercise the same code paths a real
// file would. Entirely synthetic data — no real financial records are ever
// written to this repo.
const AMOUNT_NUMFMT =
  '_ [$₹-4009]\\ * #,##0.00_ ;_ [$₹-4009]\\ * \\-#,##0.00_ ;_ [$₹-4009]\\ * "-"??_ ;_ @_ ';

export interface SeedEntry {
  amount: number; // positive rupee amount
  remarks: string;
  category: Category;
  isCard?: boolean;
  /** Overrides the "CC" note, e.g. "CC (200)". */
  cardNote?: string;
  /** Overrides the category's fill, e.g. a colour no category uses. */
  fillArgb?: string;
  /** Overrides the Amount cell's value (e.g. a formula, which the Excel
   * edition doesn't read as an entry). */
  rawAmount?: ExcelJS.CellValue;
}

function addSeedRow(sheet: ExcelJS.Worksheet, rowNumber: number, entry: SeedEntry, isLast: boolean, categories: CategoryConfig[]) {
  const categoryConfig = categories.find((c) => c.id === entry.category);
  const argb = entry.fillArgb ?? (categoryConfig ? categoryArgb(categoryConfig) : "FF000000");
  const fill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
  const closingBottom: Partial<ExcelJS.Border> = { style: "medium", color: { argb: "FF000000" } };
  const row = sheet.getRow(rowNumber);

  const cell1 = row.getCell(1);
  cell1.value = entry.rawAmount !== undefined ? entry.rawAmount : -Math.abs(entry.amount);
  cell1.numFmt = AMOUNT_NUMFMT;
  cell1.fill = fill;
  cell1.alignment = { horizontal: "right", vertical: "middle" };
  cell1.border = {
    left: { style: "medium" },
    right: { style: "medium" },
    top: { style: "thin" },
    bottom: isLast ? closingBottom : { style: "thin" },
  };

  const cell2 = row.getCell(2);
  cell2.value = entry.remarks;
  cell2.fill = fill;
  cell2.alignment = { horizontal: "left", vertical: "middle" };
  cell2.border = cell1.border;

  if (entry.isCard) {
    const cell3 = row.getCell(3);
    cell3.value = entry.cardNote ?? "CC";
    cell3.fill = fill;
    cell3.border = { right: { style: "medium" }, top: { style: "medium" }, bottom: { style: "medium" } };
  }

  row.commit();
}

export interface FixtureSheet {
  name: string;
  entries: SeedEntry[];
  protect?: boolean;
}

/** Builds a synthetic workbook matching the real sheets' conventions and
 * writes it to `filePath`. Each key in `sheets` is a month sheet name. Fill
 * colours come from `categories` (the folder's categories.json, if the
 * fixture writes one with writeCategoriesJson). */
export async function buildFixtureWorkbook(
  filePath: string,
  sheets: FixtureSheet[],
  categories: CategoryConfig[] = DEFAULT_CATEGORIES,
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  for (const { name, entries, protect } of sheets) {
    const sheet = workbook.addWorksheet(name);
    sheet.getRow(1).getCell(1).value = "Amount";
    sheet.getRow(1).getCell(2).value = "Remarks";
    sheet.getRow(1).getCell(3).value = "CC";

    entries.forEach((entry, i) => addSeedRow(sheet, i + 2, entry, i === entries.length - 1, categories));

    if (protect) {
      await sheet.protect("test-password", {});
    }
  }
  await workbook.xlsx.writeFile(filePath);
}

/** Writes a one-sheet workbook with a header row and then `rows` from row 2,
 * the layout every flat Excel-edition workbook uses. Cells are written
 * verbatim, so a fixture can hold the same values the app wrote (dates as
 * YYYY-MM-DD text, savings and card lists as JSON text) or a malformed one. */
async function buildSheetWorkbook(filePath: string, sheetName: string, headers: string[], rows: ExcelJS.CellValue[][]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  await workbook.xlsx.writeFile(filePath);
}

/** Finances.xlsx: [year, month, salary, otherIncome, savings JSON text]. */
export function buildFinancesWorkbook(dir: string, rows: ExcelJS.CellValue[][]): Promise<void> {
  return buildSheetWorkbook(path.join(dir, "Finances.xlsx"), "Income", ["Year", "Month", "Salary", "Other Income", "Current Savings Breakdown"], rows);
}

/** Debts.xlsx: [name, amount]. */
export function buildDebtsWorkbook(dir: string, rows: ExcelJS.CellValue[][]): Promise<void> {
  return buildSheetWorkbook(path.join(dir, "Debts.xlsx"), "Debts", ["Name", "Amount"], rows);
}

/** EMI.xlsx: [cardOrBank, emiAmount, dueDay, totalAmount, remarks,
 * remainingAsOf, asOfDate, untilTarget, interestRate, foreclosureCharge]. */
export function buildEmiWorkbook(dir: string, rows: ExcelJS.CellValue[][]): Promise<void> {
  return buildSheetWorkbook(
    path.join(dir, "EMI.xlsx"),
    "EMI",
    ["Card/Bank", "EMI Amount", "Due Day", "Total Amount", "Remarks", "Remaining As Of", "As Of Date", "Until Target", "Interest Rate (%)", "Foreclosure Charge (%)"],
    rows,
  );
}

/** Subscriptions.xlsx: [service, amount, duration, expiry, cardOrBank]. */
export function buildSubscriptionsWorkbook(dir: string, rows: ExcelJS.CellValue[][]): Promise<void> {
  return buildSheetWorkbook(path.join(dir, "Subscriptions.xlsx"), "Subscriptions", ["Service", "Amount", "Duration", "Expiry", "Card/Bank"], rows);
}

/** CreditCardBills.xlsx: [year, month, cards JSON text]. */
export function buildCardBillsWorkbook(dir: string, rows: ExcelJS.CellValue[][]): Promise<void> {
  return buildSheetWorkbook(path.join(dir, "CreditCardBills.xlsx"), "Bills", ["Year", "Month", "Cards"], rows);
}

/** categories.json, as a hand-edited file would hold it (fg optional). */
export function writeCategoriesJson(dir: string, categories: Array<Partial<CategoryConfig>>): void {
  fs.writeFileSync(path.join(dir, "categories.json"), JSON.stringify(categories, null, 2) + "\n");
}
