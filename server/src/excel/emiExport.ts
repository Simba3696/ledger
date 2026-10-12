import ExcelJS from "exceljs";
import { LedgerError } from "./workbookIO.js";
import { addMonths, makeDate, parseDate, startOfDay } from "./dateMath.js";
import {
  computeOutstandingPrincipal,
  emiMonthlyProjection,
  listEmis,
  projectInstallments,
  type EmiEntryComputed,
  type EmiMonthlyProjection,
  type ProjectedInstallment,
} from "./emi.js";

/** Read-only export of every EMI plan, its month-by-month repayment schedule
 * and a cash-flow projection, for sharing outside the app (for example with
 * an AI assistant for a debt-repayment analysis). Never writes EMI.xlsx.
 * The input is exactly what the EMI tab and the Dashboard's Upcoming EMIs
 * chart show: `listEmis` and `emiMonthlyProjection("auto")`, either read
 * here (`buildEmiExport`) or fetched from a running app's API
 * (`buildEmiExportFrom`, used by scripts/export-emi.ts). The schedule comes
 * from `projectInstallments`, the chart's own per-loan simulation, and is
 * checked against the chart month by month.
 *
 * Fields the app doesn't store (EMI type, start date, original tenure) are
 * exported as null rather than guessed, and every field is tagged as stored,
 * calculated or not stored (FIELD_SOURCES). */

export interface EmiExportOptions {
  from: string; // YYYY-MM, first month of the schedule and cash flow
  to: string; // YYYY-MM, last month (inclusive)
  monthlySalary: number;
  essentialExpenses: number;
  /** EMI-obligation levels to report the first month below. The amount left
   * for EMIs after essentials (salary - expenses) is always reported too. */
  thresholds?: number[];
  today?: Date;
}

interface ExportedPlan {
  emi_id: string;
  lender: string;
  description: string;
  emi_type: null;
  original_amount: number;
  current_outstanding_principal: number;
  outstanding_principal_basis: "amortised at the stated interest rate" | "no interest rate on record: equals remaining scheduled payments";
  monthly_emi: number;
  interest_rate_pa: number | null;
  original_tenure_months: null;
  remaining_installments: number;
  emi_start_date: null;
  next_payment_date: string | null;
  final_emi_date: string | null;
  final_installment_amount: number | null;
  bank_stated_end_date: string | null;
  app_estimated_payoff_date: string | null;
  total_remaining_scheduled_payments: number;
  remaining_interest_payable: number | null;
  foreclosure_charge_pct: number | null;
  foreclosure_amount: number;
  status: "Active" | "Completed";
  due_day: number;
  balance_snapshot: number;
  balance_snapshot_date: string;
}

interface ScheduleMonth {
  month: string;
  active_emis: number;
  total_emi_payment: number;
  /** Installments that fell due earlier in the current month, before the
   * export date. The Upcoming EMIs chart leaves them out (they're already
   * paid); the cash flow counts them, since the month's salary covers them. */
  paid_earlier_this_month: number;
  contributions: Record<string, number>;
  emis_ending: string[];
  remaining_scheduled_payments_at_month_end: number;
  outstanding_principal_at_month_end: number;
}

interface CashFlowMonth {
  month: string;
  salary: number;
  essential_expenses: number;
  emi_obligations: number;
  surplus_or_deficit: number;
  cumulative_surplus_or_deficit: number;
  emi_to_income_ratio: number;
  active_emis: number;
}

interface ValidationCheck {
  check: string;
  passed: boolean;
  detail: string;
}

export interface EmiExport {
  generated_at: string;
  window: { from: string; to: string };
  assumptions: {
    monthly_salary: number;
    essential_expenses: number;
    available_for_emis: number;
    initial_savings: 0;
    note: string;
  };
  field_sources: Record<string, string>;
  plans: ExportedPlan[];
  schedule: ScheduleMonth[];
  cash_flow: CashFlowMonth[];
  summary: Record<string, string | number | null>;
  validation: ValidationCheck[];
  notes: string[];
}

const FIELD_SOURCES: Record<string, string> = {
  emi_id: "generated: anonymised reference, in the EMI tab's order",
  lender: "stored: Card/Bank (card or account numbers removed)",
  description: "stored: Remarks (card or account numbers, emails and phone numbers removed)",
  emi_type: "not stored: the app has no EMI type field",
  original_amount: "stored: Total Amount, the loan's original amount as entered (the app doesn't record whether it includes interest)",
  current_outstanding_principal: "calculated: the app's foreclosure maths (reducing-balance at the interest rate; equals remaining scheduled payments when no rate is on record)",
  monthly_emi: "stored: EMI Amount",
  interest_rate_pa: "stored: Interest Rate (%), when entered",
  original_tenure_months: "not stored: only the bank-stated end date is kept",
  remaining_installments: "calculated: installments in the generated schedule until the plan is paid off",
  emi_start_date: "not stored",
  next_payment_date: "calculated: first installment in the generated schedule",
  final_emi_date: "calculated: last installment in the generated schedule",
  bank_stated_end_date: "stored: Until Target (the bank's stated end, from the Duration entered)",
  app_estimated_payoff_date: "calculated: the EMI tab's payoff date (first due date on or after the bank-stated end)",
  total_remaining_scheduled_payments: "calculated: the snapshot balance less every installment due since the snapshot date",
  remaining_interest_payable: "calculated: remaining scheduled payments less outstanding principal; null without an interest rate",
  foreclosure_charge_pct: "stored: Foreclosure Charge (%), when entered",
  foreclosure_amount: "calculated: outstanding principal plus the foreclosure charge (the EMI tab's figure)",
  status: "calculated: Completed once nothing remains",
  balance_snapshot: "stored: Remaining As Of, the balance from a statement",
  balance_snapshot_date: "stored: As Of Date",
};

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_MONTHS = 600;
const SCHEDULE_HORIZON = "9999-12";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function monthOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthsBetween(from: string, to: string): string[] {
  const [fy, fm] = from.split("-").map(Number);
  const start = makeDate(fy, fm, 1);
  const months: string[] = [];
  for (let i = 0; i < MAX_MONTHS; i++) {
    const m = monthOf(addMonths(start, i));
    if (m > to) break;
    months.push(m);
  }
  return months;
}

/** Strips anything that could identify an account or a person from free
 * text: email addresses, masked card numbers ("XX1234", "**** 1234",
 * "ending 1234"), phone numbers and any run of 8+ digits (account or card
 * numbers). Ordinary short numbers (years, amounts) are kept. */
export function sanitizeText(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email removed]")
    .replace(/(?:[xX*•]{2,}[\s-]*)+\d{2,6}/g, "[card number removed]")
    .replace(/\b(ending|ends|last\s*4|a\/c|acct|account|card\s*no\.?)(\s*(in|with|no\.?|number|:|#))?\s*\d{4,}/gi, "$1 [number removed]")
    .replace(/(\+91[\s-]?)?\b[6-9]\d{9}\b/g, "[phone removed]")
    .replace(/\d(?:[\s-]?\d){7,}/g, "[number removed]");
}

function validateOptions(opts: EmiExportOptions) {
  if (!MONTH_KEY.test(opts.from) || !MONTH_KEY.test(opts.to)) {
    throw new LedgerError("from and to must be months in YYYY-MM form", 400);
  }
  if (opts.to < opts.from) throw new LedgerError("to must not be before from", 400);
  if (monthsBetween(opts.from, opts.to).length >= MAX_MONTHS) {
    throw new LedgerError(`The export window can't exceed ${MAX_MONTHS} months`, 400);
  }
  for (const [name, value] of [
    ["Monthly salary", opts.monthlySalary],
    ["Essential expenses", opts.essentialExpenses],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new LedgerError(`${name} must be zero or more`, 400);
  }
}

/** The installment each plan already paid earlier in the current month
 * (its due day this month falls on or before today). Assumes every plan
 * that's active, or that finished this month, had an installment due this
 * month, since the app stores no start date. */
function paidEarlierThisMonth(emi: EmiEntryComputed, today: Date): number {
  const day = startOfDay(today);
  const due = makeDate(day.getFullYear(), day.getMonth() + 1, emi.dueDay);
  if (due > day) return 0;
  const finishedThisMonth = emi.isPaidOff && parseDate(emi.asOfDate) >= due;
  if (emi.isPaidOff && !finishedThisMonth) return 0;
  return emi.emiAmount;
}

/** Builds the export from this app's own workbook. */
export async function buildEmiExport(opts: EmiExportOptions): Promise<EmiExport> {
  validateOptions(opts);
  const today = opts.today ?? new Date();
  const [emis, chart] = await Promise.all([listEmis(today), emiMonthlyProjection("auto", today)]);
  return buildEmiExportFrom(emis, chart, opts);
}

/** Builds the export from an EMI list and the Upcoming EMIs chart's "auto"
 * projection, both as of `opts.today` (for example `GET /api/emi` and
 * `GET /api/emi-monthly-projection?months=auto` from a running app). */
export function buildEmiExportFrom(
  emis: EmiEntryComputed[],
  chart: EmiMonthlyProjection[],
  opts: EmiExportOptions,
): EmiExport {
  validateOptions(opts);
  const today = opts.today ?? new Date();
  const currentMonth = monthOf(startOfDay(today));
  const months = monthsBetween(opts.from, opts.to);

  const ids = emis.map((_, i) => `EMI-${String(i + 1).padStart(2, "0")}`);
  const fullSchedules: ProjectedInstallment[][] = emis.map((e) => projectInstallments(e, SCHEDULE_HORIZON, today));

  const plans: ExportedPlan[] = emis.map((e, i) => {
    const schedule = fullSchedules[i];
    const principal = computeOutstandingPrincipal(e.remaining, e.emiAmount, e.interestRate);
    const last = schedule[schedule.length - 1];
    return {
      emi_id: ids[i],
      lender: sanitizeText(e.cardOrBank),
      description: sanitizeText(e.remarks),
      emi_type: null,
      original_amount: e.totalAmount,
      current_outstanding_principal: principal,
      outstanding_principal_basis:
        e.interestRate == null || e.interestRate === 0
          ? "no interest rate on record: equals remaining scheduled payments"
          : "amortised at the stated interest rate",
      monthly_emi: e.emiAmount,
      interest_rate_pa: e.interestRate,
      original_tenure_months: null,
      remaining_installments: schedule.length,
      emi_start_date: null,
      next_payment_date: schedule[0]?.date ?? null,
      final_emi_date: last?.date ?? null,
      final_installment_amount: last?.amount ?? null,
      bank_stated_end_date: e.untilTarget,
      app_estimated_payoff_date: e.estimatedPayoffDate,
      total_remaining_scheduled_payments: e.remaining,
      remaining_interest_payable:
        e.interestRate == null || e.interestRate === 0 ? null : round2(e.remaining - principal),
      foreclosure_charge_pct: e.foreclosureCharge,
      foreclosure_amount: e.foreclosurePayoff,
      status: e.isPaidOff ? "Completed" : "Active",
      due_day: e.dueDay,
      balance_snapshot: e.remainingAsOf,
      balance_snapshot_date: e.asOfDate,
    };
  });

  // Remaining scheduled payments for each plan at the end of a month: its
  // current balance until its first installment lands, then the balance
  // after its last installment on or before that month.
  function remainingAtMonthEnd(i: number, month: string): number {
    let remaining = emis[i].remaining;
    for (const inst of fullSchedules[i]) {
      if (inst.month > month) break;
      remaining = inst.remainingAfter;
    }
    return remaining;
  }

  const schedule: ScheduleMonth[] = months.map((month) => {
    const contributions: Record<string, number> = {};
    const ending: string[] = [];
    let total = 0;
    fullSchedules.forEach((installments, i) => {
      const inMonth = installments.filter((inst) => inst.month === month);
      if (!inMonth.length) return;
      const amount = round2(inMonth.reduce((s, inst) => s + inst.amount, 0));
      contributions[ids[i]] = amount;
      total = round2(total + amount);
      if (installments[installments.length - 1].month === month) ending.push(ids[i]);
    });
    const paidEarlier =
      month === currentMonth ? round2(emis.reduce((s, e) => s + paidEarlierThisMonth(e, today), 0)) : 0;
    let remainingTotal = 0;
    let principalTotal = 0;
    emis.forEach((e, i) => {
      const r = remainingAtMonthEnd(i, month);
      remainingTotal = round2(remainingTotal + r);
      principalTotal = round2(principalTotal + computeOutstandingPrincipal(r, e.emiAmount, e.interestRate));
    });
    return {
      month,
      active_emis: Object.keys(contributions).length,
      total_emi_payment: total,
      paid_earlier_this_month: paidEarlier,
      contributions,
      emis_ending: ending,
      remaining_scheduled_payments_at_month_end: remainingTotal,
      outstanding_principal_at_month_end: principalTotal,
    };
  });

  const salary = opts.monthlySalary;
  const expenses = opts.essentialExpenses;
  const available = round2(salary - expenses);
  let cumulative = 0;
  const cashFlow: CashFlowMonth[] = schedule.map((s) => {
    const obligations = round2(s.total_emi_payment + s.paid_earlier_this_month);
    const surplus = round2(salary - expenses - obligations);
    cumulative = round2(cumulative + surplus);
    const activeThisMonth =
      s.month === currentMonth
        ? emis.filter((e, i) => s.contributions[ids[i]] !== undefined || paidEarlierThisMonth(e, today) > 0).length
        : s.active_emis;
    return {
      month: s.month,
      salary,
      essential_expenses: expenses,
      emi_obligations: obligations,
      surplus_or_deficit: surplus,
      cumulative_surplus_or_deficit: cumulative,
      emi_to_income_ratio: salary > 0 ? Math.round((obligations / salary) * 10000) / 10000 : 0,
      active_emis: activeThisMonth,
    };
  });

  const thresholds = [available, ...(opts.thresholds ?? [35000, 25000])].filter(
    (t, i, all) => all.indexOf(t) === i,
  );
  const firstBelow = (limit: number) => cashFlow.find((c) => c.emi_obligations < limit)?.month ?? null;
  const worst = cashFlow.reduce<CashFlowMonth | null>(
    (min, c) => (min === null || c.cumulative_surplus_or_deficit < min.cumulative_surplus_or_deficit ? c : min),
    null,
  );
  const maxDeficit = worst && worst.cumulative_surplus_or_deficit < 0 ? worst.cumulative_surplus_or_deficit : 0;
  const finalDates = plans.map((p) => p.final_emi_date).filter((d): d is string => d !== null).sort();
  const debtFree = finalDates[finalDates.length - 1] ?? null;
  const totalRemaining = round2(emis.reduce((s, e) => s + e.remaining, 0));
  const inWindow = round2(schedule.reduce((s, m) => s + m.total_emi_payment, 0));

  const summary: Record<string, string | number | null> = {
    active_emis: plans.filter((p) => p.status === "Active").length,
    total_remaining_scheduled_payments: totalRemaining,
    total_remaining_scheduled_payments_in_window: inWindow,
    total_outstanding_principal: round2(plans.reduce((s, p) => s + p.current_outstanding_principal, 0)),
    total_monthly_emi_current: round2(emis.filter((e) => !e.isPaidOff).reduce((s, e) => s + e.emiAmount, 0)),
    ...Object.fromEntries(thresholds.map((t) => [`first_month_emis_below_${t}`, firstBelow(t)])),
    max_cumulative_deficit: maxDeficit,
    max_cumulative_deficit_month: maxDeficit < 0 ? worst!.month : null,
    funding_required_to_cover_worst_deficit: round2(-maxDeficit),
    months_in_deficit: cashFlow.filter((c) => c.surplus_or_deficit < 0).length,
    final_cumulative_surplus_or_deficit: cashFlow[cashFlow.length - 1]?.cumulative_surplus_or_deficit ?? 0,
    projected_debt_free_date: debtFree,
    projected_debt_free_month: debtFree ? debtFree.slice(0, 7) : null,
  };

  const validation = validate(emis, chart, plans, fullSchedules, schedule, opts, today);

  const notes = [
    "All figures are in INR.",
    "Remaining scheduled payments are EMI amount x installments left (they include interest still to be charged); outstanding principal is lower whenever an interest rate is on record.",
    "The cumulative surplus/deficit is a cash-flow projection starting from zero savings, not a bank balance. A negative figure is money that would have to be arranged; it isn't assumed to be available.",
    `For the current month (${currentMonth}), installments already due before the export date are in "paid_earlier_this_month" and counted in the cash flow, but not in "total_emi_payment", which matches the Upcoming EMIs chart.`,
    "Only EMI plans are exported. Credit-card bills and expense entries are not included, so a purchase later converted to an EMI isn't counted twice.",
    "Fields marked 'not stored' in field_sources are null: the app doesn't keep them, and nothing was estimated in their place.",
  ];

  return {
    generated_at: new Date().toISOString(),
    window: { from: opts.from, to: opts.to },
    assumptions: {
      monthly_salary: salary,
      essential_expenses: expenses,
      available_for_emis: available,
      initial_savings: 0,
      note: "Salary and expenses are held flat for every month of the window.",
    },
    field_sources: FIELD_SOURCES,
    plans,
    schedule,
    cash_flow: cashFlow,
    summary,
    validation,
    notes,
  };
}

function validate(
  emis: EmiEntryComputed[],
  chart: EmiMonthlyProjection[],
  plans: ExportedPlan[],
  fullSchedules: ProjectedInstallment[][],
  schedule: ScheduleMonth[],
  opts: EmiExportOptions,
  today: Date,
): ValidationCheck[] {
  const checks: ValidationCheck[] = [];

  const unreconciled = schedule.filter(
    (m) => round2(Object.values(m.contributions).reduce((s, v) => s + v, 0)) !== m.total_emi_payment,
  );
  checks.push({
    check: "Each month's total equals the sum of its individual EMI contributions",
    passed: unreconciled.length === 0,
    detail: unreconciled.length ? `Mismatched months: ${unreconciled.map((m) => m.month).join(", ")}` : `${schedule.length} months reconciled`,
  });

  const countMismatch = plans.filter((p, i) => p.remaining_installments !== fullSchedules[i].length);
  const sumMismatch = plans.filter(
    (p, i) => round2(fullSchedules[i].reduce((s, inst) => s + inst.amount, 0)) !== p.total_remaining_scheduled_payments,
  );
  checks.push({
    check: "Each plan's remaining installments and remaining payments match its generated schedule",
    passed: countMismatch.length === 0 && sumMismatch.length === 0,
    detail:
      countMismatch.length || sumMismatch.length
        ? `Count mismatches: ${countMismatch.map((p) => p.emi_id).join(", ") || "none"}; amount mismatches: ${sumMismatch.map((p) => p.emi_id).join(", ") || "none"}`
        : `${plans.length} plans checked`,
  });

  // The Upcoming EMIs chart's own figures, from its own function.
  const chartByMonth = new Map(chart.map((c) => [c.month, c]));
  const chartMismatch = schedule.filter((m) => {
    const c = chartByMonth.get(m.month);
    const chartTotal = c?.totalAmount ?? 0;
    const chartCount = c?.count ?? 0;
    return chartTotal !== m.total_emi_payment || chartCount !== m.active_emis;
  });
  checks.push({
    check: "The schedule matches the Dashboard's Upcoming EMIs chart month for month",
    passed: chartMismatch.length === 0,
    detail: chartMismatch.length ? `Differs in: ${chartMismatch.map((m) => m.month).join(", ")}` : "Every month matches",
  });

  const payoffMismatch = plans.filter(
    (p) => p.status === "Active" && p.app_estimated_payoff_date !== null && p.final_emi_date !== p.app_estimated_payoff_date,
  );
  checks.push({
    check: "Each plan's last scheduled installment falls on the EMI tab's payoff date",
    passed: payoffMismatch.length === 0,
    detail: payoffMismatch.length
      ? payoffMismatch
          .map((p) => `${p.emi_id}: schedule ends ${p.final_emi_date}, EMI tab says ${p.app_estimated_payoff_date}`)
          .join("; ")
      : "All payoff dates agree",
  });

  const unevenFinal = plans.filter(
    (p) => p.final_installment_amount !== null && p.final_installment_amount !== p.monthly_emi,
  );
  checks.push({
    check: "Plans whose final installment is smaller than their EMI (balance not a whole number of EMIs)",
    passed: true,
    detail: unevenFinal.length
      ? unevenFinal.map((p) => `${p.emi_id}: final ${p.final_installment_amount} vs EMI ${p.monthly_emi}`).join("; ")
      : "None",
  });

  const beyond = plans.filter((p) => p.final_emi_date !== null && p.final_emi_date.slice(0, 7) > opts.to);
  checks.push({
    check: "Plans that run past the end of the export window",
    passed: true,
    detail: beyond.length
      ? `${beyond.map((p) => `${p.emi_id} (until ${p.final_emi_date})`).join(", ")}: their later installments are in the totals of the plan list, not in the monthly schedule`
      : "None: every plan finishes inside the window",
  });

  const suspicious: string[] = [];
  emis.forEach((e, i) => {
    if (e.remainingAsOf > e.totalAmount) suspicious.push(`${plans[i].emi_id}: snapshot balance exceeds the original amount`);
    if (parseDate(e.asOfDate) > startOfDay(today)) suspicious.push(`${plans[i].emi_id}: snapshot date is in the future`);
    if (e.emiAmount > e.totalAmount) suspicious.push(`${plans[i].emi_id}: EMI exceeds the original amount`);
    if (!e.cardOrBank.trim()) suspicious.push(`${plans[i].emi_id}: no lender name`);
  });
  checks.push({
    check: "Records with missing or inconsistent values",
    passed: suspicious.length === 0,
    detail: suspicious.length ? suspicious.join("; ") : "None found",
  });

  const redacted = emis.filter(
    (e) => sanitizeText(e.cardOrBank) !== e.cardOrBank || sanitizeText(e.remarks) !== e.remarks,
  );
  checks.push({
    check: "Personal identifiers removed from lender names and descriptions",
    passed: true,
    detail: redacted.length
      ? `Redacted in: ${redacted.map((e) => plans[emis.indexOf(e)].emi_id).join(", ")}`
      : "Nothing needed removing",
  });

  return checks;
}

// --- Output formats ---

/** Quotes a CSV cell when needed, and defuses values a spreadsheet would
 * otherwise run as a formula. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = Array.isArray(value) ? value.join(" ") : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  return [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
}

const PLAN_COLUMNS: (keyof ExportedPlan)[] = [
  "emi_id",
  "lender",
  "description",
  "emi_type",
  "status",
  "original_amount",
  "current_outstanding_principal",
  "outstanding_principal_basis",
  "monthly_emi",
  "interest_rate_pa",
  "original_tenure_months",
  "remaining_installments",
  "emi_start_date",
  "next_payment_date",
  "final_emi_date",
  "final_installment_amount",
  "bank_stated_end_date",
  "app_estimated_payoff_date",
  "total_remaining_scheduled_payments",
  "remaining_interest_payable",
  "foreclosure_charge_pct",
  "foreclosure_amount",
  "due_day",
  "balance_snapshot",
  "balance_snapshot_date",
];

export function plansCsv(data: EmiExport): string {
  return toCsv(data.plans as unknown as Record<string, unknown>[], PLAN_COLUMNS);
}

export function monthlyCsv(data: EmiExport): string {
  const rows = data.schedule.map((s, i) => {
    const c = data.cash_flow[i];
    return {
      month: s.month,
      active_emis: c.active_emis,
      total_emi_payment: s.total_emi_payment,
      paid_earlier_this_month: s.paid_earlier_this_month,
      emi_obligations: c.emi_obligations,
      emis_ending: s.emis_ending,
      remaining_scheduled_payments_at_month_end: s.remaining_scheduled_payments_at_month_end,
      outstanding_principal_at_month_end: s.outstanding_principal_at_month_end,
      salary: c.salary,
      essential_expenses: c.essential_expenses,
      surplus_or_deficit: c.surplus_or_deficit,
      cumulative_surplus_or_deficit: c.cumulative_surplus_or_deficit,
      emi_to_income_ratio: c.emi_to_income_ratio,
    };
  });
  return toCsv(rows, Object.keys(rows[0] ?? { month: "" }));
}

export function exportJson(data: EmiExport): string {
  return JSON.stringify(data, null, 2) + "\n";
}

const INR = '[$₹-4009]#,##0.00';

function addTable(
  sheet: ExcelJS.Worksheet,
  columns: { header: string; key: string; width?: number; money?: boolean; pct?: boolean }[],
  rows: Record<string, unknown>[],
) {
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? Math.max(12, c.header.length + 2) }));
  for (const r of rows) {
    sheet.addRow(Object.fromEntries(columns.map((c) => [c.key, Array.isArray(r[c.key]) ? (r[c.key] as string[]).join(", ") : r[c.key] ?? null])));
  }
  columns.forEach((c, i) => {
    if (c.money) sheet.getColumn(i + 1).numFmt = INR;
    if (c.pct) sheet.getColumn(i + 1).numFmt = "0.0%";
  });
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

export async function exportXlsx(data: EmiExport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date(data.generated_at);

  addTable(
    wb.addWorksheet("EMI Overview"),
    [
      { header: "EMI ID", key: "emi_id", width: 9 },
      { header: "Lender", key: "lender", width: 22 },
      { header: "Description", key: "description", width: 30 },
      { header: "EMI type", key: "emi_type" },
      { header: "Status", key: "status" },
      { header: "Original amount", key: "original_amount", money: true, width: 16 },
      { header: "Outstanding principal", key: "current_outstanding_principal", money: true, width: 20 },
      { header: "Principal basis", key: "outstanding_principal_basis", width: 30 },
      { header: "Monthly EMI", key: "monthly_emi", money: true },
      { header: "Interest rate (% p.a.)", key: "interest_rate_pa" },
      { header: "Original tenure (months)", key: "original_tenure_months" },
      { header: "Remaining installments", key: "remaining_installments" },
      { header: "Start date", key: "emi_start_date" },
      { header: "Next payment", key: "next_payment_date" },
      { header: "Final EMI date", key: "final_emi_date" },
      { header: "Final installment", key: "final_installment_amount", money: true },
      { header: "Bank-stated end", key: "bank_stated_end_date" },
      { header: "EMI tab payoff date", key: "app_estimated_payoff_date" },
      { header: "Remaining scheduled payments", key: "total_remaining_scheduled_payments", money: true, width: 22 },
      { header: "Remaining interest", key: "remaining_interest_payable", money: true },
      { header: "Foreclosure charge (%)", key: "foreclosure_charge_pct" },
      { header: "Foreclosure amount", key: "foreclosure_amount", money: true },
      { header: "Due day", key: "due_day" },
      { header: "Balance snapshot", key: "balance_snapshot", money: true },
      { header: "Snapshot date", key: "balance_snapshot_date" },
    ],
    data.plans as unknown as Record<string, unknown>[],
  );

  const ids = data.plans.map((p) => p.emi_id);
  addTable(
    wb.addWorksheet("Monthly Repayment Schedule"),
    [
      { header: "Month", key: "month", width: 9 },
      { header: "Active EMIs", key: "active_emis" },
      { header: "Total EMI payment", key: "total_emi_payment", money: true, width: 18 },
      { header: "Paid earlier this month", key: "paid_earlier_this_month", money: true, width: 20 },
      { header: "EMIs ending", key: "emis_ending", width: 24 },
      { header: "Remaining scheduled payments (month end)", key: "remaining_scheduled_payments_at_month_end", money: true, width: 26 },
      { header: "Outstanding principal (month end)", key: "outstanding_principal_at_month_end", money: true, width: 24 },
      ...ids.map((id) => ({ header: id, key: id, money: true, width: 11 })),
    ],
    data.schedule.map((s) => ({ ...s, ...s.contributions })),
  );

  addTable(
    wb.addWorksheet("Cash Flow Projection"),
    [
      { header: "Month", key: "month", width: 9 },
      { header: "Salary", key: "salary", money: true },
      { header: "Essential expenses", key: "essential_expenses", money: true, width: 18 },
      { header: "EMI obligations", key: "emi_obligations", money: true, width: 16 },
      { header: "Surplus / deficit", key: "surplus_or_deficit", money: true, width: 16 },
      { header: "Cumulative surplus / deficit", key: "cumulative_surplus_or_deficit", money: true, width: 24 },
      { header: "EMI-to-income ratio", key: "emi_to_income_ratio", pct: true, width: 18 },
      { header: "Active EMIs", key: "active_emis" },
    ],
    data.cash_flow as unknown as Record<string, unknown>[],
  );

  const summary = wb.addWorksheet("Summary & Key Metrics");
  summary.columns = [
    { header: "Item", key: "item", width: 46 },
    { header: "Value", key: "value", width: 22 },
    { header: "Detail", key: "detail", width: 90 },
  ];
  summary.getRow(1).font = { bold: true };
  const section = (title: string) => {
    summary.addRow({});
    summary.addRow({ item: title }).font = { bold: true };
  };
  section("Assumptions");
  summary.addRow({ item: "Window", value: `${data.window.from} to ${data.window.to}` });
  summary.addRow({ item: "Monthly take-home salary", value: data.assumptions.monthly_salary });
  summary.addRow({ item: "Essential living expenses", value: data.assumptions.essential_expenses });
  summary.addRow({ item: "Available for EMIs", value: data.assumptions.available_for_emis });
  summary.addRow({ item: "Initial savings", value: 0, detail: data.assumptions.note });
  section("Key metrics");
  for (const [k, v] of Object.entries(data.summary)) summary.addRow({ item: k.replace(/_/g, " "), value: v });
  section("Validation");
  for (const v of data.validation) summary.addRow({ item: v.check, value: v.passed ? "OK" : "CHECK", detail: v.detail });
  section("Field sources");
  for (const [k, v] of Object.entries(data.field_sources)) summary.addRow({ item: k, detail: v });
  section("Notes");
  for (const n of data.notes) summary.addRow({ detail: n });
  summary.getColumn(3).alignment = { wrapText: true, vertical: "top" };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
