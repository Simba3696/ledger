import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical";
import { CHAIN_START, FORMAT_VERSION, chainNext, checkRepoFile, encodeState, opHash, opProblem, vectorOf, type FileCheck } from "./codec";
import { parseRepoFileName } from "./epoch";
import { createOrderKey, genesisOrderKey } from "./keys";
import { genesisState, type Op, type SyncState } from "./state";
import { MAX_L } from "./tags";
import { Replica, deviceId, docText, emptyDocument, fingerprint } from "./testkit";

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
    ["a sortKey no append can follow (b0)", withSet(createOp(), [[`e/${ID}/sortKey`, "b0"]])],
    ["a sortKey with a trailing 0 (a10)", withSet(createOp(), [[`e/${ID}/sortKey`, "a10"]])],
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
    ["a time zone that is not a zone name (0.zzz)", withSet(createOp(), [["st/timeZone", "0.zzz"]])],
    ["an empty time zone", withSet(createOp(), [["st/timeZone", ""]])],
    ["a time zone with a space", withSet(createOp(), [["st/timeZone", "Asia/New Delhi"]])],
    ["a time zone with a dot segment", withSet(createOp(), [["st/timeZone", "Asia/../UTC"]])],
    ["an EMI asOfDate that is not a calendar day (2026-02-30)", withSet(createOp(), [[`emi/${ID}/remainingAsOf`, "1.00"], [`emi/${ID}/asOfDate`, "2026-02-30"]])],
    ["an EMI asOfDate in month 13", withSet(createOp(), [[`emi/${ID}/remainingAsOf`, "1.00"], [`emi/${ID}/asOfDate`, "2026-13-01"]])],
    ["an EMI target in year 0", withSet(createOp(), [[`emi/${ID}/untilTarget`, "0000-01-01"]])],
    ["a subscription expiry that is not a calendar day", withSet(createOp(), [[`sub/${ID}/expiryAnchor`, "2026-04-31"]])],
    ["a card bill due date that is not a calendar day", withSet(createOp(), [["cb/2026-05", [{ id: ID, updatedAt: 1, updatedBy: "a", name: "Card A", due: "1.00", paid: "0.00", dueDate: "2026-02-29", settled: false }]]])],
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

  it("accepts every IANA zone name shape and every real calendar day", () => {
    for (const zone of ["UTC", "Asia/Kolkata", "America/Argentina/Buenos_Aires", "America/Port-au-Prince", "Etc/GMT+5", "Etc/GMT-14", "EST5EDT", "Not/AZone"]) {
      expect(opProblem(withSet(createOp(), [["st/timeZone", zone]])), zone).toBeNull();
    }
    for (const day of ["2024-02-29", "2026-12-31", "0001-01-01", "9999-12-31"]) {
      expect(opProblem(withSet(createOp(), [[`sub/${ID}/expiryAnchor`, day]])), day).toBeNull();
    }
  });
});

// A value the validator accepts must never stop a later local write or read:
// the structural checks may only be loosened within fv 1, so each value the
// local write path can't take has to be refused here, or handled there.
describe("values a remote op may set", () => {
  const X = deviceId(0xa);
  const remote = (L: number, set: [string, unknown][]): Op => ({ L, at: 0, by: "sam", vv: {}, set, del: [] });
  const emiInput = { cardOrBank: "Car Loan", emiAmount: 100, dueDay: 3, totalAmount: 1000, remarks: "", remainingAsOf: 1000, interestRate: null, foreclosureCharge: null };

  it("a well-shaped zone this runtime does not know: writes and reads still work, in UTC", async () => {
    const op = remote(2, [["st/timeZone", "Not/AZone"]]);
    expect(check(LOG, logFile([op])).ok).toBe(true);
    const v = new Replica(D, emptyDocument());
    v.clock = Date.UTC(2026, 4, 10, 22, 0); // 10 May in UTC, 11 May in Asia/Kolkata
    v.receive(X, op);
    expect(v.doc.settings.timeZone).toBe("Not/AZone");
    const emi = await v.backend.addEmi(emiInput);
    expect(v.doc.emis[0].asOfDate).toBe("2026-05-10");
    await v.backend.updateEmi(emi.row, { ...emi, durationMonths: null });
    await v.backend.payEmi(emi.row, 100);
    await v.backend.addSubscription({ service: "Music", amount: 199, duration: "Monthly", expiryAnchor: "2026-05-20", cardOrBank: "Card A" });
    await expect(v.backend.getEmis()).resolves.toHaveLength(1);
    await expect(v.backend.getSubscriptions()).resolves.toHaveLength(1);
    await expect(v.backend.getOverview()).resolves.toBeDefined();
  });

  it("an EMI anchored at 9999-12-31: a payment past year 9999 is refused with a 400 and writes nothing", async () => {
    const v = new Replica(D, emptyDocument());
    const emi = await v.backend.addEmi(emiInput);
    const id = v.doc.emis[0].id;
    const op = remote(10, [[`emi/${id}/remainingAsOf`, "900.00"], [`emi/${id}/asOfDate`, "9999-12-31"]]);
    expect(opProblem(op)).toBeNull();
    v.receive(X, op);
    const before = docText(v.doc);
    await expect(v.backend.payEmi(emi.row, 100)).rejects.toMatchObject({ status: 400 });
    expect(docText(v.doc)).toBe(before);
    // Editing the EMI re-anchors it at today, and payments work again.
    await v.backend.updateEmi(emi.row, { ...emi, durationMonths: null });
    await expect(v.backend.payEmi(emi.row, 100)).resolves.toMatchObject({ asOfDate: expect.stringMatching(/^2026-/) });
  });

  // Stored money may have up to 15 integer digits and any sign, but the
  // local write path stores at most 12 (numeric(14,2)). A payment computes
  // its balance from stored values, so a remote amount can push it past
  // what the diff (or the SQL store) takes: that payment is a 400 with the
  // document untouched, never a 500 from the diff.
  it("an EMI whose payment balance would pass 12 digits: refused with a 400 and writes nothing", async () => {
    // A negative EMI amount is added back for each passed due date.
    const v = new Replica(D, emptyDocument());
    const emi = await v.backend.addEmi(emiInput);
    const id = v.doc.emis[0].id;
    const op = remote(10, [[`emi/${id}/emiAmount`, "-999999999999999.99"]]);
    expect(opProblem(op)).toBeNull();
    v.receive(X, op);
    v.clock = Date.UTC(2026, 7, 10, 6, 0);
    const before = docText(v.doc);
    await expect(v.backend.payEmi(emi.row, 1)).rejects.toMatchObject({ status: 400 });
    expect(docText(v.doc)).toBe(before);
    // Editing the EMI fixes it, and payments work again.
    await v.backend.updateEmi(emi.row, { ...emiInput, durationMonths: null });
    await expect(v.backend.payEmi(emi.row, 100)).resolves.toMatchObject({ remainingAsOf: 900 });

    // A 15-digit balance whose double rounds up to 1e15, paid 0, and one
    // just past 12 digits.
    for (const [stored, status] of [["999999999999999.95", 400], ["1000000000000.00", 400], ["999999999999.99", 200]] as const) {
      const w = new Replica(D, emptyDocument());
      const e = await w.backend.addEmi(emiInput);
      const wid = w.doc.emis[0].id;
      w.receive(X, remote(10, [[`emi/${wid}/remainingAsOf`, stored], [`emi/${wid}/asOfDate`, "2026-05-01"]]));
      const was = docText(w.doc);
      if (status === 400) {
        await expect(w.backend.payEmi(e.row, 0), stored).rejects.toMatchObject({ status: 400 });
        expect(docText(w.doc)).toBe(was);
      } else {
        await expect(w.backend.payEmi(e.row, 0), stored).resolves.toMatchObject({ remainingAsOf: 999999999999.99 });
      }
    }
  });

  // "A" + 25 zeros + "1" is the integer just above the smallest one, which
  // no key may be. A move to the top of its month must not build that key.
  it("an expense keyed just above the smallest integer: moving another entry above it still works", async () => {
    const v = new Replica(D, emptyDocument());
    await v.backend.addEntry({ year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false });
    const id = v.doc.expenses["2026-05"][0].id;
    const op = remote(10, [[`e/${id}/sortKey`, "A" + "0".repeat(25) + "1"], [`e/${id}/_s`, { at: 1, by: "sam" }]]);
    expect(opProblem(op)).toBeNull();
    v.receive(X, op);
    await v.backend.addEntry({ year: 2026, month: 5, amount: 12, remarks: "Lunch", category: "food", isCard: false });
    const rows = await v.backend.getMonth(2026, 5);
    expect(rows.map((row) => row.remarks)).toEqual(["Groceries", "Lunch"]);
    await expect(v.backend.moveEntry(2026, 5, rows[1].row, rows[0].row)).resolves.toBeUndefined();
    expect((await v.backend.getMonth(2026, 5)).map((row) => row.remarks)).toEqual(["Lunch", "Groceries"]);
  });
});

function logFile(ops: Op[], extra: Record<string, unknown> = {}) {
  return { fv: 1, kind: "log", epoch: EPOCH, device: D, snapThrough: 0, chain: CHAIN_START, ops, ...extra };
}

/** Checks `value` as the file `name`, a snap against `genesis` (its epoch's
 * genesis state, which the engine always reads first: section 8.3). */
function check(name: string, value: unknown, genesis: SyncState = genesisState(emptyDocument())): FileCheck {
  return checkRepoFile(parseRepoFileName(name)!, JSON.parse(JSON.stringify(value)), genesis);
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

describe("order keys", () => {
  /** A debt create at `L` whose order key is `o`. */
  const withKey = (o: string, L = 2) => withSet(createOp(L), createOp(L).set.map(([key, value]): [string, unknown] => (key.endsWith("/_c") ? [key, { o }] : [key, value])));

  /** A valid snap holding one more debt, created at `L`, with order key `o`. */
  const snapWithKey = async (o: string, L = 2) => {
    const snap = JSON.parse(JSON.stringify((await snapFile()).file));
    snap.state.rec.debt.push({ id: ID, c: [L, D], v: { _c: { o }, _s: { at: 1, by: "alex" }, name: "Sam", amount: "1.00" } });
    snap.maxL = Math.max(snap.maxL, L);
    snap.seen[D] = Math.max(snap.seen[D], L);
    return snap;
  };

  it("accept exactly the shapes keys.ts makes: a genesis index, or 1.<L>.<device>", async () => {
    const keys: [string, number][] = [[genesisOrderKey(0), 2], [genesisOrderKey(35), 2], [genesisOrderKey(36 ** 6), 2], [createOrderKey(2, D), 2], [createOrderKey(MAX_L - 1, OTHER), MAX_L - 1]];
    for (const [o, L] of keys) {
      expect(opProblem(withKey(o, L)), o).toBeNull();
      expect(check(SNAP, await snapWithKey(o, L)).ok, o).toBe(true);
    }
  });

  // A create's key carries the L of the op that made it, so after the join
  // every device's next L is greater and its own create lists last. A key
  // naming any other L could sort after that next local key (one above
  // 2^50 forever), and the diff would then refuse every later add to the
  // list on every device. The device part is not bound: a rehome (section
  // 10.3) re-issues a create under a new device id with its original L.
  it("accept a create whose key names its op's L and another device (a rehome re-issue)", async () => {
    expect(opProblem(withKey(createOrderKey(5, OTHER), 5))).toBeNull();
    expect(check(LOG, logFile([withKey(createOrderKey(5, OTHER), 5)])).ok).toBe(true);
    expect(check(SNAP, await snapWithKey(createOrderKey(5, OTHER), 5)).ok).toBe(true);
  });

  for (const [name, digits] of [["above its op's", "0000000000000999"], ["below its op's", "0000000000000001"], ["past 2^50", "9999999999999999"]] as const) {
    it(`refuse a create whose key names an L ${name}, in an op, a log and a snap`, async () => {
      const o = `1.${digits}.${OTHER}`;
      expect(opProblem(withKey(o, 2))).not.toBeNull();
      expect(check(LOG, logFile([withKey(o, 2)]))).toMatchObject({ ok: false, problem: "malformed" });
      expect(check(SNAP, await snapWithKey(o, 2))).toMatchObject({ ok: false, problem: "malformed" });
    });
  }

  // Any other text could sort after the key the next local create gets,
  // and the diff, which lists a new record last as push() does, would then
  // refuse every later add to that list on every device.
  for (const o of ["2", "9", "z", "1.2", "1.0000000000000002", "1.0000000000000002.dX", "1.0000000000000002.d000000000000000D", "1.000000000000002.d000000000000000d", "1.00000000000000002.d000000000000000d", "0.", "0.00000", "0.00000A", ""]) {
    it(`refuse ${JSON.stringify(o)}, in an op and in a snap`, async () => {
      expect(opProblem(withKey(o))).not.toBeNull();
      expect(check(SNAP, await snapWithKey(o))).toMatchObject({ ok: false, problem: "malformed" });
    });
  }

  // Re-apply (design section 9.4) runs in the new epoch, where the device
  // has a new id and its L starts again near 1. A list record it re-creates
  // keeps its old id but gets a fresh _c naming the re-apply op's own L, so
  // it lists last, as any create does. Its old _c names an L from the old
  // epoch, which could sort after the next local create's key, so the
  // validator refuses it. An expense keeps its old {m}: no L in it.
  it("accept a re-apply re-create with a fresh order key, and refuse one that keeps its old key", async () => {
    const ra = { ra: [`${EPOCH}/${OTHER}`] };
    const fresh = { ...withKey(createOrderKey(3, D), 3), ...ra };
    expect(opProblem(fresh)).toBeNull();
    expect(check(LOG, logFile([fresh])).ok).toBe(true);
    const stale = { ...withKey(createOrderKey(57, OTHER), 3), ...ra };
    expect(opProblem(stale)).not.toBeNull();
    expect(check(LOG, logFile([stale]))).toMatchObject({ ok: false, problem: "malformed" });
    const expense = {
      L: 3, at: 1, by: "alex", vv: {}, del: [], ...ra,
      set: [
        [`e/${ID}/_c`, { m: "2026-05" }], [`e/${ID}/sortKey`, "a0"], [`e/${ID}/amount`, "12.00"], [`e/${ID}/remarks`, "Lunch"],
        [`e/${ID}/category`, null], [`e/${ID}/cardNote`, null], [`e/${ID}/_s`, { at: 1, by: "alex" }],
      ] as [string, unknown][],
    };
    expect(opProblem(expense)).toBeNull();

    // The re-created record lists last, and a later local add after it.
    const r = new Replica(D, emptyDocument());
    await r.backend.addDebt({ name: "Alex", amount: 5 });
    r.receive(OTHER, { ...withKey(createOrderKey(4, OTHER), 4), ...ra });
    await r.backend.addDebt({ name: "Kim", amount: 7 });
    expect((await r.backend.getDebts()).map((d) => d.name)).toEqual(["Alex", "Sam", "Kim"]);
  });

  it("a remote create the validator accepts never blocks a later local add to that list", async () => {
    const r = new Replica(D, emptyDocument());
    const odd = withKey(createOrderKey(2, OTHER));
    expect(opProblem(odd)).toBeNull();
    r.receive(OTHER, odd);
    await r.backend.addDebt({ name: "Alex", amount: 5 });
    expect((await r.backend.getDebts()).map((d) => d.name)).toEqual(["Sam", "Alex"]);
  });
});

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
    ["a unit tagged by the genesis pseudo-device above L 1", (_f, s) => ((s.unit as unknown[][])[0][2] = [2, "g"])],
    ["a record created by the genesis pseudo-device above L 1", (_f, s) => ((s.rec as { e: { c: unknown }[] }).e[0].c = [2, "g"])],
    ["a field tagged by the genesis pseudo-device above L 1", (_f, s) => ((s.rec as { e: { t?: unknown }[] }).e[0].t = { amount: [2, "g"] })],
    ["a malformed joined sha", (f) => (f.joined = { [GENESIS]: "abc" })],
    ["a joined name that is no repo file", (f) => (f.joined = { "not-a-file": SHA })],
    ["a joined name with a path", (f) => (f.joined = { [`../${GENESIS}`]: SHA })],
    ["a joined name with an uppercase device id", (f) => (f.joined = { [`${EPOCH}.${D.toUpperCase()}.log.enc`]: SHA })],
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

  // maxL is the greatest L the state has joined (design section 2.3), so it
  // is derived from the tags, deletions and seen the snap holds. Carried as
  // a free number it could raise every joiner's maxL to 2^50 - 1, after
  // which no device could allocate another L in the epoch.
  it("refuse a snap whose maxL is not the greatest L it holds", async () => {
    const { file } = await snapFile();
    const genesisOnly = { ...file, through: 0, seen: {}, maxL: 1, state: encodeState(genesisState(emptyDocument())) };
    expect(check(SNAP, genesisOnly).ok).toBe(true);
    for (const maxL of [file.maxL + 1, MAX_L - 1]) expect(check(SNAP, { ...file, maxL }), String(maxL)).toMatchObject({ ok: false, problem: "malformed" });
    expect(check(SNAP, { ...genesisOnly, maxL: 2 })).toMatchObject({ ok: false, problem: "malformed" });
    expect(check(SNAP, { ...genesisOnly, maxL: 0 })).toMatchObject({ ok: false, problem: "malformed" });
  });

  // Every state a device holds has each tag [L, d] and each deletion (L, by)
  // at or below seen[d] (an op sets seen[device] to its L, a join takes the
  // pointwise max). A snap naming a device above its own seen could carry a
  // forged write at an L that device has not reached: its real write at that
  // L would tie on the tag, and the tie goes to the greater value, so the
  // forgery could win on every device. It would also mislead the section
  // 8.2 gap check, which trusts seen.
  it("refuse a snap holding a tag or deletion above its seen for that device", async () => {
    const { file } = await snapFile();
    expect(check(SNAP, file).ok).toBe(true);
    const seenD = file.seen[D];
    const spoils: [string, (f: Record<string, unknown>, s: Record<string, unknown>) => void][] = [
      ["a unit tagged by a device it has not seen", (_f, s) => (s.unit as unknown[]).push(["lk/2026-06", true, [2, OTHER]])],
      ["a field tagged above its own device's seen", (f, s) => {
        (s.rec as { e: { t?: unknown }[] }).e[0].t = { remarks: [seenD + 1, D] };
        f.maxL = seenD + 1;
      }],
      ["a deletion by a device it has not seen", (_f, s) => ((s.del as unknown[][])[0][1] = OTHER)],
      ["a seen entry lowered below its device's tags", (f) => (f.seen = { [D]: 1 })],
    ];
    for (const [name, spoil] of spoils) {
      const copy = JSON.parse(JSON.stringify(file));
      spoil(copy, copy.state);
      expect(check(SNAP, copy), name).toMatchObject({ ok: false, problem: "malformed", detail: expect.stringContaining("above its seen") });
    }
    // The same tags pass once seen covers them.
    const covered = JSON.parse(JSON.stringify(file));
    covered.state.unit.push(["lk/2026-06", true, [2, OTHER]]);
    covered.seen = { ...covered.seen, [OTHER]: 2 };
    expect(check(SNAP, covered).ok).toBe(true);
  });

  // The validator answers ok or a refusal, never a throw: a throw could
  // escape the engine's per-file handling, which halts only that device's
  // stream (section 12). Spreading a seen vector this large into one
  // Math.max call exceeds the engine's argument limit.
  it("answers, never throws, on a snap whose seen vector is very large", async () => {
    const { file } = await snapFile();
    const seen = Object.fromEntries(Array.from({ length: 300_000 }, (_, i) => [deviceId(i + 1), 1]));
    const huge = { ...file, through: 0, seen, maxL: 1, state: encodeState(genesisState(emptyDocument())) };
    expect(check(SNAP, huge).ok).toBe(true);
  });

  // Only a genesis sets the categories (design section 2.2), and an op that
  // sets them is refused. A snap must not be a way round that: a joiner
  // would take its categories over the genesis's, republish them, and
  // refuse every edit that keeps an expense's old category.
  it("refuse a snap whose categories were set by anything but the genesis, as an op is refused", async () => {
    const { file } = await snapFile();
    expect(check(SNAP, file).ok).toBe(true);
    const only = [{ id: "only", label: "Only", bg: "#000000", fg: null, position: 0 }];
    expect(opProblem(withSet(createOp(), [["cat", only]]))).not.toBeNull();
    for (const tag of [[2, D], [2, OTHER], [file.maxL, D]]) {
      const copy = JSON.parse(JSON.stringify(file));
      copy.state.unit = copy.state.unit.map((entry: unknown[]) => (entry[0] === "cat" ? ["cat", only, tag] : entry));
      expect(check(SNAP, copy), JSON.stringify(tag)).toMatchObject({ ok: false, problem: "malformed" });
    }
  });

  // A register tagged [1, "g"] in a snap ties with the genesis's own on
  // join, and an equal tag goes to the greater value. So a snap that holds
  // [1, "g"] with a value the genesis never set, or at a key it never set,
  // would rewrite the genesis on every device whatever the join order. For
  // the categories that is permanent (nothing else writes them), and every
  // later edit that keeps an expense's category is refused as "Unknown
  // category".
  it("refuse a snap holding a genesis-tagged register the genesis does not hold", async () => {
    const { file } = await snapFile();
    expect(check(SNAP, file).ok).toBe(true);
    const g = genesisState(emptyDocument());
    const cats = structuredClone(g.unit.get("cat")!.v) as { label: string }[];
    cats[0].label += "zzz";
    const other = [{ id: "zz", label: "Z", bg: "#FFFFFF", fg: null, position: 0 }];
    const withUnit = (key: string, value: unknown) => (_f: Record<string, unknown>, s: Record<string, unknown>) => {
      s.unit = (s.unit as unknown[][]).filter(([k]) => k !== key).concat([[key, value, [1, "g"]]]);
    };
    const spoils: [string, (f: Record<string, unknown>, s: Record<string, unknown>) => void][] = [
      ["other categories", withUnit("cat", other)],
      ["a category relabelled", withUnit("cat", cats)],
      ["another time zone", withUnit("st/timeZone", "Asia/Karachi")],
      ["a lock the genesis never set", withUnit("lk/2026-07", true)],
      ["a record the genesis never held", (_f, s) => (s.rec as { debt: unknown[] }).debt.push({ id: ID, c: [1, "g"], v: { _c: { o: genesisOrderKey(0) }, _s: { at: 1, by: "a" }, name: "Sam", amount: "1.00" } })],
    ];
    for (const [name, spoil] of spoils) {
      const copy = JSON.parse(JSON.stringify(file));
      spoil(copy, copy.state);
      expect(check(SNAP, copy), name).toMatchObject({ ok: false, problem: "malformed", detail: expect.stringContaining("as the genesis's") });
    }
  });

  it("accept a snap whose genesis-tagged registers are its epoch's genesis's own, and only against that genesis", async () => {
    const doc = emptyDocument();
    doc.debts = [{ id: ID, updatedAt: 1, updatedBy: "a", name: "Sam", amount: "1.00" }];
    const r = new Replica(D, doc);
    const [debt] = await r.backend.getDebts();
    await r.backend.updateDebt(debt.row, { name: "Sam", amount: 2 });
    const file = { fv: 1, kind: "snap", epoch: EPOCH, device: D, through: r.state.maxL, chain: CHAIN_START, seen: vectorOf(r.state.seen), maxL: r.state.maxL, joined: {}, state: encodeState(r.state) };
    const [record] = file.state.rec.debt;
    expect(record.c).toEqual([1, "g"]);
    expect(check(SNAP, file, genesisState(doc)).ok).toBe(true);
    // Another epoch's genesis never held this record.
    expect(check(SNAP, file, genesisState(emptyDocument()))).toMatchObject({ ok: false, problem: "malformed", detail: expect.stringContaining("as the genesis's") });
    // A genesis-tagged field with a value the genesis did not set.
    const renamed = JSON.parse(JSON.stringify(file));
    renamed.state.rec.debt[0].v.name = "Zed";
    expect(check(SNAP, renamed, genesisState(doc))).toMatchObject({ ok: false, problem: "malformed", detail: expect.stringContaining("as the genesis's") });
  });

  it("refuse an op or a snap that splits an EMI's balance pair (remainingAsOf with asOfDate)", async () => {
    const both: [string, unknown][] = [[`emi/${ID}/remainingAsOf`, "1.00"], [`emi/${ID}/asOfDate`, "2026-06-03"]];
    expect(opProblem(withSet(createOp(), both))).toBeNull();
    for (const half of both) expect(opProblem(withSet(createOp(), [half]))).not.toBeNull();

    const r = new Replica(D, emptyDocument());
    await r.backend.addEmi({ cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: null, foreclosureCharge: null });
    const e = (await r.backend.getEmis())[0];
    r.clock += 86_400_000;
    await r.backend.updateEmi(e.row, { ...e, remainingAsOf: 8000, durationMonths: null });
    const file = { fv: 1, kind: "snap", epoch: EPOCH, device: D, through: r.state.maxL, chain: CHAIN_START, seen: vectorOf(r.state.seen), maxL: r.state.maxL, joined: {}, state: encodeState(r.state) };
    expect(check(SNAP, file).ok).toBe(true);
    const split = JSON.parse(JSON.stringify(file));
    const [record] = split.state.rec.emi;
    expect(record.t.remainingAsOf).toEqual(record.t.asOfDate);
    record.t.asOfDate = record.c;
    expect(check(SNAP, split)).toMatchObject({ ok: false, problem: "malformed" });
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
