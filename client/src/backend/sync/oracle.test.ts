import { describe, expect, it } from "vitest";
import type { LedgerDocument } from "../document/types";
import { winningEpoch } from "./epoch";
import { parseRegisterKey } from "./keys";
import { materialize } from "./materialize";
import { documentOf, documentText, fold, holds, obligations, plainText, winnerOf, writesOf, type OracleOp } from "./oracle";
import { applyOp, cloneState, genesisState, type Op } from "./state";
import { Rng, deviceId, docText, emptyDocument, forEachSeed, randomOp, testEnv, type RecordPool } from "./testkit";

// The harness's oracle (oracle.ts) against hand-worked cases, and against
// the engine's own join and materialisation over random op sets: two
// implementations written apart that must agree. Fictional data only.

const SEEDS = Number(testEnv("LEDGER_ORACLE_SEEDS") ?? 300);
const [A, B, C] = [deviceId(0xa), deviceId(0xb), deviceId(0xc)];
const ID = "00000000-0000-4000-8000-000000000001";
const EMI = "00000000-0000-4000-8000-000000000002";
const stamp = { updatedAt: 1, updatedBy: "alex" };

function genesis(): LedgerDocument {
  const doc = emptyDocument();
  doc.expenses["2026-05"] = [{ id: ID, ...stamp, sortKey: "a0", amount: "40.00", remarks: "Groceries", category: "food", cardNote: null }];
  doc.emis = [{ id: EMI, ...stamp, cardOrBank: "Car Loan", emiAmount: "1000.00", dueDay: 5, totalAmount: "12000.00", remarks: "", remainingAsOf: "9000.00", asOfDate: "2026-05-05", untilTarget: null, interestRate: "9.500", foreclosureCharge: null }];
  return doc;
}

const op = (L: number, set: [string, unknown][], del: string[] = []): Op => ({ L, at: 0, by: "x", vv: {}, set, del });

/** The engine's answer for the same input: genesis state, every op joined. */
function engineDoc(doc: LedgerDocument, ops: readonly OracleOp[]): string {
  const state = cloneState(genesisState(doc));
  for (const { device, op: o } of ops) applyOp(state, device, o);
  return docText(materialize(state));
}

describe("oracle: hand-worked cases", () => {
  it("keeps the greatest tag per register: L, then device id, then (a fork) the greater canonical value", () => {
    const doc = genesis();
    const amount = (L: number, d: string, v: string): OracleOp => ({ device: d, op: op(L, [[`e/${ID}/amount`, v]]) });
    const value = (ops: OracleOp[]) => documentOf(fold(doc, ops)).expenses["2026-05"][0].amount;
    expect(value([amount(3, A, "1.00"), amount(2, B, "2.00")])).toBe("1.00");
    expect(value([amount(3, A, "1.00"), amount(3, B, "2.00")])).toBe("2.00");
    expect(value([amount(3, B, "3.00"), amount(3, B, "12.00")])).toBe("3.00"); // "\"3.00\"" > "\"12.00\""
    expect(value([amount(3, B, "12.00"), amount(3, B, "3.00")])).toBe("3.00");
  });

  it("deletes stick, whatever the tags around them", () => {
    const doc = genesis();
    const ops: OracleOp[] = [
      { device: A, op: op(2, [], [`e/${ID}`]) },
      { device: B, op: op(9, [[`e/${ID}/amount`, "5.00"]]) },
    ];
    expect(documentOf(fold(doc, ops)).expenses["2026-05"]).toBeUndefined();
    expect(engineDoc(doc, ops)).toBe(documentText(documentOf(fold(doc, ops))));
  });

  it("takes an EMI's balance pair whole from one write, a fork included", () => {
    const doc = genesis();
    const pay = (d: string, amount: string, date: string): OracleOp => ({ device: d, op: op(4, [[`emi/${EMI}/remainingAsOf`, amount], [`emi/${EMI}/asOfDate`, date]]) });
    const ops = [pay(A, "8000.00", "2026-06-05"), pay(A, "9000.00", "2026-05-01")];
    const emi = documentOf(fold(doc, ops)).emis[0];
    expect([emi.remainingAsOf, emi.asOfDate]).toEqual(["9000.00", "2026-05-01"]);
    expect(engineDoc(doc, ops)).toBe(documentText(documentOf(fold(doc, ops))));
    expect(() => fold(doc, [{ device: A, op: op(5, [[`emi/${EMI}/asOfDate`, "2026-07-05"]]) }])).toThrow(/half/);
  });

  it("lists genesis records first in backup order, then new ones by their order key", () => {
    const doc = genesis();
    const other = "00000000-0000-4000-8000-000000000003";
    const create = (L: number, d: string, id: string): OracleOp => ({
      device: d,
      op: op(L, [
        [`debt/${id}/_c`, { o: `1.${String(L).padStart(16, "0")}.${d}` }],
        [`debt/${id}/_s`, { at: L, by: "sam" }],
        [`debt/${id}/name`, `Debt ${L}`],
        [`debt/${id}/amount`, "1.00"],
      ]),
    });
    doc.debts = [{ id: ID.replace("1", "9"), ...stamp, name: "Genesis", amount: "5.00" }];
    const names = documentOf(fold(doc, [create(7, B, other), create(3, A, ID)])).debts.map((d) => d.name);
    expect(names).toEqual(["Genesis", "Debt 3", "Debt 7"]);
  });

  it("winnerOf counts only an unbroken run of epoch numbers from 1, as the engine does", () => {
    const keys = ["e000001-00000001", "e000002-0000000a", "e000002-0000000b", "e000004-ffffffff"];
    expect(winnerOf(keys)).toBe("e000002-0000000b");
    expect(winnerOf(keys)).toBe(winningEpoch(keys.map((k) => `${k}.genesis.enc`)));
    expect(winnerOf([])).toBeNull();
    expect(winnerOf(["e000002-0000000b"])).toBeNull();
  });

  it("leaves behind each device's winning writes above the cut, never stamps, and of a record created and deleted above it only the delete", () => {
    const doc = genesis();
    const created = "00000000-0000-4000-8000-000000000004";
    const ops: OracleOp[] = [
      { device: A, op: op(2, [[`e/${ID}/amount`, "1.00"], [`e/${ID}/_s`, { at: 2, by: "alex" }]]) },
      { device: B, op: op(3, [[`e/${ID}/amount`, "2.00"]]) },
      { device: A, op: op(4, [[`e/${created}/_c`, { m: "2026-05" }], [`e/${created}/_s`, { at: 4, by: "alex" }], [`e/${created}/sortKey`, "a1"], [`e/${created}/amount`, "3.00"], [`e/${created}/remarks`, "Bus"], [`e/${created}/category`, null], [`e/${created}/cardNote`, null]]) },
      { device: B, op: op(5, [], [`e/${created}`]) },
      { device: B, op: op(6, [["lk/2026-05", true]]) },
    ];
    // A backup may hold the record (any document, one exported between the
    // create and the delete included), so its delete is owed; a restored
    // ledger without it already holds the delete.
    const left = obligations("e000001-00000001", doc, ops, { [B]: 3 });
    expect(left.map((o) => `${o.device} ${o.kind} ${o.key}`).sort()).toEqual([`${B} del e/${created}`, `${B} set lk/2026-05`]);
    const all = obligations("e000001-00000001", doc, ops, {});
    expect(all.map((o) => `${o.device} ${o.kind} ${o.key}`).sort()).toEqual([`${B} del e/${created}`, `${B} set e/${ID}/amount`, `${B} set lk/2026-05`].sort());
    expect(holds(doc, { epoch: "e", device: B, L: 6, kind: "set", key: "lk/2026-05", value: false })).toBe(true);
    expect(holds(doc, all.find((o) => o.key === `e/${ID}/amount`)!)).toBe(false);
    const deletion = all.find((o) => o.kind === "del")!;
    expect(holds(doc, deletion)).toBe(true);
    const between = documentOf(fold(doc, ops.slice(0, 3)));
    expect(holds(between, deletion)).toBe(false);
  });
});

/** A genesis with one record of each list kind, its keys in the pool. */
function randomGenesis(rng: Rng, pool: RecordPool): LedgerDocument {
  const doc = genesis();
  const [debt, sub] = [rng.uuid(), rng.uuid()];
  doc.debts = [{ id: debt, ...stamp, name: "Sam", amount: "500.00" }];
  doc.subscriptions = [{ id: sub, ...stamp, service: "Music", amount: "199.00", duration: "Monthly", expiryAnchor: "2026-05-20", cardOrBank: "Card A" }];
  doc.monthLocks["2026-06"] = true;
  pool.push(`e/${ID}`, `emi/${EMI}`, `debt/${debt}`, `sub/${sub}`);
  return doc;
}

describe("oracle: agrees with the engine's join and materialisation", () => {
  it(`over ${SEEDS} random op sets from three devices, forks (equal tags) included`, async () => {
    await forEachSeed(SEEDS, (seed) => {
      const rng = new Rng(seed);
      const pool: RecordPool = [];
      const doc = randomGenesis(rng, pool);
      const ops: OracleOp[] = [];
      for (let i = 0, n = 2 + rng.int(25); i < n; i++) {
        if (ops.length > 0 && rng.chance(0.15)) {
          // The same tag with another value: a cloned profile's op.
          const original = rng.pick(ops);
          const twin = randomOp(new Rng(rng.int(1e9)), original.op.L, [...pool]);
          const set = original.op.set.map(([key, value]): [string, unknown] => {
            const parsed = parseRegisterKey(key);
            if (parsed?.kind !== "field" || parsed.field === "_c" || !rng.chance(0.5)) return [key, value];
            return twin.set.find(([k]) => k === key) ?? [key, value];
          });
          ops.push({ device: original.device, op: { ...original.op, set } });
        } else {
          ops.push({ device: rng.pick([A, B, C]), op: randomOp(rng, 2 + rng.int(9), pool) });
        }
      }
      const order = rng.shuffle(ops);
      expect(documentText(documentOf(fold(doc, order)))).toBe(engineDoc(doc, ops));
      // Every write the engine's state holds is one the ops or genesis made.
      const state = cloneState(genesisState(doc));
      for (const { device, op: o } of ops) applyOp(state, device, o);
      const writes = writesOf(doc, ops);
      for (const [rk, regs] of state.rec) for (const [field, reg] of regs) expect(writes.has(`${rk}/${field} ${reg.t[0]} ${reg.t[1]} ${plainText(reg.v)}`)).toBe(true);
    });
    // About 2 s alone; past vitest's 5 s default beside the harness in a
    // full parallel run.
  }, 30_000);
});
