import { getSql } from "../db/client.js";
import { LedgerError } from "../errors.js";
import { todayInAppZone } from "../domain/today.js";
import { assertMoney, assertText, isPossibleId, isRealDate } from "./validate.js";
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

function validateEntry(service: string, amount: number, duration: string, expiryAnchor: string, cardOrBank: string) {
  if (!service) throw new LedgerError("Service is required", 400);
  assertText(service, "Service");
  assertText(cardOrBank, "Card/bank");
  assertMoney(amount, { positive: true });
  if (duration !== "Monthly" && duration !== "Yearly") throw new LedgerError('Duration must be "Monthly" or "Yearly"', 400);
  if (!isRealDate(expiryAnchor)) throw new LedgerError("Expiry must be YYYY-MM-DD", 400);
}

function notFound(row: number): LedgerError {
  return new LedgerError(`No subscription at row ${row}`, 404);
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
