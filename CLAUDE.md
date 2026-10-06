# Ledger: engineering guide (`main` edition)

Personal-finance web app: expenses, finances and savings, debts, EMIs, credit card bills, subscriptions, and a dashboard that combines them. React 19 + Vite client, Express + TypeScript server, Supabase Postgres and Auth, hosted on Netlify. One owner per deployment.

## Branches
- **`main`**: the generic, public, hosted edition: **Netlify + Supabase**, no Excel at runtime. It was built on the `supabase-migration` branch (HLD §7) and merged into `main`. See the [HLD](docs/architecture/HLD.md), [LLD](docs/architecture/LLD.md) and [ADRs](docs/adr/).
- **`personal`**: the owner's own local Excel edition. Port changes **only by `git cherry-pick`**, never `git merge` across `personal`/`main`. Only `server/src/domain/*` and `client/*` changes port cleanly. Storage code (`server/src/store/*` here, `server/src/excel/*` there) doesn't.

## Read before changing anything
| Need | Read |
|---|---|
| Why the system is shaped this way | `docs/architecture/HLD.md`, `docs/adr/` |
| Schema, module layout, transactions, API contract, auth, config | `docs/architecture/LLD.md` |
| Domain rules (what each figure means, conventions, gotchas), local setup, testing | `README.md` |
| Technical reference: module map, request lifecycle, design principles | `ARCHITECTURE.md` |
| Standing up a hosted copy: Supabase project, migrations, owner account, Netlify site, every env var, troubleshooting | `docs/DEPLOY.md` |
| Every environment variable the code reads | `server/.env.example`, `client/.env.example` (kept complete by `server/test/envDocs.test.ts`), LLD §9 |

## Non-negotiables
1. **Stay local and isolated.** Use only the local Supabase stack or a temporary directory, never real data or a hosted project. If another checkout of Ledger runs on this machine, give this one its own ports in `server/.env` and `client/.env` so `kill-ports.js` can't kill the other. See `.claude/skills/safe-dev-environment`, and `CLAUDE.local.md` (untracked) if it exists for this machine's own rules.
2. **API compatibility.** Request and response shapes stay byte-compatible with the Excel edition. `row` fields now carry database ids.
3. **Keep calculations pure** in `server/src/domain/`. SQL and I/O live in `server/src/store/`. "Today" comes from `todayInAppZone()` or an injected `today` parameter, never a bare `new Date()`.
4. **Schema changes only through new migrations** in `supabase/migrations/`. See `.claude/skills/supabase-migrations`.
5. **Verify before calling anything done.** Run client and server `tsc` (server checks from `server/`, so its own TypeScript runs, not the client's hoisted one; see `safe-dev-environment`), the full `npm test`, then `npm run test:e2e`, and report the real counts. Rerun once only for the two known e2e flakes.
6. **Commits:** small, one concern each, with a body explaining *why*. No `Co-Authored-By` trailer. Don't push without being asked.

## Agents (`.claude/agents/`)
| Agent | Use for |
|---|---|
| `software-architect` | Design questions, reviewing plans or diffs against the HLD/LLD, writing ADRs. Doesn't write app code. |
| `qa-verifier` | Independently running tsc, server tests and e2e in isolation and reporting real results. Read-only. |

## Skills (`.claude/skills/`)
| Skill | Use for |
|---|---|
| `safe-dev-environment` | Ports, data isolation, local Supabase commands |
| `supabase-migrations` | Schema change conventions and commands |
| `write-adr` | Recording a decision in `docs/adr/` |

## Store code conventions
- One module per concern in `server/src/store/`, mapping snake_case columns to the API's camelCase fields in one place (e.g. a `toEntry(row)` function). The `row` field and `:row` parameters are database ids.
- Validate with the shared helpers in `store/validate.ts` (`assertText`, `assertMoney`, `isRealDate`, `isPossibleId`) so the user gets a specific 400 before Postgres refuses. `dbErrors.ts` is only the backstop. Not found is a `LedgerError(..., 404)`.
- Every multi-statement write runs in `withTransaction` (`db/tx.ts`). Ordered lists use a contiguous 0-based `position`, renumbered inside the transaction (LLD §4.3).
- Store tests import `server/test/dbHelpers.ts` first (it refuses a non-local database) and empty the tables they touch with its `resetTables` before each test.
- A new table: a new migration with RLS on and no policies (`supabase-migrations` skill), LLD §2, and, if it references an imported table, `IMPORT_TABLES` in `scripts/legacy-excel/importer.ts` (LLD §8).

## Environment
- `server/.env` (gitignored): `PORT` (only to override the default 4000, e.g. `4100` for a second checkout), `DATABASE_URL` (local stack, `127.0.0.1:54322`), `SUPABASE_URL=http://127.0.0.1:54321`, `OWNER_EMAIL=owner@example.test`, optionally `APP_TIMEZONE` and `ENABLED_MODULES`. `AUTH_DISABLED=true` exists for local experiments only; e2e refuses it.
- `client/.env` (gitignored): `VITE_DEV_PORT` and `VITE_API_PROXY_TARGET` (only with a `PORT` override, e.g. `5273` and `http://localhost:4100`), `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (from `npx supabase status`).
- Local sign-in: `owner@example.test` / `local-owner-password` (created by `supabase/seed.sql`, local stack only).
- A new variable goes in the matching `.env.example` with a comment, LLD §9, and (if a deployment sets it) `docs/DEPLOY.md` step 7. `envDocs.test.ts` fails otherwise.
- Never point anything at a hosted Supabase project. `npx supabase link` / `db push` are owner actions (`docs/DEPLOY.md`).

## Commands
```bash
npm ci                 # install (one install at the root covers every workspace)
npx playwright install chromium   # one time per machine: the browser e2e and screenshots drive
npm run dev            # server :4000 + client :5173 (or the .env ports); kill-ports frees those ports first
npm test               # server vitest suite against the local Postgres (truncates local tables)
npm run test:e2e       # resets the local DB, then regression.ts + expensesOnly.ts on the .env ports
npm run screenshots    # regenerate every docs/screenshots/*.png from fictional data (same isolation)
npm run import-xlsx -- --from <folder> --dry-run   # one-time Excel import (LLD §8). In development: fixture folders and the local DB only, never a real data folder
npx supabase start     # local Postgres :54322, API :54321, Studio :54323, Mailpit :54324
npx supabase status    # local URLs and keys
npx supabase db reset  # re-apply migrations + seed to the LOCAL stack
npx supabase migration new <name>                       # new schema change (never edit an applied one)
(cd client && npx tsc -b)                               # client typecheck
(cd server && npx tsc --noEmit)                         # server src + test
(cd server && npx tsc -p tsconfig.build.json --noEmit)  # what the server build compiles
(cd server && npx tsc -p ../netlify/tsconfig.json)      # the Netlify function
(cd server && npx tsc -p ../scripts/legacy-excel/tsconfig.json)  # the importer + legacy Excel readers
```
