import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { sql, resetTables, closeSql } from "./dbHelpers.js";
import { withTransaction } from "../src/db/tx.js";

const TABLES = [
  "categories",
  "expenses",
  "month_locks",
  "ledger_years",
  "finance_months",
  "savings_balances",
  "debts",
  "emis",
  "subscriptions",
  "card_bills",
];

afterAll(async () => {
  await closeSql();
});

describe("schema contract (LLD §2)", () => {
  it("has every table, each with RLS enabled and no policies", async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);

    const policies = await sql`select 1 from pg_policies where schemaname = 'public'`;
    expect(policies.length).toBe(0);
  });

  it("gives the Data API roles (anon, authenticated) no privileges on any public table or sequence", async () => {
    const tableGrants = await sql`
      select grantee, table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon', 'authenticated')`;
    expect(tableGrants).toEqual([]);
    const sequenceGrants = await sql`
      select grantee, object_name from information_schema.role_usage_grants
      where object_schema = 'public' and object_type = 'SEQUENCE' and grantee in ('anon', 'authenticated')`;
    expect(sequenceGrants).toEqual([]);
  });

  it("keeps a table created by a later migration closed to the Data API roles too", async () => {
    // A rolled-back probe: the default privileges decide what a new table
    // grants, whether or not its migration remembered RLS.
    await expect(
      withTransaction(async (tx) => {
        await tx`create table public.privilege_probe (id int)`;
        const [row] = await tx<{ anon: boolean; authed: boolean }[]>`
          select has_table_privilege('anon', 'public.privilege_probe', 'select,insert,update,delete') as anon,
                 has_table_privilege('authenticated', 'public.privilege_probe', 'select,insert,update,delete') as authed`;
        expect(row).toEqual({ anon: false, authed: false });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
  });
});

describe("driver type parsing (LLD §4.2)", () => {
  beforeEach(async () => {
    await resetTables("emis");
  });

  it("returns date columns as YYYY-MM-DD strings, numerics and ids as numbers", async () => {
    const [row] = await sql`
      insert into emis (card_or_bank, emi_amount, due_day, total_amount, remaining_as_of, as_of_date)
      values ('Test', 1234.5, 7, 20000, 15000.25, '2026-03-31')
      returning id, emi_amount, remaining_as_of, as_of_date`;
    expect(row.id).toBe(1);
    expect(row.emi_amount).toBe(1234.5);
    expect(row.remaining_as_of).toBe(15000.25);
    expect(row.as_of_date).toBe("2026-03-31");
  });
});

describe("constraints mirror API validation", () => {
  beforeEach(async () => {
    await resetTables("expenses", "categories");
    await sql`insert into categories (id, label, bg, fg, position) values ('food', 'Food', '#FFFF00', '#3d3d00', 0)`;
  });

  it("rejects a non-positive expense amount, a month outside 1-12, and blank remarks", async () => {
    await expect(
      sql`insert into expenses (year, month, position, amount, remarks, category_id) values (2026, 1, 0, 0, 'x', 'food')`,
    ).rejects.toThrow(/check constraint/);
    await expect(
      sql`insert into expenses (year, month, position, amount, remarks, category_id) values (2026, 13, 0, 10, 'x', 'food')`,
    ).rejects.toThrow(/check constraint/);
    await expect(
      sql`insert into expenses (year, month, position, amount, remarks, category_id) values (2026, 1, 0, 10, '   ', 'food')`,
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects an unknown category", async () => {
    await expect(
      sql`insert into expenses (year, month, position, amount, remarks, category_id) values (2026, 1, 0, 10, 'x', 'nope')`,
    ).rejects.toThrow(/foreign key/);
  });

  it("allows swapping two entries' positions within one transaction (deferred unique constraint)", async () => {
    const [a] = await sql`insert into expenses (year, month, position, amount, remarks, category_id) values (2026, 1, 0, 10, 'a', 'food') returning id`;
    const [b] = await sql`insert into expenses (year, month, position, amount, remarks, category_id) values (2026, 1, 1, 20, 'b', 'food') returning id`;
    await withTransaction(async (tx) => {
      await tx`update expenses set position = 1 where id = ${a.id}`;
      await tx`update expenses set position = 0 where id = ${b.id}`;
    });
    const order = await sql`select remarks from expenses where year = 2026 and month = 1 order by position`;
    expect(order.map((r) => r.remarks)).toEqual(["b", "a"]);
  });

  it("still rejects a duplicate position once the transaction commits", async () => {
    await sql`insert into expenses (year, month, position, amount, remarks, category_id) values (2026, 1, 0, 10, 'a', 'food')`;
    await expect(
      sql`insert into expenses (year, month, position, amount, remarks, category_id) values (2026, 1, 0, 20, 'b', 'food')`,
    ).rejects.toThrow(/expenses_position_unique/);
  });

  it("rejects a blank card bill name", async () => {
    await resetTables("card_bills");
    await expect(
      sql`insert into card_bills (year, month, position, name) values (2026, 1, 0, '   ')`,
    ).rejects.toThrow(/card_bills_name_not_blank/);
    await sql`insert into card_bills (year, month, position, name) values (2026, 1, 0, 'Card A')`;
  });
});

describe("withTransaction", () => {
  beforeEach(async () => {
    await resetTables("debts");
  });

  it("rolls back every statement when the callback throws", async () => {
    await expect(
      withTransaction(async (tx) => {
        await tx`insert into debts (name, amount) values ('A', 100)`;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rows = await sql`select * from debts`;
    expect(rows.length).toBe(0);
  });

  it("commits when the callback succeeds and returns its value", async () => {
    const id = await withTransaction(async (tx) => {
      const [row] = await tx`insert into debts (name, amount) values ('A', 100) returning id`;
      return row.id as number;
    });
    expect(id).toBe(1);
    expect((await sql`select count(*)::int as n from debts`)[0].n).toBe(1);
  });
});
