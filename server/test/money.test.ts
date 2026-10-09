import { describe, it, expect } from "vitest";
import { sumToNumber, toDecimalString } from "@ledger/shared/money";

// The decimal-string money helper behind GitHub storage mode's documents
// (shared/src/money.ts). Each expectation is what Postgres stores for the
// same `String(value)` in a numeric(14,2) or numeric(6,3) column; the
// backend parity suite (test/parity/) checks the two side by side.

describe("toDecimalString", () => {
  it("rounds a half away from zero on the decimal digits, not the binary double", () => {
    // 1.005 is stored as 1.00499999999999989... in binary; Postgres rounds
    // the "1.005" postgres.js sends, so it gets 1.01, as here.
    expect(toDecimalString(1.005, 2)).toBe("1.01");
    expect(toDecimalString(2.675, 2)).toBe("2.68");
    expect(toDecimalString(1.004, 2)).toBe("1.00");
    expect(toDecimalString(10.006, 2)).toBe("10.01");
    expect(toDecimalString(999999999999.99, 2)).toBe("999999999999.99");
  });

  it("rounds a negative half away from zero too", () => {
    expect(toDecimalString(-1.005, 2)).toBe("-1.01");
    expect(toDecimalString(-2500.25, 2)).toBe("-2500.25");
    expect(toDecimalString(-0.5, 2)).toBe("-0.50");
  });

  it("keeps three places for the rate columns", () => {
    expect(toDecimalString(12.0005, 3)).toBe("12.001");
    expect(toDecimalString(12.5, 3)).toBe("12.500");
    expect(toDecimalString(100, 3)).toBe("100.000");
    expect(toDecimalString(0, 3)).toBe("0.000");
  });

  it("expands exponent forms", () => {
    expect(String(1e-7)).toBe("1e-7");
    expect(toDecimalString(1e-7, 2)).toBe("0.00");
    expect(toDecimalString(0.0051, 2)).toBe("0.01");
    expect(toDecimalString(1e21, 2)).toBe("1000000000000000000000.00");
    expect(toDecimalString(1.5e21, 3)).toBe("1500000000000000000000.000");
    expect(() => toDecimalString(Number.NaN, 2)).toThrow(RangeError);
  });

  it("never returns a negative zero, and sums exactly in cents", () => {
    expect(toDecimalString(-0.001, 2)).toBe("0.00");
    expect(toDecimalString(-1e-7, 3)).toBe("0.000");
    expect(toDecimalString(-0, 2)).toBe("0.00");
    expect(sumToNumber(["0.10", "0.20"])).toBe(0.3);
    expect(sumToNumber(["-0.10", "0.10"])).toBe(0);
    expect(Object.is(sumToNumber(["-0.10", "0.10"]), -0)).toBe(false);
    expect(sumToNumber(["-1.01", "-2.02"])).toBe(-3.03);
    expect(sumToNumber([])).toBe(0);
  });
});
