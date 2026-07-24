import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { DB_DIR, LedgerError, saveWorkbook } from "./workbookIO.js";
import { yearExpenseTotals } from "./ledger.js";

export const EARLIEST_YEAR = 2018;

const FINANCES_PATH = path.join(DB_DIR, "Finances.xlsx");
const SHEET_NAME = "Income";
const HEADERS = ["Year", "Month", "Salary", "Other Income", "Current Savings Breakdown"];

export interface SavingsEntry {
  name: string; // e.g. "PPF", "NPS", "APY"
  amount: number;
}

function numberOrNull(value: ExcelJS.CellValue): number | null {
  if (typeof value === "number") return value;
  // Defensive: if the user ever hand-edits Finances.xlsx with a formula (as they
  // routinely do in Expense Summary.xlsm, e.g. "=1500+1500" for a split salary),
  // ExcelJS returns { formula, result } rather than a plain number.
  if (value && typeof value === "object" && "result" in value && typeof value.result === "number") {
    return value.result;
  }
  return null;
}

/** Current Savings is stored as a JSON array of named scheme balances (PPF,
 * NPS, APY, ...) in one cell, rather than a single number, since the set of
 * schemes changes over time (a scheme can be added or exited) and the total
 * is just their sum. A bare number is also accepted on read as a legacy
 * single-entry breakdown, in case a cell was ever set that way directly. */
function parseSavingsCell(value: ExcelJS.CellValue): SavingsEntry[] {
  if (typeof value === "number") return [{ name: "Total", amount: value }];
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (e): e is SavingsEntry =>
            e && typeof e === "object" && typeof e.name === "string" && typeof e.amount === "number",
        );
      }
    } catch {
      return [];
    }
  }
  return [];
}

function sumSavings(savings: SavingsEntry[]): number {
  return savings.reduce((sum, s) => sum + s.amount, 0);
}

function validateYearMonth(year: number, month: number) {
  if (!Number.isInteger(year) || year < EARLIEST_YEAR) throw new LedgerError(`Invalid year: ${year}`, 400);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new LedgerError(`Invalid month: ${month}`, 400);
}

function validateAmount(value: number | null, label: string) {
  if (value === null) return;
  if (!Number.isFinite(value)) throw new LedgerError(`${label} must be a number`, 400);
}

function validateSavings(savings: SavingsEntry[]) {
  for (const entry of savings) {
    if (!entry.name || !entry.name.trim()) throw new LedgerError("Each savings entry needs a name", 400);
    if (!Number.isFinite(entry.amount)) throw new LedgerError(`Savings amount for "${entry.name}" must be a number`, 400);
  }
}

async function loadOrCreateFinancesWorkbook(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  if (fs.existsSync(FINANCES_PATH)) {
    await workbook.xlsx.readFile(FINANCES_PATH);
  } else {
    workbook.addWorksheet(SHEET_NAME).addRow(HEADERS);
  }
  return workbook;
}

function getFinancesSheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) throw new LedgerError(`Finances.xlsx is missing its "${SHEET_NAME}" sheet`, 500);
  return sheet;
}

function findIncomeRow(sheet: ExcelJS.Worksheet, year: number, month: number): ExcelJS.Row | undefined {
  let found: ExcelJS.Row | undefined;
  sheet.eachRow((row, rowNumber) => {
    if (found || rowNumber === 1) return;
    if (row.getCell(1).value === year && row.getCell(2).value === month) found = row;
  });
  return found;
}

export interface MonthIncome {
  year: number;
  month: number;
  salary: number | null;
  otherIncome: number | null;
  savings: SavingsEntry[];
}

export async function getMonthIncome(year: number, month: number): Promise<MonthIncome> {
  validateYearMonth(year, month);
  const workbook = await loadOrCreateFinancesWorkbook();
  const sheet = getFinancesSheet(workbook);
  const row = findIncomeRow(sheet, year, month);
  return {
    year,
    month,
    salary: row ? numberOrNull(row.getCell(3).value) : null,
    otherIncome: row ? numberOrNull(row.getCell(4).value) : null,
    savings: row ? parseSavingsCell(row.getCell(5).value) : [],
  };
}

export interface SetMonthIncomeInput {
  year: number;
  month: number;
  salary: number | null;
  otherIncome: number | null;
  savings: SavingsEntry[];
}

export async function setMonthIncome(input: SetMonthIncomeInput): Promise<MonthIncome> {
  const { year, month, salary, otherIncome, savings } = input;
  validateYearMonth(year, month);
  validateAmount(salary, "Salary");
  validateAmount(otherIncome, "Other income");
  validateSavings(savings);

  const workbook = await loadOrCreateFinancesWorkbook();
  const sheet = getFinancesSheet(workbook);
  let row = findIncomeRow(sheet, year, month);
  if (!row) {
    row = sheet.getRow(sheet.rowCount + 1);
    row.getCell(1).value = year;
    row.getCell(2).value = month;
  }
  row.getCell(3).value = salary;
  row.getCell(4).value = otherIncome;
  row.getCell(5).value = savings.length > 0 ? JSON.stringify(savings) : null;
  row.commit();

  await saveWorkbook(workbook, FINANCES_PATH);

  return { year, month, salary, otherIncome, savings };
}

export interface MonthFinanceSummary {
  year: number;
  month: number;
  salary: number | null;
  otherIncome: number | null;
  expenses: number;
  /** Last month's total income (salary + other income) minus this month's
   * expenses. A month with no income on record is treated as zero — a real
   * deficit, not an unknown. */
  balance: number;
  /** Running sum of balance from EARLIEST_YEAR through this month. */
  cumulative: number;
  /** ceil(15% of (salary + other income)) for this month. Null if neither is set. */
  minimumSavings: number | null;
  /** Running sum of (salary + other income) from EARLIEST_YEAR through this month. */
  moneyEarned: number;
  /** Running sum of expenses from EARLIEST_YEAR through this month. */
  moneySpent: number;
  /** Sum of currentSavingsBreakdown. Most recently entered snapshot, carried
   * forward through months where it wasn't re-entered (it's an occasional
   * manual check-in, not a monthly ritual). Null until first ever entered. */
  currentSavings: number | null;
  /** The named scheme balances (PPF, NPS, APY, ...) behind currentSavings,
   * carried forward the same way. Empty until first ever entered. */
  currentSavingsBreakdown: SavingsEntry[];
}

function monthsFromEarliestThrough(year: number, month: number): Array<{ year: number; month: number }> {
  const months: Array<{ year: number; month: number }> = [];
  for (let y = EARLIEST_YEAR; y <= year; y++) {
    const lastMonth = y === year ? month : 12;
    for (let m = 1; m <= lastMonth; m++) months.push({ year: y, month: m });
  }
  return months;
}

/** Computes the full chronological finance series from EARLIEST_YEAR through
 * (uptoYear, uptoMonth) so balance/cumulative/money-earned/money-spent are
 * always continuous regardless of which single year a caller displays, then
 * returns only the rows for uptoYear. */
export async function financeSummary(uptoYear: number, uptoMonth: number): Promise<MonthFinanceSummary[]> {
  validateYearMonth(uptoYear, uptoMonth);

  const workbook = await loadOrCreateFinancesWorkbook();
  const sheet = getFinancesSheet(workbook);
  const incomeByKey = new Map<string, { salary: number | null; otherIncome: number | null; savings: SavingsEntry[] }>();
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const y = row.getCell(1).value;
    const m = row.getCell(2).value;
    if (typeof y !== "number" || typeof m !== "number") return;
    incomeByKey.set(`${y}-${m}`, {
      salary: numberOrNull(row.getCell(3).value),
      otherIncome: numberOrNull(row.getCell(4).value),
      savings: parseSavingsCell(row.getCell(5).value),
    });
  });

  const expenseCache = new Map<number, number[]>();
  async function expensesFor(year: number, month: number): Promise<number> {
    if (!expenseCache.has(year)) expenseCache.set(year, await yearExpenseTotals(year));
    return expenseCache.get(year)![month];
  }

  const results: MonthFinanceSummary[] = [];
  let cumulative = 0;
  let moneyEarned = 0;
  let moneySpent = 0;
  let lastIncome = 0;
  let lastKnownSavings: SavingsEntry[] = [];

  for (const { year, month } of monthsFromEarliestThrough(uptoYear, uptoMonth)) {
    const income = incomeByKey.get(`${year}-${month}`) ?? { salary: null, otherIncome: null, savings: [] };
    const expenses = await expensesFor(year, month);

    const balance = lastIncome - expenses;
    cumulative += balance;

    const minimumSavings =
      income.salary !== null || income.otherIncome !== null
        ? Math.ceil(0.15 * ((income.salary ?? 0) + (income.otherIncome ?? 0)))
        : null;

    moneyEarned += (income.salary ?? 0) + (income.otherIncome ?? 0);
    moneySpent += expenses;
    if (income.savings.length > 0) lastKnownSavings = income.savings;

    results.push({
      year,
      month,
      salary: income.salary,
      otherIncome: income.otherIncome,
      expenses,
      balance,
      cumulative,
      minimumSavings,
      moneyEarned,
      moneySpent,
      currentSavings: lastKnownSavings.length > 0 ? sumSavings(lastKnownSavings) : null,
      currentSavingsBreakdown: lastKnownSavings,
    });

    lastIncome = (income.salary ?? 0) + (income.otherIncome ?? 0);
  }

  return results.filter((r) => r.year === uptoYear);
}
