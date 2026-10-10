import type { LedgerDocument } from "../document/types";
import {
  RECORD_FIELDS,
  isCardBillList,
  isCategoryList,
  isFinanceMonth,
  isModuleList,
  isMonthKey,
  isRecordId,
  isRecordStamp,
  isWritableDocument,
} from "../document/validate";
import { canonicalJson } from "./canonical";
import { isEpochKey, parseRepoFileName, type RepoFile } from "./epoch";
import { CREATE, FIELDS, STAMP, TOGETHER, isOrderKey, orderKeyNames, parseRecordKey, parseRegisterKey, type Coll, type RegisterKey } from "./keys";
import { emptyState, type Op, type Register, type SyncState } from "./state";
import { GENESIS_TAG, compareTags, isDeviceId, isLamport, isTag, isVersionVector, type Tag, type VersionVector } from "./tags";

// The sync file formats and their structural validator (design sections 3.1,
// 3.6 and 6). A file another device wrote is joined only if it passes here
// whole: a malformed file is never partly applied. Validation is structural
// only (shapes, value types per register kind, formats, tag ranges, name and
// content binding, no duplicate record); business rules ran once, at the
// origin. Within one format version `fv` these checks may only be loosened,
// so two builds never disagree on whether a file is valid (ADR-0008).

/** The highest file format version this build reads and writes. */
export const FORMAT_VERSION = 1;

type Check = (value: unknown) => boolean;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An object with exactly the required keys plus any of the optional ones. */
function hasKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}

const isString = (value: unknown): value is string => typeof value === "string";
const isFiniteNumber: Check = (value) => typeof value === "number" && Number.isFinite(value);
/** A count of ops, or an L that may be 0 (nothing yet). */
const isLamportOrZero: Check = (value) => value === 0 || isLamport(value);
/** A restore cut (section 9.2: R.seen with {R: R.ownMaxL}): a version
 * vector whose entries may also be 0, because a restorer that wrote no op
 * in its epoch has ownMaxL 0. A 0 entry cuts nothing, as an absent one. */
const isRestoreCut: Check = (value) => isPlainObject(value) && Object.entries(value).every(([device, L]) => isDeviceId(device) && isLamportOrZero(L));
const isChain: Check = (value) => typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
const isBlobSha: Check = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
/** A re-apply marker: "<oldEpoch>/<deviceId>". */
const isReapplyMarker: Check = (value) => typeof value === "string" && /^e\d{6}-[0-9a-f]{8}\/d[0-9a-f]{16}$/.test(value);

const FIELD_CHECKS: { readonly [C in Coll]: Record<string, Check> } = {
  e: RECORD_FIELDS.expenses,
  debt: RECORD_FIELDS.debts,
  emi: RECORD_FIELDS.emis,
  sub: RECORD_FIELDS.subscriptions,
};

/** Whether `value` may be held by the register `key` names, when a write
 * at `L` set it (a create's order key must name that L). */
function isRegisterValue(key: RegisterKey, value: unknown, L: number): boolean {
  switch (key.kind) {
    case "field": {
      if (!isPlainObject(value) && (key.field === CREATE || key.field === STAMP)) return false;
      const object = value as Record<string, unknown>;
      if (key.field === CREATE) {
        if (key.coll === "e") return hasKeys(object, ["m"]) && isMonthKey(object.m);
        return hasKeys(object, ["o"]) && isOrderKey(object.o) && orderKeyNames(object.o, L);
      }
      if (key.field === STAMP) return hasKeys(object, ["at", "by"]) && isRecordStamp(object.at, object.by);
      return FIELD_CHECKS[key.coll][key.field](value);
    }
    case "month":
      if (key.family === "lk") return typeof value === "boolean";
      return value === null || (key.family === "fm" ? isFinanceMonth(value) : isCardBillList(value));
    case "setting":
      return key.name === "modules" ? isModuleList(value) : isString(value);
    case "categories":
      return isCategoryList(value);
  }
}

/** Every record in `fields` (record key to the fields set) that has `_c`
 * has every field and `_s` too: a create sets them all at once. */
function createsAreWhole(fields: Map<string, Set<string>>): boolean {
  for (const [key, set] of fields) {
    if (!set.has(CREATE)) continue;
    const coll = key.slice(0, key.indexOf("/")) as Coll;
    if (!set.has(STAMP) || !FIELDS[coll].every((field) => set.has(field))) return false;
  }
  return true;
}

/** Every record in `fields` sets each TOGETHER group whole or not at all. */
function groupsAreWhole(fields: Map<string, Set<string>>): boolean {
  for (const [key, set] of fields) {
    const coll = key.slice(0, key.indexOf("/")) as Coll;
    for (const group of TOGETHER[coll]) if (group.some((field) => set.has(field)) && !group.every((field) => set.has(field))) return false;
  }
  return true;
}

/** A record's TOGETHER groups are each wholly absent, or wholly present
 * under one tag: what every join of whole-group ops holds. */
function groupsShareTags(coll: Coll, regs: ReadonlyMap<string, Register>): boolean {
  return TOGETHER[coll].every((group) => {
    const tags = group.map((field) => regs.get(field)?.t);
    if (tags.every((t) => t === undefined)) return true;
    return tags.every((t) => t !== undefined && compareTags(t, tags[0]!) === 0);
  });
}

/** Why `value` is not a valid op, or null if it is one. */
export function opProblem(value: unknown): string | null {
  if (!isPlainObject(value) || !hasKeys(value, ["L", "at", "by", "vv", "set", "del"], ["ra"])) return "op has the wrong keys";
  if (!isLamport(value.L)) return "op L is out of range";
  if (!isFiniteNumber(value.at) || !isString(value.by)) return "op stamp is malformed";
  if (!isVersionVector(value.vv)) return "op vv is malformed";
  if (!Array.isArray(value.set) || !Array.isArray(value.del)) return "op set or del is not a list";

  const keys = new Set<string>();
  const fields = new Map<string, Set<string>>();
  for (const entry of value.set as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isString(entry[0])) return "op set entry is malformed";
    const [key, v] = entry as [string, unknown];
    const parsed = parseRegisterKey(key);
    if (!parsed) return `op sets an unknown register: ${key}`;
    if (parsed.kind === "categories") return "op sets the categories, which only a genesis sets";
    if (!isRegisterValue(parsed, v, value.L as number)) return `op sets a malformed value for ${key}`;
    if (keys.has(key)) return `op sets ${key} twice`;
    keys.add(key);
    if (parsed.kind === "field") {
      const rk = `${parsed.coll}/${parsed.id}`;
      const set = fields.get(rk) ?? new Set<string>();
      set.add(parsed.field);
      fields.set(rk, set);
    }
  }
  if (!createsAreWhole(fields)) return "op creates a record without all its fields";
  if (!groupsAreWhole(fields)) return "op sets part of a field group (an EMI's balance pair)";

  const deleted = new Set<string>();
  for (const key of value.del as unknown[]) {
    if (!isString(key) || !parseRecordKey(key)) return "op deletes a malformed record key";
    if (deleted.has(key)) return `op deletes ${key} twice`;
    deleted.add(key);
  }
  if (value.ra !== undefined) {
    if (!Array.isArray(value.ra) || !value.ra.every(isReapplyMarker)) return "op ra is malformed";
    if (new Set(value.ra).size !== value.ra.length) return "op ra repeats a marker";
  }
  return null;
}

// --- Compact state (a snapshot's `state`) ------------------------------------

/** One record: `c` is the `_c` tag (or, with no `_c` yet, the greatest
 * tag), `v` every register's value, `t` only the tags that differ from `c`. */
interface CompactRecord {
  id: string;
  c: Tag;
  v: Record<string, unknown>;
  t?: Record<string, Tag>;
}

export interface CompactState {
  rec: Record<Coll, CompactRecord[]>;
  unit: [key: string, value: unknown, tag: Tag][];
  del: [key: string, by: string, L: number, vv: VersionVector][];
  ra: string[];
}

function byString<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

/** A version vector in key order. */
export function vectorOf(seen: ReadonlyMap<string, number>): VersionVector {
  return Object.fromEntries([...seen].sort(byString(([device]) => device)));
}

/** The state in compact form, deterministically ordered: equal states give
 * equal canonical JSON. `seen` and `maxL` travel beside it (a snap file's
 * own fields). */
export function encodeState(state: SyncState): CompactState {
  const rec: Record<Coll, CompactRecord[]> = { e: [], debt: [], emi: [], sub: [] };
  for (const [key, regs] of state.rec) {
    const slash = key.indexOf("/");
    const fields = [...regs.keys()].sort();
    let c = regs.get(CREATE)?.t;
    if (!c) for (const field of fields) if (!c || compareTags(regs.get(field)!.t, c) > 0) c = regs.get(field)!.t;
    const record: CompactRecord = { id: key.slice(slash + 1), c: c!, v: {} };
    for (const field of fields) {
      const reg = regs.get(field)!;
      record.v[field] = reg.v;
      if (compareTags(reg.t, c!) !== 0) (record.t ??= {})[field] = reg.t;
    }
    rec[key.slice(0, slash) as Coll].push(record);
  }
  for (const list of Object.values(rec)) list.sort(byString((r) => r.id));
  return {
    rec,
    unit: [...state.unit].sort(byString(([key]) => key)).map(([key, reg]) => [key, reg.v, reg.t]),
    del: [...state.del].sort(byString(([key]) => key)).map(([key, d]) => [key, d.by, d.L, d.vv]),
    ra: [...state.ra].sort(),
  };
}

/** A compact state back as a state, validated; or why it is malformed. */
export function decodeState(value: unknown, seen: VersionVector, maxL: number): SyncState | string {
  if (!isPlainObject(value) || !hasKeys(value, ["rec", "unit", "del", "ra"])) return "state has the wrong keys";
  const state = emptyState();
  let greatestL = 0;
  const tagged = (t: Tag): Tag => {
    greatestL = Math.max(greatestL, t[0]);
    return t;
  };

  const rec = value.rec;
  if (!isPlainObject(rec) || !hasKeys(rec, ["e", "debt", "emi", "sub"])) return "state rec has the wrong keys";
  for (const coll of ["e", "debt", "emi", "sub"] as const) {
    const list = rec[coll];
    if (!Array.isArray(list)) return `state rec.${coll} is not a list`;
    for (const record of list as unknown[]) {
      if (!isPlainObject(record) || !hasKeys(record, ["id", "c", "v"], ["t"])) return "state record has the wrong keys";
      const { id, c, v, t } = record;
      if (!isString(id) || !isRecordId(id) || !isTag(c) || !isPlainObject(v)) return "state record is malformed";
      if (t !== undefined && (!isPlainObject(t) || !Object.entries(t).every(([field, tag]) => Object.hasOwn(v, field) && isTag(tag)))) {
        return "state record tags are malformed";
      }
      const key = `${coll}/${id}`;
      if (state.rec.has(key)) return `state holds ${key} twice`;
      const regs = new Map<string, Register>();
      for (const [field, fieldValue] of Object.entries(v)) {
        const parsed = parseRegisterKey(`${key}/${field}`);
        const tag = (t?.[field] as Tag | undefined) ?? c;
        if (!parsed || !isRegisterValue(parsed, fieldValue, tag[0])) return `state holds a malformed ${key}/${field}`;
        regs.set(field, { v: fieldValue, t: tagged(tag) });
      }
      if (regs.size === 0) return `state holds ${key} with no registers`;
      if (!createsAreWhole(new Map([[key, new Set(regs.keys())]]))) return `state holds ${key} without all its fields`;
      if (!groupsShareTags(coll, regs)) return `state holds ${key} with a field group split across tags`;
      state.rec.set(key, regs);
    }
  }

  if (!Array.isArray(value.unit)) return "state unit is not a list";
  for (const entry of value.unit as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 3 || !isString(entry[0]) || !isTag(entry[2])) return "state unit entry is malformed";
    const [key, unitValue, t] = entry as [string, unknown, Tag];
    const parsed = parseRegisterKey(key);
    if (!parsed || parsed.kind === "field" || !isRegisterValue(parsed, unitValue, t[0])) return `state holds a malformed ${key}`;
    // As in opProblem: only a genesis sets the categories.
    if (parsed.kind === "categories" && compareTags(t, GENESIS_TAG) !== 0) return "state holds categories a genesis did not set";
    if (state.unit.has(key)) return `state holds ${key} twice`;
    state.unit.set(key, { v: unitValue, t: tagged(t) });
  }

  if (!Array.isArray(value.del)) return "state del is not a list";
  for (const entry of value.del as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 4) return "state del entry is malformed";
    const [key, by, L, vv] = entry as unknown[];
    if (!isString(key) || !parseRecordKey(key) || !isDeviceId(by) || !isLamport(L) || !isVersionVector(vv)) return "state del entry is malformed";
    if (state.del.has(key)) return `state deletes ${key} twice`;
    state.del.set(key, { by, L, vv });
    greatestL = Math.max(greatestL, L);
  }

  if (!Array.isArray(value.ra) || !value.ra.every(isReapplyMarker)) return "state ra is malformed";
  for (const marker of value.ra as string[]) {
    if (state.ra.has(marker)) return "state ra repeats a marker";
    state.ra.add(marker);
  }

  if (!isVersionVector(seen) || !isLamportOrZero(maxL)) return "state seen or maxL is malformed";
  // maxL is the greatest L joined (section 2.3), never a free number: one
  // above everything held would raise every joiner's next L for nothing,
  // up to where no device can allocate another.
  if (Math.max(greatestL, ...Object.values(seen)) !== maxL) return "state maxL is not the greatest L it holds";
  state.seen = new Map(Object.entries(seen));
  state.maxL = maxL;
  return state;
}

// --- Files ---------------------------------------------------------------------

interface GenesisFile {
  fv: number;
  kind: "genesis";
  epoch: string;
  reason: "create" | "restore";
  by: string;
  at: number;
  /** What the restoring device had seen: the restore cut (section 9.2). */
  basedOn: { epoch: string; seen: VersionVector } | null;
  doc: LedgerDocument;
}

interface LogFile {
  fv: number;
  kind: "log";
  epoch: string;
  device: string;
  /** In a new epoch's first log: the epoch and device this one replaced. */
  prev?: { epoch: string; device: string };
  /** K: every own op at or below it is in the device's snap. */
  snapThrough: number;
  chain: string;
  /** Own ops with L > snapThrough, ascending. */
  ops: Op[];
}

interface SnapFile {
  fv: number;
  kind: "snap";
  epoch: string;
  device: string;
  through: number;
  chain: string;
  seen: VersionVector;
  maxL: number;
  /** The file versions this state already includes: name to blob sha. */
  joined: Record<string, string>;
  state: CompactState;
}

/** A file that passed (with a snap's state decoded), or why it is refused:
 * "needsUpdate" for a newer format version, "malformed" for anything else.
 * Either way the file is not joined, and that device's stream halts. */
export type FileCheck =
  | { ok: true; file: GenesisFile | LogFile; state?: undefined }
  | { ok: true; file: SnapFile; state: SyncState }
  | { ok: false; problem: "needsUpdate" | "malformed"; detail: string };

const malformed = (detail: string): FileCheck => ({ ok: false, problem: "malformed", detail });

function genesisProblem(value: Record<string, unknown>): string | null {
  if (!hasKeys(value, ["fv", "kind", "epoch", "reason", "by", "at", "basedOn", "doc"])) return "genesis has the wrong keys";
  if (value.reason !== "create" && value.reason !== "restore") return "genesis reason is malformed";
  if (!isString(value.by) || !isFiniteNumber(value.at)) return "genesis stamp is malformed";
  const basedOn = value.basedOn;
  if (basedOn !== null && !(isPlainObject(basedOn) && hasKeys(basedOn, ["epoch", "seen"]) && isEpochKey(basedOn.epoch) && isRestoreCut(basedOn.seen))) {
    return "genesis basedOn is malformed";
  }
  return isWritableDocument(value.doc) ? null : "genesis document is malformed";
}

function logProblem(value: Record<string, unknown>): string | null {
  if (!hasKeys(value, ["fv", "kind", "epoch", "device", "snapThrough", "chain", "ops"], ["prev"])) return "log has the wrong keys";
  const prev = value.prev;
  if (prev !== undefined && !(isPlainObject(prev) && hasKeys(prev, ["epoch", "device"]) && isEpochKey(prev.epoch) && isDeviceId(prev.device))) {
    return "log prev is malformed";
  }
  if (!isLamportOrZero(value.snapThrough) || !isChain(value.chain) || !Array.isArray(value.ops)) return "log header is malformed";
  let last = value.snapThrough as number;
  const created = new Set<string>();
  for (const op of value.ops as unknown[]) {
    const problem = opProblem(op);
    if (problem) return problem;
    const { L, set } = op as Op;
    if (L <= last) return "log ops are not ascending above snapThrough";
    last = L;
    for (const [key] of set) {
      if (!key.endsWith(`/${CREATE}`)) continue;
      if (created.has(key)) return `log creates ${key.slice(0, -3)} twice`;
      created.add(key);
    }
  }
  return null;
}

/** Checks a decrypted file against the name it was listed under (section
 * 6: the path is not covered by the encryption, so the content must repeat
 * it). */
export function checkRepoFile(name: RepoFile, value: unknown): FileCheck {
  if (!isPlainObject(value)) return malformed("file is not an object");
  if (Number.isSafeInteger(value.fv) && (value.fv as number) > FORMAT_VERSION) {
    return { ok: false, problem: "needsUpdate", detail: `file format ${String(value.fv)} is newer than ${FORMAT_VERSION}` };
  }
  if (value.fv !== FORMAT_VERSION) return malformed("file format version is malformed");
  if (value.kind !== name.kind || value.epoch !== name.epoch) return malformed("file content does not match its name");
  if (name.kind !== "genesis" && value.device !== name.device) return malformed("file content does not match its name");

  if (name.kind === "genesis") {
    const problem = genesisProblem(value);
    return problem ? malformed(problem) : { ok: true, file: value as unknown as GenesisFile };
  }
  if (name.kind === "log") {
    const problem = logProblem(value);
    return problem ? malformed(problem) : { ok: true, file: value as unknown as LogFile };
  }
  if (!hasKeys(value, ["fv", "kind", "epoch", "device", "through", "chain", "seen", "maxL", "joined", "state"])) {
    return malformed("snap has the wrong keys");
  }
  if (!isLamportOrZero(value.through) || !isChain(value.chain)) return malformed("snap header is malformed");
  if (!isVersionVector(value.seen) || !isLamportOrZero(value.maxL)) return malformed("snap seen or maxL is malformed");
  if (!isPlainObject(value.joined) || !Object.entries(value.joined).every(([file, sha]) => parseRepoFileName(file) !== null && isBlobSha(sha))) {
    return malformed("snap joined is malformed");
  }
  const state = decodeState(value.state, value.seen, value.maxL as number);
  if (typeof state === "string") return malformed(state);
  return { ok: true, file: value as unknown as SnapFile, state };
}

// --- Hashes ----------------------------------------------------------------------

/** A device's hash chain before its first op in an epoch. */
export const CHAIN_START = "0".repeat(16);

async function sha256Prefix(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** An op's hash: SHA-256 of its canonical JSON, first 8 bytes, as hex. */
export function opHash(op: Op): Promise<string> {
  return sha256Prefix(canonicalJson(op));
}

/** The chain after an op: H(previous chain, op hash). For fork checks
 * (section 10.3): two histories with equal chains at L are the same. */
export function chainNext(previous: string, hash: string): Promise<string> {
  return sha256Prefix(previous + hash);
}

