import type { LedgerDocument } from "../document/types";

// A write's copy of the document, made as the write reads it (stage 8c-2).
// DocumentBackend runs each write on a copy of current() and commits that
// copy; a whole structuredClone of a 10-year document costs about a third
// of a write. A draft reads exactly as that clone does, key order included,
// but copies a part only when the write first reads it: each top-level part
// (settings, categories, debts, EMIs, subscriptions, tombstones), and each
// month of a month map (expenses, month locks, finances, card bills). A part
// the write never reads is never copied, so nothing the write can reach is
// shared with the document it was drafted from, and that document never
// changes. settleDraft then turns the draft into a plain document whose
// unread parts are the source's own objects, which the diff can pass over
// by identity.
//
// The draft is the write's alone: nothing else may read it (reading copies),
// and its source must not change while the write runs (current() never
// does: every document the engine hands out is replaced, not changed).

/** The getters of parts not read yet. */
const unread = new WeakSet<() => unknown>();
/** Each lazy copy, with the object it copies. */
const sources = new WeakMap<object, Record<string, unknown>>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object with `source`'s keys, in its order, each copied by `copy` the
 * first time it is read. Writing or deleting a key works as on a plain
 * object, and reading it afterwards reads what was written. */
function lazyCopy(source: Record<string, unknown>, copy: (value: unknown) => unknown): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    // Redefined in place, so the key keeps its position.
    const own = (value: unknown) => {
      Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    };
    const get = () => {
      const value = copy(source[key]);
      own(value);
      return value;
    };
    unread.add(get);
    Object.defineProperty(target, key, { get, set: own, enumerable: true, configurable: true });
  }
  sources.set(target, source);
  return target;
}

/** A copy of `doc` for one write to change, made as the write reads it. */
export function draftOf(doc: LedgerDocument): LedgerDocument {
  const part = (value: unknown) => (isPlainObject(value) ? lazyCopy(value, (month) => structuredClone(month)) : structuredClone(value));
  return lazyCopy(doc as unknown as Record<string, unknown>, part) as unknown as LedgerDocument;
}

/** `doc` as a plain document: a draft's unread parts are its source's own
 * objects, and what the write read or wrote is the write's. Anything that
 * isn't a draft is returned as it is. */
export function settleDraft(doc: LedgerDocument): LedgerDocument {
  return settle(doc) as LedgerDocument;
}

function settle(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const source = sources.get(value);
  if (source === undefined) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    out[key] = property.get !== undefined && unread.has(property.get) ? source[key] : settle(property.value);
  }
  return out;
}
