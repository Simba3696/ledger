import type { ExpenseRecord, LedgerDocument } from "../document/types";
import { COLLECTIONS, CREATE, FIELDS, STAMP, type Coll } from "./keys";
import type { Changes, Register, SyncState } from "./state";

// Materialisation (design section 2.4): the LedgerDocument a sync state
// stands for. Pure. `materialize` builds it whole; `rematerialize` rebuilds
// only the units a join changed, into a copy-on-write copy of the previous
// document, and a property test holds the two equal.
//
// A record is visible iff it has a `_c` register and is not in the deleted
// set. Expenses are grouped by `_c.m` and listed by (sortKey, id), as
// operations.ts lists them; debts, EMIs and subscriptions by (`_c.o`, id).

/** Read access to a state: what materialisation needs, so a caller can
 * also materialise a state with an op laid over it (diff.ts). */
export interface StateReader {
  record(key: string): ReadonlyMap<string, Register> | undefined;
  unit(key: string): Register | undefined;
  deleted(key: string): boolean;
}

export function readerOf(state: SyncState): StateReader {
  return {
    record: (key) => state.rec.get(key),
    unit: (key) => state.unit.get(key),
    deleted: (key) => state.del.has(key),
  };
}

type ListColl = Exclude<Coll, "e">;
type AnyRecord = { id: string } & Record<string, unknown>;

/** A visible record's registers, or undefined. */
function visible(reader: StateReader, key: string): ReadonlyMap<string, Register> | undefined {
  const regs = reader.record(key);
  return regs?.has(CREATE) && !reader.deleted(key) ? regs : undefined;
}

/** The document record for a record's registers. Validated input always has
 * every field once `_c` is set (a create sets them all in one op), so a
 * missing one is a broken invariant, not bad input. */
function buildRecord(coll: Coll, id: string, regs: ReadonlyMap<string, Register>): AnyRecord {
  const stamp = regs.get(STAMP)?.v as { at: number; by: string } | undefined;
  if (!stamp) throw new Error(`Record ${coll}/${id} has no stamp`);
  const record: AnyRecord = { id, updatedAt: stamp.at, updatedBy: stamp.by };
  for (const field of FIELDS[coll]) {
    const reg = regs.get(field);
    if (!reg) throw new Error(`Record ${coll}/${id} has no ${field}`);
    record[field] = reg.v;
  }
  return record;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** operations.ts's compareExpenses: (sortKey, id). */
function compareExpenses(a: ExpenseRecord, b: ExpenseRecord): number {
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
  return compareIds(a.id, b.id);
}

/** A record's create marker; only visible records are asked for one. */
function createOf(regs: ReadonlyMap<string, Register> | undefined): Record<string, string> {
  const create = regs?.get(CREATE);
  if (!create) throw new Error("A listed record has no create marker");
  return create.v as Record<string, string>;
}

function monthOf(regs: ReadonlyMap<string, Register>): string {
  return createOf(regs).m;
}

function orderOf(reader: StateReader, coll: ListColl, id: string): string {
  return createOf(reader.record(`${coll}/${id}`)).o;
}

/** A list collection in (`_c.o`, id) order. */
function sortList(reader: StateReader, coll: ListColl, records: AnyRecord[]): AnyRecord[] {
  const keyed = records.map((record) => ({ record, order: orderOf(reader, coll, record.id) }));
  keyed.sort((a, b) => (a.order !== b.order ? (a.order < b.order ? -1 : 1) : compareIds(a.record.id, b.record.id)));
  return keyed.map((k) => k.record);
}

function settingsOf(reader: StateReader): LedgerDocument["settings"] {
  const modules = reader.unit("st/modules");
  const timeZone = reader.unit("st/timeZone");
  if (!modules || !timeZone) throw new Error("State has no settings: it was not started from a genesis");
  return { modules: modules.v as string[], timeZone: timeZone.v as string } as LedgerDocument["settings"];
}

function categoriesOf(reader: StateReader): LedgerDocument["categories"] {
  const categories = reader.unit("cat");
  if (!categories) throw new Error("State has no categories: it was not started from a genesis");
  return categories.v as LedgerDocument["categories"];
}

/** Sets or removes one month-keyed unit in a (copied) map. */
function putMonthUnit(doc: LedgerDocument, family: string, month: string, value: unknown): void {
  if (family === "lk") {
    if (value === true) doc.monthLocks[month] = true;
    else delete doc.monthLocks[month];
  } else {
    const map = (family === "fm" ? doc.financeMonths : doc.cardBills) as Record<string, unknown>;
    if (value === null || value === undefined) delete map[month];
    else map[month] = value;
  }
}

/** The whole document a state stands for. */
export function materialize(state: SyncState): LedgerDocument {
  const reader = readerOf(state);
  const doc: LedgerDocument = {
    version: 1,
    settings: settingsOf(reader),
    categories: categoriesOf(reader),
    expenses: {},
    monthLocks: {},
    financeMonths: {},
    debts: [],
    emis: [],
    subscriptions: [],
    cardBills: {},
    tombstones: [],
  };
  const lists: Record<ListColl, AnyRecord[]> = { debt: [], emi: [], sub: [] };
  for (const [key, regs] of state.rec) {
    if (!regs.has(CREATE) || state.del.has(key)) continue;
    const slash = key.indexOf("/");
    const coll = key.slice(0, slash) as Coll;
    const record = buildRecord(coll, key.slice(slash + 1), regs);
    if (coll === "e") (doc.expenses[monthOf(regs)] ??= []).push(record as unknown as ExpenseRecord);
    else lists[coll].push(record);
  }
  for (const records of Object.values(doc.expenses)) records.sort(compareExpenses);
  for (const coll of ["debt", "emi", "sub"] as const) {
    (doc as unknown as Record<string, AnyRecord[]>)[COLLECTIONS[coll]] = sortList(reader, coll, lists[coll]);
  }
  for (const [key, reg] of state.unit) {
    const slash = key.indexOf("/");
    const family = key.slice(0, slash);
    if (family === "fm" || family === "cb" || family === "lk") putMonthUnit(doc, family, key.slice(slash + 1), reg.v);
  }
  return doc;
}

/** `prev` (the document for the state before a join) with the units the
 * join changed rebuilt from `reader`. Unchanged units are shared with
 * `prev`, which is never modified. */
export function rematerialize(prev: LedgerDocument, reader: StateReader, changes: Changes): LedgerDocument {
  if (changes.units.size === 0) return prev;
  const doc: LedgerDocument = { ...prev };
  const touched: Record<Coll, Set<string>> = { e: new Set(), debt: new Set(), emi: new Set(), sub: new Set() };
  for (const key of changes.records) {
    const slash = key.indexOf("/");
    touched[key.slice(0, slash) as Coll].add(key.slice(slash + 1));
  }
  // The touched expenses that are visible now, by their month.
  const byMonth = new Map<string, ExpenseRecord[]>();
  for (const id of touched.e) {
    const regs = visible(reader, `e/${id}`);
    if (!regs) continue;
    const month = monthOf(regs);
    const records = byMonth.get(month) ?? [];
    records.push(buildRecord("e", id, regs) as unknown as ExpenseRecord);
    byMonth.set(month, records);
  }
  const copied = new Set<string>();
  const copy = <K extends "expenses" | "monthLocks" | "financeMonths" | "cardBills">(name: K) => {
    if (!copied.has(name)) {
      doc[name] = { ...prev[name] };
      copied.add(name);
    }
  };

  for (const unit of changes.units) {
    if (unit.startsWith("e:")) {
      const month = unit.slice(2);
      copy("expenses");
      const kept = (prev.expenses[month] ?? []).filter((r) => !touched.e.has(r.id));
      const records = [...kept, ...(byMonth.get(month) ?? [])].sort(compareExpenses);
      if (records.length === 0) delete doc.expenses[month];
      else doc.expenses[month] = records;
    } else if (unit === "debt" || unit === "emi" || unit === "sub") {
      const name = COLLECTIONS[unit];
      const ids = touched[unit];
      const kept = (prev[name] as unknown as AnyRecord[]).filter((r) => !ids.has(r.id));
      for (const id of ids) {
        const regs = visible(reader, `${unit}/${id}`);
        if (regs) kept.push(buildRecord(unit, id, regs));
      }
      (doc as unknown as Record<string, AnyRecord[]>)[name] = sortList(reader, unit, kept);
    } else if (unit === "st") {
      doc.settings = settingsOf(reader);
    } else if (unit === "cat") {
      doc.categories = categoriesOf(reader);
    } else {
      const slash = unit.indexOf("/");
      const family = unit.slice(0, slash);
      copy(family === "lk" ? "monthLocks" : family === "fm" ? "financeMonths" : "cardBills");
      putMonthUnit(doc, family, unit.slice(slash + 1), reader.unit(unit)?.v);
    }
  }
  return doc;
}

