import { describe, expect, it } from "vitest";
import type { LedgerDocument } from "../document/types";
import { NOTICE_CAP, checkNotice, detectNotices, overCap, type Detected } from "./notices";
import { cloneState, emptyState, joinInto, opState, type Op, type SyncState } from "./state";
import { compareTags } from "./tags";
import { Replica, Rng, deviceId, emptyDocument, fingerprint, forEachSeed, testEnv } from "./testkit";

// Who is told (design section 4.2): one named test per row of the section 4
// conflict table whose "who is told" column names someone, on the pure
// core (Replica runs real DocumentBackend writes over the diff), plus the
// rows and cases that tell no one. The engine tests (noticeFlow.test.ts)
// run the same rules through logs and snapshots on the fake GitHub.
// Fictional data only.

const A = deviceId(0xa);
const B = deviceId(0xb);

/** A small ledger both replicas start from. */
async function genesisDocument(): Promise<LedgerDocument> {
  const g = new Replica(deviceId(0xf), emptyDocument(), { actor: "alex" });
  await g.backend.addEntry({ year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false });
  await g.backend.addEntry({ year: 2026, month: 5, amount: 15, remarks: "Bus", category: "transportation", isCard: false });
  await g.backend.addEmi({ cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: null, foreclosureCharge: null });
  await g.backend.setMonthIncome(2026, 5, { salary: 50000, otherIncome: null, savings: [] });
  return g.doc;
}

async function pair(): Promise<{ a: Replica; b: Replica; doc: LedgerDocument }> {
  const doc = await genesisDocument();
  return { a: new Replica(A, doc, { actor: "alex" }), b: new Replica(B, doc, { actor: "sam" }), doc };
}

/** Delivers `ops` of `from` to `to` (as a cycle joins a log), and returns
 * the notices `to` gets. */
function deliver(to: Replica, from: Replica, ops: Op[] = from.ops): Detected[] {
  const arrivals = ops.map((op) => [from.device, op] as const);
  const source = emptyState();
  for (const [device, op] of arrivals) joinInto(source, opState(device, op));
  const before = JSON.stringify([...to.state.rec.keys()]);
  const found = detectNotices(to.state, source, { ops: arrivals, states: [] }, to.device);
  expect(JSON.stringify([...to.state.rec.keys()])).toBe(before);
  for (const op of ops) to.receive(from.device, op);
  return found;
}

/** Delivers `snapshot` (a whole state another device published) to `to`. */
function deliverState(to: Replica, snapshot: SyncState, device: string): Detected[] {
  const found = detectNotices(to.state, snapshot, { ops: [], states: [{ device, state: snapshot }] }, to.device);
  to.receiveState(snapshot);
  return found;
}

async function rowOf(r: Replica, remarks: string): Promise<number> {
  return (await r.backend.getMonth(2026, 5)).find((e) => e.remarks === remarks)!.row;
}
const edit = (amount: number, remarks = "Groceries") => ({ amount, remarks, category: "food", isCard: false });
const fieldsOf = (n: Detected) => (n.kind === "overwrite" ? n.registers.map((r) => r.key.split("/").at(-1)) : []);

describe("rule 1: a register overwrite (section 4.2)", () => {
  it("edit / edit, same field, different values: the device whose value lost is told, with both values", async () => {
    const { a, b } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(12));
    // [2, B] beats [2, A]: a's 10 lost.
    const onA = deliver(a, b);
    expect(onA).toHaveLength(1);
    const [notice] = onA;
    expect(notice).toMatchObject({
      kind: "overwrite",
      winner: { L: 2, device: B, by: "sam" },
      loser: { L: 2, device: A },
      target: { kind: "record", coll: "e", month: "2026-05", name: "Groceries" },
      registers: [{ theirs: "12.00", mine: "10.00" }],
    });
    expect(fieldsOf(notice)).toEqual(["amount"]);
    const id = a.doc.expenses["2026-05"].find((e) => e.remarks === "Groceries")!.id;
    expect(notice.key).toBe(`2.${B}/2.${A}/overwrite/e/${id}`);
    // The winner is told nothing.
    expect(deliver(b, a)).toEqual([]);
  });

  it("edit / edit, same field, same value: no one is told (the value-difference condition)", async () => {
    const { a, b } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(12));
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(12));
    expect(deliver(a, b)).toEqual([]);
    expect(deliver(b, a)).toEqual([]);
  });

  it("edit / edit, different fields: no one is told, and the stamp they both set never notifies", async () => {
    const { a, b } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(12));
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(40, "Groceries (veg)"));
    expect(deliver(a, b)).toEqual([]);
    expect(deliver(b, a)).toEqual([]);
  });

  it("never for a causally later change: the writer had seen my value", async () => {
    const { a, b } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
    deliver(b, a);
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(12));
    expect(deliver(a, b, b.ops.slice(-1))).toEqual([]);
  });

  it("never when the loser's own later write already stands: the remote op replaces nothing of mine", async () => {
    const { a, b } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(12));
    // a writes again, later than b's write (a greater L), never having seen it.
    await a.backend.setMonthLock(2026, 7, true);
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(15));
    expect(deliver(a, b)).toEqual([]);
    expect(a.doc.expenses["2026-05"].find((e) => e.remarks === "Groceries")?.amount).toBe("15.00");
  });

  it("never for sortKey, _s or _c: concurrent moves of one record tell no one", async () => {
    const { a, b } = await pair();
    await a.backend.moveEntry(2026, 5, await rowOf(a, "Bus"), await rowOf(a, "Groceries"));
    await b.backend.moveEntry(2026, 5, await rowOf(b, "Bus"), await rowOf(b, "Groceries"));
    expect(deliver(a, b)).toEqual([]);
    expect(deliver(b, a)).toEqual([]);
  });

  it("names only the registers whose value changed when a write sets a whole record again (a re-create)", async () => {
    // Two re-creates of one id (as re-apply makes, section 9.4): every field
    // and _c, _s and sortKey again, only the amount different.
    const { a, b } = await pair();
    const id = a.doc.expenses["2026-05"].find((e) => e.remarks === "Groceries")!.id;
    const recreate = (L: number, amount: string, vv: Record<string, number>): Op => ({
      L,
      at: 1,
      by: "sam",
      vv,
      set: [
        [`e/${id}/_c`, { m: "2026-05" }],
        [`e/${id}/sortKey`, "a5"],
        [`e/${id}/amount`, amount],
        [`e/${id}/remarks`, "Groceries"],
        [`e/${id}/category`, "food"],
        [`e/${id}/cardNote`, null],
        [`e/${id}/_s`, { at: L, by: "sam" }],
      ],
      del: [],
    });
    const mine = recreate(5, "20.00", {});
    a.receive(A, mine);
    const theirs = recreate(9, "10.00", {});
    const found = deliver(a, b, [theirs]);
    expect(found).toHaveLength(1);
    expect(fieldsOf(found[0])).toEqual(["amount"]);
    expect(found[0]).toMatchObject({ winner: { L: 9, device: B }, loser: { L: 5, device: A }, registers: [{ theirs: "10.00", mine: "20.00" }] });
  });

  it("lock / unlock: the loser is told", async () => {
    const { a, b } = await pair();
    await a.backend.setMonthLock(2026, 6, true);
    await b.backend.setMonthLock(2026, 6, true);
    await b.backend.setMonthLock(2026, 6, false);
    const found = deliver(a, b);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "overwrite", target: { kind: "unit", key: "lk/2026-06" }, registers: [{ key: "lk/2026-06", theirs: false, mine: true }] });
    expect(deliver(b, a)).toEqual([]);
  });

  it("setMonthIncome / setMonthIncome, same month: the loser is told, with both whole values", async () => {
    const { a, b } = await pair();
    await a.backend.setMonthIncome(2026, 5, { salary: 60000, otherIncome: null, savings: [] });
    await b.backend.setMonthIncome(2026, 5, { salary: 65000, otherIncome: 500, savings: [] });
    const [notice] = deliver(a, b);
    expect(notice).toMatchObject({
      target: { kind: "unit", key: "fm/2026-05" },
      registers: [{ key: "fm/2026-05", mine: { salary: "60000.00", otherIncome: null, savings: [] }, theirs: { salary: "65000.00", otherIncome: "500.00", savings: [] } }],
    });
  });

  it("setMonthBills / setMonthBills, same month: the loser is told", async () => {
    const { a, b } = await pair();
    await a.backend.setMonthBills(2026, 5, [{ name: "Card A", due: 100, paid: 0, dueDate: null, settled: false }]);
    await b.backend.setMonthBills(2026, 5, [{ name: "Card A", due: 120, paid: 0, dueDate: null, settled: false }]);
    const [notice] = deliver(a, b);
    expect(notice).toMatchObject({ target: { kind: "unit", key: "cb/2026-05" } });
    expect(notice.kind === "overwrite" && (notice.registers[0].mine as { due: string }[])[0].due).toBe("100.00");
  });

  it("payEmi / payEmi on one EMI: one notice for the balance pair, both registers in it", async () => {
    const { a, b } = await pair();
    const row = (r: Replica) => r.backend.getEmis().then((list) => list[0].row);
    await a.backend.payEmi(await row(a), 1000);
    await b.backend.payEmi(await row(b), 1500);
    const found = deliver(a, b);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "overwrite", target: { kind: "record", coll: "emi", name: "Car Loan" } });
    expect(fieldsOf(found[0]).sort()).toEqual(["asOfDate", "remainingAsOf"]);
  });

  it("payEmi / payEmi with the same result: still told (D20), since two payments became one", async () => {
    const { a, b } = await pair();
    const row = (r: Replica) => r.backend.getEmis().then((list) => list[0].row);
    await a.backend.payEmi(await row(a), 1000);
    await b.backend.payEmi(await row(b), 1000);
    const found = deliver(a, b);
    expect(found).toHaveLength(1);
    expect(found[0].kind === "overwrite" && found[0].registers.every((r) => r.theirs === r.mine)).toBe(true);
    expect(deliver(b, a)).toEqual([]);
  });

  it("a settings clash: the loser is told", async () => {
    const { a, b } = await pair();
    a.amend((doc) => void (doc.settings.timeZone = "Asia/Kolkata"));
    b.amend((doc) => void (doc.settings.timeZone = "Europe/London"));
    const [notice] = deliver(a, b);
    expect(notice).toMatchObject({ target: { kind: "unit", key: "st/timeZone" }, registers: [{ theirs: "Europe/London", mine: "Asia/Kolkata" }] });
  });

  it("not for a record the same join leaves deleted: the delete is what is told", async () => {
    const { a, b, doc } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
    const c = new Replica(deviceId(0xc), doc, { actor: "kai" });
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(12));
    await c.backend.deleteEntry(2026, 5, await rowOf(c, "Groceries"));
    const source = emptyState();
    joinInto(source, opState(B, b.ops[0]));
    joinInto(source, opState(c.device, c.ops[0]));
    const found = detectNotices(a.state, source, { ops: [[B, b.ops[0]], [c.device, c.ops[0]]], states: [] }, A);
    expect(found.map((n) => n.kind)).toEqual(["deleted"]);
  });
});

describe("rule 2: a concurrent delete (section 4.2)", () => {
  it("edit / delete: delete wins, and the editing device is told", async () => {
    const { a, b } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
    await b.backend.deleteEntry(2026, 5, await rowOf(b, "Groceries"));
    const found = deliver(a, b);
    expect(found).toEqual([
      expect.objectContaining({ kind: "deleted", winner: { L: 2, device: B, by: "sam" }, loser: { L: 2, device: A }, target: expect.objectContaining({ coll: "e", month: "2026-05", name: "Groceries" }) }),
    ]);
    expect(deliver(b, a)).toEqual([]);
  });

  it("never when the deleter had seen the edit", async () => {
    const { a, b } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
    deliver(b, a);
    await b.backend.deleteEntry(2026, 5, await rowOf(b, "Groceries"));
    expect(deliver(a, b, b.ops.slice(-1))).toEqual([]);
  });

  it("one remote op that deletes one record and overwrites another, against one op of mine that edited both, tells both kinds (F1)", async () => {
    const { a, b } = await pair();
    const id = (remarks: string) => a.doc.expenses["2026-05"].find((e) => e.remarks === remarks)!.id;
    const [groceries, bus] = [id("Groceries"), id("Bus")];
    // One op of mine edits both; one op of b's deletes Groceries and sets Bus.
    a.amend((doc) => {
      for (const e of doc.expenses["2026-05"]) e.amount = e.remarks === "Groceries" ? "10.00" : "3.00";
    });
    b.amend((doc) => {
      doc.expenses["2026-05"] = doc.expenses["2026-05"].filter((e) => e.remarks !== "Groceries");
      doc.expenses["2026-05"][0].amount = "4.00";
    });
    const found = deliver(a, b);
    // Keys are literal: (winner op, loser op, kind, what), stable whenever detected.
    expect(found.map((n) => n.key).sort()).toEqual([`2.${B}/2.${A}/deleted/e/${groceries}`, `2.${B}/2.${A}/overwrite/e/${bus}`].sort());
    expect(found.map((n) => n.kind).sort()).toEqual(["deleted", "overwrite"]);
  });

  it("one remote op that deletes two records I edited in one op tells each (F1)", async () => {
    const { a, b } = await pair();
    a.amend((doc) => {
      for (const e of doc.expenses["2026-05"]) e.amount = "1.00";
    });
    b.amend((doc) => void delete doc.expenses["2026-05"]);
    const found = deliver(a, b);
    expect(found.map((n) => (n.kind === "deleted" ? n.target.name : null)).sort()).toEqual(["Bus", "Groceries"]);
    expect(new Set(found.map((n) => n.key)).size).toBe(2);
  });

  it("move / delete tells no one: a sortKey isn't content", async () => {
    const { a, b } = await pair();
    await a.backend.moveEntry(2026, 5, await rowOf(a, "Bus"), await rowOf(a, "Groceries"));
    await b.backend.deleteEntry(2026, 5, await rowOf(b, "Bus"));
    expect(deliver(a, b)).toEqual([]);
  });

  it("delete / delete tells no one", async () => {
    const { a, b } = await pair();
    await a.backend.deleteEntry(2026, 5, await rowOf(a, "Bus"));
    await b.backend.deleteEntry(2026, 5, await rowOf(b, "Bus"));
    expect(deliver(a, b)).toEqual([]);
    expect(deliver(b, a)).toEqual([]);
  });

  it("add / add (AC6) and lock / edit tell no one", async () => {
    const { a, b } = await pair();
    await a.backend.addEntry({ year: 2026, month: 5, ...edit(1, "Tea") });
    await b.backend.addEntry({ year: 2026, month: 5, ...edit(2, "Coffee") });
    expect(deliver(a, b)).toEqual([]);
    const two = await pair();
    await two.a.backend.setMonthLock(2026, 5, true);
    await two.b.backend.updateEntry(2026, 5, await rowOf(two.b, "Groceries"), edit(10));
    expect(deliver(two.a, two.b)).toEqual([]);
    expect(deliver(two.b, two.a)).toEqual([]);
  });
});

describe("through a snapshot (section 4.2: its seen stands in for vv)", () => {
  it("a write that arrives only in a snapshot is told when the snapshot hadn't seen mine", async () => {
    const { a, b } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(12));
    const [notice] = deliverState(a, cloneState(b.state), B);
    expect(notice).toMatchObject({ kind: "overwrite", winner: { L: 2, device: B, by: null }, registers: [{ theirs: "12.00", mine: "10.00" }] });
  });

  it("a delete in a snapshot is exact: it carries its deleter's vv", async () => {
    const { a, b } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
    await b.backend.deleteEntry(2026, 5, await rowOf(b, "Groceries"));
    expect(deliverState(a, cloneState(b.state), B).map((n) => n.kind)).toEqual(["deleted"]);
  });

  it("residual (section 12.2 item 6): a snapshot taken after its device saw my write hides the overwrite", async () => {
    const { a, b } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(12));
    // b saw a's write (and kept its own, the greater tag) before compacting.
    deliver(b, a);
    expect(deliverState(a, cloneState(b.state), B)).toEqual([]);
  });

  it("another device's snapshot never stands in for the writer's vv: it can't tell a causally later write", async () => {
    const { a, b, doc } = await pair();
    const c = new Replica(deviceId(0xc), doc, { actor: "kai" });
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
    // b saw a's write and then changed the amount: causally later.
    deliver(b, a);
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(12));
    // c joined b's write without ever seeing a's: its seen[a] is 0.
    for (const op of b.ops) c.receive(B, op);
    expect(c.state.seen.get(A) ?? 0).toBe(0);
    expect(deliverState(a, cloneState(c.state), c.device)).toEqual([]);
  });

  it("an op and a snapshot holding the same write: one notice, from the op's exact vv", async () => {
    const { a, b } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(12));
    const snapshot = cloneState(b.state);
    const source = cloneState(snapshot);
    joinInto(source, opState(B, b.ops[0]));
    const found = detectNotices(a.state, source, { ops: [[B, b.ops[0]]], states: [{ device: B, state: snapshot }] }, A);
    expect(found).toHaveLength(1);
    expect(found[0].winner.by).toBe("sam");
  });
});

describe("rule 1 against an oracle (AC7, randomised)", () => {
  const SEEDS = Number(testEnv("LEDGER_NOTICE_SEEDS") ?? 150);

  // Two replicas edit the same two records without seeing each other, then
  // exchange everything. For each field, the device whose last write lost
  // to a greater tag with a different value is told once, naming exactly
  // that pair of ops, and nobody else is told anything. Both end equal.
  it("tells exactly the losers of concurrent same-field writes with different values", async () => {
    await forEachSeed(SEEDS, async (seed) => {
      const rng = new Rng(seed);
      const { a, b } = await pair();
      const amounts = [10, 12, 40];
      const names = ["Groceries", "Bus"];
      for (let i = 0; i < 6; i++) {
        const r = rng.pick([a, b]);
        const name = rng.pick(names);
        const row = await rowOf(r, name);
        if (rng.chance(0.2)) await r.backend.setMonthLock(2026, 8, rng.chance(0.5));
        else await r.backend.updateEntry(2026, 5, row, edit(rng.pick(amounts), name));
      }
      /** Per field, the last op of `r` that set it: its tag and value. */
      const lastWrites = (r: Replica) => {
        const out = new Map<string, { L: number; device: string; value: unknown }>();
        for (const op of r.ops) for (const [key, value] of op.set) if (!key.endsWith("/_s")) out.set(key, { L: op.L, device: r.device, value });
        return out;
      };
      const expected = (loser: Replica, winner: Replica) => {
        const mine = lastWrites(loser);
        const keys = new Set<string>();
        for (const [key, theirs] of lastWrites(winner)) {
          const own = mine.get(key);
          if (!own || compareTags([theirs.L, theirs.device], [own.L, own.device]) < 0) continue;
          if (JSON.stringify(theirs.value) === JSON.stringify(own.value)) continue;
          // Written out, not built with the code's own key function.
          const about = key.split("/").length === 3 ? key.slice(0, key.lastIndexOf("/")) : key;
          keys.add(`${theirs.L}.${theirs.device}/${own.L}.${own.device}/overwrite/${about} ${key}`);
        }
        return [...keys].sort();
      };
      const told = (found: Detected[]) => found.flatMap((n) => (n.kind === "overwrite" ? n.registers.map((r) => `${n.key} ${r.key}`) : [])).sort();
      const onA = expected(a, b);
      const onB = expected(b, a);
      const [aOps, bOps] = [[...a.ops], [...b.ops]];
      expect(told(deliver(a, b, bOps)), `seed ${seed} on a`).toEqual(onA);
      expect(told(deliver(b, a, aOps)), `seed ${seed} on b`).toEqual(onB);
      // Notices change nothing: both replicas hold the same state.
      expect(fingerprint(a.state)).toBe(fingerprint(b.state));
    });
  }, 300_000);
});

describe("stored notices", () => {
  it("checkNotice takes what this build stores and refuses anything else", async () => {
    const { a, b } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(12));
    const [{ key, ...body }] = deliver(a, b);
    expect(key).toContain("/");
    const stored = { ...body, seq: 3, at: 99 };
    expect(checkNotice(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    // An earlier stage's fence notice and rehome notice (no seq) still read.
    expect(checkNotice({ kind: "kept", theirs: [3, B], mine: [4, A], registers: [{ key: "lk/2026-05", theirs: true, mine: false }] })).toMatchObject({ seq: 0, at: 0 });
    expect(checkNotice({ kind: "rehome", from: A, to: B, at: 5, message: "x" })).toMatchObject({ seq: 0, at: 5 });
    for (const bad of [null, [], { kind: "overwrite" }, { ...stored, registers: [] }, { ...stored, seq: -1 }, { ...stored, winner: { L: 0, device: B, by: null } }, { ...stored, kind: "deleted", target: { kind: "unit", key: "fm/2026-05" } }, { kind: "other" }]) {
      expect(checkNotice(bad)).toBeNull();
    }
  });

  it("overCap drops the oldest past the cap of 50", () => {
    const kept = new Map(Array.from({ length: NOTICE_CAP + 3 }, (_, i) => [`k${String(i).padStart(2, "0")}`, i + 1] as [string, number]));
    expect(overCap(kept)).toEqual(["k00", "k01", "k02"]);
    expect(overCap(new Map([["a", 1]]))).toEqual([]);
  });
});
