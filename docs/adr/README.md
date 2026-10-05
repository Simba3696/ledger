# Architecture Decision Records

One short file per significant decision, numbered in order. Records are never rewritten after they're accepted. A later ADR supersedes an earlier one and says so in its Status line. Use the `write-adr` skill (`.claude/skills/write-adr`) for the template.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-host-on-netlify-and-supabase.md) | Host the `main` edition on Netlify + Supabase | Accepted |
| [0002](0002-self-host-single-owner.md) | Self-host template, single owner per deployment | Accepted |
| [0003](0003-replace-excel-storage-on-main.md) | Replace Excel storage on `main`; keep it on `personal` | Accepted |
| [0004](0004-express-as-single-netlify-function.md) | Keep Express, deploy as one Netlify Function with server-side SQL | Accepted |
| [0005](0005-explicit-app-timezone.md) | Compute "today" in an explicit application timezone | Accepted |
| [0006](0006-enabled-modules-per-deployment.md) | Choose a deployment's sections with `ENABLED_MODULES` | Accepted |
