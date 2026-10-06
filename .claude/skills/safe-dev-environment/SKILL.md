---
name: safe-dev-environment
description: Rules and commands for running Ledger's dev server, tests, e2e, and screenshot scripts without killing another running checkout or touching real financial data. Use before starting any server, test run, or script in this repo.
---

# Safe dev environment

Everything here runs locally: the dev server, the local Supabase stack in Docker, and the test and screenshot scripts. None of it should reach a hosted deployment, real financial data, or a server started from a different checkout. If this machine has machine-specific rules (another checkout that must stay up, a real data folder), they live in the untracked `CLAUDE.local.md` at the repo root. Read it if it exists.

## Hard rules
1. **Ports:** a checkout with no overrides uses **4000** (server) and **5173** (Vite). If you run a second checkout of Ledger alongside another one (a clone, a branch or a `git worktree`), give it its own ports in the gitignored `server/.env` and `client/.env`, for example `PORT=4100`, `VITE_DEV_PORT=5273` and `VITE_API_PROXY_TARGET=http://localhost:4100`. `VITE_API_PROXY_TARGET` must match `PORT`. If it's missing, Vite's proxy silently defaults to :4000, so the client's writes go to the *other* checkout's server and its data.
2. **`scripts/kill-ports.js`** runs before `dev`, `start`, `stop`, `test:e2e` and `screenshots` and force-kills whatever is listening on the configured ports. With the `.env` overrides missing in a second checkout, it would kill the first checkout's server. Check them first:
   ```bash
   cat server/.env client/.env
   ```
3. **Data:** never point `DATABASE_URL` at real data or a hosted Supabase project. The only allowed target is the local stack: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. `npm run import-xlsx` in development only ever reads fixture folders built with `scripts/legacy-excel/fixtures.ts` in a temp directory, never a real Excel data folder.
   **Auth:** the server refuses to start unless `server/.env` sets either `AUTH_DISABLED=true` or both `SUPABASE_URL` and `OWNER_EMAIL` (LLD §6). Local dev and e2e use real auth against the local stack: `server/.env` has `SUPABASE_URL=http://127.0.0.1:54321` and `OWNER_EMAIL=owner@example.test`, and `client/.env` has `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (from `npx supabase status`). Sign in as `owner@example.test` / `local-owner-password` (created by `supabase/seed.sql`, local only). e2e refuses a non-local Supabase URL and `AUTH_DISABLED=true`.
4. **Never** run `npx supabase link`, `npx supabase db push` or a deploy. Those are owner actions against a hosted project (`docs/DEPLOY.md`).

## Local Supabase stack
```bash
npx supabase start     # first run pulls Docker images; prints URLs and keys
npx supabase status    # is it up? shows DB URL, API URL, anon key
npx supabase db reset  # re-apply migrations + seed.sql (wipes local data only)
npx supabase stop      # stop containers (data kept in the Docker volume)
```
Ports: API 54321, Postgres 54322, Studio 54323, Mailpit 54324. These are shared by every checkout on the machine, and so is the local database.

`npm test` shares this local database with `npm run dev` and **truncates tables**. After a test run, local dev data (including the seeded categories) is gone, so run `npx supabase db reset` to restore the seed. `server/test/dbHelpers.ts` refuses to run against any host but `127.0.0.1`/`localhost`.

## Verification commands
Run the server checks from `server/` so they use the server's own TypeScript (5.x). From the repo root, `npx tsc` resolves the client's hoisted TypeScript 6, which accepts code the server build rejects.
```bash
(cd client && npx tsc -b)
(cd server && npx tsc --noEmit)                              # src + test
(cd server && npx tsc -p tsconfig.build.json --noEmit)       # what `npm run build -w server` compiles
(cd server && npx tsc -p ../scripts/legacy-excel/tsconfig.json)  # the importer and its legacy Excel readers
(cd server && npx tsc -p ../netlify/tsconfig.json)           # the Netlify function (netlify/functions/api.ts)
npm test
npx playwright install chromium   # one time per machine, before the first e2e or screenshots run
npm run test:e2e        # uses the ports from the .env files
npm run screenshots     # every docs/screenshots/*.png; same isolation recipe, never a custom port setup
```

`kill-ports.js` and the e2e teardown use Windows' `netstat` and `taskkill`, so `npm run dev`/`stop`/`test:e2e`/`screenshots` are only supported on Windows.
