export type Category = "food" | "transportation" | "rent" | "other";

export const CATEGORIES: Category[] = ["food", "transportation", "rent", "other"];

// ARGB fill colors, matching the scheme already used across the 2018-2026
// Expenses (YYYY).xlsx files (verified by scanning every data row's fill color).
export const CATEGORY_COLORS: Record<Category, string> = {
  food: "FFFFFF00",
  transportation: "FF00B0F0",
  rent: "FFFFC000",
  other: "FFFF0000",
};

export const CATEGORY_LABELS: Record<Category, string> = {
  food: "Food",
  transportation: "Transportation",
  rent: "Rent",
  other: "Other",
};

export function colorToCategory(argb?: string | null): Category | null {
  if (!argb) return null;
  const upper = argb.toUpperCase();
  for (const category of CATEGORIES) {
    if (CATEGORY_COLORS[category] === upper) return category;
  }
  return null;
}
