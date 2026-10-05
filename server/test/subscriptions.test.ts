import { describe, it, expect, afterAll, beforeAll } from "vitest";
// dbHelpers must be imported before any store module (it sets DATABASE_URL
// and refuses non-local hosts).
import { resetTables, closeSql } from "./dbHelpers.js";
import * as subscriptions from "../src/store/subscriptions.js";

// The cases below build on each other in order (add -> list -> update ->
// delete), the same way the Excel edition's shared scratch workbook did, so
// the table is wiped once up front rather than before every case.
beforeAll(async () => {
  await resetTables("subscriptions");
});

afterAll(async () => {
  await closeSql();
});

// Database id captured from the first add call; it stands in for the sheet
// row number (2) the Excel edition returned for Netflix.
let netflixRow = 0;

describe("subscriptions", () => {
  it("starts empty when no workbook exists yet", async () => {
    expect(await subscriptions.listSubscriptions()).toEqual([]);
  });

  it("leaves a future expiry untouched", async () => {
    const added = await subscriptions.addSubscription(
      { service: "Netflix", amount: 649, duration: "Monthly", expiryAnchor: "2026-08-25", cardOrBank: "IV" },
      new Date(2026, 6, 28), // Jul 28, 2026 — before the anchor
    );
    netflixRow = added.row;
    // resetTables restarts the identity, so the first add is id 1.
    expect(added).toMatchObject({ row: 1, expiryAnchor: "2026-08-25", nextExpiry: "2026-08-25" });
  });

  it("auto-advances a Monthly expiry that's already in the past, one cycle at a time", async () => {
    // Anchor is 2026-08-25; "today" is three months later, so it should land
    // on 2026-11-25 (Aug -> Sep -> Oct -> Nov), not skip past it.
    const list = await subscriptions.listSubscriptions(new Date(2026, 10, 20)); // Nov 20, 2026
    expect(list).toEqual([expect.objectContaining({ expiryAnchor: "2026-08-25", nextExpiry: "2026-11-25" })]);
  });

  it("auto-advances a Yearly expiry by whole years", async () => {
    await subscriptions.addSubscription(
      { service: "Microsoft Office", amount: 4899, duration: "Yearly", expiryAnchor: "2024-05-20", cardOrBank: "IV" },
      new Date(2024, 4, 20),
    );
    const list = await subscriptions.listSubscriptions(new Date(2026, 6, 28)); // Jul 28, 2026
    expect(list).toEqual(
      expect.arrayContaining([expect.objectContaining({ service: "Microsoft Office", nextExpiry: "2027-05-20" })]),
    );
  });

  it("updating an entry recomputes nextExpiry from the new anchor", async () => {
    const updated = await subscriptions.updateSubscription(
      netflixRow,
      { service: "Netflix", amount: 699, duration: "Monthly", expiryAnchor: "2026-12-25", cardOrBank: "IV" },
      new Date(2026, 6, 28),
    );
    expect(updated).toMatchObject({ amount: 699, expiryAnchor: "2026-12-25", nextExpiry: "2026-12-25" });
  });

  it("deletes a subscription, e.g. after cancelling it", async () => {
    const before = await subscriptions.listSubscriptions();
    await subscriptions.deleteSubscription(netflixRow); // remove Netflix
    const after = await subscriptions.listSubscriptions();
    expect(after).toHaveLength(before.length - 1);
    expect(after.some((s) => s.service === "Netflix")).toBe(false);
  });

  it("rejects a blank service name", async () => {
    await expect(
      subscriptions.addSubscription({ service: "  ", amount: 100, duration: "Monthly", expiryAnchor: "2026-08-01", cardOrBank: "" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a non-positive amount", async () => {
    await expect(
      subscriptions.addSubscription({ service: "X", amount: 0, duration: "Monthly", expiryAnchor: "2026-08-01", cardOrBank: "" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a duration that is not "Monthly" or "Yearly"', async () => {
    await expect(
      subscriptions.addSubscription({
        service: "X",
        amount: 100,
        duration: "Weekly" as never,
        expiryAnchor: "2026-08-01",
        cardOrBank: "",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a malformed expiry date", async () => {
    await expect(
      subscriptions.addSubscription({ service: "X", amount: 100, duration: "Monthly", expiryAnchor: "not-a-date", cardOrBank: "" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects values the database columns can't hold with a 400, not a database error", async () => {
    const base = { service: "X", duration: "Monthly" as const, cardOrBank: "" };
    // numeric(14,2): too many integer digits, or a positive amount that rounds to 0.00.
    await expect(subscriptions.addSubscription({ ...base, amount: 1e12, expiryAnchor: "2026-08-01" })).rejects.toMatchObject({ status: 400 });
    // Under 1e12, but the column rounds it up to 1000000000000.00.
    await expect(subscriptions.addSubscription({ ...base, amount: 999999999999.995, expiryAnchor: "2026-08-01" })).rejects.toMatchObject({ status: 400 });
    await expect(subscriptions.addSubscription({ ...base, amount: 0.001, expiryAnchor: "2026-08-01" })).rejects.toMatchObject({ status: 400 });
    // date: well-formed but impossible calendar days.
    await expect(subscriptions.addSubscription({ ...base, amount: 100, expiryAnchor: "2026-02-30" })).rejects.toMatchObject({ status: 400 });
    await expect(subscriptions.addSubscription({ ...base, amount: 100, expiryAnchor: "2026-13-01" })).rejects.toMatchObject({ status: 400 });
    // text: a NUL character in service or card/bank.
    await expect(subscriptions.addSubscription({ ...base, service: "X\u0000Y", amount: 100, expiryAnchor: "2026-08-01" })).rejects.toMatchObject({ status: 400 });
    await expect(subscriptions.addSubscription({ ...base, cardOrBank: "I\u0000V", amount: 100, expiryAnchor: "2026-08-01" })).rejects.toMatchObject({ status: 400 });
    // The largest amount that fits still round-trips exactly.
    const big = await subscriptions.addSubscription({ ...base, amount: 999999999999.99, expiryAnchor: "2028-02-29" });
    expect(big).toMatchObject({ amount: 999999999999.99, expiryAnchor: "2028-02-29" });
    await subscriptions.deleteSubscription(big.row);
  });

  it("404s updating or deleting a row that isn't a real entry", async () => {
    const input = { service: "X", amount: 100, duration: "Monthly" as const, expiryAnchor: "2026-08-01", cardOrBank: "" };
    await expect(subscriptions.updateSubscription(99, input)).rejects.toMatchObject({ status: 404 });
    await expect(subscriptions.deleteSubscription(99)).rejects.toMatchObject({ status: 404 });
    // Was row 1 (the sheet's header row); the nearest Postgres equivalent is
    // an id that existed but was deleted above.
    await expect(subscriptions.updateSubscription(netflixRow, input)).rejects.toMatchObject({ status: 404 });
    // Ids that can never be valid (the header row / a non-numeric :row in the
    // Excel edition) 404 too, rather than reaching Postgres.
    await expect(subscriptions.updateSubscription(0, input)).rejects.toMatchObject({ status: 404 });
    await expect(subscriptions.updateSubscription(-1, input)).rejects.toMatchObject({ status: 404 });
    await expect(subscriptions.deleteSubscription(NaN)).rejects.toMatchObject({ status: 404 });
    await expect(subscriptions.deleteSubscription(1.5)).rejects.toMatchObject({ status: 404 });
  });
});
