import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Same pattern as workbookIO.test.ts: LEDGER_DB_DIR must be set before
// workbookIO.ts's (and this module's) top-level DB_DIR evaluates, so it's
// imported dynamically after the env var is set rather than via a static
// top-level import.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-categories-test-"));
process.env.LEDGER_DB_DIR = scratchDir;

const { loadCategoryConfig, deriveForegroundColor, categoryArgb, colorToCategory, DEFAULT_CATEGORIES } = await import(
  "../src/excel/categoryColors.js"
);
const { LedgerError } = await import("../src/excel/workbookIO.js");

const CATEGORIES_PATH = path.join(scratchDir, "categories.json");

describe("loadCategoryConfig", () => {
  it("auto-creates categories.json with DEFAULT_CATEGORIES on first read", async () => {
    expect(fs.existsSync(CATEGORIES_PATH)).toBe(false);
    const categories = await loadCategoryConfig();
    expect(categories).toEqual(DEFAULT_CATEGORIES);
    expect(fs.existsSync(CATEGORIES_PATH)).toBe(true);
  });

  it("returns a previously-saved custom config on subsequent reads, not the defaults", async () => {
    const custom = [{ id: "groceries", label: "Groceries", bg: "#00FF00", fg: "#003300" }];
    fs.writeFileSync(CATEGORIES_PATH, JSON.stringify(custom));

    const categories = await loadCategoryConfig();
    expect(categories).toEqual(custom);
  });

  it("fills in a computed fg when the file omits one, but preserves an explicit fg", async () => {
    fs.writeFileSync(
      CATEGORIES_PATH,
      JSON.stringify([
        { id: "no-fg", label: "No FG", bg: "#00FF00" },
        { id: "with-fg", label: "With FG", bg: "#00FF00", fg: "#123456" },
      ]),
    );

    const categories = await loadCategoryConfig();
    const noFg = categories.find((c) => c.id === "no-fg")!;
    const withFg = categories.find((c) => c.id === "with-fg")!;

    expect(noFg.fg).toBe(deriveForegroundColor("#00FF00"));
    expect(withFg.fg).toBe("#123456"); // untouched, not overwritten by the derivation
  });

  // A present-but-unusable categories.json used to be silently replaced with
  // DEFAULT_CATEGORIES — since this is the documented hand-edit path (see
  // README's Configuring categories) and the file isn't covered by
  // workbookIO's backup-on-write, one typo destroyed the real config with no
  // way back, and every entry already colored under a removed id would read
  // back as "Uncategorized". It must throw instead, and must leave the file
  // on disk untouched either way.
  it("throws rather than silently overwriting invalid JSON", async () => {
    fs.writeFileSync(CATEGORIES_PATH, "{ not valid json,");
    await expect(loadCategoryConfig()).rejects.toThrow(LedgerError);
    expect(fs.readFileSync(CATEGORIES_PATH, "utf8")).toBe("{ not valid json,");
  });

  it("throws rather than silently overwriting a non-array JSON value", async () => {
    fs.writeFileSync(CATEGORIES_PATH, JSON.stringify({ id: "food" }));
    await expect(loadCategoryConfig()).rejects.toThrow(LedgerError);
    expect(JSON.parse(fs.readFileSync(CATEGORIES_PATH, "utf8"))).toEqual({ id: "food" });
  });

  it("throws rather than silently overwriting a file with no usable entries", async () => {
    fs.writeFileSync(CATEGORIES_PATH, JSON.stringify([{ label: "Missing id/bg" }]));
    await expect(loadCategoryConfig()).rejects.toThrow(LedgerError);
    expect(JSON.parse(fs.readFileSync(CATEGORIES_PATH, "utf8"))).toEqual([{ label: "Missing id/bg" }]);
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

describe("categoryArgb / colorToCategory", () => {
  it("round-trips a category's bg through the Excel ARGB format and back", () => {
    const category = { id: "food", label: "Food", bg: "#FFFF00", fg: "#3d3d00" };
    const argb = categoryArgb(category);
    expect(argb).toBe("FFFFFF00");
    expect(colorToCategory(argb, [category])).toBe("food");
  });

  it("returns null for an argb that matches no configured category", () => {
    expect(colorToCategory("FF123456", DEFAULT_CATEGORIES)).toBeNull();
  });

  it("returns null for a null/undefined argb", () => {
    expect(colorToCategory(null, DEFAULT_CATEGORIES)).toBeNull();
    expect(colorToCategory(undefined, DEFAULT_CATEGORIES)).toBeNull();
  });
});
