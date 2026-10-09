import { httpBackend } from "./backend/HttpBackend";
import type { LedgerBackend } from "./backend/LedgerBackend";

export type Category = string;

export interface CategoryOption {
  id: Category;
  label: string;
  bg: string;
  fg: string;
}

export interface LedgerEntry {
  row: number;
  amount: number;
  remarks: string;
  isCard: boolean;
  cardNote: string | null;
  category: Category | null;
}

export interface NewEntry {
  year: number;
  month: number; // 1-12
  amount: number;
  remarks: string;
  category: Category;
  isCard: boolean;
}

export interface EntryEdits {
  amount: number;
  remarks: string;
  category: Category;
  isCard: boolean;
}

export interface MonthSummary {
  month: number; // 1-12
  categoryTotals: Record<string, number>;
  total: number;
}

export interface SavingsEntry {
  name: string;
  amount: number;
}

export interface MonthIncome {
  year: number;
  month: number;
  salary: number | null;
  otherIncome: number | null;
  savings: SavingsEntry[];
  /** Last known per-scheme balances carried forward from before this month —
   * the baseline "+ deposit / − withdrawal" deltas are computed against. */
  previousSavings: SavingsEntry[];
}

export interface IncomeEdits {
  salary: number | null;
  otherIncome: number | null;
  savings: SavingsEntry[];
}

export interface MonthFinanceSummary {
  year: number;
  month: number;
  salary: number | null;
  otherIncome: number | null;
  expenses: number;
  balance: number;
  cumulative: number;
  minimumSavings: number | null;
  moneyEarned: number;
  moneySpent: number;
  currentSavings: number | null;
  currentSavingsBreakdown: SavingsEntry[];
}

export interface DebtEntry {
  row: number;
  name: string;
  /** Negative = money the user lent out (owed back to them); positive =
   * money the user owes someone else. */
  amount: number;
}

export interface DebtEdits {
  name: string;
  amount: number;
}

export interface CardBill {
  name: string;
  due: number;
  paid: number;
  /** YYYY-MM-DD, or null if not entered. */
  dueDate: string | null;
  /** Marked true once this bill is fully paid off, regardless of a small
   * rounding gap left by a payment app like CRED. */
  settled: boolean;
}

export interface MonthBills {
  year: number;
  month: number;
  cards: CardBill[];
}

export interface MonthBillsSummary extends MonthBills {
  totalDue: number;
  totalPaid: number;
  earliestDueDate: string | null;
  /** totalDue - totalPaid: negative = overpaid, positive = saved a little. */
  overpaidOrSaved: number;
}

interface EmiEntry {
  row: number;
  cardOrBank: string;
  emiAmount: number;
  dueDay: number;
  totalAmount: number;
  remarks: string;
  remainingAsOf: number;
  asOfDate: string;
  untilTarget: string | null;
  /** Annual interest rate as a percentage (e.g. 12.5 for 12.5% p.a.), or null
   * if not entered. Purely informational for now — display only. */
  interestRate: number | null;
  /** Early-closure fee as a percentage of the outstanding balance, or null if
   * not entered. Purely informational for now — display only. */
  foreclosureCharge: number | null;
}

export interface EmiEntryComputed extends EmiEntry {
  remaining: number;
  isPaidOff: boolean;
  estimatedPayoffMonth: string | null;
  /** Same estimate as estimatedPayoffMonth, as a full YYYY-MM-DD. */
  estimatedPayoffDate: string | null;
  /** True cost to close this loan today (outstanding principal + any
   * foreclosure charge) — equals `remaining` exactly when no interestRate
   * is on record, since `remaining` already double-counts future interest
   * once a real rate exists. */
  foreclosurePayoff: number;
}

export interface EmiEdits {
  cardOrBank: string;
  emiAmount: number;
  dueDay: number;
  totalAmount: number;
  remarks: string;
  remainingAsOf: number;
  /** Bank-stated months until payoff — optional; omitting it on an edit
   * preserves whatever until-target is already on record. */
  durationMonths?: number | null;
  /** Annual interest rate as a percentage, or null to leave/clear it — a
   * plain overwritable field (like emiAmount/totalAmount), not sticky like
   * durationMonths. */
  interestRate: number | null;
  /** Early-closure fee as a percentage, or null to leave/clear it — same
   * plain-overwritable-field semantics as interestRate. */
  foreclosureCharge: number | null;
}

export type SubscriptionDuration = "Monthly" | "Yearly";

interface SubscriptionEntry {
  row: number;
  service: string;
  amount: number;
  duration: SubscriptionDuration;
  expiryAnchor: string;
  cardOrBank: string;
}

export interface SubscriptionEntryComputed extends SubscriptionEntry {
  nextExpiry: string;
}

export interface SubscriptionEdits {
  service: string;
  amount: number;
  duration: SubscriptionDuration;
  expiryAnchor: string;
  cardOrBank: string;
}

export { ApiError } from "./backend/ApiError";

/** Where every function below sends its call (LedgerBackend.ts). The
 * Supabase build has one backend, the REST API, and no way to swap it. */
const backend: LedgerBackend = httpBackend;

/** A section a deployment can turn off with the server's ENABLED_MODULES.
 * The Dashboard is always on. */
export type ModuleName = "expenses" | "finances" | "debts" | "emi" | "credit-cards" | "subscriptions";

export interface AppConfig {
  /** The enabled modules, in canonical order. */
  modules: ModuleName[];
}

export function getConfig(): Promise<AppConfig> {
  return backend.getConfig();
}

export function getCategories(): Promise<CategoryOption[]> {
  return backend.getCategories();
}

export function getMonth(year: number, month: number): Promise<LedgerEntry[]> {
  return backend.getMonth(year, month);
}

export function addEntry(entry: NewEntry): Promise<LedgerEntry> {
  return backend.addEntry(entry);
}

export function updateEntry(
  year: number,
  month: number,
  row: number,
  edits: EntryEdits,
): Promise<LedgerEntry> {
  return backend.updateEntry(year, month, row, edits);
}

export function deleteEntry(year: number, month: number, row: number): Promise<void> {
  return backend.deleteEntry(year, month, row);
}

export function moveEntry(year: number, month: number, fromRow: number, toRow: number): Promise<void> {
  return backend.moveEntry(year, month, fromRow, toRow);
}

export interface MonthLock {
  locked: boolean;
}

export function getMonthLock(year: number, month: number): Promise<MonthLock> {
  return backend.getMonthLock(year, month);
}

export function setMonthLock(year: number, month: number, locked: boolean): Promise<MonthLock> {
  return backend.setMonthLock(year, month, locked);
}

export function getYearSummary(year: number): Promise<MonthSummary[]> {
  return backend.getYearSummary(year);
}

export function getMonthIncome(year: number, month: number): Promise<MonthIncome> {
  return backend.getMonthIncome(year, month);
}

export function setMonthIncome(year: number, month: number, edits: IncomeEdits): Promise<MonthIncome> {
  return backend.setMonthIncome(year, month, edits);
}

export function getFinanceSummary(year: number): Promise<MonthFinanceSummary[]> {
  return backend.getFinanceSummary(year);
}

export function getDebts(): Promise<DebtEntry[]> {
  return backend.getDebts();
}

export function addDebt(edits: DebtEdits): Promise<DebtEntry> {
  return backend.addDebt(edits);
}

export function updateDebt(row: number, edits: DebtEdits): Promise<DebtEntry> {
  return backend.updateDebt(row, edits);
}

export function deleteDebt(row: number): Promise<void> {
  return backend.deleteDebt(row);
}

export function getMonthBills(year: number, month: number): Promise<MonthBills> {
  return backend.getMonthBills(year, month);
}

export function setMonthBills(year: number, month: number, cards: CardBill[]): Promise<MonthBills> {
  return backend.setMonthBills(year, month, cards);
}

export function getCreditCardBillsSummary(year: number): Promise<MonthBillsSummary[]> {
  return backend.getCreditCardBillsSummary(year);
}

export function getEmis(): Promise<EmiEntryComputed[]> {
  return backend.getEmis();
}

export function addEmi(edits: EmiEdits): Promise<EmiEntryComputed> {
  return backend.addEmi(edits);
}

export function updateEmi(row: number, edits: EmiEdits): Promise<EmiEntryComputed> {
  return backend.updateEmi(row, edits);
}

export function deleteEmi(row: number): Promise<void> {
  return backend.deleteEmi(row);
}

export function payEmi(row: number, amount: number): Promise<EmiEntryComputed> {
  return backend.payEmi(row, amount);
}

export interface EmiMonthlyProjection {
  month: string; // YYYY-MM
  count: number;
  totalAmount: number;
}

export type EmiProjectionScale = 6 | 12 | 24 | 60 | "auto";

export function getEmiMonthlyProjection(months: EmiProjectionScale = 12): Promise<EmiMonthlyProjection[]> {
  return backend.getEmiMonthlyProjection(months);
}

export function getSubscriptions(): Promise<SubscriptionEntryComputed[]> {
  return backend.getSubscriptions();
}

export function addSubscription(edits: SubscriptionEdits): Promise<SubscriptionEntryComputed> {
  return backend.addSubscription(edits);
}

export function updateSubscription(row: number, edits: SubscriptionEdits): Promise<SubscriptionEntryComputed> {
  return backend.updateSubscription(row, edits);
}

export function deleteSubscription(row: number): Promise<void> {
  return backend.deleteSubscription(row);
}

type UpcomingSource = "EMI" | "Subscription" | "Credit Card" | "Salary";

export interface UpcomingItem {
  source: UpcomingSource;
  name: string;
  amount: number;
  dueDate: string;
}

/** A figure is null when its module is disabled; netWorth is null unless
 * all four inputs are enabled. */
interface NetWorthBreakdown {
  currentSavings: number | null;
  totalDebt: number | null;
  emiRemaining: number | null;
  creditCardOutstanding: number | null;
  netWorth: number | null;
}

export interface DashboardOverview {
  netWorth: NetWorthBreakdown;
  upcoming: UpcomingItem[];
  emiFreeDate: string | null;
}

export function getOverview(): Promise<DashboardOverview> {
  return backend.getOverview();
}
