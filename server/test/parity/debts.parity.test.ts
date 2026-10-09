import { describe, expect } from "vitest";
import { MISSING_ID, parity } from "./harness";

// server/test/debts.test.ts, case for case, against both backends. The
// store cases build on each other (add, update, delete); here each one
// plants the state its predecessors left as a fixture.

const anandu = { name: "Anandu", amount: -29000 };
const umma = { name: "Umma", amount: 17700 };

describe("debts", () => {
  parity("starts empty when no workbook exists yet", {}, async (b) => {
    await b.getDebts();
  });

  parity("adds entries and lists them back, preserving the lent/owed sign", {}, async (b) => {
    await b.addDebt(anandu);
    await b.addDebt(umma);
    await b.getDebts();
  });

  parity("updates an entry in place rather than appending a new row", { debts: [anandu, umma] }, async (b, { ids }) => {
    await b.updateDebt(ids.debt(0), { name: "Anandu", amount: -25000 });
    await b.getDebts();
  });

  parity("deletes an entry, shifting rows below it up", { debts: [{ name: "Anandu", amount: -25000 }, umma] }, async (b, { ids }) => {
    await b.addDebt({ name: "Uppa", amount: 477000 });
    await b.deleteDebt(ids.debt(0));
    await b.getDebts();
  });

  parity("rejects a blank name", {}, async (b) => {
    await b.addDebt({ name: "   ", amount: 100 });
    await b.getDebts();
  });

  parity("rejects a non-finite amount", {}, async (b) => {
    // NaN reaches the server as null, which Number() makes 0: a valid debt.
    await b.addDebt({ name: "Someone", amount: Number.NaN });
    // An amount that isn't numeric at all is the store's NaN.
    await b.addDebt({ name: "Someone", amount: "lots" as unknown as number });
    await b.addDebt({ name: "Someone" } as { name: string; amount: number });
    await b.getDebts();
  });

  parity("rejects a name Postgres can't store (NUL) with a 400, not a database error", {}, async (b) => {
    await b.addDebt({ name: "Some\u0000one", amount: 100 });
  });

  parity("rejects an amount too large for the column with a 400, not a database error", { debts: [umma] }, async (b, { ids }) => {
    await b.addDebt({ name: "Someone", amount: 1e12 });
    await b.addDebt({ name: "Someone", amount: -1e15 });
    await b.addDebt({ name: "Someone", amount: 999999999999.995 });
    await b.addDebt({ name: "Someone", amount: -999999999999.995 });
    await b.updateDebt(ids.debt(0), { name: "Umma", amount: 1e12 });
    const big = await b.addDebt({ name: "Big", amount: 999999999999.99 });
    await b.deleteDebt(big.row);
    await b.getDebts();
  });

  parity("404s updating or deleting a row that isn't a real entry", { debts: [anandu, umma] }, async (b, { ids }) => {
    await b.updateDebt(MISSING_ID, { name: "Nobody", amount: 1 });
    await b.deleteDebt(MISSING_ID);
    await b.deleteDebt(ids.debt(0));
    await b.updateDebt(ids.debt(0), { name: "Header row", amount: 1 });
    for (const row of [0, -1, Number.NaN, 1.5]) {
      await b.updateDebt(row, { name: "Nobody", amount: 1 });
      await b.deleteDebt(row);
    }
  });
});

describe("document parity: debts", () => {
  parity("a debt of -1.005 gives -1.01", {}, async (b) => {
    const added = await b.addDebt({ name: "Alex", amount: -1.005 });
    expect(added.amount).toBe(-1.01);
    await b.getDebts();
  });

  parity("trims the name, keeps the stored row on a no-op update, and rounds a tiny negative to 0", {}, async (b) => {
    const added = await b.addDebt({ name: "  Alex  ", amount: -0.001 });
    await b.updateDebt(added.row, { name: "Alex", amount: 0 });
    await b.getDebts();
  });

  parity("stores a lone surrogate the way Postgres does, as U+FFFD", {}, async (b) => {
    await b.addDebt({ name: "A\uD800B", amount: 1 });
    await b.getDebts();
  });
});
