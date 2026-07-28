import { describe, it, expect } from "vitest";
import { addMonths, addYears, clampDay, formatDate, parseDate } from "../src/excel/dateMath.js";

describe("dateMath", () => {
  it("clamps a day-of-month to the real last day of shorter months", () => {
    expect(clampDay(2026, 2, 31)).toBe(28); // 2026 is not a leap year
    expect(clampDay(2028, 2, 31)).toBe(29); // 2028 is a leap year
    expect(clampDay(2026, 1, 31)).toBe(31);
  });

  it("addMonths rolls over year boundaries and clamps the day", () => {
    expect(formatDate(addMonths(parseDate("2026-11-30"), 3))).toBe("2027-02-28");
    expect(formatDate(addMonths(parseDate("2026-01-15"), 1))).toBe("2026-02-15");
    expect(formatDate(addMonths(parseDate("2026-01-15"), 12))).toBe("2027-01-15");
  });

  it("addYears clamps Feb 29 to Feb 28 in a non-leap target year", () => {
    expect(formatDate(addYears(parseDate("2028-02-29"), 1))).toBe("2029-02-28");
  });

  it("parseDate/formatDate round-trip without timezone drift", () => {
    expect(formatDate(parseDate("2026-07-28"))).toBe("2026-07-28");
  });
});
