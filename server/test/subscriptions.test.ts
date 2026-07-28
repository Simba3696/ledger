import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Same pattern as debts.test.ts / emi.test.ts: LEDGER_DB_DIR must be set
// before subscriptions.ts's top-level DB_DIR evaluates, so it's imported
// dynamically after the env var is set rather than via a static top-level
// import.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-subscriptions-test-"));
process.env.LEDGER_DB_DIR = scratchDir;

const subscriptions = await import("../src/excel/subscriptions.js");

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe("subscriptions", () => {
  it("starts empty when no workbook exists yet", async () => {
    expect(await subscriptions.listSubscriptions()).toEqual([]);
  });

  it("leaves a future expiry untouched", async () => {
    const added = await subscriptions.addSubscription(
      { service: "Netflix", amount: 649, duration: "Monthly", expiryAnchor: "2026-08-25", cardOrBank: "IV" },
      new Date(2026, 6, 28), // Jul 28, 2026 — before the anchor
    );
    expect(added).toMatchObject({ row: 2, expiryAnchor: "2026-08-25", nextExpiry: "2026-08-25" });
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
      2,
      { service: "Netflix", amount: 699, duration: "Monthly", expiryAnchor: "2026-12-25", cardOrBank: "IV" },
      new Date(2026, 6, 28),
    );
    expect(updated).toMatchObject({ amount: 699, expiryAnchor: "2026-12-25", nextExpiry: "2026-12-25" });
  });

  it("deletes a subscription, e.g. after cancelling it", async () => {
    const before = await subscriptions.listSubscriptions();
    await subscriptions.deleteSubscription(2); // remove Netflix
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

  it("404s updating or deleting a row that isn't a real entry", async () => {
    const input = { service: "X", amount: 100, duration: "Monthly" as const, expiryAnchor: "2026-08-01", cardOrBank: "" };
    await expect(subscriptions.updateSubscription(99, input)).rejects.toMatchObject({ status: 404 });
    await expect(subscriptions.deleteSubscription(99)).rejects.toMatchObject({ status: 404 });
    await expect(subscriptions.updateSubscription(1, input)).rejects.toMatchObject({ status: 404 });
  });
});
