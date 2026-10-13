import { describe, expect, it } from "vitest";
import { ApiError } from "../ApiError";
import type { LedgerDocument } from "../document/types";
import { actionsFor, applyAction, noticeView, previewActions, type ActionEnv, type NoticeActionKind } from "./noticeActions";
import { detectNotices, type StoredNotice } from "./notices";
import { emptyState, joinInto, opState } from "./state";
import { Replica, deviceId, docText, emptyDocument } from "./testkit";

// Notice actions (design section 4.1): each is a new write worked out from
// the current document when it runs, checked as the ledger stands then, and
// the preview a button shows is that same plan. Run here through Replica's
// amend (SyncedHost.amend's stand-in), so every write also goes through the
// diff and the op validator. Fictional data only.

const A = deviceId(0xa);
const B = deviceId(0xb);
const ENV: ActionEnv = { now: Date.UTC(2026, 4, 12, 9), actor: "alex", newId: () => "00000000-0000-4000-8000-0000000000aa" };

async function genesisDocument(): Promise<LedgerDocument> {
  const g = new Replica(deviceId(0xf), emptyDocument(), { actor: "alex" });
  await g.backend.addEntry({ year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false });
  await g.backend.addEntry({ year: 2026, month: 5, amount: 15, remarks: "Bus", category: "transportation", isCard: false });
  await g.backend.addDebt({ name: "Sam", amount: 500 });
  await g.backend.addEmi({ cardOrBank: "Car Loan", emiAmount: 1000, dueDay: 5, totalAmount: 12000, remarks: "", remainingAsOf: 9000, interestRate: null, foreclosureCharge: null });
  return g.doc;
}

async function pair(): Promise<{ a: Replica; b: Replica }> {
  const doc = await genesisDocument();
  return { a: new Replica(A, doc, { actor: "alex", clock: ENV.now }), b: new Replica(B, doc, { actor: "sam", clock: ENV.now }) };
}

/** b's ops delivered to a: the one notice a gets, as stored. */
function noticeOn(a: Replica, b: Replica): StoredNotice {
  const source = emptyState();
  for (const op of b.ops) joinInto(source, opState(B, op));
  const found = detectNotices(a.state, source, { ops: b.ops.map((op) => [B, op] as const), states: [] }, A);
  for (const op of b.ops) a.receive(B, op);
  expect(found).toHaveLength(1);
  const { key: _key, ...body } = found[0];
  return { ...body, seq: 1, at: ENV.now };
}

async function rowOf(r: Replica, remarks: string): Promise<number> {
  return (await r.backend.getMonth(2026, 5)).find((e) => e.remarks === remarks)!.row;
}
const edit = (amount: number, remarks = "Groceries") => ({ amount, remarks, category: "food", isCard: false });
const groceries = (r: Replica) => r.doc.expenses["2026-05"]?.find((e) => e.remarks === "Groceries");

/** Runs an action as the engine does: a write on a copy of the document. */
function act(r: Replica, notice: StoredNotice, kind: NoticeActionKind) {
  return r.amend((doc) => applyAction(notice, kind, doc, r.state, ENV));
}

/** The refusal an action throws, with the document left as it was. */
function refusal(r: Replica, notice: StoredNotice, kind: NoticeActionKind): ApiError {
  const before = docText(r.doc);
  const ops = r.ops.length;
  let caught: unknown;
  try {
    act(r, notice, kind);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ApiError);
  expect(docText(r.doc)).toBe(before);
  expect(r.ops).toHaveLength(ops);
  return caught as ApiError;
}

async function lostEdit() {
  const { a, b } = await pair();
  await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
  await b.backend.updateEntry(2026, 5, await rowOf(b, "Groceries"), edit(12));
  return { a, b, notice: noticeOn(a, b) };
}

describe("Use mine (section 4.1)", () => {
  it("sets the register back to this device's value, as a new write, and shows that exact value first", async () => {
    const { a, notice } = await lostEdit();
    expect(actionsFor(notice)).toEqual(["useMine"]);
    const [preview] = previewActions(notice, a.doc, a.state, ENV);
    expect(preview).toEqual({ kind: "useMine", writes: [{ key: expect.stringMatching(/\/amount$/), value: "10.00" }], refused: null });
    const op = act(a, notice, "useMine")!;
    expect(groceries(a)).toMatchObject({ amount: "10.00", updatedBy: "alex", updatedAt: ENV.now });
    expect(op.set.map(([key]) => key.split("/")[2])).toEqual(["amount", "_s"]);
  });

  it("refuses on a locked month, a module that is off, a deleted record, and a value already in effect", async () => {
    const locked = await lostEdit();
    await locked.a.backend.setMonthLock(2026, 5, true);
    expect(previewActions(locked.notice, locked.a.doc, locked.a.state, ENV)[0].refused).toEqual({ reason: "locked" });
    expect(refusal(locked.a, locked.notice, "useMine").status).toBe(403);

    const off = await lostEdit();
    off.a.amend((doc) => void (doc.settings.modules = ["finances"]));
    expect(refusal(off.a, off.notice, "useMine").status).toBe(404);
    expect(previewActions(off.notice, off.a.doc, off.a.state, ENV)[0].refused).toEqual({ reason: "moduleOff" });

    const gone = await lostEdit();
    await gone.a.backend.deleteEntry(2026, 5, await rowOf(gone.a, "Groceries"));
    expect(previewActions(gone.notice, gone.a.doc, gone.a.state, ENV)[0].refused).toEqual({ reason: "deleted" });
    expect(refusal(gone.a, gone.notice, "useMine").status).toBe(404);

    const same = await lostEdit();
    await same.a.backend.updateEntry(2026, 5, await rowOf(same.a, "Groceries"), edit(10));
    expect(previewActions(same.notice, same.a.doc, same.a.state, ENV)[0].refused).toEqual({ reason: "inEffect" });
    expect(refusal(same.a, same.notice, "useMine").status).toBe(409);
  });

  it("is computed when it runs, not stored: a later remote value is replaced by mine, never by the value told", async () => {
    const { a, notice } = await lostEdit();
    const c = new Replica(deviceId(0xc), a.doc, { actor: "kai" });
    await c.backend.updateEntry(2026, 5, await rowOf(c, "Groceries"), edit(33));
    a.receive(c.device, c.ops[0]);
    expect(groceries(a)?.amount).toBe("33.00");
    act(a, notice, "useMine");
    expect(groceries(a)?.amount).toBe("10.00");
  });

  it("lock / unlock: a locked month doesn't refuse it, since the lock is what it sets", async () => {
    // My lock lost to an unlock.
    const lockA = await pair();
    await lockA.b.backend.setMonthLock(2026, 6, true);
    await lockA.b.backend.setMonthLock(2026, 6, false);
    await lockA.a.backend.setMonthLock(2026, 6, true);
    const unlocked = noticeOn(lockA.a, lockA.b);
    expect(unlocked).toMatchObject({ registers: [{ key: "lk/2026-06", mine: true, theirs: false }] });
    act(lockA.a, unlocked, "useMine");
    expect(lockA.a.doc.monthLocks["2026-06"]).toBe(true);

    // The other way round: my unlock lost to a lock, and the month is locked now.
    const unlockA = await pair();
    await unlockA.a.backend.setMonthLock(2026, 6, true);
    for (const op of unlockA.a.ops) unlockA.b.receive(A, op);
    await unlockA.a.backend.setMonthLock(2026, 6, false);
    await unlockA.b.backend.setMonthLock(2026, 7, true);
    await unlockA.b.backend.setMonthLock(2026, 6, false);
    await unlockA.b.backend.setMonthLock(2026, 6, true);
    const notice = noticeOn(unlockA.a, unlockA.b);
    expect(unlockA.a.doc.monthLocks["2026-06"]).toBe(true);
    act(unlockA.a, notice, "useMine");
    expect(unlockA.a.doc.monthLocks["2026-06"]).toBeUndefined();
  });

  it("a month unit and a setting: the whole value back; Finances off refuses the unit", async () => {
    const { a, b } = await pair();
    await a.backend.setMonthIncome(2026, 5, { salary: 60000, otherIncome: null, savings: [] });
    await b.backend.setMonthIncome(2026, 5, { salary: 65000, otherIncome: null, savings: [] });
    const notice = noticeOn(a, b);
    expect(a.doc.financeMonths["2026-05"].salary).toBe("65000.00");
    a.amend((doc) => void (doc.settings.modules = ["expenses"]));
    expect(previewActions(notice, a.doc, a.state, ENV)[0].refused).toEqual({ reason: "moduleOff" });
    a.amend((doc) => void (doc.settings.modules = ["expenses", "finances"]));
    act(a, notice, "useMine");
    expect(a.doc.financeMonths["2026-05"].salary).toBe("60000.00");

    const tz = await pair();
    tz.a.amend((doc) => void (doc.settings.timeZone = "Asia/Kolkata"));
    tz.b.amend((doc) => void (doc.settings.timeZone = "Europe/London"));
    const tzNotice = noticeOn(tz.a, tz.b);
    act(tz.a, tzNotice, "useMine");
    expect(tz.a.doc.settings.timeZone).toBe("Asia/Kolkata");
  });
});

describe("Add it back as a new entry (section 4.1, D16)", () => {
  async function lostToDelete() {
    const { a, b } = await pair();
    await a.backend.updateEntry(2026, 5, await rowOf(a, "Groceries"), edit(10));
    const id = groceries(a)!.id;
    await b.backend.deleteEntry(2026, 5, await rowOf(b, "Groceries"));
    return { a, b, id, notice: noticeOn(a, b) };
  }

  it("makes a new id in the same month from the dead record's registers, last in the month", async () => {
    const { a, id, notice } = await lostToDelete();
    expect(actionsFor(notice)).toEqual(["addBack"]);
    expect(groceries(a)).toBeUndefined();
    const [preview] = previewActions(notice, a.doc, a.state, ENV);
    expect(preview.refused).toBeNull();
    expect(preview.writes).toContainEqual({ key: `e/${id}/amount`, value: "10.00" });
    act(a, notice, "addBack");
    const month = a.doc.expenses["2026-05"];
    const back = groceries(a)!;
    expect(back).toMatchObject({ id: ENV.newId(), amount: "10.00", remarks: "Groceries", category: "food", cardNote: null, updatedBy: "alex" });
    expect(back.id).not.toBe(id);
    expect(month.at(-1)).toBe(back);
    expect(back.sortKey > month[0].sortKey).toBe(true);
    // The old id stays deleted: a new delete is the only way to remove the new one.
    expect(a.state.del.has(`e/${id}`)).toBe(true);
  });

  it("refuses on a locked month or a module that is off, and for a record that isn't deleted", async () => {
    const locked = await lostToDelete();
    await locked.a.backend.setMonthLock(2026, 5, true);
    expect(refusal(locked.a, locked.notice, "addBack").status).toBe(403);
    const off = await lostToDelete();
    off.a.amend((doc) => void (doc.settings.modules = ["finances"]));
    expect(previewActions(off.notice, off.a.doc, off.a.state, ENV)[0].refused).toEqual({ reason: "moduleOff" });
    const alive = await lostEdit();
    const fake: StoredNotice = { kind: "deleted", winner: { L: 9, device: B, by: "sam" }, loser: { L: 2, device: A }, target: { kind: "record", coll: "e", id: groceries(alive.a)!.id, month: "2026-05", name: "Groceries" }, seq: 1, at: 0 };
    expect(refusal(alive.a, fake, "addBack").status).toBe(409);
  });

  it("a list record goes last in its list", async () => {
    const { a, b } = await pair();
    const row = (r: Replica) => r.backend.getDebts().then((list) => list[0].row);
    await a.backend.updateDebt(await row(a), { name: "Sam", amount: 450 });
    await b.backend.addDebt({ name: "Kai", amount: 20 });
    await b.backend.deleteDebt(await row(b));
    const notice = noticeOn(a, b);
    act(a, notice, "addBack");
    expect(a.doc.debts.map((d) => [d.name, d.amount])).toEqual([
      ["Kai", "20.00"],
      ["Sam", "450.00"],
    ]);
  });
});

describe("Record again (section 4.1, D20)", () => {
  async function lostPayment() {
    const { a, b } = await pair();
    const row = (r: Replica) => r.backend.getEmis().then((list) => list[0].row);
    await a.backend.payEmi(await row(a), 1000);
    await b.backend.payEmi(await row(b), 1000);
    return { a, b, notice: noticeOn(a, b) };
  }

  it("records the payment again on the EMI as it is now, for its EMI amount, and shows the result first", async () => {
    const { a, notice } = await lostPayment();
    expect(actionsFor(notice)).toEqual(["recordAgain", "useMine"]);
    const before = a.doc.emis[0].remainingAsOf;
    const [again, mine] = previewActions(notice, a.doc, a.state, ENV);
    expect(again.paid).toBe("1000.00");
    expect(again.refused).toBeNull();
    // Use mine would write my pair, which equals theirs here: nothing to do.
    expect(mine.refused).toEqual({ reason: "inEffect" });
    act(a, notice, "recordAgain");
    expect(a.doc.emis[0].remainingAsOf).toBe(again.writes.find((w) => w.key.endsWith("/remainingAsOf"))!.value);
    expect(Number(a.doc.emis[0].remainingAsOf)).toBeLessThan(Number(before));
  });

  it("refuses a deleted EMI, or with EMI off", async () => {
    const gone = await lostPayment();
    await gone.a.backend.deleteEmi((await gone.a.backend.getEmis())[0].row);
    expect(previewActions(gone.notice, gone.a.doc, gone.a.state, ENV).map((p) => p.refused?.reason)).toEqual(["deleted", "deleted"]);
    const off = await lostPayment();
    off.a.amend((doc) => void (doc.settings.modules = ["expenses"]));
    expect(refusal(off.a, off.notice, "recordAgain").status).toBe(404);
  });
});

describe("notices with nothing to do", () => {
  it("fence and rehome notices offer no action, only dismissal; a view names each record", async () => {
    const { a } = await lostEdit();
    const id = groceries(a)!.id;
    const kept: StoredNotice = { kind: "kept", theirs: [3, B], mine: [4, A], registers: [{ key: `e/${id}/amount`, theirs: "12.00", mine: "40.00" }], seq: 2, at: 0 };
    const rehome: StoredNotice = { kind: "rehome", from: A, to: B, message: "moved", seq: 3, at: 0 };
    expect(actionsFor(kept)).toEqual([]);
    expect(actionsFor(rehome)).toEqual([]);
    expect(noticeView("k", kept, a.doc, a.state, ENV)).toEqual({ key: "k", notice: kept, names: { [`e/${id}`]: "Groceries" }, actions: [] });
    expect(() => applyAction(kept, "useMine", structuredClone(a.doc), a.state, ENV)).toThrow(ApiError);
  });
});
