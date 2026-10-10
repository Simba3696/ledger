import { daysInMonth, formatDate } from "@ledger/shared/dateMath";
import { LedgerError } from "@ledger/shared/errors";
import { isSortKey } from "./sortKey";
import type { LedgerDocument } from "./types";

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

/** A real YYYY-MM-DD calendar date. What every stored date must be: the
 * user's dates are checked with it, formatDate() only makes such dates, and
 * the document shape check below holds a remote value to it too. */
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

/** `date` as the EMI write path stores it. A payment settles the first due
 * date after the stored asOfDate, so an asOfDate late in 9999 (which a remote
 * op may set) would move to year 10000, which no stored date can hold: that
 * payment is refused, and editing the EMI re-anchors it at today. */
export function storableDate(date: Date): string {
  const text = formatDate(date);
  if (!isRealDate(text)) throw new LedgerError(`Date out of range: ${text}`, 400);
  return text;
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

// --- Document shape (GitHub mode) -------------------------------------------
// Not a SQL-store port: the structural checks GitHub mode applies to a whole
// document it did not just build (a genesis, a backup to restore, and the
// sync engine's own self-check, ADR-0008), and that sync's op validator
// applies to each register value. Structural only: formats and types, never
// business rules such as positive amounts or known categories, which ran at
// the origin. Sync replays a file only if every build agrees it is valid, so
// within one sync format version these checks may be loosened, never
// tightened (ADR-0008).

type Check = (value: unknown) => boolean;

const isString: Check = (value) => typeof value === "string";
const isFiniteNumber: Check = (value) => typeof value === "number" && Number.isFinite(value);
const isBoolean: Check = (value) => typeof value === "boolean";
const orNull = (check: Check): Check => (value) => value === null || check(value);
const matches = (pattern: RegExp): Check => (value) => typeof value === "string" && pattern.test(value);

/** Money: toDecimalString(_, 2). Rates: toDecimalString(_, 3). */
const isMoneyText = matches(/^-?\d{1,15}\.\d{2}$/);
const isRateText = matches(/^-?\d{1,15}\.\d{3}$/);
const isDateText: Check = (value) => typeof value === "string" && isRealDate(value);
const isDueDay: Check = (value) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 31;

/** monthKey()'s output: the year unpadded, the month zero-padded. */
export const isMonthKey = matches(/^[1-9]\d{0,9}-(0[1-9]|1[0-2])$/);

/** An IANA time zone name's shape: "UTC", "EST5EDT", "Asia/Kolkata",
 * "America/Argentina/Buenos_Aires", "Etc/GMT+5". Only the shape, never
 * whether this runtime's Intl knows the zone: zone lists differ between
 * builds, and every build must agree on what is valid (ADR-0008). A
 * well-shaped zone this runtime doesn't know counts as UTC
 * (DocumentBackend's today). */
export const isTimeZoneName = matches(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z][A-Za-z0-9_+-]*){0,2}$/);

/** A record id: crypto.randomUUID()'s form. */
export const isRecordId = matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** The stamps every record carries (BaseRecord minus the id). */
export const isRecordStamp = (at: unknown, by: unknown): boolean => isFiniteNumber(at) && isString(by);

/** Each record collection's own fields (BaseRecord aside), with the check
 * each value must pass. */
export const RECORD_FIELDS = {
  expenses: {
    sortKey: isSortKey,
    amount: isMoneyText,
    remarks: isString,
    category: orNull(isString),
    cardNote: orNull(isString),
  },
  debts: { name: isString, amount: isMoneyText },
  emis: {
    cardOrBank: isString,
    emiAmount: isMoneyText,
    dueDay: isDueDay,
    totalAmount: isMoneyText,
    remarks: isString,
    remainingAsOf: isMoneyText,
    asOfDate: isDateText,
    untilTarget: orNull(isDateText),
    interestRate: orNull(isRateText),
    foreclosureCharge: orNull(isRateText),
  },
  subscriptions: {
    service: isString,
    amount: isMoneyText,
    duration: (value: unknown) => value === "Monthly" || value === "Yearly",
    expiryAnchor: isDateText,
    cardOrBank: isString,
  },
} as const satisfies Record<string, Record<string, Check>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object with exactly these keys, each passing its check. */
function isShape(value: unknown, shape: Record<string, Check>): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== Object.keys(shape).length) return false;
  return keys.every((key) => Object.hasOwn(shape, key) && shape[key](value[key]));
}

const BASE_RECORD: Record<string, Check> = { id: isRecordId, updatedAt: isFiniteNumber, updatedBy: isString };

/** A list of records of one shape, no id twice in `ids` (shared across calls
 * for a collection split over months). */
function isRecordList(value: unknown, fields: Record<string, Check>, ids: Set<string>): boolean {
  if (!Array.isArray(value)) return false;
  const shape = { ...BASE_RECORD, ...fields };
  for (const record of value) {
    if (!isShape(record, shape)) return false;
    const id = (record as { id: string }).id;
    if (ids.has(id)) return false;
    ids.add(id);
  }
  return true;
}

const SAVINGS_LINE: Record<string, Check> = { name: isString, amount: isMoneyText };

/** One financeMonths value: what setMonthIncome writes. */
export function isFinanceMonth(value: unknown): boolean {
  return isShape(value, {
    salary: orNull(isMoneyText),
    otherIncome: orNull(isMoneyText),
    savings: (savings) => Array.isArray(savings) && savings.every((line) => isShape(line, SAVINGS_LINE)),
  });
}

const CARD_FIELDS: Record<string, Check> = { name: isString, due: isMoneyText, paid: isMoneyText, dueDate: orNull(isDateText), settled: isBoolean };

/** One cardBills value: what setMonthBills writes, card ids unique. */
export function isCardBillList(value: unknown): boolean {
  return isRecordList(value, CARD_FIELDS, new Set());
}

const CATEGORY: Record<string, Check> = { id: isString, label: isString, bg: isString, fg: orNull(isString), position: isFiniteNumber };

/** The categories list: only a genesis sets it. Ids unique. */
export function isCategoryList(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every((c) => isShape(c, CATEGORY))) return false;
  return new Set(value.map((c: { id: string }) => c.id)).size === value.length;
}

/** settings.modules: plain strings (canonicalModules drops unknown names). */
export const isModuleList: Check = (value) => Array.isArray(value) && value.every(isString);

/** A month-keyed map whose every value passes `check`. */
function isMonthMap(value: unknown, check: Check): boolean {
  return isPlainObject(value) && Object.entries(value).every(([key, v]) => isMonthKey(key) && check(v));
}

/** Whether a value is a LedgerDocument this version writes, checked all the
 * way down: version 1, exactly the document's keys, every record exactly its
 * collection's fields with well-formed values, month keys as monthKey()
 * writes them, and no record id twice in one collection (expenses across all
 * their months). What a genesis, a backup to restore and every materialised
 * sync document must pass. */
export function isWritableDocument(value: unknown): value is LedgerDocument {
  if (!isPlainObject(value) || value.version !== 1) return false;
  const expenseIds = new Set<string>();
  return isShape(value, {
    version: () => true,
    settings: (settings) => isShape(settings, { modules: isModuleList, timeZone: isTimeZoneName }),
    categories: isCategoryList,
    expenses: (months) => isMonthMap(months, (list) => isRecordList(list, RECORD_FIELDS.expenses, expenseIds)),
    monthLocks: (locks) => isMonthMap(locks, (locked) => locked === true),
    financeMonths: (months) => isMonthMap(months, isFinanceMonth),
    debts: (list) => isRecordList(list, RECORD_FIELDS.debts, new Set()),
    emis: (list) => isRecordList(list, RECORD_FIELDS.emis, new Set()),
    subscriptions: (list) => isRecordList(list, RECORD_FIELDS.subscriptions, new Set()),
    cardBills: (months) => isMonthMap(months, isCardBillList),
    tombstones: (list) => Array.isArray(list) && list.every((t) => isShape(t, { id: isString, deletedAt: isFiniteNumber })),
  });
}
