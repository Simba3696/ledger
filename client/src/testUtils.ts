import type { EmiEntryComputed } from "./api";

/** An active EMI with plain round numbers; override what a test cares about. */
export function makeEmi(overrides: Partial<EmiEntryComputed> = {}): EmiEntryComputed {
  return {
    row: 2,
    cardOrBank: "Coral",
    emiAmount: 1000,
    dueDay: 8,
    totalAmount: 12000,
    remarks: "Phone",
    remainingAsOf: 6000,
    asOfDate: "2026-11-02",
    untilTarget: null,
    interestRate: null,
    foreclosureCharge: null,
    remaining: 6000,
    isPaidOff: false,
    estimatedPayoffMonth: "2027-05",
    estimatedPayoffDate: "2027-05-08",
    foreclosurePayoff: 6000,
    ...overrides,
  };
}
