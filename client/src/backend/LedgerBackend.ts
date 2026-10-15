import type {
  AppConfig,
  CardBill,
  CategoryOption,
  DashboardOverview,
  DebtEdits,
  DebtEntry,
  EmiEdits,
  EmiEntryComputed,
  EmiMonthlyProjection,
  EmiProjectionScale,
  EntryEdits,
  IncomeEdits,
  LedgerEntry,
  MonthBills,
  MonthBillsSummary,
  MonthFinanceSummary,
  MonthIncome,
  MonthLock,
  MonthSummary,
  NewEntry,
  SubscriptionEdits,
  SubscriptionEntryComputed,
} from "../api";

/** Where the app's data lives, behind the functions `api.ts` exports: one
 * method per export, with the same parameters and result. Components never
 * see a backend; they call `api.ts`, which delegates to one. The Supabase
 * build uses `httpBackend` (HttpBackend.ts, the REST API). A failed call
 * rejects with `ApiError`, carrying an HTTP-equivalent `status`.
 *
 * Defaults live in `api.ts`, not here (`getEmiMonthlyProjection`'s
 * `months = 12`), so every backend receives the same arguments. */
export interface LedgerBackend {
  getConfig(): Promise<AppConfig>;
  getCategories(): Promise<CategoryOption[]>;

  getMonth(year: number, month: number): Promise<LedgerEntry[]>;
  addEntry(entry: NewEntry): Promise<LedgerEntry>;
  updateEntry(year: number, month: number, row: number, edits: EntryEdits): Promise<LedgerEntry>;
  deleteEntry(year: number, month: number, row: number): Promise<void>;
  moveEntry(year: number, month: number, fromRow: number, toRow: number): Promise<void>;
  getMonthLock(year: number, month: number): Promise<MonthLock>;
  setMonthLock(year: number, month: number, locked: boolean): Promise<MonthLock>;
  getYearSummary(year: number): Promise<MonthSummary[]>;

  getMonthIncome(year: number, month: number): Promise<MonthIncome>;
  setMonthIncome(year: number, month: number, edits: IncomeEdits): Promise<MonthIncome>;
  getFinanceSummary(year: number): Promise<MonthFinanceSummary[]>;

  getDebts(): Promise<DebtEntry[]>;
  addDebt(edits: DebtEdits): Promise<DebtEntry>;
  updateDebt(row: number, edits: DebtEdits): Promise<DebtEntry>;
  deleteDebt(row: number): Promise<void>;

  getMonthBills(year: number, month: number): Promise<MonthBills>;
  setMonthBills(year: number, month: number, cards: CardBill[]): Promise<MonthBills>;
  getCreditCardBillsSummary(year: number): Promise<MonthBillsSummary[]>;

  getEmis(): Promise<EmiEntryComputed[]>;
  addEmi(edits: EmiEdits): Promise<EmiEntryComputed>;
  updateEmi(row: number, edits: EmiEdits): Promise<EmiEntryComputed>;
  deleteEmi(row: number): Promise<void>;
  payEmi(row: number, amount: number): Promise<EmiEntryComputed>;
  getEmiMonthlyProjection(months: EmiProjectionScale): Promise<EmiMonthlyProjection[]>;

  getSubscriptions(): Promise<SubscriptionEntryComputed[]>;
  addSubscription(edits: SubscriptionEdits): Promise<SubscriptionEntryComputed>;
  updateSubscription(row: number, edits: SubscriptionEdits): Promise<SubscriptionEntryComputed>;
  deleteSubscription(row: number): Promise<void>;

  getOverview(): Promise<DashboardOverview>;
}
