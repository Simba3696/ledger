import { LedgerError } from "@ledger/shared/errors";
import type { ModuleName } from "../../api";

// The module gate, ported from server/src/modules.ts (ADR-0006) rather than
// imported: that file is server code the Supabase deployment ships. The
// backend parity suite checks the two agree.

/** Every optional module, in canonical order (the order getConfig returns). */
const MODULES: readonly ModuleName[] = ["expenses", "finances", "debts", "emi", "credit-cards", "subscriptions"];

const MODULE_LABELS: Record<ModuleName, string> = {
  expenses: "Expenses",
  finances: "Finances",
  debts: "Debts",
  emi: "EMI",
  "credit-cards": "Credit Cards",
  subscriptions: "Subscriptions",
};

/** The enabled modules in canonical order, duplicates and unknown names
 * dropped, as parseEnabledModules leaves ENABLED_MODULES. */
export function canonicalModules(modules: readonly string[]): ModuleName[] {
  return MODULES.filter((m) => modules.includes(m));
}

/** The 404 a disabled module's route answers with (requireEnabledModule). */
export function assertModuleEnabled(modules: readonly string[], module: ModuleName): void {
  if (!modules.includes(module)) {
    throw new LedgerError(`${MODULE_LABELS[module]} is not enabled on this deployment`, 404);
  }
}
