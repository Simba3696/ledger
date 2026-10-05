# ADR-0004: Keep the Express API, deployed as one Netlify Function with server-side SQL

**Status:** Accepted (2026-10-05)

## Context
With Supabase in place, the client could call the database directly with `supabase-js`, with Row Level Security as the guard. Or the existing Express routes could keep sitting between client and database.

## Decision
Keep `routes.ts` and the server-side calculations. Wrap the Express app with `serverless-http` as **one** Netlify Function (`api`). The function talks to Postgres with `postgres.js` through Supabase's transaction pooler. The client only ever calls `/api/*`, with the same request and response shapes as the Excel edition.

## Alternatives considered
- **Client-direct `supabase-js` + RLS:** every calculation (EMI balances and due dates, overview aggregation, finance summaries since 2018) would have to move into the browser or into Postgres functions. Multi-step writes (reordering, replacing a month's card bills) would need to become database functions to stay atomic. The existing server tests, the parity contract for the port, would no longer apply. Rejected.
- **One function per route:** 30 functions with duplicated bootstrap code and more cold starts. No benefit at one owner's traffic.

## Consequences
- The client and the e2e suite need no API changes beyond the auth header.
- Server-side SQL gets real transactions (`sql.begin`) for multi-step writes.
- Serverless connection handling: `prepare: false` (required by the transaction pooler) and `max: 1` per instance.
- The Data API is unused. Every table has RLS enabled with no policies, so it exposes nothing.
