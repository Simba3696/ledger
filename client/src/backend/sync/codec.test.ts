import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical";
import { CHAIN_START, FORMAT_VERSION, chainNext, checkRepoFile, encodeState, opHash, opProblem, vectorOf, type FileCheck } from "./codec";
import { parseRepoFileName } from "./epoch";
import type { Op } from "./state";
import { Replica, deviceId, emptyDocument, fingerprint } from "./testkit";

// The structural validator and file formats (design sections 3.1, 3.6, 6
// and 12): one test per malformed shape, format-version gating, and name
// and content binding. A refused file is never partly applied.

const D = deviceId(0xd);
const OTHER = deviceId(0xe);
const EPOCH = "e000001-9c1f22aa";
const ID = "6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b";
const SHA = "a".repeat(40);

function createOp(L = 2, id = ID): Op {
  return {
    L,
    at: 1,
    by: "alex",
    vv: { [D]: L - 1 },
    set: [
      [`debt/${id}/_c`, { o: "1.0000000000000002.d000000000000000d" }],
      [`debt/${id}/name`, "Sam"],
      [`debt/${id}/amount`, "12.00"],
      [`debt/${id}/_s`, { at: 1, by: "alex" }],
    ],
    del: [],
  };
}

function withSet(op: Op, set: [string, unknown][]): Op {
  return { ...op, set };
}

describe("op validator", () => {
  it("accepts well-formed ops", () => {
    expect(opProblem(createOp())).toBeNull();
    expect(opProblem({ L: 3, at: 0, by: "", vv: {}, set: [["lk/2026-05", false], ["fm/2026-05", null], ["cb/2026-05", null]], del: [`e/${ID}`], ra: ["e000001-9c1f22aa/d0000000000000001"] })).toBeNull();
  });

  const bad: [string, unknown][] = [
    ["not an object", [1]],
    ["an unknown key", { ...createOp(), extra: 1 }],
    ["a missing key", { L: 2, at: 1, by: "a", vv: {}, set: [] }],
    ["L of 0", { ...createOp(), L: 0 }],
    ["L at 2^50", { ...createOp(), L: 2 ** 50 }],
    ["a fractional L", { ...createOp(), L: 2.5 }],
    ["a non-numeric at", { ...createOp(), at: "now" }],
    ["a vv naming a non-device", { ...createOp(), vv: { g: 1 } }],
    ["a vv with L 0", { ...createOp(), vv: { [D]: 0 } }],
    ["a set entry that is not a pair", withSet(createOp(), [["lk/2026-05", true, 1] as unknown as [string, unknown]])],
    ["an unknown register", withSet(createOp(), [["st/theme", "dark"]])],
    ["a non-uuid record id", withSet(createOp(), [["debt/42/name", "Sam"]])],
    ["a field from another collection", withSet(createOp(), [[`debt/${ID}/sortKey`, "a0"]])],
    ["the categories (genesis only)", withSet(createOp(), [["cat", []]])],
    ["a malformed money string", withSet(createOp(), [[`debt/${ID}/amount`, "12.5"]])],
    ["a number for money", withSet(createOp(), [[`debt/${ID}/amount`, 12]])],
    ["a malformed month key in _c", withSet(createOp(), [[`e/${ID}/_c`, { m: "2026-5" }]])],
    ["an expense _c with an order key", withSet(createOp(), [[`e/${ID}/_c`, { o: "1.2" }]])],
    ["a stamp with extra keys", withSet(createOp(), [[`debt/${ID}/_s`, { at: 1, by: "a", x: 1 }]])],
    ["a lock that is not boolean", withSet(createOp(), [["lk/2026-05", "yes"]])],
    ["a malformed finance month", withSet(createOp(), [["fm/2026-05", { salary: "1.00" }]])],
    ["card bills with a repeated id", withSet(createOp(), [["cb/2026-05", [1, 2].map(() => ({ id: ID, updatedAt: 1, updatedBy: "a", name: "Card A", due: "1.00", paid: "0.00", dueDate: null, settled: false }))]])],
    ["an EMI due day of 32", withSet(createOp(), [[`emi/${ID}/dueDay`, 32]])],
    ["a subscription duration outside the two", withSet(createOp(), [[`sub/${ID}/duration`, "Weekly"]])],
    ["a register set twice", withSet(createOp(), [...createOp().set, [`debt/${ID}/name`, "Alex"]])],
    ["a create missing a field", withSet(createOp(), createOp().set.filter(([k]) => !k.endsWith("/amount")))],
    ["a create missing its stamp", withSet(createOp(), createOp().set.filter(([k]) => !k.endsWith("/_s")))],
    ["a malformed delete key", { ...createOp(), del: [`debt/${ID}/name`] }],
    ["a delete repeated", { ...createOp(), del: [`debt/${ID}`, `debt/${ID}`] }],
    ["a malformed re-apply marker", { ...createOp(), ra: ["e000001/d0000000000000001"] }],
  ];
  for (const [name, op] of bad) {
    it(`refuses ${name}`, () => {
      expect(opProblem(op)).not.toBeNull();
    });
  }
});

function logFile(ops: Op[], extra: Record<string, unknown> = {}) {
  return { fv: 1, kind: "log", epoch: EPOCH, device: D, snapThrough: 0, chain: CHAIN_START, ops, ...extra };
}

function check(name: string, value: unknown): FileCheck {
  return checkRepoFile(parseRepoFileName(name)!, JSON.parse(JSON.stringify(value)));
}

const LOG = `${EPOCH}.${D}.log.enc`;
const SNAP = `${EPOCH}.${D}.snap.enc`;
const GENESIS = `${EPOCH}.genesis.enc`;

async function snapFile() {
  const r = new Replica(D, emptyDocument());
  await r.backend.addEntry({ year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false });
  await r.backend.addDebt({ name: "Sam", amount: 1 });
  await r.backend.deleteDebt((await r.backend.getDebts())[0].row);
  await r.backend.setMonthIncome(2026, 5, { salary: 1, otherIncome: null, savings: [] });
  return { replica: r, file: { fv: 1, kind: "snap", epoch: EPOCH, device: D, through: r.state.maxL, chain: CHAIN_START, seen: vectorOf(r.state.seen), maxL: r.state.maxL, joined: { [GENESIS]: SHA }, state: encodeState(r.state) } };
}

describe("files", () => {
  it("accept a log, a snap (decoded to the same state) and a genesis", async () => {
    expect(check(LOG, logFile([createOp(2), { ...createOp(5), set: [["lk/2026-05", true]] }])).ok).toBe(true);
    const { replica, file } = await snapFile();
    const result = check(SNAP, file);
    expect(result.ok && result.state && fingerprint(result.state)).toBe(fingerprint(replica.state));
    const genesis = { fv: 1, kind: "genesis", epoch: EPOCH, reason: "create", by: "alex", at: 1, basedOn: null, doc: emptyDocument() };
    expect(check(GENESIS, genesis).ok).toBe(true);
    expect(check(GENESIS, { ...genesis, reason: "restore", basedOn: { epoch: EPOCH, seen: { [D]: 4 } } }).ok).toBe(true);
  });

  it("accept a restore genesis whose cut holds 0 for a restorer that wrote no op (section 9.2: seen with {R: ownMaxL})", () => {
    const genesis = { fv: 1, kind: "genesis", epoch: "e000002-0000abcd", reason: "restore", by: "alex", at: 0, doc: emptyDocument() };
    const name = "e000002-0000abcd.genesis.enc";
    expect(check(name, { ...genesis, basedOn: { epoch: "e000001-0000abcd", seen: { [D]: 0 } } }).ok).toBe(true);
    expect(check(name, { ...genesis, basedOn: { epoch: "e000001-0000abcd", seen: { [OTHER]: 7, [D]: 0 } } }).ok).toBe(true);
    // Still refused: a negative or fractional L, a non-device, an L at 2^50.
    for (const seen of [{ [D]: -1 }, { [D]: 0.5 }, { g: 0 }, { [D]: 2 ** 50 }]) {
      expect(check(name, { ...genesis, basedOn: { epoch: "e000001-0000abcd", seen } })).toMatchObject({ ok: false, problem: "malformed" });
    }
  });

  it("gate on the format version: newer is needsUpdate, on every kind, before anything else is read", () => {
    for (const name of [LOG, SNAP, GENESIS]) {
      expect(check(name, { fv: FORMAT_VERSION + 1, whatever: true })).toMatchObject({ ok: false, problem: "needsUpdate" });
      expect(check(name, { kind: "log" })).toMatchObject({ ok: false, problem: "malformed" });
      expect(check(name, { fv: "1" })).toMatchObject({ ok: false, problem: "malformed" });
    }
  });

  it("bind content to the name: a copied file is not credited to another device, epoch or kind", () => {
    const log = logFile([createOp()]);
    expect(check(`${EPOCH}.${OTHER}.log.enc`, log)).toMatchObject({ ok: false, problem: "malformed" });
    expect(check(`e000002-9c1f22aa.${D}.log.enc`, log)).toMatchObject({ ok: false, problem: "malformed" });
    expect(check(SNAP, log)).toMatchObject({ ok: false, problem: "malformed" });
  });

  const badLogs: [string, unknown][] = [
    ["ops not ascending", logFile([createOp(3), { ...createOp(3, "00000000-0000-4000-8000-000000000002") }])],
    ["an op at or below snapThrough", logFile([createOp(4)], { snapThrough: 4 })],
    ["one record created twice", logFile([createOp(2), createOp(3)])],
    ["one malformed op among good ones", logFile([createOp(2), { ...createOp(3, "00000000-0000-4000-8000-000000000002"), L: 2 ** 50 }])],
    ["a malformed chain", logFile([createOp()], { chain: "xyz" })],
    ["a malformed prev", logFile([createOp()], { prev: { epoch: EPOCH } })],
    ["an unknown key", logFile([createOp()], { extra: 1 })],
  ];
  for (const [name, file] of badLogs) {
    it(`refuse a log with ${name}`, () => {
      expect(check(LOG, file)).toMatchObject({ ok: false, problem: "malformed" });
    });
  }

  const badSnaps: [string, (file: Record<string, unknown>, state: Record<string, unknown>) => void][] = [
    ["a tag at 2^50", (_f, s) => ((s.unit as unknown[][])[0][2] = [2 ** 50, D])],
    ["a tag above its maxL", (f) => (f.maxL = 1)],
    ["a record without all its fields", (_f, s) => delete ((s.rec as { e: { v: Record<string, unknown> }[] }).e[0].v.amount)],
    ["a record held twice", (_f, s) => (s.rec as { e: unknown[] }).e.push((s.rec as { e: unknown[] }).e[0])],
    ["a malformed value", (_f, s) => ((s.rec as { e: { v: Record<string, unknown> }[] }).e[0].v.amount = 40)],
    ["a tag on a field it doesn't hold", (_f, s) => ((s.rec as { e: { t?: unknown }[] }).e[0].t = { nope: [2, D] })],
    ["a deletion by the genesis pseudo-device", (_f, s) => ((s.del as unknown[][])[0][1] = "g")],
    ["a malformed joined sha", (f) => (f.joined = { [GENESIS]: "abc" })],
    ["a state with missing parts", (_f, s) => delete s.ra],
  ];
  for (const [name, spoil] of badSnaps) {
    it(`refuse a snap with ${name}`, async () => {
      const { file } = await snapFile();
      const copy = JSON.parse(JSON.stringify(file));
      spoil(copy, copy.state);
      expect(check(SNAP, copy)).toMatchObject({ ok: false, problem: "malformed" });
    });
  }

  it("refuse a genesis whose document is not writable (duplicate ids, deep shapes) or whose basedOn is malformed", () => {
    const doc = emptyDocument();
    const debt = { id: ID, updatedAt: 1, updatedBy: "a", name: "Sam", amount: "1.00" };
    doc.debts = [debt, debt];
    const genesis = { fv: 1, kind: "genesis", epoch: EPOCH, reason: "create", by: "alex", at: 1, basedOn: null, doc };
    expect(check(GENESIS, genesis)).toMatchObject({ ok: false, problem: "malformed" });
    expect(check(GENESIS, { ...genesis, doc: emptyDocument(), basedOn: { epoch: EPOCH } })).toMatchObject({ ok: false, problem: "malformed" });
    expect(check(GENESIS, { ...genesis, doc: emptyDocument(), reason: "merge" })).toMatchObject({ ok: false, problem: "malformed" });
  });
});

describe("compact state", () => {
  it("lists a tag per field only where it differs from the record's create tag", async () => {
    const r = new Replica(D, emptyDocument());
    const entry = await r.backend.addEntry({ year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false });
    await r.backend.updateEntry(2026, 5, entry.row, { amount: 12, remarks: "Groceries", category: "food", isCard: false });
    const [record] = encodeState(r.state).rec.e;
    expect(record.c).toEqual([2, D]);
    expect(record.t).toEqual({ amount: [3, D], _s: [3, D] });
  });

  it("is deterministic: equal states give equal text whatever their insertion order", async () => {
    const { replica } = await snapFile();
    const reversed = { ...replica.state, rec: new Map([...replica.state.rec].reverse()), unit: new Map([...replica.state.unit].reverse()) };
    expect(canonicalJson(encodeState(reversed))).toBe(canonicalJson(encodeState(replica.state)));
  });
});

describe("hashes", () => {
  it("hash an op's canonical JSON to 8 bytes, whatever its key order, and chain them", async () => {
    const op = createOp();
    const shuffled = Object.fromEntries(Object.entries(op).reverse()) as unknown as Op;
    const h = await opHash(op);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(await opHash(shuffled)).toBe(h);
    expect(await opHash({ ...op, L: 3 })).not.toBe(h);
    const chain = await chainNext(CHAIN_START, h);
    expect(chain).toMatch(/^[0-9a-f]{16}$/);
    expect(await chainNext(chain, h)).not.toBe(chain);
  });
});
