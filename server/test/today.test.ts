import { describe, it, expect } from "vitest";
import { todayInAppZone } from "../src/domain/today.js";
import { formatDate } from "../src/domain/dateMath.js";

describe("todayInAppZone", () => {
  it("rolls over to the next day at local midnight in the app zone, while UTC is still on the previous day", () => {
    // 00:30 IST on Oct 5 is still 19:00 UTC on Oct 4 — the exact window
    // (00:00-05:30 IST) where a UTC serverless runtime would be a day behind.
    const now = new Date(Date.UTC(2026, 9, 4, 19, 0));
    expect(formatDate(todayInAppZone(now, "Asia/Kolkata"))).toBe("2026-10-05");
    expect(formatDate(todayInAppZone(now, "UTC"))).toBe("2026-10-04");
  });

  it("stays on the current day just before local midnight", () => {
    const now = new Date(Date.UTC(2026, 9, 4, 18, 29)); // 23:59 IST Oct 4
    expect(formatDate(todayInAppZone(now, "Asia/Kolkata"))).toBe("2026-10-04");
  });

  it("returns a local-midnight Date, matching dateMath's calendar-day convention", () => {
    const today = todayInAppZone(new Date(Date.UTC(2026, 0, 31, 12)), "Asia/Kolkata");
    expect([today.getHours(), today.getMinutes(), today.getSeconds()]).toEqual([0, 0, 0]);
    expect(formatDate(today)).toBe("2026-01-31");
  });

  it("defaults to APP_TIMEZONE, falling back to Asia/Kolkata", () => {
    const previous = process.env.APP_TIMEZONE;
    try {
      const now = new Date(Date.UTC(2026, 9, 4, 19, 0));
      delete process.env.APP_TIMEZONE;
      expect(formatDate(todayInAppZone(now))).toBe("2026-10-05");
      process.env.APP_TIMEZONE = "UTC";
      expect(formatDate(todayInAppZone(now))).toBe("2026-10-04");
    } finally {
      if (previous === undefined) delete process.env.APP_TIMEZONE;
      else process.env.APP_TIMEZONE = previous;
    }
  });
});
