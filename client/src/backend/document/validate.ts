import { daysInMonth } from "@ledger/shared/dateMath";
import { LedgerError } from "@ledger/shared/errors";

// The SQL store's input checks, ported (not moved: server/src is what the
// Supabase deployment ships) with identical messages, statuses and order:
// server/src/store/validate.ts:12-49 and each store's own checks. The backend
// parity suite (server/test/parity/) runs every message here against the SQL
// store, so a drift on either side fails it.
//
// Checks the route coercions make unreachable are left out: routes.ts turns
// a card's `settled` into a boolean (`c?.settled === true`), so the store's
// "Settled flag ... must be a boolean" can't fire over HTTP, nor here.

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** The `year` columns' own bounds: `check (year >= 2018)` and int4. */
const EARLIEST_YEAR = 2018;
const LATEST_YEAR = 2147483647;

// --- validate.ts -----------------------------------------------------------

/** Postgres `text` can't hold a NUL character. */
function assertText(value: string, label: string): void {
  if (value.includes("\u0000")) throw new LedgerError(`${label} contains an invalid character`, 400);
}

const MONEY_LIMIT_CENTS = 1e14; // numeric(14,2): at most 12 integer digits

/** Both bounds of a numeric(14,2) amount, checked on the rounded cents. */
function assertMoney(amount: number, opts: { positive: boolean }): void {
  const absCents = Math.round(Math.abs(amount) * 100);
  if (opts.positive) {
    if (!Number.isFinite(amount) || amount <= 0 || absCents <= 0) {
      throw new LedgerError("Amount must be a positive number", 400);
    }
  } else if (!Number.isFinite(amount)) {
    throw new LedgerError("Amount must be a number", 400);
  }
  if (absCents >= MONEY_LIMIT_CENTS) throw new LedgerError("Amount is too large", 400);
}

/** A real YYYY-MM-DD calendar date. */
function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** A `:row` that isn't a positive integer can't be a real row. */
export function isPossibleId(row: number): boolean {
  return Number.isSafeInteger(row) && row > 0;
}

// --- ledger.ts --------------------------------------------------------------

export function monthName(month: number): string {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new LedgerError(`Invalid month: ${month}`, 400);
  }
  return MONTH_NAMES[month - 1];
}

/** A year the `year` column can hold. Anything else can't have rows. */
export function isStorableYear(year: number): boolean {
  return Number.isInteger(year) && year >= EARLIEST_YEAR && year <= LATEST_YEAR;
}

export function validateYear(year: number): void {
  if (!isStorableYear(year)) throw new LedgerError(`Invalid year: ${year}`, 400);
}

export function noEntry(row: number, year: number, month: number): LedgerError {
  return new LedgerError(`No entry found at row ${row} in ${monthName(month)} ${year}`, 404);
}

export function monthLocked(year: number, month: number): LedgerError {
  return new LedgerError(
    `${monthName(month)} ${year} is locked. Unlock it first from the app if you really need to add an entry there.`,
    403,
  );
}

export function invalidTargetRow(toRow: number): LedgerError {
  return new LedgerError(`Invalid target row: ${toRow}`, 400);
}

export function validateEntryFields(amount: number, remarks: string, category: unknown, categoryIds: readonly string[]): void {
  assertMoney(amount, { positive: true });
  if (!remarks || !remarks.trim()) throw new LedgerError("Remarks are required", 400);
  assertText(remarks, "Remarks");
  if (!categoryIds.some((id) => id === category)) throw new LedgerError(`Unknown category: ${String(category)}`, 400);
}

// --- finances.ts ------------------------------------------------------------

export function validateFinanceYearMonth(year: number, month: number): void {
  if (!Number.isInteger(year) || year < EARLIEST_YEAR || year > LATEST_YEAR) {
    throw new LedgerError(`Invalid year: ${year}`, 400);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new LedgerError(`Invalid month: ${month}`, 400);
}

/** assertMoney relabelled with the field: callers check finiteness first,
 * so only "too large" reaches here. */
function assertMoneyLabelled(value: number, label: string): void {
  try {
    assertMoney(value, { positive: false });
  } catch {
    throw new LedgerError(`${label} is too large`, 400);
  }
}

export function validateIncomeAmount(value: number | null, label: string): void {
  if (value === null) return;
  if (!Number.isFinite(value)) throw new LedgerError(`${label} must be a number`, 400);
  assertMoneyLabelled(value, label);
}

export function validateSavings(savings: { name: string; amount: number }[]): void {
  for (const entry of savings) {
    if (!entry.name || !entry.name.trim()) throw new LedgerError("Each savings entry needs a name", 400);
    if (!Number.isFinite(entry.amount)) throw new LedgerError(`Savings amount for "${entry.name}" must be a number`, 400);
    assertText(entry.name, "Savings name");
    assertMoneyLabelled(entry.amount, `Savings amount for "${entry.name}"`);
  }
}

// --- debts.ts ---------------------------------------------------------------

export function validateDebt(name: string, amount: number): void {
  if (!name) throw new LedgerError("Name is required", 400);
  assertText(name, "Name");
  assertMoney(amount, { positive: false });
}

export function debtNotFound(row: number): LedgerError {
  return new LedgerError(`No debt entry at row ${row}`, 404);
}

// --- creditCardBills.ts -----------------------------------------------------

export function validateCardYear(year: number): void {
  if (!Number.isInteger(year) || year < EARLIEST_YEAR || year > LATEST_YEAR) {
    throw new LedgerError(`Invalid year: ${year}`, 400);
  }
}

export function validateCardYearMonth(year: number, month: number): void {
  validateCardYear(year);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new LedgerError(`Invalid month: ${month}`, 400);
}

export function validateCards(cards: { name: string; due: number; paid: number; dueDate: string | null }[]): void {
  for (const card of cards) {
    if (!card.name || !card.name.trim()) throw new LedgerError("Each card needs a name", 400);
    if (!Number.isFinite(card.due)) throw new LedgerError(`Amount due for "${card.name}" must be a number`, 400);
    if (!Number.isFinite(card.paid)) throw new LedgerError(`Amount paid for "${card.name}" must be a number`, 400);
    if (card.dueDate !== null && !isRealDate(card.dueDate)) {
      throw new LedgerError(`Due date for "${card.name}" must be YYYY-MM-DD or null`, 400);
    }
    assertText(card.name, "Card name");
    assertMoney(card.due, { positive: false });
    assertMoney(card.paid, { positive: false });
  }
}

// --- emi.ts -----------------------------------------------------------------

export interface EmiFields {
  cardOrBank: string;
  emiAmount: number;
  dueDay: number;
  totalAmount: number;
  remarks: string;
  remainingAsOf: number;
  durationMonths: number | null;
  interestRate: number | null;
  foreclosureCharge: number | null;
}

/** prepareInput's checks, in its order, on already-trimmed text. */
export function validateEmi(input: EmiFields): void {
  const { cardOrBank, emiAmount, dueDay, totalAmount, remainingAsOf, remarks } = input;
  if (!cardOrBank) throw new LedgerError("Card/Bank is required", 400);
  if (!Number.isFinite(emiAmount) || emiAmount <= 0) throw new LedgerError("EMI Amount must be a positive number", 400);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) throw new LedgerError("Due Day must be between 1 and 31", 400);
  if (!Number.isFinite(totalAmount) || totalAmount < 0) throw new LedgerError("Total Amount must be a number", 400);
  if (!Number.isFinite(remainingAsOf) || remainingAsOf < 0) throw new LedgerError("Remaining must be a number", 400);
  assertText(cardOrBank, "Card/Bank");
  assertText(remarks, "Remarks");
  assertMoney(emiAmount, { positive: true });
  assertMoney(totalAmount, { positive: false });
  assertMoney(remainingAsOf, { positive: false });

  const { durationMonths, interestRate, foreclosureCharge } = input;
  if (durationMonths !== null && (!Number.isInteger(durationMonths) || durationMonths < 1 || durationMonths > 600)) {
    throw new LedgerError("Duration must be a whole number of months (1-600)", 400);
  }
  if (interestRate !== null && (!Number.isFinite(interestRate) || interestRate < 0 || interestRate > 100)) {
    throw new LedgerError("Interest Rate must be a number between 0 and 100", 400);
  }
  if (foreclosureCharge !== null && (!Number.isFinite(foreclosureCharge) || foreclosureCharge < 0 || foreclosureCharge > 100)) {
    throw new LedgerError("Foreclosure Charge must be a number between 0 and 100", 400);
  }
}

export function validateEmiPayment(amountPaid: number): void {
  if (!Number.isFinite(amountPaid) || amountPaid < 0) {
    throw new LedgerError("Payment amount must be a non-negative number", 400);
  }
}

export function emiNotFound(row: number): LedgerError {
  return new LedgerError(`No EMI entry at row ${row}`, 404);
}

// --- subscriptions.ts -------------------------------------------------------

export function validateSubscription(service: string, amount: number, duration: unknown, expiryAnchor: string, cardOrBank: string): void {
  if (!service) throw new LedgerError("Service is required", 400);
  assertText(service, "Service");
  assertText(cardOrBank, "Card/bank");
  assertMoney(amount, { positive: true });
  if (duration !== "Monthly" && duration !== "Yearly") throw new LedgerError('Duration must be "Monthly" or "Yearly"', 400);
  if (!isRealDate(expiryAnchor)) throw new LedgerError("Expiry must be YYYY-MM-DD", 400);
}

export function subscriptionNotFound(row: number): LedgerError {
  return new LedgerError(`No subscription at row ${row}`, 404);
}
