/**
 * Resets the LOCAL Supabase Postgres to a fresh state (every public table
 * truncated, identities restarted, supabase/seed.sql re-applied) so the e2e
 * and screenshot scripts start from known-empty data, the same guarantee a
 * fresh LEDGER_DB_DIR scratch folder gives the Excel-backed modules.
 *
 * Refuses any host but 127.0.0.1/localhost: this truncates every table, so
 * it must never be pointed at a hosted project or real data.
 */
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

export async function resetLocalDatabase(root: string, databaseUrl: string | undefined): Promise<void> {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set in server/.env. Point it at the local Supabase stack " +
        "(postgresql://postgres:postgres@127.0.0.1:54322/postgres) and run `npx supabase start`.",
    );
  }
  const host = new URL(databaseUrl).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to reset non-local database host "${host}".`);
  }

  const sql = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const tables = await sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
    if (tables.length) {
      await sql.unsafe(`truncate ${tables.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`);
    }
    await sql.unsafe(fs.readFileSync(path.join(root, "supabase", "seed.sql"), "utf8"));
  } finally {
    await sql.end({ timeout: 5 });
  }
}
