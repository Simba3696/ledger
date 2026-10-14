import type { ModuleName } from "../api";

// The choices a new ledger starts from (#8): which sections are ticked,
// from a fork's VITE_DEFAULT_MODULES (T7), and the time zone. The variable
// is read here and nowhere else, with the server's ENABLED_MODULES rules
// (server/src/modules.ts), so a fork can ship "expenses only" by default.

/** Every optional section, in canonical order. */
export const SECTIONS: readonly ModuleName[] = ["expenses", "finances", "debts", "emi", "credit-cards", "subscriptions"];

export const SECTION_LABELS: Record<ModuleName, string> = {
  expenses: "Expenses",
  finances: "Finances",
  debts: "Debts",
  emi: "EMI",
  "credit-cards": "Credit Cards",
  subscriptions: "Subscriptions",
};

/** VITE_DEFAULT_MODULES as parseEnabledModules reads ENABLED_MODULES:
 * comma-separated, case-insensitive, whitespace tolerant, duplicates
 * ignored, unset or blank meaning every section, in canonical order. An
 * unknown name is a misconfigured copy of Ledger, with the server's
 * wording. */
export function parseDefaultSections(raw: string | undefined): { ok: true; sections: ModuleName[] } | { ok: false; message: string } {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) return { ok: true, sections: [...SECTIONS] };
  const unknown = names.filter((n) => !(SECTIONS as readonly string[]).includes(n));
  if (unknown.length > 0) {
    return {
      ok: false,
      message:
        `Unknown module${unknown.length > 1 ? "s" : ""} in VITE_DEFAULT_MODULES: ${unknown.join(", ")}. ` +
        `Valid names: ${SECTIONS.join(", ")} (leave it unset to enable all).`,
    };
  }
  return { ok: true, sections: SECTIONS.filter((m) => names.includes(m)) };
}

/** This build's default sections. */
export function defaultSections(): ReturnType<typeof parseDefaultSections> {
  return parseDefaultSections(import.meta.env.VITE_DEFAULT_MODULES as string | undefined);
}

/** The device's time zone, or UTC when the browser can't say. */
export function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every time zone the browser knows, sorted, or null when it can't list
 * them (the picker is then a text field). The list is ICU's canonical
 * names, which can leave out zones the browser itself reports or accepts:
 * Node and Chrome list "Asia/Calcutta" but not "Asia/Kolkata", and no
 * "UTC". So the device's zone, UTC and `include` (the ledger's own zone,
 * in Settings) are always added, and the picker can always show the value
 * it holds. */
export function timeZones(include: readonly string[] = []): string[] | null {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
  let listed: string[];
  try {
    if (!intl.supportedValuesOf) return null;
    listed = intl.supportedValuesOf("timeZone");
  } catch {
    return null;
  }
  return [...new Set([...listed, defaultTimeZone(), "UTC", ...include])].sort();
}
