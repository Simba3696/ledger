import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { DB_DIR, LedgerError, saveWorkbook, withFileLock } from "./workbookIO.js";

const DEBTS_PATH = path.join(DB_DIR, "Debts.xlsx");
const SHEET_NAME = "Debts";
const HEADERS = ["Name", "Amount"];

export interface DebtEntry {
  row: number;
  name: string;
  /** Negative = money the user lent out (owed back to them); positive = money
   * the user owes someone else. Matches the sign convention already used in
   * the source Expense Summary.xlsm Debts sheet. */
  amount: number;
}

function resolveNumber(value: ExcelJS.CellValue): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "result" in value && typeof value.result === "number") {
    return value.result;
  }
  return null;
}

function validateEntry(name: string, amount: number) {
  if (!name) throw new LedgerError("Name is required", 400);
  if (!Number.isFinite(amount)) throw new LedgerError("Amount must be a number", 400);
}

async function loadOrCreateWorkbook(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  if (fs.existsSync(DEBTS_PATH)) {
    await workbook.xlsx.readFile(DEBTS_PATH);
  } else {
    workbook.addWorksheet(SHEET_NAME).addRow(HEADERS);
  }
  return workbook;
}

function getDebtsSheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) throw new LedgerError(`Debts.xlsx is missing its "${SHEET_NAME}" sheet`, 500);
  return sheet;
}

/** Throws unless `row` is an existing debt entry (a real name in column A),
 * not the header or a row past the end of the data. */
function assertRealDebtRow(sheet: ExcelJS.Worksheet, row: number) {
  const name = row >= 2 ? sheet.getRow(row).getCell(1).value : null;
  if (typeof name !== "string" || !name.trim()) {
    throw new LedgerError(`No debt entry at row ${row}`, 404);
  }
}

export async function listDebts(): Promise<DebtEntry[]> {
  const workbook = await loadOrCreateWorkbook();
  const sheet = getDebtsSheet(workbook);
  const entries: DebtEntry[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const name = row.getCell(1).value;
    const amount = resolveNumber(row.getCell(2).value);
    if (typeof name === "string" && name.trim() && amount !== null) {
      entries.push({ row: rowNumber, name, amount });
    }
  });
  return entries;
}

export interface AddDebtInput {
  name: string;
  amount: number;
}

export async function addDebt(input: AddDebtInput): Promise<DebtEntry> {
  const name = input.name.trim();
  validateEntry(name, input.amount);

  return withFileLock(DEBTS_PATH, async () => {
    const workbook = await loadOrCreateWorkbook();
    const sheet = getDebtsSheet(workbook);
    const rowNumber = sheet.rowCount + 1;
    const row = sheet.getRow(rowNumber);
    row.getCell(1).value = name;
    row.getCell(2).value = input.amount;
    row.commit();

    await saveWorkbook(workbook, DEBTS_PATH);
    return { row: rowNumber, name, amount: input.amount };
  });
}

export interface UpdateDebtInput {
  row: number;
  name: string;
  amount: number;
}

export async function updateDebt(input: UpdateDebtInput): Promise<DebtEntry> {
  const name = input.name.trim();
  validateEntry(name, input.amount);

  return withFileLock(DEBTS_PATH, async () => {
    const workbook = await loadOrCreateWorkbook();
    const sheet = getDebtsSheet(workbook);
    assertRealDebtRow(sheet, input.row);

    const row = sheet.getRow(input.row);
    row.getCell(1).value = name;
    row.getCell(2).value = input.amount;
    row.commit();

    await saveWorkbook(workbook, DEBTS_PATH);
    return { row: input.row, name, amount: input.amount };
  });
}

export async function deleteDebt(rowNumber: number): Promise<void> {
  await withFileLock(DEBTS_PATH, async () => {
    const workbook = await loadOrCreateWorkbook();
    const sheet = getDebtsSheet(workbook);
    assertRealDebtRow(sheet, rowNumber);

    sheet.spliceRows(rowNumber, 1);
    await saveWorkbook(workbook, DEBTS_PATH);
  });
}
