import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { DB_DIR, LedgerError, saveWorkbook } from "./workbookIO.js";
import { makeDate, parseDate, formatDate, startOfDay } from "./dateMath.js";

const EMI_PATH = path.join(DB_DIR, "EMI.xlsx");
const SHEET_NAME = "EMI";
const HEADERS = ["Card/Bank", "EMI Amount", "Due Day", "Total Amount", "Remarks", "Remaining As Of", "As Of Date"];

/** A loan/EMI plan, tracked flat (not month-indexed) like Debts — there's no
 * fixed count of active loans, so adding one or foreclosing one is just
 * adding/removing a row. */
export interface EmiEntry {
  row: number;
  cardOrBank: string;
  /** Fixed monthly installment amount. */
  emiAmount: number;
  /** Day of month the installment is due (1-31, clamped to the real last day
   * of shorter months — e.g. 31 in February becomes the 28th/29th). */
  dueDay: number;
  /** The original total amount of the loan — a fixed fact entered once, never
   * recomputed. */
  totalAmount: number;
  remarks: string;
  /** The real outstanding balance as of `asOfDate` — a snapshot the user
   * enters from their own bank/card statement, not a running total the app
   * invents. Everything since that date is projected forward automatically
   * (see `computeRemaining`). */
  remainingAsOf: number;
  asOfDate: string; // YYYY-MM-DD
}

export interface EmiEntryComputed extends EmiEntry {
  /** Auto-decayed from `remainingAsOf`: `emiAmount` less for every due date
   * that has passed since `asOfDate`, floored at 0. Never written back to the
   * sheet — always computed fresh relative to "now" so it can never drift out
   * of sync the way a manually-typed running balance could. */
  remaining: number;
  isPaidOff: boolean;
  /** YYYY-MM of the due date on which `remaining` is projected to hit zero,
   * or null once already paid off. Replaces a manually-typed "Until" date
   * (which could silently fall out of sync with the real balance). */
  estimatedPayoffMonth: string | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Counts how many monthly due dates (on `dueDay`) fall strictly after
 * `asOfDate` and on or before `today` — the number of installments that have
 * been paid since the snapshot was taken. */
function countDueDatesPassed(asOfDate: Date, dueDay: number, today: Date): number {
  let year = asOfDate.getFullYear();
  let month = asOfDate.getMonth() + 1;
  let count = 0;
  for (let i = 0; i < 1200; i++) {
    const due = makeDate(year, month, dueDay);
    if (due > today) break;
    if (due > asOfDate) count++;
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return count;
}

/** Finds the YYYY-MM of the Nth monthly due date strictly after `today`. */
function nthFutureDueMonth(dueDay: number, n: number, today: Date): string | null {
  let year = today.getFullYear();
  let month = today.getMonth() + 1;
  let found = 0;
  for (let i = 0; i < 1200; i++) {
    const due = makeDate(year, month, dueDay);
    if (due > today) {
      found++;
      if (found === n) return `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}`;
    }
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return null;
}

export function withComputed(entry: EmiEntry, today: Date = new Date()): EmiEntryComputed {
  const asOf = parseDate(entry.asOfDate);
  const passed = countDueDatesPassed(asOf, entry.dueDay, startOfDay(today));
  const remaining = Math.max(0, round2(entry.remainingAsOf - passed * entry.emiAmount));
  const isPaidOff = remaining <= 0;
  const estimatedPayoffMonth = isPaidOff
    ? null
    : nthFutureDueMonth(entry.dueDay, Math.ceil(remaining / entry.emiAmount), startOfDay(today));
  return { ...entry, remaining, isPaidOff, estimatedPayoffMonth };
}

function validateEntry(cardOrBank: string, emiAmount: number, dueDay: number, totalAmount: number, remainingAsOf: number) {
  if (!cardOrBank) throw new LedgerError("Card/Bank is required", 400);
  if (!Number.isFinite(emiAmount) || emiAmount <= 0) throw new LedgerError("EMI Amount must be a positive number", 400);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) throw new LedgerError("Due Day must be between 1 and 31", 400);
  if (!Number.isFinite(totalAmount) || totalAmount < 0) throw new LedgerError("Total Amount must be a number", 400);
  if (!Number.isFinite(remainingAsOf) || remainingAsOf < 0) throw new LedgerError("Remaining must be a number", 400);
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
  if (fs.existsSync(EMI_PATH)) {
    await workbook.xlsx.readFile(EMI_PATH);
  } else {
    workbook.addWorksheet(SHEET_NAME).addRow(HEADERS);
  }
  return workbook;
}

function getEmiSheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) throw new LedgerError(`EMI.xlsx is missing its "${SHEET_NAME}" sheet`, 500);
  return sheet;
}

function assertRealEmiRow(sheet: ExcelJS.Worksheet, row: number) {
  const cardOrBank = row >= 2 ? sheet.getRow(row).getCell(1).value : null;
  if (typeof cardOrBank !== "string" || !cardOrBank.trim()) {
    throw new LedgerError(`No EMI entry at row ${row}`, 404);
  }
}

export async function listEmis(today: Date = new Date()): Promise<EmiEntryComputed[]> {
  const workbook = await loadOrCreateWorkbook();
  const sheet = getEmiSheet(workbook);
  const entries: EmiEntry[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cardOrBank = row.getCell(1).value;
    const emiAmount = resolveNumber(row.getCell(2).value);
    const dueDay = resolveNumber(row.getCell(3).value);
    const totalAmount = resolveNumber(row.getCell(4).value);
    const remarks = row.getCell(5).value;
    const remainingAsOf = resolveNumber(row.getCell(6).value);
    const asOfDate = row.getCell(7).value;
    if (
      typeof cardOrBank === "string" &&
      cardOrBank.trim() &&
      emiAmount !== null &&
      dueDay !== null &&
      totalAmount !== null &&
      remainingAsOf !== null &&
      typeof asOfDate === "string"
    ) {
      entries.push({
        row: rowNumber,
        cardOrBank,
        emiAmount,
        dueDay,
        totalAmount,
        remarks: typeof remarks === "string" ? remarks : "",
        remainingAsOf,
        asOfDate,
      });
    }
  });
  return entries.map((e) => withComputed(e, today));
}

export interface EmiEditsInput {
  cardOrBank: string;
  emiAmount: number;
  dueDay: number;
  totalAmount: number;
  remarks: string;
  /** The user's current real balance — becomes the new decay anchor, dated
   * to today (see `withComputed`). */
  remainingAsOf: number;
}

export async function addEmi(input: EmiEditsInput, today: Date = new Date()): Promise<EmiEntryComputed> {
  const cardOrBank = input.cardOrBank.trim();
  validateEntry(cardOrBank, input.emiAmount, input.dueDay, input.totalAmount, input.remainingAsOf);

  const workbook = await loadOrCreateWorkbook();
  const sheet = getEmiSheet(workbook);
  const rowNumber = sheet.rowCount + 1;
  const asOfDate = formatDate(startOfDay(today));
  const row = sheet.getRow(rowNumber);
  row.getCell(1).value = cardOrBank;
  row.getCell(2).value = input.emiAmount;
  row.getCell(3).value = input.dueDay;
  row.getCell(4).value = input.totalAmount;
  row.getCell(5).value = input.remarks.trim();
  row.getCell(6).value = input.remainingAsOf;
  row.getCell(7).value = asOfDate;
  row.commit();

  await saveWorkbook(workbook, EMI_PATH);
  const entry: EmiEntry = {
    row: rowNumber,
    cardOrBank,
    emiAmount: input.emiAmount,
    dueDay: input.dueDay,
    totalAmount: input.totalAmount,
    remarks: input.remarks.trim(),
    remainingAsOf: input.remainingAsOf,
    asOfDate,
  };
  return withComputed(entry, today);
}

export async function updateEmi(
  rowNumber: number,
  input: EmiEditsInput,
  today: Date = new Date(),
): Promise<EmiEntryComputed> {
  const cardOrBank = input.cardOrBank.trim();
  validateEntry(cardOrBank, input.emiAmount, input.dueDay, input.totalAmount, input.remainingAsOf);

  const workbook = await loadOrCreateWorkbook();
  const sheet = getEmiSheet(workbook);
  assertRealEmiRow(sheet, rowNumber);

  const asOfDate = formatDate(startOfDay(today));
  const row = sheet.getRow(rowNumber);
  row.getCell(1).value = cardOrBank;
  row.getCell(2).value = input.emiAmount;
  row.getCell(3).value = input.dueDay;
  row.getCell(4).value = input.totalAmount;
  row.getCell(5).value = input.remarks.trim();
  row.getCell(6).value = input.remainingAsOf;
  row.getCell(7).value = asOfDate;
  row.commit();

  await saveWorkbook(workbook, EMI_PATH);
  const entry: EmiEntry = {
    row: rowNumber,
    cardOrBank,
    emiAmount: input.emiAmount,
    dueDay: input.dueDay,
    totalAmount: input.totalAmount,
    remarks: input.remarks.trim(),
    remainingAsOf: input.remainingAsOf,
    asOfDate,
  };
  return withComputed(entry, today);
}

/** Removes an EMI entry entirely — e.g. after foreclosing a loan early. */
export async function deleteEmi(rowNumber: number): Promise<void> {
  const workbook = await loadOrCreateWorkbook();
  const sheet = getEmiSheet(workbook);
  assertRealEmiRow(sheet, rowNumber);

  sheet.spliceRows(rowNumber, 1);
  await saveWorkbook(workbook, EMI_PATH);
}
