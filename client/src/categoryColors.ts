import type { Category } from "./api";

// Matches the fill colors already used in the Excel sheets.
export const CATEGORY_SWATCH: Record<Category, { bg: string; fg: string }> = {
  food: { bg: "#FFFF00", fg: "#3d3d00" },
  transportation: { bg: "#00B0F0", fg: "#00303d" },
  rent: { bg: "#FFC000", fg: "#4d3300" },
  other: { bg: "#FF0000", fg: "#ffffff" },
};
