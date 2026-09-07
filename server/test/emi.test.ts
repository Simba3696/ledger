import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";

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
    expect(added.estimatedPayoffDate).toBe("2026-05-15"); // same estimate, full date (dueDay = 15)
  });

  it("decays remaining by one EMI amount per due date that has passed", async () => {
    const list = await emi.listEmis(new Date(2026, 1, 16)); // Feb 16, 2026 — Jan15 + Feb15 both passed
    expect(list).toEqual([
      expect.objectContaining({
        row: 2,
        remaining: 3000,
        isPaidOff: false,
        estimatedPayoffMonth: "2026-05",
        estimatedPayoffDate: "2026-05-15",
      }),
    ]);
  });

  it("floors remaining at 0 and reports paid-off once due dates exceed the balance", async () => {
    const list = await emi.listEmis(new Date(2026, 5, 16)); // Jun 16 — Jan..Jun 15ths all passed (6 installments)
    expect(list).toEqual([
      expect.objectContaining({
        row: 2,
        remaining: 0,
        isPaidOff: true,
        estimatedPayoffMonth: null,
        estimatedPayoffDate: null,
      }),
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
    // untilTarget's day-of-month (1st) comes from *when the loan was added*
    // (Jan 1 + 10 months) and has nothing to do with dueDay — the real final
    // installment is the first actual due date (15th) on or after that
    // target, i.e. Nov 15 here (15th >= 1st, so it lands the same month).
    expect(added.estimatedPayoffDate).toBe("2026-11-15");
  });

  it("without a Duration, falls back to the derived remaining/emiAmount estimate as before", async () => {
    const added = await emi.addEmi({ ...durationInput, remainingAsOf: 12000 }, new Date(2026, 0, 1));
    expect(added.untilTarget).toBeNull();
    expect(added.estimatedPayoffMonth).toBe("2026-12"); // ceil(12000/1000) = 12 future due dates from Jan 1
    expect(added.estimatedPayoffDate).toBe("2026-12-15"); // derived estimate lands on dueDay (15th)
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
    expect(updated.estimatedPayoffDate).toBe("2026-11-15"); // resolved against dueDay, same as above
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

  it("rolls the until-target forward to next month's due date when dueDay falls before the target's day-of-month", async () => {
    // Regression test for a real reported bug: a loan added/edited on the
    // 23rd with dueDay 9 and a Duration landing on "the 23rd, N months out"
    // — since the 9th of that target month already passed relative to the
    // 23rd, the loan doesn't actually finish until the 9th of the *next*
    // month, not that (already-passed) month's 9th.
    const added = await emi.addEmi(
      { cardOrBank: "Moneyback+", emiAmount: 621, dueDay: 9, totalAmount: 20660, remarks: "", remainingAsOf: 27965, durationMonths: 45 },
      new Date(2026, 7, 23), // Aug 23, 2026
    );
    expect(added.untilTarget).toBe("2030-05-23"); // Aug 23, 2026 + 45 months
    expect(added.estimatedPayoffMonth).toBe("2030-06"); // rolled forward a month, not May
    expect(added.estimatedPayoffDate).toBe("2030-06-09");
  });

  it("keeps the until-target's own month when dueDay falls on or after the target's day-of-month", async () => {
    // Symmetric case: dueDay 25 with a target of the 10th — this month's
    // 25th is still on/after the 10th, so no roll-forward is needed.
    const added = await emi.addEmi(
      { cardOrBank: "Same Month", emiAmount: 500, dueDay: 25, totalAmount: 6000, remarks: "", remainingAsOf: 6000, durationMonths: 12 },
      new Date(2026, 0, 10), // Jan 10, 2026
    );
    expect(added.untilTarget).toBe("2027-01-10"); // Jan 10, 2026 + 12 months
    expect(added.estimatedPayoffMonth).toBe("2027-01");
    expect(added.estimatedPayoffDate).toBe("2027-01-25");
  });

  it("until-target is ignored once the loan is actually paid off", async () => {
    const added = await emi.addEmi(
      { ...durationInput, remainingAsOf: 500, durationMonths: 24 },
      new Date(2026, 0, 1),
    );
    const paid = await emi.recordEmiPayment(added.row, 500, new Date(2026, 0, 10));
    expect(paid).toMatchObject({ remaining: 0, isPaidOff: true, estimatedPayoffMonth: null, estimatedPayoffDate: null });
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

describe("emi interest rate (optional)", () => {
  const rateInput = { cardOrBank: "Rate Test", emiAmount: 500, dueDay: 10, totalAmount: 6000, remarks: "" };

  it("defaults to null when not supplied at all", async () => {
    const added = await emi.addEmi({ ...rateInput, remainingAsOf: 6000 });
    expect(added.interestRate).toBeNull();
  });

  it("stores and round-trips an interest rate", async () => {
    const added = await emi.addEmi({ ...rateInput, remainingAsOf: 6000, interestRate: 12.5 });
    expect(added.interestRate).toBe(12.5);
    const [listed] = await emi.listEmis().then((all) => all.filter((e) => e.row === added.row));
    expect(listed.interestRate).toBe(12.5);
  });

  it("allows 0% (an interest-free EMI conversion)", async () => {
    const added = await emi.addEmi({ ...rateInput, remainingAsOf: 6000, interestRate: 0 });
    expect(added.interestRate).toBe(0);
  });

  it("rejects a negative or out-of-range interest rate", async () => {
    await expect(emi.addEmi({ ...rateInput, remainingAsOf: 6000, interestRate: -1 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(emi.addEmi({ ...rateInput, remainingAsOf: 6000, interestRate: 101 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(emi.addEmi({ ...rateInput, remainingAsOf: 6000, interestRate: NaN })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("is a plain overwritable field on edit — updates, clears, and doesn't need to be resupplied to keep other fields", async () => {
    const added = await emi.addEmi({ ...rateInput, remainingAsOf: 6000, interestRate: 10 });

    const updated = await emi.updateEmi(added.row, { ...rateInput, remainingAsOf: 5000, interestRate: 15 });
    expect(updated.interestRate).toBe(15);

    // Omitting it on a later edit clears it (unlike durationMonths/
    // untilTarget, there's no "preserve if omitted" behavior for this field).
    const cleared = await emi.updateEmi(added.row, { ...rateInput, remainingAsOf: 4000 });
    expect(cleared.interestRate).toBeNull();
  });

  it("survives recordEmiPayment unchanged", async () => {
    const added = await emi.addEmi({ ...rateInput, remainingAsOf: 6000, interestRate: 18 });
    const paid = await emi.recordEmiPayment(added.row, 500);
    expect(paid.interestRate).toBe(18);
  });

  it("defaults a legacy entry with no interest-rate column (pre-dating the field) to null rather than rejecting it", async () => {
    // Simulates a real pre-existing EMI.xlsx written before this column
    // existed: only 8 columns, no 9th at all.
    const emiPath = path.join(scratchDir, "EMI.xlsx");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(emiPath);
    const sheet = workbook.getWorksheet("EMI")!;
    const row = sheet.getRow(sheet.rowCount + 1);
    row.getCell(1).value = "Legacy Loan";
    row.getCell(2).value = 500;
    row.getCell(3).value = 10;
    row.getCell(4).value = 5000;
    row.getCell(5).value = "";
    row.getCell(6).value = 5000;
    row.getCell(7).value = "2026-01-01";
    // No cell 8 (untilTarget) or 9 (interestRate) at all.
    row.commit();
    await workbook.xlsx.writeFile(emiPath);

    const all = await emi.listEmis(new Date(2026, 0, 1));
    const legacy = all.find((e) => e.cardOrBank === "Legacy Loan");
    expect(legacy?.interestRate).toBeNull();
  });
});

describe("emi foreclosure charge (optional)", () => {
  const chargeInput = { cardOrBank: "Charge Test", emiAmount: 500, dueDay: 10, totalAmount: 6000, remarks: "" };

  it("defaults to null when not supplied at all", async () => {
    const added = await emi.addEmi({ ...chargeInput, remainingAsOf: 6000 });
    expect(added.foreclosureCharge).toBeNull();
  });

  it("stores and round-trips a foreclosure charge", async () => {
    const added = await emi.addEmi({ ...chargeInput, remainingAsOf: 6000, foreclosureCharge: 2.5 });
    expect(added.foreclosureCharge).toBe(2.5);
    const [listed] = await emi.listEmis().then((all) => all.filter((e) => e.row === added.row));
    expect(listed.foreclosureCharge).toBe(2.5);
  });

  it("allows 0% (e.g. this CRED/IDFC FIRST loan, which charges no foreclosure fee)", async () => {
    const added = await emi.addEmi({ ...chargeInput, remainingAsOf: 6000, foreclosureCharge: 0 });
    expect(added.foreclosureCharge).toBe(0);
  });

  it("rejects a negative or out-of-range foreclosure charge", async () => {
    await expect(emi.addEmi({ ...chargeInput, remainingAsOf: 6000, foreclosureCharge: -1 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(emi.addEmi({ ...chargeInput, remainingAsOf: 6000, foreclosureCharge: 101 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(emi.addEmi({ ...chargeInput, remainingAsOf: 6000, foreclosureCharge: NaN })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("is a plain overwritable field on edit — updates, clears, and doesn't need to be resupplied to keep other fields", async () => {
    const added = await emi.addEmi({ ...chargeInput, remainingAsOf: 6000, foreclosureCharge: 3 });

    const updated = await emi.updateEmi(added.row, { ...chargeInput, remainingAsOf: 5000, foreclosureCharge: 4 });
    expect(updated.foreclosureCharge).toBe(4);

    // Omitting it on a later edit clears it — same plain-field semantics as
    // interestRate, unlike durationMonths/untilTarget's preserve-if-omitted.
    const cleared = await emi.updateEmi(added.row, { ...chargeInput, remainingAsOf: 4000 });
    expect(cleared.foreclosureCharge).toBeNull();
  });

  it("survives recordEmiPayment unchanged", async () => {
    const added = await emi.addEmi({ ...chargeInput, remainingAsOf: 6000, foreclosureCharge: 5 });
    const paid = await emi.recordEmiPayment(added.row, 500);
    expect(paid.foreclosureCharge).toBe(5);
  });

  it("defaults a legacy entry with no foreclosure-charge column (pre-dating the field) to null rather than rejecting it", async () => {
    // Simulates a real pre-existing EMI.xlsx written before this column
    // existed: 9 columns (interestRate already existed), no 10th at all.
    const emiPath = path.join(scratchDir, "EMI.xlsx");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(emiPath);
    const sheet = workbook.getWorksheet("EMI")!;
    const row = sheet.getRow(sheet.rowCount + 1);
    row.getCell(1).value = "Legacy Loan 2";
    row.getCell(2).value = 500;
    row.getCell(3).value = 10;
    row.getCell(4).value = 5000;
    row.getCell(5).value = "";
    row.getCell(6).value = 5000;
    row.getCell(7).value = "2026-01-01";
    row.getCell(9).value = 15; // interestRate present, foreclosureCharge (10) not
    row.commit();
    await workbook.xlsx.writeFile(emiPath);

    const all = await emi.listEmis(new Date(2026, 0, 1));
    const legacy = all.find((e) => e.cardOrBank === "Legacy Loan 2");
    expect(legacy).toMatchObject({ interestRate: 15, foreclosureCharge: null });
  });
});

describe("emiMonthlyProjection", () => {
  // The EMI.xlsx workbook is shared across this whole test file (one scratch
  // dir, created once at the top), so by the time this block runs it already
  // holds EMIs from every earlier describe block. Rather than asserting an
  // exact full result (which every prior test's leftover data would break),
  // each test here snapshots the projection *before* adding its own EMI(s)
  // and asserts the delta — robust regardless of whatever else is already
  // in the workbook.
  it("returns exactly `months` entries, one per calendar month starting this month", async () => {
    const result = await emi.emiMonthlyProjection(5, new Date(2026, 0, 1));
    expect(result.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]);
  });

  it("buckets a fresh loan's full-size installments by their real due month, including a smaller final one", async () => {
    const before = await emi.emiMonthlyProjection(4, new Date(2026, 0, 1));
    await emi.addEmi(
      // 2 full ₹1000 installments + one ₹500 final one (2500 remaining).
      { cardOrBank: "Proj Fresh", emiAmount: 1000, dueDay: 15, totalAmount: 2500, remarks: "", remainingAsOf: 2500 },
      new Date(2026, 0, 1),
    );
    const after = await emi.emiMonthlyProjection(4, new Date(2026, 0, 1));
    const delta = after.map((m, i) => ({
      month: m.month,
      count: m.count - before[i].count,
      totalAmount: m.totalAmount - before[i].totalAmount,
    }));
    expect(delta).toEqual([
      { month: "2026-01", count: 1, totalAmount: 1000 },
      { month: "2026-02", count: 1, totalAmount: 1000 },
      { month: "2026-03", count: 1, totalAmount: 500 }, // final partial installment
      { month: "2026-04", count: 0, totalAmount: 0 }, // already paid off by then
    ]);
  });

  it("sums multiple active EMIs due in the same month", async () => {
    const before = await emi.emiMonthlyProjection(1, new Date(2026, 0, 1));
    await emi.addEmi(
      { cardOrBank: "Proj A", emiAmount: 500, dueDay: 10, totalAmount: 500, remarks: "", remainingAsOf: 500 },
      new Date(2026, 0, 1),
    );
    await emi.addEmi(
      { cardOrBank: "Proj B", emiAmount: 700, dueDay: 20, totalAmount: 700, remarks: "", remainingAsOf: 700 },
      new Date(2026, 0, 1),
    );
    const after = await emi.emiMonthlyProjection(1, new Date(2026, 0, 1));
    expect(after[0].count - before[0].count).toBe(2);
    expect(after[0].totalAmount - before[0].totalAmount).toBe(1200);
  });

  it("excludes an already-paid-off EMI entirely", async () => {
    const before = await emi.emiMonthlyProjection(2, new Date(2026, 0, 1));
    const added = await emi.addEmi(
      { cardOrBank: "Proj PaidOff", emiAmount: 500, dueDay: 5, totalAmount: 500, remarks: "", remainingAsOf: 500 },
      new Date(2026, 0, 1),
    );
    await emi.recordEmiPayment(added.row, 500, new Date(2026, 0, 1));
    const after = await emi.emiMonthlyProjection(2, new Date(2026, 0, 1));
    expect(after).toEqual(before);
  });

  it("doesn't include a due date that falls outside the requested window", async () => {
    // dueDay 25, anchored the 26th — that month's 25th has already passed
    // relative to the anchor, so the *next* real due date is next month's
    // 25th, which a 1-month (this-month-only) window must not include.
    const before = await emi.emiMonthlyProjection(1, new Date(2026, 0, 26));
    await emi.addEmi(
      { cardOrBank: "Proj OutOfWindow", emiAmount: 400, dueDay: 25, totalAmount: 400, remarks: "", remainingAsOf: 400 },
      new Date(2026, 0, 26),
    );
    const after = await emi.emiMonthlyProjection(1, new Date(2026, 0, 26));
    expect(after).toEqual(before);
  });

  it("doesn't crash when an EMI's asOfDate is stale (no payment recorded in a while)", async () => {
    // Regression test for a real reported crash: added back in January with
    // no payment recorded since, so by June this asOfDate is 5 months stale.
    // nextDueDateAfter(asOfDate, dueDay) landed in a month *before* the
    // projection window (whose first month is June, where "today" is), so
    // the bucket lookup for it returned undefined and threw
    // "Cannot read properties of undefined (reading 'count')" — this must
    // instead anchor on "today" here, not the stale stored date.
    const before = await emi.emiMonthlyProjection(3, new Date(2026, 5, 15)); // Jun 15, 2026
    await emi.addEmi(
      { cardOrBank: "Proj Stale", emiAmount: 500, dueDay: 10, totalAmount: 5000, remarks: "", remainingAsOf: 5000 },
      new Date(2026, 0, 1), // Jan 1, 2026
    );
    const after = await emi.emiMonthlyProjection(3, new Date(2026, 5, 15));
    const delta = after.map((m, i) => ({
      month: m.month,
      count: m.count - before[i].count,
      totalAmount: m.totalAmount - before[i].totalAmount,
    }));
    expect(delta).toEqual([
      { month: "2026-06", count: 0, totalAmount: 0 }, // this month's own 10th already passed by the 15th
      { month: "2026-07", count: 1, totalAmount: 500 },
      { month: "2026-08", count: 1, totalAmount: 500 },
    ]);
  });
});
