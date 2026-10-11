import { expect } from "vitest";
import { createEmptyDocument } from "../document/createDocument";
import { DocumentBackend, type DocumentHost } from "../document/DocumentBackend";
import type { LedgerDocument } from "../document/types";
import { isWritableDocument } from "../document/validate";
import { canonicalJson } from "./canonical";
import { encodeState, opProblem, vectorOf } from "./codec";
import { diffDocuments } from "./diff";
import { FIELDS, TOGETHER, createOrderKey, type Coll } from "./keys";
import { materialize, readerOf, rematerialize } from "./materialize";
import { nextEpochKey } from "./epoch";
import { applyOp, cloneState, genesisState, joinInto, type Op, type SyncState } from "./state";
import { LamportExhausted, newDeviceId, nextLamport } from "./tags";

// Test support for the sync core: a seeded PRNG, fingerprints for comparing
// states and documents, and Replica, an in-memory stand-in for the engine's
// SyncedHost (design section 3.5, without IndexedDB or GitHub) that runs a
// real DocumentBackend over the diff, the join and incremental
// materialisation. Imported only by tests.

/** The environment variables a test run was given, if any. */
export function testEnv(name: string): string | undefined {
  return (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[name];
}

/** mulberry32: a small seeded PRNG, so a failing seed can be replayed. */
export class Rng {
  #t: number;
  constructor(seed: number) {
    this.#t = seed >>> 0;
  }
  next(): number {
    this.#t = (this.#t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(this.#t ^ (this.#t >>> 15), 1 | this.#t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  }
  /** An integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  /** A uuid-shaped id, from this generator. */
  uuid(): string {
    const hex = Array.from({ length: 32 }, () => this.int(16).toString(16)).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
  }
}

/** Runs `run` once per seed; a failure names its seed and how to replay it. */
export async function forEachSeed(count: number, run: (seed: number) => void | Promise<void>): Promise<void> {
  const only = testEnv("LEDGER_SIM_SEED");
  const seeds = only !== undefined ? [Number(only)] : Array.from({ length: count }, (_, i) => i + 1);
  for (const seed of seeds) {
    try {
      await run(seed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`seed ${seed} failed (replay with LEDGER_SIM_SEED=${seed}): ${message}`, { cause: err });
    }
  }
}

/** A test device id: "d" and 16 hex digits. */
export function deviceId(n: number): string {
  return `d${n.toString(16).padStart(16, "0")}`;
}

export const ALL_MODULES = ["expenses", "finances", "debts", "emi", "credit-cards", "subscriptions"] as const;

export function emptyDocument(): LedgerDocument {
  return createEmptyDocument({ modules: [...ALL_MODULES], timeZone: "UTC" });
}

/** Canonical text of a state: equal states, equal text. */
export function fingerprint(state: SyncState): string {
  return canonicalJson({ ...encodeState(state), seen: vectorOf(state.seen), maxL: state.maxL });
}

/** Canonical text of a document, `tombstones` left out (sync keeps deletes
 * in its own deleted set). */
export function docText(doc: LedgerDocument): string {
  return canonicalJson({ ...doc, tombstones: [] });
}

/** One replica of the ledger: a sync state, the document materialised from
 * it, and a DocumentBackend whose commits go through the diff. Ops it makes
 * are kept in `ops` (its log) and handed to `onOp`. With `checks` on, every
 * commit and join also checks the section 15 invariants: the materialised
 * state equals the committed document (AC3), incremental materialisation
 * equals full, and the document is writable.
 *
 * When no L is left (LamportExhausted), it does what the engine does: it
 * restores its current document as the next epoch, under a new device id,
 * keeps the genesis it would PUT in `geneses`, and commits the write in the
 * new epoch. */
export class Replica implements DocumentHost {
  device: string;
  epoch: string;
  readonly geneses: Record<string, unknown>[] = [];
  state: SyncState;
  doc: LedgerDocument;
  readonly ops: Op[] = [];
  readonly backend: DocumentBackend;
  clock: number;
  checks = true;
  onOp?: (device: string, op: Op) => void;
  #lastL = 0;

  constructor(device: string, genesis: LedgerDocument | SyncState, options: { actor?: string; clock?: number; newId?: () => string; epoch?: string } = {}) {
    this.device = device;
    this.epoch = options.epoch ?? "e000001-00000000";
    this.state = "rec" in genesis ? cloneState(genesis) : genesisState(genesis);
    this.doc = materialize(this.state);
    this.clock = options.clock ?? Date.UTC(2026, 4, 10, 6, 0);
    this.backend = new DocumentBackend({
      host: this,
      now: () => this.clock,
      actor: options.actor ?? "alex",
      newId: options.newId ?? (() => crypto.randomUUID()),
    });
  }

  current(): LedgerDocument {
    return this.doc;
  }

  async commit(next: LedgerDocument): Promise<void> {
    this.commitNow(next);
  }

  /** The commit path, synchronously: diff, allocate L, join, swap. `ra`
   * is the re-apply markers the op carries (section 9.4). */
  commitNow(next: LedgerDocument, ra?: string[]): Op | null {
    let L: number;
    try {
      L = nextLamport(this.state.maxL, this.#lastL);
    } catch (err) {
      if (!(err instanceof LamportExhausted)) throw err;
      this.#restoreAsNextEpoch();
      L = nextLamport(this.state.maxL, this.#lastL);
    }
    const body = diffDocuments(this.state, this.doc, next, { L, device: this.device });
    if (!body) return null;
    this.#lastL = L;
    const op: Op = { L, at: this.clock, by: "alex", vv: vectorOf(this.state.seen), ...body, ...(ra ? { ra } : {}) };
    expect(opProblem(op)).toBeNull();
    this.receive(this.device, op);
    if (this.checks) expect(docText(this.doc)).toBe(docText(next));
    this.ops.push(op);
    this.onOp?.(this.device, op);
    return op;
  }

  /** A write made directly on a copy of the document (a stand-in for
   * SyncedHost.amend and for #8's updateSettings), carrying the re-apply
   * markers `ra` if given. */
  amend(run: (doc: LedgerDocument) => void, ra?: string[]): Op | null {
    const next = structuredClone(this.doc);
    run(next);
    return this.commitNow(next, ra);
  }

  /** Section 9.2 with the current document as the backup: a genesis whose
   * cut is everything this device has seen and written, then the new
   * epoch's genesis state under a new device id. `current()` reads the same
   * before and after, so a write diffed against it commits unchanged. */
  #restoreAsNextEpoch(): void {
    const seen = { ...vectorOf(this.state.seen), [this.device]: this.state.seen.get(this.device) ?? 0 };
    const from = this.epoch;
    this.epoch = nextEpochKey(from);
    this.geneses.push({ fv: 1, kind: "genesis", epoch: this.epoch, reason: "restore", by: "alex", at: this.clock, basedOn: { epoch: from, seen }, doc: structuredClone(this.doc) });
    this.device = newDeviceId();
    this.state = genesisState(this.doc);
    this.doc = materialize(this.state);
    this.#lastL = 0;
  }

  /** Joins another device's op. */
  receive(device: string, op: Op): void {
    const changes = applyOp(this.state, device, op);
    this.#swap(changes);
  }

  /** Joins a whole state (a snapshot, or a batch of ops). */
  receiveState(other: SyncState): void {
    this.#swap(joinInto(this.state, other));
  }

  #swap(changes: ReturnType<typeof joinInto>): void {
    this.doc = rematerialize(this.doc, readerOf(this.state), changes);
    if (this.checks) {
      expect(docText(this.doc)).toBe(docText(materialize(this.state)));
      expect(isWritableDocument(this.doc)).toBe(true);
    }
  }
}

// --- Random ops, straight from the register model --------------------------

const MONTHS = ["2026-05", "2026-06"];
const MONEY = ["1.00", "12.00", "40.00", "-5.50"];
const DATES = ["2026-05-20", "2026-06-05"];
const NAMES = ["Sam", "Alex", "Card A"];

/** A value for one field register, from small pools so values collide. */
function fieldValue(rng: Rng, coll: string, field: string): unknown {
  const money = () => rng.pick(MONEY);
  switch (`${coll}.${field}`) {
    case "e.sortKey":
      return rng.pick(["a0", "a1", "a2", "Zz", "a0V"]);
    case "e.category":
      return rng.pick(["food", "travel", null]);
    case "e.cardNote":
      return rng.pick([null, "CC"]);
    case "emi.dueDay":
      return 1 + rng.int(31);
    case "emi.asOfDate":
    case "sub.expiryAnchor":
      return rng.pick(DATES);
    case "emi.untilTarget":
      return rng.pick([null, ...DATES]);
    case "emi.interestRate":
    case "emi.foreclosureCharge":
      return rng.pick([null, "9.500", "1.000"]);
    case "sub.duration":
      return rng.pick(["Monthly", "Yearly"]);
  }
  return field.toLowerCase().includes("amount") || ["due", "paid", "remainingAsOf"].includes(field) ? money() : rng.pick(NAMES);
}

function unitValue(rng: Rng, family: string): unknown {
  if (family === "lk") return rng.chance(0.5);
  if (rng.chance(0.25)) return null;
  if (family === "fm") {
    return { salary: rng.pick([null, "100.00"]), otherIncome: rng.pick([null, "5.00"]), savings: rng.chance(0.5) ? [] : [{ name: rng.pick(NAMES), amount: rng.pick(MONEY) }] };
  }
  const cards = ["00000000-0000-4000-8000-00000000c001", "00000000-0000-4000-8000-00000000c002"].slice(0, 1 + rng.int(2));
  return cards.map((id) => ({ id, updatedAt: rng.int(5), updatedBy: rng.pick(NAMES), name: rng.pick(NAMES), due: rng.pick(MONEY), paid: rng.pick(MONEY), dueDate: rng.pick([null, ...DATES]), settled: rng.chance(0.5) }));
}

/** Record keys a run's random ops pick from. */
export type RecordPool = string[];

/** A random valid op: creates, field edits, deletes, month units,
 * settings and re-apply markers, over the records in `pool` (creates add
 * to it). Ops are not causally sensible; the join must not care. */
export function randomOp(rng: Rng, L: number, pool: RecordPool): Op {
  const set: [string, unknown][] = [];
  const del: string[] = [];
  const op: Op = { L, at: rng.int(1000), by: rng.pick(NAMES), vv: {}, set, del };
  const parts = 1 + rng.int(3);
  const used = new Set<string>();
  const put = (key: string, value: unknown) => {
    if (used.has(key)) return;
    used.add(key);
    set.push([key, value]);
  };
  for (let i = 0; i < parts; i++) {
    const kind = rng.int(10);
    if (kind < 3 || pool.length === 0) {
      const coll = rng.pick(["e", "e", "debt", "emi", "sub"]);
      const rk = `${coll}/${rng.uuid()}`;
      pool.push(rk);
      put(`${rk}/_c`, coll === "e" ? { m: rng.pick(MONTHS) } : { o: createOrderKey(L, deviceId(1 + rng.int(2))) });
      for (const field of FIELDS[coll as Coll]) put(`${rk}/${field}`, fieldValue(rng, coll, field));
      put(`${rk}/_s`, { at: rng.int(1000), by: rng.pick(NAMES) });
    } else if (kind < 6) {
      const rk = rng.pick(pool);
      const coll = rk.slice(0, rk.indexOf("/"));
      for (const picked of rng.shuffle(FIELDS[coll as Coll]).slice(0, 1 + rng.int(2))) {
        // A field group is set whole, as the diff writes it.
        const group = TOGETHER[coll as Coll].find((g) => g.includes(picked)) ?? [picked];
        for (const field of group) put(`${rk}/${field}`, fieldValue(rng, coll, field));
      }
      if (rng.chance(0.8)) put(`${rk}/_s`, { at: rng.int(1000), by: rng.pick(NAMES) });
    } else if (kind < 7) {
      const rk = rng.pick(pool);
      if (!del.includes(rk)) del.push(rk);
    } else if (kind < 9) {
      const family = rng.pick(["fm", "cb", "lk"]);
      put(`${family}/${rng.pick(MONTHS)}`, unitValue(rng, family));
    } else if (rng.chance(0.5)) {
      if (rng.chance(0.5)) put("st/timeZone", rng.pick(["UTC", "Asia/Kolkata"]));
      else put("st/modules", rng.chance(0.5) ? [...ALL_MODULES] : ["expenses"]);
    } else {
      op.ra = [`e000001-0000000${rng.int(2)}/${deviceId(rng.int(3) + 1)}`];
    }
  }
  expect(opProblem(op)).toBeNull();
  return op;
}
