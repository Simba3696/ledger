---
name: port-module-to-supabase
description: Step-by-step checklist for porting one Ledger storage module from Excel (server/src/excel) to Postgres (server/src/store) with behaviour parity, following docs/architecture/LLD.md. Use when migrating debts, subscriptions, emi, creditCardBills, finances, categories, ledger, or overview.
---

# Port one module to Supabase

Port order (simplest first): debts → subscriptions → emi → creditCardBills → finances → categories → ledger → overview. Do one module per commit.

## 0. Before starting
- Follow the `safe-dev-environment` skill and check `npx supabase status`.
- Run `npm test` and write down the current pass count. That's the parity baseline.
- Read `server/src/excel/<module>.ts`, `server/test/<module>.test.ts` and LLD §2, §3, §4.3 and §5 for this module.

## 1. Schema
- If LLD §2 has this module's tables but no migration exists yet, create one: `npx supabase migration new <module>_tables`, paste the DDL, then `npx supabase db reset`.
- Every table gets `enable row level security` with no policies.

## 2. Split calculations from storage
- Move pure functions (no `fs`, no ExcelJS, no SQL) into `server/src/domain/<module>Math.ts` **verbatim**. Re-export them from the old path if other unported modules still import them.
- Replace any bare `new Date()` used as "today" with an injected `today` parameter defaulting to `todayInAppZone()`.

## 3. Write `server/src/store/<module>.ts`
- Same exported names, parameters and return types as the Excel module.
- The `row` field and `:row` parameters carry the database `id`.
- Not found → `LedgerError("No <thing> at row <id>", 404)`. Validation → 400 with the same messages as before, since tests may match on them.
- Multi-statement writes go in `withTransaction`. Order-sensitive lists use `position` and are renumbered contiguously inside the transaction.
- Map snake_case columns to the existing camelCase fields in one place (a `toEntry(row)` function).

## 4. Port the tests
- Replace scratch-workbook setup with `truncate <tables> restart identity cascade` in `beforeEach`.
- Keep every `it(...)` name and every `expect(...)` unchanged. Anything that asserted on sheet row numbers now asserts on the returned `row` (id) values. Capture them from the add calls instead of hardcoding 2, 3, 4.
- Delete only the Excel-specific tests (backups, ExcelJS style detaching, sheet protection internals). Note each one deleted, and why, in the commit message.

## 5. Rewire
- Point `routes.ts`, and any modules that import this one, at `store/<module>.ts`.
- Delete `server/src/excel/<module>.ts` once nothing imports it. First copy its readers to `scripts/legacy-excel/` if the import script will need them (LLD §8).

## 6. Verify (use the `qa-verifier` agent or run these yourself)
```bash
npx tsc -p server/tsconfig.build.json --noEmit
npm test        # full suite: count must equal the baseline minus deliberately deleted Excel-only tests
```

## 7. Commit
Use `feat(store): port <module> to Postgres`. The body lists tests ported, tests deleted (and why), and any behaviour question resolved. Don't add a Co-Authored-By trailer.
