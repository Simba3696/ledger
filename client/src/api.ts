import { currentAccessToken, expireSession } from "./auth/session";

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

export interface EmiEntry {
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

export interface SubscriptionEntry {
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

const BASE = "/api";

/** A non-2xx API response. `status` lets a caller tell, say, the 403 for a
 * signed-in account that isn't the owner (only ever seen on the first
 * request, GET /api/config, since every route answers it the same way)
 * apart from a validation error. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** The one place the client calls the API (LLD §6). Reads the current
 * session on every call rather than caching a token, since supabase-js
 * refreshes it in the background. A 401 means the session is gone or no
 * longer valid: it is cleared locally, which returns the app to <SignIn/>. */
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = await currentAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const message = body.error ?? `Request failed (${res.status})`;
    if (res.status === 401) await expireSession(message);
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** A section a deployment can turn off with the server's ENABLED_MODULES.
 * The Dashboard is always on. */
export type ModuleName = "expenses" | "finances" | "debts" | "emi" | "credit-cards" | "subscriptions";

export interface AppConfig {
  /** The enabled modules, in canonical order. */
  modules: ModuleName[];
}

export function getConfig(): Promise<AppConfig> {
  return request(`${BASE}/config`);
}

export function getCategories(): Promise<CategoryOption[]> {
  return request(`${BASE}/categories`);
}

export function getMonth(year: number, month: number): Promise<LedgerEntry[]> {
  return request(`${BASE}/months/${year}/${month}`);
}

export function addEntry(entry: NewEntry): Promise<LedgerEntry> {
  return request(`${BASE}/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  });
}

export function updateEntry(
  year: number,
  month: number,
  row: number,
  edits: EntryEdits,
): Promise<LedgerEntry> {
  return request(`${BASE}/entries/${year}/${month}/${row}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  });
}

export function deleteEntry(year: number, month: number, row: number): Promise<void> {
  return request(`${BASE}/entries/${year}/${month}/${row}`, { method: "DELETE" });
}

export function moveEntry(year: number, month: number, fromRow: number, toRow: number): Promise<void> {
  return request(`${BASE}/entries/${year}/${month}/${fromRow}/move`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toRow }),
  });
}

export interface MonthLock {
  locked: boolean;
}

export function getMonthLock(year: number, month: number): Promise<MonthLock> {
  return request(`${BASE}/months/${year}/${month}/lock`);
}

export function setMonthLock(year: number, month: number, locked: boolean): Promise<MonthLock> {
  return request(`${BASE}/months/${year}/${month}/lock`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locked }),
  });
}

export function getYearSummary(year: number): Promise<MonthSummary[]> {
  return request(`${BASE}/summary/${year}`);
}

export function getMonthIncome(year: number, month: number): Promise<MonthIncome> {
  return request(`${BASE}/finance/${year}/${month}`);
}

export function setMonthIncome(year: number, month: number, edits: IncomeEdits): Promise<MonthIncome> {
  return request(`${BASE}/finance/${year}/${month}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  });
}

export function getFinanceSummary(year: number): Promise<MonthFinanceSummary[]> {
  return request(`${BASE}/finance-summary/${year}`);
}

export function getDebts(): Promise<DebtEntry[]> {
  return request(`${BASE}/debts`);
}

export function addDebt(edits: DebtEdits): Promise<DebtEntry> {
  return request(`${BASE}/debts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  });
}

export function updateDebt(row: number, edits: DebtEdits): Promise<DebtEntry> {
  return request(`${BASE}/debts/${row}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  });
}

export function deleteDebt(row: number): Promise<void> {
  return request(`${BASE}/debts/${row}`, { method: "DELETE" });
}

export function getMonthBills(year: number, month: number): Promise<MonthBills> {
  return request(`${BASE}/credit-card-bills/${year}/${month}`);
}

export function setMonthBills(year: number, month: number, cards: CardBill[]): Promise<MonthBills> {
  return request(`${BASE}/credit-card-bills/${year}/${month}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cards }),
  });
}

export function getCreditCardBillsSummary(year: number): Promise<MonthBillsSummary[]> {
  return request(`${BASE}/credit-card-bills-summary/${year}`);
}

export function getEmis(): Promise<EmiEntryComputed[]> {
  return request(`${BASE}/emi`);
}

export function addEmi(edits: EmiEdits): Promise<EmiEntryComputed> {
  return request(`${BASE}/emi`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  });
}

export function updateEmi(row: number, edits: EmiEdits): Promise<EmiEntryComputed> {
  return request(`${BASE}/emi/${row}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  });
}

export function deleteEmi(row: number): Promise<void> {
  return request(`${BASE}/emi/${row}`, { method: "DELETE" });
}

export function payEmi(row: number, amount: number): Promise<EmiEntryComputed> {
  return request(`${BASE}/emi/${row}/pay`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount }),
  });
}

export interface EmiMonthlyProjection {
  month: string; // YYYY-MM
  count: number;
  totalAmount: number;
}

export type EmiProjectionScale = 6 | 12 | 24 | 60 | "auto";

export function getEmiMonthlyProjection(months: EmiProjectionScale = 12): Promise<EmiMonthlyProjection[]> {
  return request(`${BASE}/emi-monthly-projection?months=${months}`);
}

export function getSubscriptions(): Promise<SubscriptionEntryComputed[]> {
  return request(`${BASE}/subscriptions`);
}

export function addSubscription(edits: SubscriptionEdits): Promise<SubscriptionEntryComputed> {
  return request(`${BASE}/subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  });
}

export function updateSubscription(row: number, edits: SubscriptionEdits): Promise<SubscriptionEntryComputed> {
  return request(`${BASE}/subscriptions/${row}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  });
}

export function deleteSubscription(row: number): Promise<void> {
  return request(`${BASE}/subscriptions/${row}`, { method: "DELETE" });
}

export type UpcomingSource = "EMI" | "Subscription" | "Credit Card" | "Salary";

export interface UpcomingItem {
  source: UpcomingSource;
  name: string;
  amount: number;
  dueDate: string;
}

/** A figure is null when its module is disabled; netWorth is null unless
 * all four inputs are enabled. */
export interface NetWorthBreakdown {
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
  return request(`${BASE}/overview`);
}
