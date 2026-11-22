import { describe, expect, it } from "vitest";
import { knownMonths, trailingAverages } from "./movingAverage";
import { EARLIEST_YEAR } from "./constants";

const twelve = (fill: (i: number) => number) => Array.from({ length: 12 }, (_, i) => fill(i));

describe("knownMonths", () => {
  const today = new Date(2026, 3, 15); // Apr 15, 2026

  it("keeps months up to and including the current one, nulls the rest of this year", () => {
    const result = knownMonths(2026, twelve((i) => (i + 1) * 100), today);
    expect(result.slice(0, 4)).toEqual([100, 200, 300, 400]);
    expect(result.slice(4)).toEqual(Array(8).fill(null));
  });

  it("keeps every month of a past year, zeros included", () => {
    const totals = twelve((i) => (i === 5 ? 0 : 50));
    expect(knownMonths(2025, totals, today)).toEqual(totals);
  });

  it("nulls a future year entirely", () => {
    expect(knownMonths(2027, twelve(() => 10), today)).toEqual(Array(12).fill(null));
  });

  it("treats a year with nothing recorded as no data, not twelve zeros", () => {
    expect(knownMonths(2025, twelve(() => 0), today)).toEqual(Array(12).fill(null));
  });

  it("nulls a year before any data was recorded", () => {
    expect(knownMonths(EARLIEST_YEAR - 1, twelve(() => 10), today)).toEqual(Array(12).fill(null));
  });
});

describe("trailingAverages", () => {
  it("averages each month with the window-1 months before it", () => {
    const year = [30, 60, 90, 120, ...Array(8).fill(null)];
    const result = trailingAverages(Array(12).fill(null), year, 3);
    expect(result.slice(0, 4)).toEqual([null, null, 60, 90]); // no full window until March
    expect(result.slice(4)).toEqual(Array(8).fill(null)); // never runs into months without data
  });

  it("reaches back into the previous year when the window starts before January", () => {
    const previous = twelve((i) => (i >= 10 ? 300 : 0)); // Nov, Dec = 300
    const year = [600, ...Array(11).fill(null)];
    expect(trailingAverages(previous, year, 3)[0]).toBe(400); // (300 + 300 + 600) / 3
  });

  it("rounds to paise", () => {
    const year = [10, 10, 11, ...Array(9).fill(null)];
    expect(trailingAverages(Array(12).fill(null), year, 3)[2]).toBe(10.33);
  });
});
