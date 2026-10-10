import { DEFAULT_CATEGORIES, deriveForegroundColor } from "@ledger/shared/categoryColors";
import { summarize, type CardBill, type MonthBills, type MonthBillsSummary } from "@ledger/shared/creditCardMath";
import { formatDate, makeDate, parseDate, startOfDay } from "@ledger/shared/dateMath";
import {
  nextDueDateAfter,
  projectEmiMonthly,
  resolveUntilTarget,
  settleEmiPayment,
  withComputed as emiWithComputed,
  type EmiEntry,
  type EmiEntryComputed,
  type EmiMonthlyProjection,
} from "@ledger/shared/emiMath";
import {
  EARLIEST_YEAR,
  computeFinanceSummary,
  savingsBaselineFrom,
  type FinanceMonth as FinanceMonthRow,
  type MonthFinanceSummary,
  type MonthIncome,
} from "@ledger/shared/financeMath";
import { sumToNumber, toDecimalString } from "@ledger/shared/money";
import {
  withComputed as subscriptionWithComputed,
  type SubscriptionEntry,
  type SubscriptionEntryComputed,
} from "@ledger/shared/subscriptionMath";
import type { CategoryOption, DashboardOverview, DebtEntry, LedgerEntry, ModuleName, MonthSummary, UpcomingItem } from "../../api";
import type { RowHandles } from "./handles";
import { keyBetween, sequentialKeys } from "./sortKey";
import {
  monthKey,
  parseMonthKey,
  type BaseRecord,
  type CardBillRecord,
  type DebtRecord,
  type EmiRecord,
  type ExpenseRecord,
  type LedgerDocument,
  type SubscriptionRecord,
} from "./types";
import {
  MONTH_NAMES,
  debtNotFound,
  emiNotFound,
  invalidTargetRow,
  isPossibleId,
  isStorableYear,
  monthLocked,
  monthName,
  noEntry,
  storableDate,
  subscriptionNotFound,
  validateCardYear,
  validateCardYearMonth,
  validateCards,
  validateDebt,
  validateEmi,
  validateEmiBalance,
  validateEmiPayment,
  validateEntryFields,
  validateFinanceYearMonth,
  validateIncomeAmount,
  validateSavings,
  validateSubscription,
  validateYear,
  type EmiFields,
} from "./validate";

// The SQL store (server/src/store/*.ts) re-done over a LedgerDocument: the
// same checks in the same order, the same results, the same figures. Every
// function takes the coerced arguments (coerce.ts) and a context; the write
// functions change `ctx.doc`, which is DocumentBackend's draft clone, and
// stamp what they touch.

export interface ReadContext {
  doc: LedgerDocument;
  /** "Today" in the document's time zone (todayInAppZone). */
  today: Date;
  handles: RowHandles;
}

export interface WriteContext extends ReadContext {
  /** One clock reading for the whole write: every stamp it makes. */
  now: number;
  actor: string;
  newId: () => string;
}

/** Postgres stores text as UTF-8, and postgres.js encodes a lone surrogate
 * as U+FFFD, so that is what the SQL store reads back. Stored text gets the
 * same replacement (String.prototype.toWellFormed, which ES2023 lacks). */
function storedText(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

function money(value: number): string {
  return toDecimalString(value, 2);
}

function rate(value: number | null): string | null {
  return value === null ? null : toDecimalString(value, 3);
}

function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function newRecord(ctx: WriteContext): BaseRecord {
  return { id: ctx.newId(), updatedAt: ctx.now, updatedBy: ctx.actor };
}

/** Writes `changes` onto `record`, restamping it only if a field really
 * changed (a save that changes nothing keeps the record's stamps). */
function applyChanges<T extends BaseRecord, K extends keyof T>(record: T, changes: Pick<T, K>, ctx: WriteContext): void {
  let changed = false;
  for (const key of Object.keys(changes) as K[]) {
    if (record[key] !== changes[key]) {
      record[key] = changes[key];
      changed = true;
    }
  }
  if (changed) {
    record.updatedAt = ctx.now;
    record.updatedBy = ctx.actor;
  }
}

function bury(ctx: WriteContext, id: string): void {
  ctx.doc.tombstones.push({ id, deletedAt: ctx.now });
}

/** The record a handle names in `records`, if it is (still) there. */
function byHandle<T extends BaseRecord>(records: readonly T[], handles: RowHandles, row: number): T | undefined {
  const id = handles.idFor(row);
  return id === undefined ? undefined : records.find((r) => r.id === id);
}

// --- categories.ts ----------------------------------------------------------

/** loadCategoryConfig: ordered by (position, id), fg derived when null. An
 * empty list reads as the defaults, as an empty `categories` table does. */
export function listCategories(doc: LedgerDocument): CategoryOption[] {
  if (doc.categories.length === 0) return DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  return [...doc.categories]
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => ({ id: c.id, label: c.label, bg: c.bg, fg: c.fg ?? deriveForegroundColor(c.bg) }));
}

// --- ledger.ts --------------------------------------------------------------

function compareExpenses(a: ExpenseRecord, b: ExpenseRecord): number {
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A month's expenses in display order: (sortKey, id). */
function monthExpenses(doc: LedgerDocument, year: number, month: number): ExpenseRecord[] {
  return [...(doc.expenses[monthKey(year, month)] ?? [])].sort(compareExpenses);
}

function toEntry(r: ExpenseRecord, handles: RowHandles): LedgerEntry {
  return {
    row: handles.rowFor(r.id),
    amount: Number(r.amount),
    remarks: r.remarks,
    isCard: r.cardNote !== null,
    cardNote: r.cardNote,
    category: r.category,
  };
}

function cardNoteFor(isCard: boolean): string | null {
  return isCard ? "CC" : null;
}

function assertWritable(doc: LedgerDocument, year: number, month: number): void {
  if (doc.monthLocks[monthKey(year, month)] === true) throw monthLocked(year, month);
}

function findEntry(ctx: ReadContext, year: number, month: number, row: number): ExpenseRecord {
  if (!isPossibleId(row)) throw noEntry(row, year, month);
  const found = byHandle(ctx.doc.expenses[monthKey(year, month)] ?? [], ctx.handles, row);
  if (!found) throw noEntry(row, year, month);
  return found;
}

/** Stores a month's list back in display order; an emptied month's key goes. */
function putMonth(doc: LedgerDocument, year: number, month: number, records: ExpenseRecord[]): void {
  const key = monthKey(year, month);
  if (records.length === 0) delete doc.expenses[key];
  else doc.expenses[key] = [...records].sort(compareExpenses);
}

export function listMonth(ctx: ReadContext, year: number, month: number): LedgerEntry[] {
  validateYear(year);
  monthName(month);
  return monthExpenses(ctx.doc, year, month).map((r) => toEntry(r, ctx.handles));
}

export function isMonthLocked(ctx: ReadContext, year: number, month: number): boolean {
  validateYear(year);
  monthName(month);
  return ctx.doc.monthLocks[monthKey(year, month)] === true;
}

export function setMonthLocked(ctx: WriteContext, year: number, month: number, locked: boolean): void {
  validateYear(year);
  monthName(month);
  if (locked) ctx.doc.monthLocks[monthKey(year, month)] = true;
  else delete ctx.doc.monthLocks[monthKey(year, month)];
}

/** sum(amount) per group, exact, as a number (one group per key). */
function groupSums<K>(records: Iterable<ExpenseRecord>, keyOf: (r: ExpenseRecord) => K): Map<K, number> {
  const groups = new Map<K, string[]>();
  for (const r of records) {
    const key = keyOf(r);
    const amounts = groups.get(key);
    if (amounts) amounts.push(r.amount);
    else groups.set(key, [r.amount]);
  }
  return new Map([...groups].map(([key, amounts]) => [key, sumToNumber(amounts)]));
}

export function yearSummary(ctx: ReadContext, year: number): MonthSummary[] {
  const categories = listCategories(ctx.doc);
  const months: MonthSummary[] = [];
  for (let month = 1; month <= 12; month++) {
    months.push({ month, categoryTotals: Object.fromEntries(categories.map((c) => [c.id, 0])), total: 0 });
  }
  if (!isStorableYear(year)) return months;

  for (const summary of months) {
    // Grouped by category, then combined in JS, as ledger.ts:217-223 does
    // with the rows of `group by month, category_id`.
    const totals = groupSums(monthExpenses(ctx.doc, year, summary.month), (r) => r.category);
    for (const [category, total] of totals) {
      if (category !== null) summary.categoryTotals[category] = (summary.categoryTotals[category] ?? 0) + total;
      summary.total += total;
    }
  }
  return months;
}

/** expenseTotalsForYears: per-month totals (index 1-12) for every year in
 * the range, one exact sum per (year, month). */
function expenseTotalsForYears(doc: LedgerDocument, fromYear: number, toYear: number): Map<number, readonly number[]> {
  const zeros: readonly number[] = Object.freeze(Array.from({ length: 13 }, () => 0));
  const byYear = new Map<number, readonly number[]>();
  for (const [key, records] of Object.entries(doc.expenses)) {
    const { year, month } = parseMonthKey(key);
    if (year < fromYear || year > toYear || records.length === 0) continue;
    let totals = byYear.get(year) as number[] | undefined;
    if (!totals) {
      totals = Array.from({ length: 13 }, () => 0);
      byYear.set(year, totals);
    }
    totals[month] = sumToNumber(records.map((r) => r.amount));
  }
  for (let year = fromYear; year <= toYear; year++) {
    if (!byYear.has(year)) byYear.set(year, zeros);
  }
  return byYear;
}

export interface EntryInput {
  amount: number;
  remarks: string;
  category: unknown;
  isCard: boolean;
}

function categoryIds(doc: LedgerDocument): string[] {
  return listCategories(doc).map((c) => c.id);
}

export function appendEntry(ctx: WriteContext, year: number, month: number, input: EntryInput): LedgerEntry {
  validateEntryFields(input.amount, input.remarks, input.category, categoryIds(ctx.doc));
  validateYear(year);
  monthName(month);
  assertWritable(ctx.doc, year, month);

  const records = monthExpenses(ctx.doc, year, month);
  const record: ExpenseRecord = {
    ...newRecord(ctx),
    sortKey: keyBetween(records.at(-1)?.sortKey ?? null, null),
    amount: money(input.amount),
    remarks: storedText(input.remarks.trim()),
    category: String(input.category),
    cardNote: cardNoteFor(input.isCard),
  };
  putMonth(ctx.doc, year, month, [...records, record]);
  return toEntry(record, ctx.handles);
}

export function updateEntry(ctx: WriteContext, year: number, month: number, row: number, input: EntryInput): LedgerEntry {
  validateEntryFields(input.amount, input.remarks, input.category, categoryIds(ctx.doc));
  validateYear(year);
  monthName(month);
  assertWritable(ctx.doc, year, month);
  const record = findEntry(ctx, year, month, row);
  applyChanges(
    record,
    {
      amount: money(input.amount),
      remarks: storedText(input.remarks.trim()),
      category: String(input.category),
      cardNote: cardNoteFor(input.isCard),
    },
    ctx,
  );
  return toEntry(record, ctx.handles);
}

export function deleteEntry(ctx: WriteContext, year: number, month: number, row: number): void {
  validateYear(year);
  monthName(month);
  assertWritable(ctx.doc, year, month);
  const record = findEntry(ctx, year, month, row);
  putMonth(
    ctx.doc,
    year,
    month,
    monthExpenses(ctx.doc, year, month).filter((r) => r !== record),
  );
  bury(ctx, record.id);
}

/** moveEntry: the moved entry lands right after the target when moving down
 * and right before it when moving up, which is where ledger.ts:336-365's
 * renumbering puts it. Only the moved record gets a new key, unless two
 * records share a key at that spot (only a sync merge makes that), when the
 * month is re-keyed in its new order. */
export function moveEntry(ctx: WriteContext, year: number, month: number, fromRow: number, toRow: number): void {
  validateYear(year);
  monthName(month);
  assertWritable(ctx.doc, year, month);
  const from = findEntry(ctx, year, month, fromRow);
  const target = isPossibleId(toRow) ? byHandle(ctx.doc.expenses[monthKey(year, month)] ?? [], ctx.handles, toRow) : undefined;
  if (!target) throw invalidTargetRow(toRow);
  if (fromRow === toRow) return;

  const records = monthExpenses(ctx.doc, year, month);
  const fromIndex = records.indexOf(from);
  const toIndex = records.indexOf(target);
  const [before, after] = fromIndex < toIndex ? [target, records[toIndex + 1]] : [records[toIndex - 1], target];
  if (!before || !after || before.sortKey < after.sortKey) {
    applyChanges(from, { sortKey: keyBetween(before?.sortKey ?? null, after?.sortKey ?? null) }, ctx);
  } else {
    const reordered = records.filter((r) => r !== from);
    reordered.splice(reordered.indexOf(target) + (fromIndex < toIndex ? 1 : 0), 0, from);
    const keys = sequentialKeys(reordered.length);
    reordered.forEach((r, i) => applyChanges(r, { sortKey: keys[i] }, ctx));
  }
  putMonth(ctx.doc, year, month, records);
}

// --- finances.ts ------------------------------------------------------------

/** Every stored month through (year, month) inclusive, chronologically. */
function loadMonthsThrough(doc: LedgerDocument, year: number, month: number): FinanceMonthRow[] {
  const months: FinanceMonthRow[] = [];
  for (const [key, m] of Object.entries(doc.financeMonths)) {
    const at = parseMonthKey(key);
    if (at.year > year || (at.year === year && at.month > month)) continue;
    months.push({
      year: at.year,
      month: at.month,
      salary: numberOrNull(m.salary),
      otherIncome: numberOrNull(m.otherIncome),
      savings: m.savings.map((s) => ({ name: s.name, amount: Number(s.amount) })),
    });
  }
  return months.sort((a, b) => a.year - b.year || a.month - b.month);
}

export function getMonthIncome(ctx: ReadContext, year: number, month: number): MonthIncome {
  validateFinanceYearMonth(year, month);
  const months = loadMonthsThrough(ctx.doc, year, month);
  const row = months.find((r) => r.year === year && r.month === month);
  return {
    year,
    month,
    salary: row ? row.salary : null,
    otherIncome: row ? row.otherIncome : null,
    savings: row ? row.savings : [],
    previousSavings: savingsBaselineFrom(months, year, month),
  };
}

export interface IncomeInput {
  salary: number | null;
  otherIncome: number | null;
  savings: { name: string; amount: number }[];
}

export function setMonthIncome(ctx: WriteContext, year: number, month: number, input: IncomeInput): MonthIncome {
  validateFinanceYearMonth(year, month);
  validateIncomeAmount(input.salary, "Salary");
  validateIncomeAmount(input.otherIncome, "Other income");
  validateSavings(input.savings);
  ctx.doc.financeMonths[monthKey(year, month)] = {
    salary: input.salary === null ? null : money(input.salary),
    otherIncome: input.otherIncome === null ? null : money(input.otherIncome),
    savings: input.savings.map((s) => ({ name: storedText(s.name), amount: money(s.amount) })),
  };
  return getMonthIncome(ctx, year, month);
}

function financeSummary(doc: LedgerDocument, uptoYear: number, uptoMonth: number): MonthFinanceSummary[] {
  validateFinanceYearMonth(uptoYear, uptoMonth);
  const months = loadMonthsThrough(doc, uptoYear, uptoMonth);
  return computeFinanceSummary(months, expenseTotalsForYears(doc, EARLIEST_YEAR, uptoYear), uptoYear, uptoMonth);
}

/** GET /finance-summary/:year always asks for the whole year (routes.ts:196). */
export function yearFinanceSummary(ctx: ReadContext, year: number): MonthFinanceSummary[] {
  return financeSummary(ctx.doc, year, 12);
}

// --- debts.ts ---------------------------------------------------------------

function toDebt(r: DebtRecord, handles: RowHandles): DebtEntry {
  return { row: handles.rowFor(r.id), name: r.name, amount: Number(r.amount) };
}

export function listDebts(ctx: ReadContext): DebtEntry[] {
  return ctx.doc.debts.map((r) => toDebt(r, ctx.handles));
}

export function addDebt(ctx: WriteContext, input: { name: string; amount: number }): DebtEntry {
  const name = input.name.trim();
  validateDebt(name, input.amount);
  const record: DebtRecord = { ...newRecord(ctx), name: storedText(name), amount: money(input.amount) };
  ctx.doc.debts.push(record);
  return toDebt(record, ctx.handles);
}

export function updateDebt(ctx: WriteContext, row: number, input: { name: string; amount: number }): DebtEntry {
  const name = input.name.trim();
  validateDebt(name, input.amount);
  if (!isPossibleId(row)) throw debtNotFound(row);
  const record = byHandle(ctx.doc.debts, ctx.handles, row);
  if (!record) throw debtNotFound(row);
  applyChanges(record, { name: storedText(name), amount: money(input.amount) }, ctx);
  return toDebt(record, ctx.handles);
}

/** Removes the record a handle names from `records`, leaving a tombstone. */
function removeRecord<T extends BaseRecord>(ctx: WriteContext, records: T[], row: number, notFound: (row: number) => Error): void {
  if (!isPossibleId(row)) throw notFound(row);
  const record = byHandle(records, ctx.handles, row);
  if (!record) throw notFound(row);
  records.splice(records.indexOf(record), 1);
  bury(ctx, record.id);
}

export function deleteDebt(ctx: WriteContext, row: number): void {
  removeRecord(ctx, ctx.doc.debts, row, debtNotFound);
}

// --- creditCardBills.ts -----------------------------------------------------

function toCard(r: CardBillRecord): CardBill {
  return { name: r.name, due: Number(r.due), paid: Number(r.paid), dueDate: r.dueDate, settled: r.settled };
}

function monthCards(doc: LedgerDocument, year: number, month: number): CardBill[] {
  return (doc.cardBills[monthKey(year, month)] ?? []).map(toCard);
}

export function getMonthBills(ctx: ReadContext, year: number, month: number): MonthBills {
  validateCardYearMonth(year, month);
  return { year, month, cards: monthCards(ctx.doc, year, month) };
}

/** Whole-month replace, in the order given. A card keeps its id when the
 * same position held a card of the same name; the others get new ids, and
 * a dropped card leaves no tombstone (a month's cards merge as one unit). */
export function setMonthBills(ctx: WriteContext, year: number, month: number, cards: CardBill[]): MonthBills {
  validateCardYearMonth(year, month);
  validateCards(cards);
  const key = monthKey(year, month);
  const previous = ctx.doc.cardBills[key] ?? [];
  const saved = cards.map((card, position): CardBillRecord => {
    const fields = {
      name: storedText(card.name),
      due: money(card.due),
      paid: money(card.paid),
      dueDate: card.dueDate,
      settled: card.settled,
    };
    const kept = previous[position];
    if (kept && kept.name === fields.name) {
      const record = { ...kept };
      applyChanges(record, fields, ctx);
      return record;
    }
    return { ...newRecord(ctx), ...fields };
  });
  if (saved.length === 0) delete ctx.doc.cardBills[key];
  else ctx.doc.cardBills[key] = saved;
  return { year, month, cards: saved.map(toCard) };
}

export function yearBillsSummary(ctx: ReadContext, year: number): MonthBillsSummary[] {
  validateCardYear(year);
  const results: MonthBillsSummary[] = [];
  for (let month = 1; month <= 12; month++) results.push(summarize({ year, month, cards: monthCards(ctx.doc, year, month) }));
  return results;
}

// --- emi.ts -----------------------------------------------------------------

function toEmi(r: EmiRecord, handles: RowHandles): EmiEntry {
  return {
    row: handles.rowFor(r.id),
    cardOrBank: r.cardOrBank,
    emiAmount: Number(r.emiAmount),
    dueDay: r.dueDay,
    totalAmount: Number(r.totalAmount),
    remarks: r.remarks,
    remainingAsOf: Number(r.remainingAsOf),
    asOfDate: r.asOfDate,
    untilTarget: r.untilTarget,
    interestRate: numberOrNull(r.interestRate),
    foreclosureCharge: numberOrNull(r.foreclosureCharge),
  };
}

export function listEmis(ctx: ReadContext): EmiEntryComputed[] {
  return ctx.doc.emis.map((r) => emiWithComputed(toEmi(r, ctx.handles), ctx.today));
}

export function emiMonthlyProjection(ctx: ReadContext, months: number | "auto"): EmiMonthlyProjection[] {
  return projectEmiMonthly(listEmis(ctx), months, ctx.today);
}

/** prepareInput: trims, validates, and returns the fields to store. */
function prepareEmi(input: EmiFields): EmiFields {
  const prepared = { ...input, cardOrBank: input.cardOrBank.trim(), remarks: input.remarks.trim() };
  validateEmi(prepared);
  return prepared;
}

function emiFieldsToStore(input: EmiFields, today: Date) {
  return {
    cardOrBank: storedText(input.cardOrBank),
    emiAmount: money(input.emiAmount),
    dueDay: input.dueDay,
    totalAmount: money(input.totalAmount),
    remarks: storedText(input.remarks),
    remainingAsOf: money(input.remainingAsOf),
    asOfDate: formatDate(startOfDay(today)),
    interestRate: rate(input.interestRate),
    foreclosureCharge: rate(input.foreclosureCharge),
  };
}

export function addEmi(ctx: WriteContext, input: EmiFields): EmiEntryComputed {
  const prepared = prepareEmi(input);
  const untilTarget = prepared.durationMonths ? resolveUntilTarget(prepared.durationMonths, ctx.today) : null;
  const record: EmiRecord = { ...newRecord(ctx), ...emiFieldsToStore(prepared, ctx.today), untilTarget };
  ctx.doc.emis.push(record);
  return emiWithComputed(toEmi(record, ctx.handles), ctx.today);
}

export function updateEmi(ctx: WriteContext, row: number, input: EmiFields): EmiEntryComputed {
  const prepared = prepareEmi(input);
  if (!isPossibleId(row)) throw emiNotFound(row);
  // A fresh Duration replaces the target; without one the stored target is
  // kept, as the store's coalesce does.
  const untilTarget = prepared.durationMonths ? resolveUntilTarget(prepared.durationMonths, ctx.today) : null;
  const record = byHandle(ctx.doc.emis, ctx.handles, row);
  if (!record) throw emiNotFound(row);
  applyChanges(record, { ...emiFieldsToStore(prepared, ctx.today), untilTarget: untilTarget ?? record.untilTarget }, ctx);
  return emiWithComputed(toEmi(record, ctx.handles), ctx.today);
}

export function recordEmiPayment(ctx: WriteContext, row: number, amountPaid: number): EmiEntryComputed {
  validateEmiPayment(amountPaid);
  if (!isPossibleId(row)) throw emiNotFound(row);
  const record = byHandle(ctx.doc.emis, ctx.handles, row);
  if (!record) throw emiNotFound(row);
  const { dueToSettle, newRemainingAsOf } = settleEmiPayment(toEmi(record, ctx.handles), amountPaid, ctx.today);
  validateEmiBalance(newRemainingAsOf);
  applyChanges(record, { remainingAsOf: money(newRemainingAsOf), asOfDate: storableDate(startOfDay(dueToSettle)) }, ctx);
  // Computed relative to the settled due date, as the store returns it.
  return emiWithComputed(toEmi(record, ctx.handles), dueToSettle);
}

export function deleteEmi(ctx: WriteContext, row: number): void {
  removeRecord(ctx, ctx.doc.emis, row, emiNotFound);
}

// --- subscriptions.ts -------------------------------------------------------

function toSubscription(r: SubscriptionRecord, handles: RowHandles): SubscriptionEntry {
  return {
    row: handles.rowFor(r.id),
    service: r.service,
    amount: Number(r.amount),
    duration: r.duration,
    expiryAnchor: r.expiryAnchor,
    cardOrBank: r.cardOrBank,
  };
}

export function listSubscriptions(ctx: ReadContext): SubscriptionEntryComputed[] {
  return ctx.doc.subscriptions.map((r) => subscriptionWithComputed(toSubscription(r, ctx.handles), ctx.today));
}

export interface SubscriptionInput {
  service: string;
  amount: number;
  duration: unknown;
  expiryAnchor: string;
  cardOrBank: string;
}

/** Trims and validates; returns the fields to store. */
function prepareSubscription(input: SubscriptionInput) {
  const service = input.service.trim();
  const cardOrBank = input.cardOrBank.trim();
  const { duration } = input;
  validateSubscription(service, input.amount, duration, input.expiryAnchor, cardOrBank);
  return {
    service: storedText(service),
    amount: money(input.amount),
    duration: duration === "Yearly" ? ("Yearly" as const) : ("Monthly" as const),
    expiryAnchor: input.expiryAnchor,
    cardOrBank: storedText(cardOrBank),
  };
}

export function addSubscription(ctx: WriteContext, input: SubscriptionInput): SubscriptionEntryComputed {
  const record: SubscriptionRecord = { ...newRecord(ctx), ...prepareSubscription(input) };
  ctx.doc.subscriptions.push(record);
  return subscriptionWithComputed(toSubscription(record, ctx.handles), ctx.today);
}

export function updateSubscription(ctx: WriteContext, row: number, input: SubscriptionInput): SubscriptionEntryComputed {
  const fields = prepareSubscription(input);
  if (!isPossibleId(row)) throw subscriptionNotFound(row);
  const record = byHandle(ctx.doc.subscriptions, ctx.handles, row);
  if (!record) throw subscriptionNotFound(row);
  applyChanges(record, fields, ctx);
  return subscriptionWithComputed(toSubscription(record, ctx.handles), ctx.today);
}

export function deleteSubscription(ctx: WriteContext, row: number): void {
  removeRecord(ctx, ctx.doc.subscriptions, row, subscriptionNotFound);
}

// --- overview.ts ------------------------------------------------------------

const UPCOMING_WINDOW_DAYS = 14;

function cardOutstanding(card: CardBill): number {
  return card.settled ? 0 : card.due - card.paid;
}

function nextMonthOf(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function previousMonthOf(year: number, month: number): { year: number; month: number } | null {
  if (year <= EARLIEST_YEAR && month <= 1) return null;
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/** dashboardOverview: only the enabled modules are read, a disabled one's
 * figure is null and its Upcoming items are left out. */
export function dashboardOverview(ctx: ReadContext, modules: readonly ModuleName[]): DashboardOverview {
  const on = new Set(modules);
  const day = startOfDay(ctx.today);
  const windowEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + UPCOMING_WINDOW_DAYS);
  const { year: nextYear, month: nextMonth } = nextMonthOf(day.getFullYear(), day.getMonth() + 1);
  const lastMonth = previousMonthOf(day.getFullYear(), day.getMonth() + 1);

  const debts = on.has("debts") ? listDebts(ctx) : null;
  const emis = on.has("emi") ? listEmis(ctx) : null;
  const subscriptions = on.has("subscriptions") ? listSubscriptions(ctx) : null;
  const financeRows = on.has("finances") ? financeSummary(ctx.doc, day.getFullYear(), day.getMonth() + 1) : null;
  const thisMonthBills = on.has("credit-cards") ? getMonthBills(ctx, day.getFullYear(), day.getMonth() + 1) : null;
  const nextMonthBills = on.has("credit-cards") ? getMonthBills(ctx, nextYear, nextMonth) : null;
  const lastMonthIncome = on.has("finances") && lastMonth ? getMonthIncome(ctx, lastMonth.year, lastMonth.month) : null;

  const currentSavings = financeRows ? (financeRows[financeRows.length - 1]?.currentSavings ?? 0) : null;
  const totalDebt = debts ? debts.reduce((sum, d) => sum + d.amount, 0) : null;
  const emiRemaining = emis ? emis.reduce((sum, e) => sum + e.remaining, 0) : null;
  const creditCardOutstanding = thisMonthBills
    ? Math.max(
        0,
        thisMonthBills.cards.reduce((sum, c) => sum + cardOutstanding(c), 0),
      )
    : null;
  const netWorth =
    currentSavings !== null && totalDebt !== null && emiRemaining !== null && creditCardOutstanding !== null
      ? currentSavings - totalDebt - emiRemaining - creditCardOutstanding
      : null;

  const emiFreeDate = (emis ?? []).reduce<string | null>(
    (latest, e) => (!e.isPaidOff && e.estimatedPayoffDate && (!latest || e.estimatedPayoffDate > latest) ? e.estimatedPayoffDate : latest),
    null,
  );

  const upcoming: UpcomingItem[] = [];
  if (lastMonth && lastMonthIncome?.salary === null && day.getDate() <= UPCOMING_WINDOW_DAYS) {
    upcoming.push({
      source: "Salary",
      name: `${MONTH_NAMES[lastMonth.month - 1]} ${lastMonth.year}`,
      amount: 0,
      dueDate: formatDate(makeDate(lastMonth.year, lastMonth.month, 1)),
    });
  }

  const cardBills = [thisMonthBills, nextMonthBills].filter((b) => b !== null);
  const cardBilledNames = new Set(cardBills.flatMap((b) => b.cards).map((c) => c.name));

  for (const emi of emis ?? []) {
    if (emi.isPaidOff || cardBilledNames.has(emi.cardOrBank)) continue;
    const asOf = parseDate(emi.asOfDate);
    const anchor = asOf > day ? asOf : day;
    const due = nextDueDateAfter(anchor, emi.dueDay);
    if (due <= windowEnd) {
      upcoming.push({ source: "EMI", name: emi.cardOrBank, amount: emi.emiAmount, dueDate: formatDate(due) });
    }
  }

  for (const sub of subscriptions ?? []) {
    const due = parseDate(sub.nextExpiry);
    if (due >= day && due <= windowEnd) {
      upcoming.push({ source: "Subscription", name: sub.service, amount: sub.amount, dueDate: sub.nextExpiry });
    }
  }

  for (const bills of cardBills) {
    for (const card of bills.cards) {
      const outstanding = cardOutstanding(card);
      if (outstanding <= 0 || !card.dueDate) continue;
      const due = parseDate(card.dueDate);
      if (due >= day && due <= windowEnd) {
        upcoming.push({ source: "Credit Card", name: card.name, amount: outstanding, dueDate: card.dueDate });
      }
    }
  }

  upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return {
    netWorth: { currentSavings, totalDebt, emiRemaining, creditCardOutstanding, netWorth },
    upcoming,
    emiFreeDate,
  };
}
