import { vi } from "vitest";
import { LedgerError } from "@ledger/shared/errors";
import { todayInAppZone } from "@ledger/shared/today";
import { RowHandles } from "../document/handles";
import * as ops from "../document/operations";
import type { LedgerDocument } from "../document/types";
import { device, expectConverged, quiesce, world, type Device, type World } from "./cycleTestkit";
import type { SyncEngine } from "./SyncEngine";
import { Replica, Rng, emptyDocument } from "./testkit";

// Test support for the performance run (design section 16.5, AC7 in section
// 15 item 14): a deterministic, seeded plan of a household's 10 years in the
// ledger, and two ways to carry it out.
//
//   - runOnEngines: three real SyncEngines (two phones and a laptop, two
//     logins) on the fake GitHub, each write committed through the engine
//     (diff, fence, op, device store), each session ending in a real sync
//     cycle, compaction at its default limits. The logs, snapshots and repo
//     history are the engine's own, not hand-made.
//   - runOnDocument: the same writes applied in place to one document, with
//     no sync at all: a quick 10-year document for the normal suite's
//     regression guard.
//
// Writes run operations.ts, the code DocumentBackend runs for each write,
// on a copy of the document. The engine run copies only the month a write
// touches instead of the whole document (DocumentBackend's structuredClone),
// which would cost tens of ms per write at 10 years and make the run take
// many minutes; the document the engine diffs is the one DocumentBackend
// would hand it. Fictional data only.

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
/** The plan's first day. The app's years start at 2018 (EARLIEST_YEAR). */
const START = Date.UTC(2018, 0, 1);

type PlanKind =
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

/** One device's writes between two sync cycles: writes less than 45
 * minutes apart. */
interface Session {
  device: number;
  events: PlanEvent[];
}

function sessionsOf(events: readonly PlanEvent[]): Session[] {
  const open = new Map<number, Session>();
  const sessions: Session[] = [];
  for (const event of events) {
    const current = open.get(event.device);
    if (current && event.at - current.events.at(-1)!.at < 45 * MINUTE) {
      current.events.push(event);
      continue;
    }
    const session = { device: event.device, events: [event] };
    open.set(event.device, session);
    sessions.push(session);
  }
  return sessions;
}

// --- Carrying the plan out ---------------------------------------------------

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
function runEvent(event: PlanEvent, ctx: ops.WriteContext, made: Map<string, Made>, device: number): void {
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
function holds(doc: LedgerDocument, event: PlanEvent, made: Map<string, Made>): boolean {
  const at = made.get(event.key);
  if (!at) return false;
  if (event.kind.endsWith("Expense")) return doc.expenses[at.month]?.some((r) => r.id === at.id) === true;
  const list = event.kind.endsWith("Debt") ? doc.debts : event.kind.endsWith("Emi") ? doc.emis : doc.subscriptions;
  return list.some((r) => r.id === at.id);
}

const CREATES = new Set<PlanKind>(["addExpense", "addEmi", "addDebt", "addSub", "income", "billsDue", "billsPaid", "lock"]);

/** The context a write runs in, as DocumentBackend makes it: "today" is
 * worked out only if the write reads it. */
function writeContext(doc: LedgerDocument, handles: RowHandles, now: number, actor: string, newId: () => string): ops.WriteContext {
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
  const doc = emptyDocument();
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

/** The document a write runs on: `current` with the parts a write changes
 * copied. Every expense month but `month` is shared with `current`, which
 * no write changes in place; DocumentBackend clones it all. */
function draftOf(current: LedgerDocument, month: string): LedgerDocument {
  const { expenses, ...rest } = current;
  const draft = structuredClone(rest) as Omit<LedgerDocument, "expenses">;
  const copied = { ...expenses };
  if (expenses[month]) copied[month] = structuredClone(expenses[month]);
  return { ...draft, expenses: copied };
}

/** Where planned writes commit: a login, row handles, and a commit of the
 * next document built from the current one. */
export interface Writer {
  login: string;
  handles: RowHandles;
  commit(build: (current: LedgerDocument) => LedgerDocument): Promise<void>;
}

/** An engine's write path, as SyncedHost gives it to DocumentBackend: a
 * turn, the current document at that turn, then commit. */
export function engineWriter(engine: SyncEngine, login: string): Writer {
  return {
    login,
    handles: new RowHandles(),
    async commit(build) {
      const turn = engine.beginWrite();
      try {
        await turn.ready;
        await turn.commit(build(engine.current()));
      } finally {
        turn.end();
      }
    },
  };
}

/** A Replica's write path (testkit.ts): the diff, the join and incremental
 * materialisation, with no device store or network. */
export function replicaWriter(replica: Replica): Writer {
  return {
    login: replica.actor,
    handles: new RowHandles(),
    async commit(build) {
      replica.commitNow(build(replica.doc));
    },
  };
}

/** Commits one planned write through `writer`, as `device`, at `now`.
 * Records it creates are entered in `made`. False when the app refused it
 * (a LedgerError). */
export async function writePlanned(writer: Writer, event: PlanEvent, made: Map<string, Made>, device: number, now: number, newId: () => string): Promise<boolean> {
  try {
    await writer.commit((current) => {
      const draft = draftOf(current, event.month);
      runEvent(event, writeContext(draft, writer.handles, now, writer.login, newId), made, device);
      return draft;
    });
    return true;
  } catch (err) {
    if (err instanceof LedgerError) return false;
    throw err;
  }
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

/** A request the engines sent, as the run counts it. */
interface RequestRecord {
  device: string;
  method: string;
  /** "ref", "listing" (the tree), "blob", "repo", "put:log", "put:snap",
   * "put:genesis" or "other". */
  kind: string;
  status: number;
  /** For a PUT: the file text's length in bytes. */
  bytes: number;
  /** The plan's clock when it was sent. */
  at: number;
}

/** Counts requests by kind and the most in flight at once. */
class RequestMeter {
  readonly records: RequestRecord[] = [];
  inFlight = 0;
  peak = 0;
  readonly #clock: () => number;

  constructor(clock: () => number) {
    this.#clock = clock;
  }

  wrap(device: () => string): (inner: typeof fetch) => typeof fetch {
    return (inner) => async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      this.inFlight++;
      this.peak = Math.max(this.peak, this.inFlight);
      try {
        const res = await inner(input, init);
        this.records.push({ device: device(), method, kind: kindOf(method, url), status: res.status, bytes: method === "PUT" ? putBytes(init?.body) : 0, at: this.#clock() });
        return res;
      } finally {
        this.inFlight--;
      }
    };
  }

  /** Requests since index `from`, counted by kind. */
  countsSince(from = 0): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const r of this.records.slice(from)) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    return counts;
  }
}

function kindOf(method: string, url: string): string {
  const path = url.replace(/^https:\/\/api\.github\.com/, "").split("?")[0];
  if (method === "PUT") return path.endsWith(".genesis.enc") ? "put:genesis" : path.endsWith(".snap.enc") ? "put:snap" : path.endsWith(".log.enc") ? "put:log" : "put:other";
  if (path.includes("/git/ref/")) return "ref";
  if (path.includes("/git/blobs/")) return "blob";
  if (path.includes("/git/trees/")) return "listing";
  if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return "repo";
  return "other";
}

/** The file text's length in a contents PUT body (base64 inside JSON). */
function putBytes(body: unknown): number {
  if (typeof body !== "string") return 0;
  const { content } = JSON.parse(body) as { content: string };
  const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
  return (content.length * 3) / 4 - padding;
}

export interface EngineRun {
  w: World;
  devices: Device[];
  writers: Writer[];
  meter: RequestMeter;
  plan: Plan;
  /** Writes each device committed, and writes refused (none expected). */
  writes: number[];
  refused: number;
  /** Writes moved to the device that made the record, because the planned
   * device didn't hold it yet. */
  rerouted: number;
  cycles: number;
  /** Real time the run took, and the part of it spent in writes and in
   * sync cycles, in ms. */
  elapsedMs: number;
  writeMs: number;
  syncMs: number;
  /** Commits more planned writes on `device`, without syncing. */
  write(device: number, events: readonly PlanEvent[]): Promise<void>;
  /** Restores the platform's randomness. */
  restore: () => void;
}

/** Replaces the platform's randomness with the seed's (device ids, writer
 * tokens, IVs), as harness.test.ts does: sizes and request counts repeat
 * from run to run. */
function seedCrypto(seed: number): () => void {
  const rng = new Rng(seed ^ 0x5bd1e995);
  const values = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
    if (array) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = rng.int(256);
    }
    return array;
  });
  const uuids = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => rng.uuid() as `${string}-${string}-${string}-${string}-${string}`);
  return () => {
    values.mockRestore();
    uuids.mockRestore();
  };
}

/** The plan carried out by three real engines on the fake GitHub. Each
 * session (a device's writes less than 45 minutes apart) starts with a
 * sync cycle (the app opening) and ends with one (the debounced push);
 * compaction runs at its default limits. The test must fake the timers
 * (setTimeout and setInterval), so the engines' own debounce and poll
 * timers never fire: every cycle is one the run starts. At the end every
 * device cycles until the repo is quiet, and all must show one document. */
export async function runOnEngines(plan: Plan, { seed = 7, onProgress }: { seed?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<EngineRun> {
  const restore = seedCrypto(seed);
  const began = performance.now();
  const clock = { wall: plan.start, mono: 1_000_000 };
  const w = await world({ fake: { now: () => clock.wall } });
  // One clock for the engines, the fake and the run.
  w.clock = clock;
  const meter = new RequestMeter(() => clock.wall);
  const devices: Device[] = [];
  for (const { login } of PLAN_DEVICES) {
    const index = devices.length;
    devices.push(await device(w, { login, wrapFetch: meter.wrap(() => devices[index]?.engine.deviceId ?? "new") }));
  }
  const writers = devices.map((d) => engineWriter(d.engine, d.login));
  const rng = new Rng(seed ^ 0x2545f491);
  const newId = () => rng.uuid();
  const made = new Map<string, Made>();
  const writes = devices.map(() => 0);
  let refused = 0;
  let rerouted = 0;
  let cycles = 0;
  let writeMs = 0;
  let syncMs = 0;
  const at = (time: number) => {
    clock.wall = time;
    clock.mono = Math.max(clock.mono + 1, time - plan.start + 1_000_000);
  };
  const sync = async (d: Device) => {
    const t = performance.now();
    await d.engine.sync();
    syncMs += performance.now() - t;
    cycles++;
  };
  const write = async (on: number, event: PlanEvent) => {
    const t = performance.now();
    if (await writePlanned(writers[on], event, made, on, clock.wall, newId)) writes[on]++;
    else refused++;
    writeMs += performance.now() - t;
  };

  const sessions = sessionsOf(plan.events);
  let done = 0;
  for (const session of sessions) {
    at(session.events[0].at);
    const d = devices[session.device];
    await sync(d);
    let last = session.events[0].at;
    for (const [i, event] of session.events.entries()) {
      // A write takes a person at least 20 s.
      last = Math.max(event.at, last + (i === 0 ? 0 : 20_000));
      at(last);
      let on = session.device;
      if (!CREATES.has(event.kind) && !holds(devices[on].engine.current(), event, made)) {
        on = made.get(event.key)!.device;
        rerouted++;
        if (!holds(devices[on].engine.current(), event, made)) throw new Error(`plan event ${event.kind} ${event.key}: no device holds the record`);
      }
      await write(on, event);
      // A write that went to the record's own device is pushed from there.
      if (on !== session.device) await sync(devices[on]);
    }
    // The debounced push, 2 s after the last write.
    at(last + 2000);
    await sync(d);
    // Keep memory flat: the fake's and the stores' request and mutation
    // logs hold every body sent.
    (w.fake.requests as unknown[]).length = 0;
    for (const dev of devices) dev.store.mutations.length = 0;
    onProgress?.(++done, sessions.length);
  }
  at(plan.start + plan.days * DAY);
  await quiesce(w, ...devices);
  expectConverged(...devices);
  const burstMade = new Map<string, Made>();
  return {
    w,
    devices,
    writers,
    meter,
    plan,
    writes,
    refused,
    rerouted,
    cycles,
    elapsedMs: performance.now() - began,
    writeMs,
    syncMs,
    async write(on, events) {
      for (const event of events) {
        at(Math.max(clock.wall + 20_000, event.at));
        if (!(await writePlanned(writers[on], event, burstMade, on, clock.wall, newId))) throw new Error(`plan event ${event.kind} ${event.key} was refused`);
      }
    },
    restore,
  };
}

// --- Timing ------------------------------------------------------------------

export interface Timing {
  runs: number;
  median: number;
  p95: number;
  min: number;
  max: number;
}

/** Times `run` `runs` times after `warmup` untimed runs; `prepare` runs
 * before each, untimed. Milliseconds. */
export function time<T>(run: (input: T) => unknown, { runs = 50, warmup = 5, prepare }: { runs?: number; warmup?: number; prepare?: () => T } = {}): Timing {
  const samples: number[] = [];
  for (let i = 0; i < warmup + runs; i++) {
    const input = prepare ? prepare() : (undefined as T);
    const t = performance.now();
    run(input);
    const ms = performance.now() - t;
    if (i >= warmup) samples.push(ms);
  }
  return summarize(samples);
}

/** The same for an async `run`. */
export async function timeAsync<T>(run: (input: T) => Promise<unknown>, { runs = 20, warmup = 2, prepare }: { runs?: number; warmup?: number; prepare?: () => Promise<T> | T } = {}): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < warmup + runs; i++) {
    const input = prepare ? await prepare() : (undefined as T);
    const t = performance.now();
    await run(input);
    const ms = performance.now() - t;
    if (i >= warmup) samples.push(ms);
  }
  return summarize(samples);
}

function summarize(samples: number[]): Timing {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const round = (ms: number) => Math.round(ms * 100) / 100;
  return { runs: sorted.length, median: round(at(0.5)), p95: round(at(0.95)), min: round(sorted[0]), max: round(sorted.at(-1)!) };
}
