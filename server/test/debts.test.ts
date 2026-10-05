import { describe, it, expect, afterAll, beforeAll } from "vitest";
// dbHelpers must be imported before any store module (it sets DATABASE_URL
// and refuses non-local hosts).
import { resetTables, closeSql } from "./dbHelpers.js";
import * as debts from "../src/store/debts.js";

// The cases below build on each other in order (add → update → delete), the
// same way the Excel edition's shared scratch workbook did, so the table is
// wiped once up front rather than before every case.
beforeAll(async () => {
  await resetTables("debts");
});

afterAll(async () => {
  await closeSql();
});

// Database ids captured from the add calls; they stand in for the sheet row
// numbers (2, 3, ...) the Excel edition returned.
let ananduRow = 0;
let ummaRow = 0;

describe("debts", () => {
  it("starts empty when no workbook exists yet", async () => {
    expect(await debts.listDebts()).toEqual([]);
  });

  it("adds entries and lists them back, preserving the lent/owed sign", async () => {
    const anandu = await debts.addDebt({ name: "Anandu", amount: -29000 });
    ananduRow = anandu.row;
    expect(anandu).toMatchObject({ row: ananduRow, name: "Anandu", amount: -29000 });

    const umma = await debts.addDebt({ name: "Umma", amount: 17700 });
    ummaRow = umma.row;
    expect(umma).toMatchObject({ row: ummaRow, name: "Umma", amount: 17700 });

    expect(await debts.listDebts()).toEqual([
      { row: ananduRow, name: "Anandu", amount: -29000 },
      { row: ummaRow, name: "Umma", amount: 17700 },
    ]);
  });

  it("updates an entry in place rather than appending a new row", async () => {
    const updated = await debts.updateDebt({ row: ananduRow, name: "Anandu", amount: -25000 });
    expect(updated).toEqual({ row: ananduRow, name: "Anandu", amount: -25000 });
    expect(await debts.listDebts()).toEqual([
      { row: ananduRow, name: "Anandu", amount: -25000 },
      { row: ummaRow, name: "Umma", amount: 17700 },
    ]);
  });

  it("deletes an entry, shifting rows below it up", async () => {
    const uppa = await debts.addDebt({ name: "Uppa", amount: 477000 });
    await debts.deleteDebt(ananduRow); // remove Anandu
    expect(await debts.listDebts()).toEqual([
      { row: ummaRow, name: "Umma", amount: 17700 },
      { row: uppa.row, name: "Uppa", amount: 477000 },
    ]);
  });

  it("rejects a blank name", async () => {
    await expect(debts.addDebt({ name: "   ", amount: 100 })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a non-finite amount", async () => {
    await expect(debts.addDebt({ name: "Someone", amount: NaN })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an amount too large for the column with a 400, not a database error", async () => {
    await expect(debts.addDebt({ name: "Someone", amount: 1e12 })).rejects.toMatchObject({ status: 400 });
    await expect(debts.addDebt({ name: "Someone", amount: -1e15 })).rejects.toMatchObject({ status: 400 });
    // Under 1e12, but the column rounds them to +/-1000000000000.00.
    await expect(debts.addDebt({ name: "Someone", amount: 999999999999.995 })).rejects.toMatchObject({ status: 400 });
    await expect(debts.addDebt({ name: "Someone", amount: -999999999999.995 })).rejects.toMatchObject({ status: 400 });
    await expect(debts.updateDebt({ row: ummaRow, name: "Umma", amount: 1e12 })).rejects.toMatchObject({ status: 400 });
    // The largest value that fits still round-trips.
    const big = await debts.addDebt({ name: "Big", amount: 999999999999.99 });
    expect(big.amount).toBe(999999999999.99);
    await debts.deleteDebt(big.row);
  });

  it("404s updating or deleting a row that isn't a real entry", async () => {
    await expect(debts.updateDebt({ row: 99, name: "Nobody", amount: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(debts.deleteDebt(99)).rejects.toMatchObject({ status: 404 });
    // There's no header row any more; the id deleted above is the nearest
    // equivalent of "a row number that isn't a real entry".
    await expect(debts.updateDebt({ row: ananduRow, name: "Header row", amount: 1 })).rejects.toMatchObject({ status: 404 });
  });
});
