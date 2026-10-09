# ADR-0007: Add a serverless GitHub storage mode, built separately

**Status:** Accepted (2026-10-09)

## Context
Self-hosting today means following `docs/DEPLOY.md`: 9 steps, two accounts (Supabase and Netlify), a database password, SQL migrations, a hand-made owner account and 7 environment variables. That is too much for a non-technical person. Supabase's free tier also pauses a project after about 7 idle days ([ADR-0001](0001-host-on-netlify-and-supabase.md), Consequences). Existing Supabase deployments, including an expenses-only Netlify site that builds from `main` on every push, must not change.

## Decision
Add an opt-in **GitHub storage mode** as a third option alongside ADR-0001. It does not supersede ADR-0001, which stays in force for Supabase mode, and Supabase mode stays the default when no mode is set.
- **Audience and hosting:** non-technical people who only need a GitHub account. One shared GitHub Pages site serves everyone, and forks can still deploy their own copy.
- **Storage:** each household's data is one file, `ledger.json.enc`, in a **private repo** (default name `ledger-data`) that they own, read and written through the GitHub contents API. One person keeps the repo under their own account. A household keeps it in a free GitHub organization, and each member makes a fine-grained token whose resource owner is the org.
- **Always encrypted:** gzip, then AES-GCM-256 with a key derived from a passphrase (PBKDF2-SHA256, 600k iterations, random salt in the file header). The key is remembered per device as a non-extractable `CryptoKey` in IndexedDB, with a "Forget this device" option.
- **Connecting GitHub:** a guided paste of a fine-grained token limited to that one repo (Contents: read and write). A "Sign in with GitHub" button appears only when a sign-in helper is configured.
- **Build-time mode:** `vite build --mode github` defines `__LEDGER_STORAGE__ = "github"` (it is `"supabase"` in every other mode) and writes `client/dist-pages`. `client/src/main.tsx` reaches all GitHub, crypto and sync code through one dynamic `import()` of `startGithubStorage`, so the default bundle contains none of it. `scripts/check-storage-isolation.mjs` proves that on every pull request.
- **Settings:** enabled sections and the time zone (the browser's by default) live in the document. A fork can set build-time defaults. Categories are the 4 defaults, as today.
- **Browser storage:** localStorage and IndexedDB keys are prefixed `ledger:`.
- **Deploy:** `.github/workflows/pages.yml` builds `--mode github --base /<repo>/` and deploys to Pages. `docs/DEPLOY-github.md` documents it.

This answers ADR-0001's two objections to GitHub Pages: writes go to the GitHub contents API instead of a server, and the data is encrypted before it leaves the browser, so the public Pages site holds no data.

## Alternatives considered
- **A gist:** gists have no collaborators, so only the owner could edit a household's data.
- **Unencrypted JSON in a private repo:** the data would sit in plaintext on GitHub, readable by anyone the repo or a token is ever shared with.
- **A runtime mode switch in one bundle:** every Supabase deployment would ship GitHub, crypto and sync code it never runs, and its bundle would change.
- **OAuth sign-in as the only way to connect:** GitHub's token exchange needs a server-side helper, which is the server this mode exists to avoid, so it stays optional.

## Consequences
- Two storage paths must behave the same. A parity suite runs the store cases against both and holds them together.
- `*.github.io` project sites share one origin, so their localStorage and IndexedDB are shared. The `ledger:` prefix avoids clashes, and a custom domain is optional.
- The Pages deploy works only after the repo's Pages source is set to "GitHub Actions" in its settings.
- Each change that adds GitHub-mode code appends a string-literal sentinel to the isolation check's forbidden list.
