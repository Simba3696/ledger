import type { Request, RequestHandler } from "express";

// Which sections of the app this deployment serves (ADR-0006, LLD §5/§9).
// ENABLED_MODULES lets one deployment start expenses-only and turn more
// sections on later by changing the variable and redeploying. Nothing in the
// database depends on it: every table exists either way, and a disabled
// module's routes are never served. (Its rows can still be read indirectly:
// Finances reads expense totals for its balances when expenses is off.)

/** Every optional module, in canonical order (the order GET /api/config
 * returns them in). The Dashboard, categories and config are always on. */
export const MODULES = ["expenses", "finances", "debts", "emi", "credit-cards", "subscriptions"] as const;

export type ModuleName = (typeof MODULES)[number];

/** How a module is named in the 404 for its disabled routes; matches its tab label. */
export const MODULE_LABELS: Record<ModuleName, string> = {
  expenses: "Expenses",
  finances: "Finances",
  debts: "Debts",
  emi: "EMI",
  "credit-cards": "Credit Cards",
  subscriptions: "Subscriptions",
};

/** Parses ENABLED_MODULES: comma-separated, case-insensitive, whitespace
 * tolerant, duplicates ignored. Unset or blank means every module. An
 * unknown name throws, so a typo fails the deploy at startup instead of
 * silently hiding a section. */
export function parseEnabledModules(raw: string | undefined): ModuleName[] {
  const names = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) return [...MODULES];
  const unknown = names.filter((n) => !(MODULES as readonly string[]).includes(n));
  if (unknown.length) {
    throw new Error(
      `Unknown module${unknown.length > 1 ? "s" : ""} in ENABLED_MODULES: ${unknown.join(", ")}. ` +
        `Valid names: ${MODULES.join(", ")} (leave it unset to enable all).`,
    );
  }
  return MODULES.filter((m) => names.includes(m));
}

/** The first path segment of every module-owned route → its module. Routes
 * whose segment isn't listed (categories, config, overview) are always on;
 * api.test.ts checks that every route in routes.ts is one or the other. */
export const ROUTE_MODULES: Record<string, ModuleName> = {
  months: "expenses",
  summary: "expenses",
  entries: "expenses",
  finance: "finances",
  "finance-summary": "finances",
  debts: "debts",
  emi: "emi",
  "emi-monthly-projection": "emi",
  "credit-card-bills": "credit-cards",
  "credit-card-bills-summary": "credit-cards",
  subscriptions: "subscriptions",
};

export const ALWAYS_ON_ROUTES = new Set(["categories", "config", "overview"]);

/** One middleware in front of the router: a request for a disabled module's
 * route is a 404 before it reaches any store code. The segment is lowercased
 * because Express routes match case-insensitively, so /api/DEBTS reaches the
 * debts handlers just as /api/debts does. */
export function requireEnabledModule(enabled: readonly ModuleName[]): RequestHandler {
  const on = new Set(enabled);
  return (req, res, next) => {
    const module = ROUTE_MODULES[(req.path.split("/")[1] ?? "").toLowerCase()];
    if (module && !on.has(module)) {
      res.status(404).json({ error: `${MODULE_LABELS[module]} is not enabled on this deployment` });
      return;
    }
    next();
  };
}

/** The enabled list createApp stored on the app (routes for /config and /overview). */
export function enabledModules(req: Request): readonly ModuleName[] {
  return req.app.locals.enabledModules as readonly ModuleName[];
}
