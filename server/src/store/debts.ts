import { getSql } from "../db/client.js";
import { LedgerError } from "../errors.js";
import { assertMoney, assertText, isPossibleId } from "./validate.js";

export interface DebtEntry {
  /** The debt's database id (opaque and stable; no longer a sheet row). */
  row: number;
  name: string;
  /** Negative = money the user lent out (owed back to them); positive = money
   * the user owes someone else. Matches the sign convention already used in
   * the source Expense Summary.xlsm Debts sheet. */
  amount: number;
}

export interface AddDebtInput {
  name: string;
  amount: number;
}

export interface UpdateDebtInput {
  row: number;
  name: string;
  amount: number;
}

interface DebtRow {
  id: number;
  name: string;
  amount: number;
}

function toEntry(r: DebtRow): DebtEntry {
  return { row: r.id, name: r.name, amount: r.amount };
}

function validateEntry(name: string, amount: number) {
  if (!name) throw new LedgerError("Name is required", 400);
  assertText(name, "Name");
  // Signed (+ you owe, − owed to you), so any finite amount that fits the column.
  assertMoney(amount, { positive: false });
}

function notFound(row: number): LedgerError {
  return new LedgerError(`No debt entry at row ${row}`, 404);
}

/** Insertion order, matching the Excel edition's sheet order. */
export async function listDebts(): Promise<DebtEntry[]> {
  const sql = getSql();
  const rows = await sql<DebtRow[]>`select id, name, amount from debts order by id`;
  return rows.map(toEntry);
}

export async function addDebt(input: AddDebtInput): Promise<DebtEntry> {
  const name = input.name.trim();
  validateEntry(name, input.amount);

  const sql = getSql();
  const [r] = await sql<DebtRow[]>`
    insert into debts (name, amount) values (${name}, ${input.amount})
    returning id, name, amount`;
  return toEntry(r);
}

export async function updateDebt(input: UpdateDebtInput): Promise<DebtEntry> {
  const name = input.name.trim();
  validateEntry(name, input.amount);
  if (!isPossibleId(input.row)) throw notFound(input.row);

  const sql = getSql();
  const [r] = await sql<DebtRow[]>`
    update debts set name = ${name}, amount = ${input.amount}
    where id = ${input.row}
    returning id, name, amount`;
  if (!r) throw notFound(input.row);
  return toEntry(r);
}

export async function deleteDebt(rowNumber: number): Promise<void> {
  if (!isPossibleId(rowNumber)) throw notFound(rowNumber);

  const sql = getSql();
  const result = await sql`delete from debts where id = ${rowNumber}`;
  if (result.count === 0) throw notFound(rowNumber);
}
