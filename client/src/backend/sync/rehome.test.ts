import { describe, expect, it } from "vitest";
import type { LedgerDocument } from "../document/types";
import { CHAIN_START, checkRepoFile, opProblem } from "./codec";
import { parseRepoFileName } from "./epoch";
import { materialize } from "./materialize";
import { rehomeReissue } from "./rehome";
import { applyOp, cloneState, genesisState, type Op, type SyncState } from "./state";
import { Replica, deviceId, docText, emptyDocument } from "./testkit";

// Rehome after a fork (design section 10.3, as ADR-0008 amends step 4). Two
// engines shared device id D and wrote different ops at the same L. The one
// that rehomes rebuilds its state from the epoch's files, which hold the
// other's ops under D, and re-issues under its new id D' what the rebuild
// lost, keeping each original L. Rehome must never be refused, so the log
// it writes must pass the validator, and nothing it wrote may be lost.

const D = deviceId(0xd);
const D2 = deviceId(0xe); // D', after D as a string, so a re-issue wins D's equal-L writes
const EPOCH = "e000001-9c1f22aa";
const EMI = { cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: null, foreclosureCharge: null };

/** The state rebuilt from the epoch's files: the genesis and the other
 * instance's ops under D. */
function rebuild(genesis: LedgerDocument, ops: readonly Op[]): SyncState {
  const state = genesisState(genesis);
  for (const op of ops) applyOp(state, D, op);
  return state;
}

/** The re-issued ops as D' would write them, after checking the log they
 * make passes the validator whole. */
function reissue(pre: SyncState, rebuilt: SyncState): Op[] {
  const ops = rehomeReissue(pre, rebuilt, D).map((body): Op => ({ ...body, at: 0, by: "alex", vv: {} }));
  for (const op of ops) expect(opProblem(op), JSON.stringify(op)).toBeNull();
  const log = { fv: 1, kind: "log", epoch: EPOCH, device: D2, snapThrough: 0, chain: CHAIN_START, ops };
  expect(checkRepoFile(parseRepoFileName(`${EPOCH}.${D2}.log.enc`)!, JSON.parse(JSON.stringify(log)))).toMatchObject({ ok: true });
  return ops;
}

/** The rebuilt state with the re-issued ops joined, as a document. */
function afterRehome(rebuilt: SyncState, ops: readonly Op[]): LedgerDocument {
  const state = cloneState(rebuilt);
  for (const op of ops) applyOp(state, D2, op);
  return materialize(state);
}

describe("rehome re-issue (section 10.3 step 4)", () => {
  it("re-issues a create whole at its L, though a later write tagged some of its fields", async () => {
    const one = new Replica(D, emptyDocument());
    const two = new Replica(D, emptyDocument());
    await one.backend.addDebt({ name: "Sam", amount: 10 }); // L 2
    await one.backend.updateDebt(1, { name: "Sam", amount: 20 }); // L 3
    await two.backend.setMonthLock(2026, 5, true); // L 2
    await two.backend.setMonthLock(2026, 6, true); // L 3
    const rebuilt = rebuild(emptyDocument(), two.ops);

    const ops = reissue(one.state, rebuilt);
    expect(ops.map((op) => op.L)).toEqual([2, 3]);
    const id = one.doc.debts[0].id;
    expect(ops[0].set.map(([key]) => key).sort()).toEqual([`debt/${id}/_c`, `debt/${id}/_s`, `debt/${id}/amount`, `debt/${id}/name`]);

    const doc = afterRehome(rebuilt, ops);
    expect(doc.debts.map((d) => [d.name, d.amount])).toEqual([["Sam", "20.00"]]);
    expect(Object.keys(doc.monthLocks).sort()).toEqual(["2026-05", "2026-06"]);
  });

  it("re-issues an EMI's balance pair whole, though only one of the pair differs from the rebuild", async () => {
    const seed = new Replica(D, emptyDocument());
    await seed.backend.addEmi(EMI);
    const genesis = structuredClone(seed.doc);
    const one = new Replica(D, genesis);
    const two = new Replica(D, genesis);
    one.clock = two.clock = Date.UTC(2026, 5, 10, 6, 0);
    await one.backend.payEmi((await one.backend.getEmis())[0].row, 1000); // L 2
    await two.backend.payEmi((await two.backend.getEmis())[0].row, 500); // L 2: the same asOfDate, another balance
    expect(one.doc.emis[0].asOfDate).toBe(two.doc.emis[0].asOfDate);
    expect(one.doc.emis[0].remainingAsOf).not.toBe(two.doc.emis[0].remainingAsOf);
    const rebuilt = rebuild(genesis, two.ops);

    const ops = reissue(one.state, rebuilt);
    const id = one.doc.emis[0].id;
    expect(ops).toHaveLength(1);
    expect(ops[0].set.map(([key]) => key)).toEqual(expect.arrayContaining([`emi/${id}/remainingAsOf`, `emi/${id}/asOfDate`]));

    const doc = afterRehome(rebuilt, ops);
    expect(docText({ ...doc, tombstones: [] })).toBe(docText({ ...one.doc, tombstones: [] }));
  });

  it("re-issues deletions and units the rebuild lacks, and nothing the rebuild already holds", async () => {
    const one = new Replica(D, emptyDocument());
    await one.backend.addDebt({ name: "Sam", amount: 10 }); // L 2
    const two = new Replica(D, one.state);
    await one.backend.deleteDebt(1); // L 3
    await one.backend.setMonthIncome(2026, 5, { salary: 100, otherIncome: null, savings: [] }); // L 4
    await two.backend.setMonthLock(2026, 5, true); // L 3
    const rebuilt = rebuild(emptyDocument(), [one.ops[0], ...two.ops]);

    const ops = reissue(one.state, rebuilt);
    const id = one.state.del.keys().next().value!;
    expect(ops.map((op) => [op.L, op.set.map(([key]) => key), op.del])).toEqual([
      [3, [], [id]],
      [4, ["fm/2026-05"], []],
    ]);
    const doc = afterRehome(rebuilt, ops);
    expect(doc.debts).toEqual([]);
    expect(doc.financeMonths["2026-05"]).toBeDefined();
    expect(doc.monthLocks).toEqual({ "2026-05": true });
  });
});
