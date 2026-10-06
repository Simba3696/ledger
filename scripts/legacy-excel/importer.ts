// One-time import of an Excel-edition data folder (the .xlsx workbooks and
// categories.json) into an empty hosted-edition database (LLD §8). Reads
// only with the legacy readers in this folder, so it sees exactly what the
// Excel edition showed; writes everything in one transaction. The CLI is
// scripts/import-xlsx.ts.
//
// Only inputs are imported. Everything the Excel edition computed on read
// (EMI remaining and payoff dates, subscription next expiry, finance series)
// is computed by the hosted edition on read too, from these (LLD §3).
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { assertMoney, isRealDate } from "../../server/src/store/validate.js";
import { setDbDir, usedDataRows } from "./workbookIO.js";
import {
  DEFAULT_CATEGORIES,
  deriveForegroundColor,
  hasCategoriesFile,
  loadCategoryConfig,
  type CategoryConfig,
} from "./categoryColors.js";
import { readYearForImport } from "./ledger.js";
import { listIncomeRows } from "./finances.js";
import { listDebts } from "./debts.js";
import { listEmis } from "./emi.js";
import { listSubscriptions } from "./subscriptions.js";
import { listBillsRows } from "./creditCardBills.js";

/** Every table the import writes, in write order (parents before children). */
export const IMPORT_TABLES = [
  "categories",
  "ledger_years",
  "expenses",
  "month_locks",
  "finance_months",
  "savings_balances",
  "debts",
  "emis",
  "subscriptions",
  "card_bills",
] as const;
export type ImportTable = (typeof IMPORT_TABLES)[number];

/** A problem the import found and refused to fix silently. */
export interface ImportIssue {
  /** Where: file, then sheet and row when there is one. */
  where: string;
  reason: string;
}

export interface ImportReport {
  /** Rows written (or, on a dry run, that would have been) per table. */
  counts: Record<ImportTable, number>;
  /** Rows (or parts of rows) not imported because a column would refuse them. */
  skipped: ImportIssue[];
  /** Non-empty rows the Excel edition didn't read either, so never showed. */
  ignored: ImportIssue[];
  /** Rows imported with a visible difference: no category, rounded to the column's precision, a derived colour. */
  changed: ImportIssue[];
  /** Files in the folder that aren't part of the Excel edition's data. */
  otherFiles: string[];
  /** Tables that had rows before the import (all replaced, with --force). */
  replaced: Partial<Record<ImportTable, number>>;
  dryRun: boolean;
}

/** A fatal error: the import stops and writes nothing. */
export class ImportError extends Error {}

export interface ImportOptions {
  /** The Excel-edition data folder. Only read, never written. */
  from: string;
  databaseUrl: string;
  /** Do everything inside a transaction, then roll it back. */
  dryRun?: boolean;
  /** Replace existing rows: truncate every import table first, in the same transaction. */
  force?: boolean;
}

// --- The rows to insert (column names as in supabase/migrations) ----------

interface CategoryRow { id: string; label: string; bg: string; fg: string | null; position: number }
interface ExpenseRow { year: number; month: number; position: number; amount: number; remarks: string; category_id: string | null; card_note: string | null }
interface MonthRow { year: number; month: number }
interface FinanceMonthRow { year: number; month: number; salary: number | null; other_income: number | null }
interface SavingsRow { year: number; month: number; position: number; name: string; amount: number }
interface DebtRow { name: string; amount: number }
interface EmiRow {
  card_or_bank: string; emi_amount: number; due_day: number; total_amount: number; remarks: string;
  remaining_as_of: number; as_of_date: string; until_target: string | null;
  interest_rate: number | null; foreclosure_charge: number | null;
}
interface SubscriptionRow { service: string; amount: number; duration: string; expiry_anchor: string; card_or_bank: string }
interface CardBillRow { year: number; month: number; position: number; name: string; due: number; paid: number; due_date: string | null; settled: boolean }

export interface ImportPlan {
  categories: CategoryRow[];
  ledger_years: Array<{ year: number }>;
  expenses: ExpenseRow[];
  month_locks: MonthRow[];
  finance_months: FinanceMonthRow[];
  savings_balances: SavingsRow[];
  debts: DebtRow[];
  emis: EmiRow[];
  subscriptions: SubscriptionRow[];
  card_bills: CardBillRow[];
}

// Matched ignoring case, as Windows (the Excel edition's platform) opened them.
const EXPENSES_FILE = /^Expenses \((\d{4})\)\.xlsx$/i;
const FLAT_FILES = ["Finances.xlsx", "Debts.xlsx", "EMI.xlsx", "Subscriptions.xlsx", "CreditCardBills.xlsx", "categories.json"];

/** The Excel edition's own name for a file of its data folder, or null. */
function canonicalName(name: string): string | null {
  const m = EXPENSES_FILE.exec(name);
  if (m) return `Expenses (${m[1]}).xlsx`;
  return FLAT_FILES.find((f) => f.toLowerCase() === name.toLowerCase()) ?? null;
}

/** The columns' own bounds (supabase/migrations): year >= 2018, int4. */
const EARLIEST_YEAR = 2018;
const LATEST_YEAR = 2147483647;
const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;

function isStorableYear(year: number): boolean {
  return Number.isInteger(year) && year >= EARLIEST_YEAR && year <= LATEST_YEAR;
}

function isMonth(month: number): boolean {
  return Number.isInteger(month) && month >= 1 && month <= 12;
}

/** Why a money value can't go in a numeric(14,2) column, or null. Uses the
 * store's own assertMoney, relabelled with the field. */
function moneyProblem(value: number, label: string, positive: boolean): string | null {
  try {
    assertMoney(value, { positive });
    return null;
  } catch (e) {
    return (e as Error).message.replace(/^Amount/, label);
  }
}

/** A note when a value has more decimals than its column keeps (Postgres
 * rounds on insert). Floating-point noise such as 0.1 + 0.2 isn't reported. */
function roundingNote(value: number, decimals: number, label: string): string | null {
  const scaled = Math.abs(value) * 10 ** decimals;
  if (Math.abs(scaled - Math.round(scaled)) < 1e-6) return null;
  return `${label} ${value} has more than ${decimals} decimal places; stored as ${roundAsPostgres(value, decimals)}`;
}

/** `value` rounded the way a numeric(p, decimals) column stores it:
 * postgres.js sends the number as String(value), and Postgres rounds that
 * decimal half away from zero. Rounding the float instead can differ
 * (1.005 * 100 is 100.49999999999999, but Postgres stores 1.01). */
function roundAsPostgres(value: number, decimals: number): number {
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(Math.abs(value)));
  if (!m) return value;
  const frac = m[2] ?? "";
  const digits = BigInt(m[1] + frac);
  const shift = Number(m[3] ?? 0) - frac.length + decimals; // value * 10^decimals = digits * 10^shift
  let units: bigint;
  if (shift >= 0) {
    units = digits * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    units = digits / divisor;
    if ((digits % divisor) * 2n >= divisor) units += 1n;
  }
  const text = units.toString().padStart(decimals + 1, "0");
  const rounded = Number(`${text.slice(0, text.length - decimals)}.${text.slice(text.length - decimals)}`);
  return value < 0 ? -rounded : rounded;
}

function hasNul(value: string): boolean {
  return value.includes("\u0000");
}

function isBlankCell(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

function at(file: string, sheet?: string, row?: number): string {
  return [file, sheet !== undefined ? `sheet "${sheet}"` : null, row !== undefined ? `row ${row}` : null].filter(Boolean).join(", ");
}

/** Reads and validates the whole folder without touching any database. */
export async function readSource(folder: string): Promise<{ plan: ImportPlan; report: Omit<ImportReport, "counts" | "replaced" | "dryRun"> }> {
  const dir = path.resolve(folder);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ImportError(`Not a folder: ${dir}`);
  setDbDir(dir);

  const skipped: ImportIssue[] = [];
  const ignored: ImportIssue[] = [];
  const changed: ImportIssue[] = [];
  const plan: ImportPlan = {
    categories: [], ledger_years: [], expenses: [], month_locks: [], finance_months: [],
    savings_balances: [], debts: [], emis: [], subscriptions: [], card_bills: [],
  };

  const names = fs.readdirSync(dir);
  // Excel keeps a "~$<name>" owner file next to a workbook it has open. Its
  // unsaved changes wouldn't be imported, so refuse until it's closed.
  const open = names.filter((n) => n.startsWith("~$") && canonicalName(n.slice(2)) !== null);
  if (open.length > 0) {
    throw new ImportError(
      `Excel has ${open.map((n) => n.slice(2)).join(", ")} open (${open.join(", ")} is in the folder). ` +
        "Close Excel first. If it isn't running, the lock file is left over from a crash: delete it.",
    );
  }
  // The legacy readers open each file by the Excel edition's own name. On a
  // case-insensitive file system (Windows, macOS) that finds "debts.xlsx"
  // too, as the Excel edition did; where it wouldn't, refuse rather than
  // leave the file out.
  const found = new Map<string, string>(); // canonical name -> name in the folder
  for (const n of names) {
    const canonical = canonicalName(n);
    if (canonical === null) continue;
    const other = found.get(canonical);
    if (other !== undefined) throw new ImportError(`${other} and ${n} differ only in case. Keep the one the Excel edition used and move the other out.`);
    if (n !== canonical && !fs.existsSync(path.join(dir, canonical))) {
      throw new ImportError(`Rename ${n} to ${canonical}: the import reads it under that name.`);
    }
    found.set(canonical, n);
  }
  const expenseYears = [...found.keys()]
    .map((n) => EXPENSES_FILE.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  const known = new Set(found.values());
  const otherFiles = names.filter((n) => !known.has(n) && !n.startsWith(".") && fs.statSync(path.join(dir, n)).isFile());
  if (known.size === 0) {
    throw new ImportError(
      `No Excel-edition files in ${dir}. Expected "Expenses (YYYY).xlsx", Finances.xlsx, Debts.xlsx, EMI.xlsx, ` +
        "Subscriptions.xlsx, CreditCardBills.xlsx or categories.json.",
    );
  }

  // Any read failure below (a corrupt workbook, a missing sheet, an invalid
  // categories.json) is fatal: importing the rest would silently leave a
  // whole section out.
  const fatal = (file: string) => (e: unknown): never => {
    throw new ImportError(`Could not read ${file}: ${(e as Error).message}`);
  };

  // categories.json (or the defaults), in file order.
  const legacyCategories = await loadCategoryConfig().catch(fatal("categories.json"));
  const rawCategories: unknown[] = hasCategoriesFile()
    ? (JSON.parse(fs.readFileSync(path.join(dir, "categories.json"), "utf8")) as unknown[])
    : DEFAULT_CATEGORIES;
  const imported = new Set<string>();
  rawCategories.forEach((raw, index) => {
    const where = `categories.json, entry ${index + 1}`;
    const e = raw as Partial<Record<keyof CategoryConfig, unknown>> | null;
    if (!e || typeof e.id !== "string" || typeof e.label !== "string" || typeof e.bg !== "string") {
      ignored.push({ where, reason: "needs a text id, label and bg" });
      return;
    }
    const { id, label, bg } = e as { id: string; label: string; bg: string };
    const problem =
      !id.trim() || hasNul(id)
        ? "the id is blank or has an invalid character"
        : imported.has(id)
          ? `a category with id "${id}" was already imported`
          : !label.trim() || hasNul(label)
            ? `"${id}": the label is blank or has an invalid character`
            : !HEX_COLOUR.test(bg)
              ? `"${id}": bg "${bg}" isn't a #RRGGBB colour`
              : null;
    if (problem) {
      skipped.push({ where, reason: problem });
      return;
    }
    let fg: string | null = typeof e.fg === "string" ? e.fg : null;
    if (fg !== null && !HEX_COLOUR.test(fg)) {
      changed.push({ where, reason: `"${id}": fg "${fg}" isn't a #RRGGBB colour; stored empty, so the text colour is derived from bg (${deriveForegroundColor(bg)})` });
      fg = null;
    }
    imported.add(id);
    plan.categories.push({ id, label, bg, fg, position: plan.categories.length });
  });

  // Expenses, one workbook per year.
  for (const year of expenseYears) {
    const file = `Expenses (${year}).xlsx`;
    const workbook = await readYearForImport(year, legacyCategories).catch(fatal(file));
    for (const name of workbook.otherSheets) ignored.push({ where: at(file, name), reason: "not a month sheet" });
    if (!isStorableYear(year)) {
      const entries = workbook.months.reduce((n, m) => n + m.entries.length, 0);
      skipped.push({ where: file, reason: `the whole workbook (${entries} ${entries === 1 ? "entry" : "entries"}): years before ${EARLIEST_YEAR} can't be stored` });
      continue;
    }
    plan.ledger_years.push({ year });
    for (const month of workbook.months) {
      if (month.locked) plan.month_locks.push({ year, month: month.month });
      let position = 0; // contiguous over the imported entries, in sheet order
      for (const r of month.ignoredRows) {
        ignored.push({ where: at(file, month.sheetName, r.row), reason: r.reason });
      }
      for (const entry of month.entries) {
        const where = at(file, month.sheetName, entry.row);
        const problem =
          moneyProblem(entry.amount, "Amount", true) ??
          (!entry.remarks.trim() ? "Remarks are blank" : null) ??
          (hasNul(entry.remarks) || (entry.cardNote !== null && hasNul(entry.cardNote)) ? "the text has an invalid character" : null);
        if (problem) {
          skipped.push({ where, reason: problem });
          continue;
        }
        const rounding = roundingNote(entry.amount, 2, "Amount");
        if (rounding) changed.push({ where, reason: rounding });
        let category = entry.category;
        if (category === null) {
          changed.push({
            where,
            reason: entry.fillArgb
              ? `fill colour ${entry.fillArgb} matches no category; imported without one`
              : "no fill colour; imported without a category",
          });
        } else if (!imported.has(category)) {
          changed.push({ where, reason: `its category "${category}" wasn't imported; imported without one` });
          category = null;
        }
        plan.expenses.push({
          year,
          month: month.month,
          position: position++,
          amount: entry.amount,
          remarks: entry.remarks,
          category_id: category,
          card_note: entry.cardNote,
        });
      }
    }
  }

  await readFinances(plan, skipped, ignored, changed);
  await readDebts(plan, skipped, ignored, changed);
  await readEmis(plan, skipped, ignored, changed);
  await readSubscriptions(plan, skipped, ignored, changed);
  await readCardBills(plan, skipped, ignored, changed);

  return { plan, report: { skipped, ignored, changed, otherFiles } };
}

type Issues = ImportIssue[];

/** Reports rows below the header that have content but that a reader didn't
 * return (it needs every required cell, of the right type). */
async function reportUnreadRows(file: string, sheet: string, returned: number[], ignored: Issues) {
  const used = await usedDataRows(file, sheet);
  const seen = new Set(returned);
  for (const row of used ?? []) {
    if (!seen.has(row)) ignored.push({ where: at(file, sheet, row), reason: "incomplete or of the wrong type" });
  }
}

async function readFinances(plan: ImportPlan, skipped: Issues, ignored: Issues, changed: Issues) {
  const file = "Finances.xlsx";
  const sheet = "Income";
  const result = await listIncomeRows().catch((e: unknown) => {
    throw new ImportError(`Could not read ${file}: ${(e as Error).message}`);
  });
  if (!result) return;
  for (const row of result.ignored) ignored.push({ where: at(file, sheet, row), reason: "the Year or Month isn't a number" });

  // getMonthIncome reads the first row for a month; a later duplicate is skipped.
  const firstRowFor = new Map<string, number>();
  for (const r of result.rows) {
    const where = at(file, sheet, r.row);
    if (!isStorableYear(r.year) || !isMonth(r.month)) {
      skipped.push({ where, reason: `${r.year}-${r.month} isn't a month from ${EARLIEST_YEAR} on` });
      continue;
    }
    const key = `${r.year}-${r.month}`;
    const first = firstRowFor.get(key);
    if (first !== undefined) {
      skipped.push({ where, reason: `another row (${first}) for ${key} is the one the Excel edition's month view showed` });
      continue;
    }
    // Recorded before the row is validated: if the first row is skipped, a
    // later one must not stand in for it, since the Excel edition never
    // showed that one.
    firstRowFor.set(key, r.row);
    const problem =
      (r.salary !== null ? moneyProblem(r.salary, "Salary", false) : null) ??
      (r.otherIncome !== null ? moneyProblem(r.otherIncome, "Other income", false) : null);
    if (problem) {
      skipped.push({ where, reason: problem });
      continue;
    }
    for (const [value, raw, label] of [
      [r.salary, r.rawSalary, "Salary"],
      [r.otherIncome, r.rawOtherIncome, "Other income"],
    ] as const) {
      if (value === null && !isBlankCell(raw)) changed.push({ where, reason: `${label} isn't a number; imported empty, as the Excel edition read it` });
      const note = value !== null ? roundingNote(value, 2, label) : null;
      if (note) changed.push({ where, reason: note });
    }
    plan.finance_months.push({ year: r.year, month: r.month, salary: r.salary, other_income: r.otherIncome });

    const droppedSavings = countDroppedSavings(r.rawSavings, r.savings.length);
    if (droppedSavings) changed.push({ where, reason: droppedSavings });
    let position = 0;
    for (const s of r.savings) {
      const bad =
        !s.name.trim() || hasNul(s.name)
          ? "a savings entry's name is blank or has an invalid character"
          : moneyProblem(s.amount, `Savings amount for "${s.name}"`, false);
      if (bad) {
        skipped.push({ where, reason: bad });
        continue;
      }
      const note = roundingNote(s.amount, 2, `Savings amount for "${s.name}"`);
      if (note) changed.push({ where, reason: note });
      plan.savings_balances.push({ year: r.year, month: r.month, position: position++, name: s.name, amount: s.amount });
    }
  }
}

/** parseSavingsCell drops a cell it can't parse, and entries without a text
 * name and a numeric amount; say so rather than lose them quietly. */
function countDroppedSavings(raw: unknown, kept: number): string | null {
  if (isBlankCell(raw) || typeof raw === "number") return null;
  if (typeof raw !== "string") return "the savings cell isn't text; imported no savings, as the Excel edition read it";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "the savings cell isn't valid JSON; imported no savings, as the Excel edition read it";
  }
  if (!Array.isArray(parsed)) return "the savings cell isn't a list; imported no savings, as the Excel edition read it";
  const dropped = parsed.length - kept;
  return dropped > 0 ? `${dropped} savings entr${dropped === 1 ? "y" : "ies"} without a name and amount not imported, as the Excel edition ignored them` : null;
}

async function readDebts(plan: ImportPlan, skipped: Issues, ignored: Issues, changed: Issues) {
  const file = "Debts.xlsx";
  const sheet = "Debts";
  const used = await usedDataRows(file, sheet).catch((e: unknown) => {
    throw new ImportError(`Could not read ${file}: ${(e as Error).message}`);
  });
  if (used === null) return;
  const debts = await listDebts();
  await reportUnreadRows(file, sheet, debts.map((d) => d.row), ignored);
  for (const d of debts) {
    const where = at(file, sheet, d.row);
    const problem = hasNul(d.name) ? "the name has an invalid character" : moneyProblem(d.amount, "Amount", false);
    if (problem) {
      skipped.push({ where, reason: problem });
      continue;
    }
    const note = roundingNote(d.amount, 2, "Amount");
    if (note) changed.push({ where, reason: note });
    plan.debts.push({ name: d.name, amount: d.amount });
  }
}

async function readEmis(plan: ImportPlan, skipped: Issues, ignored: Issues, changed: Issues) {
  const file = "EMI.xlsx";
  const sheet = "EMI";
  const used = await usedDataRows(file, sheet).catch((e: unknown) => {
    throw new ImportError(`Could not read ${file}: ${(e as Error).message}`);
  });
  if (used === null) return;
  // Only the stored columns are imported; listEmis's computed fields
  // (remaining, payoff dates, foreclosure payoff) are recomputed on read.
  const emis = await listEmis();
  await reportUnreadRows(file, sheet, emis.map((e) => e.row), ignored);
  for (const e of emis) {
    const where = at(file, sheet, e.row);
    const percent = (value: number | null, label: string) =>
      value !== null && !(Number.isFinite(value) && value >= 0 && value <= 100) ? `${label} must be between 0 and 100` : null;
    const problem =
      (hasNul(e.cardOrBank) || hasNul(e.remarks) ? "the text has an invalid character" : null) ??
      moneyProblem(e.emiAmount, "EMI Amount", true) ??
      (e.totalAmount < 0 ? "Total Amount is negative" : moneyProblem(e.totalAmount, "Total Amount", false)) ??
      (e.remainingAsOf < 0 ? "Remaining As Of is negative" : moneyProblem(e.remainingAsOf, "Remaining As Of", false)) ??
      (!Number.isInteger(e.dueDay) || e.dueDay < 1 || e.dueDay > 31 ? `Due Day ${e.dueDay} isn't a whole number from 1 to 31` : null) ??
      (!isRealDate(e.asOfDate) ? `As Of Date "${e.asOfDate}" isn't a real YYYY-MM-DD date` : null) ??
      (e.untilTarget !== null && !isRealDate(e.untilTarget) ? `Until Target "${e.untilTarget}" isn't a real YYYY-MM-DD date` : null) ??
      percent(e.interestRate, "Interest Rate") ??
      percent(e.foreclosureCharge, "Foreclosure Charge");
    if (problem) {
      skipped.push({ where, reason: problem });
      continue;
    }
    for (const note of [
      roundingNote(e.emiAmount, 2, "EMI Amount"),
      roundingNote(e.totalAmount, 2, "Total Amount"),
      roundingNote(e.remainingAsOf, 2, "Remaining As Of"),
      e.interestRate !== null ? roundingNote(e.interestRate, 3, "Interest Rate") : null,
      e.foreclosureCharge !== null ? roundingNote(e.foreclosureCharge, 3, "Foreclosure Charge") : null,
    ]) {
      if (note) changed.push({ where, reason: note });
    }
    plan.emis.push({
      card_or_bank: e.cardOrBank,
      emi_amount: e.emiAmount,
      due_day: e.dueDay,
      total_amount: e.totalAmount,
      remarks: e.remarks,
      remaining_as_of: e.remainingAsOf,
      as_of_date: e.asOfDate,
      until_target: e.untilTarget,
      interest_rate: e.interestRate,
      foreclosure_charge: e.foreclosureCharge,
    });
  }
}

async function readSubscriptions(plan: ImportPlan, skipped: Issues, ignored: Issues, changed: Issues) {
  const file = "Subscriptions.xlsx";
  const sheet = "Subscriptions";
  const used = await usedDataRows(file, sheet).catch((e: unknown) => {
    throw new ImportError(`Could not read ${file}: ${(e as Error).message}`);
  });
  if (used === null) return;
  // nextExpiry is computed on read; only the anchor is stored.
  const subscriptions = await listSubscriptions();
  await reportUnreadRows(file, sheet, subscriptions.map((s) => s.row), ignored);
  for (const s of subscriptions) {
    const where = at(file, sheet, s.row);
    const problem =
      (hasNul(s.service) || hasNul(s.cardOrBank) ? "the text has an invalid character" : null) ??
      moneyProblem(s.amount, "Amount", true) ??
      (!isRealDate(s.expiryAnchor) ? `Expiry "${s.expiryAnchor}" isn't a real YYYY-MM-DD date` : null);
    if (problem) {
      skipped.push({ where, reason: problem });
      continue;
    }
    const note = roundingNote(s.amount, 2, "Amount");
    if (note) changed.push({ where, reason: note });
    plan.subscriptions.push({
      service: s.service,
      amount: s.amount,
      duration: s.duration,
      expiry_anchor: s.expiryAnchor,
      card_or_bank: s.cardOrBank,
    });
  }
}

async function readCardBills(plan: ImportPlan, skipped: Issues, ignored: Issues, changed: Issues) {
  const file = "CreditCardBills.xlsx";
  const sheet = "Bills";
  const result = await listBillsRows().catch((e: unknown) => {
    throw new ImportError(`Could not read ${file}: ${(e as Error).message}`);
  });
  if (!result) return;
  for (const row of result.ignored) ignored.push({ where: at(file, sheet, row), reason: "the Year or Month isn't a number" });

  const firstRowFor = new Map<string, number>();
  for (const r of result.rows) {
    const where = at(file, sheet, r.row);
    if (!isStorableYear(r.year) || !isMonth(r.month)) {
      skipped.push({ where, reason: `${r.year}-${r.month} isn't a month from ${EARLIEST_YEAR} on` });
      continue;
    }
    const key = `${r.year}-${r.month}`;
    const first = firstRowFor.get(key);
    if (first !== undefined) {
      skipped.push({ where, reason: `another row (${first}) for ${key} is the one the Excel edition's month view showed` });
      continue;
    }
    firstRowFor.set(key, r.row);
    const dropped = countDroppedCards(r.rawCards, r.cards.length);
    if (dropped) changed.push({ where, reason: dropped });
    let position = 0;
    for (const c of r.cards) {
      const problem =
        (!c.name.trim() || hasNul(c.name) ? "a card's name is blank or has an invalid character" : null) ??
        moneyProblem(c.due, `Amount due for "${c.name}"`, false) ??
        moneyProblem(c.paid, `Amount paid for "${c.name}"`, false) ??
        (c.dueDate !== null && !isRealDate(c.dueDate) ? `Due date "${c.dueDate}" for "${c.name}" isn't a real YYYY-MM-DD date` : null);
      if (problem) {
        skipped.push({ where, reason: problem });
        continue;
      }
      for (const note of [roundingNote(c.due, 2, `Amount due for "${c.name}"`), roundingNote(c.paid, 2, `Amount paid for "${c.name}"`)]) {
        if (note) changed.push({ where, reason: note });
      }
      plan.card_bills.push({
        year: r.year,
        month: r.month,
        position: position++,
        name: c.name,
        due: c.due,
        paid: c.paid,
        due_date: c.dueDate,
        settled: c.settled,
      });
    }
  }
}

function countDroppedCards(raw: unknown, kept: number): string | null {
  if (isBlankCell(raw)) return null;
  if (typeof raw !== "string") return "the Cards cell isn't text; imported no cards, as the Excel edition read it";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "the Cards cell isn't valid JSON; imported no cards, as the Excel edition read it";
  }
  if (!Array.isArray(parsed)) return "the Cards cell isn't a list; imported no cards, as the Excel edition read it";
  const dropped = parsed.length - kept;
  return dropped > 0 ? `${dropped} card entr${dropped === 1 ? "y" : "ies"} without a name, due, paid and due date not imported, as the Excel edition ignored them` : null;
}

// --- Writing --------------------------------------------------------------

/** Thrown inside the transaction to roll a dry run back. */
class RollbackDryRun extends Error {}

/** Whether `categories` holds exactly the four defaults that seed.sql and
 * the app's first load create, which a fresh deployment always has. Those
 * don't count as existing data: the import replaces them without --force. */
function isDefaultCategories(rows: CategoryRow[]): boolean {
  return (
    rows.length === DEFAULT_CATEGORIES.length &&
    DEFAULT_CATEGORIES.every((d, i) => {
      const r = rows[i];
      return r.id === d.id && r.label === d.label && r.bg.toUpperCase() === d.bg.toUpperCase() && (r.fg ?? "").toLowerCase() === d.fg.toLowerCase() && r.position === i;
    })
  );
}

const INSERT_CHUNK = 1000;

/** Reads the folder, then writes it into the database in one transaction.
 * Throws ImportError (writing nothing) on anything fatal. */
export async function importXlsx(options: ImportOptions): Promise<ImportReport> {
  const { plan, report } = await readSource(options.from);
  const dryRun = options.dryRun === true;

  const sql = postgres(options.databaseUrl, { prepare: false, max: 1, onnotice: () => {} });
  const replaced: ImportReport["replaced"] = {};
  try {
    await sql.begin(async (tx) => {
      // A write from the app waits until the import commits or rolls back,
      // so the emptiness check below can't race one. That write is only
      // delayed, not refused: an app request mid-import that read the
      // categories table as empty inserts the defaults missing from the
      // import right after it commits. So the site must not be in use
      // during an import (DEPLOY.md, Moving from the Excel edition).
      await tx.unsafe(`lock table ${IMPORT_TABLES.join(", ")} in exclusive mode`);

      const existing: Partial<Record<ImportTable, number>> = {};
      for (const table of IMPORT_TABLES) {
        const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from ${tx(table)}`;
        if (n > 0) existing[table] = n;
      }
      if (existing.categories) {
        const rows = await tx<CategoryRow[]>`select id, label, bg, fg, position from categories order by position, id`;
        if (isDefaultCategories(rows)) delete existing.categories;
      }
      const tables = Object.keys(existing) as ImportTable[];
      if (tables.length > 0 && !options.force) {
        throw new ImportError(
          `The database already has data (${tables.map((t) => `${t}: ${existing[t]} rows`).join(", ")}). ` +
            "Importing would mix it with the folder's. Re-run with --force to delete every row in the import's tables first.",
        );
      }
      Object.assign(replaced, existing);

      // With --force, every import table is emptied first; otherwise only
      // the default categories (just checked) are there to replace. No
      // `cascade`: every table referencing these is in the list, and one a
      // later migration adds must make this fail rather than be emptied
      // without being listed in --help.
      if (options.force) {
        await tx.unsafe(`truncate ${IMPORT_TABLES.join(", ")} restart identity`);
      } else {
        await tx`delete from categories`;
      }

      for (const table of IMPORT_TABLES) {
        const rows = plan[table] as unknown as Record<string, unknown>[];
        if (rows.length === 0) continue;
        const columns = Object.keys(rows[0]);
        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
          const chunk = rows.slice(i, i + INSERT_CHUNK) as Record<string, postgres.ParameterOrJSON<never>>[];
          await tx`insert into ${tx(table)} ${tx(chunk, columns)}`;
        }
      }

      if (dryRun) throw new RollbackDryRun();
    });
  } catch (e) {
    if (!(e instanceof RollbackDryRun)) throw e;
  } finally {
    await sql.end({ timeout: 5 });
  }

  const counts = Object.fromEntries(IMPORT_TABLES.map((t) => [t, plan[t].length])) as Record<ImportTable, number>;
  return { ...report, counts, replaced, dryRun };
}

/** The report as printed by the CLI. */
export function formatReport(report: ImportReport): string {
  const lines: string[] = [];
  const width = Math.max(...IMPORT_TABLES.map((t) => t.length));
  lines.push(report.dryRun ? "Rows that would be imported (dry run):" : "Rows imported:");
  for (const table of IMPORT_TABLES) lines.push(`  ${table.padEnd(width)}  ${report.counts[table]}`);
  const replacedTables = Object.keys(report.replaced) as ImportTable[];
  if (replacedTables.length > 0) {
    lines.push("", `Replaced (--force deleted these rows first): ${replacedTables.map((t) => `${t} ${report.replaced[t]}`).join(", ")}`);
  }
  const section = (title: string, issues: ImportIssue[]) => {
    if (issues.length === 0) return;
    lines.push("", `${title} (${issues.length}):`);
    for (const i of issues) lines.push(`  ${i.where}: ${i.reason}`);
  };
  section("Skipped, not imported", report.skipped);
  section("Imported with a difference", report.changed);
  section("Not read by the Excel edition either, so not imported", report.ignored);
  if (report.otherFiles.length > 0) lines.push("", `Other files in the folder, not imported: ${report.otherFiles.join(", ")}`);
  lines.push("", report.dryRun ? "Dry run: everything was written inside a transaction and rolled back. Nothing was saved." : "Done: committed.");
  return lines.join("\n");
}
