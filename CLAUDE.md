# Ledger: engineering guide (`main` edition)

Personal-finance web app: expenses, finances and savings, debts, EMIs, credit card bills, subscriptions, and a dashboard that combines them. React 19 + Vite client, Express + TypeScript server.

## Branches
- **`main`**: the generic, public edition. It's migrating from local Excel storage to **Netlify + Supabase** on the `supabase-migration` branch. See the [HLD](docs/architecture/HLD.md), [LLD](docs/architecture/LLD.md) and [ADRs](docs/adr/).
- **`personal`**: the owner's own edition (local Excel + Scheduled Task + Tailscale), in a separate checkout. Port changes **only by `git cherry-pick`**, never `git merge` across `personal`/`main`. After the migration, only `server/src/domain/*` and `client/*` changes port cleanly. Storage code doesn't.

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
1. **Never disturb the live app.** It runs on port 4000 from another checkout and uses real data. Use this worktree's ports 4100/5273 and only the local Supabase stack or a temporary directory. See `.claude/skills/safe-dev-environment`.
2. **API compatibility.** Request and response shapes stay byte-compatible with the Excel edition. `row` fields now carry database ids.
3. **Keep calculations pure** in `server/src/domain/`. SQL and I/O live in `server/src/store/`. "Today" comes from `todayInAppZone()` or an injected `today` parameter, never a bare `new Date()`.
4. **Schema changes only through new migrations** in `supabase/migrations/`. See `.claude/skills/supabase-migrations`.
5. **Verify before calling anything done.** Run client and server `tsc` (server checks from `server/`, so its own TypeScript runs, not the client's hoisted one; see `safe-dev-environment`), the full `npm test`, then `npm run test:e2e`, and report the real counts. Rerun once only for the two known e2e flakes.
6. **Commits:** small, one concern each, with a body explaining *why*. No `Co-Authored-By` trailer. Don't push without being asked.

## Agents (`.claude/agents/`)
| Agent | Use for |
|---|---|
| `software-architect` | Design questions, reviewing plans or diffs against the HLD/LLD, writing ADRs. Doesn't write app code. |
| `supabase-module-porter` | Porting one storage module from Excel to Postgres with test parity. |
| `qa-verifier` | Independently running tsc, server tests and e2e in isolation and reporting real results. Read-only. |

## Skills (`.claude/skills/`)
| Skill | Use for |
|---|---|
| `safe-dev-environment` | Ports, data isolation, local Supabase commands |
| `port-module-to-supabase` | Checklist for porting one module |
| `supabase-migrations` | Schema change conventions and commands |
| `write-adr` | Recording a decision in `docs/adr/` |

## Environment
- `server/.env` (gitignored): `PORT=4100`, `DATABASE_URL` (local stack, `127.0.0.1:54322`), `SUPABASE_URL=http://127.0.0.1:54321`, `OWNER_EMAIL=owner@example.test`, optionally `APP_TIMEZONE` and `ENABLED_MODULES`. `AUTH_DISABLED=true` exists for local experiments only; e2e refuses it.
- `client/.env` (gitignored): `VITE_DEV_PORT=5273`, `VITE_API_PROXY_TARGET=http://localhost:4100`, `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (from `npx supabase status`).
- Local sign-in: `owner@example.test` / `local-owner-password` (created by `supabase/seed.sql`, local stack only).
- A new variable goes in the matching `.env.example` with a comment, LLD §9, and (if a deployment sets it) `docs/DEPLOY.md` step 7. `envDocs.test.ts` fails otherwise.
- Never point anything at a hosted Supabase project. `npx supabase link` / `db push` are owner actions (`docs/DEPLOY.md`).

## Commands
```bash
npm run dev            # server :4100 + client :5273 (from .env); kill-ports frees those ports first
npm test               # server vitest suite against the local Postgres (truncates local tables)
npm run test:e2e       # resets the local DB, then regression.ts + expensesOnly.ts on 4100/5273
npm run screenshots    # regenerate docs/screenshots/dashboard{,-dark}.png (same isolation)
npm run import-xlsx -- --from <folder> --dry-run   # one-time Excel import (LLD §8). Here: fixture folders and the local DB only, never a real data folder
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
