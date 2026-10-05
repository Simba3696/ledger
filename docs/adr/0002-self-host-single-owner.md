# ADR-0002: Self-host template with a single owner per deployment

**Status:** Accepted (2026-10-05)

## Context
`main` is the generic, public edition of Ledger. A hosted version could either be one shared service that many people sign up to, or a template each person deploys for themselves.

## Decision
`main` is a **self-host template**. Each person forks it and deploys their own Netlify site and Supabase project. Each deployment has exactly one user, the owner, identified by `OWNER_EMAIL`.

## Alternatives considered
- **Multi-user hosted app:** needs a `user_id` on every table, per-user Row Level Security policies, sign-up, password reset and account deletion flows. It would also mean holding other people's financial data, with the security and privacy obligations that brings. Rejected as out of proportion for a personal-finance tool.

## Consequences
- No `user_id` columns. The schema mirrors one person's books.
- Authorisation is a single check: the token belongs to `OWNER_EMAIL`.
- Public sign-ups are disabled in the Supabase project.
- Moving to multi-user later would mean a schema migration (add `user_id`, backfill, add policies). That's acceptable since nobody has asked for it.
