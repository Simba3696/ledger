# ADR-0006: Choose a deployment's sections with ENABLED_MODULES

**Status:** Accepted (2026-10-06)

## Context
The first real hosted deployment only needs expenses. Its owner may want Debts later, and other deployments may want a different subset. Showing tabs nobody uses clutters a phone-sized nav. A Dashboard full of zero Net Worth, Debt and EMI cards reads as real figures. Forking the code or keeping a build per subset would split one template into many.

## Decision
- The server reads `ENABLED_MODULES`, a comma-separated list of `expenses`, `finances`, `debts`, `emi`, `credit-cards` and `subscriptions`. It is case-insensitive and tolerates whitespace and duplicates. Unset or blank enables every module. An unknown name makes `createApp` throw at startup, and the error lists the valid names. Parsing lives in `server/src/modules.ts` (`parseEnabledModules`).
- The Dashboard, `GET /api/categories`, `GET /api/config` and `GET /api/overview` are always on.
- `GET /api/config` returns `{ modules }`, the enabled list in canonical order. It sits behind auth like every other route.
- Each other route belongs to one module, keyed by its first path segment (`ROUTE_MODULES`). One middleware (`requireEnabledModule`), mounted after auth and before the body parser, answers a disabled module's routes with 404 `{ error: "<Module> is not enabled on this deployment" }`. A test fails if a route is in neither the module map nor the always-on set.
- `dashboardOverview` reads only enabled modules' stores. A disabled module's figure is `null`. `netWorth` is `null` unless finances, debts, emi and credit-cards are all on. `emiFreeDate` is `null` without emi. Upcoming items come only from enabled sources: Salary from finances, EMI from emi, Credit Card from credit-cards, Subscription from subscriptions. With every module on, the response is unchanged.
- The client fetches `/api/config` at startup. It shows the Dashboard tab plus only the enabled tabs, renders only the Dashboard sections whose module is on, and never calls a disabled route. Expenses is now a nav tab, right after Dashboard.
- The setting changes only what is served. The schema is the same in every deployment, so turning a module on later needs only an env var change and a redeploy, with no migration.

## Alternatives considered
- **Client-only hiding (a `VITE_` variable):** cheaper, but the API would still serve and write every module, the overview would still query every table, and the setting would be baked in at build time, separately from the server's.
- **Per-module schema (create tables only for enabled modules):** turning a module on would then need a migration, and code would have to handle missing tables. Empty tables cost nothing.
- **Disabled figures as `0` instead of `null`:** a zero Net Worth or Total Debt looks like a real figure, and the client couldn't tell "none" from "not tracked".
- **Settings stored in the database, edited in the app:** that needs an admin UI and a settings table for a choice made once per deployment.

## Consequences
- A deployment can start small and grow without a code change or a data migration. Data a disabled module already holds stays in its tables, untouched, and comes back when the module is turned back on.
- A new route must be added to `ROUTE_MODULES` or `ALWAYS_ON_ROUTES`, or the API test fails.
- Finances still reads expense totals for its balance figures when the expenses module is off. That table is then empty or frozen, not hidden.
- With credit-cards off, an EMI paid through a card bill lists as its own Upcoming item. There is no card entry left to double-count it.
- `npm run test:e2e` runs a second pass with `ENABLED_MODULES=expenses` (`e2e/expensesOnly.ts`).
