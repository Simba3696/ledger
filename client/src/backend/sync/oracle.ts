import type { LedgerDocument } from "../document/types";
import { unseal, type DeviceKey } from "./records";
import type { Op } from "./state";

// The property harness's oracle (design section 16.4, stage 8a): what a
// household's document must be, worked out from what reached the repo, by a
// deliberately plain second implementation. It shares no code with the
// engine's join, materialisation, diff or left-behind projection, and keeps
// none of their incremental state: it reads every version of every file the
// repo ever held, collects every op once, and for each register keeps the
// write with the greatest tag, as the spec states the rule. Imported only by
// tests. Fictional data only.
//
// The rules it implements, each straight from the spec and ADR-0008:
//   - a register's value is the write with the greatest [L, device] tag;
//     an equal tag (only after a fork) goes to the greater canonical JSON
//     of the value (ADR-0008, stage 1);
//   - an EMI's balance pair (remainingAsOf, asOfDate) is one register,
//     compared as the pair (ADR-0008, stage 1);
//   - a record is shown iff it was created (`_c`) and nobody deleted it;
//   - expenses by month `_c.m`, ordered by (sortKey, id); debts, EMIs and
//     subscriptions by (`_c.o`, id), a genesis record's `o` being
//     "0." + its index in base 36 padded to 6 (section 2.4);
//   - the winning epoch is the greatest epoch key that counts: its genesis
//     is listed and so is one for every number from 1 up (ADR-0008);
//   - what a restore leaves behind is each device's writes above the cut,
//     less display stamps, the categories, records never created and,
//     for a record deleted in the old epoch, everything but its deletion; a
//     record created and deleted above the cut leaves nothing (section 9.3,
//     ADR-0008 stage 6).

/** One write's place: [L, device], "g" for a genesis. */
interface Cell {
  L: number;
  d: string;
  v: unknown;
}

/** One op as it reached a log, with the device whose log it is. */
export interface OracleOp {
  device: string;
  op: Op;
}

/** Canonical JSON, written again here on purpose: keys sorted, undefined
 * members left out. */
export function plainText(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => plainText(item === undefined ? null : item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${plainText(v)}`).join(",")}}`;
}

const LIST_NAMES = { debt: "debts", emi: "emis", sub: "subscriptions" } as const;
type ListColl = keyof typeof LIST_NAMES;
const COLLS = ["e", "debt", "emi", "sub"] as const;
/** The EMI balance pair, folded as one register under this field name. */
const PAIR = "#balance";

function later(a: Cell, b: Cell): boolean {
  if (a.L !== b.L) return a.L > b.L;
  if (a.d !== b.d) return a.d > b.d;
  return plainText(a.v) > plainText(b.v);
}

/** Every register's winning write, and every record's greatest deletion. */
export interface Fold {
  cells: Map<string, Cell>;
  dels: Map<string, { L: number; by: string }>;
}

function put(cells: Map<string, Cell>, key: string, cell: Cell): void {
  const now = cells.get(key);
  if (!now || later(cell, now)) cells.set(key, cell);
}

/** The pair key for an EMI balance field, or the key itself. */
function folded(key: string): string {
  const parts = key.split("/");
  return parts.length === 3 && parts[0] === "emi" && (parts[2] === "remainingAsOf" || parts[2] === "asOfDate") ? `emi/${parts[1]}/${PAIR}` : key;
}

/** The genesis document as writes tagged [1, "g"]. */
function genesisCells(doc: LedgerDocument): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  const g = (v: unknown): Cell => ({ L: 1, d: "g", v: structuredClone(v) });
  const addRecord = (coll: string, record: Record<string, unknown>, create: unknown) => {
    const id = record.id as string;
    cells.set(`${coll}/${id}/_c`, g(create));
    cells.set(`${coll}/${id}/_s`, g({ at: record.updatedAt, by: record.updatedBy }));
    for (const [field, value] of Object.entries(record)) {
      if (field === "id" || field === "updatedAt" || field === "updatedBy") continue;
      if (coll === "emi" && (field === "remainingAsOf" || field === "asOfDate")) continue;
      cells.set(`${coll}/${id}/${field}`, g(value));
    }
    if (coll === "emi") cells.set(`emi/${id}/${PAIR}`, g([record.remainingAsOf, record.asOfDate]));
  };
  for (const [m, records] of Object.entries(doc.expenses)) for (const r of records) addRecord("e", r as unknown as Record<string, unknown>, { m });
  for (const [coll, name] of Object.entries(LIST_NAMES)) {
    (doc[name] as unknown as Record<string, unknown>[]).forEach((r, i) => addRecord(coll, r, { o: `0.${i.toString(36).padStart(6, "0")}` }));
  }
  for (const [k, v] of Object.entries(doc.financeMonths)) cells.set(`fm/${k}`, g(v));
  for (const [k, v] of Object.entries(doc.cardBills)) cells.set(`cb/${k}`, g(v));
  for (const k of Object.keys(doc.monthLocks)) cells.set(`lk/${k}`, g(true));
  cells.set("st/modules", g(doc.settings.modules));
  cells.set("st/timeZone", g(doc.settings.timeZone));
  cells.set("cat", g(doc.categories));
  return cells;
}

/** The genesis and every op, folded register by register. */
export function fold(genesis: LedgerDocument, ops: readonly OracleOp[]): Fold {
  const cells = genesisCells(genesis);
  const dels = new Map<string, { L: number; by: string }>();
  for (const { device, op } of ops) {
    const pairs = new Map<string, { remainingAsOf?: unknown; asOfDate?: unknown }>();
    for (const [key, v] of op.set) {
      const f = folded(key);
      if (f === key) {
        put(cells, key, { L: op.L, d: device, v: structuredClone(v) });
        continue;
      }
      const pair = pairs.get(f) ?? {};
      pair[key.endsWith("/remainingAsOf") ? "remainingAsOf" : "asOfDate"] = v;
      pairs.set(f, pair);
    }
    for (const [key, pair] of pairs) {
      if (!("remainingAsOf" in pair) || !("asOfDate" in pair)) throw new Error(`oracle: an op of ${device} at ${op.L} sets half of ${key}`);
      put(cells, key, { L: op.L, d: device, v: [pair.remainingAsOf, pair.asOfDate] });
    }
    for (const rk of op.del) {
      const now = dels.get(rk);
      if (!now || op.L > now.L || (op.L === now.L && device > now.by)) dels.set(rk, { L: op.L, by: device });
    }
  }
  return { cells, dels };
}

/** The records a fold holds: record key to its fields' writes. */
function recordsOf(f: Fold): Map<string, Map<string, Cell>> {
  const records = new Map<string, Map<string, Cell>>();
  for (const [key, cell] of f.cells) {
    const parts = key.split("/");
    if (parts.length !== 3) continue;
    const rk = `${parts[0]}/${parts[1]}`;
    if (!records.has(rk)) records.set(rk, new Map());
    records.get(rk)!.set(parts[2], cell);
  }
  return records;
}

/** Whether a record is shown: created, and not deleted. */
function shown(f: Fold, rk: string): boolean {
  return f.cells.has(`${rk}/_c`) && !f.dels.has(rk);
}

/** The document the fold stands for. */
export function documentOf(f: Fold): LedgerDocument {
  const value = (key: string) => {
    const cell = f.cells.get(key);
    if (!cell) throw new Error(`oracle: nothing ever set ${key}`);
    return structuredClone(cell.v);
  };
  const doc = {
    version: 1,
    settings: { modules: value("st/modules"), timeZone: value("st/timeZone") },
    categories: value("cat"),
    expenses: {} as Record<string, Record<string, unknown>[]>,
    monthLocks: {} as Record<string, true>,
    financeMonths: {} as Record<string, unknown>,
    debts: [] as Record<string, unknown>[],
    emis: [] as Record<string, unknown>[],
    subscriptions: [] as Record<string, unknown>[],
    cardBills: {} as Record<string, unknown>,
    tombstones: [],
  };
  const lists: Record<ListColl, { o: string; record: Record<string, unknown> }[]> = { debt: [], emi: [], sub: [] };
  for (const [rk, fields] of recordsOf(f)) {
    if (!shown(f, rk)) continue;
    const [coll, id] = rk.split("/");
    const stamp = fields.get("_s")?.v as { at: number; by: string } | undefined;
    if (!stamp) throw new Error(`oracle: ${rk} was created with no stamp`);
    const record: Record<string, unknown> = { id, updatedAt: stamp.at, updatedBy: stamp.by };
    for (const [field, cell] of fields) {
      if (field === "_c" || field === "_s") continue;
      if (field === PAIR) [record.remainingAsOf, record.asOfDate] = structuredClone(cell.v) as [unknown, unknown];
      else record[field] = structuredClone(cell.v);
    }
    const create = fields.get("_c")!.v as { m?: string; o?: string };
    if (coll === "e") (doc.expenses[create.m!] ??= []).push(record);
    else lists[coll as ListColl].push({ o: create.o!, record });
  }
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  for (const records of Object.values(doc.expenses)) {
    records.sort((a, b) => byText(a.sortKey as string, b.sortKey as string) || byText(a.id as string, b.id as string));
  }
  for (const coll of ["debt", "emi", "sub"] as const) {
    doc[LIST_NAMES[coll]] = lists[coll].sort((a, b) => byText(a.o, b.o) || byText(a.record.id as string, b.record.id as string)).map((x) => x.record);
  }
  for (const [key, cell] of f.cells) {
    const [family, month] = key.split("/");
    if (family === "lk" && cell.v === true) doc.monthLocks[month] = true;
    if (family === "fm" && cell.v !== null) doc.financeMonths[month] = structuredClone(cell.v);
    if (family === "cb" && cell.v !== null) doc.cardBills[month] = structuredClone(cell.v);
  }
  return doc as unknown as LedgerDocument;
}

/** A document as text, `tombstones` aside: equal documents, equal text. */
export function documentText(doc: LedgerDocument): string {
  return plainText({ ...doc, tombstones: [] });
}

// --- Epochs -----------------------------------------------------------------------

const EPOCH = /^e(\d{6}|[1-9]\d{6,})-[0-9a-f]{8}$/;

/** An epoch key's number, as a bigint. */
function epochNumber(epoch: string): bigint {
  return BigInt(epoch.slice(1, epoch.indexOf("-")));
}

function compareEpochs(a: string, b: string): number {
  const [na, nb] = [epochNumber(a), epochNumber(b)];
  if (na !== nb) return na < nb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The winning epoch among genesis epoch keys: the greatest whose number,
 * and every number from 1 below it, has a genesis. */
export function winnerOf(geneses: readonly string[]): string | null {
  const keys = geneses.filter((e) => EPOCH.test(e));
  let winner: string | null = null;
  for (let n = 1n; ; n++) {
    const of = keys.filter((e) => epochNumber(e) === n).sort(compareEpochs);
    if (of.length === 0) return winner;
    winner = of.at(-1)!;
  }
}

// --- The repo, every version of every file --------------------------------------------

interface Genesis {
  epoch: string;
  reason: string;
  by: string;
  basedOn: { epoch: string; seen: Record<string, number> } | null;
  doc: LedgerDocument;
}

export interface RepoHistory {
  geneses: Map<string, Genesis>;
  /** Per epoch, every op found in any version of any log, each (device, L,
   * content) once. */
  ops: Map<string, OracleOp[]>;
  /** Per epoch, every snapshot version's state, as written. */
  snaps: Map<string, { device: string; state: unknown }[]>;
  /** Files that didn't decrypt or weren't what their name says. */
  unreadable: string[];
}

/** Reads every file version the repo ever held (fakeGitHub's versions()). */
export async function readHistory(versions: readonly { path: string; text: string }[], key: DeviceKey): Promise<RepoHistory> {
  const history: RepoHistory = { geneses: new Map(), ops: new Map(), snaps: new Map(), unreadable: [] };
  const seenOps = new Set<string>();
  for (const { path, text } of versions) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    const parts = name.split(".");
    if (!path.startsWith("ledger/") || parts.at(-1) !== "enc" || !EPOCH.test(parts[0])) continue;
    let content: Record<string, unknown>;
    try {
      content = (await unseal(text, key)) as Record<string, unknown>;
    } catch {
      history.unreadable.push(path);
      continue;
    }
    const epoch = parts[0];
    if (parts.length === 3 && parts[1] === "genesis") {
      if (content.kind !== "genesis" || content.epoch !== epoch) {
        history.unreadable.push(path);
        continue;
      }
      history.geneses.set(epoch, { epoch, reason: content.reason as string, by: content.by as string, basedOn: content.basedOn as Genesis["basedOn"], doc: content.doc as LedgerDocument });
      continue;
    }
    const device = parts[1];
    if (content.epoch !== epoch || content.device !== device || content.kind !== parts[2]) {
      history.unreadable.push(path);
      continue;
    }
    if (content.kind === "log") {
      for (const op of content.ops as Op[]) {
        const id = `${epoch}/${device}/${op.L}/${plainText(op)}`;
        if (seenOps.has(id)) continue;
        seenOps.add(id);
        if (!history.ops.has(epoch)) history.ops.set(epoch, []);
        history.ops.get(epoch)!.push({ device, op });
      }
    } else if (content.kind === "snap") {
      if (!history.snaps.has(epoch)) history.snaps.set(epoch, []);
      history.snaps.get(epoch)!.push({ device, state: content.state });
    }
  }
  return history;
}

/** Every write a snapshot's state holds, as (key, L, device, value) text:
 * what "nothing invented" checks against the ops and the genesis. */
export function snapshotWrites(state: unknown): string[] {
  const out: string[] = [];
  const s = state as { rec: Record<string, { id: string; c: [number, string]; v: Record<string, unknown>; t?: Record<string, [number, string]> }[]>; unit: [string, unknown, [number, string]][]; del: [string, string, number, unknown][] };
  for (const coll of COLLS) {
    for (const r of s.rec[coll] ?? []) {
      for (const [field, v] of Object.entries(r.v)) {
        const [L, d] = r.t?.[field] ?? r.c;
        out.push(writeText(`${coll}/${r.id}/${field}`, L, d, v));
      }
    }
  }
  for (const [key, v, [L, d]] of s.unit) out.push(writeText(key, L, d, v));
  for (const [rk, by, L] of s.del) out.push(`del ${rk} ${L} ${by}`);
  return out;
}

/** One write as text. */
function writeText(key: string, L: number, d: string, v: unknown): string {
  return `${key} ${L} ${d} ${plainText(v)}`;
}

/** Every write the genesis and `ops` make, as writeText gives them, and
 * each deletion: the writes a snapshot may hold. */
export function writesOf(genesis: LedgerDocument, ops: readonly OracleOp[]): Set<string> {
  const out = new Set<string>();
  for (const [key, cell] of genesisCells(genesis)) {
    if (key.endsWith(`/${PAIR}`)) {
      const [amount, date] = cell.v as [unknown, unknown];
      const rk = key.slice(0, -PAIR.length - 1);
      out.add(writeText(`${rk}/remainingAsOf`, 1, "g", amount));
      out.add(writeText(`${rk}/asOfDate`, 1, "g", date));
    } else {
      out.add(writeText(key, 1, "g", cell.v));
    }
  }
  for (const { device, op } of ops) {
    for (const [key, v] of op.set) out.add(writeText(key, op.L, device, v));
    for (const rk of op.del) out.add(`del ${rk} ${op.L} ${device}`);
  }
  return out;
}

// --- What a restore leaves behind ---------------------------------------------------

/** One change a restore must leave offered (or otherwise account for): a
 * register `key` set to `value`, or record `key` deleted, by `device` at
 * `L`, in epoch `epoch`. */
export interface Obligation {
  epoch: string;
  device: string;
  L: number;
  kind: "set" | "del";
  key: string;
  value?: unknown;
}

/** What epoch `epoch` (its genesis and every op made in it, pushed or not)
 * leaves behind under `cut`: per register, the winning write when its
 * writer is above its cut entry; per record, its deletion likewise. */
export function obligations(epoch: string, genesis: LedgerDocument, ops: readonly OracleOp[], cut: Readonly<Record<string, number>>): Obligation[] {
  const f = fold(genesis, ops);
  const above = (d: string, L: number) => d !== "g" && L > (Object.hasOwn(cut, d) ? cut[d] : 0);
  const out: Obligation[] = [];
  for (const [key, cell] of f.cells) {
    if (key === "cat" || !above(cell.d, cell.L)) continue;
    const parts = key.split("/");
    if (parts.length === 3) {
      const rk = `${parts[0]}/${parts[1]}`;
      // Never created, or deleted there: only a deletion is left behind.
      if (!f.cells.has(`${rk}/_c`) || f.dels.has(rk) || parts[2] === "_s") continue;
      if (parts[2] === PAIR) {
        const [amount, date] = cell.v as [unknown, unknown];
        out.push({ epoch, device: cell.d, L: cell.L, kind: "set", key: `${rk}/remainingAsOf`, value: amount });
        out.push({ epoch, device: cell.d, L: cell.L, kind: "set", key: `${rk}/asOfDate`, value: date });
        continue;
      }
    }
    out.push({ epoch, device: cell.d, L: cell.L, kind: "set", key, value: structuredClone(cell.v) });
  }
  for (const [rk, del] of f.dels) {
    if (!above(del.by, del.L)) continue;
    const create = f.cells.get(`${rk}/_c`);
    if (create && above(create.d, create.L)) continue;
    out.push({ epoch, device: del.by, L: del.L, kind: "del", key: rk });
  }
  return out;
}

/** Whether `genesis` (a restore's document) already holds `ob`: a register
 * at the same value (an absent lock is unlocked, an absent month's
 * finances or bills are none), a create of a record it has, a delete of a
 * record it lacks. */
export function holds(genesis: LedgerDocument, ob: Obligation): boolean {
  return holdsIn(fold(genesis, []), ob);
}

/** The same test against a fold, where a record counts only while shown. */
export function holdsIn(f: Fold, ob: Obligation): boolean {
  if (ob.kind === "del") return !shown(f, ob.key);
  const parts = ob.key.split("/");
  if (parts.length === 3) {
    const rk = `${parts[0]}/${parts[1]}`;
    if (!shown(f, rk)) return false;
    if (parts[2] === "_c") return true;
    const pair = folded(ob.key);
    if (pair !== ob.key) {
      const [amount, date] = f.cells.get(pair)!.v as [unknown, unknown];
      return plainText(parts[2] === "remainingAsOf" ? amount : date) === plainText(ob.value);
    }
    return plainText(f.cells.get(ob.key)?.v) === plainText(ob.value);
  }
  const absent = ob.key.startsWith("lk/") ? false : ob.key.startsWith("fm/") || ob.key.startsWith("cb/") ? null : undefined;
  return plainText(f.cells.get(ob.key)?.v ?? absent) === plainText(ob.value ?? absent);
}
