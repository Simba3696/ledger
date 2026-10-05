import { describe, it, expect, beforeAll, afterAll } from "vitest";
// dbHelpers must be imported before any store module (it sets DATABASE_URL
// and refuses non-local hosts).
import { resetTables, closeSql, sql } from "./dbHelpers.js";
import * as ccBills from "../src/store/creditCardBills.js";

// The cases below build on each other in order (save -> read -> overwrite),
// the same way the Excel edition's shared scratch workbook did, so the table
// is wiped once up front rather than before every case.
beforeAll(async () => {
  await resetTables("card_bills");
});

afterAll(async () => {
  await closeSql();
});

describe("getMonthBills / setMonthBills", () => {
  it("returns an empty card list for a month that was never entered", async () => {
    expect(await ccBills.getMonthBills(2094, 6)).toEqual({ year: 2094, month: 6, cards: [] });
  });

  it("round-trips a saved entry with multiple cards", async () => {
    const cards = [
      { name: "Coral", due: 5000, paid: 4990, dueDate: "2094-07-07", settled: false },
      { name: "OneCard", due: 3000, paid: 3000, dueDate: "2094-07-09", settled: true },
    ];
    await ccBills.setMonthBills({ year: 2094, month: 6, cards });
    expect(await ccBills.getMonthBills(2094, 6)).toEqual({ year: 2094, month: 6, cards });
  });

  it("defaults a legacy entry with no settled field (pre-dating the field) to false rather than rejecting it", async () => {
    // Simulates data written before `settled` existed: insert the row
    // directly, leaving `settled` to its column default (bypassing
    // setMonthBills, which requires the field), then confirm the real
    // getMonthBills path still reads it back cleanly.
    await sql`
      insert into card_bills (year, month, position, name, due, paid, due_date)
      values (2094, 8, 0, 'Coral', 5000, 4990, '2094-07-07')`;

    expect(await ccBills.getMonthBills(2094, 8)).toEqual({
      year: 2094,
      month: 8,
      cards: [{ name: "Coral", due: 5000, paid: 4990, dueDate: "2094-07-07", settled: false }],
    });
  });

  it("rejects a non-boolean settled flag", async () => {
    await expect(
      ccBills.setMonthBills({
        year: 2094,
        month: 7,
        // @ts-expect-error - deliberately wrong type to exercise validation
        cards: [{ name: "Coral", due: 100, paid: 100, dueDate: null, settled: "yes" }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("overwrites an existing entry (including clearing to empty) rather than duplicating a row", async () => {
    await ccBills.setMonthBills({ year: 2094, month: 6, cards: [] });
    expect(await ccBills.getMonthBills(2094, 6)).toEqual({ year: 2094, month: 6, cards: [] });
  });

  it("rejects a year before EARLIEST_YEAR", async () => {
    await expect(ccBills.setMonthBills({ year: 2000, month: 1, cards: [] })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a year past the column's int4 limit with the store's own 400, not a database error", async () => {
    const tooBig = ccBills.LATEST_YEAR + 1;
    const invalid = { status: 400, message: `Invalid year: ${tooBig}` };
    await expect(ccBills.getMonthBills(tooBig, 1)).rejects.toMatchObject(invalid);
    await expect(ccBills.setMonthBills({ year: tooBig, month: 1, cards: [] })).rejects.toMatchObject(invalid);
    await expect(ccBills.yearBillsSummary(tooBig)).rejects.toMatchObject(invalid);
    // The limit itself is still a valid (empty) year, as any year was before.
    expect(await ccBills.getMonthBills(ccBills.LATEST_YEAR, 12)).toEqual({ year: ccBills.LATEST_YEAR, month: 12, cards: [] });
  });

  it("rejects an out-of-range month", async () => {
    await expect(ccBills.setMonthBills({ year: 2094, month: 13, cards: [] })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a card with no name", async () => {
    await expect(
      ccBills.setMonthBills({
        year: 2094,
        month: 7,
        cards: [{ name: "", due: 100, paid: 100, dueDate: null, settled: false }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a non-finite due/paid amount", async () => {
    await expect(
      ccBills.setMonthBills({
        year: 2094,
        month: 7,
        cards: [{ name: "Coral", due: NaN, paid: 100, dueDate: null, settled: false }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a malformed due date", async () => {
    await expect(
      ccBills.setMonthBills({
        year: 2094,
        month: 7,
        cards: [{ name: "Coral", due: 100, paid: 100, dueDate: "07/09/2094", settled: false }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("Postgres storage", () => {
  it("keeps cards in the order they were saved, and a resave with fewer cards drops the rest", async () => {
    const cards = ["Zeta", "Alpha", "Mid"].map((name) => ({ name, due: 100, paid: 0, dueDate: null, settled: false }));
    expect(await ccBills.setMonthBills({ year: 2095, month: 1, cards })).toEqual({ year: 2095, month: 1, cards });
    expect((await ccBills.getMonthBills(2095, 1)).cards.map((c) => c.name)).toEqual(["Zeta", "Alpha", "Mid"]);

    await ccBills.setMonthBills({ year: 2095, month: 1, cards: [cards[2], cards[0]] });
    expect((await ccBills.getMonthBills(2095, 1)).cards.map((c) => c.name)).toEqual(["Mid", "Zeta"]);
    // Other months are untouched by a month's replace.
    expect((await ccBills.getMonthBills(2094, 8)).cards).toHaveLength(1);
  });

  it("lets overlapping saves to the same month both succeed, the last one winning (no 409)", async () => {
    // Smoke check only: getSql's single connection already serializes these
    // within one process; the advisory lock is what covers separate servers.
    const card = (name: string) => ({ name, due: 100, paid: 0, dueDate: null, settled: false });
    const a = [card("A1"), card("A2")];
    const b = [card("B1")];
    await Promise.all([
      ccBills.setMonthBills({ year: 2095, month: 4, cards: a }),
      ccBills.setMonthBills({ year: 2095, month: 4, cards: b }),
    ]);
    expect([a, b]).toContainEqual((await ccBills.getMonthBills(2095, 4)).cards);
  });

  it("still accepts negative due/paid amounts, as the Excel edition did", async () => {
    const cards = [{ name: "Refund", due: -250.5, paid: -10, dueDate: null, settled: true }];
    expect(await ccBills.setMonthBills({ year: 2095, month: 2, cards })).toEqual({ year: 2095, month: 2, cards });
  });

  it("rejects an impossible due date with a 400, not a database error", async () => {
    await expect(
      ccBills.setMonthBills({
        year: 2095,
        month: 3,
        cards: [{ name: "Coral", due: 100, paid: 100, dueDate: "2095-02-30", settled: false }],
      }),
    ).rejects.toMatchObject({ status: 400, message: 'Due date for "Coral" must be YYYY-MM-DD or null' });
  });

  it("rejects values the database columns can't hold with a 400, not a database error", async () => {
    const card = { name: "Coral", due: 100, paid: 100, dueDate: null, settled: false };
    for (const bad of [
      { ...card, due: 1e12 },
      { ...card, paid: -1e12 },
      { ...card, name: "Co\u0000ral" },
    ]) {
      await expect(ccBills.setMonthBills({ year: 2095, month: 3, cards: [bad] })).rejects.toMatchObject({ status: 400 });
    }
    // A rejected save leaves the month as it was (nothing half-written).
    expect((await ccBills.getMonthBills(2095, 3)).cards).toEqual([]);
    // The largest value the column holds round-trips exactly; others come back at 2 decimals.
    const saved = await ccBills.setMonthBills({
      year: 2095,
      month: 3,
      cards: [{ ...card, due: 999999999999.99, paid: 10.006 }],
    });
    expect(saved.cards[0]).toMatchObject({ due: 999999999999.99, paid: 10.01 });
  });
});

describe("yearBillsSummary", () => {
  const YEAR = 2093;

  beforeAll(async () => {
    await ccBills.setMonthBills({
      year: YEAR,
      month: 1,
      cards: [
        // Settled: its own (due - paid) gap counts toward overpaidOrSaved.
        { name: "Coral", due: 5000, paid: 4990, dueDate: "2093-01-07", settled: true },
        // Unsettled: paid *more* than due (a real -50 gap), but since this
        // bill isn't marked Settled yet, that gap must NOT count — an
        // in-progress bill shouldn't move the Saved/Overpaid figure.
        { name: "OneCard", due: 3000, paid: 3050, dueDate: "2093-01-09", settled: false },
      ],
    });
    await ccBills.setMonthBills({
      year: YEAR,
      month: 2,
      // Unsettled with a real due/paid gap (100) — must contribute 0.
      cards: [{ name: "Coral", due: 1000, paid: 900, dueDate: null, settled: false }],
    });
    // Month 3 intentionally left with no entry at all.
  });

  it("returns exactly 12 months, computing totals/earliest-date/overpaid independently per month", async () => {
    const summary = await ccBills.yearBillsSummary(YEAR);
    expect(summary).toHaveLength(12);
    const [jan, feb, mar] = summary;

    // Jan: totalDue = 5000+3000 = 8000, totalPaid = 4990+3050 = 8040 — these
    // sum every card regardless of settled status. overpaidOrSaved, though,
    // only counts Coral (settled): 5000-4990 = 10. OneCard's -50 gap is
    // real (it was paid more than due) but doesn't count since it isn't
    // settled — the naive totalDue-totalPaid would give -40 here instead.
    // Earliest due date = min(Jan 7, Jan 9) = Jan 7, unaffected by settled.
    expect(jan).toMatchObject({
      month: 1,
      totalDue: 8000,
      totalPaid: 8040,
      earliestDueDate: "2093-01-07",
      overpaidOrSaved: 10,
    });

    // Feb: single unsettled card with a real 100 gap — contributes 0 to
    // overpaidOrSaved even though totalDue/totalPaid still reflect it.
    // No due date entered at all -> earliestDueDate null.
    expect(feb).toMatchObject({
      month: 2,
      totalDue: 1000,
      totalPaid: 900,
      earliestDueDate: null,
      overpaidOrSaved: 0,
    });

    // Mar: no entry at all -> zeroed out, not omitted.
    expect(mar).toMatchObject({
      month: 3,
      cards: [],
      totalDue: 0,
      totalPaid: 0,
      earliestDueDate: null,
      overpaidOrSaved: 0,
    });
  });
});
