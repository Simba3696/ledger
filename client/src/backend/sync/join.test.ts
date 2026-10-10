import { describe, expect, it } from "vitest";
import type { LedgerDocument } from "../document/types";
import { isWritableDocument } from "../document/validate";
import { canonicalJson } from "./canonical";
import { decodeState, encodeState, vectorOf } from "./codec";
import { FIELDS, TOGETHER, parseRegisterKey, type Coll } from "./keys";
import { materialize } from "./materialize";
import { applyOp, cloneState, emptyState, genesisState, join, joinInto, opState, type Op, type SyncState } from "./state";
import { Replica, Rng, deviceId, docText, emptyDocument, fingerprint, forEachSeed, randomOp, testEnv, type RecordPool } from "./testkit";

// The join's laws (design sections 2.3 and 16.1): commutative, associative
// and idempotent over random states, and materialise(join(...)) independent
// of the order, duplication and batching of one op set, equal-tag forks
// included. Replica checks incremental materialisation against full after
// every join.

const LAW_SEEDS = Number(testEnv("LEDGER_LAW_SEEDS") ?? 1000);
const ORDER_SEEDS = Number(testEnv("LEDGER_ORDER_SEEDS") ?? 300);
const DEVICES = [deviceId(1), deviceId(2), deviceId(3)];

type Delivery = { device: string; op: Op };

/** A genesis with one record of each kind, whose keys join the pool. */
function genesisFor(rng: Rng, pool: RecordPool): { doc: LedgerDocument; state: SyncState } {
  const doc = emptyDocument();
  const stamp = { updatedAt: 1, updatedBy: "alex" };
  const ids = [rng.uuid(), rng.uuid(), rng.uuid(), rng.uuid()];
  doc.expenses["2026-05"] = [{ id: ids[0], ...stamp, sortKey: "a0", amount: "40.00", remarks: "Groceries", category: "food", cardNote: null }];
  doc.debts = [{ id: ids[1], ...stamp, name: "Sam", amount: "500.00" }];
  doc.emis = [{ id: ids[2], ...stamp, cardOrBank: "Car Loan", emiAmount: "1000.00", dueDay: 5, totalAmount: "12000.00", remarks: "", remainingAsOf: "9000.00", asOfDate: "2026-05-05", untilTarget: null, interestRate: "9.500", foreclosureCharge: null }];
  doc.subscriptions = [{ id: ids[3], ...stamp, service: "Music", amount: "199.00", duration: "Monthly", expiryAnchor: "2026-05-20", cardOrBank: "Card A" }];
  doc.monthLocks["2026-06"] = true;
  pool.push(`e/${ids[0]}`, `debt/${ids[1]}`, `emi/${ids[2]}`, `sub/${ids[3]}`);
  return { doc, state: genesisState(doc) };
}

/** The same tag with different content: what a cloned device produces. */
function forkOf(rng: Rng, op: Op): Op {
  const set = op.set.map(([key, value]): [string, unknown] => {
    const parsed = parseRegisterKey(key);
    if (!rng.chance(0.6) || !parsed || (parsed.kind === "field" && parsed.field === "_c")) return [key, value];
    if (parsed.kind === "field" && parsed.field === "_s") return [key, { at: rng.int(1000), by: "fork" }];
    if (parsed.kind === "field") {
      const pool = new Rng(rng.int(1e9));
      const twin = randomOp(pool, op.L, [`${parsed.coll}/${parsed.id}`]);
      return twin.set.find(([k]) => k === key) ?? [key, value];
    }
    return [key, value];
  });
  return { ...op, set, vv: { [DEVICES[rng.int(3)]]: 1 + rng.int(9) } };
}

/** A random op set from 3 devices with clashing Ls, some of them forks. */
function randomOps(rng: Rng, pool: RecordPool, count: number): Delivery[] {
  const ops: Delivery[] = [];
  for (let i = 0; i < count; i++) {
    if (ops.length > 0 && rng.chance(0.15)) {
      const original = rng.pick(ops);
      ops.push({ device: original.device, op: forkOf(rng, original.op) });
    } else {
      ops.push({ device: rng.pick(DEVICES), op: randomOp(rng, 2 + rng.int(8), pool) });
    }
  }
  return ops;
}

function stateOf(deliveries: readonly Delivery[], base: SyncState = emptyState()): SyncState {
  const state = cloneState(base);
  for (const { device, op } of deliveries) applyOp(state, device, op);
  return state;
}

describe("join: unit rules", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const op = (L: number, set: [string, unknown][], del: string[] = []): Op => ({ L, at: 0, by: "x", vv: {}, set, del });

  it("keeps, per register, the value with the greater tag: L first, then device id", () => {
    const a = opState(DEVICES[0], op(3, [[`debt/${id}/name`, "A"]]));
    const b = opState(DEVICES[1], op(3, [[`debt/${id}/name`, "B"]]));
    const c = opState(DEVICES[0], op(4, [[`debt/${id}/name`, "C"]]));
    expect(join(a, b).rec.get(`debt/${id}`)?.get("name")?.v).toBe("B");
    expect(join(join(a, b), c).rec.get(`debt/${id}`)?.get("name")?.v).toBe("C");
  });

  it("orders an equal tag (a fork) by canonical value, so both sides agree", () => {
    const a = opState(DEVICES[0], op(3, [["fm/2026-05", { salary: "1.00", otherIncome: null, savings: [] }]]));
    const b = opState(DEVICES[0], op(3, [["fm/2026-05", { salary: "2.00", otherIncome: null, savings: [] }]]));
    expect(fingerprint(join(a, b))).toBe(fingerprint(join(b, a)));
    expect(join(a, b).unit.get("fm/2026-05")!.v).toMatchObject({ salary: "2.00" });
  });

  it("is remove-wins: a delete stands against any edit, whatever its tag, and the edit's registers are kept", () => {
    const { state } = genesisFor(new Rng(1), []);
    const rk = [...state.rec.keys()].find((k) => k.startsWith("debt/"))!;
    const deleted = join(state, opState(DEVICES[0], op(2, [], [rk])));
    const edited = join(deleted, opState(DEVICES[1], op(9, [[`${rk}/name`, "Late edit"], [`${rk}/_s`, { at: 1, by: "sam" }]])));
    expect(materialize(edited).debts).toEqual([]);
    expect(edited.rec.get(rk)?.get("name")?.v).toBe("Late edit");
  });

  it("keeps the greater (L, by) of two deletions, unions ra, and takes seen and maxL pointwise", () => {
    const rk = `debt/${id}`;
    const a = opState(DEVICES[0], { ...op(5, [], [rk]), ra: ["e000001-00000000/d0000000000000001"] });
    const b = opState(DEVICES[1], { ...op(4, [], [rk]), ra: ["e000001-00000001/d0000000000000002"] });
    const joined = join(a, b);
    expect(joined.del.get(rk)).toEqual({ by: DEVICES[0], L: 5, vv: {} });
    expect([...joined.ra].sort()).toEqual(["e000001-00000000/d0000000000000001", "e000001-00000001/d0000000000000002"]);
    expect(vectorOf(joined.seen)).toEqual({ [DEVICES[0]]: 5, [DEVICES[1]]: 4 });
    expect(joined.maxL).toBe(5);
  });

  it("does not change its inputs", () => {
    const rng = new Rng(7);
    const pool: RecordPool = [];
    const a = stateOf(randomOps(rng, pool, 8));
    const b = stateOf(randomOps(rng, pool, 8));
    const [fa, fb] = [fingerprint(a), fingerprint(b)];
    join(a, b);
    expect([fingerprint(a), fingerprint(b)]).toEqual([fa, fb]);
  });
});

describe("join: an equal tag (a fork) on a field group", () => {
  const EMI = "00000000-0000-4000-8000-0000000000e1";
  const genesis = () => {
    const doc = emptyDocument();
    doc.emis = [{ id: EMI, updatedAt: 1, updatedBy: "alex", cardOrBank: "Car Loan", emiAmount: "1000.00", dueDay: 5, totalAmount: "12000.00", remarks: "", remainingAsOf: "10000.00", asOfDate: "2026-04-05", untilTarget: null, interestRate: null, foreclosureCharge: null }];
    return genesisState(doc);
  };
  /** A payEmi-shaped op at L 5: the balance pair, set whole. */
  const pay = (remainingAsOf: string, asOfDate: string): Op => ({
    L: 5,
    at: 0,
    by: "x",
    vv: {},
    set: [[`emi/${EMI}/remainingAsOf`, remainingAsOf], [`emi/${EMI}/asOfDate`, asOfDate], [`emi/${EMI}/_s`, { at: 0, by: "x" }]],
    del: [],
  });
  const pairOf = (state: SyncState) => {
    const emi = materialize(state).emis[0];
    return [emi.remainingAsOf, emi.asOfDate];
  };

  it("takes one op's balance pair whole, never one field from each, in every order", () => {
    // Crossed value orders: by value alone, remainingAsOf would come from
    // the first op and asOfDate from the second.
    const first = pay("9000.00", "2026-05-05");
    const second = pay("8000.00", "2026-06-05");
    const written = [["9000.00", "2026-05-05"], ["8000.00", "2026-06-05"]];
    const one = genesis();
    applyOp(one, DEVICES[0], first);
    applyOp(one, DEVICES[0], second);
    const other = genesis();
    applyOp(other, DEVICES[0], second);
    applyOp(other, DEVICES[0], first);
    const a = join(genesis(), opState(DEVICES[0], first));
    const b = join(genesis(), opState(DEVICES[0], second));
    for (const state of [one, other, join(a, b), join(b, a)]) expect(written).toContainEqual(pairOf(state));
    expect(fingerprint(one)).toBe(fingerprint(other));
    expect(fingerprint(join(a, b))).toBe(fingerprint(join(b, a)));
  });

  it(`keeps every group whole over ${ORDER_SEEDS} random op sets with forks: its values all come from one op`, async () => {
    await forEachSeed(ORDER_SEEDS, (seed) => {
      const rng = new Rng(seed);
      const pool: RecordPool = [];
      const { state: genesisOfRun } = genesisFor(rng, pool);
      const ops = randomOps(rng, pool, 10 + rng.int(30));
      const state = stateOf(ops, genesisOfRun);
      for (const [rk, regs] of state.rec) {
        const coll = rk.slice(0, rk.indexOf("/")) as Coll;
        for (const group of TOGETHER[coll]) {
          if (!regs.has(group[0])) continue;
          const sources = [genesisOfRun.rec.get(rk), ...ops.map(({ device, op }) => opState(device, op).rec.get(rk))];
          const written = sources.filter((regsOf) => regsOf?.has(group[0])).map((regsOf) => group.map((field) => regsOf!.get(field)!.v));
          expect(written, `${rk} ${group.join("+")}`).toContainEqual(group.map((field) => regs.get(field)!.v));
        }
      }
    });
  }, 120_000);
});

describe("genesis", () => {
  it("is every register tagged [1, g], list order kept, and materialises back to the document", () => {
    const rng = new Rng(3);
    const { doc, state } = genesisFor(rng, []);
    doc.debts.push({ id: rng.uuid(), updatedAt: 2, updatedBy: "sam", name: "Alex", amount: "1.00" });
    doc.debts.reverse();
    doc.tombstones.push({ id: "gone", deletedAt: 1 });
    const fresh = genesisState(doc);
    for (const regs of fresh.rec.values()) for (const reg of regs.values()) expect(reg.t).toEqual([1, "g"]);
    expect(fresh.maxL).toBe(1);
    expect(docText(materialize(fresh))).toBe(docText(doc));
    expect(docText(materialize(state))).not.toBe(docText(doc));
  });

  it("refuses a malformed genesis document (duplicate ids, deep shapes)", () => {
    const doc = emptyDocument();
    const debt = { id: "00000000-0000-4000-8000-000000000001", updatedAt: 1, updatedBy: "a", name: "Sam", amount: "1.00" };
    doc.debts = [debt, { ...debt }];
    expect(() => genesisState(doc)).toThrow(/malformed/);
  });
});

describe(`join laws over ${LAW_SEEDS} random states`, () => {
  it("is commutative, associative and idempotent", async () => {
    await forEachSeed(LAW_SEEDS, (seed) => {
      const rng = new Rng(seed);
      const pool: RecordPool = [];
      const { state: genesis } = genesisFor(rng, pool);
      const ops = randomOps(rng, pool, 6 + rng.int(14));
      const randomState = () => stateOf(ops.filter(() => rng.chance(0.5)), rng.chance(0.5) ? genesis : emptyState());
      const [a, b, c] = [randomState(), randomState(), randomState()];
      expect(fingerprint(join(a, b))).toBe(fingerprint(join(b, a)));
      expect(fingerprint(join(join(a, b), c))).toBe(fingerprint(join(a, join(b, c))));
      expect(fingerprint(join(a, a))).toBe(fingerprint(a));
      // A state survives its compact encoding (a snapshot) unchanged.
      const decoded = decodeState(JSON.parse(canonicalJson(encodeState(a))), vectorOf(a.seen), a.maxL, genesis);
      expect(typeof decoded === "string" ? decoded : fingerprint(decoded)).toBe(fingerprint(a));
    });
  }, 120_000);
});

describe(`materialise(join) over ${ORDER_SEEDS} random op sets`, () => {
  it("is the same whatever the order, duplication and batching, forks included; incremental equals full throughout", async () => {
    await forEachSeed(ORDER_SEEDS, (seed) => {
      const rng = new Rng(seed);
      const pool: RecordPool = [];
      const { state: genesis } = genesisFor(rng, pool);
      const ops = randomOps(rng, pool, 10 + rng.int(30));
      const reference = stateOf(ops, genesis);
      const expected = { state: fingerprint(reference), doc: docText(materialize(reference)) };
      expect(isWritableDocument(materialize(reference))).toBe(true);

      for (let trial = 0; trial < 4; trial++) {
        const replica = new Replica(DEVICES[0], genesis);
        const stream = rng.shuffle([...ops, ...ops.filter(() => rng.chance(0.3))]);
        while (stream.length > 0) {
          const batch = stream.splice(0, 1 + rng.int(4));
          if (batch.length === 1) replica.receive(batch[0].device, batch[0].op);
          else replica.receiveState(stateOf(batch));
        }
        expect(fingerprint(replica.state)).toBe(expected.state);
        expect(docText(replica.doc)).toBe(expected.doc);
      }
    });
  }, 120_000);

  it("covers every collection and field the document has (the generator is not blind to one)", () => {
    const rng = new Rng(11);
    const pool: RecordPool = [];
    const keys = new Set<string>();
    for (let i = 0; i < 400; i++) for (const [key] of randomOp(rng, 2, pool).set) {
      const parsed = parseRegisterKey(key)!;
      keys.add(parsed.kind === "field" ? `${parsed.coll}.${parsed.field}` : parsed.kind === "month" ? parsed.family : parsed.kind);
    }
    for (const coll of Object.keys(FIELDS) as Coll[]) for (const field of [...FIELDS[coll], "_c", "_s"]) expect(keys).toContain(`${coll}.${field}`);
    for (const unit of ["fm", "cb", "lk", "setting"]) expect(keys).toContain(unit);
  });

  it("joinInto reports what changed, and nothing when joining what is already there", () => {
    const rng = new Rng(5);
    const pool: RecordPool = [];
    const { state } = genesisFor(rng, pool);
    const other = stateOf(randomOps(rng, pool, 10), state);
    const target = cloneState(state);
    expect(joinInto(target, other).units.size).toBeGreaterThan(0);
    expect(joinInto(target, other)).toEqual({ records: new Set(), units: new Set() });
  });
});
