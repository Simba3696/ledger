import { describe, expect, it } from "vitest";
import type { HostWrite } from "../document/DocumentBackend";
import type { LedgerDocument } from "../document/types";
import { draftOf, settleDraft } from "./draft";
import { Replica, Rng, deviceId, emptyDocument, forEachSeed, randomWrite } from "./testkit";

// A write's copy made as the write reads it (draft.ts, stage 8c-2): it reads
// exactly as DocumentBackend's whole structuredClone would, key order
// included, before and after any change; its source never changes; and once
// settled it shares with the source exactly the parts the write never read.

const A = deviceId(0xa);

function sample(): LedgerDocument {
  const doc = emptyDocument();
  const stamp = { updatedAt: 1, updatedBy: "alex" };
  const expense = (id: string, remarks: string) => ({ id, ...stamp, sortKey: "a0", amount: "40.00", remarks, category: "food", cardNote: null });
  doc.expenses["2026-01"] = [expense("00000000-0000-4000-8000-000000000001", "Bus")];
  doc.expenses["2026-02"] = [expense("00000000-0000-4000-8000-000000000002", "Tea")];
  doc.expenses["2026-03"] = [expense("00000000-0000-4000-8000-000000000003", "Rent")];
  doc.monthLocks["2026-01"] = true;
  doc.financeMonths["2026-01"] = { salary: "50000.00", otherIncome: null, savings: [{ name: "Fund A", amount: "10.00" }] };
  doc.debts = [{ id: "00000000-0000-4000-8000-000000000004", ...stamp, name: "Sam", amount: "500.00" }];
  return doc;
}

describe("draftOf and settleDraft", () => {
  it("reads as a whole clone does, key order included", () => {
    const doc = sample();
    const draft = draftOf(doc);
    expect(JSON.stringify(draft)).toBe(JSON.stringify(doc));
    expect(Object.keys(draft)).toEqual(Object.keys(doc));
    expect(Object.keys(draft.expenses)).toEqual(Object.keys(doc.expenses));
    expect("2026-02" in draft.expenses).toBe(true);
    expect(Object.hasOwn(draft.expenses, "2026-04")).toBe(false);
    expect(draft.expenses["2026-04"]).toBeUndefined();
  });

  it("hands out copies: nothing changed through a draft reaches its source", () => {
    const doc = sample();
    const text = JSON.stringify(doc);
    const draft = draftOf(doc);
    draft.expenses["2026-02"][0].remarks = "Coffee";
    draft.expenses["2026-01"].push({ ...draft.expenses["2026-01"][0], id: "00000000-0000-4000-8000-000000000009" });
    draft.financeMonths["2026-01"].savings[0].amount = "20.00";
    draft.debts[0].amount = "1.00";
    draft.settings.modules.pop();
    draft.categories[0].label = "Changed";
    draft.tombstones.push({ id: "x", deletedAt: 1 });
    delete draft.monthLocks["2026-01"];
    expect(JSON.stringify(doc)).toBe(text);
  });

  it("settles to a plain document sharing exactly the parts the write never read", () => {
    const doc = sample();
    const draft = draftOf(doc);
    draft.expenses["2026-02"][0].remarks = "Coffee";
    const settled = settleDraft(draft);
    // Plain data, the same text as the clone the write would have changed.
    const clone = structuredClone(doc);
    clone.expenses["2026-02"][0].remarks = "Coffee";
    expect(JSON.stringify(settled)).toBe(JSON.stringify(clone));
    expect(Object.getOwnPropertyDescriptor(settled, "expenses")?.get).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(settled.expenses, "2026-01")?.get).toBeUndefined();
    // Read: copies. Not read: the source's own.
    expect(settled.expenses["2026-02"]).not.toBe(doc.expenses["2026-02"]);
    expect(settled.expenses).not.toBe(doc.expenses);
    for (const month of ["2026-01", "2026-03"]) expect(settled.expenses[month]).toBe(doc.expenses[month]);
    for (const part of ["settings", "categories", "monthLocks", "financeMonths", "debts", "emis", "subscriptions", "cardBills", "tombstones"] as const) expect(settled[part]).toBe(doc[part]);
    // Settling is the identity on anything that isn't a draft.
    expect(settleDraft(doc)).toBe(doc);
  });

  it("keeps a plain object's key order through deletes, re-adds and new keys", () => {
    const doc = sample();
    const draft = draftOf(doc);
    const clone = structuredClone(doc);
    for (const target of [draft, clone]) {
      delete target.expenses["2026-01"];
      target.expenses["2026-04"] = [];
      target.expenses["2026-01"] = target.expenses["2026-03"];
      target.expenses["2026-02"] = [...target.expenses["2026-02"]];
      target.monthLocks["2026-02"] = true;
      target.debts = [];
    }
    expect(JSON.stringify(draft)).toBe(JSON.stringify(clone));
    expect(JSON.stringify(settleDraft(draft))).toBe(JSON.stringify(clone));
  });
});

/** A Replica whose writes run on a draft, as SyncedHost's do. */
class DraftReplica extends Replica {
  drafts = 0;

  begin(): HostWrite {
    return {
      draft: (doc) => {
        this.drafts++;
        return draftOf(doc);
      },
      commit: (next) => this.commit(settleDraft(next)),
      end: () => {},
    };
  }
}

describe("a write on a draft, through DocumentBackend", () => {
  it("makes the same document and the same op as a write on a whole clone, and never changes the document before it", async () => {
    await forEachSeed(30, async (seed) => {
      const ids = (prefix: string) => {
        let n = 0;
        return () => `6f1e2d3c-4b5a-4987-8a6b-${prefix}${(++n).toString(16).padStart(10, "0")}`;
      };
      const plain = new Replica(A, emptyDocument(), { newId: ids("00") });
      const drafted = new DraftReplica(A, emptyDocument(), { newId: ids("00") });
      const [rngA, rngB] = [new Rng(seed), new Rng(seed)];
      for (let i = 0; i < 60; i++) {
        const before = drafted.doc;
        const text = JSON.stringify(before);
        await randomWrite(rngA, plain.backend);
        await randomWrite(rngB, drafted.backend);
        expect(JSON.stringify(before)).toBe(text);
        expect(JSON.stringify(drafted.doc)).toBe(JSON.stringify(plain.doc));
      }
      expect(drafted.ops).toEqual(plain.ops);
      expect(drafted.drafts).toBeGreaterThan(30);
    });
  }, 60_000);
});
