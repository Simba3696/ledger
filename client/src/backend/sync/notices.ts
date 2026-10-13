import { sameValue } from "./canonical";
import { CREATE, STAMP, TOGETHER, parseRecordKey, parseRegisterKey, type Coll } from "./keys";
import { beats, joinRecord, type Op, type Register, type SyncState } from "./state";
import { GENESIS_TAG, isDeviceId, isLamport, isTag, type Tag } from "./tags";

// Notices (design section 4.2): who is told when a concurrent write of
// theirs lost. Nothing blocks and nothing here changes the state: the join
// has already decided every outcome the same way on every device, and a
// notice only tells the device whose write lost, with an action that is a
// new write (noticeActions.ts). Convergence never reads a notice.
//
// When this device (`me`) joins remote data, a notice fires for:
//   1. A register overwrite. A remote op R replaces a register whose tag is
//      one of my ops M, R had not seen M (R.vv[me] < L_M), and R's value
//      differs from mine: section 4's table tells no one for "edit / edit,
//      same field, same value" (ADR-0008, stage 7). Display stamps (`_s`),
//      sortKey and create markers (`_c`) never notify, and neither does a
//      register of a record the join leaves deleted (rule 2 tells that).
//      An EMI's balance pair is one unit (keys.ts TOGETHER): one notice
//      holds the whole pair. It notifies even when both pairs are equal:
//      two payments recorded from the same state give the same pair, and
//      only one is kept (payments are state, not increments; owner decision
//      D20 tells the loser, with "Record again").
//   2. A concurrent delete. A remote delete of a record on which I have a
//      content op M (not `_c`, `_s` or sortKey) that the deleter had not
//      seen (L_M > the deletion's vv[me]).
// For data that arrives in a snapshot rather than a log, the snapshot's
// `seen` stands in for R.vv: the least `seen[me]` of the snapshots holding
// that write, the closest bound on what R had seen (section 12.2 item 6 is
// the case this can miss). A deletion carries its deleter's vv wherever it
// arrives from, so rule 2 is exact.
//
// A notice is keyed by (winner op, loser op), "<L>.<device>/<L>.<device>",
// so one pair is told at most once.

/** Registers that never notify: not content. */
const QUIET_FIELDS = new Set([CREATE, STAMP, "sortKey"]);

/** An EMI's balance pair: a payment, which notifies even at equal values. */
const BALANCE = new Set(["emi/remainingAsOf", "emi/asOfDate"]);

/** A record's name, as a list shows it. */
const NAME_FIELD: Record<Coll, string> = { e: "remarks", debt: "name", emi: "cardOrBank", sub: "service" };

/** An op, as a notice names it: its tag, and who made it when known. */
interface NoticeOp {
  L: number;
  device: string;
  /** The login on the op (display only); null when the write arrived in a
   * snapshot, which names no author. */
  by: string | null;
}

/** What a notice is about: a record (its collection and id, its month for
 * an expense, and its name when it was told), or a month unit or setting
 * (its register key). */
type NoticeTarget = { kind: "record"; coll: Coll; id: string; month: string | null; name: string | null } | { kind: "unit"; key: string };

/** A register of mine that a concurrent write replaced: its key, the value
 * that won and mine. */
interface ReplacedRegister {
  key: string;
  theirs: unknown;
  mine: unknown;
}

/** Rule 1: my write to `target` lost to a concurrent one. */
interface OverwriteNotice {
  kind: "overwrite";
  winner: NoticeOp;
  loser: { L: number; device: string };
  target: NoticeTarget;
  registers: ReplacedRegister[];
}

/** Rule 2: a record I edited was deleted by someone who hadn't seen it. */
interface DeleteNotice {
  kind: "deleted";
  winner: NoticeOp;
  loser: { L: number; device: string };
  target: Extract<NoticeTarget, { kind: "record" }>;
}

/** A notice the join raises, with its key. */
export type Detected = (OverwriteNotice | DeleteNotice) & { key: string };

/** What arrived in one join: other devices' ops, and whole states
 * (snapshots, and a genesis). */
export interface Arrivals {
  ops: readonly (readonly [device: string, op: Op])[];
  states: readonly SyncState[];
}

const opId = (L: number, device: string) => `${L}.${device}`;

/** A notice's key: (winner op, loser op). */
export function noticeKeyOf(winner: { L: number; device: string }, loser: { L: number; device: string }): string {
  return `${opId(winner.L, winner.device)}/${opId(loser.L, loser.device)}`;
}

/** What the writer of `t` had seen of `me`, and who it was, as far as the
 * arrivals tell: the op's vv, or the least `seen` of the states holding the
 * write. Null when nothing that arrived holds it. */
function writerView(t: Tag, arrivals: Arrivals, holds: (state: SyncState) => boolean, me: string): { seenMe: number; by: string | null } | null {
  for (const [device, op] of arrivals.ops) {
    if (device === t[1] && op.L === t[0]) return { seenMe: op.vv[me] ?? 0, by: op.by };
  }
  let least: number | null = null;
  for (const state of arrivals.states) {
    if (!holds(state)) continue;
    const seen = state.seen.get(me) ?? 0;
    if (least === null || seen < least) least = seen;
  }
  return least === null ? null : { seenMe: least, by: null };
}

function sameTag(a: Tag, b: Tag): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** The fields joined as one unit with `field` (its TOGETHER group), or just
 * itself. */
function groupOf(coll: Coll, field: string): readonly string[] {
  return TOGETHER[coll].find((group) => group.includes(field)) ?? [field];
}

function recordTarget(rk: string, regs: ReadonlyMap<string, Register> | undefined): Extract<NoticeTarget, { kind: "record" }> {
  const { coll, id } = parseRecordKey(rk)!;
  const create = regs?.get(CREATE)?.v as { m?: unknown } | undefined;
  const name = regs?.get(NAME_FIELD[coll])?.v;
  return { kind: "record", coll, id, month: coll === "e" && typeof create?.m === "string" ? create.m : null, name: typeof name === "string" ? name : null };
}

/** The notices joining `source` (the join of everything in `arrivals`) into
 * `live` raises for device `me`, by the rules above. Reads only: neither
 * state changes. */
export function detectNotices(live: SyncState, source: SyncState, arrivals: Arrivals, me: string): Detected[] {
  const found = new Map<string, Detected>();
  const isMine = (reg: Register | undefined): reg is Register => reg !== undefined && reg.t[1] === me;
  const isRemote = (t: Tag) => t[1] !== me && !sameTag(t, GENESIS_TAG);

  // Rule 1, record fields.
  for (const [rk, incoming] of source.rec) {
    const mine = live.rec.get(rk);
    if (!mine) continue;
    // A record the join leaves deleted is told by rule 2, or not at all.
    const visible = (mine.has(CREATE) || incoming.has(CREATE)) && !live.del.has(rk) && !source.del.has(rk);
    if (!visible) continue;
    const candidates = [...mine].filter(([field, reg]) => !QUIET_FIELDS.has(field) && isMine(reg) && incoming.has(field));
    if (candidates.length === 0) continue;
    const coll = rk.slice(0, rk.indexOf("/")) as Coll;
    const after = new Map(mine);
    joinRecord(coll, after, incoming);
    const done = new Set<string>();
    for (const [field, reg] of candidates) {
      if (done.has(field)) continue;
      const group = groupOf(coll, field);
      for (const f of group) done.add(f);
      const now = after.get(field)!;
      if (now === reg || !isRemote(now.t)) continue;
      // Whether any value of the unit differs from mine; a balance pair
      // notifies regardless (D20).
      const differs = group.some((f) => !sameValue(after.get(f)?.v, mine.get(f)?.v));
      if (!differs && !BALANCE.has(`${coll}/${field}`)) continue;
      const view = writerView(now.t, arrivals, (state) => {
        const held = state.rec.get(rk)?.get(field);
        return held !== undefined && sameTag(held.t, now.t);
      }, me);
      if (view === null || view.seenMe >= reg.t[0]) continue;
      const winner: NoticeOp = { L: now.t[0], device: now.t[1], by: view.by };
      const loser = { L: reg.t[0], device: me };
      const key = noticeKeyOf(winner, loser);
      let notice = found.get(key);
      if (!notice) found.set(key, (notice = { key, kind: "overwrite", winner, loser, target: recordTarget(rk, after), registers: [] }));
      if (notice.kind !== "overwrite") continue;
      for (const f of group) notice.registers.push({ key: `${rk}/${f}`, theirs: structuredClone(after.get(f)?.v), mine: structuredClone(mine.get(f)?.v) });
    }
  }

  // Rule 1, month units and settings.
  for (const [key, incoming] of source.unit) {
    const reg = live.unit.get(key);
    if (key === "cat" || !isMine(reg) || !beats(incoming, reg) || !isRemote(incoming.t)) continue;
    if (sameValue(incoming.v, reg.v)) continue;
    const view = writerView(incoming.t, arrivals, (state) => {
      const held = state.unit.get(key);
      return held !== undefined && sameTag(held.t, incoming.t);
    }, me);
    if (view === null || view.seenMe >= reg.t[0]) continue;
    const winner: NoticeOp = { L: incoming.t[0], device: incoming.t[1], by: view.by };
    const loser = { L: reg.t[0], device: me };
    const id = noticeKeyOf(winner, loser);
    const notice = found.get(id);
    const register = { key, theirs: structuredClone(incoming.v), mine: structuredClone(reg.v) };
    if (notice?.kind === "overwrite") notice.registers.push(register);
    else if (!notice) found.set(id, { key: id, kind: "overwrite", winner, loser, target: { kind: "unit", key }, registers: [register] });
  }

  // Rule 2.
  for (const [rk, deletion] of source.del) {
    if (live.del.has(rk) || deletion.by === me) continue;
    const regs = live.rec.get(rk);
    if (!regs?.has(CREATE)) continue;
    const seenMe = deletion.vv[me] ?? 0;
    let latest = 0;
    for (const [field, reg] of regs) if (!QUIET_FIELDS.has(field) && isMine(reg) && reg.t[0] > seenMe) latest = Math.max(latest, reg.t[0]);
    if (latest === 0) continue;
    const by = arrivals.ops.find(([device, op]) => device === deletion.by && op.L === deletion.L)?.[1].by ?? null;
    const winner: NoticeOp = { L: deletion.L, device: deletion.by, by };
    const loser = { L: latest, device: me };
    const key = noticeKeyOf(winner, loser);
    if (!found.has(key)) found.set(key, { key, kind: "deleted", winner, loser, target: recordTarget(rk, regs) });
  }
  return [...found.values()];
}

// --- Stored notices -----------------------------------------------------------

/** A remote write the user hadn't seen when they saved (the stale-UI fence,
 * section 3.4): "kept", their save left it and the remote value stands;
 * "replaced", they typed over it. `mine` is the tag of their write. */
interface FenceStored {
  kind: "kept" | "replaced";
  theirs: Tag;
  mine: Tag;
  registers: ReplacedRegister[];
}

/** This device's sync identity was in use elsewhere (section 10.3). */
interface RehomeStored {
  kind: "rehome";
  from: string;
  to: string;
  message: string;
}

/** A notice as this device keeps it (encrypted in ledger:sync): what it
 * says, when this device saw it (`at`, display only) and its place in the
 * order notices arrived (`seq`): the cap drops the lowest. */
export type StoredNotice = (OverwriteNotice | DeleteNotice | FenceStored | RehomeStored) & { seq: number; at: number };

/** At most this many notices are kept; past it, the oldest go. */
export const NOTICE_CAP = 50;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpRef(value: unknown): value is { L: number; device: string } {
  return isPlainObject(value) && isLamport(value.L) && isDeviceId(value.device);
}

function isRegisters(value: unknown): value is ReplacedRegister[] {
  return Array.isArray(value) && value.every((r) => isPlainObject(r) && typeof r.key === "string" && parseRegisterKey(r.key) !== null);
}

function isTarget(value: unknown): value is NoticeTarget {
  if (!isPlainObject(value)) return false;
  if (value.kind === "unit") return typeof value.key === "string" && parseRegisterKey(value.key)?.kind !== "field";
  if (value.kind !== "record" || typeof value.coll !== "string" || typeof value.id !== "string") return false;
  if (parseRecordKey(`${value.coll}/${value.id}`) === null) return false;
  return (value.month === null || typeof value.month === "string") && (value.name === null || typeof value.name === "string");
}

/** A stored notice back, or null when it isn't one this build wrote. A
 * notice an earlier stage stored without `seq` or `at` reads as the oldest. */
export function checkNotice(value: unknown): StoredNotice | null {
  if (!isPlainObject(value)) return null;
  const seq = value.seq ?? 0;
  const at = value.at ?? 0;
  if (!Number.isSafeInteger(seq) || (seq as number) < 0 || typeof at !== "number" || !Number.isFinite(at)) return null;
  const base = { seq: seq as number, at };
  switch (value.kind) {
    case "overwrite":
    case "deleted": {
      const { winner, loser, target } = value;
      if (!isOpRef(winner) || !((winner as { by?: unknown }).by === null || typeof (winner as { by?: unknown }).by === "string") || !isOpRef(loser) || !isTarget(target)) return null;
      if (value.kind === "deleted") return target.kind === "record" ? ({ ...value, ...base } as unknown as StoredNotice) : null;
      return isRegisters(value.registers) && value.registers.length > 0 ? ({ ...value, ...base } as unknown as StoredNotice) : null;
    }
    case "kept":
    case "replaced":
      return isTag(value.theirs) && isTag(value.mine) && isRegisters(value.registers) ? ({ ...value, ...base } as unknown as StoredNotice) : null;
    case "rehome":
      return isDeviceId(value.from) && isDeviceId(value.to) && typeof value.message === "string" ? ({ ...value, ...base } as unknown as StoredNotice) : null;
    default:
      return null;
  }
}

/** The keys to drop so that `count` notices fit the cap, the lowest `seq`
 * (oldest) first, from `kept` (key to seq). */
export function overCap(kept: ReadonlyMap<string, number>, cap = NOTICE_CAP): string[] {
  if (kept.size <= cap) return [];
  return [...kept]
    .sort(([ka, a], [kb, b]) => a - b || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .slice(0, kept.size - cap)
    .map(([key]) => key);
}
