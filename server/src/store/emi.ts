import { getSql } from "../db/client.js";
import { withTransaction } from "../db/tx.js";
import { LedgerError } from "../errors.js";
import { formatDate, startOfDay } from "../domain/dateMath.js";
import { todayInAppZone } from "../domain/today.js";
import { assertMoney, assertText, isPossibleId } from "./validate.js";
import {
  EMI_PROJECTION_MONTHS,
  projectEmiMonthly,
  resolveUntilTarget,
  settleEmiPayment,
  withComputed,
  type EmiEntry,
  type EmiEntryComputed,
  type EmiMonthlyProjection,
} from "../domain/emiMath.js";

export {
  EMI_PROJECTION_MONTHS,
  dueDateOnOrAfter,
  nextDueDateAfter,
  withComputed,
  type EmiEntry,
  type EmiEntryComputed,
  type EmiMonthlyProjection,
} from "../domain/emiMath.js";

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
  /** Annual interest rate as a percentage, or null/omitted to leave it
   * unset (or clear it, on an edit) — unlike `durationMonths`, this is a
   * plain overwritable field (like `emiAmount`/`totalAmount`): whatever is
   * passed here (including omitted, treated the same as null) is exactly
   * what gets stored, with no "preserve if omitted" behavior. */
  interestRate?: number | null;
  /** Early-closure fee as a percentage, or null/omitted to leave/clear it —
   * same plain-overwritable-field semantics as `interestRate`. */
  foreclosureCharge?: number | null;
}

interface EmiRow {
  id: number;
  card_or_bank: string;
  emi_amount: number;
  due_day: number;
  total_amount: number;
  remarks: string;
  remaining_as_of: number;
  as_of_date: string; // 'YYYY-MM-DD' (date parser override in db/client.ts)
  until_target: string | null;
  interest_rate: number | null;
  foreclosure_charge: number | null;
}

function toEntry(r: EmiRow): EmiEntry {
  return {
    row: r.id,
    cardOrBank: r.card_or_bank,
    emiAmount: r.emi_amount,
    dueDay: r.due_day,
    totalAmount: r.total_amount,
    remarks: r.remarks,
    remainingAsOf: r.remaining_as_of,
    asOfDate: r.as_of_date,
    untilTarget: r.until_target,
    interestRate: r.interest_rate,
    foreclosureCharge: r.foreclosure_charge,
  };
}

function validateEntry(
  cardOrBank: string,
  emiAmount: number,
  dueDay: number,
  totalAmount: number,
  remainingAsOf: number,
  remarks: string,
) {
  if (!cardOrBank) throw new LedgerError("Card/Bank is required", 400);
  if (!Number.isFinite(emiAmount) || emiAmount <= 0) throw new LedgerError("EMI Amount must be a positive number", 400);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) throw new LedgerError("Due Day must be between 1 and 31", 400);
  if (!Number.isFinite(totalAmount) || totalAmount < 0) throw new LedgerError("Total Amount must be a number", 400);
  if (!Number.isFinite(remainingAsOf) || remainingAsOf < 0) throw new LedgerError("Remaining must be a number", 400);
  // The Excel edition's own messages above win; these only add what the
  // numeric(14,2) and text columns can't hold (too large, rounds to 0.00, NUL).
  assertText(cardOrBank, "Card/Bank");
  assertText(remarks, "Remarks");
  assertMoney(emiAmount, { positive: true });
  assertMoney(totalAmount, { positive: false });
  assertMoney(remainingAsOf, { positive: false });
}

function validateDurationMonths(durationMonths: number | null | undefined) {
  if (durationMonths === null || durationMonths === undefined) return;
  if (!Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 600) {
    throw new LedgerError("Duration must be a whole number of months (1-600)", 400);
  }
}

function validateInterestRate(interestRate: number | null | undefined) {
  if (interestRate === null || interestRate === undefined) return;
  if (!Number.isFinite(interestRate) || interestRate < 0 || interestRate > 100) {
    throw new LedgerError("Interest Rate must be a number between 0 and 100", 400);
  }
}

function validateForeclosureCharge(foreclosureCharge: number | null | undefined) {
  if (foreclosureCharge === null || foreclosureCharge === undefined) return;
  if (!Number.isFinite(foreclosureCharge) || foreclosureCharge < 0 || foreclosureCharge > 100) {
    throw new LedgerError("Foreclosure Charge must be a number between 0 and 100", 400);
  }
}

/** Trims and validates an add/update input; returns the values to store. */
function prepareInput(input: EmiEditsInput) {
  const cardOrBank = input.cardOrBank.trim();
  const remarks = input.remarks.trim();
  validateEntry(cardOrBank, input.emiAmount, input.dueDay, input.totalAmount, input.remainingAsOf, remarks);
  validateDurationMonths(input.durationMonths);
  validateInterestRate(input.interestRate);
  validateForeclosureCharge(input.foreclosureCharge);
  return {
    cardOrBank,
    remarks,
    interestRate: input.interestRate ?? null,
    foreclosureCharge: input.foreclosureCharge ?? null,
  };
}

function notFound(row: number): LedgerError {
  return new LedgerError(`No EMI entry at row ${row}`, 404);
}

/** Insertion order, matching the Excel edition's sheet order. */
export async function listEmis(today: Date = todayInAppZone()): Promise<EmiEntryComputed[]> {
  const sql = getSql();
  const rows = await sql<EmiRow[]>`
    select id, card_or_bank, emi_amount, due_day, total_amount, remarks, remaining_as_of,
           as_of_date, until_target, interest_rate, foreclosure_charge
    from emis order by id`;
  return rows.map((r) => withComputed(toEntry(r), today));
}

/** Loads every EMI and simulates its future installments month by month
 * (see `projectEmiMonthly` in domain/emiMath.ts). */
export async function emiMonthlyProjection(
  months: number | "auto" = EMI_PROJECTION_MONTHS,
  today: Date = todayInAppZone(),
): Promise<EmiMonthlyProjection[]> {
  return projectEmiMonthly(await listEmis(today), months, today);
}

export async function addEmi(input: EmiEditsInput, today: Date = todayInAppZone()): Promise<EmiEntryComputed> {
  const { cardOrBank, remarks, interestRate, foreclosureCharge } = prepareInput(input);
  const asOfDate = formatDate(startOfDay(today));
  const untilTarget = input.durationMonths ? resolveUntilTarget(input.durationMonths, today) : null;

  const sql = getSql();
  const [r] = await sql<EmiRow[]>`
    insert into emis (card_or_bank, emi_amount, due_day, total_amount, remarks, remaining_as_of,
                      as_of_date, until_target, interest_rate, foreclosure_charge)
    values (${cardOrBank}, ${input.emiAmount}, ${input.dueDay}, ${input.totalAmount}, ${remarks},
            ${input.remainingAsOf}, ${asOfDate}, ${untilTarget}, ${interestRate}, ${foreclosureCharge})
    returning id, card_or_bank, emi_amount, due_day, total_amount, remarks, remaining_as_of,
              as_of_date, until_target, interest_rate, foreclosure_charge`;
  return withComputed(toEntry(r), today);
}

export async function updateEmi(
  rowNumber: number,
  input: EmiEditsInput,
  today: Date = todayInAppZone(),
): Promise<EmiEntryComputed> {
  const { cardOrBank, remarks, interestRate, foreclosureCharge } = prepareInput(input);
  if (!isPossibleId(rowNumber)) throw notFound(rowNumber);
  const asOfDate = formatDate(startOfDay(today));
  // A fresh Duration replaces the target; without one, the stored target is
  // kept (sticky), which coalesce does in the same statement.
  const untilTarget = input.durationMonths ? resolveUntilTarget(input.durationMonths, today) : null;

  const sql = getSql();
  const [r] = await sql<EmiRow[]>`
    update emis set
      card_or_bank = ${cardOrBank},
      emi_amount = ${input.emiAmount},
      due_day = ${input.dueDay},
      total_amount = ${input.totalAmount},
      remarks = ${remarks},
      remaining_as_of = ${input.remainingAsOf},
      as_of_date = ${asOfDate},
      until_target = coalesce(${untilTarget}::date, until_target),
      interest_rate = ${interestRate},
      foreclosure_charge = ${foreclosureCharge}
    where id = ${rowNumber}
    returning id, card_or_bank, emi_amount, due_day, total_amount, remarks, remaining_as_of,
              as_of_date, until_target, interest_rate, foreclosure_charge`;
  if (!r) throw notFound(rowNumber);
  return withComputed(toEntry(r), today);
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
 * the current anchor in that case, so every call moves strictly forward.
 *
 * The rule itself is `settleEmiPayment` (domain/emiMath.ts). Only the
 * balance snapshot and its anchor change: Card/Bank, amounts, remarks, the
 * until-target, interest rate and foreclosure charge are all kept as stored.
 * The read and the write share one transaction with the row locked (FOR
 * UPDATE), so two overlapping payments can't both read the same pre-payment
 * balance and silently lose one of them. */
export async function recordEmiPayment(
  rowNumber: number,
  amountPaid: number,
  today: Date = todayInAppZone(),
): Promise<EmiEntryComputed> {
  if (!Number.isFinite(amountPaid) || amountPaid < 0) {
    throw new LedgerError("Payment amount must be a non-negative number", 400);
  }
  if (!isPossibleId(rowNumber)) throw notFound(rowNumber);

  return withTransaction(async (tx) => {
    const [current] = await tx<EmiRow[]>`
      select id, card_or_bank, emi_amount, due_day, total_amount, remarks, remaining_as_of,
             as_of_date, until_target, interest_rate, foreclosure_charge
      from emis where id = ${rowNumber}
      for update`;
    if (!current) throw notFound(rowNumber);

    const { dueToSettle, newRemainingAsOf } = settleEmiPayment(toEntry(current), amountPaid, today);
    const [r] = await tx<EmiRow[]>`
      update emis set
        remaining_as_of = ${newRemainingAsOf},
        as_of_date = ${formatDate(startOfDay(dueToSettle))}
      where id = ${rowNumber}
      returning id, card_or_bank, emi_amount, due_day, total_amount, remarks, remaining_as_of,
                as_of_date, until_target, interest_rate, foreclosure_charge`;
    // Computed relative to the settled due date, exactly as the Excel
    // edition's update-under-lock returned it.
    return withComputed(toEntry(r), dueToSettle);
  });
}

/** Removes an EMI entry entirely — e.g. after foreclosing a loan early. */
export async function deleteEmi(rowNumber: number): Promise<void> {
  if (!isPossibleId(rowNumber)) throw notFound(rowNumber);

  const sql = getSql();
  const result = await sql`delete from emis where id = ${rowNumber}`;
  if (result.count === 0) throw notFound(rowNumber);
}
