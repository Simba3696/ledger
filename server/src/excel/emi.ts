import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { DB_DIR, LedgerError, saveWorkbook } from "./workbookIO.js";
import { addMonths, makeDate, parseDate, formatDate, startOfDay } from "./dateMath.js";

const EMI_PATH = path.join(DB_DIR, "EMI.xlsx");
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
];

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
  /** An exact payoff target, given by the bank at EMI-conversion time (as a
   * duration in months — see `EmiEditsInput.durationMonths`) and stored here
   * as the literal resulting date. When set, this — not a derived estimate —
   * is what `estimatedPayoffMonth` reports, since a real bank schedule's
   * final installment is often adjusted (larger *or* smaller) to hit this
   * exact date, which a plain `remaining ÷ emiAmount` estimate can't always
   * reproduce. Sticky across edits/payments unless a new Duration is
   * explicitly given — routine balance corrections shouldn't perturb it. */
  untilTarget: string | null; // YYYY-MM-DD
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

/** Finds the earliest monthly due date (on `dueDay`) strictly after `anchor`.
 * Exported for `overview.ts`'s Upcoming list — using an EMI's own stored
 * `asOfDate` (not "today") is what makes a just-recorded payment correctly
 * advance which cycle is actually next, instead of recomputing "the next
 * occurrence of dueDay" from scratch and re-surfacing the cycle just paid. */
export function nextDueDateAfter(anchor: Date, dueDay: number): Date {
  let year = anchor.getFullYear();
  let month = anchor.getMonth() + 1;
  for (let i = 0; i < 1200; i++) {
    const due = makeDate(year, month, dueDay);
    if (due > anchor) return due;
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  throw new Error("nextDueDateAfter: no due date found within 100 years");
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
 * day, that month's own due date already covers it, unchanged.
 *
 * Exported so the e2e regression suite can reuse this exact logic when
 * computing its own expected finish date, rather than risking a
 * hand-rolled equivalent silently drifting from this one. */
export function dueDateOnOrAfter(target: Date, dueDay: number): Date {
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

export function withComputed(entry: EmiEntry, today: Date = new Date()): EmiEntryComputed {
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
  return { ...entry, remaining, isPaidOff, estimatedPayoffMonth, estimatedPayoffDate };
}

function validateEntry(cardOrBank: string, emiAmount: number, dueDay: number, totalAmount: number, remainingAsOf: number) {
  if (!cardOrBank) throw new LedgerError("Card/Bank is required", 400);
  if (!Number.isFinite(emiAmount) || emiAmount <= 0) throw new LedgerError("EMI Amount must be a positive number", 400);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) throw new LedgerError("Due Day must be between 1 and 31", 400);
  if (!Number.isFinite(totalAmount) || totalAmount < 0) throw new LedgerError("Total Amount must be a number", 400);
  if (!Number.isFinite(remainingAsOf) || remainingAsOf < 0) throw new LedgerError("Remaining must be a number", 400);
}

function validateDurationMonths(durationMonths: number | null | undefined) {
  if (durationMonths === null || durationMonths === undefined) return;
  if (!Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 600) {
    throw new LedgerError("Duration must be a whole number of months (1-600)", 400);
  }
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

/** Reads whatever `untilTarget` is currently stored for a row, without the
 * rest of `EmiEntry` — used by `updateEmi` to preserve it across an edit that
 * doesn't supply a fresh Duration. */
function readStoredUntilTarget(sheet: ExcelJS.Worksheet, rowNumber: number): string | null {
  const value = sheet.getRow(rowNumber).getCell(8).value;
  return typeof value === "string" && value ? value : null;
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
      });
    }
  });
  return entries.map((e) => withComputed(e, today));
}

/** How many calendar months ahead the Dashboard's upcoming-EMIs chart
 * projects — a year gives a full picture of the near-term EMI load without
 * projecting so far out that a long-tenure loan's tail dominates the chart. */
export const EMI_PROJECTION_MONTHS = 12;

export interface EmiMonthlyProjection {
  month: string; // YYYY-MM
  count: number;
  totalAmount: number;
}

/** Projects every active EMI's future installments forward, bucketed by
 * calendar month, for the Dashboard's upcoming-EMIs chart. Each loan
 * contributes its full `emiAmount` every cycle until paid off, except
 * possibly a smaller final installment (whatever balance is actually left)
 * — the same amortization `withComputed` already does for a single "final
 * payoff" date, just simulated across every future cycle instead of only
 * the last one, and summed across every loan per month. Months with no EMI
 * due at all are still included (zeroed), so the chart's X-axis is a
 * continuous run of months rather than skipping gaps. */
export async function emiMonthlyProjection(
  months: number = EMI_PROJECTION_MONTHS,
  today: Date = new Date(),
): Promise<EmiMonthlyProjection[]> {
  const day = startOfDay(today);
  const firstOfThisMonth = makeDate(day.getFullYear(), day.getMonth() + 1, 1);
  const windowMonths = Array.from({ length: months }, (_, i) => toMonthOnly(addMonths(firstOfThisMonth, i)));
  const lastWindowMonth = windowMonths[windowMonths.length - 1];

  const buckets = new Map<string, { count: number; totalAmount: number }>(
    windowMonths.map((m) => [m, { count: 0, totalAmount: 0 }]),
  );

  const emis = await listEmis(today);
  for (const emi of emis) {
    if (emi.isPaidOff) continue;
    let balance = emi.remaining;
    const asOf = parseDate(emi.asOfDate);
    // Anchored to whichever is later: the EMI's own stored asOfDate — so an
    // early payment (which can advance that anchor *past* today, to the
    // due date it settled) still correctly skips the cycle just paid, same
    // reasoning as overview.ts's Upcoming list — or "today", so a *stale*
    // asOfDate (no payment recorded in a while) can't walk this projection
    // backward into an already-decayed past month. `remaining` is already
    // decayed through today (see `withComputed`), so re-projecting a due
    // date before today would double-count that installment; it can also
    // fall outside this window's map entirely, which crashed here before
    // this fix (real bug: a loan whose asOfDate hadn't been touched in a
    // while threw "Cannot read properties of undefined (reading 'count')").
    const anchor = asOf > day ? asOf : day;
    let due = nextDueDateAfter(anchor, emi.dueDay);
    while (balance > 0) {
      const monthKey = toMonthOnly(due);
      if (monthKey > lastWindowMonth) break;
      const payment = Math.min(emi.emiAmount, balance);
      const bucket = buckets.get(monthKey);
      if (bucket) {
        bucket.count += 1;
        bucket.totalAmount = round2(bucket.totalAmount + payment);
      }
      balance = round2(balance - payment);
      due = nextDueDateAfter(due, emi.dueDay);
    }
  }

  return windowMonths.map((month) => ({ month, ...buckets.get(month)! }));
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
  /** The bank-stated number of months until this loan finishes, given at
   * EMI-conversion time. Optional and *not* stored as a number — it's
   * resolved once, relative to `today`, into a literal target date
   * (`EmiEntry.untilTarget`). Leaving this null/omitted on an edit preserves
   * whatever target was already on record rather than clearing it; there's
   * no direct way to blank it out again short of re-adding the entry. */
  durationMonths?: number | null;
}

export async function addEmi(input: EmiEditsInput, today: Date = new Date()): Promise<EmiEntryComputed> {
  const cardOrBank = input.cardOrBank.trim();
  validateEntry(cardOrBank, input.emiAmount, input.dueDay, input.totalAmount, input.remainingAsOf);
  validateDurationMonths(input.durationMonths);

  const workbook = await loadOrCreateWorkbook();
  const sheet = getEmiSheet(workbook);
  const rowNumber = sheet.rowCount + 1;
  const asOfDate = formatDate(startOfDay(today));
  const untilTarget = input.durationMonths ? formatDate(addMonths(startOfDay(today), input.durationMonths)) : null;
  const row = sheet.getRow(rowNumber);
  row.getCell(1).value = cardOrBank;
  row.getCell(2).value = input.emiAmount;
  row.getCell(3).value = input.dueDay;
  row.getCell(4).value = input.totalAmount;
  row.getCell(5).value = input.remarks.trim();
  row.getCell(6).value = input.remainingAsOf;
  row.getCell(7).value = asOfDate;
  row.getCell(8).value = untilTarget;
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
    untilTarget,
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
  validateDurationMonths(input.durationMonths);

  const workbook = await loadOrCreateWorkbook();
  const sheet = getEmiSheet(workbook);
  assertRealEmiRow(sheet, rowNumber);

  const untilTarget = input.durationMonths
    ? formatDate(addMonths(startOfDay(today), input.durationMonths))
    : readStoredUntilTarget(sheet, rowNumber);

  const asOfDate = formatDate(startOfDay(today));
  const row = sheet.getRow(rowNumber);
  row.getCell(1).value = cardOrBank;
  row.getCell(2).value = input.emiAmount;
  row.getCell(3).value = input.dueDay;
  row.getCell(4).value = input.totalAmount;
  row.getCell(5).value = input.remarks.trim();
  row.getCell(6).value = input.remainingAsOf;
  row.getCell(7).value = asOfDate;
  row.getCell(8).value = untilTarget;
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
    untilTarget,
  };
  return withComputed(entry, today);
}

/** Records a payment toward an EMI, without risking the double-decay that a
 * naive "just subtract from today's balance" approach would cause: if you pay
 * a few days *before* this month's due date, anchoring the new snapshot to
 * today (rather than to that due date) would leave the due date still
 * "unaccounted for", and once it actually passed, `withComputed`'s automatic
 * decay would subtract *another* installment on top of the one you already
 * recorded.
 *
 * Fix: compute the balance *as of the day before* the due date being settled
 * — i.e. with that due date's own auto-assumed decay deliberately excluded —
 * then subtract the actual amount paid, then anchor the new snapshot to the
 * due date itself. Since the new anchor lands exactly on that due date,
 * `withComputed` will never separately decay for it again (whether the
 * automatic assumption or this explicit payment "wins" doesn't matter — they
 * represent the same real-world event, so they must not stack). Only
 * genuinely later due dates decay the balance further from here. Paying
 * exactly one `emiAmount` *after* the due date has already passed is
 * therefore a no-op — the auto-decay already assumed it — while paying early
 * (or a different amount than usual) changes the balance immediately instead
 * of waiting for the due date to pass.
 *
 * Which due date gets settled: normally this calendar month's (so paying
 * covers however many months have silently gone by, all at once, same as if
 * each had auto-decayed on schedule) — *unless* the stored anchor is already
 * at or past that date, which happens whenever `dueDay` falls earlier in the
 * month than whatever day the entry was last touched on (e.g. added on the
 * 30th with a due day of the 15th — this month's 15th already lies in the
 * past relative to that anchor, even though it hasn't been "settled" by any
 * real payment). Reusing a due date the anchor has already passed would let
 * repeated clicks each subtract another `emiAmount` from the same stuck
 * month — checked here by always advancing to the true next due date after
 * the current anchor in that case, so every call moves strictly forward. */
export async function recordEmiPayment(
  rowNumber: number,
  amountPaid: number,
  today: Date = new Date(),
): Promise<EmiEntryComputed> {
  if (!Number.isFinite(amountPaid) || amountPaid < 0) {
    throw new LedgerError("Payment amount must be a non-negative number", 400);
  }

  const entries = await listEmis(today);
  const entry = entries.find((e) => e.row === rowNumber);
  if (!entry) throw new LedgerError(`No EMI entry at row ${rowNumber}`, 404);

  const day = startOfDay(today);
  const currentAsOf = parseDate(entry.asOfDate);
  const thisMonthsDue = makeDate(day.getFullYear(), day.getMonth() + 1, entry.dueDay);
  const dueToSettle = thisMonthsDue > currentAsOf ? thisMonthsDue : nextDueDateAfter(currentAsOf, entry.dueDay);
  const dayBeforeDue = new Date(dueToSettle.getFullYear(), dueToSettle.getMonth(), dueToSettle.getDate() - 1);
  const remainingBeforeThisDue = withComputed(entry, dayBeforeDue).remaining;
  const newRemainingAsOf = Math.max(0, round2(remainingBeforeThisDue - amountPaid));

  return updateEmi(
    rowNumber,
    {
      cardOrBank: entry.cardOrBank,
      emiAmount: entry.emiAmount,
      dueDay: entry.dueDay,
      totalAmount: entry.totalAmount,
      remarks: entry.remarks,
      remainingAsOf: newRemainingAsOf,
      durationMonths: null, // preserve whatever until-target was already on record
    },
    dueToSettle,
  );
}

/** Removes an EMI entry entirely — e.g. after foreclosing a loan early. */
export async function deleteEmi(rowNumber: number): Promise<void> {
  const workbook = await loadOrCreateWorkbook();
  const sheet = getEmiSheet(workbook);
  assertRealEmiRow(sheet, rowNumber);

  sheet.spliceRows(rowNumber, 1);
  await saveWorkbook(workbook, EMI_PATH);
}
