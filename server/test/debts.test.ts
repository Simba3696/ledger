import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Same pattern as ledger.test.ts / finances.test.ts: LEDGER_DB_DIR must be set
// before debts.ts's top-level DB_DIR evaluates, so it's imported dynamically
// after the env var is set rather than via a static top-level import.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-debts-test-"));
process.env.LEDGER_DB_DIR = scratchDir;

const debts = await import("../src/excel/debts.js");

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

describe("debts", () => {
  it("starts empty when no workbook exists yet", async () => {
    expect(await debts.listDebts()).toEqual([]);
  });

  it("adds entries and lists them back, preserving the lent/owed sign", async () => {
    const anandu = await debts.addDebt({ name: "Anandu", amount: -29000 });
    expect(anandu).toMatchObject({ row: 2, name: "Anandu", amount: -29000 });

    const umma = await debts.addDebt({ name: "Umma", amount: 17700 });
    expect(umma).toMatchObject({ row: 3, name: "Umma", amount: 17700 });

    expect(await debts.listDebts()).toEqual([
      { row: 2, name: "Anandu", amount: -29000 },
      { row: 3, name: "Umma", amount: 17700 },
    ]);
  });

  it("updates an entry in place rather than appending a new row", async () => {
    const updated = await debts.updateDebt({ row: 2, name: "Anandu", amount: -25000 });
    expect(updated).toEqual({ row: 2, name: "Anandu", amount: -25000 });
    expect(await debts.listDebts()).toEqual([
      { row: 2, name: "Anandu", amount: -25000 },
      { row: 3, name: "Umma", amount: 17700 },
    ]);
  });

  it("deletes an entry, shifting rows below it up", async () => {
    await debts.addDebt({ name: "Uppa", amount: 477000 });
    await debts.deleteDebt(2); // remove Anandu
    expect(await debts.listDebts()).toEqual([
      { row: 2, name: "Umma", amount: 17700 },
      { row: 3, name: "Uppa", amount: 477000 },
    ]);
  });

  it("rejects a blank name", async () => {
    await expect(debts.addDebt({ name: "   ", amount: 100 })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects a non-finite amount", async () => {
    await expect(debts.addDebt({ name: "Someone", amount: NaN })).rejects.toMatchObject({ status: 400 });
  });

  it("404s updating or deleting a row that isn't a real entry", async () => {
    await expect(debts.updateDebt({ row: 99, name: "Nobody", amount: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(debts.deleteDebt(99)).rejects.toMatchObject({ status: 404 });
    await expect(debts.updateDebt({ row: 1, name: "Header row", amount: 1 })).rejects.toMatchObject({ status: 404 });
  });
});
