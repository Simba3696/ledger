import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { getDbDir, LedgerError, saveWorkbook, withFileLock } from "./workbookIO.js";

export const EARLIEST_YEAR = 2018;

function billsPath(): string {
  return path.join(getDbDir(), "CreditCardBills.xlsx");
}
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
  if (fs.existsSync(billsPath())) {
    await workbook.xlsx.readFile(billsPath());
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

export interface BillsRow {
  row: number;
  year: number;
  month: number;
  cards: CardBill[];
  /** The raw Cards cell, so the importer can report entries parseCardsCell dropped. */
  rawCards: ExcelJS.CellValue;
}

/** Every data row of the Bills sheet in sheet order, parsed with the same
 * parseCardsCell as getMonthBills, for the importer. Rows whose Year or
 * Month isn't a number come back in `ignored`. Read-only; `null` when the
 * folder has no CreditCardBills.xlsx. */
export async function listBillsRows(): Promise<{ rows: BillsRow[]; ignored: number[] } | null> {
  if (!fs.existsSync(billsPath())) return null;
  const sheet = getBillsSheet(await loadOrCreateWorkbook());
  const rows: BillsRow[] = [];
  const ignored: number[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const y = row.getCell(1).value;
    const m = row.getCell(2).value;
    if (typeof y !== "number" || typeof m !== "number") {
      ignored.push(rowNumber);
      return;
    }
    rows.push({ row: rowNumber, year: y, month: m, cards: parseCardsCell(row.getCell(3).value), rawCards: row.getCell(3).value });
  });
  return { rows, ignored };
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

  return withFileLock(billsPath(), async () => {
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

    await saveWorkbook(workbook, billsPath());
    return { year, month, cards };
  });
}

export interface MonthBillsSummary extends MonthBills {
  totalDue: number;
  totalPaid: number;
  /** Earliest of each card's own due date this month, or null if none entered. */
  earliestDueDate: string | null;
  /** Sum of (due - paid) across only *settled* cards, matching the sign
   * convention already used by hand: negative = overpaid (paid more than
   * due), positive = saved a little (paid less, e.g. a bill-payment app
   * rounding down). An unsettled card's raw gap is just an in-progress bill,
   * not a real result yet — same reasoning as `cardOutstanding` in
   * overview.ts, which likewise ignores a settled card's gap (there, in the
   * opposite direction: a settled card contributes 0 outstanding regardless
   * of its gap; here, an *unsettled* card contributes 0 to this stat
   * regardless of its gap). Total Due/Total Paid below are unaffected by
   * this — they still sum every card, settled or not. */
  overpaidOrSaved: number;
}

function summarize(month: MonthBills): MonthBillsSummary {
  const totalDue = month.cards.reduce((sum, c) => sum + c.due, 0);
  const totalPaid = month.cards.reduce((sum, c) => sum + c.paid, 0);
  const dueDates = month.cards.map((c) => c.dueDate).filter((d): d is string => d !== null);
  const earliestDueDate = dueDates.length > 0 ? dueDates.reduce((a, b) => (a < b ? a : b)) : null;
  const overpaidOrSaved = month.cards.reduce((sum, c) => sum + (c.settled ? c.due - c.paid : 0), 0);
  return { ...month, totalDue, totalPaid, earliestDueDate, overpaidOrSaved };
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
