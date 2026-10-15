import { describe, expect } from "vitest";
import type { SubscriptionEdits } from "../../../client/src/api";
import { MISSING_ID, parity } from "./harness";
import type { SeedSubscription } from "./seed";

// server/test/subscriptions.test.ts against both backends, "today" moved
// with at() where the store cases pass one.

const netflix: SeedSubscription = { service: "Netflix", amount: 649, duration: "Monthly", expiryAnchor: "2026-08-25", cardOrBank: "IV" };
const office: SeedSubscription = { service: "Microsoft Office", amount: 4899, duration: "Yearly", expiryAnchor: "2024-05-20", cardOrBank: "IV" };
const x = (fields: Partial<SubscriptionEdits>): SubscriptionEdits => ({
  service: "X",
  amount: 100,
  duration: "Monthly",
  expiryAnchor: "2026-08-01",
  cardOrBank: "",
  ...fields,
});

describe("subscriptions", () => {
  parity("starts empty when no workbook exists yet", {}, async (b) => {
    await b.getSubscriptions();
  });

  parity("leaves a future expiry untouched", {}, async (b, { at }) => {
    at("2026-07-28");
    const added = await b.addSubscription(netflix as SubscriptionEdits);
    expect(added).toMatchObject({ expiryAnchor: "2026-08-25", nextExpiry: "2026-08-25" });
  });

  parity("auto-advances a Monthly expiry that's already in the past, one cycle at a time", { subscriptions: [netflix] }, async (b, { at }) => {
    at("2026-11-20");
    await b.getSubscriptions();
  });

  parity("auto-advances a Yearly expiry by whole years", { subscriptions: [netflix] }, async (b, { at }) => {
    at("2024-05-20");
    await b.addSubscription(office as SubscriptionEdits);
    at("2026-07-28");
    await b.getSubscriptions();
  });

  parity("updating an entry recomputes nextExpiry from the new anchor", { subscriptions: [netflix, office] }, async (b, { at, ids }) => {
    at("2026-07-28");
    await b.updateSubscription(ids.subscription(0), { ...(netflix as SubscriptionEdits), amount: 699, expiryAnchor: "2026-12-25" });
  });

  parity("deletes a subscription, e.g. after cancelling it", { subscriptions: [netflix, office] }, async (b, { ids }) => {
    await b.getSubscriptions();
    await b.deleteSubscription(ids.subscription(0));
    await b.getSubscriptions();
  });

  parity("rejects a blank service name", {}, async (b) => {
    await b.addSubscription(x({ service: "  " }));
  });

  parity("rejects a non-positive amount", {}, async (b) => {
    await b.addSubscription(x({ amount: 0 }));
    await b.addSubscription(x({ amount: -1 }));
  });

  parity('rejects a duration that is not "Monthly" or "Yearly"', {}, async (b) => {
    await b.addSubscription(x({ duration: "Weekly" as never }));
    await b.addSubscription(x({ duration: "monthly" as never }));
    await b.addSubscription(x({ duration: undefined }));
  });

  parity("rejects a malformed expiry date", {}, async (b) => {
    await b.addSubscription(x({ expiryAnchor: "not-a-date" }));
    await b.addSubscription(x({ expiryAnchor: undefined }));
  });

  parity("rejects values the database columns can't hold with a 400, not a database error", {}, async (b) => {
    await b.addSubscription(x({ amount: 1e12 }));
    await b.addSubscription(x({ amount: 999999999999.995 }));
    await b.addSubscription(x({ amount: 0.001 }));
    await b.addSubscription(x({ expiryAnchor: "2026-02-30" }));
    await b.addSubscription(x({ expiryAnchor: "2026-13-01" }));
    await b.addSubscription(x({ service: "X\u0000Y" }));
    await b.addSubscription(x({ cardOrBank: "I\u0000V" }));
    const big = await b.addSubscription(x({ amount: 999999999999.99, expiryAnchor: "2028-02-29" }));
    await b.deleteSubscription(big.row);
    await b.getSubscriptions();
  });

  parity("404s updating or deleting a row that isn't a real entry", { subscriptions: [netflix] }, async (b, { ids }) => {
    await b.updateSubscription(MISSING_ID, x({}));
    await b.deleteSubscription(MISSING_ID);
    await b.deleteSubscription(ids.subscription(0));
    await b.updateSubscription(ids.subscription(0), x({}));
    await b.updateSubscription(0, x({}));
    await b.updateSubscription(-1, x({}));
    await b.deleteSubscription(Number.NaN);
    await b.deleteSubscription(1.5);
  });
});

describe("document parity: subscriptions", () => {
  parity("trims the service and card, rounds the amount, and checks fields before the row", {}, async (b, { at }) => {
    at("2026-01-31");
    const added = await b.addSubscription(x({ service: "  Music  ", amount: 1.005, cardOrBank: "  Card A ", expiryAnchor: "2026-01-31" }));
    expect(added.amount).toBe(1.01);
    at("2026-03-01");
    await b.getSubscriptions();
    await b.updateSubscription(MISSING_ID, x({ service: "" }));
    await b.updateSubscription(added.row, x({ amount: "9" as unknown as number, cardOrBank: undefined }));
    await b.updateSubscription(added.row, x({ amount: "9" as unknown as number, cardOrBank: undefined }));
    await b.addSubscription({ amount: 5 } as SubscriptionEdits);
  });
});
