// Pure finance maths (no I/O), moved verbatim from the Excel edition's
// excel/finances.ts (LLD §3): the balance / cumulative / minimum-savings /
// money-earned / money-spent series, the savings carry-forward, and the
// previousSavings baseline. They take plain arrays of month rows instead of
// reading a sheet. No "today" is involved.

export const EARLIEST_YEAR = 2018;

export interface SavingsEntry {
  name: string; // e.g. "PPF", "NPS", "APY"
  amount: number;
}

/** One month as stored: its income and its savings snapshot. An empty
 * `savings` array means savings weren't entered that month. Months with no
 * record at all are simply absent from the array. */
export interface FinanceMonth {
  year: number;
  month: number;
  salary: number | null;
  otherIncome: number | null;
  savings: SavingsEntry[];
}

export interface MonthIncome {
  year: number;
  month: number;
  salary: number | null;
  otherIncome: number | null;
  savings: SavingsEntry[];
  /** The last known per-scheme balances carried forward from before this
   * month (i.e. what this month's savings would be if left untouched) — the
   * baseline the client computes "+ deposit / − withdrawal" deltas against,
   * so editing a month doesn't require retyping every scheme's balance from
   * memory. Empty before any savings have ever been entered. */
  previousSavings: SavingsEntry[];
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

export function sumSavings(savings: SavingsEntry[]): number {
  return savings.reduce((sum, s) => sum + s.amount, 0);
}

export function previousMonth(year: number, month: number): { year: number; month: number } | null {
  if (year <= EARLIEST_YEAR && month <= 1) return null;
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export function monthsFromEarliestThrough(year: number, month: number): Array<{ year: number; month: number }> {
  const months: Array<{ year: number; month: number }> = [];
  for (let y = EARLIEST_YEAR; y <= year; y++) {
    const lastMonth = y === year ? month : 12;
    for (let m = 1; m <= lastMonth; m++) months.push({ year: y, month: m });
  }
  return months;
}

/** Last non-empty savings snapshot strictly before (year, month) — the same
 * carry-forward rule `computeFinanceSummary` uses for display, reused here so
 * the edit form's baseline always matches what the stats panel currently
 * shows. */
export function savingsBaselineFrom(months: FinanceMonth[], year: number, month: number): SavingsEntry[] {
  const savingsByKey = new Map<string, SavingsEntry[]>();
  for (const r of months) savingsByKey.set(`${r.year}-${r.month}`, r.savings);

  const prev = previousMonth(year, month);
  if (!prev) return [];
  let lastKnownSavings: SavingsEntry[] = [];
  for (const { year: y, month: m } of monthsFromEarliestThrough(prev.year, prev.month)) {
    const savings = savingsByKey.get(`${y}-${m}`) ?? [];
    if (savings.length > 0) lastKnownSavings = savings;
  }
  return lastKnownSavings;
}

/** Computes the full chronological finance series from EARLIEST_YEAR through
 * (uptoYear, uptoMonth) so balance/cumulative/money-earned/money-spent are
 * always continuous regardless of which single year a caller displays, then
 * returns only the rows for uptoYear. `expenseTotalsByYear` holds, for every
 * year from EARLIEST_YEAR through uptoYear, that year's monthly expense totals
 * (index 0 unused; 1-12 are the months). */
export function computeFinanceSummary(
  months: FinanceMonth[],
  expenseTotalsByYear: ReadonlyMap<number, readonly number[]>,
  uptoYear: number,
  uptoMonth: number,
): MonthFinanceSummary[] {
  const incomeByKey = new Map<string, { salary: number | null; otherIncome: number | null; savings: SavingsEntry[] }>();
  for (const r of months) {
    incomeByKey.set(`${r.year}-${r.month}`, { salary: r.salary, otherIncome: r.otherIncome, savings: r.savings });
  }

  const results: MonthFinanceSummary[] = [];
  let cumulative = 0;
  let moneyEarned = 0;
  let moneySpent = 0;
  let lastIncome = 0;
  let lastKnownSavings: SavingsEntry[] = [];

  for (const { year, month } of monthsFromEarliestThrough(uptoYear, uptoMonth)) {
    const income = incomeByKey.get(`${year}-${month}`) ?? { salary: null, otherIncome: null, savings: [] };
    const expenses = expenseTotalsByYear.get(year)![month];

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
