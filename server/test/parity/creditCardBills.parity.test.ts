import { describe, expect } from "vitest";
import type { CardBill } from "../../../client/src/api";
import { parity } from "./harness";

// server/test/creditCardBills.test.ts against both backends. The store
// cases share one table in order; each case here plants what it relies on.

const card = (name: string, extra: Partial<CardBill> = {}): CardBill => ({
  name,
  due: 100,
  paid: 0,
  dueDate: null,
  settled: false,
  ...extra,
});

const coralAndOneCard: CardBill[] = [
  { name: "Coral", due: 5000, paid: 4990, dueDate: "2094-07-07", settled: false },
  { name: "OneCard", due: 3000, paid: 3000, dueDate: "2094-07-09", settled: true },
];

describe("getMonthBills / setMonthBills", () => {
  parity("returns an empty card list for a month that was never entered", {}, async (b) => {
    await b.getMonthBills(2094, 6);
  });

  parity("round-trips a saved entry with multiple cards", {}, async (b) => {
    await b.setMonthBills(2094, 6, coralAndOneCard);
    expect(await b.getMonthBills(2094, 6)).toEqual({ year: 2094, month: 6, cards: coralAndOneCard });
  });

  parity(
    "defaults a legacy entry with no settled field (pre-dating the field) to false rather than rejecting it",
    { cardBills: [{ year: 2094, month: 8, cards: [{ name: "Coral", due: 5000, paid: 4990, dueDate: "2094-07-07" }] }] },
    async (b) => {
      await b.getMonthBills(2094, 8);
    },
  );

  parity("rejects a non-boolean settled flag", {}, async (b) => {
    // routes.ts turns anything but `true` into false before the store sees
    // it, so over HTTP this saves an unsettled card.
    await b.setMonthBills(2094, 7, [{ ...card("Coral", { due: 100, paid: 100 }), settled: "yes" as unknown as boolean }]);
    await b.getMonthBills(2094, 7);
  });

  parity(
    "overwrites an existing entry (including clearing to empty) rather than duplicating a row",
    { cardBills: [{ year: 2094, month: 6, cards: coralAndOneCard }] },
    async (b) => {
      await b.setMonthBills(2094, 6, []);
      await b.getMonthBills(2094, 6);
      await b.getCreditCardBillsSummary(2094);
    },
  );

  parity("rejects a year before EARLIEST_YEAR", {}, async (b) => {
    await b.setMonthBills(2000, 1, []);
    await b.getMonthBills(2000, 1);
    await b.getCreditCardBillsSummary(2000);
  });

  parity("rejects a year past the column's int4 limit with the store's own 400, not a database error", {}, async (b) => {
    const tooBig = 2147483647 + 1;
    await b.getMonthBills(tooBig, 1);
    await b.setMonthBills(tooBig, 1, []);
    await b.getCreditCardBillsSummary(tooBig);
    await b.getMonthBills(2147483647, 12);
  });

  parity("rejects an out-of-range month", {}, async (b) => {
    await b.setMonthBills(2094, 13, []);
    await b.getMonthBills(2094, 0);
  });

  parity("rejects a card with no name", {}, async (b) => {
    await b.setMonthBills(2094, 7, [card("", { paid: 100 })]);
    await b.setMonthBills(2094, 7, [card("  ", { paid: 100 })]);
  });

  parity("rejects a non-finite due/paid amount", {}, async (b) => {
    // NaN is null on the wire, which Number() makes 0.
    await b.setMonthBills(2094, 7, [card("Coral", { due: Number.NaN, paid: 100 })]);
    await b.setMonthBills(2094, 7, [card("Coral", { due: "x" as unknown as number })]);
    await b.setMonthBills(2094, 7, [card("Coral", { paid: "x" as unknown as number })]);
    await b.getMonthBills(2094, 7);
  });

  parity("rejects a malformed due date", {}, async (b) => {
    await b.setMonthBills(2094, 7, [card("Coral", { paid: 100, dueDate: "07/09/2094" })]);
  });
});

describe("Postgres storage", () => {
  const zam = ["Zeta", "Alpha", "Mid"].map((name) => card(name));

  parity(
    "keeps cards in the order they were saved, and a resave with fewer cards drops the rest",
    { cardBills: [{ year: 2094, month: 8, cards: [{ name: "Coral", due: 5000, paid: 4990, dueDate: "2094-07-07" }] }] },
    async (b) => {
      await b.setMonthBills(2095, 1, zam);
      await b.getMonthBills(2095, 1);
      await b.setMonthBills(2095, 1, [zam[2], zam[0]]);
      await b.getMonthBills(2095, 1);
      await b.getMonthBills(2094, 8);
    },
  );

  parity("lets overlapping saves to the same month both succeed, the last one winning (no 409)", {}, async (b, { note, quietly }) => {
    const a = [card("A1"), card("A2")];
    const bCards = [card("B1")];
    await Promise.all([b.setMonthBills(2095, 4, a), b.setMonthBills(2095, 4, bCards)]);
    const after = await quietly(() => b.getMonthBills(2095, 4));
    note("one of the two saves won whole", [a, bCards].some((cards) => JSON.stringify(cards) === JSON.stringify(after.cards)));
  });

  parity("still accepts negative due/paid amounts, as the Excel edition did", {}, async (b) => {
    await b.setMonthBills(2095, 2, [{ name: "Refund", due: -250.5, paid: -10, dueDate: null, settled: true }]);
  });

  parity("rejects an impossible due date with a 400, not a database error", {}, async (b) => {
    await b.setMonthBills(2095, 3, [card("Coral", { paid: 100, dueDate: "2095-02-30" })]);
    await b.setMonthBills(2095, 3, [card("Coral", { paid: 100, dueDate: "0000-01-01" })]);
  });

  parity("rejects values the database columns can't hold with a 400, not a database error", {}, async (b) => {
    const coral = card("Coral", { paid: 100 });
    await b.setMonthBills(2095, 3, [{ ...coral, due: 1e12 }]);
    await b.setMonthBills(2095, 3, [{ ...coral, paid: -1e12 }]);
    await b.setMonthBills(2095, 3, [{ ...coral, name: "Co\u0000ral" }]);
    await b.getMonthBills(2095, 3);
    await b.setMonthBills(2095, 3, [{ ...coral, due: 999999999999.99, paid: 10.006 }]);
    await b.getMonthBills(2095, 3);
  });
});

describe("yearBillsSummary", () => {
  const YEAR = 2093;

  parity(
    "returns exactly 12 months, computing totals/earliest-date/overpaid independently per month",
    {
      cardBills: [
        {
          year: YEAR,
          month: 1,
          cards: [
            { name: "Coral", due: 5000, paid: 4990, dueDate: "2093-01-07", settled: true },
            { name: "OneCard", due: 3000, paid: 3050, dueDate: "2093-01-09", settled: false },
          ],
        },
        { year: YEAR, month: 2, cards: [{ name: "Coral", due: 1000, paid: 900, dueDate: null, settled: false }] },
      ],
    },
    async (b) => {
      const summary = await b.getCreditCardBillsSummary(YEAR);
      expect(summary).toHaveLength(12);
      expect(summary[0]).toMatchObject({ totalDue: 8000, totalPaid: 8040, earliestDueDate: "2093-01-07", overpaidOrSaved: 10 });
    },
  );
});

describe("document parity: credit card bills", () => {
  parity("coerces each card as routes.ts does: blank due dates, missing fields, a non-array list", {}, async (b) => {
    await b.setMonthBills(2026, 1, [{ name: "Card A", due: 10, paid: 5, dueDate: "", settled: true }]);
    await b.setMonthBills(2026, 2, [{ name: "Card B" } as unknown as CardBill]);
    await b.setMonthBills(2026, 2, [{ name: "Card B", due: "10.005", paid: "1", dueDate: 20260301, settled: 1 } as unknown as CardBill]);
    await b.setMonthBills(2026, 3, "none" as unknown as CardBill[]);
    await b.setMonthBills(2026, 3, [null as unknown as CardBill]);
    await b.getCreditCardBillsSummary(2026);
  });

  parity("keeps a resaved card's amounts at 2 decimals and lists the month in saved order", {}, async (b) => {
    await b.setMonthBills(2026, 4, [card("Card A", { due: 1.005, paid: -1.005 }), card(" Card B ", { due: 0.1 })]);
    await b.setMonthBills(2026, 4, [card(" Card B ", { due: 0.2 }), card("Card A", { due: 1.005, paid: -1.005 })]);
    await b.getMonthBills(2026, 4);
    const summary = await b.getCreditCardBillsSummary(2026);
    expect(summary[3].totalDue).toBeCloseTo(1.21);
  });
});
