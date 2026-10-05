// Pure category definitions and colour maths (no I/O), moved verbatim from
// the Excel edition's excel/categoryColors.ts (LLD §3). Storage lives in
// store/categories.ts; the Excel fill-colour helpers (colorToCategory,
// categoryArgb) stay with the unported Excel ledger.

export type Category = string;

export interface CategoryConfig {
  id: Category;
  label: string;
  /** Plain CSS hex, e.g. "#FFFF00" — not ARGB. Excel writes derive the ARGB
   * fill value from this ("FF" + bg.slice(1)) rather than storing ARGB here,
   * since a human hand-editing categories.json will find CSS hex familiar. */
  bg: string;
  /** Optional — auto-derived from bg (see deriveForegroundColor) if omitted,
   * so a hand-written categories.json entry never needs color-contrast math. */
  fg: string;
}

// The app's original 4 categories, matching the fill colors already used
// across the 2018-2026 Expenses (YYYY).xlsx files (verified by scanning every
// data row's fill color) — shipped as the default so a fresh install (or any
// deployment that never customizes categories.json) behaves identically to
// the app's original hardcoded category set.
export const DEFAULT_CATEGORIES: CategoryConfig[] = [
  { id: "food", label: "Food", bg: "#FFFF00", fg: "#3d3d00" },
  { id: "transportation", label: "Transportation", bg: "#00B0F0", fg: "#00303d" },
  { id: "rent", label: "Rent", bg: "#FFC000", fg: "#4d3300" },
  { id: "other", label: "Other", bg: "#FF0000", fg: "#ffffff" },
];

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rN = r / 255,
    gN = g / 255,
    bN = b / 255;
  const max = Math.max(rN, gN, bN),
    min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case rN:
      h = (gN - bN) / d + (gN < bN ? 6 : 0);
      break;
    case gN:
      h = (bN - rN) / d + 2;
      break;
    default:
      h = (rN - gN) / d + 4;
  }
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hN = h / 360;
  return [255 * hue2rgb(p, q, hN + 1 / 3), 255 * hue2rgb(p, q, hN), 255 * hue2rgb(p, q, hN - 1 / 3)];
}

// WCAG 2.x relative luminance / contrast ratio — standard formulas.
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const cN = c / 255;
    return cN <= 0.03928 ? cN / 12.92 : Math.pow((cN + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(hexA: string, hexB: string): number {
  const lA = relativeLuminance(hexToRgb(hexA));
  const lB = relativeLuminance(hexToRgb(hexB));
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Picks a readable text color for an arbitrary background: darkens the same
 * hue substantially (keeps the category's color identity, e.g. a yellow chip
 * gets dark-olive text, not generic black) and falls back to whichever of
 * black/white contrasts better if that still doesn't clear WCAG AA (4.5:1).
 * Not always white: pure red (#FF0000), for instance, only reaches ~4:1
 * against white but ~5.25:1 against black — picking whichever actually wins
 * guarantees a passing result for any background (the worst case, where
 * black and white tie, still clears ~4.58:1), whereas hardcoding white would
 * silently under-deliver for exactly this kind of saturated color. */
export function deriveForegroundColor(bg: string): string {
  const [h, s] = rgbToHsl(hexToRgb(bg));
  const darkened = rgbToHex(hslToRgb([h, s, 0.18]));
  if (contrastRatio(bg, darkened) >= 4.5) return darkened;
  return contrastRatio(bg, "#ffffff") >= contrastRatio(bg, "#000000") ? "#ffffff" : "#000000";
}
