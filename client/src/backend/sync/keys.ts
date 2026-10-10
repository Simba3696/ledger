import { RECORD_FIELDS, isMonthKey, isRecordId } from "../document/validate";

// Register keys (design section 2.2). Every part of a LedgerDocument is one
// or more registers:
//   <coll>/<id>/_c       a record's create marker: {m} (expenses) or {o}
//   <coll>/<id>/_s       its display stamp {at, by}, never a notice
//   <coll>/<id>/<field>  one field, last writer wins
//   fm/<k>, cb/<k>       a month's finances or card bills, as one unit
//   lk/<k>               a month's lock, true or false
//   st/modules, st/timeZone, cat
// A record's deletion lives in the deleted set, keyed <coll>/<id>.

/** The record collections, by their key prefix. */
export const COLLECTIONS = {
  e: "expenses",
  debt: "debts",
  emi: "emis",
  sub: "subscriptions",
} as const;

export type Coll = keyof typeof COLLECTIONS;

/** Each collection's field registers, in the record's field order. */
export const FIELDS: { readonly [C in Coll]: readonly string[] } = {
  e: Object.keys(RECORD_FIELDS.expenses),
  debt: Object.keys(RECORD_FIELDS.debts),
  emi: Object.keys(RECORD_FIELDS.emis),
  sub: Object.keys(RECORD_FIELDS.subscriptions),
};

export const CREATE = "_c";
export const STAMP = "_s";

/** The month-keyed unit families. */
type MonthUnit = "fm" | "cb" | "lk";

export type RegisterKey =
  | { kind: "field"; coll: Coll; id: string; field: string }
  | { kind: "month"; family: MonthUnit; month: string }
  | { kind: "setting"; name: "modules" | "timeZone" }
  | { kind: "categories" };

function isColl(value: string): value is Coll {
  return Object.hasOwn(COLLECTIONS, value);
}

/** The parts of a register key, or null if it names no register. */
export function parseRegisterKey(key: string): RegisterKey | null {
  if (key === "cat") return { kind: "categories" };
  const parts = key.split("/");
  if (parts.length === 2) {
    const [family, rest] = parts;
    if (family === "st") return rest === "modules" || rest === "timeZone" ? { kind: "setting", name: rest } : null;
    if ((family === "fm" || family === "cb" || family === "lk") && isMonthKey(rest)) return { kind: "month", family, month: rest };
    return null;
  }
  if (parts.length === 3) {
    const [coll, id, field] = parts;
    if (!isColl(coll) || !isRecordId(id)) return null;
    if (field === CREATE || field === STAMP || FIELDS[coll].includes(field)) return { kind: "field", coll, id, field };
  }
  return null;
}

/** `<coll>/<id>`: a record's key in the state and the deleted set. */
export function recordKey(coll: Coll, id: string): string {
  return `${coll}/${id}`;
}

export function parseRecordKey(key: string): { coll: Coll; id: string } | null {
  const parts = key.split("/");
  if (parts.length !== 2 || !isColl(parts[0]) || !isRecordId(parts[1])) return null;
  return { coll: parts[0], id: parts[1] };
}

/** A genesis record's order key: its index in the backup's list, so the
 * list keeps the backup's order. */
export function genesisOrderKey(index: number): string {
  return `0.${index.toString(36).padStart(6, "0")}`;
}

/** A new record's order key: after every genesis record, and after every
 * record this device had joined when it created it (its L is greater). L is
 * padded to 16 digits, the most any L below 2^50 has, so keys compare as
 * strings in L order. */
export function createOrderKey(L: number, device: string): string {
  return `1.${String(L).padStart(16, "0")}.${device}`;
}
