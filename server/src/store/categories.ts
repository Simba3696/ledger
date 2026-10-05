import { getSql } from "../db/client.js";
import { DEFAULT_CATEGORIES, deriveForegroundColor, type CategoryConfig } from "../domain/categoryColors.js";

export {
  DEFAULT_CATEGORIES,
  deriveForegroundColor,
  type Category,
  type CategoryConfig,
} from "../domain/categoryColors.js";

interface CategoryRow {
  id: string;
  label: string;
  bg: string;
  /** Null = derive from bg on read, as an Excel-edition categories.json entry
   * without an fg did. */
  fg: string | null;
}

function toEntry(r: CategoryRow): CategoryConfig {
  return {
    id: r.id,
    label: r.label,
    bg: r.bg,
    fg: r.fg ?? deriveForegroundColor(r.bg),
  };
}

async function selectCategories(): Promise<CategoryConfig[]> {
  const sql = getSql();
  const rows = await sql<CategoryRow[]>`
    select id, label, bg, fg
    from categories order by position, id`;
  return rows.map(toEntry);
}

/** Read-or-create, same as the Excel edition's categories.json: an empty
 * `categories` table is filled with DEFAULT_CATEGORIES on first read, so a
 * brand-new hosted project (which never runs seed.sql) and a freshly reset
 * local database both work without any setup step. Read fresh on every
 * call, no caching, so a change to the table takes effect on the next
 * request.
 *
 * `on conflict do nothing` keeps two concurrent first reads from colliding:
 * the loser's insert is a no-op and both then read the same rows back. */
export async function loadCategoryConfig(): Promise<CategoryConfig[]> {
  const existing = await selectCategories();
  if (existing.length > 0) return existing;

  const sql = getSql();
  const defaults = DEFAULT_CATEGORIES.map((c, position) => ({ id: c.id, label: c.label, bg: c.bg, fg: c.fg, position }));
  await sql`
    insert into categories ${sql(defaults, "id", "label", "bg", "fg", "position")}
    on conflict do nothing`;
  return selectCategories();
}
