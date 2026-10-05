# ADR-0003: Replace Excel storage on `main`; keep it on `personal`

**Status:** Accepted (2026-10-05)

## Context
Every storage module (expenses, debts, EMI, credit card bills, subscriptions, finances, categories) reads and writes `.xlsx` files directly with ExcelJS. The hosted edition needs a database. One option is to keep both behind a shared storage interface.

## Decision
On `main`, Postgres **replaces** Excel. There's no dual-backend storage layer. The `personal` branch stays the local Excel edition. A one-time import script (`scripts/import-xlsx.ts`) brings existing Excel history into Postgres.

## Alternatives considered
- **A storage interface with Excel and Postgres implementations:** every feature would need two backends, two sets of store tests, and parity checks between them. Excel-specific behaviour (fill colours as categories, sheet protection as locks, row numbers as ids) doesn't map cleanly onto a shared interface. Rejected: doubled cost for a second backend `main` doesn't need, since `personal` already covers the Excel use case.

## Consequences
- Simpler code on `main`: one storage implementation and one set of store tests.
- **Cherry-picking between branches narrows.** Pure calculation logic (`domain/*`) and client UI changes still port. Changes to storage code don't, and need re-implementing on the other branch by hand.
- On `main`, Excel stops being the live source of truth. An Excel export is planned so data can still be opened there.
