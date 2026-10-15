import { decryptDocument, encryptDocument, isKeyParams } from "../crypto";
import { decodeState, encodeState, opProblem, vectorOf, type CompactState } from "./codec";
import { isEpochKey } from "./epoch";
import { checkGroup, type LeftBehindGroup } from "./leftBehind";
import { emptyState, type Op, type SyncState } from "./state";
import { GENESIS_TAG, compareTags, isDeviceId, isLamport, isTag, isVersionVector, type VersionVector } from "./tags";

// What the ledger:sync records hold (design section 10.1), and their
// checks. persist.ts stores text; this module turns the engine's values into
// that text and back. Everything but `meta` is encrypted with the household
// key in the repo files' format (crypto.ts), so nothing on the device is
// plaintext financial data (AC15). A record this build can't read is never
// taken for an empty one: the engine shows `unreadable` (section 12, B13).

/** The local records' format. A `meta` with a greater one was written by a
 * newer build: this one reads nothing and writes nothing over it. */
export const LOCAL_FORMAT_VERSION = 1;

/** The device key (#6) with the header values it was derived for: every
 * record is encrypted with the genesis's salt and iter, as the repo files
 * are (section 6). */
export interface DeviceKey {
  key: CryptoKey;
  salt: string;
  iter: number;
}

/** The `meta` record: ids, counters and shas only, so it is not encrypted. */
export interface SyncMeta {
  formatVersion: number;
  deviceId: string;
  epochKey: string;
  /** The greatest L joined or committed (the state's maxL, section 2.1). */
  maxL: number;
  /** The greatest L of this device's own committed ops in the epoch. */
  ownMaxL: number;
  /** The device's confirmed snapshot point: its log holds own ops above it. */
  K: number;
  /** The own log's blob sha as last confirmed in the repo, and the greatest
   * own L that version holds (K when it holds no op): every own op at or
   * below it is known to be in the repo (section 7 step 5). */
  ownLogSha: string | null;
  ownLogThrough: number;
  /** The blob sha of the last own log text sent, persisted before the PUT,
   * and the greatest own L it holds: a listed own sha equal to it means that
   * send landed, whatever became of its response. */
  lastSentLogSha: string | null;
  lastSentLogThrough: number;
  /** The `snapThrough` of the confirmed own log version and of the last
   * own log text sent. A confirmed log naming a K below meta.K still holds
   * ops the device's snapshot covers: the trim (section 8.1 step 4) is due. */
  ownLogK: number;
  lastSentLogK: number;
  /** The own snap's blob sha as last confirmed in the repo (its `through`
   * is K), the blob sha of the last own snap text sent, persisted before the
   * PUT, and the `through` that text holds (section 8.1 step 3). */
  ownSnapSha: string | null;
  lastSentSnapSha: string | null;
  lastSentSnapThrough: number;
  /** Repo file name to the blob sha this state already includes: only
   * versions this device read and joined itself, never ones another file
   * says it holds (owner decision D24). */
  joined: Record<string, string>;
  seen: VersionVector;
  /** Per other device, what this device read from that device's own files
   * (owner decision D24): the last L of the version of its log joined, and
   * the `through` of the version of its snapshot last joined (the one
   * `joined` names). A log's ops at or below `logReach` are not joined again
   * (that log gave them), and a log whose snapThrough is past both waits
   * for its snapshot (section 8.2); `snapReach` counts only while that
   * snapshot version is still the listed one. Neither is ever `seen`, which
   * another device's snapshot raises on its word alone, and a snapshot's
   * `through` never leaves a log's ops out. */
  logReach: VersionVector;
  snapReach: VersionVector;
  lastSeenCommit: string | null;
  refEtag: string | null;
  /** The tab that may write (section 10.2): every mutation checks it. */
  writerToken: string;
  /** The epoch and device id this device synced as before it switched to
   * this epoch (section 9.3 step 3): written into its log here as `prev`.
   * Absent on a device that started in this epoch. */
  prev?: { epoch: string; device: string };
  /** The epoch this epoch's genesis is based on (its `basedOn.epoch`), when
   * it has one: kept in `old` while the device stays in this epoch, since
   * another restore of the same number may be based on it with another cut
   * (section 9.4). When this device never joined that epoch (it skipped
   * it), the epoch it kept that this epoch's line reaches first instead
   * (#adoptEpoch's anchor). Absent on a device that started in this
   * epoch. */
  basedOn?: string;
  /** The salt and iterations of the key the device is sealed under, once
   * it joined a racing create's winner (D32) and so is sealed under
   * another key than the one it started with: a start with another key
   * knows, without the network, which one to ask for. Absent otherwise. */
  sealedWith?: { salt: string; iter: number };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isLamportOrZero = (value: unknown) => value === 0 || isLamport(value);
/** `logReach` or `snapReach`: a 0 entry holds nothing, as an absent one.
 * The engine never stores one, but a meta that holds one (an earlier stage 5
 * build stored a snapshot's through 0) still loads, so no repo file can
 * leave a device unreadable through its reach. */
const isReach = (value: unknown) => isPlainObject(value) && Object.entries(value).every(([device, L]) => isDeviceId(device) && isLamportOrZero(L));
const isShaOrNull =(value: unknown) => value === null || (typeof value === "string" && /^[0-9a-f]{40}$/.test(value));
const isTextOrNull = (value: unknown) => value === null || typeof value === "string";

const META_KEYS = [
  "formatVersion",
  "deviceId",
  "epochKey",
  "maxL",
  "ownMaxL",
  "K",
  "ownLogSha",
  "ownLogThrough",
  "lastSentLogSha",
  "lastSentLogThrough",
  "ownLogK",
  "lastSentLogK",
  "ownSnapSha",
  "lastSentSnapSha",
  "lastSentSnapThrough",
  "joined",
  "seen",
  "logReach",
  "snapReach",
  "lastSeenCommit",
  "refEtag",
  "writerToken",
];

/** What a stored `meta` is: usable, written by a newer build, or malformed. */
export type MetaCheck = { ok: true; meta: SyncMeta } | { ok: false; problem: "newer" | "malformed"; detail: string };

export function checkMeta(value: unknown): MetaCheck {
  if (!isPlainObject(value)) return { ok: false, problem: "malformed", detail: "meta is not an object" };
  const fv = value.formatVersion;
  if (Number.isSafeInteger(fv) && (fv as number) > LOCAL_FORMAT_VERSION) {
    return { ok: false, problem: "newer", detail: `local format ${String(fv)} is newer than ${LOCAL_FORMAT_VERSION}` };
  }
  const bad = (detail: string): MetaCheck => ({ ok: false, problem: "malformed", detail });
  if (fv !== LOCAL_FORMAT_VERSION) return bad("meta format version is malformed");
  const keys = Object.keys(value).filter((key) => key !== "prev" && key !== "basedOn" && key !== "sealedWith");
  if (keys.length !== META_KEYS.length || !META_KEYS.every((key) => Object.hasOwn(value, key))) return bad("meta has the wrong keys");
  const prev = value.prev;
  if (prev !== undefined && !(isPlainObject(prev) && Object.keys(prev).length === 2 && isEpochKey(prev.epoch) && isDeviceId(prev.device))) return bad("meta prev is malformed");
  if (value.basedOn !== undefined && !isEpochKey(value.basedOn)) return bad("meta basedOn is malformed");
  const sealed = value.sealedWith;
  if (sealed !== undefined && !(isPlainObject(sealed) && Object.keys(sealed).length === 2 && isKeyParams(sealed.salt, sealed.iter))) return bad("meta sealedWith is malformed");
  if (!isDeviceId(value.deviceId) || !isEpochKey(value.epochKey)) return bad("meta ids are malformed");
  if (![value.maxL, value.ownMaxL, value.K, value.ownLogThrough, value.lastSentLogThrough, value.ownLogK, value.lastSentLogK, value.lastSentSnapThrough].every(isLamportOrZero)) return bad("meta counters are malformed");
  if (![value.ownLogSha, value.lastSentLogSha, value.ownSnapSha, value.lastSentSnapSha, value.lastSeenCommit].every(isShaOrNull)) return bad("meta shas are malformed");
  if (!isTextOrNull(value.refEtag) || typeof value.writerToken !== "string") return bad("meta tokens are malformed");
  if (!isPlainObject(value.joined) || !Object.values(value.joined).every((sha) => isShaOrNull(sha) && sha !== null)) return bad("meta joined is malformed");
  if (!isVersionVector(value.seen)) return bad("meta seen is malformed");
  if (!isReach(value.logReach) || !isReach(value.snapReach)) return bad("meta reach is malformed");
  return { ok: true, meta: value as unknown as SyncMeta };
}

/** Encrypts a record's value with the device key. */
export function seal(value: unknown, key: DeviceKey): Promise<string> {
  return encryptDocument(value, key.key, { salt: key.salt, iter: key.iter });
}

/** Decrypts a record. Throws (WrongPassphraseError, InvalidFileError) when
 * this key or this build can't read it, or it inflates past `maxPlainBytes`. */
export function unseal(text: string, key: DeviceKey, options?: { maxPlainBytes?: number }): Promise<unknown> {
  return decryptDocument(text, key.key, options);
}

// --- base: the joined state ------------------------------------------------

interface StoredState {
  state: CompactState;
  seen: VersionVector;
  maxL: number;
}

/** A state as the `base` record holds it (codec.ts's compact form). */
export function storedState(state: SyncState): StoredState {
  return { state: encodeState(state), seen: vectorOf(state.seen), maxL: state.maxL };
}

/** The registers a compact state holds under the genesis tag [1, "g"], as a
 * state: what decodeState binds a state's genesis registers to. The local
 * state is checked against its own genesis part, because the device keeps
 * no separate copy of the genesis; anything malformed here is left for
 * decodeState to report. */
function genesisPart(value: unknown): SyncState {
  const genesis = emptyState();
  const isGenesis = (t: unknown) => isTag(t) && compareTags(t, GENESIS_TAG) === 0;
  try {
    const { rec, unit } = value as CompactState;
    for (const coll of ["e", "debt", "emi", "sub"] as const) {
      for (const record of rec[coll]) {
        for (const [field, v] of Object.entries(record.v)) {
          if (!isGenesis(record.t?.[field] ?? record.c)) continue;
          const key = `${coll}/${record.id}`;
          let regs = genesis.rec.get(key);
          if (!regs) genesis.rec.set(key, (regs = new Map()));
          regs.set(field, { v, t: GENESIS_TAG });
        }
      }
    }
    for (const [key, v, t] of unit) if (isGenesis(t)) genesis.unit.set(key, { v, t: GENESIS_TAG });
  } catch {
    // decodeState reports the shape.
  }
  return genesis;
}

/** A `base` record's value back as a state, or why it is malformed. */
export function decodeStoredState(value: unknown): SyncState | string {
  if (!isPlainObject(value) || Object.keys(value).length !== 3 || !Object.hasOwn(value, "state")) return "base has the wrong keys";
  return decodeState(value.state, value.seen as VersionVector, value.maxL as number, genesisPart(value.state));
}

// --- old: the previous epochs' states ----------------------------------------

/** One previous epoch this device synced in, and its state there when a
 * restore replaced it (section 9.3): the epoch last switched from, the one
 * the current epoch's genesis is based on, and any earlier one while a
 * left-behind group from it is unresolved, so a later restore based on
 * that epoch (racing restores) can project it again with its own cut. */
export interface OldEpoch {
  epoch: string;
  device: string;
  state: SyncState;
}

/** A part of a left-behind group (or of a projection) that a genesis
 * held, so a switch didn't offer it: owed again should every epoch in `by`
 * (the epochs whose genesis held it, in the line of the epoch the device is
 * in) turn out not to be in a winner's line, unless something the device
 * left since wrote over it (ADR-0008, #14). */
export interface HeldPart {
  by: string[];
  group: LeftBehindGroup;
}

/** The `old` record: the previous epochs' states, and the parts geneses
 * held (absent in records an earlier build wrote, which read as none). */
export interface OldRecord {
  entries: OldEpoch[];
  held: HeldPart[];
}

/** The `old` record's value. */
export function storedOld(entries: readonly OldEpoch[], held: readonly HeldPart[] = []): unknown {
  return { entries: entries.map(({ epoch, device, state }) => ({ epoch, device, state: storedState(state) })), ...(held.length > 0 ? { held } : {}) };
}

/** An `old` record's value back, or why it is malformed. */
export function decodeOld(value: unknown): OldRecord | string {
  if (!isPlainObject(value) || !Array.isArray(value.entries)) return "old is malformed";
  const entries: OldEpoch[] = [];
  for (const entry of value.entries as unknown[]) {
    if (!isPlainObject(entry) || !isEpochKey(entry.epoch) || !isDeviceId(entry.device)) return "old entry is malformed";
    const state = decodeStoredState(entry.state);
    if (typeof state === "string") return state;
    entries.push({ epoch: entry.epoch, device: entry.device, state });
  }
  const held: HeldPart[] = [];
  if (value.held !== undefined) {
    if (!Array.isArray(value.held)) return "old's held parts are malformed";
    for (const part of value.held as unknown[]) {
      if (!isPlainObject(part) || !Array.isArray(part.by) || part.by.length === 0 || !part.by.every(isEpochKey)) return "old's held part is malformed";
      const group = checkGroup(part.group);
      if (group === null) return "old's held part is malformed";
      held.push({ by: part.by as string[], group });
    }
  }
  return { entries, held };
}

// --- tail and ownLog: deltas ----------------------------------------------

/** One `tail` entry: ops and/or a state joined since `base`. A local op is
 * one op of this device's, and its `ownLog` entry is the same text. */
export interface Delta {
  ops: [device: string, op: Op][];
  state?: StoredState;
}

/** A tail or ownLog value back as a delta, or why it is malformed. */
export function decodeDelta(value: unknown): { ops: [string, Op][]; state?: SyncState } | string {
  if (!isPlainObject(value) || !Array.isArray(value.ops)) return "delta is malformed";
  if (!Object.keys(value).every((key) => key === "ops" || key === "state")) return "delta has the wrong keys";
  const ops: [string, Op][] = [];
  for (const entry of value.ops as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isDeviceId(entry[0])) return "delta op is malformed";
    const problem = opProblem(entry[1]);
    if (problem) return problem;
    ops.push([entry[0], entry[1] as Op]);
  }
  if (value.state === undefined) return { ops };
  const state = decodeStoredState(value.state);
  return typeof state === "string" ? state : { ops, state };
}

/** A chain record's value: 16 hex digits. */
export function isChainValue(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}

