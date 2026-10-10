import type { LedgerDocument } from "../document/types";
import { sameValue } from "./canonical";
import { opProblem } from "./codec";
import { COLLECTIONS, CREATE, FIELDS, STAMP, createOrderKey, recordKey, type Coll } from "./keys";
import { rematerialize, type StateReader } from "./materialize";
import { beats, opState, type Op, type SyncState } from "./state";

// The diff (design section 3.3): one write's before and after documents,
// turned into one op. DocumentBackend runs every write unchanged (checks,
// locks, today, sort keys, the no-op rule) on a clone of current(), and the
// host's commit(next) diffs current() against next.
//
//   - Records match by (collection, id): an id only in `next` is a create,
//     an id only in `current` a delete.
//   - A record's changed fields are set, plus `_s` from next's stamps. A
//     change to the stamps alone produces nothing.
//   - `tombstones` is ignored: deletes live in the deleted set.
//   - Fail closed: any difference an op can't represent throws
//     UnrepresentableChange, so commit rejects and the document is
//     untouched. That covers a changed version or categories, an unknown
//     key, an expense moved between months, a deleted id coming back, two
//     creates in one ordered list, and anything else, because the op is
//     checked by materialising it over the state and comparing every unit it
//     touched with `next`.

/** A write the sync layer can't express as an op. */
export class UnrepresentableChange extends Error {
  override name = "UnrepresentableChange";
}

/** An op's content, before the engine adds L, at, by and vv. */
export type OpBody = Pick<Op, "set" | "del">;

const DOCUMENT_KEYS = [
  "version",
  "settings",
  "categories",
  "expenses",
  "monthLocks",
  "financeMonths",
  "debts",
  "emis",
  "subscriptions",
  "cardBills",
  "tombstones",
];
const STAMP_KEYS = ["id", "updatedAt", "updatedBy"];

type AnyRecord = { id: string } & Record<string, unknown>;

function fail(reason: string): never {
  throw new UnrepresentableChange(reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): boolean {
  if (!isPlainObject(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function idsOf(records: readonly AnyRecord[] | undefined): string {
  return (records ?? []).map((r) => r.id).join(",");
}

/** A state with one op laid over it, read without changing either. */
function overlay(base: SyncState, top: SyncState): StateReader {
  return {
    record(key) {
      const over = top.rec.get(key);
      const under = base.rec.get(key);
      if (!over || !under) return over ?? under;
      const merged = new Map(under);
      for (const [field, reg] of over) {
        const current = merged.get(field);
        if (!current || beats(reg, current)) merged.set(field, reg);
      }
      return merged;
    },
    unit(key) {
      const over = top.unit.get(key);
      const under = base.unit.get(key);
      if (!over || !under) return over ?? under;
      return beats(over, under) ? over : under;
    },
    deleted: (key) => base.del.has(key) || top.del.has(key),
  };
}

/** Whether two record lists are the same, record by record: exactly for the
 * records the op sets, and ignoring the stamps for the others (a stamp-only
 * change is dropped by design). */
function sameRecords(coll: Coll, a: readonly AnyRecord[] | undefined, b: readonly AnyRecord[] | undefined, setRecords: Set<string>): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((record, i) => {
    const other = b[i];
    if (record.id !== other.id) return false;
    if (setRecords.has(recordKey(coll, record.id))) return sameValue(record, other);
    return FIELDS[coll].every((field) => sameValue(record[field], other[field]));
  });
}

/** The op content that turns `current` into `next`, or null if there is
 * none. `state` is the sync state `current` was materialised from, and
 * `writer` the L and device the op will carry (a create's order key uses
 * them). Throws UnrepresentableChange instead of dropping a difference. */
export function diffDocuments(state: SyncState, current: LedgerDocument, next: LedgerDocument, writer: { L: number; device: string }): OpBody | null {
  if (!hasExactKeys(next, DOCUMENT_KEYS)) fail("the document's keys changed");
  if (next.version !== current.version) fail("the document version changed");
  if (!sameValue(next.categories, current.categories)) fail("the categories changed, and nothing can write them");
  if (!hasExactKeys(next.settings, ["modules", "timeZone"])) fail("the settings' keys changed");

  const set: [string, unknown][] = [];
  const del: string[] = [];
  /** Units where anything other than a stamp differs: each is checked. */
  const dirty = new Set<string>();
  /** Records the op sets registers of. */
  const setRecords = new Set<string>();

  // Settings: one register per key.
  if (!sameValue(current.settings.modules, next.settings.modules)) set.push(["st/modules", structuredClone(next.settings.modules)]);
  if (current.settings.timeZone !== next.settings.timeZone) set.push(["st/timeZone", next.settings.timeZone]);
  if (set.length > 0) dirty.add("st");

  // Month units: a lock is a boolean register (unlocking writes false); a
  // month's finances or card bills are one value, null when removed.
  const monthUnits = [
    ["lk", current.monthLocks, next.monthLocks],
    ["fm", current.financeMonths, next.financeMonths],
    ["cb", current.cardBills, next.cardBills],
  ] as const;
  for (const [family, before, after] of monthUnits) {
    if (!isPlainObject(after)) fail(`${family} is not a month map`);
    for (const month of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const a = (before as Record<string, unknown>)[month];
      const b = (after as Record<string, unknown>)[month];
      if (sameValue(a, b)) continue;
      if (family === "lk" && b !== undefined && b !== true) fail("a month lock is neither true nor absent");
      const key = `${family}/${month}`;
      set.push([key, family === "lk" ? b === true : b === undefined ? null : structuredClone(b)]);
      dirty.add(key);
    }
  }

  const create = (coll: Coll, record: AnyRecord, marker: unknown, unit: string) => {
    const rk = recordKey(coll, record.id);
    if (state.del.has(rk)) fail(`${rk} was deleted, and a deleted id never comes back`);
    if (state.rec.has(rk)) fail(`${rk} is already in the sync state`);
    set.push([`${rk}/${CREATE}`, marker]);
    for (const field of FIELDS[coll]) set.push([`${rk}/${field}`, record[field]]);
    set.push([`${rk}/${STAMP}`, { at: record.updatedAt, by: record.updatedBy }]);
    setRecords.add(rk);
    dirty.add(unit);
  };
  const update = (coll: Coll, before: AnyRecord, after: AnyRecord, unit: string) => {
    const changed = FIELDS[coll].filter((field) => !sameValue(before[field], after[field]));
    if (changed.length === 0) return;
    const rk = recordKey(coll, after.id);
    for (const field of changed) set.push([`${rk}/${field}`, after[field]]);
    set.push([`${rk}/${STAMP}`, { at: after.updatedAt, by: after.updatedBy }]);
    setRecords.add(rk);
    dirty.add(unit);
  };
  const checkRecord = (coll: Coll, record: unknown): AnyRecord => {
    if (!hasExactKeys(record, [...STAMP_KEYS, ...FIELDS[coll]])) fail(`a ${COLLECTIONS[coll]} record has the wrong keys`);
    return record as AnyRecord;
  };

  // Expenses: matched by id across months; an expense never changes month.
  if (!isPlainObject(next.expenses)) fail("expenses is not a month map");
  const before = new Map<string, { month: string; record: AnyRecord }>();
  for (const [month, records] of Object.entries(current.expenses)) {
    for (const record of records) before.set(record.id, { month, record: record as unknown as AnyRecord });
  }
  const after = new Map<string, { month: string; record: AnyRecord }>();
  for (const [month, records] of Object.entries(next.expenses)) {
    if (!Array.isArray(records)) fail("an expense month is not a list");
    for (const value of records) {
      const record = checkRecord("e", value);
      if (after.has(record.id)) fail(`expense ${record.id} appears twice`);
      after.set(record.id, { month, record });
    }
    const currentMonth = current.expenses[month] as unknown as AnyRecord[] | undefined;
    if (idsOf(currentMonth) !== idsOf(records as unknown as AnyRecord[]) || records.length === 0) dirty.add(`e:${month}`);
  }
  for (const month of Object.keys(current.expenses)) if (!Object.hasOwn(next.expenses, month)) dirty.add(`e:${month}`);
  for (const [id, { month, record }] of after) {
    const old = before.get(id);
    if (!old) create("e", record, { m: month }, `e:${month}`);
    else if (old.month !== month) fail(`expense ${id} moved from ${old.month} to ${month}`);
    else update("e", old.record, record, `e:${month}`);
  }
  for (const [id, { month }] of before) {
    if (after.has(id)) continue;
    del.push(recordKey("e", id));
    dirty.add(`e:${month}`);
  }

  // Debts, EMIs and subscriptions: ordered by their create marker, so a new
  // record lists last. One write creates at most one per list.
  for (const coll of ["debt", "emi", "sub"] as const) {
    const name = COLLECTIONS[coll];
    const list = next[name] as unknown;
    if (!Array.isArray(list)) fail(`${name} is not a list`);
    const old = new Map((current[name] as unknown as AnyRecord[]).map((r) => [r.id, r]));
    const seen = new Set<string>();
    let creates = 0;
    for (const value of list) {
      const record = checkRecord(coll, value);
      if (seen.has(record.id)) fail(`${name} record ${record.id} appears twice`);
      seen.add(record.id);
      const previous = old.get(record.id);
      if (previous) {
        update(coll, previous, record, coll);
      } else {
        if (++creates > 1) fail(`one write created two ${name} records, whose order an op can't keep`);
        create(coll, record, { o: createOrderKey(writer.L, writer.device) }, coll);
      }
    }
    for (const id of old.keys()) {
      if (seen.has(id)) continue;
      del.push(recordKey(coll, id));
      dirty.add(coll);
    }
    if (idsOf(current[name] as unknown as AnyRecord[]) !== idsOf(list as AnyRecord[])) dirty.add(coll);
  }

  if (dirty.size === 0) return null;
  const op: Op = { L: writer.L, at: 0, by: "", vv: {}, set, del };
  const problem = opProblem(op);
  if (problem) fail(problem);

  // The check that nothing was dropped: the state with this op joined must
  // materialise to `next` in every unit where the two documents differ.
  const reader = overlay(state, opState(writer.device, op));
  const records = new Set([...setRecords, ...del]);
  const result = rematerialize(current, reader, { records, units: dirty });
  for (const unit of dirty) {
    let same: boolean;
    if (unit.startsWith("e:")) {
      const month = unit.slice(2);
      same = sameRecords("e", result.expenses[month] as unknown as AnyRecord[], next.expenses[month] as unknown as AnyRecord[], setRecords);
    } else if (unit === "debt" || unit === "emi" || unit === "sub") {
      const name = COLLECTIONS[unit];
      same = sameRecords(unit, result[name] as unknown as AnyRecord[], next[name] as unknown as AnyRecord[], setRecords);
    } else if (unit === "st") {
      same = sameValue(result.settings, next.settings);
    } else {
      const [family, month] = unit.split("/");
      const map = family === "lk" ? "monthLocks" : family === "fm" ? "financeMonths" : "cardBills";
      const a = result[map] as Record<string, unknown>;
      const b = next[map] as Record<string, unknown>;
      same = Object.hasOwn(a, month) === Object.hasOwn(b, month) && sameValue(a[month], b[month]);
    }
    if (!same) fail(`the change to ${unit} can't be represented as an op`);
  }
  return set.length === 0 && del.length === 0 ? null : { set, del };
}
