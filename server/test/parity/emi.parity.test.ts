import { describe, expect } from "vitest";
import type { EmiEdits, EmiProjectionScale } from "../../../client/src/api";
import type { LedgerBackend } from "../../../client/src/backend/LedgerBackend";
import { MISSING_ID, parity } from "./harness";
import type { SeedEmi } from "./seed";

// server/test/emi.test.ts against both backends. The store cases pass
// "today" to each store call; here the pinned clock is moved with at()
// before each call instead, which is the "today" both backends read. The
// store cases also share one table in order (later blocks see earlier
// blocks' loans); each case here plants what it relies on.

/** An EMI body as a client may send it: fields left out stay left out. */
function emi(fields: Partial<EmiEdits>): EmiEdits {
  return fields as EmiEdits;
}

/** Any month count the route accepts, not only the scales the UI offers. */
function months(count: number | "auto"): EmiProjectionScale {
  return count as EmiProjectionScale;
}

const baseInput = { cardOrBank: "Coral", emiAmount: 1000, dueDay: 15, totalAmount: 6000, remarks: "Doctor Plus", remainingAsOf: 5000 };
const coral: SeedEmi = { ...baseInput, asOfDate: "2026-01-01" };

describe("emi", () => {
  parity("starts empty when no workbook exists yet", {}, async (b) => {
    await b.getEmis();
  });

  parity("computes remaining as the untouched snapshot before any due date has passed", {}, async (b, { at }) => {
    at("2026-01-01");
    const added = await b.addEmi(emi(baseInput));
    expect(added).toMatchObject({ cardOrBank: "Coral", remaining: 5000, isPaidOff: false, asOfDate: "2026-01-01" });
    expect(added.estimatedPayoffMonth).toBe("2026-05");
    expect(added.estimatedPayoffDate).toBe("2026-05-15");
  });

  parity("decays remaining by one EMI amount per due date that has passed", { emis: [coral] }, async (b, { at }) => {
    at("2026-02-16");
    await b.getEmis();
  });

  parity("floors remaining at 0 and reports paid-off once due dates exceed the balance", { emis: [coral] }, async (b, { at }) => {
    at("2026-06-16");
    await b.getEmis();
  });

  parity("clamps a due day past the end of a shorter month (e.g. 31 in February)", { emis: [coral] }, async (b, { at, ids }) => {
    at("2026-01-01");
    await b.updateEmi(ids.emi(0), emi({ ...baseInput, dueDay: 31, remainingAsOf: 5000 }));
    at("2026-03-01");
    expect((await b.getEmis())[0]).toMatchObject({ remaining: 3000 });
  });

  parity("updating an entry resets the decay anchor to the update's date", { emis: [coral] }, async (b, { at, ids }) => {
    at("2026-04-01");
    await b.updateEmi(ids.emi(0), emi({ ...baseInput, remainingAsOf: 2500 }));
  });

  parity("deletes an entry, e.g. after foreclosing a loan early", { emis: [coral] }, async (b, { at, ids }) => {
    at("2026-04-01");
    await b.addEmi(emi({ ...baseInput, cardOrBank: "Amazon Pay" }));
    await b.getEmis();
    await b.deleteEmi(ids.emi(0));
    await b.getEmis();
  });

  parity("rejects a blank Card/Bank", {}, async (b) => {
    await b.addEmi(emi({ ...baseInput, cardOrBank: "  " }));
    await b.addEmi(emi({ ...baseInput, cardOrBank: undefined }));
  });

  parity("rejects a non-positive EMI amount", {}, async (b) => {
    await b.addEmi(emi({ ...baseInput, emiAmount: 0 }));
    await b.addEmi(emi({ ...baseInput, emiAmount: -1 }));
  });

  parity("rejects a due day outside 1-31", {}, async (b) => {
    await b.addEmi(emi({ ...baseInput, dueDay: 32 }));
    await b.addEmi(emi({ ...baseInput, dueDay: 0 }));
    await b.addEmi(emi({ ...baseInput, dueDay: 1.5 }));
  });

  parity("rejects a negative Remaining or Total Amount", {}, async (b) => {
    await b.addEmi(emi({ ...baseInput, remainingAsOf: -1 }));
    await b.addEmi(emi({ ...baseInput, totalAmount: -1 }));
  });

  parity("404s updating or deleting a row that isn't a real entry", { emis: [coral] }, async (b, { ids }) => {
    await b.updateEmi(MISSING_ID, emi(baseInput));
    await b.deleteEmi(MISSING_ID);
    await b.deleteEmi(ids.emi(0));
    await b.updateEmi(ids.emi(0), emi(baseInput));
    await b.getEmis();
  });

  parity("404s an id that can't exist (not a positive integer) before querying", { emis: [coral] }, async (b) => {
    for (const row of [0, -1, Number.NaN, 1.5]) {
      await b.updateEmi(row, emi(baseInput));
      await b.deleteEmi(row);
      await b.payEmi(row, 1000);
    }
  });

  parity("rejects values the database columns can't hold with a 400, not a database error", {}, async (b, { at }) => {
    await b.addEmi(emi({ ...baseInput, emiAmount: 1e12 }));
    await b.addEmi(emi({ ...baseInput, totalAmount: 999999999999.995 }));
    await b.addEmi(emi({ ...baseInput, remainingAsOf: 1e15 }));
    await b.addEmi(emi({ ...baseInput, emiAmount: 0.001 }));
    await b.addEmi(emi({ ...baseInput, cardOrBank: "Co\u0000ral" }));
    await b.addEmi(emi({ ...baseInput, remarks: "Doctor\u0000Plus" }));
    at("2026-04-01");
    const big = await b.addEmi(
      emi({ ...baseInput, cardOrBank: "Big", emiAmount: 999999999999.99, totalAmount: 999999999999.99, remainingAsOf: 999999999999.99 }),
    );
    await b.deleteEmi(big.row);
    await b.getEmis();
  });
});

describe("emi payments (recordEmiPayment)", () => {
  const paymentInput = { cardOrBank: "Payment Test", emiAmount: 1000, dueDay: 15, totalAmount: 20000, remarks: "" };

  parity("an early payment (before the due date) is not later double-decayed once the due date passes", {}, async (b, { at }) => {
    at("2026-01-01");
    const added = await b.addEmi(emi({ ...paymentInput, remainingAsOf: 10000 }));
    at("2026-01-10");
    const paid = await b.payEmi(added.row, 1000);
    expect(paid).toMatchObject({ remaining: 9000, asOfDate: "2026-01-15" });
    at("2026-02-16");
    await b.getEmis();
  });

  parity("paying the standard EMI amount right after the due date already passed is a no-op", {}, async (b, { at }) => {
    at("2026-01-01");
    const added = await b.addEmi(emi({ ...paymentInput, remainingAsOf: 10000 }));
    at("2026-01-20");
    await b.getEmis();
    expect((await b.payEmi(added.row, 1000)).remaining).toBe(9000);
  });

  parity("catches up several unrecorded months in one payment, same as if each had auto-decayed", {}, async (b, { at }) => {
    at("2026-01-01");
    const added = await b.addEmi(emi({ ...paymentInput, remainingAsOf: 10000 }));
    at("2026-04-10");
    await b.payEmi(added.row, 1000);
  });

  parity("a custom (non-standard) payment amount is reflected exactly, not clamped to the usual EMI amount", {}, async (b, { at }) => {
    at("2026-01-01");
    const added = await b.addEmi(emi({ ...paymentInput, remainingAsOf: 10000 }));
    at("2026-01-10");
    await b.payEmi(added.row, 1500);
  });

  parity("floors at 0 when the payment exceeds the remaining balance", {}, async (b, { at }) => {
    at("2026-01-01");
    const added = await b.addEmi(emi({ ...paymentInput, remainingAsOf: 500 }));
    at("2026-01-10");
    await b.payEmi(added.row, 5000);
  });

  parity("rejects a negative payment amount", {}, async (b, { at }) => {
    at("2026-01-01");
    const added = await b.addEmi(emi({ ...paymentInput, remainingAsOf: 5000 }));
    at("2026-01-10");
    await b.payEmi(added.row, -1);
    await b.payEmi(added.row, "lots" as unknown as number);
    await b.getEmis();
  });

  parity("404s recording a payment against a row that isn't a real entry", {}, async (b) => {
    await b.payEmi(MISSING_ID, 1000);
  });

  parity(
    "advances to next month's due date, not backward, when the due day falls earlier in the month than the snapshot day",
    {},
    async (b, { at }) => {
      at("2026-07-30");
      const added = await b.addEmi(emi({ ...paymentInput, remainingAsOf: 12000 }));
      expect(await b.payEmi(added.row, 1000)).toMatchObject({ remaining: 11000, asOfDate: "2026-08-15" });
    },
  );

  parity(
    "repeated payments on the same day each advance the anchor forward instead of re-settling the same stuck due date",
    {},
    async (b, { at }) => {
      at("2026-07-30");
      const added = await b.addEmi(emi({ ...paymentInput, remainingAsOf: 12000 }));
      await b.payEmi(added.row, 1000);
      await b.payEmi(added.row, 1000);
      expect(await b.payEmi(added.row, 1000)).toMatchObject({ remaining: 9000, asOfDate: "2026-10-15" });
    },
  );
});

describe("emi until-target (bank-stated Duration)", () => {
  const durationInput = { cardOrBank: "Duration Test", emiAmount: 1000, dueDay: 15, totalAmount: 12000, remarks: "" };

  parity("stores Duration as a real target date, overriding the derived estimate", {}, async (b, { at }) => {
    at("2026-01-01");
    const added = await b.addEmi(emi({ ...durationInput, remainingAsOf: 12000, durationMonths: 10 }));
    expect(added).toMatchObject({ estimatedPayoffMonth: "2026-11", untilTarget: "2026-11-01", estimatedPayoffDate: "2026-11-15" });
  });

  parity("without a Duration, falls back to the derived remaining/emiAmount estimate as before", {}, async (b, { at }) => {
    at("2026-01-01");
    await b.addEmi(emi({ ...durationInput, remainingAsOf: 12000 }));
  });

  parity("preserves the stored until-target across an edit that doesn't resupply Duration", {}, async (b, { at }) => {
    at("2026-01-01");
    const added = await b.addEmi(emi({ ...durationInput, remainingAsOf: 12000, durationMonths: 10 }));
    at("2026-03-01");
    await b.updateEmi(added.row, emi({ ...durationInput, remainingAsOf: 9000 }));
    await b.updateEmi(added.row, emi({ ...durationInput, remainingAsOf: 9000, durationMonths: null }));
  });

  parity("preserves the stored until-target across recordEmiPayment (never touches it)", {}, async (b, { at }) => {
    at("2026-01-01");
    const added = await b.addEmi(emi({ ...durationInput, remainingAsOf: 12000, durationMonths: 10 }));
    at("2026-01-10");
    await b.payEmi(added.row, 1000);
  });

  parity("a fresh Duration on a later edit replaces the old target", {}, async (b, { at }) => {
    at("2026-01-01");
    const added = await b.addEmi(emi({ ...durationInput, remainingAsOf: 12000, durationMonths: 10 }));
    at("2026-03-01");
    await b.updateEmi(added.row, emi({ ...durationInput, remainingAsOf: 9000, durationMonths: 6 }));
  });

  parity(
    "rolls the until-target forward to next month's due date when dueDay falls before the target's day-of-month",
    {},
    async (b, { at }) => {
      at("2026-08-23");
      await b.addEmi(
        emi({ cardOrBank: "Moneyback+", emiAmount: 621, dueDay: 9, totalAmount: 20660, remarks: "", remainingAsOf: 27965, durationMonths: 45 }),
      );
    },
  );

  parity("keeps the until-target's own month when dueDay falls on or after the target's day-of-month", {}, async (b, { at }) => {
    at("2026-01-10");
    await b.addEmi(
      emi({ cardOrBank: "Same Month", emiAmount: 500, dueDay: 25, totalAmount: 6000, remarks: "", remainingAsOf: 6000, durationMonths: 12 }),
    );
  });

  parity("until-target is ignored once the loan is actually paid off", {}, async (b, { at }) => {
    at("2026-01-01");
    const added = await b.addEmi(emi({ ...durationInput, remainingAsOf: 500, durationMonths: 24 }));
    at("2026-01-10");
    await b.payEmi(added.row, 500);
  });

  parity("rejects a non-integer or out-of-range Duration", {}, async (b) => {
    for (const durationMonths of [0, 1.5, 601, -1]) {
      await b.addEmi(emi({ ...durationInput, remainingAsOf: 12000, durationMonths }));
    }
    await b.addEmi(emi({ ...durationInput, remainingAsOf: 12000, durationMonths: "" as unknown as number }));
    await b.getEmis();
  });
});

/** The scenarios the interest-rate and foreclosure-charge blocks share:
 * both are optional, plainly overwritable numeric(6,3) fields. */
function optionalRateCases(field: "interestRate" | "foreclosureCharge", values: { stored: number; first: number; second: number; kept: number }) {
  const input = { cardOrBank: field === "interestRate" ? "Rate Test" : "Charge Test", emiAmount: 500, dueDay: 10, totalAmount: 6000, remarks: "" };
  return {
    defaultsToNull: async (b: LedgerBackend) => {
      const added = await b.addEmi(emi({ ...input, remainingAsOf: 6000 }));
      expect(added[field]).toBeNull();
    },
    roundTrips: async (b: LedgerBackend) => {
      const added = await b.addEmi(emi({ ...input, remainingAsOf: 6000, [field]: values.stored }));
      expect(added[field]).toBe(values.stored);
      await b.getEmis();
    },
    allowsZero: async (b: LedgerBackend) => {
      await b.addEmi(emi({ ...input, remainingAsOf: 6000, [field]: 0 }));
    },
    rejectsOutOfRange: async (b: LedgerBackend) => {
      await b.addEmi(emi({ ...input, remainingAsOf: 6000, [field]: -1 }));
      await b.addEmi(emi({ ...input, remainingAsOf: 6000, [field]: 101 }));
      // NaN is null on the wire: saved as "not entered".
      await b.addEmi(emi({ ...input, remainingAsOf: 6000, [field]: Number.NaN }));
      await b.addEmi(emi({ ...input, remainingAsOf: 6000, [field]: "high" as unknown as number }));
      await b.getEmis();
    },
    overwritable: async (b: LedgerBackend) => {
      const added = await b.addEmi(emi({ ...input, remainingAsOf: 6000, [field]: values.first }));
      await b.updateEmi(added.row, emi({ ...input, remainingAsOf: 5000, [field]: values.second }));
      const cleared = await b.updateEmi(added.row, emi({ ...input, remainingAsOf: 4000 }));
      expect(cleared[field]).toBeNull();
    },
    survivesPayment: async (b: LedgerBackend) => {
      const added = await b.addEmi(emi({ ...input, remainingAsOf: 6000, [field]: values.kept }));
      await b.payEmi(added.row, 500);
    },
  };
}

const legacyLoan = { emiAmount: 500, dueDay: 10, totalAmount: 5000, remainingAsOf: 5000, asOfDate: "2026-01-01" };

describe("emi interest rate (optional)", () => {
  const cases = optionalRateCases("interestRate", { stored: 12.5, first: 10, second: 15, kept: 18 });
  parity("defaults to null when not supplied at all", {}, cases.defaultsToNull);
  parity("stores and round-trips an interest rate", {}, cases.roundTrips);
  parity("allows 0% (an interest-free EMI conversion)", {}, cases.allowsZero);
  parity("rejects a negative or out-of-range interest rate", {}, cases.rejectsOutOfRange);
  parity("is a plain overwritable field on edit — updates, clears, and doesn't need to be resupplied to keep other fields", {}, cases.overwritable);
  parity("survives recordEmiPayment unchanged", {}, cases.survivesPayment);
  parity(
    "defaults a legacy entry with no interest-rate column (pre-dating the field) to null rather than rejecting it",
    { emis: [{ cardOrBank: "Legacy Loan", ...legacyLoan }] },
    async (b, { at }) => {
      at("2026-01-01");
      await b.getEmis();
    },
  );
});

describe("emi foreclosure charge (optional)", () => {
  const cases = optionalRateCases("foreclosureCharge", { stored: 2.5, first: 3, second: 4, kept: 5 });
  parity("defaults to null when not supplied at all", {}, cases.defaultsToNull);
  parity("stores and round-trips a foreclosure charge", {}, cases.roundTrips);
  parity("allows 0% (e.g. this CRED/IDFC FIRST loan, which charges no foreclosure fee)", {}, cases.allowsZero);
  parity("rejects a negative or out-of-range foreclosure charge", {}, cases.rejectsOutOfRange);
  parity("is a plain overwritable field on edit — updates, clears, and doesn't need to be resupplied to keep other fields", {}, cases.overwritable);
  parity("survives recordEmiPayment unchanged", {}, cases.survivesPayment);
  parity(
    "defaults a legacy entry with no foreclosure-charge column (pre-dating the field) to null rather than rejecting it",
    { emis: [{ cardOrBank: "Legacy Loan 2", ...legacyLoan, interestRate: 15 }] },
    async (b, { at }) => {
      at("2026-01-01");
      await b.getEmis();
    },
  );
});

describe("emiMonthlyProjection", () => {
  // The store cases compare before/after deltas because earlier blocks'
  // loans are still in their shared table; with each case planting its own
  // state, the raw projections are compared, which covers the deltas.
  const leftovers: SeedEmi[] = [{ cardOrBank: "Earlier Loan", emiAmount: 300, dueDay: 3, totalAmount: 900, remainingAsOf: 900, asOfDate: "2025-12-20" }];

  parity("returns exactly `months` entries, one per calendar month starting this month", { emis: leftovers }, async (b, { at }) => {
    at("2026-01-01");
    const result = await b.getEmiMonthlyProjection(months(5));
    expect(result.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]);
  });

  parity(
    "buckets a fresh loan's full-size installments by their real due month, including a smaller final one",
    { emis: leftovers },
    async (b, { at }) => {
      at("2026-01-01");
      await b.getEmiMonthlyProjection(months(4));
      await b.addEmi(emi({ cardOrBank: "Proj Fresh", emiAmount: 1000, dueDay: 15, totalAmount: 2500, remarks: "", remainingAsOf: 2500 }));
      await b.getEmiMonthlyProjection(months(4));
    },
  );

  parity("sums multiple active EMIs due in the same month", { emis: leftovers }, async (b, { at }) => {
    at("2026-01-01");
    await b.getEmiMonthlyProjection(months(1));
    await b.addEmi(emi({ cardOrBank: "Proj A", emiAmount: 500, dueDay: 10, totalAmount: 500, remarks: "", remainingAsOf: 500 }));
    await b.addEmi(emi({ cardOrBank: "Proj B", emiAmount: 700, dueDay: 20, totalAmount: 700, remarks: "", remainingAsOf: 700 }));
    await b.getEmiMonthlyProjection(months(1));
  });

  parity("excludes an already-paid-off EMI entirely", { emis: leftovers }, async (b, { at }) => {
    at("2026-01-01");
    await b.getEmiMonthlyProjection(months(2));
    const added = await b.addEmi(emi({ cardOrBank: "Proj PaidOff", emiAmount: 500, dueDay: 5, totalAmount: 500, remarks: "", remainingAsOf: 500 }));
    await b.payEmi(added.row, 500);
    await b.getEmiMonthlyProjection(months(2));
  });

  parity("doesn't include a due date that falls outside the requested window", { emis: leftovers }, async (b, { at }) => {
    at("2026-01-26");
    await b.getEmiMonthlyProjection(months(1));
    await b.addEmi(emi({ cardOrBank: "Proj OutOfWindow", emiAmount: 400, dueDay: 25, totalAmount: 400, remarks: "", remainingAsOf: 400 }));
    await b.getEmiMonthlyProjection(months(1));
  });

  parity("doesn't crash when an EMI's asOfDate is stale (no payment recorded in a while)", { emis: leftovers }, async (b, { at }) => {
    at("2026-06-15");
    await b.getEmiMonthlyProjection(months(3));
    at("2026-01-01");
    await b.addEmi(emi({ cardOrBank: "Proj Stale", emiAmount: 500, dueDay: 10, totalAmount: 5000, remarks: "", remainingAsOf: 5000 }));
    at("2026-06-15");
    await b.getEmiMonthlyProjection(months(3));
  });
});

describe("emi foreclosurePayoff", () => {
  parity("matches a hand-computed present-value example (12% p.a., 5 installments left)", {}, async (b) => {
    const added = await b.addEmi(
      emi({ cardOrBank: "PV Test", emiAmount: 1000, dueDay: 10, totalAmount: 10000, remarks: "", remainingAsOf: 5000, interestRate: 12 }),
    );
    expect(added.remaining).toBe(5000);
    expect(added.foreclosurePayoff).toBeCloseTo(4853.43, 1);
  });

  parity("equals remaining exactly when no interestRate is on record (graceful r→0 degradation)", {}, async (b) => {
    const added = await b.addEmi(emi({ cardOrBank: "No Rate Test", emiAmount: 500, dueDay: 10, totalAmount: 5000, remarks: "", remainingAsOf: 3500 }));
    expect(added.foreclosurePayoff).toBe(added.remaining);
  });

  parity("equals remaining exactly when interestRate is explicitly 0", {}, async (b) => {
    await b.addEmi(emi({ cardOrBank: "Zero Rate Test", emiAmount: 500, dueDay: 10, totalAmount: 5000, remarks: "", remainingAsOf: 3500, interestRate: 0 }));
  });

  parity("applies foreclosureCharge as a percentage on top of the outstanding principal", {}, async (b) => {
    const added = await b.addEmi(
      emi({ cardOrBank: "Charge Payoff Test", emiAmount: 500, dueDay: 10, totalAmount: 5000, remarks: "", remainingAsOf: 1000, foreclosureCharge: 5 }),
    );
    expect(added.foreclosurePayoff).toBe(1050);
  });

  parity("is 0 for a fully paid-off loan, never negative or NaN", {}, async (b) => {
    await b.addEmi(
      emi({
        cardOrBank: "Paid Off Test",
        emiAmount: 500,
        dueDay: 10,
        totalAmount: 5000,
        remarks: "",
        remainingAsOf: 0,
        interestRate: 15,
        foreclosureCharge: 3,
      }),
    );
  });
});

describe("emiMonthlyProjection auto mode (until paid off)", () => {
  // The store case anchors 10 years past the real date; the pinned clock
  // makes that a fixed day here.
  const FAR_FUTURE = "2036-01-01";

  parity("extends past the default 12-month window until the loan actually reaches zero", {}, async (b, { at }) => {
    at(FAR_FUTURE);
    const added = await b.addEmi(emi({ cardOrBank: "Auto Long", emiAmount: 1000, dueDay: 15, totalAmount: 18000, remarks: "", remainingAsOf: 18000 }));
    const result = await b.getEmiMonthlyProjection("auto");
    expect(result.at(-1)).toEqual({ month: "2037-06", count: 1, totalAmount: 1000 });
    await b.deleteEmi(added.row);
  });

  parity(
    "trims to a single (zeroed) month when there are no active EMIs at all",
    { emis: [{ cardOrBank: "Old", emiAmount: 1000, dueDay: 5, totalAmount: 3000, remainingAsOf: 3000, asOfDate: "2026-01-01" }] },
    async (b, { at }) => {
      at(FAR_FUTURE);
      expect(await b.getEmiMonthlyProjection("auto")).toEqual([{ month: "2036-01", count: 0, totalAmount: 0 }]);
    },
  );

  parity("extends to the later of two loans' payoff dates, not the sooner one", {}, async (b, { at }) => {
    at(FAR_FUTURE);
    const shorter = await b.addEmi(emi({ cardOrBank: "Auto Shorter", emiAmount: 1000, dueDay: 5, totalAmount: 2000, remarks: "", remainingAsOf: 2000 }));
    const longer = await b.addEmi(emi({ cardOrBank: "Auto Longer", emiAmount: 500, dueDay: 20, totalAmount: 5000, remarks: "", remainingAsOf: 5000 }));
    await b.getEmiMonthlyProjection("auto");
    await b.deleteEmi(longer.row);
    await b.deleteEmi(shorter.row);
  });

  parity("caps at the 600-month ceiling rather than simulating forever for an implausibly slow loan", {}, async (b, { at }) => {
    at(FAR_FUTURE);
    const added = await b.addEmi(emi({ cardOrBank: "Auto Slow", emiAmount: 1, dueDay: 15, totalAmount: 10000, remarks: "", remainingAsOf: 10000 }));
    expect((await b.getEmiMonthlyProjection("auto")).length).toBe(600);
    await b.deleteEmi(added.row);
  });
});

describe("document parity: emi", () => {
  parity("an EMI interest rate of 12.0005 gives 12.001", {}, async (b) => {
    const added = await b.addEmi(emi({ ...baseInput, interestRate: 12.0005, foreclosureCharge: 99.9995 }));
    expect(added.interestRate).toBe(12.001);
    expect(added.foreclosureCharge).toBe(100);
    await b.addEmi(emi({ ...baseInput, interestRate: 0.0004, foreclosureCharge: 100.0001 }));
    await b.addEmi(emi({ ...baseInput, emiAmount: 1.005, totalAmount: 2.675, remainingAsOf: 0.005 }));
    await b.getEmis();
  });

  parity("checks fields in the store's order, before the row", { emis: [coral] }, async (b, { ids }) => {
    await b.updateEmi(MISSING_ID, emi({ ...baseInput, cardOrBank: "" }));
    await b.updateEmi(MISSING_ID, emi({ ...baseInput, emiAmount: 0, dueDay: 99 }));
    await b.updateEmi(MISSING_ID, emi({ ...baseInput, dueDay: 99, totalAmount: -1 }));
    await b.updateEmi(MISSING_ID, emi({ ...baseInput, totalAmount: Number.NaN, remainingAsOf: -1 }));
    await b.updateEmi(MISSING_ID, emi({ ...baseInput, totalAmount: "x" as unknown as number, remainingAsOf: -1 }));
    await b.updateEmi(MISSING_ID, emi({ ...baseInput, remainingAsOf: "x" as unknown as number, cardOrBank: "a\u0000" }));
    await b.updateEmi(MISSING_ID, emi({ ...baseInput, cardOrBank: "a\u0000", emiAmount: 0.001 }));
    await b.updateEmi(MISSING_ID, emi({ ...baseInput, emiAmount: 0.001, durationMonths: 0 }));
    await b.updateEmi(MISSING_ID, emi({ ...baseInput, durationMonths: 0, interestRate: -1 }));
    await b.updateEmi(MISSING_ID, emi({ ...baseInput, interestRate: -1, foreclosureCharge: -1 }));
    await b.updateEmi(MISSING_ID, emi({ ...baseInput, foreclosureCharge: -1 }));
    await b.updateEmi(MISSING_ID, emi(baseInput));
    await b.payEmi(MISSING_ID, -1);
    await b.payEmi(ids.emi(0), Number.NaN);
    await b.getEmis();
  });

  parity("coerces the body as routes.ts does", {}, async (b, { at }) => {
    at("2026-02-03");
    await b.addEmi({ cardOrBank: "  Card A  ", emiAmount: "250", dueDay: "5", totalAmount: "3000", remarks: 12, remainingAsOf: "2000", interestRate: "", foreclosureCharge: "2" } as unknown as EmiEdits);
    await b.addEmi(emi({ ...baseInput, remarks: undefined, durationMonths: undefined }));
    await b.getEmis();
  });

  parity("clamps the projection's month count as routes.ts does", { emis: [coral] }, async (b, { at }) => {
    at("2026-01-01");
    // 1e21 stringifies as "1e+21"; the query parser reads its "+" as a space.
    for (const count of [0, -5, 1000, 2.5, Number.NaN, 1e21]) await b.getEmiMonthlyProjection(months(count));
    await b.getEmiMonthlyProjection("abc" as unknown as EmiProjectionScale);
    await b.getEmiMonthlyProjection(12);
  });

  parity("an update that changes nothing still re-dates the snapshot to today", { emis: [coral] }, async (b, { at, ids }) => {
    at("2026-03-03");
    await b.updateEmi(ids.emi(0), emi(baseInput));
    at("2026-03-03");
    await b.updateEmi(ids.emi(0), emi(baseInput));
    await b.getEmis();
  });
});
