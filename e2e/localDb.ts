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

/** Validates the URL (set, and a local host) and opens a short-lived
 * postgres.js client for it. Callers must `end()` it. */
function connectLocal(databaseUrl: string | undefined): postgres.Sql {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set in server/.env. Point it at the local Supabase stack " +
        "(postgresql://postgres:postgres@127.0.0.1:54322/postgres) and run `npx supabase start`.",
    );
  }
  const host = new URL(databaseUrl).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to touch non-local database host "${host}".`);
  }
  return postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
}

export async function resetLocalDatabase(root: string, databaseUrl: string | undefined): Promise<void> {
  const sql = connectLocal(databaseUrl);
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

/** Adds one category row to the LOCAL database (same host guard as
 * resetLocalDatabase). A missing `fg` is stored as null, so the server
 * derives it from `bg` on read. */
export async function insertLocalCategory(
  databaseUrl: string | undefined,
  category: { id: string; label: string; bg: string; fg?: string; position: number },
): Promise<void> {
  const sql = connectLocal(databaseUrl);
  try {
    await sql`
      insert into categories (id, label, bg, fg, position)
      values (${category.id}, ${category.label}, ${category.bg}, ${category.fg ?? null}, ${category.position})`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Inserts one month's expenses into the LOCAL database (same host guard as
 * resetLocalDatabase), at positions 0..n-1 in the given order. A card entry
 * gets the "CC" note the app itself writes. The categories must already
 * exist (seed.sql / insertLocalCategory). */
export async function insertLocalExpenses(
  databaseUrl: string | undefined,
  year: number,
  month: number,
  entries: { amount: number; remarks: string; category: string; isCard?: boolean }[],
): Promise<void> {
  const sql = connectLocal(databaseUrl);
  try {
    for (const [position, e] of entries.entries()) {
      await sql`
        insert into expenses (year, month, position, amount, remarks, category_id, card_note)
        values (${year}, ${month}, ${position}, ${e.amount}, ${e.remarks}, ${e.category}, ${e.isCard ? "CC" : null})`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
