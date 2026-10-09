import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { getDbDir, LedgerError } from "./workbookIO.js";
import { addMonths, makeDate, parseDate, formatDate, startOfDay } from "./dateMath.js";

function emiPath(): string {
  return path.join(getDbDir(), "EMI.xlsx");
}
const SHEET_NAME = "EMI";
const HEADERS = [
  "Card/Bank",
  "EMI Amount",
  "Due Day",
  "Total Amount",
  "Remarks",
  "Remaining As Of",
  "As Of Date",
  "Until Target",
  "Interest Rate (%)",
  "Foreclosure Charge (%)",
];

/** A loan/EMI plan, tracked flat (not month-indexed) like Debts — there's no
 * fixed count of active loans, so adding one or foreclosing one is just
 * adding/removing a row. */
interface EmiEntry {
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
  /** An exact payoff target, given by the bank at EMI-conversion time (as a
   * duration in months) and stored here as the literal resulting date. When
   * set, this — not a derived estimate — is what `estimatedPayoffMonth`
   * reports, since a real bank schedule's final installment is often adjusted
   * (larger *or* smaller) to hit this exact date, which a plain
   * `remaining ÷ emiAmount` estimate can't always reproduce. Sticky across
   * edits/payments unless a new Duration is explicitly given — routine
   * balance corrections shouldn't perturb it. */
  untilTarget: string | null; // YYYY-MM-DD
  /** Annual interest rate as a percentage (e.g. 12.5 for 12.5% p.a.), if the
   * user has entered one — optional since plenty of entries (an interest-
   * free EMI conversion, or just not knowing the rate) legitimately have
   * none. Purely informational for now: nothing in this file's amortization
   * (a fixed `emiAmount` per cycle, no interest/principal split) depends on
   * it yet. */
  interestRate: number | null;
  /** Early-closure fee as a percentage of the outstanding balance (e.g. 2 for
   * 2%), if known — optional for the same reasons as `interestRate`, and
   * likewise purely informational for now: the foreclosure-hint progress bar
   * only compares raw percent-paid, it doesn't yet net this out against a
   * loan's remaining balance to find the actual cheapest-to-close loan. A
   * loan with a small remaining balance but a stiff prepayment penalty can
   * be worse to foreclose than one with a bigger balance and 0% charge. */
  foreclosureCharge: number | null;
}

export interface EmiEntryComputed extends EmiEntry {
  /** Auto-decayed from `remainingAsOf`: `emiAmount` less for every due date
   * that has passed since `asOfDate`, floored at 0. Never written back to the
   * sheet — always computed fresh relative to "now" so it can never drift out
   * of sync the way a manually-typed running balance could. */
  remaining: number;
  isPaidOff: boolean;
  /** YYYY-MM this loan is expected to finish. When a bank-stated `untilTarget`
   * is on record, this is the month of the first real due date (on `dueDay`)
   * on or after it — `untilTarget` itself is just a calendar-month milestone,
   * not necessarily a real payment date, so it's resolved via
   * `dueDateOnOrAfter` rather than used verbatim. Otherwise falls back to an
   * estimate — the `ceil(remaining/emiAmount)`-th future due date. Null once
   * already paid off, regardless of which source it would otherwise have
   * used. */
  estimatedPayoffMonth: string | null;
  /** The same payoff estimate as `estimatedPayoffMonth`, but as a full
   * YYYY-MM-DD rather than truncated to the month. Powers the EMI tab's
   * "EMI-Free On" stat, which needs an exact date to compare across loans,
   * not just a month. */
  estimatedPayoffDate: string | null;
  /** What it would actually cost to close this loan today — the true
   * outstanding principal (via standard reducing-balance amortization, the
   * same shape a bank's own early-closure quote uses), plus
   * `foreclosureCharge`% if one is on record. Deliberately *not* the same as
   * `remaining`: that figure is `emiAmount` × cycles-left, which includes
   * interest that hasn't accrued yet for any loan with a real
   * `interestRate` — a genuinely bigger number than what foreclosing today
   * would cost. Equals `remaining` exactly when no `interestRate` is on
   * record (see `computeOutstandingPrincipal`), so an entry with no rate
   * behaves exactly as it always has. */
  foreclosurePayoff: number;
}

/** Present value of the remaining payment stream — `n` level payments of
 * `emiAmount` at monthly rate `r` — which is the true outstanding
 * principal, as opposed to `remaining` (`emiAmount` × cycles-left), which
 * double-counts interest that hasn't accrued yet for any loan with a real
 * `interestRate`. Gracefully reduces to exactly `remaining` when `r` is 0
 * (no rate on record): the formula's mathematical limit as `r → 0` is `A ×
 * n`, i.e. `remaining` itself, but that limit isn't safe to evaluate
 * directly (literal division by `r = 0`), so it's special-cased. */
function computeOutstandingPrincipal(remaining: number, emiAmount: number, interestRate: number | null): number {
  if (remaining <= 0 || emiAmount <= 0) return 0;
  const monthlyRate = (interestRate ?? 0) / 12 / 100;
  if (monthlyRate === 0) return remaining;
  const n = remaining / emiAmount;
  return round2((emiAmount * (1 - Math.pow(1 + monthlyRate, -n))) / monthlyRate);
}

function computeForeclosurePayoff(outstandingPrincipal: number, foreclosureCharge: number | null): number {
  return round2(outstandingPrincipal * (1 + (foreclosureCharge ?? 0) / 100));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toMonthOnly(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
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

/** Finds the first real due date (on `dueDay`) on or after `target`.
 *
 * `untilTarget` (a bank-stated tenure resolved to `addMonths(asOfDate,
 * durationMonths)`) is just a calendar-month milestone, not itself
 * necessarily a real payment date — it keeps whatever day-of-month the loan
 * happened to be added/edited on, which has nothing to do with `dueDay`.
 * If `dueDay` falls *earlier* in the target's month than the target's own
 * day, that month's due date has already passed relative to the target, so
 * the loan doesn't actually finish paying until the following month's due
 * date instead (e.g. target day 23 with dueDay 9: the 9th of that month is
 * before the 23rd, so the real final installment is the 9th of the *next*
 * month, not that month's 9th). If `dueDay` falls on or after the target's
 * day, that month's own due date already covers it, unchanged. */
function dueDateOnOrAfter(target: Date, dueDay: number): Date {
  const sameMonth = makeDate(target.getFullYear(), target.getMonth() + 1, dueDay);
  return sameMonth >= target ? sameMonth : addMonths(sameMonth, 1);
}

/** Finds the Nth monthly due date (on `dueDay`) strictly after `today`. */
function nthFutureDueDate(dueDay: number, n: number, today: Date): Date | null {
  let year = today.getFullYear();
  let month = today.getMonth() + 1;
  let found = 0;
  for (let i = 0; i < 1200; i++) {
    const due = makeDate(year, month, dueDay);
    if (due > today) {
      found++;
      if (found === n) return due;
    }
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return null;
}

function withComputed(entry: EmiEntry, today: Date = new Date()): EmiEntryComputed {
  const asOf = parseDate(entry.asOfDate);
  const passed = countDueDatesPassed(asOf, entry.dueDay, startOfDay(today));
  const remaining = Math.max(0, round2(entry.remainingAsOf - passed * entry.emiAmount));
  const isPaidOff = remaining <= 0;
  const payoffDate = isPaidOff
    ? null
    : entry.untilTarget
      ? dueDateOnOrAfter(parseDate(entry.untilTarget), entry.dueDay)
      : nthFutureDueDate(entry.dueDay, Math.ceil(remaining / entry.emiAmount), startOfDay(today));
  const estimatedPayoffMonth = payoffDate ? toMonthOnly(payoffDate) : null;
  const estimatedPayoffDate = payoffDate ? formatDate(payoffDate) : null;
  const outstandingPrincipal = computeOutstandingPrincipal(remaining, entry.emiAmount, entry.interestRate);
  const foreclosurePayoff = computeForeclosurePayoff(outstandingPrincipal, entry.foreclosureCharge);
  return { ...entry, remaining, isPaidOff, estimatedPayoffMonth, estimatedPayoffDate, foreclosurePayoff };
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
  if (fs.existsSync(emiPath())) {
    await workbook.xlsx.readFile(emiPath());
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
    const untilTargetRaw = row.getCell(8).value;
    const interestRate = resolveNumber(row.getCell(9).value);
    const foreclosureCharge = resolveNumber(row.getCell(10).value);
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
        untilTarget: typeof untilTargetRaw === "string" && untilTargetRaw ? untilTargetRaw : null,
        interestRate,
        foreclosureCharge,
      });
    }
  });
  return entries.map((e) => withComputed(e, today));
}
