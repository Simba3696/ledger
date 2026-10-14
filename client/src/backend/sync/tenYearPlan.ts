import { todayInAppZone } from "@ledger/shared/today";
import { createEmptyDocument } from "../document/createDocument";
import { RowHandles } from "../document/handles";
import * as ops from "../document/operations";
import type { LedgerDocument } from "../document/types";
import { Rng } from "./rng";

// The 10-year household plan (design section 16.5, AC7 in section 15 item
// 14) and its quickest carrying out: a deterministic, seeded plan of a
// household's 10 years in the ledger (planLedger, planBurst) and the same
// writes applied in place to one document with no sync (runOnDocument).
// Pure: no test runner, no sync engine, no device store, no network, so the
// GitHub storage e2e can build its ten-year document in Node from this
// module alone. tenYearLedger.ts carries the plan out on real engines.
//
// Writes run operations.ts, the code DocumentBackend runs for each write.
// Fictional data only.

export const DAY = 24 * 60 * 60 * 1000;
export const MINUTE = 60 * 1000;
/** The plan's first day. The app's years start at 2018 (EARLIEST_YEAR). */
const START = Date.UTC(2018, 0, 1);

export type PlanKind =
  | "addExpense"
  | "editExpense"
  | "deleteExpense"
  | "moveExpense"
  | "income"
  | "billsDue"
  | "billsPaid"
  | "lock"
  | "addEmi"
  | "payEmi"
  | "deleteEmi"
  | "addDebt"
  | "updateDebt"
  | "deleteDebt"
  | "addSub"
  | "updateSub"
  | "deleteSub";

/** One write in the plan: when, on which device, and what. `key` names the
 * record across the plan (its id is only known once it is created). */
export interface PlanEvent {
  at: number;
  device: number;
  kind: PlanKind;
  key: string;
  /** "YYYY-MM": the month the write is in. */
  month: string;
  data: Record<string, unknown>;
}

/** The devices of the plan: two logins, three devices. */
export const PLAN_DEVICES = [
  { name: "alex-phone", login: "alex" },
  { name: "alex-laptop", login: "alex" },
  { name: "sam-phone", login: "sam" },
] as const;
const PHONE_A = 0;
const LAPTOP = 1;
export const PHONE_S = 2;

export interface PlanOptions {
  seed?: number;
  years?: number;
  expenses?: number;
  deletes?: number;
}

export interface Plan {
  events: PlanEvent[];
  counts: Record<PlanKind, number>;
  days: number;
  start: number;
}

const REMARKS: [string, string][] = [
  ["Groceries", "food"],
  ["Vegetables", "food"],
  ["Milk and bread", "food"],
  ["Coffee", "food"],
  ["Lunch", "food"],
  ["Dinner out", "food"],
  ["Snacks", "food"],
  ["Bakery", "food"],
  ["Fruit", "food"],
  ["Taxi", "transportation"],
  ["Bus pass", "transportation"],
  ["Fuel", "transportation"],
  ["Parking", "transportation"],
  ["Train ticket", "transportation"],
  ["Rent", "rent"],
  ["Maintenance", "rent"],
  ["Pharmacy", "other"],
  ["Doctor", "other"],
  ["Electricity bill", "other"],
  ["Water bill", "other"],
  ["Internet", "other"],
  ["Mobile recharge", "other"],
  ["Books", "other"],
  ["Stationery", "other"],
  ["Movie", "other"],
  ["Gift", "other"],
  ["Clothes", "other"],
  ["Haircut", "other"],
  ["Hardware store", "other"],
  ["Cleaning supplies", "other"],
  ["Pet food", "other"],
  ["Laundry", "other"],
  ["Repairs", "other"],
  ["Courier", "other"],
  ["Insurance", "other"],
  ["Donation", "other"],
];
const NOTES = [" - weekly", " (shared)", " for Alex", " for Sam", " at the market", " and tip"];
const AMOUNT_RANGE: Record<string, [number, number]> = { food: [40, 900], transportation: [20, 1500], rent: [12000, 22000], other: [50, 4000] };

function monthOf(at: number): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The last minute of `at`'s month, 23:00. */
function monthEnd(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - DAY + 23 * 60 * MINUTE;
}

function dayAt(start: number, day: number, hour: number, minute = 0): number {
  return start + day * DAY + hour * 60 * MINUTE + minute * MINUTE;
}

function money(rng: Rng, [lo, hi]: [number, number]): number {
  const value = lo + rng.next() * (hi - lo);
  return rng.chance(0.5) ? Math.round(value) : Math.round(value * 100) / 100;
}

/** A household's `years` years in the ledger: `expenses` expenses (about
 * 5% edited, 1% moved, `deletes` deleted, a fifth of edits and deletes
 * made on another device than the one that added it), a month's income and
 * savings, two cards' bills (entered, then paid), the month before locked,
 * six EMIs paid monthly, 40 debts and 12 subscriptions. Deterministic for
 * a seed. */
export function planLedger({ seed = 7, years = 10, expenses = 12_000, deletes = 300 }: PlanOptions = {}): Plan {
  const rng = new Rng(seed);
  const days = Math.round(years * 365.25);
  const end = START + days * DAY;
  const events: PlanEvent[] = [];
  const add = (at: number, device: number, kind: PlanKind, key: string, data: Record<string, unknown> = {}, month = monthOf(at)) => {
    if (at < end) events.push({ at, device, kind, key, month, data });
  };
  const otherPhone = (device: number) => (device === PHONE_A ? PHONE_S : PHONE_A);

  // Expenses: a weight per day (weekends busier), scaled to exactly
  // `expenses` in all.
  const weights = Array.from({ length: days }, (_, day) => {
    const weekday = new Date(START + day * DAY).getUTCDay();
    return (0.4 + rng.next() * 1.2) * (weekday === 0 || weekday === 6 ? 1.4 : 1);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const adds: { at: number; device: number; key: string }[] = [];
  let cumulative = 0;
  let placed = 0;
  for (let day = 0; day < days; day++) {
    cumulative += weights[day];
    const upTo = day === days - 1 ? expenses : Math.round((expenses * cumulative) / total);
    for (; placed < upTo; placed++) {
      const roll = rng.next();
      const device = roll < 0.5 ? PHONE_A : roll < 0.85 ? PHONE_S : LAPTOP;
      const at = dayAt(START, day, 8, rng.int(14 * 60));
      const [remarks, category] = rng.pick(REMARKS);
      const key = `e${placed}`;
      adds.push({ at, device, key });
      add(at, device, "addExpense", key, {
        amount: money(rng, AMOUNT_RANGE[category]),
        remarks: rng.chance(0.3) ? remarks + rng.pick(NOTES) : remarks,
        category,
        isCard: rng.chance(0.4),
      });
    }
  }
  // Disjoint sets of expenses to edit, delete and move, each in the month
  // it was added (a month is locked on the 10th of the next).
  const order = rng.shuffle(adds.map((_, i) => i));
  const edits = order.slice(0, Math.round(expenses * 0.05));
  const removed = order.slice(edits.length, edits.length + deletes);
  const moved = order.slice(edits.length + deletes, edits.length + deletes + Math.round(expenses * 0.01));
  const later = (from: number, maxDays: number) => Math.min(from + MINUTE + rng.int(maxDays * DAY), monthEnd(from));
  for (const i of edits) {
    const { at, device, key } = adds[i];
    const by = rng.chance(0.2) ? otherPhone(device) : device;
    const what = rng.next();
    add(later(at, 5), by, "editExpense", key, what < 0.6 ? { amountBy: 0.5 + rng.next() } : what < 0.9 ? { remarks: rng.pick(REMARKS)[0] } : { category: rng.pick(["food", "transportation", "other"]) }, monthOf(at));
  }
  for (const i of removed) {
    const { at, device, key } = adds[i];
    add(later(at, 3), rng.chance(0.2) ? otherPhone(device) : device, "deleteExpense", key, {}, monthOf(at));
  }
  for (const i of moved) {
    const { at, device, key } = adds[i];
    add(later(at, 2), device, "moveExpense", key, {}, monthOf(at));
  }

  // Each month: income and savings, two cards' bills, last month locked.
  const months = Math.round(years * 12);
  for (let m = 0; m < months; m++) {
    const first = Date.UTC(2018, m, 1);
    const day = Math.round((first - START) / DAY);
    const grown = Math.pow(1.03, m / 12);
    const savings = [
      { name: "Bank", amount: Math.round(20000 * grown + m * 900) },
      { name: "Mutual fund", amount: Math.round(10000 + m * 1500) },
      { name: "Gold", amount: Math.round(5000 + m * 200) },
    ];
    const income = { salary: Math.round(90000 * grown), otherIncome: rng.chance(0.3) ? money(rng, [500, 8000]) : null, savings };
    add(dayAt(START, day, 10, rng.int(120)), LAPTOP, "income", `fm${m}`, income);
    if (rng.chance(0.3)) add(dayAt(START, day + 14, 21, rng.int(60)), LAPTOP, "income", `fm${m}`, { ...income, otherIncome: money(rng, [500, 8000]) });
    const billsBy = rng.chance(0.7) ? LAPTOP : PHONE_A;
    const due = [money(rng, [2000, 40000]), money(rng, [500, 15000])];
    add(dayAt(START, day + 5, 20, rng.int(120)), billsBy, "billsDue", `cb${m}`, { due });
    add(dayAt(START, day + 18, 20, rng.int(120)), billsBy, "billsPaid", `cb${m}`, { due });
    if (m > 0) add(dayAt(START, day + 9, 22, rng.int(60)), LAPTOP, "lock", `lk${m - 1}`, {}, monthOf(Date.UTC(2018, m - 1, 1)));
  }

  // Six EMIs: added, paid each month on the due day, deleted once paid.
  const emis: [string, number, number, number][] = [
    ["Car Loan", 2, 60, 18000],
    ["Phone EMI", 18, 12, 4500],
    ["Laptop EMI", 37, 24, 6200],
    ["Home Loan", 53, 240, 42000],
    ["TV EMI", 82, 18, 3900],
    ["Bike Loan", 87, 36, 5600],
  ];
  emis.forEach(([name, startMonth, term, emiAmount], n) => {
    const key = `emi${n}`;
    const dueDay = 3 + n * 4;
    const startDay = Math.round((Date.UTC(2018, startMonth, 1) - START) / DAY);
    add(dayAt(START, startDay, 11), LAPTOP, "addEmi", key, { cardOrBank: name, emiAmount, dueDay, totalAmount: emiAmount * term, term });
    for (let k = 1; k <= term; k++) {
      const due = Date.UTC(2018, startMonth + k, dueDay);
      add(due + 9 * 60 * MINUTE + rng.int(120) * MINUTE, LAPTOP, "payEmi", key, { amount: emiAmount });
    }
    add(Date.UTC(2018, startMonth + term + 1, 2) + 12 * 60 * MINUTE, LAPTOP, "deleteEmi", key);
  });

  // Debts: added on a phone, updated once (part paid back), most settled.
  for (let n = 0; n < 40; n++) {
    const key = `debt${n}`;
    const at = START + rng.int(days - 10) * DAY + (9 + rng.int(12)) * 60 * MINUTE;
    const by = rng.chance(0.6) ? PHONE_A : PHONE_S;
    const name = `${rng.pick(["Lent to", "Borrowed from", "Trip split with", "Dinner split with"])} ${rng.pick(["Jordan", "Riley", "Casey", "Morgan", "Taylor"])}`;
    const amount = money(rng, [500, 20000]) * (name.startsWith("Lent") ? -1 : 1);
    add(at, by, "addDebt", key, { name, amount });
    add(at + (10 + rng.int(30)) * DAY, by, "updateDebt", key, { name, amount: Math.round(amount * 0.5) });
    if (rng.chance(0.75)) add(at + (40 + rng.int(90)) * DAY, by, "deleteDebt", key);
  }

  // Subscriptions: added over the years, repriced each year, a few dropped.
  const services = ["Music", "Video", "Cloud storage", "News", "Gym", "VPN", "Phone plan", "Password manager", "Language app", "Magazine", "Game pass", "Photo backup"];
  services.forEach((service, n) => {
    const key = `sub${n}`;
    const startDay = Math.round((n * days) / services.length / 1.5) + rng.int(60);
    const yearly = rng.chance(0.3);
    const anchor = new Date(START + (startDay + 20) * DAY).toISOString().slice(0, 10);
    const data = { service, amount: yearly ? money(rng, [1000, 5000]) : money(rng, [99, 999]), duration: yearly ? "Yearly" : "Monthly", expiryAnchor: anchor, cardOrBank: rng.pick(["Card A", "Card B"]) };
    add(dayAt(START, startDay, 19), LAPTOP, "addSub", key, data);
    const dropAt = rng.chance(0.35) ? startDay + 400 + rng.int(1500) : Infinity;
    for (let year = 1; startDay + year * 365 < Math.min(days, dropAt); year++) {
      add(dayAt(START, startDay + year * 365, 19), LAPTOP, "updateSub", key, { ...data, amount: Math.round(data.amount * Math.pow(1.08, year)) });
    }
    if (dropAt < days) add(dayAt(START, dropAt, 19), LAPTOP, "deleteSub", key);
  });

  events.sort((a, b) => a.at - b.at || a.device - b.device);
  const counts = Object.fromEntries(
    (["addExpense", "editExpense", "deleteExpense", "moveExpense", "income", "billsDue", "billsPaid", "lock", "addEmi", "payEmi", "deleteEmi", "addDebt", "updateDebt", "deleteDebt", "addSub", "updateSub", "deleteSub"] as const).map((kind) => [kind, 0]),
  ) as Record<PlanKind, number>;
  for (const event of events) counts[event.kind]++;
  return { events, counts, days, start: START };
}

// --- Carrying the plan out on one document ----------------------------------

/** Where a planned record lives once created: its id, its month, and the
 * device that made it. */
export interface Made {
  id: string;
  month: string;
  device: number;
}

function ymOf(month: string): [number, number] {
  const [y, m] = month.split("-").map(Number);
  return [y, m];
}

/** Runs one planned write on `ctx` (operations.ts, as DocumentBackend runs
 * it). Records it creates are entered in `made`. */
export function runEvent(event: PlanEvent, ctx: ops.WriteContext, made: Map<string, Made>, device: number): void {
  const [y, m] = ymOf(event.month);
  const d = event.data;
  const rowOf = (key: string) => ctx.handles.rowFor(made.get(key)!.id);
  const note = (row: number) => made.set(event.key, { id: ctx.handles.idFor(row)!, month: event.month, device });
  switch (event.kind) {
    case "addExpense":
      note(ops.appendEntry(ctx, y, m, d as unknown as ops.EntryInput).row);
      return;
    case "editExpense": {
      const id = made.get(event.key)!.id;
      const record = ctx.doc.expenses[event.month].find((r) => r.id === id)!;
      ops.updateEntry(ctx, y, m, rowOf(event.key), {
        amount: d.amountBy !== undefined ? Math.max(1, Math.round(Number(record.amount) * (d.amountBy as number))) : Number(record.amount),
        remarks: (d.remarks as string | undefined) ?? record.remarks,
        category: (d.category as string | undefined) ?? record.category,
        isCard: record.cardNote !== null,
      });
      return;
    }
    case "deleteExpense":
      ops.deleteEntry(ctx, y, m, rowOf(event.key));
      return;
    case "moveExpense": {
      const id = made.get(event.key)!.id;
      const target = ctx.doc.expenses[event.month].find((r) => r.id !== id);
      if (target) ops.moveEntry(ctx, y, m, rowOf(event.key), ctx.handles.rowFor(target.id));
      return;
    }
    case "income":
      ops.setMonthIncome(ctx, y, m, d as unknown as ops.IncomeInput);
      return;
    case "billsDue":
    case "billsPaid": {
      const due = d.due as number[];
      const paid = event.kind === "billsPaid";
      ops.setMonthBills(
        ctx,
        y,
        m,
        ["Card A", "Card B"].map((name, i) => ({ name, due: due[i], paid: paid ? due[i] : 0, dueDate: `${event.month}-${String(15 + i * 5)}`, settled: paid })),
      );
      return;
    }
    case "lock":
      ops.setMonthLocked(ctx, y, m, true);
      return;
    case "addEmi":
      note(
        ops.addEmi(ctx, {
          cardOrBank: d.cardOrBank as string,
          emiAmount: d.emiAmount as number,
          dueDay: d.dueDay as number,
          totalAmount: d.totalAmount as number,
          remarks: "",
          remainingAsOf: d.totalAmount as number,
          durationMonths: d.term as number,
          interestRate: 9.5,
          foreclosureCharge: null,
        }).row,
      );
      return;
    case "payEmi":
      ops.recordEmiPayment(ctx, rowOf(event.key), d.amount as number);
      return;
    case "deleteEmi":
      ops.deleteEmi(ctx, rowOf(event.key));
      return;
    case "addDebt":
      note(ops.addDebt(ctx, d as { name: string; amount: number }).row);
      return;
    case "updateDebt":
      ops.updateDebt(ctx, rowOf(event.key), d as { name: string; amount: number });
      return;
    case "deleteDebt":
      ops.deleteDebt(ctx, rowOf(event.key));
      return;
    case "addSub":
      note(ops.addSubscription(ctx, d as unknown as ops.SubscriptionInput).row);
      return;
    case "updateSub":
      ops.updateSubscription(ctx, rowOf(event.key), d as unknown as ops.SubscriptionInput);
      return;
    case "deleteSub":
      ops.deleteSubscription(ctx, rowOf(event.key));
      return;
  }
}

/** Whether `event` can run on `doc`: the record it names is there. */
export function holds(doc: LedgerDocument, event: PlanEvent, made: Map<string, Made>): boolean {
  const at = made.get(event.key);
  if (!at) return false;
  if (event.kind.endsWith("Expense")) return doc.expenses[at.month]?.some((r) => r.id === at.id) === true;
  const list = event.kind.endsWith("Debt") ? doc.debts : event.kind.endsWith("Emi") ? doc.emis : doc.subscriptions;
  return list.some((r) => r.id === at.id);
}

export const CREATES = new Set<PlanKind>(["addExpense", "addEmi", "addDebt", "addSub", "income", "billsDue", "billsPaid", "lock"]);

/** The context a write runs in, as DocumentBackend makes it: "today" is
 * worked out only if the write reads it. */
export function writeContext(doc: LedgerDocument, handles: RowHandles, now: number, actor: string, newId: () => string): ops.WriteContext {
  let today: Date | undefined;
  return {
    doc,
    handles,
    now,
    actor,
    newId,
    get today() {
      today ??= todayInAppZone(new Date(now), doc.settings.timeZone);
      return today;
    },
  };
}

/** The plan applied in place to one document, with no sync: a 10-year
 * document in a few seconds. */
export function runOnDocument(plan: Plan, seed = 7): LedgerDocument {
  const rng = new Rng(seed ^ 0x2545f491);
  const doc = createEmptyDocument({ modules: ["expenses", "finances", "debts", "emi", "credit-cards", "subscriptions"], timeZone: "UTC" });
  const handles = new RowHandles();
  const made = new Map<string, Made>();
  for (const event of plan.events) {
    if (!CREATES.has(event.kind) && !holds(doc, event, made)) continue;
    const login = PLAN_DEVICES[event.device].login;
    runEvent(event, writeContext(doc, handles, event.at, login, () => rng.uuid()), made, event.device);
  }
  doc.tombstones = [];
  return doc;
}

/** A month a device spends offline: `count` writes in `month`, four in
 * five adding expenses and the rest editing, deleting and moving its own
 * new ones, a debt, the month's income and its card bills. The "100
 * remote ops" another device joins at once (AC7). Its keys start with
 * `burst`, so it runs with a fresh `made` map. */
export function planBurst({ seed = 11, count = 100, device = PHONE_S, month, at }: { seed?: number; count?: number; device?: number; month: string; at: number }): PlanEvent[] {
  const rng = new Rng(seed);
  const events: PlanEvent[] = [];
  const push = (kind: PlanKind, key: string, data: Record<string, unknown> = {}) => events.push({ at: at + events.length * 10 * MINUTE, device, kind, key, month, data });
  let added = 0;
  while (events.length < count - 4) {
    const i = added++;
    const [remarks, category] = rng.pick(REMARKS);
    push("addExpense", `burst${i}`, { amount: money(rng, AMOUNT_RANGE[category]), remarks, category, isCard: rng.chance(0.4) });
    // Edits, deletes and moves of entries it made earlier in the month.
    if (i % 10 === 9 && events.length < count - 4) push("editExpense", `burst${i - 4}`, { amountBy: 1.1 });
    if (i % 13 === 12 && events.length < count - 4) push("deleteExpense", `burst${i - 1}`);
    if (i % 29 === 28 && events.length < count - 4) push("moveExpense", `burst${i - 5}`);
  }
  push("addDebt", "burstDebt", { name: "Dinner split with Riley", amount: 1200 });
  push("updateDebt", "burstDebt", { name: "Dinner split with Riley", amount: 600 });
  push("income", "burstIncome", { salary: 140000, otherIncome: 2500, savings: [{ name: "Bank", amount: 150000 }] });
  push("billsPaid", "burstBills", { due: [12000, 3400] });
  return events;
}
