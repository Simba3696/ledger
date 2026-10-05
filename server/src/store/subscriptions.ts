import { getSql } from "../db/client.js";
import { LedgerError } from "../errors.js";
import { daysInMonth } from "../domain/dateMath.js";
import { todayInAppZone } from "../domain/today.js";
import {
  withComputed,
  type Duration,
  type SubscriptionEntry,
  type SubscriptionEntryComputed,
} from "../domain/subscriptionMath.js";

export {
  withComputed,
  type Duration,
  type SubscriptionEntry,
  type SubscriptionEntryComputed,
} from "../domain/subscriptionMath.js";

export interface SubscriptionEditsInput {
  service: string;
  amount: number;
  duration: Duration;
  expiryAnchor: string; // YYYY-MM-DD
  cardOrBank: string;
}

interface SubscriptionRow {
  id: number;
  service: string;
  amount: number;
  duration: Duration;
  expiry_anchor: string; // 'YYYY-MM-DD' (date parser override in db/client.ts)
  card_or_bank: string;
}

function toEntry(r: SubscriptionRow): SubscriptionEntry {
  return {
    row: r.id,
    service: r.service,
    amount: r.amount,
    duration: r.duration,
    expiryAnchor: r.expiry_anchor,
    cardOrBank: r.card_or_bank,
  };
}

/** True for a real calendar date in Postgres' range. The Excel edition only
 * checked the YYYY-MM-DD shape (and parseDate clamped e.g. 02-30 to the end
 * of February); a `date` column rejects impossible days, which would surface
 * as a 500, so they're caught here as the same 400 instead. */
function isRealDate(value: string): boolean {
  const [y, m, d] = value.split("-").map(Number);
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** Postgres `text` can't hold a NUL character (it raises "invalid byte
 * sequence", a 500); the Excel edition stored it silently. Rejected as a 400. */
function hasNul(value: string): boolean {
  return value.includes("\u0000");
}

function validateEntry(service: string, amount: number, duration: string, expiryAnchor: string, cardOrBank: string) {
  if (!service) throw new LedgerError("Service is required", 400);
  if (hasNul(service)) throw new LedgerError("Service contains an invalid character", 400);
  if (hasNul(cardOrBank)) throw new LedgerError("Card/bank contains an invalid character", 400);
  // amount is numeric(14,2) with check (amount > 0). The column rounds to
  // cents first, so both bounds are checked on the rounded cents: a positive
  // amount that rounds to 0.00 would violate the check, and one that rounds
  // up to 1000000000000.00 (e.g. 999999999999.995) would overflow the 12
  // integer digits. Either would be a database error (500) otherwise.
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount <= 0 || cents <= 0) {
    throw new LedgerError("Amount must be a positive number", 400);
  }
  // Same rule and message as debts.
  if (cents >= 1e14) throw new LedgerError("Amount is too large", 400);
  if (duration !== "Monthly" && duration !== "Yearly") throw new LedgerError('Duration must be "Monthly" or "Yearly"', 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryAnchor) || !isRealDate(expiryAnchor)) {
    throw new LedgerError("Expiry must be YYYY-MM-DD", 400);
  }
}

function notFound(row: number): LedgerError {
  return new LedgerError(`No subscription at row ${row}`, 404);
}

/** A `:row` that isn't a positive integer (e.g. Number("abc") = NaN) can't
 * be a real id; the Excel edition 404'd these too, so don't let them reach
 * Postgres as an invalid bigint (which would surface as a 500). */
function isPossibleId(row: number): boolean {
  return Number.isSafeInteger(row) && row > 0;
}

/** Insertion order, matching the Excel edition's sheet order. */
export async function listSubscriptions(today: Date = todayInAppZone()): Promise<SubscriptionEntryComputed[]> {
  const sql = getSql();
  const rows = await sql<SubscriptionRow[]>`
    select id, service, amount, duration, expiry_anchor, card_or_bank
    from subscriptions order by id`;
  return rows.map((r) => withComputed(toEntry(r), today));
}

export async function addSubscription(
  input: SubscriptionEditsInput,
  today: Date = todayInAppZone(),
): Promise<SubscriptionEntryComputed> {
  const service = input.service.trim();
  const cardOrBank = input.cardOrBank.trim();
  validateEntry(service, input.amount, input.duration, input.expiryAnchor, cardOrBank);

  const sql = getSql();
  const [r] = await sql<SubscriptionRow[]>`
    insert into subscriptions (service, amount, duration, expiry_anchor, card_or_bank)
    values (${service}, ${input.amount}, ${input.duration}, ${input.expiryAnchor}, ${cardOrBank})
    returning id, service, amount, duration, expiry_anchor, card_or_bank`;
  return withComputed(toEntry(r), today);
}

export async function updateSubscription(
  rowNumber: number,
  input: SubscriptionEditsInput,
  today: Date = todayInAppZone(),
): Promise<SubscriptionEntryComputed> {
  const service = input.service.trim();
  const cardOrBank = input.cardOrBank.trim();
  validateEntry(service, input.amount, input.duration, input.expiryAnchor, cardOrBank);
  if (!isPossibleId(rowNumber)) throw notFound(rowNumber);

  const sql = getSql();
  const [r] = await sql<SubscriptionRow[]>`
    update subscriptions set
      service = ${service},
      amount = ${input.amount},
      duration = ${input.duration},
      expiry_anchor = ${input.expiryAnchor},
      card_or_bank = ${cardOrBank}
    where id = ${rowNumber}
    returning id, service, amount, duration, expiry_anchor, card_or_bank`;
  if (!r) throw notFound(rowNumber);
  return withComputed(toEntry(r), today);
}

export async function deleteSubscription(rowNumber: number): Promise<void> {
  if (!isPossibleId(rowNumber)) throw notFound(rowNumber);

  const sql = getSql();
  const result = await sql`delete from subscriptions where id = ${rowNumber}`;
  if (result.count === 0) throw notFound(rowNumber);
}
