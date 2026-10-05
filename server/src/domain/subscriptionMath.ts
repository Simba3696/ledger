import { addMonths, addYears, formatDate, parseDate, startOfDay } from "./dateMath.js";
import { todayInAppZone } from "./today.js";

// Pure renewal-cycle maths for subscriptions (no I/O), moved verbatim from
// the Excel edition's excel/subscriptions.ts (LLD §3). The only change is the
// default "today": todayInAppZone() instead of a bare new Date() (ADR-0005).

export type Duration = "Monthly" | "Yearly";

/** A recurring subscription, tracked flat (not month-indexed) like Debts and
 * EMI — the set of active subscriptions changes as you add or cancel one. */
export interface SubscriptionEntry {
  /** The subscription's database id (opaque and stable; no longer a sheet row). */
  row: number;
  service: string;
  amount: number;
  duration: Duration;
  /** The last known/entered renewal date — not necessarily in the future; see
   * `nextExpiry`, which auto-advances past it. */
  expiryAnchor: string; // YYYY-MM-DD
  /** Free text ("N/A" if not billed to a card), matching the source sheet. */
  cardOrBank: string;
}

export interface SubscriptionEntryComputed extends SubscriptionEntry {
  /** `expiryAnchor` advanced forward by whole Monthly/Yearly cycles until
   * it's on or after today — never written back, so `expiryAnchor` always
   * stays the real last-entered renewal date and this stays in sync with
   * "now" on every read. */
  nextExpiry: string; // YYYY-MM-DD
}

export function advanceToOnOrAfter(anchor: Date, duration: Duration, today: Date): Date {
  let date = anchor;
  for (let i = 0; i < 1200 && date < today; i++) {
    date = duration === "Monthly" ? addMonths(date, 1) : addYears(date, 1);
  }
  return date;
}

export function withComputed(entry: SubscriptionEntry, today: Date = todayInAppZone()): SubscriptionEntryComputed {
  const nextExpiry = formatDate(advanceToOnOrAfter(parseDate(entry.expiryAnchor), entry.duration, startOfDay(today)));
  return { ...entry, nextExpiry };
}
