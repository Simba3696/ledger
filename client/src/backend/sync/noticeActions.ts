import { LedgerError } from "@ledger/shared/errors";
import { todayInAppZone } from "@ledger/shared/today";
import type { ModuleName } from "../../api";
import { ApiError } from "../ApiError";
import { RowHandles } from "../document/handles";
import { recordEmiPayment } from "../document/operations";
import { keyBetween } from "../document/sortKey";
import type { ExpenseRecord, LedgerDocument } from "../document/types";
import { sameValue } from "./canonical";
import { COLLECTIONS, CREATE, FIELDS, parseRecordKey, parseRegisterKey, type Coll } from "./keys";
import type { StoredNotice } from "./notices";
import type { SyncState } from "./state";
import type { Tag } from "./tags";

// What a notice offers (design section 4.1). Each action is a new write,
// worked out from the current document when it is clicked, never an answer
// stored to be applied later (the old B4 class). The same plan gives the
// preview a button shows, so the button names the exact values it will
// write. A plan refuses on a locked month, a module that is off, and a
// record that is deleted or not in the ledger ("Add it back" is the one
// action for a deleted record).
//
//   - Use mine: sets each register the notice names back to this device's
//     value (section 4.1). A month lock is the one register a locked month
//     doesn't refuse: it is the lock. It never overwrites a value that
//     changed again after the notice (owner decision D30): when a register
//     it names is now tagged neither with the notice's winning write nor
//     with one of this device's own, it refuses ("changedSince") and the
//     preview carries the values as they are now.
//   - Add it back as a new entry: a new record, with a new id, in the same
//     month (or list), from the dead record's registers as they are now; an
//     expense gets a fresh sortKey at the end of its month, and a list
//     record lists last (its order key comes from the write's own L). It is
//     causally after the delete, so only a new delete removes it. Its op
//     names the dead record in `ab` (state.ts), and once the state holds
//     that, every device's Add it back for the record refuses: it is back.
//   - Record again: payEmi again on the EMI as it is now, for its EMI
//     amount (the amount the losing payment used isn't kept anywhere).

export type NoticeActionKind = "useMine" | "addBack" | "recordAgain";

/** Why an action can't run now. */
export type Refusal =
  /** The record was deleted. */
  | "deleted"
  /** The record isn't in the ledger. */
  | "missing"
  /** The month is locked. */
  | "locked"
  /** The module is turned off. */
  | "moduleOff"
  /** The ledger already holds what it would write. */
  | "inEffect"
  /** What it would overwrite changed again since the notice (D30), or no
   * longer matches what the button showed. */
  | "changedSince"
  /** "Add it back": the record is in the ledger, not deleted. */
  | "notDeleted"
  /** The ledger's checks refuse it (`detail` says why). */
  | "invalid";

/** An action as a button shows it: what it writes, register by register
 * (exact values; "Add it back" names the dead record's registers it copies
 * into a new one), or why it can't run now. */
export interface ActionPreview {
  kind: NoticeActionKind;
  writes: { key: string; value: unknown }[];
  /** "Record again": the amount it pays. */
  paid?: string;
  refused: { reason: Refusal; detail?: string } | null;
  /** Refused "changedSince" (D30): each register that changed again, with
   * its value now, so the list can say why. */
  current?: { key: string; value: unknown }[];
}

/** The clock, login and id source a write uses, and this device's id
 * (whose own writes Use mine may replace, D30). */
export interface ActionEnv {
  now: number;
  actor: string;
  newId: () => string;
  device: string;
}

const MODULE_OF: Record<Coll | "fm" | "cb" | "lk", ModuleName> = {
  e: "expenses",
  debt: "debts",
  emi: "emi",
  sub: "subscriptions",
  fm: "finances",
  cb: "credit-cards",
  lk: "expenses",
};

const PAIR = "remainingAsOf";

/** The actions a notice offers, in the order a list shows them. */
export function actionsFor(notice: StoredNotice): NoticeActionKind[] {
  if (notice.kind === "deleted") return ["addBack"];
  if (notice.kind !== "overwrite") return [];
  // A payment or balance edit that lost (an EMI's balance pair): another
  // payment, or this device's balance back.
  const pair = notice.registers.some((r) => r.key.startsWith("emi/") && r.key.endsWith(`/${PAIR}`));
  return pair ? ["recordAgain", "useMine"] : ["useMine"];
}

type AnyRecord = { id: string; updatedAt: number; updatedBy: string } & Record<string, unknown>;

type Plan = { refused: { reason: Refusal; detail?: string }; current?: { key: string; value: unknown }[] } | { refused: null; writes: { key: string; value: unknown }[]; paid?: string; apply: (doc: LedgerDocument) => void };

const refuse = (reason: Refusal, detail?: string): Plan => ({ refused: detail === undefined ? { reason } : { reason, detail } });

/** What a button showed: the writes (and the amount) its action previewed.
 * An action given one runs only if it would still write exactly that. */
export type ShownAction = Pick<ActionPreview, "writes" | "paid">;

/** The refusal for an action whose plan no longer matches its button: the
 * document or the day changed since the list was worked out. */
export class ShownChanged extends ApiError {
  constructor() {
    super(409, "That changed since it was shown, so nothing was written. Check what the button says now.");
    this.name = "ShownChanged";
  }
}

/** "Today" in the document's zone, or UTC when this runtime's Intl doesn't
 * know it (as DocumentBackend works it out). */
function todayOf(now: number, timeZone: string): Date {
  try {
    return todayInAppZone(new Date(now), timeZone);
  } catch (err) {
    if (err instanceof RangeError) return todayInAppZone(new Date(now), "UTC");
    throw err;
  }
}

/** The day "today" is for an action's plan, as text: a preview that
 * depends on it (Record again) is worked out again when it changes. */
export function actionDay(now: number, timeZone: string): string {
  return todayOf(now, timeZone).toISOString().slice(0, 10);
}

/** The month an expense was created in, from its `_c` register. */
function monthOf(state: SyncState, rk: string): string | null {
  const create = state.rec.get(rk)?.get(CREATE)?.v as { m?: unknown } | undefined;
  return typeof create?.m === "string" ? create.m : null;
}

/** The record `rk` names in `doc` (and its month, for an expense), if it is
 * visible there; `tag` reads each of its registers' tags from `state`. */
function findRecord(doc: LedgerDocument, state: SyncState, rk: string): { record: AnyRecord; month: string | null; tag: (field: string) => Tag | undefined } | null {
  const { coll, id } = parseRecordKey(rk)!;
  const tag = (field: string) => state.rec.get(rk)?.get(field)?.t;
  if (coll === "e") {
    const month = monthOf(state, rk);
    const record = month === null ? undefined : doc.expenses[month]?.find((r) => r.id === id);
    return record ? { record: record as unknown as AnyRecord, month, tag } : null;
  }
  const record = (doc[COLLECTIONS[coll]] as unknown as AnyRecord[]).find((r) => r.id === id);
  return record ? { record, month: null, tag } : null;
}

/** Why `rk` can't be written now, if it can't: deleted, not in the ledger,
 * its module off, or its month locked. */
function recordRefusal(doc: LedgerDocument, state: SyncState, rk: string): Plan | null {
  const { coll } = parseRecordKey(rk)!;
  if (state.del.has(rk)) return refuse("deleted");
  const found = findRecord(doc, state, rk);
  if (!found) return refuse("missing");
  if (!doc.settings.modules.includes(MODULE_OF[coll])) return refuse("moduleOff");
  if (found.month !== null && doc.monthLocks[found.month] === true) return refuse("locked");
  return null;
}

/** A month unit's or setting's value as the document holds it, and its
 * register's tag in `state`. */
function unitValue(doc: LedgerDocument, state: SyncState, key: string): { value: unknown; tag: Tag | undefined } {
  const parsed = parseRegisterKey(key);
  const tag = state.unit.get(key)?.t;
  if (parsed?.kind === "setting") return { value: doc.settings[parsed.name], tag };
  if (parsed?.kind !== "month") return { value: undefined, tag };
  if (parsed.family === "lk") return { value: doc.monthLocks[parsed.month] === true, tag };
  return { value: (parsed.family === "fm" ? doc.financeMonths : doc.cardBills)[parsed.month] ?? null, tag };
}

function setUnit(doc: LedgerDocument, key: string, value: unknown): void {
  const parsed = parseRegisterKey(key);
  if (parsed?.kind === "setting") {
    (doc.settings as unknown as Record<string, unknown>)[parsed.name] = structuredClone(value);
    return;
  }
  if (parsed?.kind !== "month") return;
  if (parsed.family === "lk") {
    if (value === true) doc.monthLocks[parsed.month] = true;
    else delete doc.monthLocks[parsed.month];
    return;
  }
  const map = (parsed.family === "fm" ? doc.financeMonths : doc.cardBills) as Record<string, unknown>;
  if (value === null) delete map[parsed.month];
  else map[parsed.month] = structuredClone(value);
}

function planUseMine(notice: Extract<StoredNotice, { kind: "overwrite" }>, doc: LedgerDocument, state: SyncState, env: ActionEnv): Plan {
  const records = new Set<string>();
  for (const { key } of notice.registers) {
    const parsed = parseRegisterKey(key)!;
    if (parsed.kind === "field") records.add(`${parsed.coll}/${parsed.id}`);
    else if (parsed.kind === "month" && !doc.settings.modules.includes(MODULE_OF[parsed.family])) return refuse("moduleOff");
  }
  for (const rk of records) {
    const refused = recordRefusal(doc, state, rk);
    if (refused) return refused;
  }
  const current = (key: string): { value: unknown; tag: Tag | undefined } => {
    const parsed = parseRegisterKey(key)!;
    if (parsed.kind !== "field") return unitValue(doc, state, key);
    const found = findRecord(doc, state, `${parsed.coll}/${parsed.id}`)!;
    return { value: found.record[parsed.field], tag: found.tag(parsed.field) };
  };
  if (notice.registers.every(({ key, mine }) => sameValue(current(key).value, mine))) return refuse("inEffect");
  // D30: a register another write set after the notice (neither the winner
  // the notice names nor this device's own) is never overwritten with the
  // value the notice kept; the preview shows it as it is now.
  const own = (t: Tag) => t[1] === env.device || t[1] === notice.loser.device;
  const changed = notice.registers.filter(({ key }) => {
    const { tag } = current(key);
    return tag === undefined || !((tag[0] === notice.winner.L && tag[1] === notice.winner.device) || own(tag));
  });
  if (changed.length > 0) return { refused: { reason: "changedSince" }, current: changed.map(({ key }) => ({ key, value: structuredClone(current(key).value) })) };
  return {
    refused: null,
    writes: notice.registers.map(({ key, mine }) => ({ key, value: mine })),
    apply: (target) => {
      for (const { key, mine } of notice.registers) {
        const parsed = parseRegisterKey(key)!;
        if (parsed.kind !== "field") {
          setUnit(target, key, mine);
          continue;
        }
        const { record } = findRecord(target, state, `${parsed.coll}/${parsed.id}`)!;
        if (sameValue(record[parsed.field], mine)) continue;
        record[parsed.field] = structuredClone(mine);
        record.updatedAt = env.now;
        record.updatedBy = env.actor;
      }
    },
  };
}

function planAddBack(notice: Extract<StoredNotice, { kind: "deleted" }>, doc: LedgerDocument, state: SyncState, env: ActionEnv): Plan {
  const { coll } = notice.target;
  const rk = `${coll}/${notice.target.id}`;
  const regs = state.rec.get(rk);
  if (!regs?.has(CREATE)) return refuse("missing");
  if (!state.del.has(rk)) return refuse("notDeleted");
  // Another device told of the same delete already added it back (its op's
  // `ab`, F3): a second add-back would make a second entry.
  if (state.ab.has(rk)) return refuse("inEffect", ADDED_BACK);
  if (!doc.settings.modules.includes(MODULE_OF[coll])) return refuse("moduleOff");
  const copied = FIELDS[coll].filter((field) => !(coll === "e" && field === "sortKey"));
  if (!copied.every((field) => regs.get(field) !== undefined)) return refuse("missing");
  const month = coll === "e" ? monthOf(state, rk) : null;
  if (coll === "e" && month === null) return refuse("missing");
  if (month !== null && doc.monthLocks[month] === true) return refuse("locked");
  return {
    refused: null,
    writes: copied.map((field) => ({ key: `${rk}/${field}`, value: regs.get(field)!.v })),
    apply: (target) => {
      const record: AnyRecord = { id: env.newId(), updatedAt: env.now, updatedBy: env.actor };
      for (const field of copied) record[field] = structuredClone(regs.get(field)!.v);
      if (month !== null) {
        // operations.ts's order for a month: (sortKey, id); the new one goes last.
        const list = [...(target.expenses[month] ?? [])].sort((a, b) => (a.sortKey !== b.sortKey ? (a.sortKey < b.sortKey ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        record.sortKey = keyBetween(list.at(-1)?.sortKey ?? null, null);
        target.expenses[month] = [...list, record as unknown as ExpenseRecord];
        return;
      }
      (target[COLLECTIONS[coll as Exclude<Coll, "e">]] as unknown as AnyRecord[]).push(record);
    },
  };
}

function planRecordAgain(notice: Extract<StoredNotice, { kind: "overwrite" }>, doc: LedgerDocument, state: SyncState, env: ActionEnv): Plan {
  const pair = notice.registers.find((r) => r.key.startsWith("emi/") && r.key.endsWith(`/${PAIR}`));
  if (!pair) return refuse("missing");
  const parsed = parseRegisterKey(pair.key)!;
  if (parsed.kind !== "field") return refuse("missing");
  const rk = `emi/${parsed.id}`;
  const refused = recordRefusal(doc, state, rk);
  if (refused) return refused;
  const today = todayOf(env.now, doc.settings.timeZone);
  /** Records the payment on `target`'s EMI; the amount it paid. */
  const pay = (target: LedgerDocument): string => {
    const record = target.emis.find((r) => r.id === parsed.id)!;
    const handles = new RowHandles();
    const paid = record.emiAmount;
    recordEmiPayment({ doc: target, today, handles, now: env.now, actor: env.actor, newId: env.newId }, handles.rowFor(record.id), Number(paid));
    return paid;
  };
  // The preview runs on a copy of this EMI alone, not of the document.
  const emi = structuredClone(doc.emis.find((r) => r.id === parsed.id)!);
  let paid: string;
  try {
    paid = pay({ ...doc, emis: [emi] });
  } catch (err) {
    if (err instanceof LedgerError) return refuse("invalid", err.message);
    throw err;
  }
  return {
    refused: null,
    paid,
    writes: [
      { key: `${rk}/remainingAsOf`, value: emi.remainingAsOf },
      { key: `${rk}/asOfDate`, value: emi.asOfDate },
    ],
    apply: (target) => void pay(target),
  };
}

function plan(notice: StoredNotice, kind: NoticeActionKind, doc: LedgerDocument, state: SyncState, env: ActionEnv): Plan {
  if (!actionsFor(notice).includes(kind)) return refuse("invalid", "This notice has no such action.");
  if (notice.kind === "deleted") return planAddBack(notice, doc, state, env);
  if (notice.kind !== "overwrite") return refuse("invalid");
  return kind === "recordAgain" ? planRecordAgain(notice, doc, state, env) : planUseMine(notice, doc, state, env);
}

/** What each of the notice's actions would write now, against `doc` (which
 * `state` materialises to), or why it can't. Changes nothing. */
export function previewActions(notice: StoredNotice, doc: LedgerDocument, state: SyncState, env: ActionEnv): ActionPreview[] {
  return actionsFor(notice).map((kind) => {
    const p = plan(notice, kind, doc, state, env);
    if (p.refused !== null) return { kind, writes: [], refused: p.refused, ...(p.current ? { current: p.current } : {}) };
    return { kind, writes: p.writes, ...(p.paid !== undefined ? { paid: p.paid } : {}), refused: null };
  });
}

/** A notice as the list shows it. */
export interface NoticeView {
  /** What dismissNotice() and noticeAction() take. */
  key: string;
  notice: StoredNotice;
  /** Each record the notice names, by record key ("e/<id>"): its name as
   * the state holds it now, deleted or not, else as it was when told. */
  names: Record<string, string | null>;
  /** Its actions, each with what it would write now or why it can't. */
  actions: ActionPreview[];
}

const NAME_FIELD: Record<Coll, string> = { e: "remarks", debt: "name", emi: "cardOrBank", sub: "service" };

/** `notice` as the list shows it, against the current `doc` (which `state`
 * materialises to). Changes nothing. */
export function noticeView(key: string, notice: StoredNotice, doc: LedgerDocument, state: SyncState, env: ActionEnv): NoticeView {
  const records = new Set<string>();
  if ((notice.kind === "overwrite" || notice.kind === "deleted") && notice.target.kind === "record") records.add(`${notice.target.coll}/${notice.target.id}`);
  if (notice.kind === "overwrite" || notice.kind === "kept" || notice.kind === "replaced") {
    for (const { key: register } of notice.registers) {
      const parsed = parseRegisterKey(register);
      if (parsed?.kind === "field") records.add(`${parsed.coll}/${parsed.id}`);
    }
  }
  const names: Record<string, string | null> = {};
  for (const rk of records) {
    const { coll } = parseRecordKey(rk)!;
    const name = state.rec.get(rk)?.get(NAME_FIELD[coll])?.v;
    const told = (notice.kind === "overwrite" || notice.kind === "deleted") && notice.target.kind === "record" && `${notice.target.coll}/${notice.target.id}` === rk ? notice.target.name : null;
    names[rk] = typeof name === "string" ? name : told;
  }
  return { key, notice, names, actions: previewActions(notice, doc, state, env) };
}

/** Why Add it back refuses once the record was added back elsewhere. */
export const ADDED_BACK = "It was already added back as a new entry.";

/** The words for a refusal, and the HTTP status a write refused for it
 * answers with. */
export const REFUSALS: Record<Refusal, { status: number; message: string }> = {
  deleted: { status: 404, message: "That record was deleted." },
  missing: { status: 404, message: "That record isn't in the ledger." },
  locked: { status: 403, message: "That month is locked. Unlock it first." },
  moduleOff: { status: 404, message: "That section is turned off." },
  inEffect: { status: 409, message: "The ledger already has that." },
  changedSince: { status: 409, message: "That changed again since, so it isn't set back." },
  notDeleted: { status: 409, message: "That record is in the ledger, so there's nothing to add back." },
  invalid: { status: 400, message: "That can't be saved." },
};

/** Runs action `kind` of `notice` on `doc` (a copy of the current
 * document, which `state` materialises to), checked as it stands now.
 * Throws an ApiError, with `doc` unchanged, when it can't run, and
 * ShownChanged when `shown` (what its button showed) isn't what it would
 * write now. */
export function applyAction(notice: StoredNotice, kind: NoticeActionKind, doc: LedgerDocument, state: SyncState, env: ActionEnv, shown?: ShownAction): void {
  const p = plan(notice, kind, doc, state, env);
  if (p.refused !== null) {
    const { status, message } = REFUSALS[p.refused.reason];
    throw new ApiError(status, p.refused.detail ?? message);
  }
  if (shown !== undefined && !(sameValue(p.writes, shown.writes) && (p.paid ?? null) === (shown.paid ?? null))) throw new ShownChanged();
  p.apply(doc);
}
