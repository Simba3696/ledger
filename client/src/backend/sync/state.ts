import { isWritableDocument } from "../document/validate";
import type { LedgerDocument } from "../document/types";
import { canonicalJson } from "./canonical";
import { COLLECTIONS, CREATE, FIELDS, STAMP, TOGETHER, genesisOrderKey, parseRegisterKey, recordKey, type Coll } from "./keys";
import { GENESIS_TAG, compareTags, type Tag, type VersionVector } from "./tags";

// The sync state and its join (design section 2.3). The state is a set of
// registers, a deleted set, re-apply markers and a seen vector. Joining two
// states takes, per register, the one with the greater tag, and per field
// group (keys.ts TOGETHER) the whole group of one side. The join is
// commutative, associative and idempotent, so the same ops give the same
// state whatever order they arrive in, however often and however batched.
// Convergence rests on that alone, and join.test.ts checks the laws.

/** One register: a value and the tag of the write that set it. Registers
 * are immutable: a join replaces them and never edits one. */
export interface Register {
  readonly v: unknown;
  readonly t: Tag;
}

/** A deleted record: who deleted it, at which L, and what they had seen. */
interface Deletion {
  readonly by: string;
  readonly L: number;
  readonly vv: VersionVector;
}

export interface SyncState {
  /** `<coll>/<id>` to its registers by field, `_c` and `_s` included. A
   * deleted record keeps its registers, so a lost edit can be recovered. */
  rec: Map<string, Map<string, Register>>;
  /** The other registers: fm/*, cb/*, lk/*, st/*, cat. */
  unit: Map<string, Register>;
  /** The deleted set: grow-only for the epoch, remove-wins. */
  del: Map<string, Deletion>;
  /** Re-apply markers "<oldEpoch>/<deviceId>" (section 9.4). */
  ra: Set<string>;
  /** Per device, the greatest L joined from it. */
  seen: Map<string, number>;
  /** The greatest L in anything joined or committed. */
  maxL: number;
}

/** One op as a device's log holds it (section 3.1). Its tag is [L, the
 * log's device]. `at` and `by` are for display only, and `vv` only for
 * notices and restore cuts: convergence reads none of them. */
export interface Op {
  L: number;
  at: number;
  by: string;
  vv: VersionVector;
  set: [key: string, value: unknown][];
  del: string[];
  ra?: string[];
}

/** What a join changed, for incremental materialisation: the record keys
 * whose registers or deletion changed, and the document units to rebuild
 * ("e:<month>", "debt", "emi", "sub", "fm/<k>", "cb/<k>", "lk/<k>", "st",
 * "cat"). */
export interface Changes {
  records: Set<string>;
  units: Set<string>;
}

export function emptyState(): SyncState {
  return { rec: new Map(), unit: new Map(), del: new Map(), ra: new Set(), seen: new Map(), maxL: 0 };
}

/** A copy a join can change without touching `state`. Registers are
 * immutable, so they are shared. */
export function cloneState(state: SyncState): SyncState {
  return {
    rec: new Map(Array.from(state.rec, ([key, regs]) => [key, new Map(regs)])),
    unit: new Map(state.unit),
    del: new Map(state.del),
    ra: new Set(state.ra),
    seen: new Map(state.seen),
    maxL: state.maxL,
  };
}

/** Whether register `a` beats `b`: the greater tag, or on an equal tag
 * (only after a fork) the greater canonical value. The order is therefore
 * total, and the join stays commutative even on malformed history. A
 * TOGETHER group is compared as one unit instead (joinRecord). */
export function beats(a: Register, b: Register): boolean {
  const order = compareTags(a.t, b.t);
  if (order !== 0) return order > 0;
  return a.v !== b.v && canonicalJson(a.v) > canonicalJson(b.v);
}

/** Whether a field group's registers `a` beat `b`'s, as one unit: their
 * tags in group order, then on equal tags (only after a fork) the canonical
 * JSON of all their values. Comparing values per register instead would let
 * a fork take one field from each side: a pair nobody wrote. */
function groupBeats(a: readonly Register[], b: readonly Register[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const order = compareTags(a[i].t, b[i].t);
    if (order !== 0) return order > 0;
  }
  if (a.every((reg, i) => reg === b[i])) return false;
  return canonicalJson(a.map((reg) => reg.v)) > canonicalJson(b.map((reg) => reg.v));
}

function isWhole(regs: readonly (Register | undefined)[]): regs is Register[] {
  return regs.every((reg) => reg !== undefined);
}

/** Joins one record's `incoming` registers into `mine` in place, and says
 * whether any changed: per register the one that beats, except that a
 * TOGETHER group present whole on both sides is taken whole from the side
 * whose group beats. Valid input always holds a group whole or not at all
 * (codec.ts), so the join stays commutative, associative and idempotent. */
export function joinRecord(coll: Coll, mine: Map<string, Register>, incoming: ReadonlyMap<string, Register>): boolean {
  let changed = false;
  const grouped = new Set<string>();
  for (const group of TOGETHER[coll]) {
    const ours = group.map((field) => mine.get(field));
    const theirs = group.map((field) => incoming.get(field));
    if (!isWhole(ours) || !isWhole(theirs)) continue;
    for (const field of group) grouped.add(field);
    if (groupBeats(theirs, ours)) {
      group.forEach((field, i) => mine.set(field, theirs[i]));
      changed = true;
    }
  }
  for (const [field, reg] of incoming) {
    if (grouped.has(field)) continue;
    const current = mine.get(field);
    if (!current || beats(reg, current)) {
      mine.set(field, reg);
      changed = true;
    }
  }
  return changed;
}

/** The same order for deletions: (L, by), then the canonical vv. */
function deletionBeats(a: Deletion, b: Deletion): boolean {
  const order = compareTags([a.L, a.by], [b.L, b.by]);
  if (order !== 0) return order > 0;
  return a.vv !== b.vv && canonicalJson(a.vv) > canonicalJson(b.vv);
}

/** The document unit a record belongs to, given its `_c` register. An
 * expense with no `_c` yet is in no month. */
function recordUnit(coll: Coll, create: Register | undefined): string | null {
  if (coll !== "e") return coll;
  return create ? `e:${(create.v as { m: string }).m}` : null;
}

function unitOfRegisterKey(key: string): string {
  return key.startsWith("st/") ? "st" : key;
}

/** Joins `source` into `target` in place, and says what changed. */
export function joinInto(target: SyncState, source: SyncState): Changes {
  const changes: Changes = { records: new Set(), units: new Set() };
  const touch = (key: string, before: Register | undefined) => {
    changes.records.add(key);
    const coll = key.slice(0, key.indexOf("/")) as Coll;
    const after = target.rec.get(key)?.get(CREATE);
    for (const unit of [recordUnit(coll, before), recordUnit(coll, after)]) if (unit) changes.units.add(unit);
  };

  for (const [key, regs] of source.rec) {
    const mine = target.rec.get(key);
    if (!mine) {
      target.rec.set(key, new Map(regs));
      touch(key, undefined);
      continue;
    }
    const before = mine.get(CREATE);
    if (joinRecord(key.slice(0, key.indexOf("/")) as Coll, mine, regs)) touch(key, before);
  }
  for (const [key, reg] of source.unit) {
    const current = target.unit.get(key);
    if (!current || beats(reg, current)) {
      target.unit.set(key, reg);
      changes.units.add(unitOfRegisterKey(key));
    }
  }
  for (const [key, deletion] of source.del) {
    const current = target.del.get(key);
    if (!current || deletionBeats(deletion, current)) {
      target.del.set(key, deletion);
      if (!current) touch(key, target.rec.get(key)?.get(CREATE));
    }
  }
  for (const marker of source.ra) target.ra.add(marker);
  for (const [device, L] of source.seen) if (L > (target.seen.get(device) ?? 0)) target.seen.set(device, L);
  target.maxL = Math.max(target.maxL, source.maxL);
  return changes;
}

/** The join of two states, as a new state. */
export function join(a: SyncState, b: SyncState): SyncState {
  const joined = cloneState(a);
  joinInto(joined, b);
  return joined;
}

/** The state holding exactly one of `device`'s ops. Expects a validated op
 * (codec.ts), and throws on a key that names no register. */
export function opState(device: string, op: Op): SyncState {
  const state = emptyState();
  const t: Tag = [op.L, device];
  for (const [key, v] of op.set) {
    const parsed = parseRegisterKey(key);
    if (!parsed) throw new Error(`Not a register key: ${key}`);
    if (parsed.kind === "field") {
      const rk = recordKey(parsed.coll, parsed.id);
      let regs = state.rec.get(rk);
      if (!regs) state.rec.set(rk, (regs = new Map()));
      regs.set(parsed.field, { v, t });
    } else {
      state.unit.set(key, { v, t });
    }
  }
  for (const key of op.del) state.del.set(key, { by: device, L: op.L, vv: op.vv });
  for (const marker of op.ra ?? []) state.ra.add(marker);
  state.seen.set(device, op.L);
  state.maxL = op.L;
  return state;
}

/** Joins one of `device`'s ops into `state`. */
export function applyOp(state: SyncState, device: string, op: Op): Changes {
  return joinInto(state, opState(device, op));
}

/** A genesis document as a state: every register tagged [1, "g"], list
 * order kept through order keys made from the array indices, and
 * `tombstones` ignored. Throws unless the document is writable (deep
 * shapes, unique ids). */
export function genesisState(document: LedgerDocument): SyncState {
  if (!isWritableDocument(document)) throw new Error("Genesis document is malformed");
  const doc = structuredClone(document);
  const state = emptyState();
  const t = GENESIS_TAG;
  const addRecord = (coll: Coll, record: object, create: unknown) => {
    const fields = record as Record<string, unknown>;
    const regs = new Map<string, Register>([
      [CREATE, { v: create, t }],
      [STAMP, { v: { at: fields.updatedAt, by: fields.updatedBy }, t }],
    ]);
    for (const field of FIELDS[coll]) regs.set(field, { v: fields[field], t });
    state.rec.set(recordKey(coll, fields.id as string), regs);
  };
  for (const [m, records] of Object.entries(doc.expenses)) {
    for (const record of records) addRecord("e", record, { m });
  }
  for (const coll of ["debt", "emi", "sub"] as const) {
    doc[COLLECTIONS[coll]].forEach((record, index) => addRecord(coll, record, { o: genesisOrderKey(index) }));
  }
  for (const [k, value] of Object.entries(doc.financeMonths)) state.unit.set(`fm/${k}`, { v: value, t });
  for (const [k, value] of Object.entries(doc.cardBills)) state.unit.set(`cb/${k}`, { v: value, t });
  for (const k of Object.keys(doc.monthLocks)) state.unit.set(`lk/${k}`, { v: true, t });
  state.unit.set("st/modules", { v: doc.settings.modules, t });
  state.unit.set("st/timeZone", { v: doc.settings.timeZone, t });
  state.unit.set("cat", { v: doc.categories, t });
  state.maxL = 1;
  return state;
}
