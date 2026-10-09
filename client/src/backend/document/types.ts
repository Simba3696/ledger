import type { ModuleName, SubscriptionDuration } from "../../api";

// The plaintext of GitHub storage mode's data file (ADR-0007, the epic's
// "Document format"): everything the SQL tables hold, as one JSON value.
// DocumentBackend reads and writes it; persistence, encryption and sync
// (#6, #7) only ever see it whole.
//
// Conventions:
// - Month keys are `${year}-${MM}`: the year unpadded (the store accepts
//   years up to 2147483647), the month zero-padded. See monthKey().
// - Money is a decimal string with exactly 2 places ("1234.50"), and the two
//   rates have exactly 3, rounded as numeric(14,2) and numeric(6,3) round
//   (@ledger/shared/money). A record never holds a JS number for money.
// - Every record carries BaseRecord: a uuid, and who changed it last and
//   when. Those stamps and `tombstones` are what the sync merge (#7) reads.

export interface BaseRecord {
  id: string;
  /** Epoch milliseconds of the last change to this record's own fields. */
  updatedAt: number;
  /** GitHub login of whoever made that change. */
  updatedBy: string;
}

export interface ExpenseRecord extends BaseRecord {
  /** Fractional index (sortKey.ts). A month lists by (sortKey, id). */
  sortKey: string;
  amount: string;
  remarks: string;
  /** Null only for an imported row whose colour matched no category. */
  category: string | null;
  /** Null = cash; "CC", or an imported note like "CC (200)", = card. */
  cardNote: string | null;
}

export interface DebtRecord extends BaseRecord {
  name: string;
  /** Signed: positive = you owe, negative = owed to you. */
  amount: string;
}

/** The columns server/src/store/emi.ts reads. */
export interface EmiRecord extends BaseRecord {
  cardOrBank: string;
  emiAmount: string;
  dueDay: number;
  totalAmount: string;
  remarks: string;
  remainingAsOf: string;
  /** YYYY-MM-DD the remainingAsOf snapshot was taken. */
  asOfDate: string;
  untilTarget: string | null;
  /** Scale 3, like numeric(6,3). */
  interestRate: string | null;
  /** Scale 3, like numeric(6,3). */
  foreclosureCharge: string | null;
}

export interface SubscriptionRecord extends BaseRecord {
  service: string;
  amount: string;
  duration: SubscriptionDuration;
  /** YYYY-MM-DD. */
  expiryAnchor: string;
  cardOrBank: string;
}

export interface CardBillRecord extends BaseRecord {
  name: string;
  due: string;
  paid: string;
  dueDate: string | null;
  settled: boolean;
}

interface SavingsLine {
  name: string;
  amount: string;
}

/** One month's income and savings snapshot. An empty `savings` list means
 * savings weren't entered that month. */
interface FinanceMonth {
  salary: string | null;
  otherIncome: string | null;
  savings: SavingsLine[];
}

interface CategoryRecord {
  id: string;
  label: string;
  bg: string;
  /** Null = derived from bg on read. */
  fg: string | null;
  position: number;
}

interface Tombstone {
  id: string;
  deletedAt: number;
}

interface LedgerSettings {
  /** The enabled sections, as ENABLED_MODULES is on the server. */
  modules: ModuleName[];
  /** The IANA zone "today" is reckoned in, as APP_TIMEZONE is. */
  timeZone: string;
}

export interface LedgerDocument {
  version: 1;
  settings: LedgerSettings;
  categories: CategoryRecord[];
  expenses: Record<string, ExpenseRecord[]>;
  monthLocks: Record<string, true>;
  financeMonths: Record<string, FinanceMonth>;
  debts: DebtRecord[];
  emis: EmiRecord[];
  subscriptions: SubscriptionRecord[];
  /** Each month's cards in the order they were saved. */
  cardBills: Record<string, CardBillRecord[]>;
  tombstones: Tombstone[];
}

/** The document key for a month: `${year}-${MM}`, year unpadded. */
export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** The inverse of monthKey, for walking a month-keyed collection. */
export function parseMonthKey(key: string): { year: number; month: number } {
  const dash = key.lastIndexOf("-");
  return { year: Number(key.slice(0, dash)), month: Number(key.slice(dash + 1)) };
}
