import { getSql, type Sql, type Tx } from "../db/client.js";
import { withTransaction } from "../db/tx.js";
import { LedgerError } from "../errors.js";
import { assertMoney, assertText } from "./validate.js";
import { expenseTotalsForYears } from "./ledger.js";
import {
  EARLIEST_YEAR,
  computeFinanceSummary,
  savingsBaselineFrom,
  type FinanceMonth,
  type MonthFinanceSummary,
  type MonthIncome,
  type SavingsEntry,
} from "../domain/financeMath.js";

export {
  EARLIEST_YEAR,
  type MonthFinanceSummary,
  type MonthIncome,
  type SavingsEntry,
} from "../domain/financeMath.js";

/** The `year` column is int4. The Excel edition had no upper bound; this is
 * only the column's limit, checked here so a huge year gets this store's own
 * "Invalid year" 400 rather than the generic out-of-range database error. */
const LATEST_YEAR = 2147483647;

export interface SetMonthIncomeInput {
  year: number;
  month: number;
  salary: number | null;
  otherIncome: number | null;
  savings: SavingsEntry[];
}

interface FinanceMonthRow {
  year: number;
  month: number;
  salary: number | null;
  other_income: number | null;
}

interface SavingsBalanceRow {
  year: number;
  month: number;
  position: number;
  name: string;
  amount: number;
}

function toSavingsEntry(r: SavingsBalanceRow): SavingsEntry {
  return { name: r.name, amount: r.amount };
}

/** Joins each finance_months row with its savings_balances rows (already
 * ordered by position). No savings rows = savings not entered that month. */
function toEntry(r: FinanceMonthRow, savings: SavingsBalanceRow[]): FinanceMonth {
  return {
    year: r.year,
    month: r.month,
    salary: r.salary,
    otherIncome: r.other_income,
    savings: savings.map(toSavingsEntry),
  };
}

function validateYearMonth(year: number, month: number) {
  if (!Number.isInteger(year) || year < EARLIEST_YEAR || year > LATEST_YEAR) {
    throw new LedgerError(`Invalid year: ${year}`, 400);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new LedgerError(`Invalid month: ${month}`, 400);
}

/** assertMoney's own messages carry no field label, and this form saves
 * several money fields at once, so its rejection is relabelled with the
 * field. Callers check finiteness first, so only "too large" reaches here. */
function assertMoneyLabelled(value: number, label: string) {
  try {
    assertMoney(value, { positive: false });
  } catch (e) {
    if (e instanceof LedgerError) throw new LedgerError(`${label} is too large`, 400);
    throw e;
  }
}

function validateAmount(value: number | null, label: string) {
  if (value === null) return;
  if (!Number.isFinite(value)) throw new LedgerError(`${label} must be a number`, 400);
  // The check above keeps the Excel edition's message; this adds only the
  // numeric(14,2) bounds. Income stays signed, as before.
  assertMoneyLabelled(value, label);
}

function validateSavings(savings: SavingsEntry[]) {
  for (const entry of savings) {
    if (!entry.name || !entry.name.trim()) throw new LedgerError("Each savings entry needs a name", 400);
    if (!Number.isFinite(entry.amount)) throw new LedgerError(`Savings amount for "${entry.name}" must be a number`, 400);
    // As above: the old messages win; these add only the column limits.
    assertText(entry.name, "Savings name");
    assertMoneyLabelled(entry.amount, `Savings amount for "${entry.name}"`);
  }
}

/** One finance_months row left-joined with one of its savings_balances rows
 * (savings columns null when the month has none). */
interface FinanceMonthSavingsRow extends FinanceMonthRow {
  position: number | null;
  name: string | null;
  amount: number | null;
}

/** Every stored month from EARLIEST_YEAR through (year, month) inclusive, in
 * chronological order, each with its savings snapshot. A single statement,
 * so callers outside a transaction still read one consistent snapshot (the
 * Excel edition read the whole workbook at once) rather than a month's
 * income from before a concurrent save and its savings from after. The
 * foreign key guarantees every savings row has its finance_months row. */
async function loadMonthsThrough(q: Sql | Tx, year: number, month: number): Promise<FinanceMonth[]> {
  const rows = await q<FinanceMonthSavingsRow[]>`
    select f.year, f.month, f.salary, f.other_income, s.position, s.name, s.amount
    from finance_months f
    left join savings_balances s using (year, month)
    where (f.year, f.month) <= (${year}, ${month})
    order by f.year, f.month, s.position`;

  const months: FinanceMonth[] = [];
  let current: FinanceMonth | undefined;
  for (const r of rows) {
    if (!current || current.year !== r.year || current.month !== r.month) {
      current = toEntry(r, []);
      months.push(current);
    }
    if (r.name !== null && r.amount !== null) current.savings.push({ name: r.name, amount: r.amount });
  }
  return months;
}

export async function getMonthIncome(year: number, month: number): Promise<MonthIncome> {
  validateYearMonth(year, month);
  const months = await loadMonthsThrough(getSql(), year, month);
  const row = months.find((r) => r.year === year && r.month === month);
  return {
    year,
    month,
    salary: row ? row.salary : null,
    otherIncome: row ? row.otherIncome : null,
    savings: row ? row.savings : [],
    previousSavings: savingsBaselineFrom(months, year, month),
  };
}

/** Upserts the month's income, then replaces its savings snapshot with the
 * new list at positions 0..n-1 (LLD §4.3), all in one transaction. An empty
 * list clears the month's savings (= not entered). Returns the month as
 * saved, so amounts come back rounded to the columns' 2 decimals. */
export async function setMonthIncome(input: SetMonthIncomeInput): Promise<MonthIncome> {
  const { year, month, salary, otherIncome, savings } = input;
  validateYearMonth(year, month);
  validateAmount(salary, "Salary");
  validateAmount(otherIncome, "Other income");
  validateSavings(savings);

  return withTransaction(async (tx) => {
    // The upsert takes the finance_months row lock, so overlapping saves to
    // the same month queue behind each other here (last writer wins, like
    // the Excel edition's withFileLock) and the delete-then-insert below
    // never races on the savings primary key.
    const [saved] = await tx<FinanceMonthRow[]>`
      insert into finance_months (year, month, salary, other_income)
      values (${year}, ${month}, ${salary}, ${otherIncome})
      on conflict (year, month) do update
        set salary = excluded.salary, other_income = excluded.other_income
      returning year, month, salary, other_income`;
    await tx`delete from savings_balances where year = ${year} and month = ${month}`;

    let savedSavings: SavingsBalanceRow[] = [];
    if (savings.length > 0) {
      const values = savings.map((s, position) => ({ year, month, position, name: s.name, amount: s.amount }));
      // Built outside the template: passed inline, TypeScript 5.x infers the
      // helper's column list as a readonly tuple the template rejects.
      const insert = tx(values, "year", "month", "position", "name", "amount");
      const rows = await tx<SavingsBalanceRow[]>`
        insert into savings_balances ${insert}
        returning year, month, position, name, amount`;
      // insert ... returning doesn't promise row order, so sort by position.
      savedSavings = [...rows].sort((a, b) => a.position - b.position);
    }

    // The baseline only looks at months strictly before this one, so it's
    // unaffected by the write above.
    const months = await loadMonthsThrough(tx, year, month);
    const entry = toEntry(saved, savedSavings);
    return {
      year,
      month,
      salary: entry.salary,
      otherIncome: entry.otherIncome,
      savings: entry.savings,
      previousSavings: savingsBaselineFrom(months, year, month),
    };
  });
}

/** The full chronological series from EARLIEST_YEAR through
 * (uptoYear, uptoMonth), returning only uptoYear's rows (see
 * computeFinanceSummary). Expense totals come from the ledger store's
 * expenseTotalsForYears, one grouped query for the whole range. */
export async function financeSummary(uptoYear: number, uptoMonth: number): Promise<MonthFinanceSummary[]> {
  validateYearMonth(uptoYear, uptoMonth);

  const months = await loadMonthsThrough(getSql(), uptoYear, uptoMonth);
  const expenseTotalsByYear = await expenseTotalsForYears(EARLIEST_YEAR, uptoYear);
  return computeFinanceSummary(months, expenseTotalsByYear, uptoYear, uptoMonth);
}
