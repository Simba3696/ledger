import type { Category, CategoryConfig } from "../domain/categoryColors.js";

// Categories now live in Postgres (store/categories.ts) and their pure parts
// in domain/categoryColors.ts. What's left here are the Excel fill-colour
// helpers the unported Excel ledger (excel/ledger.ts) still needs; the
// ledger port moves them to scripts/legacy-excel. The original Excel module
// is kept verbatim at scripts/legacy-excel/categoryColors.ts.

export {
  DEFAULT_CATEGORIES,
  deriveForegroundColor,
  type Category,
  type CategoryConfig,
} from "../domain/categoryColors.js";

export function colorToCategory(argb: string | null | undefined, categories: CategoryConfig[]): Category | null {
  if (!argb) return null;
  const upper = argb.toUpperCase();
  for (const category of categories) {
    if (`FF${category.bg.slice(1).toUpperCase()}` === upper) return category.id;
  }
  return null;
}

export function categoryArgb(category: CategoryConfig): string {
  return `FF${category.bg.slice(1).toUpperCase()}`;
}
