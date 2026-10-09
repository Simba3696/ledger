import { DEFAULT_CATEGORIES } from "@ledger/shared/categoryColors";
import type { ModuleName } from "../../api";
import type { LedgerDocument } from "./types";

/** A new, empty ledger: version 1, the given sections and time zone, the 4
 * default categories at positions 0-3 with their `fg` (as
 * server/src/store/categories.ts inserts them into an empty table), and
 * every collection empty. */
export function createEmptyDocument({ modules, timeZone }: { modules: ModuleName[]; timeZone: string }): LedgerDocument {
  return {
    version: 1,
    settings: { modules: [...modules], timeZone },
    categories: DEFAULT_CATEGORIES.map((c, position) => ({ id: c.id, label: c.label, bg: c.bg, fg: c.fg, position })),
    expenses: {},
    monthLocks: {},
    financeMonths: {},
    debts: [],
    emis: [],
    subscriptions: [],
    cardBills: {},
    tombstones: [],
  };
}
