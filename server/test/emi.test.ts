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

describe("emi payments (recordEmiPayment)", () => {
  const paymentInput = { cardOrBank: "Payment Test", emiAmount: 1000, dueDay: 15, totalAmount: 20000, remarks: "" };

  it("an early payment (before the due date) is not later double-decayed once the due date passes", async () => {
    const added = await emi.addEmi({ ...paymentInput, remainingAsOf: 10000 }, new Date(2026, 0, 1)); // asOfDate Jan 1
    const row = added.row;

    // Pay on Jan 10 — 5 days before the Jan 15 due date.
    const paid = await emi.recordEmiPayment(row, 1000, new Date(2026, 0, 10));
    expect(paid).toMatchObject({ remaining: 9000, asOfDate: "2026-01-15" });

    // Now the real due date (Jan 15) passes, then Feb 15 too. If Jan 15 were
    // double-counted, remaining would incorrectly drop to 7000.
    const list = await emi.listEmis(new Date(2026, 1, 16));
    expect(list.find((e) => e.row === row)).toMatchObject({ remaining: 8000 });
  });

  it("paying the standard EMI amount right after the due date already passed is a no-op", async () => {
    const added = await emi.addEmi({ ...paymentInput, remainingAsOf: 10000 }, new Date(2026, 0, 1));
    const row = added.row;

    // The due date (Jan 15) has already passed by the time this runs (Jan 20)
    // — auto-decay already assumes it was paid, so live remaining is 9000.
    const before = await emi.listEmis(new Date(2026, 0, 20));
    expect(before.find((e) => e.row === row)).toMatchObject({ remaining: 9000 });

    const paid = await emi.recordEmiPayment(row, 1000, new Date(2026, 0, 20));
    expect(paid.remaining).toBe(9000); // unchanged — confirms the same event, not a second deduction
  });

  it("catches up several unrecorded months in one payment, same as if each had auto-decayed", async () => {
    const added = await emi.addEmi({ ...paymentInput, remainingAsOf: 10000 }, new Date(2026, 0, 1)); // Jan 1
    const row = added.row;

    // Nothing touched this entry in months; pay April's installment on Apr 10
    // (before Apr 15). Jan/Feb/Mar are assumed auto-paid (3000), April's
    // explicit payment is another 1000 — remaining should be 6000.
    const paid = await emi.recordEmiPayment(row, 1000, new Date(2026, 3, 10));
    expect(paid).toMatchObject({ remaining: 6000, asOfDate: "2026-04-15" });
  });

  it("a custom (non-standard) payment amount is reflected exactly, not clamped to the usual EMI amount", async () => {
    const added = await emi.addEmi({ ...paymentInput, remainingAsOf: 10000 }, new Date(2026, 0, 1));
    const row = added.row;

    // Overpay by 500 this month.
    const paid = await emi.recordEmiPayment(row, 1500, new Date(2026, 0, 10));
    expect(paid.remaining).toBe(8500);
  });

  it("floors at 0 when the payment exceeds the remaining balance", async () => {
    const added = await emi.addEmi({ ...paymentInput, remainingAsOf: 500 }, new Date(2026, 0, 1));
    const row = added.row;

    const paid = await emi.recordEmiPayment(row, 5000, new Date(2026, 0, 10));
    expect(paid).toMatchObject({ remaining: 0, isPaidOff: true });
  });

  it("rejects a negative payment amount", async () => {
    const added = await emi.addEmi({ ...paymentInput, remainingAsOf: 5000 }, new Date(2026, 0, 1));
    await expect(emi.recordEmiPayment(added.row, -1, new Date(2026, 0, 10))).rejects.toMatchObject({ status: 400 });
  });

  it("404s recording a payment against a row that isn't a real entry", async () => {
    await expect(emi.recordEmiPayment(999, 1000)).rejects.toMatchObject({ status: 404 });
  });

  it("advances to next month's due date, not backward, when the due day falls earlier in the month than the snapshot day", async () => {
    // A loan snapshotted on the 30th with a due day of the 15th — the 15th of
    // *this* month has already gone by relative to that snapshot, even though
    // no payment has actually settled it. The anchor must move to next
    // month's due date, never regress to a date before the current anchor.
    const added = await emi.addEmi({ ...paymentInput, remainingAsOf: 12000 }, new Date(2026, 6, 30)); // Jul 30
    const paid = await emi.recordEmiPayment(added.row, 1000, new Date(2026, 6, 30));
    expect(paid).toMatchObject({ remaining: 11000, asOfDate: "2026-08-15" }); // Aug 15, not Jul 15
  });

  it("repeated payments on the same day each advance the anchor forward instead of re-settling the same stuck due date", async () => {
    const added = await emi.addEmi({ ...paymentInput, remainingAsOf: 12000 }, new Date(2026, 6, 30)); // Jul 30
    const first = await emi.recordEmiPayment(added.row, 1000, new Date(2026, 6, 30));
    expect(first).toMatchObject({ remaining: 11000, asOfDate: "2026-08-15" });

    const second = await emi.recordEmiPayment(added.row, 1000, new Date(2026, 6, 30));
    expect(second).toMatchObject({ remaining: 10000, asOfDate: "2026-09-15" }); // advanced again, not stuck

    const third = await emi.recordEmiPayment(added.row, 1000, new Date(2026, 6, 30));
    expect(third).toMatchObject({ remaining: 9000, asOfDate: "2026-10-15" });
  });
});

describe("emi until-target (bank-stated Duration)", () => {
  const durationInput = { cardOrBank: "Duration Test", emiAmount: 1000, dueDay: 15, totalAmount: 12000, remarks: "" };

  it("stores Duration as a real target date, overriding the derived estimate", async () => {
    // 12 full-size installments (12000/1000) would derive an estimate of
    // Dec 2026, but the bank says this one actually finishes in 10 months
    // (Nov 2026) — its last installment must be adjusted to fit.
    const added = await emi.addEmi(
      { ...durationInput, remainingAsOf: 12000, durationMonths: 10 },
      new Date(2026, 0, 1), // Jan 1, 2026
    );
    expect(added.estimatedPayoffMonth).toBe("2026-11");
    expect(added.untilTarget).toBe("2026-11-01");
  });

  it("without a Duration, falls back to the derived remaining/emiAmount estimate as before", async () => {
    const added = await emi.addEmi({ ...durationInput, remainingAsOf: 12000 }, new Date(2026, 0, 1));
    expect(added.untilTarget).toBeNull();
    expect(added.estimatedPayoffMonth).toBe("2026-12"); // ceil(12000/1000) = 12 future due dates from Jan 1
  });

  it("preserves the stored until-target across an edit that doesn't resupply Duration", async () => {
    const added = await emi.addEmi(
      { ...durationInput, remainingAsOf: 12000, durationMonths: 10 },
      new Date(2026, 0, 1),
    );
    const updated = await emi.updateEmi(
      added.row,
      { ...durationInput, remainingAsOf: 9000 }, // correcting the balance, no durationMonths supplied
      new Date(2026, 2, 1),
    );
    expect(updated.untilTarget).toBe("2026-11-01"); // unchanged
    expect(updated.estimatedPayoffMonth).toBe("2026-11");
  });

  it("preserves the stored until-target across recordEmiPayment (never touches it)", async () => {
    const added = await emi.addEmi(
      { ...durationInput, remainingAsOf: 12000, durationMonths: 10 },
      new Date(2026, 0, 1),
    );
    const paid = await emi.recordEmiPayment(added.row, 1000, new Date(2026, 0, 10));
    expect(paid.untilTarget).toBe("2026-11-01");
  });

  it("a fresh Duration on a later edit replaces the old target", async () => {
    const added = await emi.addEmi(
      { ...durationInput, remainingAsOf: 12000, durationMonths: 10 },
      new Date(2026, 0, 1),
    );
    const updated = await emi.updateEmi(
      added.row,
      { ...durationInput, remainingAsOf: 9000, durationMonths: 6 },
      new Date(2026, 2, 1), // Mar 1, 2026
    );
    expect(updated.untilTarget).toBe("2026-09-01"); // Mar 1 + 6 months
  });

  it("until-target is ignored once the loan is actually paid off", async () => {
    const added = await emi.addEmi(
      { ...durationInput, remainingAsOf: 500, durationMonths: 24 },
      new Date(2026, 0, 1),
    );
    const paid = await emi.recordEmiPayment(added.row, 500, new Date(2026, 0, 10));
    expect(paid).toMatchObject({ remaining: 0, isPaidOff: true, estimatedPayoffMonth: null });
  });

  it("rejects a non-integer or out-of-range Duration", async () => {
    await expect(emi.addEmi({ ...durationInput, remainingAsOf: 12000, durationMonths: 0 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(emi.addEmi({ ...durationInput, remainingAsOf: 12000, durationMonths: 1.5 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(emi.addEmi({ ...durationInput, remainingAsOf: 12000, durationMonths: 601 })).rejects.toMatchObject({
      status: 400,
    });
  });
});
