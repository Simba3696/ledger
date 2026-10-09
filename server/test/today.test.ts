import { describe, it, expect } from "vitest";
import { todayInAppZone } from "@ledger/shared/today";
import { formatDate } from "@ledger/shared/dateMath";
import { appToday } from "../src/today.js";

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

  it("is still the previous calendar day in a zone behind UTC", () => {
    // 06:30 UTC on Oct 5 is 23:30 PDT on Oct 4.
    const now = new Date(Date.UTC(2026, 9, 5, 6, 30));
    expect(formatDate(todayInAppZone(now, "America/Los_Angeles"))).toBe("2026-10-04");
    expect(formatDate(todayInAppZone(now, "UTC"))).toBe("2026-10-05");
  });

  it("rolls over at local midnight in a non-hour offset zone, not at UTC or +05:30", () => {
    // Asia/Kathmandu is +05:45: its midnight on Oct 5 is 18:15 UTC on Oct 4,
    // a quarter of an hour before Asia/Kolkata's (+05:30) at 18:30 UTC.
    expect(formatDate(todayInAppZone(new Date(Date.UTC(2026, 9, 4, 18, 14)), "Asia/Kathmandu"))).toBe("2026-10-04");
    const justAfter = new Date(Date.UTC(2026, 9, 4, 18, 16));
    expect(formatDate(todayInAppZone(justAfter, "Asia/Kathmandu"))).toBe("2026-10-05");
    expect(formatDate(todayInAppZone(justAfter, "Asia/Kolkata"))).toBe("2026-10-04");
    expect(formatDate(todayInAppZone(justAfter, "UTC"))).toBe("2026-10-04");
  });

  it("returns local midnight of the right calendar day across a DST change", () => {
    // America/New_York springs forward on 2026-03-08 at 02:00 EST (-05:00) to
    // 03:00 EDT (-04:00), so that day starts at 05:00 UTC and the next at 04:00 UTC.
    const zone = "America/New_York";
    expect(formatDate(todayInAppZone(new Date(Date.UTC(2026, 2, 8, 4, 59)), zone))).toBe("2026-03-07");
    const afterChange = todayInAppZone(new Date(Date.UTC(2026, 2, 8, 7, 30)), zone); // 03:30 EDT
    expect(formatDate(afterChange)).toBe("2026-03-08");
    expect([afterChange.getHours(), afterChange.getMinutes(), afterChange.getSeconds()]).toEqual([0, 0, 0]);
    expect(formatDate(todayInAppZone(new Date(Date.UTC(2026, 2, 9, 3, 59)), zone))).toBe("2026-03-08");
    expect(formatDate(todayInAppZone(new Date(Date.UTC(2026, 2, 9, 4, 0)), zone))).toBe("2026-03-09");
  });
});

describe("appToday", () => {
  it("defaults to APP_TIMEZONE, falling back to Asia/Kolkata", () => {
    const previous = process.env.APP_TIMEZONE;
    try {
      const now = new Date(Date.UTC(2026, 9, 4, 19, 0));
      delete process.env.APP_TIMEZONE;
      expect(formatDate(appToday(now))).toBe("2026-10-05");
      process.env.APP_TIMEZONE = "UTC";
      expect(formatDate(appToday(now))).toBe("2026-10-04");
    } finally {
      if (previous === undefined) delete process.env.APP_TIMEZONE;
      else process.env.APP_TIMEZONE = previous;
    }
  });
});
