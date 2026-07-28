import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Same pattern as debts.test.ts: LEDGER_DB_DIR must be set before emi.ts's
// top-level DB_DIR evaluates, so it's imported dynamically after the env var
// is set rather than via a static top-level import.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-emi-test-"));
process.env.LEDGER_DB_DIR = scratchDir;

const emi = await import("../src/excel/emi.js");

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

const baseInput = {
  cardOrBank: "Coral",
  emiAmount: 1000,
  dueDay: 15,
  totalAmount: 6000,
  remarks: "Doctor Plus",
  remainingAsOf: 5000,
};

describe("emi", () => {
  it("starts empty when no workbook exists yet", async () => {
    expect(await emi.listEmis()).toEqual([]);
  });

  it("computes remaining as the untouched snapshot before any due date has passed", async () => {
    const added = await emi.addEmi(baseInput, new Date(2026, 0, 1)); // Jan 1, 2026
    expect(added).toMatchObject({ row: 2, cardOrBank: "Coral", remaining: 5000, isPaidOff: false, asOfDate: "2026-01-01" });
    // 5 more Jan-15ths (2026-01 already happened as of Jan 1? No: Jan1 < Jan15, so
    // the 5th future due date from Jan 1 is 2026-05 (Jan, Feb, Mar, Apr, May).
    expect(added.estimatedPayoffMonth).toBe("2026-05");
  });

  it("decays remaining by one EMI amount per due date that has passed", async () => {
    const list = await emi.listEmis(new Date(2026, 1, 16)); // Feb 16, 2026 — Jan15 + Feb15 both passed
    expect(list).toEqual([
      expect.objectContaining({ row: 2, remaining: 3000, isPaidOff: false, estimatedPayoffMonth: "2026-05" }),
    ]);
  });

  it("floors remaining at 0 and reports paid-off once due dates exceed the balance", async () => {
    const list = await emi.listEmis(new Date(2026, 5, 16)); // Jun 16 — Jan..Jun 15ths all passed (6 installments)
    expect(list).toEqual([
      expect.objectContaining({ row: 2, remaining: 0, isPaidOff: true, estimatedPayoffMonth: null }),
    ]);
  });

  it("clamps a due day past the end of a shorter month (e.g. 31 in February)", async () => {
    await emi.updateEmi(2, { ...baseInput, dueDay: 31, remainingAsOf: 5000 }, new Date(2026, 0, 1));
    // Due dates: Jan 31, Feb 28 (clamped), both <= Mar 1 — 2 installments passed.
    const list = await emi.listEmis(new Date(2026, 2, 1));
    expect(list[0]).toMatchObject({ remaining: 3000 });
  });

  it("updating an entry resets the decay anchor to the update's date", async () => {
    const updated = await emi.updateEmi(2, { ...baseInput, remainingAsOf: 2500 }, new Date(2026, 3, 1));
    expect(updated).toMatchObject({ remainingAsOf: 2500, asOfDate: "2026-04-01", remaining: 2500 });
  });

  it("deletes an entry, e.g. after foreclosing a loan early", async () => {
    await emi.addEmi({ ...baseInput, cardOrBank: "Amazon Pay" }, new Date(2026, 3, 1));
    const beforeDelete = await emi.listEmis(new Date(2026, 3, 1));
    expect(beforeDelete).toHaveLength(2);

    await emi.deleteEmi(2); // remove Coral
    const afterDelete = await emi.listEmis(new Date(2026, 3, 1));
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]).toMatchObject({ cardOrBank: "Amazon Pay" });
  });

  it("rejects a blank Card/Bank", async () => {
    await expect(emi.addEmi({ ...baseInput, cardOrBank: "  " })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a non-positive EMI amount", async () => {
    await expect(emi.addEmi({ ...baseInput, emiAmount: 0 })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a due day outside 1-31", async () => {
    await expect(emi.addEmi({ ...baseInput, dueDay: 32 })).rejects.toMatchObject({ status: 400 });
    await expect(emi.addEmi({ ...baseInput, dueDay: 0 })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a negative Remaining or Total Amount", async () => {
    await expect(emi.addEmi({ ...baseInput, remainingAsOf: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(emi.addEmi({ ...baseInput, totalAmount: -1 })).rejects.toMatchObject({ status: 400 });
  });

  it("404s updating or deleting a row that isn't a real entry", async () => {
    await expect(emi.updateEmi(99, baseInput)).rejects.toMatchObject({ status: 404 });
    await expect(emi.deleteEmi(99)).rejects.toMatchObject({ status: 404 });
    await expect(emi.updateEmi(1, baseInput)).rejects.toMatchObject({ status: 404 });
  });
});
