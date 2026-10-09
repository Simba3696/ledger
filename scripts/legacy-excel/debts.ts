import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { getDbDir, LedgerError } from "./workbookIO.js";

function debtsPath(): string {
  return path.join(getDbDir(), "Debts.xlsx");
}
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

async function loadOrCreateWorkbook(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  if (fs.existsSync(debtsPath())) {
    await workbook.xlsx.readFile(debtsPath());
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
