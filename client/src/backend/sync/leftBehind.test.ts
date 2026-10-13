import { describe, expect, it } from "vitest";
import type { LedgerDocument } from "../document/types";
import { checkGroup, inEffect, leftBehind, leftBehindItems, reapplyTo, withoutHeld, type LeftBehindGroup, type RestoreInto } from "./leftBehind";
import { genesisState } from "./state";
import { ALL_MODULES, Replica, deviceId, docText, emptyDocument } from "./testkit";

// What a restore leaves behind, and re-applying it (design sections 9.3 and
// 9.4), on the pure core: replicas in the old epoch exchange ops, and their
// state is projected above a restore's cut against the new epoch's genesis.
// Then re-apply runs as the write it is (Replica.amend, which checks every
// op and that the materialised state equals the document written). Section
// 16.1's "left-behind projection" list: own and others, records created and
// deleted above the cut, dead records, a cut from a different epoch.
// Fictional data only.

const A = deviceId(0xa);
const B = deviceId(0xb);
const N = deviceId(0xe);
const OLD = "e000001-00000000";
const NEW = "e000002-00000001";
const STAMP = { at: Date.UTC(2026, 5, 1), by: "kim" };

/** The backup: a small ledger every replica starts from. */
async function backup(): Promise<LedgerDocument> {
  const g = new Replica(deviceId(0xf), emptyDocument(), { actor: "alex" });
  await g.backend.addEntry({ year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false });
  await g.backend.addEntry({ year: 2026, month: 5, amount: 15, remarks: "Bus", category: "transportation", isCard: false });
  await g.backend.addDebt({ name: "Sam", amount: 500 });
  await g.backend.addEmi({ cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: 9.5, foreclosureCharge: null });
  return g.doc;
}

/** Two replicas of the old epoch over `doc`, and a sync that delivers
 * each one's ops to the other (joins are idempotent). */
function pair(doc: LedgerDocument) {
  const a = new Replica(A, doc, { actor: "alex" });
  const b = new Replica(B, doc, { actor: "sam" });
  const sync = () => {
    for (const op of a.ops) b.receive(A, op);
    for (const op of b.ops) a.receive(B, op);
  };
  return { a, b, sync };
}

function into(doc: LedgerDocument): RestoreInto {
  return { epoch: NEW, by: "kim", at: STAMP.at, state: genesisState(doc) };
}

const rowOf = async (r: Replica, remarks: string) => (await r.backend.getMonth(2026, 5)).find((e) => e.remarks === remarks)!.row;
const remarksIn = (doc: LedgerDocument) => (doc.expenses["2026-05"] ?? []).map((e) => e.remarks);

/** A replica of the new epoch, started from the backup, re-applying
 * `group` as one write carrying its marker. */
function reapplied(n: Replica, group: LeftBehindGroup) {
  let result!: ReturnType<typeof reapplyTo>;
  const op = n.amend((doc) => {
    result = reapplyTo(doc, n.state, group, STAMP);
  }, [group.marker]);
  return { result, op };
}

describe("left behind (section 9.3)", () => {
  it("is each device's writes above its cut entry, own first, without stamps or what the restore holds", async () => {
    const doc = await backup();
    const { a, b, sync } = pair(doc);
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), { amount: 50, remarks: "Groceries", category: "food", isCard: false });
    await b.backend.addEntry({ year: 2026, month: 5, amount: 9, remarks: "Taxi", category: "transportation", isCard: false });
    sync();
    // A cut from another epoch (or none): everything above the genesis.
    const groups = leftBehind(a.state, {}, into(doc), { epoch: OLD, me: A });
    expect(groups.map((g) => [g.device, g.own, g.who, g.marker])).toEqual([
      [A, true, "alex", `${OLD}/${A}`],
      [B, false, "sam", `${OLD}/${B}`],
    ]);
    expect(groups.every((g) => g.set.every(([key]) => !key.endsWith("/_s")))).toBe(true);
    const [own, other] = groups.map(leftBehindItems);
    expect(own).toMatchObject([{ kind: "edit", coll: "e", fields: { amount: "50.00" }, record: { remarks: "Groceries" } }]);
    expect(other).toMatchObject([{ kind: "add", coll: "e", month: "2026-05", record: { remarks: "Taxi", amount: "9.00" } }]);
    expect(groups[0].into).toEqual({ epoch: NEW, by: "kim", at: STAMP.at });

    // A cut that covers a's write leaves only b's.
    const cut = { [A]: a.state.seen.get(A)! };
    expect(leftBehind(a.state, cut, into(doc), { epoch: OLD, me: A }).map((g) => g.device)).toEqual([B]);
    // The same projection on b: b's own group first.
    expect(leftBehind(b.state, cut, into(doc), { epoch: OLD, me: B }).map((g) => [g.device, g.own])).toEqual([[B, true]]);
  });

  it("leaves nothing of a record created and deleted above the cut that the restored ledger lacks, and only the delete of a record deleted in the old epoch", async () => {
    const doc = await backup();
    const { a, b, sync } = pair(doc);
    await b.backend.addEntry({ year: 2026, month: 5, amount: 9, remarks: "Taxi", category: "transportation", isCard: false });
    await b.backend.deleteEntry(2026, 5, await rowOf(b, "Taxi"));
    // a edits Groceries while b deletes it: the delete won there (remove-wins).
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), { amount: 41, remarks: "Groceries", category: "food", isCard: false });
    await b.backend.deleteEntry(2026, 5, await rowOf(b, "Groceries"));
    sync();
    expect(remarksIn(a.doc)).toEqual(["Bus"]);
    const groups = leftBehind(a.state, {}, into(doc), { epoch: OLD, me: A });
    expect(groups.map((g) => g.device)).toEqual([B]);
    expect(leftBehindItems(groups[0])).toMatchObject([{ kind: "delete", coll: "e", record: { remarks: "Groceries" } }]);
  });

  it("leaves the delete of a record created and deleted above the cut when the restored ledger holds it (a backup taken in between)", async () => {
    const doc = await backup();
    const { a } = pair(doc);
    await a.backend.addEntry({ year: 2026, month: 5, amount: 9, remarks: "Taxi", category: "transportation", isCard: false });
    // The backup is any document: here, one exported after Taxi was added.
    const between = structuredClone(a.doc);
    await a.backend.deleteEntry(2026, 5, await rowOf(a, "Taxi"));
    const groups = leftBehind(a.state, {}, into(between), { epoch: OLD, me: A });
    expect(groups.map((g) => [g.device, g.own])).toEqual([[A, true]]);
    expect(leftBehindItems(groups[0])).toMatchObject([{ kind: "delete", coll: "e", record: { remarks: "Taxi" } }]);
    // The same delete against a backup without Taxi has nothing to delete.
    expect(leftBehind(a.state, {}, into(doc), { epoch: OLD, me: A })).toEqual([]);
  });

  it("leaves nothing the restored ledger already holds: an equal value, a create it has, a delete of a record it lacks", async () => {
    const doc = await backup();
    const { a } = pair(doc);
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), { amount: 50, remarks: "Groceries", category: "food", isCard: false });
    await a.backend.addEntry({ year: 2026, month: 5, amount: 9, remarks: "Taxi", category: "transportation", isCard: false });
    await a.backend.deleteDebt((await a.backend.getDebts())[0].row);
    // A backup taken now holds all three.
    const later = structuredClone(a.doc);
    expect(leftBehind(a.state, {}, into(later), { epoch: OLD, me: A })).toEqual([]);
  });

  it("leaves an EMI's balance pair whole, even where one of the two equals the restore's", async () => {
    const doc = await backup();
    const { a } = pair(doc);
    const emi = (await a.backend.getEmis())[0];
    await a.backend.updateEmi(emi.row, { cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 8000, interestRate: 9.5, foreclosureCharge: null });
    const [group] = leftBehind(a.state, {}, into(doc), { epoch: OLD, me: A });
    const keys = group.set.map(([key]) => key.split("/").at(-1));
    expect(keys).toEqual(expect.arrayContaining(["remainingAsOf", "asOfDate"]));
  });

  it("carried into a later genesis, keeps only what that genesis doesn't hold, a field group whole, and nothing once it holds all", async () => {
    const doc = await backup();
    const { a } = pair(doc);
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), { amount: 50, remarks: "Groceries", category: "food", isCard: false });
    await a.backend.addEntry({ year: 2026, month: 5, amount: 9, remarks: "Taxi", category: "transportation", isCard: false });
    await a.backend.deleteDebt((await a.backend.getDebts())[0].row);
    const emi = (await a.backend.getEmis())[0];
    await a.backend.updateEmi(emi.row, { cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 8000, interestRate: 9.5, foreclosureCharge: null });
    const [group] = leftBehind(a.state, {}, into(doc), { epoch: OLD, me: A });
    expect(withoutHeld(group, genesisState(doc))).toBe(group);
    // A later genesis that took in Taxi and the delete, but not the rest.
    const n = new Replica(N, doc, { epoch: NEW });
    await n.backend.addEntry({ year: 2026, month: 5, amount: 9, remarks: "Taxi", category: "transportation", isCard: false });
    const later = structuredClone(n.doc);
    later.expenses["2026-05"] = later.expenses["2026-05"].map((e) => (e.remarks === "Taxi" ? { ...e, id: leftBehindItems(group).find((i) => i.kind === "add")!.id } : e));
    later.debts = [];
    const left = withoutHeld(group, genesisState(later))!;
    expect(leftBehindItems(left).map((i) => (i.kind === "unit" ? i.key : `${i.kind}:${i.coll}`))).toEqual(["edit:e", "edit:emi"]);
    expect(left.set.map(([key]) => key.split("/").at(-1))).toEqual(expect.arrayContaining(["remainingAsOf", "asOfDate"]));
    expect(Object.keys(left.records).sort()).toEqual(left.set.map(([key]) => key.split("/").slice(0, 2).join("/")).filter((rk, i, all) => all.indexOf(rk) === i).sort());
    // One that holds it all leaves nothing.
    expect(withoutHeld(group, genesisState(a.doc))).toBeNull();
  });

  it("is never the genesis's registers, nor a unit equal to the restore's, and is a unit that differs", async () => {
    const doc = await backup();
    const { a } = pair(doc);
    expect(leftBehind(a.state, {}, into(doc), { epoch: OLD, me: A })).toEqual([]);
    await a.backend.setMonthLock(2026, 5, true);
    await a.backend.setMonthIncome(2026, 6, { salary: 100, otherIncome: null, savings: [] });
    const [group] = leftBehind(a.state, {}, into(doc), { epoch: OLD, me: A });
    expect(leftBehindItems(group)).toMatchObject([
      { kind: "unit", key: "fm/2026-06" },
      { kind: "unit", key: "lk/2026-05", value: true },
    ]);
  });
});

describe("re-apply (section 9.4)", () => {
  it("re-creates an expense with its old id in its month, and a list record last with a fresh order key; edits and deletes apply to records visible now", async () => {
    const doc = await backup();
    const { a } = pair(doc);
    await a.backend.addEntry({ year: 2026, month: 5, amount: 9, remarks: "Taxi", category: "transportation", isCard: false });
    await a.backend.addDebt({ name: "Kim", amount: 70 });
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), { amount: 50, remarks: "Groceries", category: "food", isCard: false });
    await a.backend.deleteEntry(2026, 5, await rowOf(a, "Bus"));
    const [group] = leftBehind(a.state, {}, into(doc), { epoch: OLD, me: A });

    // The new epoch: a new device, a write of its own first.
    const n = new Replica(N, doc, { actor: "kim", epoch: NEW });
    await n.backend.addDebt({ name: "Lee", amount: 1 });
    const { result, op } = reapplied(n, group);
    expect(result.skipped).toEqual([]);
    expect(op?.ra).toEqual([group.marker]);
    const taxi = a.doc.expenses["2026-05"].find((e) => e.remarks === "Taxi")!;
    const back = n.doc.expenses["2026-05"].find((e) => e.remarks === "Taxi")!;
    expect(back).toMatchObject({ id: taxi.id, sortKey: taxi.sortKey, amount: "9.00", updatedBy: "kim" });
    expect(remarksIn(n.doc)).toEqual(remarksIn(a.doc));
    expect(n.doc.debts.map((d) => d.name)).toEqual(["Sam", "Lee", "Kim"]);
    expect(n.doc.debts[2].id).toBe(a.doc.debts[1].id);
    expect(n.state.ra.has(group.marker)).toBe(true);
    expect(inEffect(group, n.state)).toBe(true);
  });

  it("skips what can't be done now, and says why: a locked month, a module turned off, a record the restore lacks, a record deleted since", async () => {
    const doc = await backup();
    const { a } = pair(doc);
    // A record created below the cut that the backup (older) lacks.
    await a.backend.addDebt({ name: "Kim", amount: 70 });
    const cut = { [A]: a.state.seen.get(A)! };
    await a.backend.updateDebt((await a.backend.getDebts())[1].row, { name: "Kim", amount: 75 });
    await a.backend.updateDebt((await a.backend.getDebts())[0].row, { name: "Sam", amount: 450 });
    await a.backend.addEntry({ year: 2026, month: 5, amount: 9, remarks: "Taxi", category: "transportation", isCard: false });
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Bus"), { amount: 16, remarks: "Bus", category: "transportation", isCard: false });
    const emi = (await a.backend.getEmis())[0];
    await a.backend.updateEmi(emi.row, { cardOrBank: "Car Loan", emiAmount: 1100, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: 9.5, foreclosureCharge: null });
    const [group] = leftBehind(a.state, cut, into(doc), { epoch: OLD, me: A });

    const n = new Replica(N, doc, { actor: "kim", epoch: NEW });
    await n.backend.deleteEmi((await n.backend.getEmis())[0].row);
    await n.backend.setMonthLock(2026, 5, true);
    n.amend((d) => (d.settings.modules = ALL_MODULES.filter((m) => m !== "debts")));
    const preview = reapplyTo(structuredClone(n.doc), n.state, group, STAMP);
    const { result } = reapplied(n, group);
    expect(result).toEqual(preview);
    const reasons = result.skipped.map(({ item, reason }) => [item.kind, item.kind === "unit" ? item.key : item.coll, reason]);
    expect(reasons).toEqual(
      expect.arrayContaining([
        ["edit", "debt", "moduleOff"],
        ["edit", "debt", "moduleOff"],
        ["add", "e", "monthLocked"],
        ["edit", "e", "monthLocked"],
        ["edit", "emi", "deleted"],
      ]),
    );
    expect(result.applied).toEqual([]);
    // Turned back on, the debts: the one the restore lacks is not there.
    n.amend((d) => (d.settings.modules = [...ALL_MODULES]));
    const again = reapplyTo(structuredClone(n.doc), n.state, group, STAMP);
    expect(again.skipped.filter(({ item }) => item.kind !== "unit" && item.coll === "debt").map(({ reason }) => reason).sort()).toEqual(["notInLedger"]);
  });

  it("puts back month units and settings, and deletes a record only while it is there", async () => {
    const doc = await backup();
    const { a } = pair(doc);
    await a.backend.setMonthIncome(2026, 6, { salary: 100, otherIncome: null, savings: [] });
    a.amend((d) => (d.settings.timeZone = "Asia/Kolkata"));
    await a.backend.deleteEntry(2026, 5, await rowOf(a, "Bus"));
    const [group] = leftBehind(a.state, {}, into(doc), { epoch: OLD, me: A });
    const n = new Replica(N, doc, { actor: "kim", epoch: NEW });
    reapplied(n, group);
    expect(n.doc.financeMonths["2026-06"]).toEqual(a.doc.financeMonths["2026-06"]);
    expect(n.doc.settings.timeZone).toBe("Asia/Kolkata");
    expect(remarksIn(n.doc)).toEqual(["Groceries"]);
    // Twice (another device re-applied it too): the same document.
    const before = docText(n.doc);
    const { result } = reapplied(n, group);
    expect(result.skipped).toEqual([]);
    expect(docText(n.doc)).toBe(before);
  });

  it("re-applies to a record another device re-created only what this group wrote", async () => {
    const doc = await backup();
    const { a, b, sync } = pair(doc);
    await a.backend.addEntry({ year: 2026, month: 5, amount: 9, remarks: "Taxi", category: "transportation", isCard: false });
    sync();
    await b.backend.updateEntry(2026, 5, await rowOf(b, "Taxi"), { amount: 11, remarks: "Taxi", category: "transportation", isCard: false });
    sync();
    const [ownA, ownB] = [leftBehind(a.state, {}, into(doc), { epoch: OLD, me: A }), leftBehind(b.state, {}, into(doc), { epoch: OLD, me: B })];
    const groupA = ownA.find((g) => g.device === A)!;
    const groupB = ownB.find((g) => g.device === B)!;
    const n = new Replica(N, doc, { actor: "kim", epoch: NEW });
    // a's group re-creates Taxi as the old epoch last had it (b's amount).
    reapplied(n, groupA);
    const taxi = () => n.doc.expenses["2026-05"].find((e) => e.remarks === "Taxi")!;
    expect(taxi().amount).toBe("11.00");
    await n.backend.updateEntry(2026, 5, await rowOf(n, "Taxi"), { amount: 12, remarks: "Taxi", category: "transportation", isCard: false });
    // b's group sets only b's amount.
    reapplied(n, groupB);
    expect(taxi().amount).toBe("11.00");
  });

  it("is in effect once every register holds its value and every deleted record is gone", async () => {
    const doc = await backup();
    const { a } = pair(doc);
    await a.backend.deleteEntry(2026, 5, await rowOf(a, "Bus"));
    await a.backend.setMonthLock(2026, 5, true);
    const [group] = leftBehind(a.state, {}, into(doc), { epoch: OLD, me: A });
    const n = new Replica(N, doc, { epoch: NEW });
    expect(inEffect(group, n.state)).toBe(false);
    await n.backend.deleteEntry(2026, 5, await rowOf(n, "Bus"));
    expect(inEffect(group, n.state)).toBe(false);
    await n.backend.setMonthLock(2026, 5, true);
    expect(inEffect(group, n.state)).toBe(true);
  });

  it("stored groups read back as they were written, and anything else is refused", async () => {
    const doc = await backup();
    const { a } = pair(doc);
    await a.backend.addEntry({ year: 2026, month: 5, amount: 9, remarks: "Taxi", category: "transportation", isCard: false });
    const [group] = leftBehind(a.state, {}, into(doc), { epoch: OLD, me: A });
    expect(checkGroup(JSON.parse(JSON.stringify(group)))).toEqual(group);
    for (const bad of [null, { ...group, marker: `${OLD}/${B}` }, { ...group, set: [["nope", 1]] }, { ...group, del: ["e/x"] }, { ...group, into: null }, { ...group, own: "yes" }]) {
      expect(checkGroup(bad)).toBeNull();
    }
  });
});
