import type { ModuleName } from "../../api";
import type { ExpenseRecord, LedgerDocument } from "../document/types";
import { sameValue } from "./canonical";
import { isEpochKey } from "./epoch";
import { COLLECTIONS, CREATE, FIELDS, STAMP, TOGETHER, parseRecordKey, parseRegisterKey, type Coll } from "./keys";
import type { Register, SyncState } from "./state";
import { GENESIS_TAG, isDeviceId, type VersionVector } from "./tags";

// What a restore left behind, and putting it back (design sections 9.3 and
// 9.4). A restore starts a new epoch from a backup; nothing of the old
// epoch's state is ever joined into it. Instead each device, when it
// switches, projects its old-epoch state above the restore's cut
// (`basedOn.seen`, or nothing when the restore was based on another epoch):
// per device, the registers that device wrote above its cut entry, and the
// records it deleted above it. Each device's projection is one group,
// resolved everywhere by the re-apply marker "<oldEpoch>/<device>" (`ra`),
// which a Re-apply or a Discard op carries.
//
//   - Display stamps (`_s`) are never left behind: they are not content.
//   - A record both created and deleted above the cut was never in any
//     ledger the restore could have held, so nothing of it is.
//   - A record the old epoch deleted keeps only its deletion: its field
//     writes lost to the delete there (remove-wins, section 4), so they are
//     not offered on their own.
//   - A record never created in the old epoch (registers with no `_c`) was
//     never shown, so nothing of it is.
//   - What the restored ledger already holds is not left behind: a
//     register whose value the new genesis has, a create of a record the
//     genesis has, a delete of a record it lacks (ADR-0008, stage 6).
//
// Re-apply builds one write against the current document: a record created
// above the cut that is absent now is created again with its old id and the
// old state's current fields (a list record gets a fresh order key, ADR-0008
// stage 1); each field is set on a record visible now; each delete removes a
// record visible now; each month unit or setting is set. What can't be done
// is skipped and listed: a record the restored ledger doesn't hold or that
// was deleted since, a locked month, a module that is turned off.

/** One device's changes in an old epoch that a restore left out. */
export interface LeftBehindGroup {
  /** "<oldEpoch>/<device>": the re-apply marker that resolves it. */
  marker: string;
  epoch: string;
  device: string;
  /** This device's own changes there (owner decision D18: shown
   * prominently; other devices' in a collapsed list). */
  own: boolean;
  /** A login on the records that device stamped, for "Changes from Sam",
   * or null when its changes carry none (deletes only). */
  who: string | null;
  /** The restore that left these behind: its epoch, who restored and when
   * (display only). */
  into: { epoch: string; by: string; at: number };
  /** The registers to set again, by register key, ascending. */
  set: [key: string, value: unknown][];
  /** The records to delete again, by record key, ascending. */
  del: string[];
  /** Per record the group touches, the old state's registers by field
   * (`_c` and `_s` included): what a re-created record is made from, and
   * what a list shows. */
  records: Record<string, Record<string, unknown>>;
}

/** The restore a projection is for: the new epoch's genesis state and who
 * made it. */
export interface RestoreInto {
  epoch: string;
  by: string;
  at: number;
  state: SyncState;
}

/** A register's value as the document reads it: an absent month lock is
 * unlocked, an absent month's finances or bills are none. */
function readValue(key: string, reg: Register | undefined): unknown {
  if (reg) return reg.v;
  if (key.startsWith("lk/")) return false;
  if (key.startsWith("fm/") || key.startsWith("cb/")) return null;
  return undefined;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether `rk` is a visible record in `state`: created and not deleted. */
function isVisible(state: SyncState, rk: string): boolean {
  return state.rec.get(rk)?.has(CREATE) === true && !state.del.has(rk);
}

/** The groups device `me` (on epoch `epoch`) is left with when a restore
 * replaces `old`, its state there, cut at `cut`: one per device with
 * anything above its cut entry that the restored state lacks, `me`'s own
 * first, then by device id. */
export function leftBehind(old: SyncState, cut: VersionVector, into: RestoreInto, context: { epoch: string; me: string }): LeftBehindGroup[] {
  const restored = into.state;
  const above = (device: string, L: number) => device !== GENESIS_TAG[1] && L > (Object.hasOwn(cut, device) ? cut[device] : 0);
  const byDevice = new Map<string, { set: Map<string, unknown>; del: Set<string>; records: Set<string>; who: string | null }>();
  const group = (device: string) => {
    let found = byDevice.get(device);
    if (!found) byDevice.set(device, (found = { set: new Map(), del: new Set(), records: new Set(), who: null }));
    return found;
  };

  for (const [rk, regs] of old.rec) {
    const create = regs.get(CREATE);
    // Never shown in the old epoch, or deleted there: only a deletion of it
    // can be left behind (below).
    if (!create || old.del.has(rk)) continue;
    const coll = rk.slice(0, rk.indexOf("/")) as Coll;
    const theirs = restored.rec.get(rk);
    const fields = new Set<string>();
    for (const [field, reg] of regs) {
      if (field === STAMP || !above(reg.t[1], reg.t[0])) continue;
      if (field === CREATE ? theirs?.has(CREATE) === true : sameValue(reg.v, theirs?.get(field)?.v)) continue;
      fields.add(field);
    }
    // A field group (an EMI's balance pair) is set whole, as its writer set
    // it: the group's registers share one tag.
    for (const fieldGroup of TOGETHER[coll]) {
      if (fieldGroup.some((field) => fields.has(field))) for (const field of fieldGroup) if (regs.has(field)) fields.add(field);
    }
    for (const field of fields) {
      const reg = regs.get(field)!;
      const g = group(reg.t[1]);
      g.set.set(`${rk}/${field}`, reg.v);
      g.records.add(rk);
    }
  }
  for (const [key, reg] of old.unit) {
    if (key === "cat" || !above(reg.t[1], reg.t[0])) continue;
    if (sameValue(readValue(key, reg), readValue(key, restored.unit.get(key)))) continue;
    group(reg.t[1]).set.set(key, reg.v);
  }
  for (const [rk, deletion] of old.del) {
    if (!above(deletion.by, deletion.L)) continue;
    const create = old.rec.get(rk)?.get(CREATE);
    // Created and deleted above the cut: in no ledger the restore could hold.
    if (create && above(create.t[1], create.t[0])) continue;
    // Nothing to delete in the restored ledger.
    if (!restored.rec.get(rk)?.has(CREATE)) continue;
    const g = group(deletion.by);
    g.del.add(rk);
    g.records.add(rk);
  }
  // Who: a login on a record stamp the device wrote.
  for (const regs of old.rec.values()) {
    const stamp = regs.get(STAMP);
    if (!stamp) continue;
    const g = byDevice.get(stamp.t[1]);
    const by = (stamp.v as { by?: unknown }).by;
    if (g && g.who === null && typeof by === "string") g.who = by;
  }

  const groups: LeftBehindGroup[] = [];
  for (const [device, g] of byDevice) {
    if (g.set.size === 0 && g.del.size === 0) continue;
    const records: Record<string, Record<string, unknown>> = {};
    for (const rk of [...g.records].sort(compareText)) {
      records[rk] = Object.fromEntries([...(old.rec.get(rk) ?? new Map<string, Register>())].map(([field, reg]) => [field, structuredClone(reg.v)]));
    }
    groups.push({
      marker: `${context.epoch}/${device}`,
      epoch: context.epoch,
      device,
      own: device === context.me,
      who: g.who,
      into: { epoch: into.epoch, by: into.by, at: into.at },
      set: [...g.set].sort(([a], [b]) => compareText(a, b)).map(([key, value]) => [key, structuredClone(value)]),
      del: [...g.del].sort(compareText),
      records,
    });
  }
  return groups.sort((a, b) => Number(b.own) - Number(a.own) || compareText(a.device, b.device));
}

/** `group` less what `restored` (a new epoch's genesis state) already
 * holds, by the projection's rule above: a register at the same value, a
 * create of a record the genesis has, a delete of a record it lacks, and a
 * field group set whole while any of it is left. Null when nothing is left;
 * `group` itself when nothing is held. For a group carried across a switch
 * (section 9.3): its marker joined in the old epoch, if at all, never
 * reaches the new one, so this is what hides one the new genesis took in. */
export function withoutHeld(group: LeftBehindGroup, restored: SyncState): LeftBehindGroup | null {
  const held = (key: string, value: unknown): boolean => {
    const parsed = parseRegisterKey(key);
    if (parsed?.kind !== "field") return sameValue(readValue(key, { v: value, t: GENESIS_TAG }), readValue(key, restored.unit.get(key)));
    const theirs = restored.rec.get(`${parsed.coll}/${parsed.id}`);
    return parsed.field === CREATE ? theirs?.has(CREATE) === true : sameValue(value, theirs?.get(parsed.field)?.v);
  };
  const left = new Set(group.set.filter(([key, value]) => !held(key, value)).map(([key]) => key));
  // A field group (an EMI's balance pair) stays whole while any of it is left.
  for (const [key] of group.set) {
    const parsed = parseRegisterKey(key);
    if (parsed?.kind !== "field" || left.has(key)) continue;
    const rk = `${parsed.coll}/${parsed.id}`;
    const together = TOGETHER[parsed.coll].find((fields) => fields.includes(parsed.field));
    if (together?.some((field) => left.has(`${rk}/${field}`))) left.add(key);
  }
  const del = group.del.filter((rk) => restored.rec.get(rk)?.has(CREATE) === true);
  if (left.size === group.set.length && del.length === group.del.length) return group;
  if (left.size === 0 && del.length === 0) return null;
  const set = group.set.filter(([key]) => left.has(key));
  const touched = new Set(del);
  for (const [key] of set) {
    const parsed = parseRegisterKey(key);
    if (parsed?.kind === "field") touched.add(`${parsed.coll}/${parsed.id}`);
  }
  const records = Object.fromEntries(Object.entries(group.records).filter(([rk]) => touched.has(rk)));
  return { ...group, set, del, records };
}

// --- Stored groups ----------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored group back, or null when it isn't one this build wrote. */
export function checkGroup(value: unknown): LeftBehindGroup | null {
  if (!isPlainObject(value)) return null;
  const { marker, epoch, device, own, who, into, set, del, records } = value;
  if (typeof marker !== "string" || !isEpochKey(epoch) || !isDeviceId(device) || marker !== `${epoch}/${device}`) return null;
  if (typeof own !== "boolean" || (who !== null && typeof who !== "string")) return null;
  if (!isPlainObject(into) || !isEpochKey(into.epoch) || typeof into.by !== "string" || typeof into.at !== "number") return null;
  if (!Array.isArray(set) || !set.every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && parseRegisterKey(entry[0]) !== null)) return null;
  if (!Array.isArray(del) || !del.every((key) => typeof key === "string" && parseRecordKey(key) !== null)) return null;
  if (!isPlainObject(records) || !Object.values(records).every(isPlainObject)) return null;
  return value as unknown as LeftBehindGroup;
}

// --- What a group holds, as a list ---------------------------------------------

/** A document-shaped record from a group's snapshot of its registers. */
type RecordSnapshot = { id: string } & Record<string, unknown>;

/** One change in a group, as a list shows it and re-apply applies it. */
export type LeftBehindItem =
  /** A record created in the old epoch that the restored ledger lacks:
   * `record` is it as the old epoch last had it, `fields` what this group
   * wrote of it. */
  | { kind: "add"; coll: Coll; id: string; record: RecordSnapshot; fields: Record<string, unknown>; month?: string }
  /** Fields of a record, set to these values. */
  | { kind: "edit"; coll: Coll; id: string; fields: Record<string, unknown>; record: RecordSnapshot }
  | { kind: "delete"; coll: Coll; id: string; record: RecordSnapshot }
  /** A month's lock, finances or card bills, or a setting. */
  | { kind: "unit"; key: string; value: unknown };

function snapshotOf(group: LeftBehindGroup, coll: Coll, id: string): RecordSnapshot {
  const regs = group.records[`${coll}/${id}`] ?? {};
  const stamp = isPlainObject(regs[STAMP]) ? regs[STAMP] : {};
  const record: RecordSnapshot = { id, updatedAt: stamp.at, updatedBy: stamp.by };
  for (const field of FIELDS[coll]) record[field] = regs[field];
  return record;
}

/** The group's changes, record by record, in the group's key order. */
export function leftBehindItems(group: LeftBehindGroup): LeftBehindItem[] {
  const items: LeftBehindItem[] = [];
  const byRecord = new Map<string, { coll: Coll; id: string; fields: Record<string, unknown>; create: boolean }>();
  for (const [key, value] of group.set) {
    const parsed = parseRegisterKey(key);
    if (parsed?.kind !== "field") {
      items.push({ kind: "unit", key, value });
      continue;
    }
    const rk = `${parsed.coll}/${parsed.id}`;
    let entry = byRecord.get(rk);
    if (!entry) byRecord.set(rk, (entry = { coll: parsed.coll, id: parsed.id, fields: {}, create: false }));
    if (parsed.field === CREATE) entry.create = true;
    else entry.fields[parsed.field] = value;
  }
  for (const { coll, id, fields, create } of byRecord.values()) {
    const record = snapshotOf(group, coll, id);
    if (create) {
      const c = group.records[`${coll}/${id}`]?.[CREATE];
      const month = coll === "e" && isPlainObject(c) && typeof c.m === "string" ? c.m : undefined;
      items.push({ kind: "add", coll, id, record, fields, ...(month ? { month } : {}) });
    } else {
      items.push({ kind: "edit", coll, id, fields, record });
    }
  }
  for (const rk of group.del) {
    const parsed = parseRecordKey(rk)!;
    items.push({ kind: "delete", coll: parsed.coll, id: parsed.id, record: snapshotOf(group, parsed.coll, parsed.id) });
  }
  return items;
}

// --- Whether a group is in effect -----------------------------------------------

/** Whether `state` already holds everything `group` would write: each
 * register at the group's value (a created record visible), and each
 * deleted record gone. */
export function inEffect(group: LeftBehindGroup, state: SyncState): boolean {
  for (const [key, value] of group.set) {
    const parsed = parseRegisterKey(key);
    if (parsed?.kind === "field") {
      const rk = `${parsed.coll}/${parsed.id}`;
      if (!isVisible(state, rk)) return false;
      if (parsed.field !== CREATE && !sameValue(state.rec.get(rk)?.get(parsed.field)?.v, value)) return false;
    } else if (!sameValue(readValue(key, state.unit.get(key)), readValue(key, { v: value, t: GENESIS_TAG }))) {
      return false;
    }
  }
  return group.del.every((rk) => !isVisible(state, rk));
}

/** The part of `group` that `applied` (reapplyTo's) put back: what an own
 * group keeps after its own re-apply, so it shows again if a concurrent
 * re-apply from an older view sets any of it back (D18). Null when nothing
 * was applied. */
export function appliedPart(group: LeftBehindGroup, applied: readonly LeftBehindItem[]): LeftBehindGroup | null {
  const keys = new Set<string>();
  const dels = new Set<string>();
  for (const item of applied) {
    if (item.kind === "unit") keys.add(item.key);
    else if (item.kind === "delete") dels.add(`${item.coll}/${item.id}`);
    else {
      const rk = `${item.coll}/${item.id}`;
      if (item.kind === "add") keys.add(`${rk}/${CREATE}`);
      for (const field of Object.keys(item.fields)) keys.add(`${rk}/${field}`);
    }
  }
  const set = group.set.filter(([key]) => keys.has(key));
  const del = group.del.filter((rk) => dels.has(rk));
  if (set.length === 0 && del.length === 0) return null;
  const touched = new Set(del);
  for (const [key] of set) {
    const parsed = parseRegisterKey(key);
    if (parsed?.kind === "field") touched.add(`${parsed.coll}/${parsed.id}`);
  }
  return { ...group, set, del, records: Object.fromEntries(Object.entries(group.records).filter(([rk]) => touched.has(rk))) };
}

// --- Re-apply ---------------------------------------------------------------------

/** Why a change can't be re-applied now. */
type SkipReason =
  /** The record isn't in the restored ledger. */
  | "notInLedger"
  /** The record was deleted after the restore. */
  | "deleted"
  /** Its month is locked. */
  | "monthLocked"
  /** Its module is turned off. */
  | "moduleOff";

export interface ReapplyResult {
  applied: LeftBehindItem[];
  skipped: { item: LeftBehindItem; reason: SkipReason }[];
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

/** operations.ts's order for a month: (sortKey, id). */
function compareExpenses(a: ExpenseRecord, b: ExpenseRecord): number {
  if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
  return compareText(a.id, b.id);
}

type AnyRecord = { id: string } & Record<string, unknown>;

/** Applies `group` to `doc` (a copy of the current document, which `state`
 * materialises to), stamping what it changes with `stamp`. The locks and
 * modules checked are the document's before any change. Returns what was
 * applied and what was skipped, and why. */
export function reapplyTo(doc: LedgerDocument, state: SyncState, group: LeftBehindGroup, stamp: { at: number; by: string }): ReapplyResult {
  const result: ReapplyResult = { applied: [], skipped: [] };
  const locks = { ...doc.monthLocks };
  const modules = new Set<string>(doc.settings.modules);
  const skip = (item: LeftBehindItem, reason: SkipReason) => result.skipped.push({ item, reason });
  const lists = (coll: Exclude<Coll, "e">) => doc[COLLECTIONS[coll]] as unknown as AnyRecord[];
  /** The record's month (expenses) and the record itself, if visible now. */
  const find = (coll: Coll, id: string): { month?: string; record: AnyRecord } | null => {
    if (coll !== "e") {
      const record = lists(coll).find((r) => r.id === id);
      return record ? { record } : null;
    }
    for (const [month, records] of Object.entries(doc.expenses)) {
      const record = records.find((r) => r.id === id);
      if (record) return { month, record: record as unknown as AnyRecord };
    }
    return null;
  };
  const absent = (coll: Coll, id: string): SkipReason => (state.del.has(`${coll}/${id}`) ? "deleted" : "notInLedger");
  const touchedMonths = new Set<string>();
  const creates: Record<Exclude<Coll, "e">, AnyRecord[]> = { debt: [], emi: [], sub: [] };

  const edit = (item: LeftBehindItem, coll: Coll, id: string, fields: Record<string, unknown>) => {
    const found = find(coll, id);
    if (!found) return skip(item, absent(coll, id));
    if (found.month !== undefined && locks[found.month] === true) return skip(item, "monthLocked");
    let changed = false;
    for (const [field, value] of Object.entries(fields)) {
      if (!FIELDS[coll].includes(field) || sameValue(found.record[field], value)) continue;
      found.record[field] = structuredClone(value);
      changed = true;
    }
    if (changed) {
      found.record.updatedAt = stamp.at;
      found.record.updatedBy = stamp.by;
      if (found.month !== undefined) touchedMonths.add(found.month);
    }
    result.applied.push(item);
  };

  for (const item of leftBehindItems(group)) {
    if (item.kind === "unit") {
      const family = item.key.slice(0, item.key.indexOf("/"));
      if ((family === "fm" || family === "cb" || family === "lk") && !modules.has(MODULE_OF[family])) {
        skip(item, "moduleOff");
        continue;
      }
      const month = item.key.slice(item.key.indexOf("/") + 1);
      if (family === "lk") {
        if (item.value === true) doc.monthLocks[month] = true;
        else delete doc.monthLocks[month];
      } else if (family === "fm" || family === "cb") {
        const map = (family === "fm" ? doc.financeMonths : doc.cardBills) as Record<string, unknown>;
        if (item.value === null) delete map[month];
        else map[month] = structuredClone(item.value);
      } else if (item.key === "st/modules") {
        doc.settings.modules = structuredClone(item.value) as LedgerDocument["settings"]["modules"];
      } else if (item.key === "st/timeZone") {
        doc.settings.timeZone = item.value as string;
      }
      result.applied.push(item);
      continue;
    }
    if (!modules.has(MODULE_OF[item.coll])) {
      skip(item, "moduleOff");
      continue;
    }
    if (item.kind === "edit") {
      edit(item, item.coll, item.id, item.fields);
      continue;
    }
    if (item.kind === "delete") {
      const found = find(item.coll, item.id);
      // Already gone: nothing to do.
      if (!found) {
        result.applied.push(item);
        continue;
      }
      if (found.month !== undefined && locks[found.month] === true) {
        skip(item, "monthLocked");
        continue;
      }
      if (item.coll === "e") {
        const month = found.month!;
        doc.expenses[month] = doc.expenses[month].filter((r) => r.id !== item.id);
        touchedMonths.add(month);
      } else {
        (doc as unknown as Record<string, AnyRecord[]>)[COLLECTIONS[item.coll]] = lists(item.coll).filter((r) => r.id !== item.id);
      }
      result.applied.push(item);
      continue;
    }
    // An add: the record again, with its old id. One that is there now
    // (another device re-applied it) gets only what this group wrote.
    if (find(item.coll, item.id)) {
      edit(item, item.coll, item.id, item.fields);
      continue;
    }
    if (state.del.has(`${item.coll}/${item.id}`)) {
      skip(item, "deleted");
      continue;
    }
    if (!FIELDS[item.coll].every((field) => item.record[field] !== undefined)) {
      skip(item, "notInLedger");
      continue;
    }
    const record: AnyRecord = { id: item.id, updatedAt: stamp.at, updatedBy: stamp.by };
    for (const field of FIELDS[item.coll]) record[field] = structuredClone(item.record[field]);
    if (item.coll === "e") {
      const month = item.month;
      if (month === undefined) {
        skip(item, "notInLedger");
        continue;
      }
      if (locks[month] === true) {
        skip(item, "monthLocked");
        continue;
      }
      (doc.expenses[month] ??= []).push(record as unknown as ExpenseRecord);
      touchedMonths.add(month);
    } else {
      creates[item.coll].push(record);
    }
    result.applied.push(item);
  }

  for (const month of touchedMonths) {
    const records = doc.expenses[month] ?? [];
    if (records.length === 0) delete doc.expenses[month];
    else doc.expenses[month] = [...records].sort(compareExpenses);
  }
  // Records created by one write list last, in id order (diff.ts).
  for (const coll of ["debt", "emi", "sub"] as const) {
    if (creates[coll].length === 0) continue;
    (doc as unknown as Record<string, AnyRecord[]>)[COLLECTIONS[coll]] = [...lists(coll), ...creates[coll].sort((a, b) => compareText(a.id, b.id))];
  }
  return result;
}
