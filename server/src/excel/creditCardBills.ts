import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { DB_DIR, LedgerError, saveWorkbook } from "./workbookIO.js";

export const EARLIEST_YEAR = 2018;

const BILLS_PATH = path.join(DB_DIR, "CreditCardBills.xlsx");
const SHEET_NAME = "Bills";
const HEADERS = ["Year", "Month", "Cards"];

export interface CardBill {
  name: string;
  /** Amount due for this card's bill this month. */
  due: number;
  /** Amount actually paid. */
  paid: number;
  /** This card's own due date this month, YYYY-MM-DD, or null if not entered. */
  dueDate: string | null;
  /** Marked true once this bill is paid off, even if a payment app's rounding
   * left a rupee or two of (due − paid) gap that isn't real debt. A settled
   * card contributes 0 to Net Worth's credit card outstanding and is excluded
   * from the Dashboard's Upcoming list, regardless of its raw due/paid gap. */
  settled: boolean;
}

function validateYearMonth(year: number, month: number) {
  if (!Number.isInteger(year) || year < EARLIEST_YEAR) throw new LedgerError(`Invalid year: ${year}`, 400);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new LedgerError(`Invalid month: ${month}`, 400);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validateCards(cards: CardBill[]) {
  for (const card of cards) {
    if (!card.name || !card.name.trim()) throw new LedgerError("Each card needs a name", 400);
    if (!Number.isFinite(card.due)) throw new LedgerError(`Amount due for "${card.name}" must be a number`, 400);
    if (!Number.isFinite(card.paid)) throw new LedgerError(`Amount paid for "${card.name}" must be a number`, 400);
    if (card.dueDate !== null && !DATE_PATTERN.test(card.dueDate)) {
      throw new LedgerError(`Due date for "${card.name}" must be YYYY-MM-DD or null`, 400);
    }
    if (typeof card.settled !== "boolean") {
      throw new LedgerError(`Settled flag for "${card.name}" must be a boolean`, 400);
    }
  }
}

/** Cards are stored as a JSON array in one cell, the same reasoning as
 * Finances' Current Savings breakdown: the number of cards changes over time
 * (a card or loan can be added or paid off), so a flexible named list beats a
 * fixed set of columns. */
function parseCardsCell(value: ExcelJS.CellValue): CardBill[] {
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        const result: CardBill[] = [];
        for (const c of parsed) {
          if (
            c &&
            typeof c === "object" &&
            typeof c.name === "string" &&
            typeof c.due === "number" &&
            typeof c.paid === "number" &&
            (c.dueDate === null || typeof c.dueDate === "string")
          ) {
            // `settled` is a new field — entries written before it existed
            // default to false (unsettled) rather than being rejected.
            result.push({ name: c.name, due: c.due, paid: c.paid, dueDate: c.dueDate, settled: c.settled === true });
          }
        }
        return result;
      }
    } catch {
      return [];
    }
  }
  return [];
}

async function loadOrCreateWorkbook(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  if (fs.existsSync(BILLS_PATH)) {
    await workbook.xlsx.readFile(BILLS_PATH);
  } else {
    workbook.addWorksheet(SHEET_NAME).addRow(HEADERS);
  }
  return workbook;
}

function getBillsSheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) throw new LedgerError(`CreditCardBills.xlsx is missing its "${SHEET_NAME}" sheet`, 500);
  return sheet;
}

function findMonthRow(sheet: ExcelJS.Worksheet, year: number, month: number): ExcelJS.Row | undefined {
  let found: ExcelJS.Row | undefined;
  sheet.eachRow((row, rowNumber) => {
    if (found || rowNumber === 1) return;
    if (row.getCell(1).value === year && row.getCell(2).value === month) found = row;
  });
  return found;
}

export interface MonthBills {
  year: number;
  month: number;
  cards: CardBill[];
}

export async function getMonthBills(year: number, month: number): Promise<MonthBills> {
  validateYearMonth(year, month);
  const workbook = await loadOrCreateWorkbook();
  const sheet = getBillsSheet(workbook);
  const row = findMonthRow(sheet, year, month);
  return { year, month, cards: row ? parseCardsCell(row.getCell(3).value) : [] };
}

export interface SetMonthBillsInput {
  year: number;
  month: number;
  cards: CardBill[];
}

export async function setMonthBills(input: SetMonthBillsInput): Promise<MonthBills> {
  const { year, month, cards } = input;
  validateYearMonth(year, month);
  validateCards(cards);

  const workbook = await loadOrCreateWorkbook();
  const sheet = getBillsSheet(workbook);
  let row = findMonthRow(sheet, year, month);
  if (!row) {
    row = sheet.getRow(sheet.rowCount + 1);
    row.getCell(1).value = year;
    row.getCell(2).value = month;
  }
  row.getCell(3).value = cards.length > 0 ? JSON.stringify(cards) : null;
  row.commit();

  await saveWorkbook(workbook, BILLS_PATH);
  return { year, month, cards };
}

export interface MonthBillsSummary extends MonthBills {
  totalDue: number;
  totalPaid: number;
  /** Earliest of each card's own due date this month, or null if none entered. */
  earliestDueDate: string | null;
  /** totalDue - totalPaid, matching the sign convention already used by hand:
   * negative = overpaid (paid more than due), positive = saved a little
   * (paid less, e.g. a bill-payment app rounding down). */
  overpaidOrSaved: number;
}

function summarize(month: MonthBills): MonthBillsSummary {
  const totalDue = month.cards.reduce((sum, c) => sum + c.due, 0);
  const totalPaid = month.cards.reduce((sum, c) => sum + c.paid, 0);
  const dueDates = month.cards.map((c) => c.dueDate).filter((d): d is string => d !== null);
  const earliestDueDate = dueDates.length > 0 ? dueDates.reduce((a, b) => (a < b ? a : b)) : null;
  return { ...month, totalDue, totalPaid, earliestDueDate, overpaidOrSaved: totalDue - totalPaid };
}

/** All 12 months of a year, each independently summarized (unlike Finances,
 * there's no running/cumulative figure here — every month's bills stand on
 * their own). Months with nothing entered come back with an empty card list
 * and zeroed totals rather than being omitted, so the UI can always render
 * a full 12-row year. */
export async function yearBillsSummary(year: number): Promise<MonthBillsSummary[]> {
  if (!Number.isInteger(year) || year < EARLIEST_YEAR) throw new LedgerError(`Invalid year: ${year}`, 400);

  const workbook = await loadOrCreateWorkbook();
  const sheet = getBillsSheet(workbook);
  const byMonth = new Map<number, CardBill[]>();
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const y = row.getCell(1).value;
    const m = row.getCell(2).value;
    if (typeof y !== "number" || typeof m !== "number" || y !== year) return;
    byMonth.set(m, parseCardsCell(row.getCell(3).value));
  });

  const results: MonthBillsSummary[] = [];
  for (let month = 1; month <= 12; month++) {
    results.push(summarize({ year, month, cards: byMonth.get(month) ?? [] }));
  }
  return results;
}
