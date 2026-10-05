import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { sql, resetTables, closeSql } from "./dbHelpers.js";
import { assertMoney, assertText, isPossibleId, isRealDate } from "../src/store/validate.js";
import { mapDatabaseError } from "../src/dbErrors.js";
import { LedgerError } from "../src/errors.js";

afterAll(async () => {
  await closeSql();
});

function statusOf(fn: () => void): number | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof LedgerError ? err.status : -1;
  }
}

describe("store validation helpers", () => {
  it("rejects text containing a NUL character, naming the field", () => {
    expect(() => assertText("a\u0000b", "Name")).toThrow("Name contains an invalid character");
    expect(statusOf(() => assertText("plain text", "Name"))).toBeNull();
  });

  it("checks money on the rounded cents, matching numeric(14,2)", () => {
    expect(statusOf(() => assertMoney(999999999999.99, { positive: true }))).toBeNull();
    expect(() => assertMoney(999999999999.995, { positive: true })).toThrow("Amount is too large");
    expect(() => assertMoney(-999999999999.995, { positive: false })).toThrow("Amount is too large");
    expect(() => assertMoney(0.001, { positive: true })).toThrow("Amount must be a positive number");
    expect(() => assertMoney(-5, { positive: true })).toThrow("Amount must be a positive number");
    expect(statusOf(() => assertMoney(-5, { positive: false }))).toBeNull();
    expect(() => assertMoney(Number.NaN, { positive: false })).toThrow("Amount must be a number");
  });

  it("accepts only real YYYY-MM-DD calendar dates", () => {
    expect(isRealDate("2028-02-29")).toBe(true);
    expect(isRealDate("2026-02-29")).toBe(false);
    expect(isRealDate("2026-02-30")).toBe(false);
    expect(isRealDate("2026-13-01")).toBe(false);
    expect(isRealDate("2026-1-01")).toBe(false);
  });

  it("treats only positive safe integers as possible ids", () => {
    expect([1, 42].every(isPossibleId)).toBe(true);
    expect([0, -1, 1.5, Number.NaN, 2 ** 60].some(isPossibleId)).toBe(false);
  });
});

describe("mapDatabaseError: real Postgres refusals become client errors (LLD §11)", () => {
  beforeEach(async () => {
    await resetTables("debts", "subscriptions");
  });

  async function caught(query: Promise<unknown>): Promise<unknown> {
    try {
      await query;
    } catch (err) {
      return err;
    }
    throw new Error("expected the query to fail");
  }

  it("maps a NUL character to 400", async () => {
    const err = await caught(sql`insert into debts (name, amount) values (${"a\u0000b"}, 1)`);
    expect(mapDatabaseError(err)).toEqual({ status: 400, message: "Input contains an invalid character" });
  });

  it("maps a numeric overflow to 400", async () => {
    const err = await caught(sql`insert into debts (name, amount) values ('a', 1e13)`);
    expect(mapDatabaseError(err)?.status).toBe(400);
  });

  it("maps an impossible date to 400", async () => {
    const err = await caught(
      sql`insert into subscriptions (service, amount, duration, expiry_anchor) values ('x', 1, 'Monthly', ${"2026-02-30"})`,
    );
    expect(mapDatabaseError(err)?.status).toBe(400);
  });

  it("maps a check-constraint violation to 400", async () => {
    const err = await caught(
      sql`insert into subscriptions (service, amount, duration, expiry_anchor) values ('x', 1, 'Weekly', '2026-01-01')`,
    );
    expect(mapDatabaseError(err)).toEqual({ status: 400, message: "Invalid value" });
  });

  it("leaves non-database errors unmapped", () => {
    expect(mapDatabaseError(new Error("boom"))).toBeNull();
    expect(mapDatabaseError(null)).toBeNull();
  });
});
