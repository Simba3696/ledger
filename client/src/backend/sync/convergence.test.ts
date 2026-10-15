import { describe, expect, it } from "vitest";
import { ApiError } from "../ApiError";
import type { LedgerDocument } from "../document/types";
import { canonicalJson } from "./canonical";
import { winningEpoch } from "./epoch";
import { parseRecordKey, parseRegisterKey } from "./keys";
import { materialize } from "./materialize";
import { applyAction } from "./noticeActions";
import type { StoredNotice } from "./notices";
import { cloneState, emptyState, genesisState, joinInto, opState, type Op, type SyncState } from "./state";
import { compareTags } from "./tags";
import { ALL_MODULES, Replica, Rng, deviceId, docText, emptyDocument, fingerprint, forEachSeed, testEnv } from "./testkit";

// Convergence (design sections 4 and 16.4, at the level of the pure core):
// replicas running real DocumentBackend writes over the diff, exchanging ops
// in random orders with duplication, batching, snapshot-style whole-state
// joins and loss-then-redelivery. Every replica that has received the same
// op set must materialise identically, and equal a reference fold that
// applies the ops one at a time in tag order with sticky deletes. Then one
// named test per row of the section 4 conflict table (its outcome column;
// the "who is told" column is the notice stage, design step 7).

const SIM_SEEDS = Number(testEnv("LEDGER_SIM_SEEDS") ?? 200);
const SIM_STEPS = Number(testEnv("LEDGER_SIM_STEPS") ?? 80);
const START = Date.UTC(2026, 4, 10, 6, 0);
const DAY = 86_400_000;

type Delivery = { device: string; op: Op };

/** The reference fold (section 16.4's oracle): from the genesis, every op
 * applied one at a time in tag order, each register simply overwritten and
 * each deletion sticky. Independent of the join. */
function referenceFold(genesis: SyncState, published: readonly Delivery[]): SyncState {
  const state = cloneState(genesis);
  const sorted = [...published].sort((a, b) => compareTags([a.op.L, a.device], [b.op.L, b.device]));
  for (const { device, op } of sorted) {
    const t = [op.L, device] as const;
    for (const [key, v] of op.set) {
      const parsed = parseRegisterKey(key)!;
      if (parsed.kind !== "field") {
        state.unit.set(key, { v, t });
        continue;
      }
      const rk = `${parsed.coll}/${parsed.id}`;
      if (!state.rec.has(rk)) state.rec.set(rk, new Map());
      state.rec.get(rk)!.set(parsed.field, { v, t });
    }
    for (const key of op.del) state.del.set(key, { by: device, L: op.L, vv: op.vv });
    for (const marker of op.ra ?? []) state.ra.add(marker);
    for (const marker of op.ab ?? []) state.ab.add(marker);
    state.seen.set(device, Math.max(state.seen.get(device) ?? 0, op.L));
    state.maxL = Math.max(state.maxL, op.L);
  }
  return state;
}

/** A small ledger every replica starts from, written through a backend. */
async function genesisDocument(): Promise<LedgerDocument> {
  const g = new Replica(deviceId(0xf), emptyDocument(), { actor: "alex" });
  await g.backend.addEntry({ year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false });
  await g.backend.addEntry({ year: 2026, month: 5, amount: 15, remarks: "Bus", category: "transportation", isCard: false });
  await g.backend.addDebt({ name: "Sam", amount: 500 });
  await g.backend.addEmi({ cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: 9.5, foreclosureCharge: null });
  await g.backend.addSubscription({ service: "Music", amount: 199, duration: "Monthly", expiryAnchor: "2026-05-20", cardOrBank: "Card A" });
  await g.backend.setMonthIncome(2026, 5, { salary: 50000, otherIncome: null, savings: [] });
  return g.doc;
}

/** One random write of any of the 18 kinds, against random existing rows.
 * Refusals at the origin (a locked month, a disabled module, a missing
 * row) are part of the schedule; a 500 is a failure. */
async function randomWrite(r: Replica, rng: Rng): Promise<void> {
  const b = r.backend;
  const month = rng.pick([5, 6]);
  const amount = () => rng.pick([10, 12, 40, 99.5]);
  const entry = () => ({ amount: amount(), remarks: rng.pick(["Groceries", "Bus", "Rent"]), category: rng.pick(["food", "transportation", "rent"]), isCard: rng.chance(0.3) });
  const row = async (rows: Promise<{ row: number }[]>) => {
    const list = await rows;
    return list.length > 0 ? rng.pick(list).row : 999;
  };
  const emi = () => ({ cardOrBank: rng.pick(["Car Loan", "Bank B"]), emiAmount: rng.pick([500, 1000]), dueDay: rng.pick([5, 20]), totalAmount: 12000, remarks: rng.pick(["", "x"]), remainingAsOf: rng.pick([9000, 8000]), interestRate: rng.pick([9.5, null]), foreclosureCharge: null, durationMonths: rng.pick([null, 12]) });
  const sub = () => ({ service: rng.pick(["Music", "Video"]), amount: rng.pick([199, 499]), duration: rng.pick(["Monthly", "Yearly"] as const), expiryAnchor: rng.pick(["2026-05-20", "2026-06-01"]), cardOrBank: "Card A" });
  try {
    switch (rng.int(20)) {
      case 0:
      case 1:
        await b.addEntry({ year: 2026, month, ...entry() });
        break;
      case 2:
        await b.updateEntry(2026, month, await row(b.getMonth(2026, month)), entry());
        break;
      case 3:
        await b.deleteEntry(2026, month, await row(b.getMonth(2026, month)));
        break;
      case 4:
        await b.moveEntry(2026, month, await row(b.getMonth(2026, month)), await row(b.getMonth(2026, month)));
        break;
      case 5:
        await b.setMonthLock(2026, month, rng.chance(0.4));
        break;
      case 6:
        await b.setMonthIncome(2026, month, { salary: rng.pick([null, 50000, 52000]), otherIncome: rng.pick([null, 10]), savings: rng.chance(0.5) ? [] : [{ name: "Fund A", amount: amount() }] });
        break;
      case 7:
        await b.addDebt({ name: rng.pick(["Sam", "Alex"]), amount: amount() });
        break;
      case 8:
        await b.updateDebt(await row(b.getDebts()), { name: rng.pick(["Sam", "Alex"]), amount: amount() });
        break;
      case 9:
        await b.deleteDebt(await row(b.getDebts()));
        break;
      case 10:
        await b.setMonthBills(2026, month, rng.shuffle(["Card A", "Card B"]).slice(0, rng.int(3)).map((name) => ({ name, due: amount(), paid: rng.pick([0, 10]), dueDate: rng.pick([null, "2026-06-25"]), settled: rng.chance(0.3) })));
        break;
      case 11:
        await b.addEmi(emi());
        break;
      case 12:
        await b.updateEmi(await row(b.getEmis()), emi());
        break;
      case 13:
        await b.payEmi(await row(b.getEmis()), rng.pick([500, 1000]));
        break;
      case 14:
        await b.deleteEmi(await row(b.getEmis()));
        break;
      case 15:
        await b.addSubscription(sub());
        break;
      case 16:
        await b.updateSubscription(await row(b.getSubscriptions()), sub());
        break;
      case 17:
        await b.deleteSubscription(await row(b.getSubscriptions()));
        break;
      case 18: {
        // "Add it back as a new entry" (section 4.1) of a deleted record:
        // a new record, its op naming the dead one in ab (F3).
        const dead = [...r.state.del.keys()].filter((rk) => r.state.rec.get(rk)?.has("_c")).sort();
        if (dead.length === 0) break;
        const rk = rng.pick(dead);
        const { coll, id } = parseRecordKey(rk)!;
        const notice: StoredNotice = { kind: "deleted", winner: { L: 1, device: deviceId(0xf), by: null }, loser: { L: 1, device: r.device }, target: { kind: "record", coll, id, month: null, name: null }, seq: 0, at: 0 };
        r.amend((doc) => applyAction(notice, "addBack", doc, r.state, { now: r.clock, actor: r.actor, newId: () => rng.uuid(), device: r.device }), undefined, [rk]);
        break;
      }
      default:
        // #8's updateSettings: a section switched, or the time zone.
        r.amend((doc) => {
          if (rng.chance(0.5)) doc.settings.timeZone = rng.pick(["UTC", "Asia/Kolkata"]);
          else doc.settings.modules = ALL_MODULES.filter((m) => m === "expenses" || rng.chance(0.8));
        });
    }
  } catch (err) {
    if (!(err instanceof ApiError) || err.status === 500) throw err;
  }
}

/** Add-back ops (op.ab) published over every run, so the harness is seen
 * to exercise them. */
let addBacks = 0;

/** One seeded run: 2-4 replicas, random writes and deliveries, then a
 * quiet period in which every replica receives everything. */
async function simulate(seed: number): Promise<void> {
  const rng = new Rng(seed);
  const genesisDoc = await genesisDocument();
  const genesis = genesisState(genesisDoc);
  const count = 2 + rng.int(3);
  const replicas = Array.from({ length: count }, (_, i) => {
    const r = new Replica(deviceId(i + 1), genesis, { actor: i % 2 ? "sam" : "alex", clock: START + (rng.int(61) - 30) * DAY, newId: () => rng.uuid() });
    return r;
  });
  const published: Delivery[] = [];
  const pending = new Map<Replica, Delivery[]>(replicas.map((r) => [r, []]));
  const lost: [Replica, Delivery][] = [];
  for (const r of replicas) {
    r.onOp = (device, op) => {
      published.push({ device, op });
      for (const other of replicas) if (other !== r) pending.get(other)!.push({ device, op });
    };
  }

  for (let step = 0; step < SIM_STEPS; step++) {
    const r = rng.pick(replicas);
    r.clock += rng.int(3) * DAY - DAY / 2;
    const inbox = pending.get(r)!;
    const action = rng.int(20);
    if (action < 9) {
      await randomWrite(r, rng);
    } else if (action < 14 && inbox.length > 0) {
      // Deliver one, sometimes keeping it to deliver again later.
      const index = rng.int(inbox.length);
      const delivery = inbox[index];
      if (!rng.chance(0.2)) inbox.splice(index, 1);
      r.receive(delivery.device, delivery.op);
    } else if (action < 16 && inbox.length > 0) {
      // A batch, joined as one state.
      const batch = inbox.splice(0, 1 + rng.int(inbox.length));
      const state = emptyState();
      for (const { device, op } of batch) joinInto(state, opState(device, op));
      r.receiveState(state);
    } else if (action < 17) {
      // A snapshot: another replica's whole state.
      r.receiveState(cloneState(rng.pick(replicas).state));
    } else if (action < 19 && inbox.length > 0) {
      // Lost for now; redelivered later.
      lost.push([r, inbox.splice(rng.int(inbox.length), 1)[0]]);
    } else if (lost.length > 0) {
      const [to, delivery] = lost.splice(rng.int(lost.length), 1)[0];
      pending.get(to)!.push(delivery);
    }
  }

  // Quiet period: every replica receives every op, in its own random order,
  // some twice.
  for (const r of replicas) {
    for (const { device, op } of rng.shuffle([...published, ...published.filter(() => rng.chance(0.2))])) r.receive(device, op);
  }

  addBacks += published.filter(({ op }) => op.ab !== undefined).length;
  // No (device, L) was published with two contents.
  const byId = new Map<string, string>();
  for (const { device, op } of published) {
    const id = `${device}/${op.L}`;
    expect(byId.get(id) ?? canonicalJson(op)).toBe(canonicalJson(op));
    byId.set(id, canonicalJson(op));
  }
  // Convergence: equal states (deleted sets included) and equal documents.
  const [first, ...rest] = replicas;
  for (const r of rest) {
    expect(fingerprint(r.state)).toBe(fingerprint(first.state));
    expect(docText(r.doc)).toBe(docText(first.doc));
  }
  // Nothing lost, nothing invented: the reference fold agrees.
  const reference = referenceFold(genesis, published);
  expect(docText(materialize(reference))).toBe(docText(first.doc));
  expect(fingerprint(reference)).toBe(fingerprint(first.state));
}

describe("convergence harness", () => {
  it(`converges on the reference fold over ${SIM_SEEDS} seeds x ${SIM_STEPS} steps`, async () => {
    await forEachSeed(SIM_SEEDS, simulate);
    if (SIM_SEEDS >= 50) expect(addBacks).toBeGreaterThan(0);
  }, 300_000);
});

// --- The conflict table, row by row (section 4) -------------------------------

const A = deviceId(0xa);
const B = deviceId(0xb);

/** Two devices from one genesis, and a sync that hands each the other's ops
 * it hasn't had yet. B's device id is greater, so on an equal L B wins. */
async function pair() {
  const genesis = await genesisDocument();
  const a = new Replica(A, genesis, { actor: "alex" });
  const b = new Replica(B, genesis, { actor: "sam" });
  const sent = { a: 0, b: 0 };
  const sync = () => {
    for (const op of a.ops.slice(sent.a)) b.receive(A, op);
    for (const op of b.ops.slice(sent.b)) a.receive(B, op);
    sent.a = a.ops.length;
    sent.b = b.ops.length;
    expect(fingerprint(a.state)).toBe(fingerprint(b.state));
    expect(docText(a.doc)).toBe(docText(b.doc));
  };
  return { a, b, sync };
}

async function rowOf(r: Replica, remarks: string, month = 5): Promise<number> {
  const rows = await r.backend.getMonth(2026, month);
  return rows.find((e) => e.remarks === remarks)!.row;
}

const remarksIn = (r: Replica) => (r.doc.expenses["2026-05"] ?? []).map((e) => e.remarks);
const groceries = (r: Replica) => r.doc.expenses["2026-05"]?.find((e) => e.remarks.startsWith("Groceries"));
const edit = (amount: number, remarks = "Groceries") => ({ amount, remarks, category: "food", isCard: false });

describe("conflict table (section 4)", () => {
  it("add / add (AC6): both kept, a shared sortKey ordered by id", async () => {
    const { a, b, sync } = await pair();
    await a.backend.addEntry({ year: 2026, month: 5, ...edit(1, "Tea") });
    await b.backend.addEntry({ year: 2026, month: 5, ...edit(2, "Coffee") });
    sync();
    const month = a.doc.expenses["2026-05"];
    expect(month.map((e) => e.remarks).sort()).toEqual(["Bus", "Coffee", "Groceries", "Tea"]);
    const [tea, coffee] = ["Tea", "Coffee"].map((name) => month.find((e) => e.remarks === name)!);
    expect(tea.sortKey).toBe(coffee.sortKey);
    expect(month.indexOf(tea) < month.indexOf(coffee)).toBe(tea.id < coffee.id);
  });

  it("edit / edit, different fields: both kept", async () => {
    const { a, b, sync } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(12));
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(40, "Groceries (veg)"));
    sync();
    expect(groceries(a)).toMatchObject({ amount: "12.00", remarks: "Groceries (veg)" });
  });

  it("edit / edit, same field, same value: that value", async () => {
    const { a, b, sync } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(12));
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(12));
    sync();
    expect(groceries(a)?.amount).toBe("12.00");
  });

  it("edit / edit, same field, different values: the higher tag wins, whoever it is", async () => {
    const equalL = await pair();
    await equalL.a.backend.updateEntry(2026, 5, await rowOf(equalL.a, "Groceries"), edit(10));
    await equalL.b.backend.updateEntry(2026, 5, await rowOf(equalL.b, "Groceries"), edit(12));
    equalL.sync();
    expect(groceries(equalL.a)?.amount).toBe("12.00"); // [2, B] > [2, A]

    const higherL = await pair();
    await higherL.a.backend.setMonthLock(2026, 7, true); // A is one L ahead
    await higherL.a.backend.updateEntry(2026, 5, await rowOf(higherL.a, "Groceries"), edit(10));
    await higherL.b.backend.updateEntry(2026, 5, await rowOf(higherL.b, "Groceries"), edit(12));
    higherL.sync();
    expect(groceries(higherL.a)?.amount).toBe("10.00"); // [3, A] > [2, B]
  });

  it("edit / delete: delete wins, and the edited registers stay in state under the dead id", async () => {
    const { a, b, sync } = await pair();
    const id = groceries(a)!.id;
    await a.backend.setMonthLock(2026, 7, true); // the edit even has the higher tag
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
    await b.backend.deleteEntry(2026, 5, await rowOf(b, "Groceries"));
    sync();
    expect(remarksIn(a)).toEqual(["Bus"]);
    expect(a.state.rec.get(`e/${id}`)?.get("amount")?.v).toBe("10.00");
    expect(a.state.del.has(`e/${id}`)).toBe(true);
  });

  it("move / delete, re-key bystander / delete, stamp-only / delete: delete wins", async () => {
    const { a, b, sync } = await pair();
    await a.backend.moveEntry(2026, 5, await rowOf(a, "Bus"), await rowOf(a, "Groceries"));
    expect(a.amend((doc) => (doc.expenses["2026-05"][0].updatedAt += 1))).toBeNull(); // stamp-only: no op at all
    await b.backend.deleteEntry(2026, 5, await rowOf(b, "Bus"));
    sync();
    expect(remarksIn(a)).toEqual(["Groceries"]);

    // A re-key: two concurrent appends share a key, then a move re-keys the
    // month, sweeping in a record another device deletes.
    const two = await pair();
    await two.a.backend.addEntry({ year: 2026, month: 5, ...edit(1, "Tea") });
    await two.b.backend.addEntry({ year: 2026, month: 5, ...edit(2, "Coffee") });
    two.sync();
    // Groceries moves between the two shared keys, so the month is re-keyed.
    const rows = await two.a.backend.getMonth(2026, 5);
    expect(rows.map((e) => e.remarks).slice(0, 2)).toEqual(["Groceries", "Bus"]);
    await two.a.backend.moveEntry(2026, 5, rows[0].row, rows[2].row);
    const teaId = two.a.doc.expenses["2026-05"].find((e) => e.remarks === "Tea")!.id;
    expect(two.a.ops.at(-1)!.set.map(([key]) => key)).toContain(`e/${teaId}/sortKey`);
    await two.b.backend.deleteEntry(2026, 5, await rowOf(two.b, "Tea"));
    two.sync();
    expect(remarksIn(two.a).sort()).toEqual(["Bus", "Coffee", "Groceries"]);
  });

  it("move / move: sortKey last-writer-wins", async () => {
    const { a, b, sync } = await pair();
    await a.backend.moveEntry(2026, 5, await rowOf(a, "Bus"), await rowOf(a, "Groceries"));
    await b.backend.moveEntry(2026, 5, await rowOf(b, "Groceries"), await rowOf(b, "Bus"));
    const bKey = b.doc.expenses["2026-05"].find((e) => e.remarks === "Groceries")!.sortKey;
    sync();
    expect(groceries(a)?.sortKey).toBe(bKey);
  });

  it("delete / delete: deleted, the greater (L, by) kept", async () => {
    const { a, b, sync } = await pair();
    const id = groceries(a)!.id;
    await a.backend.deleteEntry(2026, 5, await rowOf(a, "Groceries"));
    await b.backend.deleteEntry(2026, 5, await rowOf(b, "Groceries"));
    sync();
    expect(remarksIn(a)).toEqual(["Bus"]);
    expect(a.state.del.get(`e/${id}`)).toMatchObject({ by: B, L: 2 });
  });

  it("delete / re-add: the re-add is a new id, untouched by the delete", async () => {
    const { a, b, sync } = await pair();
    const old = groceries(a)!;
    await a.backend.deleteEntry(2026, 5, await rowOf(a, "Groceries"));
    // "Add it back as a new entry": the same content under a new id.
    await b.backend.addEntry({ year: 2026, month: 5, ...edit(Number(old.amount), "Groceries again") });
    sync();
    expect(remarksIn(a).sort()).toEqual(["Bus", "Groceries again"]);
    expect(groceries(a)!.id).not.toBe(old.id);
  });

  it("lock / edit made offline before seeing the lock: the edit is kept and the month stays locked", async () => {
    const { a, b, sync } = await pair();
    await a.backend.setMonthLock(2026, 5, true);
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(12));
    await b.backend.addEntry({ year: 2026, month: 5, ...edit(3, "Tea") });
    sync();
    expect(a.doc.monthLocks["2026-05"]).toBe(true);
    expect(groceries(a)?.amount).toBe("12.00");
    expect(remarksIn(a)).toContain("Tea");
    await expect(a.backend.addEntry({ year: 2026, month: 5, ...edit(1, "Late") })).rejects.toMatchObject({ status: 403 });
  });

  it("lock / unlock: last writer wins", async () => {
    const { a, b, sync } = await pair();
    await a.backend.setMonthLock(2026, 5, true); // [2, A]
    await b.backend.setMonthLock(2026, 5, true); // [2, B]
    await b.backend.setMonthLock(2026, 5, false); // [3, B]
    sync();
    expect(a.doc.monthLocks["2026-05"]).toBeUndefined();
  });

  it("setMonthIncome / setMonthIncome and setMonthBills / setMonthBills: the whole unit, higher tag wins", async () => {
    const { a, b, sync } = await pair();
    await a.backend.setMonthIncome(2026, 6, { salary: 100, otherIncome: null, savings: [{ name: "Fund A", amount: 5 }] });
    await b.backend.setMonthIncome(2026, 6, { salary: null, otherIncome: 50, savings: [] });
    await a.backend.setMonthBills(2026, 6, [{ name: "Card A", due: 900, paid: 0, dueDate: null, settled: false }]);
    await b.backend.setMonthBills(2026, 6, [{ name: "Card B", due: 10, paid: 10, dueDate: null, settled: true }]);
    const [bIncome, bBills] = [b.doc.financeMonths["2026-06"], b.doc.cardBills["2026-06"]];
    sync();
    // No mixing of A's salary with B's other income: the unit is whole.
    expect(a.doc.financeMonths["2026-06"]).toEqual(bIncome);
    expect(a.doc.cardBills["2026-06"]).toEqual(bBills);
  });

  it("payEmi / payEmi on one EMI from the same state: one result wins (payments are state)", async () => {
    const { a, b, sync } = await pair();
    a.clock = b.clock = Date.UTC(2026, 5, 10, 6, 0);
    const before = a.doc.emis[0].remainingAsOf;
    await a.backend.payEmi((await a.backend.getEmis())[0].row, 1000);
    await b.backend.payEmi((await b.backend.getEmis())[0].row, 500);
    const results = [a.doc.emis[0].remainingAsOf, b.doc.emis[0].remainingAsOf];
    sync();
    expect(results).toContain(a.doc.emis[0].remainingAsOf);
    expect(a.doc.emis[0].remainingAsOf).toBe(results[1]);
    expect(a.doc.emis[0].remainingAsOf).not.toBe(before);
  });

  it("payEmi / updateEmi on one EMI from the same state: one device's balance (remainingAsOf with its asOfDate) wins whole", async () => {
    // The payment settles the 06-05 installment early; the edit touches only
    // the remarks but re-dates the shown balance to today, as the form does.
    // Each order of the two writers, so each one holds the higher tag once.
    for (const payerIsA of [true, false]) {
      const { a, b, sync } = await pair();
      a.clock = b.clock = Date.UTC(2026, 5, 3, 6, 0);
      const [payer, editor] = payerIsA ? [a, b] : [b, a];
      await payer.backend.payEmi((await payer.backend.getEmis())[0].row, 1000);
      const e = (await editor.backend.getEmis())[0];
      await editor.backend.updateEmi(e.row, {
        cardOrBank: e.cardOrBank,
        emiAmount: e.emiAmount,
        dueDay: e.dueDay,
        totalAmount: e.totalAmount,
        remarks: "note",
        remainingAsOf: e.remaining,
        interestRate: e.interestRate,
        foreclosureCharge: e.foreclosureCharge,
        durationMonths: null,
      });
      a.clock = b.clock = Date.UTC(2026, 5, 10, 6, 0);
      const pairs = [a, b].map((r) => [r.doc.emis[0].remainingAsOf, r.doc.emis[0].asOfDate]);
      const alone = [(await a.backend.getEmis())[0].remaining, (await b.backend.getEmis())[0].remaining];
      sync();
      const merged = a.doc.emis[0];
      expect(pairs).toContainEqual([merged.remainingAsOf, merged.asOfDate]);
      expect(alone).toContain((await a.backend.getEmis())[0].remaining);
      expect(merged.remarks).toBe("note");
    }
  });

  it("settings / anything: per-key last-writer-wins; a record in a disabled module is kept and hidden", async () => {
    const { a, b, sync } = await pair();
    a.amend((doc) => (doc.settings.modules = doc.settings.modules.filter((m) => m !== "debts")));
    b.amend((doc) => (doc.settings.timeZone = "Asia/Kolkata"));
    await b.backend.addDebt({ name: "Alex", amount: 20 });
    sync();
    expect(a.doc.settings).toEqual({ modules: ALL_MODULES.filter((m) => m !== "debts"), timeZone: "Asia/Kolkata" });
    expect(a.doc.debts.map((d) => d.name)).toEqual(["Sam", "Alex"]);
    await expect(a.backend.getDebts()).rejects.toMatchObject({ status: 404 });
    a.amend((doc) => (doc.settings.modules = [...ALL_MODULES]));
    expect((await a.backend.getDebts()).map((d) => d.name)).toEqual(["Sam", "Alex"]);
  });

  it("restore / anything: a new epoch is its genesis alone; nothing from the old epoch's state is joined into it", async () => {
    const { a, b, sync } = await pair();
    await a.backend.deleteEntry(2026, 5, await rowOf(a, "Groceries"));
    sync();
    const backup = await genesisDocument(); // still has Groceries (AC14)
    const restored = new Replica(deviceId(0xc), backup);
    expect(remarksIn(restored).sort()).toEqual(["Bus", "Groceries"]);
    expect(docText(restored.doc)).toBe(docText(materialize(genesisState(backup))));
    expect(b.state.del.size).toBe(1);
    expect(restored.state.del.size).toBe(0);
  });

  it("restore / restore: the greater epoch key wins on every device", () => {
    const listing = ["e000001-00000000.genesis.enc", "e000002-41d0be77.genesis.enc", "e000002-41d0be78.genesis.enc"];
    for (let i = 0; i < 6; i++) expect(winningEpoch(new Rng(i).shuffle(listing))).toBe("e000002-41d0be78");
  });
});
