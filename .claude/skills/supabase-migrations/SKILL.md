---
name: supabase-migrations
description: Conventions and commands for changing Ledger's Postgres schema with Supabase CLI migrations — creating, applying locally, testing, and deploying. Use whenever a table, column, constraint, or index needs to change.
---

# Supabase migrations

`supabase/migrations/*.sql` is the only source of truth for the schema. The local stack, the test suite and every hosted deployment all apply the same files in the same order.

## Rules
1. **Never edit a migration that's already committed.** Add a new one that alters the schema. An already-deployed project would never re-run the edited file.
2. Each migration is one coherent change with a descriptive name: `npx supabase migration new add_emi_notes_column`.
3. Every new table gets `alter table … enable row level security;` with **no policies** (LLD §2). The API connects as the `postgres` role. The public Data API must expose nothing.
4. Constraints mirror API validation (positive amounts, months 1–12, due days 1–31), so bad data can't get in even through a bug.
5. Money is `numeric(14,2)` and calendar dates are `date`. Never `timestamptz` for a calendar day (ADR-0005).
6. Destructive changes (drop or rename a column) ship in two steps: add the new column and backfill it, release, then drop the old one in a later migration.

## Local workflow
```bash
npx supabase migration new <name>   # creates supabase/migrations/<timestamp>_<name>.sql
# edit the file
npx supabase db reset               # re-applies all migrations + seed.sql to the LOCAL stack only
npm test                            # store tests run against the reset schema
```

## Deploy to a hosted project (owner action)
```bash
npx supabase link --project-ref <ref>
npx supabase db push                # applies pending migrations
```
Never run `db push` or `link` from an automated agent session. Deploying is an owner decision ([docs/DEPLOY.md](../../../docs/DEPLOY.md), "Updating to a newer version").

## Review checklist
- [ ] RLS enabled on every new table
- [ ] Constraints match the API's validation
- [ ] Indexes on every column used in a `where` (most are `(year, month)`)
- [ ] A new table that references an imported one is added to `IMPORT_TABLES` in `scripts/legacy-excel/importer.ts`, or the importer's `--force` fails (LLD §8)
- [ ] LLD §2 updated with the net schema
- [ ] `db reset` + `npm test` pass from a clean stack
