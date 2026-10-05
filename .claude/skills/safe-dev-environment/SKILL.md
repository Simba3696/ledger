---
name: safe-dev-environment
description: Rules and commands for running Ledger's dev server, tests, e2e, and screenshot scripts without touching the owner's live production app or real financial data. Use before starting any server, test run, or script in this repo.
---

# Safe dev environment

The owner's live app runs from a **different checkout** (`D:\codebase\personal\ledger`, branch `personal`) as a Windows Scheduled Task on **port 4000**, reading real Excel files in OneDrive. Nothing done in this worktree may touch it.

## Hard rules
1. **Ports:** this worktree runs on **4100** (server) and **5273** (Vite), set in the gitignored `server/.env` and `client/.env`. `client/.env` must also set `VITE_API_PROXY_TARGET=http://localhost:4100`. If it doesn't, Vite's proxy silently defaults to :4000, the live app. That exact mistake once wrote demo data into real files.
2. **`scripts/kill-ports.js`** runs before every `dev` and `start` and force-kills whatever is listening on the configured ports. With the `.env` files missing it would kill the live app. Check them first:
   ```bash
   cat server/.env client/.env
   ```
3. **Data:** never point `DATABASE_URL` at real data or a hosted Supabase project. The only allowed target is the local stack: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. (`LEDGER_DB_DIR` is no longer read by the server.)
4. **Never** run `Start-ScheduledTask`, `Stop-ScheduledTask`, or anything against port 4000 from this worktree.

## Local Supabase stack
```bash
npx supabase start     # first run pulls Docker images; prints URLs and keys
npx supabase status    # is it up? shows DB URL, API URL, anon key
npx supabase db reset  # re-apply migrations + seed.sql (wipes local data only)
npx supabase stop      # stop containers (data kept in the Docker volume)
```
Ports: API 54321, Postgres 54322, Studio 54323, Mailpit 54324. None collide with the live app.

`npm test` shares this local database with `npm run dev` and **truncates tables**. After a test run, local dev data (including the seeded categories) is gone, so run `npx supabase db reset` to restore the seed. `server/test/dbHelpers.ts` refuses to run against any host but `127.0.0.1`/`localhost`.

## Verification commands
Run the server checks from `server/` so they use the server's own TypeScript (5.x). From the repo root, `npx tsc` resolves the client's hoisted TypeScript 6, which accepts code the server build rejects.
```bash
(cd client && npx tsc -b)
(cd server && npx tsc --noEmit)                              # src + test
(cd server && npx tsc -p tsconfig.build.json --noEmit)       # what `npm run build -w server` compiles
(cd server && npx tsc -p ../scripts/legacy-excel/tsconfig.json)  # the importer's legacy Excel readers
npm test
npm run test:e2e        # uses 4100/5273 from the .env files
npm run screenshots     # same isolation recipe; never a custom port setup
```

## If something might have touched the live app
Check that it still answers and still has its real data:
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/categories
```
If it's down, tell the owner. Don't restart it from this worktree. Its rebuild-and-restart procedure belongs to the `personal` checkout.
