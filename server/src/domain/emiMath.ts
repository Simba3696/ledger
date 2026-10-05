import { addMonths, makeDate, parseDate, formatDate, startOfDay } from "./dateMath.js";
import { todayInAppZone } from "./today.js";

// Pure EMI maths (no I/O), moved verbatim from the Excel edition's
// excel/emi.ts (LLD §3): due-date walking, balance decay, payoff estimates,
// foreclosure payoff, the payment-settlement rule behind recordEmiPayment and
// the monthly projection simulation behind emiMonthlyProjection. The store
// (store/emi.ts) loads and saves rows; everything here works on plain values.
// The only changes: the default "today" is todayInAppZone() instead of a bare
// new Date() (ADR-0005), and the projection and settlement steps are split
// out of their old load-and-write functions as pure functions.

/** A loan/EMI plan, tracked flat (not month-indexed) like Debts — there's no
 * fixed count of active loans, so adding one or foreclosing one is just
 * adding/removing a row. */
export interface EmiEntry {
  /** The EMI's database id (opaque and stable; no longer a sheet row). */
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
export function computeOutstandingPrincipal(remaining: number, emiAmount: number, interestRate: number | null): number {
  if (remaining <= 0 || emiAmount <= 0) return 0;
  const monthlyRate = (interestRate ?? 0) / 12 / 100;
  if (monthlyRate === 0) return remaining;
  const n = remaining / emiAmount;
  return round2((emiAmount * (1 - Math.pow(1 + monthlyRate, -n))) / monthlyRate);
}

export function computeForeclosurePayoff(outstandingPrincipal: number, foreclosureCharge: number | null): number {
  return round2(outstandingPrincipal * (1 + (foreclosureCharge ?? 0) / 100));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function toMonthOnly(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Counts how many monthly due dates (on `dueDay`) fall strictly after
 * `asOfDate` and on or before `today` — the number of installments that have
 * been paid since the snapshot was taken. */
export function countDueDatesPassed(asOfDate: Date, dueDay: number, today: Date): number {
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
export function nthFutureDueDate(dueDay: number, n: number, today: Date): Date | null {
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

export function withComputed(entry: EmiEntry, today: Date = todayInAppZone()): EmiEntryComputed {
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

/** The literal target date a bank-stated Duration resolves to, relative to
 * `today` (see `EmiEntry.untilTarget`). */
export function resolveUntilTarget(durationMonths: number, today: Date): string {
  return formatDate(addMonths(startOfDay(today), durationMonths));
}

export interface EmiPaymentSettlement {
  /** The due date this payment settles; it becomes the new `asOfDate`. */
  dueToSettle: Date;
  /** The new `remainingAsOf` snapshot, as of `dueToSettle`. */
  newRemainingAsOf: number;
}

/** The pure half of `recordEmiPayment` (store/emi.ts), which explains the
 * rule in full: settles a payment against the right due date, without
 * risking the double-decay that a naive "just subtract from today's balance"
 * approach would cause.
 *
 * Fix: compute the balance *as of the day before* the due date being settled
 * — i.e. with that due date's own auto-assumed decay deliberately excluded —
 * then subtract the actual amount paid, then anchor the new snapshot to the
 * due date itself.
 *
 * Which due date gets settled: normally this calendar month's — *unless* the
 * stored anchor is already at or past that date, in which case the true next
 * due date after the current anchor, so every call moves strictly forward. */
export function settleEmiPayment(entry: EmiEntry, amountPaid: number, today: Date): EmiPaymentSettlement {
  const day = startOfDay(today);
  const currentAsOf = parseDate(entry.asOfDate);
  const thisMonthsDue = makeDate(day.getFullYear(), day.getMonth() + 1, entry.dueDay);
  const dueToSettle = thisMonthsDue > currentAsOf ? thisMonthsDue : nextDueDateAfter(currentAsOf, entry.dueDay);
  const dayBeforeDue = new Date(dueToSettle.getFullYear(), dueToSettle.getMonth(), dueToSettle.getDate() - 1);
  const remainingBeforeThisDue = withComputed(entry, dayBeforeDue).remaining;
  const newRemainingAsOf = Math.max(0, round2(remainingBeforeThisDue - amountPaid));
  return { dueToSettle, newRemainingAsOf };
}

/** How many calendar months ahead the Dashboard's upcoming-EMIs chart
 * projects by default — a year gives a full picture of the near-term EMI
 * load without projecting so far out that a long-tenure loan's tail
 * dominates the chart. The chart also offers other fixed scales and an
 * "auto" (until every active loan is paid off) mode — see
 * `emiMonthlyProjection`. */
export const EMI_PROJECTION_MONTHS = 12;

/** Upper bound for the "auto" (until paid off) mode's simulation window —
 * matches `validateDurationMonths`'s own 600-month (50-year) ceiling, so
 * "auto" can never simulate further out than a loan's own Duration field
 * could ever legitimately claim to finish. */
export const EMI_PROJECTION_MAX_MONTHS = 600;

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
 * continuous run of months rather than skipping gaps.
 *
 * `months: "auto"` extends the window instead of capping it — simulates the
 * generous `EMI_PROJECTION_MAX_MONTHS` ceiling (so even a long-tenure loan's
 * real payoff is always captured), then trims every trailing all-zero month
 * once every active loan has actually reached 0, so the chart's x-axis stops
 * right where the last installment lands instead of padding out to 50 years
 * of empty months.
 *
 * `emis` must already be computed relative to the same `today` (the store's
 * emiMonthlyProjection passes listEmis(today)). */
export function projectEmiMonthly(
  emis: EmiEntryComputed[],
  months: number | "auto" = EMI_PROJECTION_MONTHS,
  today: Date = todayInAppZone(),
): EmiMonthlyProjection[] {
  const day = startOfDay(today);
  const firstOfThisMonth = makeDate(day.getFullYear(), day.getMonth() + 1, 1);
  const windowSize = months === "auto" ? EMI_PROJECTION_MAX_MONTHS : months;
  const windowMonths = Array.from({ length: windowSize }, (_, i) => toMonthOnly(addMonths(firstOfThisMonth, i)));
  const lastWindowMonth = windowMonths[windowMonths.length - 1];

  const buckets = new Map<string, { count: number; totalAmount: number }>(
    windowMonths.map((m) => [m, { count: 0, totalAmount: 0 }]),
  );

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

  const result = windowMonths.map((month) => ({ month, ...buckets.get(month)! }));
  if (months !== "auto") return result;

  // Trim trailing all-zero months once every loan's simulated above has
  // actually reached 0 — always keeps at least the current month, so a
  // portfolio with no active EMIs at all still returns one (zeroed) row
  // rather than an empty array.
  let lastNonZero = 0;
  result.forEach((r, i) => {
    if (r.count > 0) lastNonZero = i;
  });
  return result.slice(0, lastNonZero + 1);
}
