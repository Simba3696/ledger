// Shared setup for every test that touches Postgres. Import this module
// *before* any store module so DATABASE_URL is in place before the
// connection is created.
import { getSql, closeSql } from "../src/db/client.js";

const LOCAL_STACK_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

process.env.DATABASE_URL ??= LOCAL_STACK_URL;

// These tests TRUNCATE tables. Refuse to run against anything but a local
// database — never a hosted Supabase project, never real data.
const host = new URL(process.env.DATABASE_URL).hostname;
if (host !== "127.0.0.1" && host !== "localhost") {
  throw new Error(`Refusing to run DB tests against non-local host "${host}". Use the local Supabase stack.`);
}

export const sql = getSql();

/** Wipes the given tables and resets their identity counters. `cascade`
 * also clears dependent rows (e.g. savings_balances under finance_months). */
export async function resetTables(...tables: string[]): Promise<void> {
  await sql.unsafe(`truncate ${tables.join(", ")} restart identity cascade`);
}

export { closeSql };
