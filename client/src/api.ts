export type Category = "food" | "transportation" | "rent" | "other";

export interface CategoryOption {
  id: Category;
  label: string;
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
  food: number;
  transportation: number;
  rent: number;
  other: number;
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

const BASE = "/api";

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function getCategories(): Promise<CategoryOption[]> {
  return fetch(`${BASE}/categories`).then((r) => handle(r));
}

export function getMonth(year: number, month: number): Promise<LedgerEntry[]> {
  return fetch(`${BASE}/months/${year}/${month}`).then((r) => handle(r));
}

export function addEntry(entry: NewEntry): Promise<LedgerEntry> {
  return fetch(`${BASE}/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  }).then((r) => handle(r));
}

export function updateEntry(
  year: number,
  month: number,
  row: number,
  edits: EntryEdits,
): Promise<LedgerEntry> {
  return fetch(`${BASE}/entries/${year}/${month}/${row}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  }).then((r) => handle(r));
}

export function deleteEntry(year: number, month: number, row: number): Promise<void> {
  return fetch(`${BASE}/entries/${year}/${month}/${row}`, { method: "DELETE" }).then((r) => handle(r));
}

export function moveEntry(year: number, month: number, fromRow: number, toRow: number): Promise<void> {
  return fetch(`${BASE}/entries/${year}/${month}/${fromRow}/move`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toRow }),
  }).then((r) => handle(r));
}

export function getYearSummary(year: number): Promise<MonthSummary[]> {
  return fetch(`${BASE}/summary/${year}`).then((r) => handle(r));
}

export function getMonthIncome(year: number, month: number): Promise<MonthIncome> {
  return fetch(`${BASE}/finance/${year}/${month}`).then((r) => handle(r));
}

export function setMonthIncome(year: number, month: number, edits: IncomeEdits): Promise<MonthIncome> {
  return fetch(`${BASE}/finance/${year}/${month}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  }).then((r) => handle(r));
}

export function getFinanceSummary(year: number): Promise<MonthFinanceSummary[]> {
  return fetch(`${BASE}/finance-summary/${year}`).then((r) => handle(r));
}

export function getDebts(): Promise<DebtEntry[]> {
  return fetch(`${BASE}/debts`).then((r) => handle(r));
}

export function addDebt(edits: DebtEdits): Promise<DebtEntry> {
  return fetch(`${BASE}/debts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  }).then((r) => handle(r));
}

export function updateDebt(row: number, edits: DebtEdits): Promise<DebtEntry> {
  return fetch(`${BASE}/debts/${row}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(edits),
  }).then((r) => handle(r));
}

export function deleteDebt(row: number): Promise<void> {
  return fetch(`${BASE}/debts/${row}`, { method: "DELETE" }).then((r) => handle(r));
}

export function getMonthBills(year: number, month: number): Promise<MonthBills> {
  return fetch(`${BASE}/credit-card-bills/${year}/${month}`).then((r) => handle(r));
}

export function setMonthBills(year: number, month: number, cards: CardBill[]): Promise<MonthBills> {
  return fetch(`${BASE}/credit-card-bills/${year}/${month}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cards }),
  }).then((r) => handle(r));
}

export function getCreditCardBillsSummary(year: number): Promise<MonthBillsSummary[]> {
  return fetch(`${BASE}/credit-card-bills-summary/${year}`).then((r) => handle(r));
}
