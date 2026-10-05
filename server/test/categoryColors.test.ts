import { describe, it, expect, afterAll } from "vitest";
// Categories now live in Postgres: dbHelpers must load before any store module.
import { sql, resetTables, closeSql } from "./dbHelpers.js";
import { loadCategoryConfig, deriveForegroundColor, DEFAULT_CATEGORIES } from "../src/store/categories.js";

afterAll(async () => {
  // Leave an empty table so the next reader re-creates the defaults, the
  // state every other test file expects.
  await resetTables("categories");
  await closeSql();
});

/** Stands in for hand-writing categories.json: replaces the whole table with
 * these entries, in order. A missing fg is stored as null (derived on read). */
async function writeCategories(entries: { id: string; label: string; bg: string; fg?: string }[]): Promise<void> {
  await resetTables("categories");
  for (const [position, e] of entries.entries()) {
    await sql`
      insert into categories (id, label, bg, fg, position)
      values (${e.id}, ${e.label}, ${e.bg}, ${e.fg ?? null}, ${position})`;
  }
}

async function categoryRowCount(): Promise<number> {
  const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from categories`;
  return count;
}

describe("loadCategoryConfig", () => {
  it("auto-creates categories.json with DEFAULT_CATEGORIES on first read", async () => {
    await resetTables("categories");
    expect(await categoryRowCount()).toBe(0);
    const categories = await loadCategoryConfig();
    expect(categories).toEqual(DEFAULT_CATEGORIES);
    expect(await categoryRowCount()).toBe(DEFAULT_CATEGORIES.length);
  });

  it("returns a previously-saved custom config on subsequent reads, not the defaults", async () => {
    const custom = [{ id: "groceries", label: "Groceries", bg: "#00FF00", fg: "#003300" }];
    await writeCategories(custom);

    const categories = await loadCategoryConfig();
    expect(categories).toEqual(custom);
  });

  it("fills in a computed fg when the file omits one, but preserves an explicit fg", async () => {
    await writeCategories([
      { id: "no-fg", label: "No FG", bg: "#00FF00" },
      { id: "with-fg", label: "With FG", bg: "#00FF00", fg: "#123456" },
    ]);

    const categories = await loadCategoryConfig();
    const noFg = categories.find((c) => c.id === "no-fg")!;
    const withFg = categories.find((c) => c.id === "with-fg")!;

    expect(noFg.fg).toBe(deriveForegroundColor("#00FF00"));
    expect(withFg.fg).toBe("#123456"); // untouched, not overwritten by the derivation
  });

  it("returns categories in position order, not insertion or id order", async () => {
    await resetTables("categories");
    await sql`
      insert into categories (id, label, bg, fg, position) values
        ('b', 'B', '#000000', null, 1),
        ('c', 'C', '#000000', null, 2),
        ('a', 'A', '#000000', null, 0)`;
    expect((await loadCategoryConfig()).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("does not re-insert the defaults once the table has rows", async () => {
    await writeCategories([{ id: "groceries", label: "Groceries", bg: "#00FF00" }]);
    await loadCategoryConfig();
    await loadCategoryConfig();
    expect(await categoryRowCount()).toBe(1);
  });

  it("the schema allows a null fg but still rejects a malformed non-null one", async () => {
    await resetTables("categories");
    await sql`insert into categories (id, label, bg, fg, position) values ('ok', 'OK', '#000000', null, 0)`;
    expect(await categoryRowCount()).toBe(1);
    await expect(
      sql`insert into categories (id, label, bg, fg, position) values ('x', 'X', '#000000', 'red', 1)`,
    ).rejects.toThrow(/check constraint/);
  });
});

describe("deriveForegroundColor", () => {
  function contrastOk(bg: string, fg: string): boolean {
    // Re-derive the same WCAG relative-luminance contrast check the function
    // itself uses, as an independent verification rather than trusting the
    // implementation to grade its own homework.
    const toRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const luminance = (hex: string) => {
      const [r, g, b] = toRgb(hex).map((c) => {
        const cN = c / 255;
        return cN <= 0.03928 ? cN / 12.92 : Math.pow((cN + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const lBg = luminance(bg);
    const lFg = luminance(fg);
    const ratio = (Math.max(lBg, lFg) + 0.05) / (Math.min(lBg, lFg) + 0.05);
    return ratio >= 4.5;
  }

  it("produces sufficient WCAG AA contrast for a representative range of backgrounds", () => {
    for (const bg of ["#FFFFFF", "#000000", "#FFFF00", "#FF0000", "#00B0F0", "#808080", "#123456"]) {
      const fg = deriveForegroundColor(bg);
      expect(contrastOk(bg, fg), `bg=${bg} fg=${fg}`).toBe(true);
    }
  });

  it("picks whichever of black/white actually contrasts better, not always white", () => {
    // Pure red only reaches ~4:1 against white (fails AA) but ~5.25:1
    // against black — this is exactly the case a naive "always fall back to
    // white" implementation would get wrong. (DEFAULT_CATEGORIES ships its
    // own explicit "#ffffff" for Other regardless — this only covers what
    // the algorithm derives for a *custom* category with no fg specified.)
    expect(deriveForegroundColor("#FF0000")).toBe("#000000");
  });

  it("darkens the same hue (not a generic black/white split) for a bright background", () => {
    const fg = deriveForegroundColor("#FFFF00");
    expect(fg).not.toBe("#ffffff");
    expect(fg).not.toBe("#000000");
  });
});
