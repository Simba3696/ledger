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
| Domain rules (what each figure means, conventions, gotchas) | `README.md` |
| Excel-edition technical reference (storage sections superseded by the LLD) | `ARCHITECTURE.md` |

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

## Commands
```bash
npm run dev            # server :4100 + client :5273 (from .env)
npm test               # server vitest suite
npm run test:e2e       # full browser regression (isolated ports)
npm run screenshots    # regenerate docs/screenshots (isolated)
npx supabase start     # local Postgres :54322, API :54321, Studio :54323
npx supabase db reset  # re-apply migrations + seed to the LOCAL stack
(cd server && npx tsc -p ../netlify/tsconfig.json)  # typecheck the Netlify function
```
