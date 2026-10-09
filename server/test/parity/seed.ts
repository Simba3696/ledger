// One backend-neutral fixture, and two ways to plant it: rows inserted into
// the local Postgres (as server/test/ledgerSeed.ts does) and a LedgerDocument
// built directly. Import-shaped data (an imported "CC (200)" card note, an
// uncategorised expense, a legacy row with no rate or settled flag) is
// planted the same way on both sides, so those store cases port too.
import { sql, resetTables } from "../dbHelpers.js";
import { DEFAULT_CATEGORIES } from "@ledger/shared/categoryColors";
import { toDecimalString } from "@ledger/shared/money";
import type { ModuleName } from "../../../client/src/api";
import { createEmptyDocument } from "../../../client/src/backend/document/createDocument";
import { sequentialKeys } from "../../../client/src/backend/document/sortKey";
import { monthKey, type LedgerDocument } from "../../../client/src/backend/document/types";

export const ALL_MODULES: ModuleName[] = ["expenses", "finances", "debts", "emi", "credit-cards", "subscriptions"];

export interface SeedEntry {
  amount: number;
  remarks: string;
  category: string | null;
  isCard?: boolean;
  /** Overrides the "CC" an isCard entry gets, e.g. an imported "CC (200)". */
  cardNote?: string;
}

interface SeedMonth {
  year: number;
  month: number;
  entries: SeedEntry[];
  locked?: boolean;
}

export interface SeedEmi {
  cardOrBank: string;
  emiAmount: number;
  dueDay: number;
  totalAmount: number;
  remarks?: string;
  remainingAsOf: number;
  asOfDate: string;
  untilTarget?: string | null;
  /** Left out = a legacy row written before the column existed (null). */
  interestRate?: number | null;
  foreclosureCharge?: number | null;
}

export interface SeedSubscription {
  service: string;
  amount: number;
  duration: "Monthly" | "Yearly";
  expiryAnchor: string;
  cardOrBank?: string;
}

interface SeedCard {
  name: string;
  due: number;
  paid: number;
  dueDate?: string | null;
  /** Left out = a legacy row from before the flag existed (false). */
  settled?: boolean;
}

export interface Fixture {
  /** ENABLED_MODULES / settings.modules. Left out = every module. */
  modules?: ModuleName[];
  /** The calendar day the clock starts on (YYYY-MM-DD, in TIME_ZONE). */
  today?: string;
  /** Left out = the 4 defaults, as a fresh database creates them. */
  categories?: { id: string; label: string; bg: string; fg: string | null }[];
  expenses?: SeedMonth[];
  locks?: { year: number; month: number }[];
  financeMonths?: { year: number; month: number; salary?: number | null; otherIncome?: number | null; savings?: { name: string; amount: number }[] }[];
  debts?: { name: string; amount: number }[];
  emis?: SeedEmi[];
  subscriptions?: SeedSubscription[];
  cardBills?: { year: number; month: number; cards: SeedCard[] }[];
}

/** The `row` each backend issued for a seeded record, by fixture position. */
export interface SeedIds {
  expenses: Map<string, number[]>;
  debts: number[];
  emis: number[];
  subscriptions: number[];
}

export function emptyIds(): SeedIds {
  return { expenses: new Map(), debts: [], emis: [], subscriptions: [] };
}

const TABLES = [
  "categories",
  "expenses",
  "month_locks",
  "ledger_years",
  "finance_months",
  "savings_balances",
  "debts",
  "emis",
  "subscriptions",
  "card_bills",
];

function cardNoteOf(e: SeedEntry): string | null {
  return e.cardNote ?? (e.isCard ? "CC" : null);
}

/** Empties every table, then inserts the fixture's rows. */
export async function seedSql(fixture: Fixture): Promise<SeedIds> {
  await resetTables(...TABLES);
  const ids = emptyIds();

  // Expenses need their categories (a foreign key); with none given, a
  // fixture without expenses leaves the table empty for the store's own
  // first-read defaults, which are the same 4.
  const categories =
    fixture.categories ?? (fixture.expenses?.length ? DEFAULT_CATEGORIES.map((c) => ({ ...c, fg: c.fg as string | null })) : []);
  for (const [position, c] of categories.entries()) {
    await sql`insert into categories (id, label, bg, fg, position) values (${c.id}, ${c.label}, ${c.bg}, ${c.fg}, ${position})`;
  }

  for (const m of fixture.expenses ?? []) {
    const monthIds: number[] = [];
    for (const [position, e] of m.entries.entries()) {
      const [{ id }] = await sql<{ id: number }[]>`
        insert into expenses (year, month, position, amount, remarks, category_id, card_note)
        values (${m.year}, ${m.month}, ${position}, ${e.amount}, ${e.remarks}, ${e.category}, ${cardNoteOf(e)})
        returning id`;
      monthIds.push(id);
    }
    ids.expenses.set(monthKey(m.year, m.month), monthIds);
    if (m.locked) await sql`insert into month_locks (year, month) values (${m.year}, ${m.month})`;
  }
  for (const l of fixture.locks ?? []) {
    await sql`insert into month_locks (year, month) values (${l.year}, ${l.month})`;
  }

  for (const f of fixture.financeMonths ?? []) {
    await sql`
      insert into finance_months (year, month, salary, other_income)
      values (${f.year}, ${f.month}, ${f.salary ?? null}, ${f.otherIncome ?? null})`;
    for (const [position, s] of (f.savings ?? []).entries()) {
      await sql`
        insert into savings_balances (year, month, position, name, amount)
        values (${f.year}, ${f.month}, ${position}, ${s.name}, ${s.amount})`;
    }
  }

  for (const d of fixture.debts ?? []) {
    const [{ id }] = await sql<{ id: number }[]>`insert into debts (name, amount) values (${d.name}, ${d.amount}) returning id`;
    ids.debts.push(id);
  }

  for (const e of fixture.emis ?? []) {
    const [{ id }] = await sql<{ id: number }[]>`
      insert into emis (card_or_bank, emi_amount, due_day, total_amount, remarks, remaining_as_of,
                        as_of_date, until_target, interest_rate, foreclosure_charge)
      values (${e.cardOrBank}, ${e.emiAmount}, ${e.dueDay}, ${e.totalAmount}, ${e.remarks ?? ""}, ${e.remainingAsOf},
              ${e.asOfDate}, ${e.untilTarget ?? null}, ${e.interestRate ?? null}, ${e.foreclosureCharge ?? null})
      returning id`;
    ids.emis.push(id);
  }

  for (const s of fixture.subscriptions ?? []) {
    const [{ id }] = await sql<{ id: number }[]>`
      insert into subscriptions (service, amount, duration, expiry_anchor, card_or_bank)
      values (${s.service}, ${s.amount}, ${s.duration}, ${s.expiryAnchor}, ${s.cardOrBank ?? "N/A"})
      returning id`;
    ids.subscriptions.push(id);
  }

  for (const b of fixture.cardBills ?? []) {
    for (const [position, c] of b.cards.entries()) {
      if (c.settled === undefined) {
        // Leaves `settled` to its column default, as a legacy row would.
        await sql`
          insert into card_bills (year, month, position, name, due, paid, due_date)
          values (${b.year}, ${b.month}, ${position}, ${c.name}, ${c.due}, ${c.paid}, ${c.dueDate ?? null})`;
      } else {
        await sql`
          insert into card_bills (year, month, position, name, due, paid, due_date, settled)
          values (${b.year}, ${b.month}, ${position}, ${c.name}, ${c.due}, ${c.paid}, ${c.dueDate ?? null}, ${c.settled})`;
      }
    }
  }
  return ids;
}

/** The same fixture as a document, with every module on (the harness
 * applies the fixture's modules once it has read the rows back) and records
 * stamped as if written by "seed" at time 0. */
export function seedDocument(fixture: Fixture, timeZone: string, newId: () => string): LedgerDocument {
  const doc = createEmptyDocument({ modules: ALL_MODULES, timeZone });
  const base = () => ({ id: newId(), updatedAt: 0, updatedBy: "seed" });
  const money = (value: number) => toDecimalString(value, 2);

  if (fixture.categories) {
    doc.categories = fixture.categories.map((c, position) => ({ ...c, position }));
  }
  for (const m of fixture.expenses ?? []) {
    const keys = sequentialKeys(m.entries.length);
    doc.expenses[monthKey(m.year, m.month)] = m.entries.map((e, i) => ({
      ...base(),
      sortKey: keys[i],
      amount: money(e.amount),
      remarks: e.remarks,
      category: e.category,
      cardNote: cardNoteOf(e),
    }));
    if (m.locked) doc.monthLocks[monthKey(m.year, m.month)] = true;
  }
  for (const l of fixture.locks ?? []) doc.monthLocks[monthKey(l.year, l.month)] = true;
  for (const f of fixture.financeMonths ?? []) {
    doc.financeMonths[monthKey(f.year, f.month)] = {
      salary: f.salary === undefined || f.salary === null ? null : money(f.salary),
      otherIncome: f.otherIncome === undefined || f.otherIncome === null ? null : money(f.otherIncome),
      savings: (f.savings ?? []).map((s) => ({ name: s.name, amount: money(s.amount) })),
    };
  }
  doc.debts = (fixture.debts ?? []).map((d) => ({ ...base(), name: d.name, amount: money(d.amount) }));
  doc.emis = (fixture.emis ?? []).map((e) => ({
    ...base(),
    cardOrBank: e.cardOrBank,
    emiAmount: money(e.emiAmount),
    dueDay: e.dueDay,
    totalAmount: money(e.totalAmount),
    remarks: e.remarks ?? "",
    remainingAsOf: money(e.remainingAsOf),
    asOfDate: e.asOfDate,
    untilTarget: e.untilTarget ?? null,
    interestRate: e.interestRate === undefined || e.interestRate === null ? null : toDecimalString(e.interestRate, 3),
    foreclosureCharge:
      e.foreclosureCharge === undefined || e.foreclosureCharge === null ? null : toDecimalString(e.foreclosureCharge, 3),
  }));
  doc.subscriptions = (fixture.subscriptions ?? []).map((s) => ({
    ...base(),
    service: s.service,
    amount: money(s.amount),
    duration: s.duration,
    expiryAnchor: s.expiryAnchor,
    cardOrBank: s.cardOrBank ?? "N/A",
  }));
  for (const b of fixture.cardBills ?? []) {
    doc.cardBills[monthKey(b.year, b.month)] = b.cards.map((c) => ({
      ...base(),
      name: c.name,
      due: money(c.due),
      paid: money(c.paid),
      dueDate: c.dueDate ?? null,
      settled: c.settled ?? false,
    }));
  }
  return doc;
}
