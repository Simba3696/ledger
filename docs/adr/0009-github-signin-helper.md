# ADR-0009: Offer Sign in with GitHub through one optional, stateless helper

**Status:** Accepted (2026-10-14). Adds to [ADR-0007](0007-serverless-github-storage-mode.md), which is unchanged.

## Context
GitHub storage mode ([ADR-0007](0007-serverless-github-storage-mode.md)) has no server: a person connects by pasting a fine-grained token limited to their one data repo. Making that token is the hardest step for a non-technical person. A GitHub App sign-in would skip it, but GitHub's token endpoint (`github.com/login/oauth/access_token`) needs the App's client secret and sends no CORS headers, so a static page can't exchange the code itself. ADR-0007 kept sign-in optional for exactly this reason. Existing Supabase deployments, including an expenses-only Netlify site that builds from `main` on every push, must not change.

## Decision
- **One helper, optional:** a new zero-dependency workspace, `signin-helper/`. It is one Web-standard `fetch(request, env)` handler, with Cloudflare Workers as the documented host, deployed by hand (`npx wrangler deploy`). `POST /token` exchanges a code with its PKCE verifier. `POST /refresh` renews an access token. It keeps no state and logs no body, code, token or secret.
- **Narrow by construction:** `Access-Control-Allow-Origin` echoes only origins in `ALLOWED_ORIGINS`, never `*`. Any other origin gets a 403. A `redirect_uri` must be on an allowed origin. Bodies are JSON and capped at 4 KB. Every response is `no-store`. GitHub's OAuth error passes through as its code only.
- **Kept away from Netlify and the server:** the helper lives outside `netlify/functions/`, so no Netlify site built from `main` deploys it. It lives outside `server/src`, so it has its own env-docs test and its own root script, `test:helper`. The root `npm test` stays server-only.
- **The flow:** GitHub App web flow with S256 PKCE and a 256-bit `state` kept in `sessionStorage` (`ledger:github-signin`). The callback is the page's own URL. The code and state are stripped with `history.replaceState` before the exchange. The App asks for Contents read and write only, plus the mandatory Metadata read. Expiring user tokens stay on, and "request user authorization during installation" is on.
- **One token path:** App tokens live in #6's `ledger:connection` record with `kind: "app"` and the refresh fields it already defines. `ledgerAccess.ts` gives a `kind: "app"` connection an App session as the token source and `onUnauthorized` handler of #6's contents client, so `contents.ts` is unchanged and owns the only retry. A token with under 5 minutes left is refreshed first. A 401 gets one refresh and one retry. A refresh GitHub refuses clears the tokens and asks to sign in again, keeping unsynced changes. A helper that can't be reached counts as offline and never signs anyone out.
- **Off unless configured:** the button appears only in a `--mode github` build given all three public settings: `VITE_GITHUB_APP_CLIENT_ID`, `VITE_GITHUB_APP_SLUG` and `VITE_GITHUB_SIGNIN_HELPER_URL`. CI passes them from Actions variables. Only then does the Pages CSP's `connect-src` list the helper's origin. Without all three, the build has no button and no helper URL. The default build's `client/dist` is byte-identical.

## Alternatives considered
- **No sign-in, token paste only:** this keeps zero servers, but leaves the hardest step in place for everyone. Paste stays the default, and sign-in is a shortcut.
- **GitHub's device flow:** it needs no secret, but GitHub's device endpoints also send no CORS headers, so it needs a proxy all the same. It also asks people to copy a code between tabs.
- **A Netlify Function:** every Netlify site built from `main` deploys `netlify/functions/`, including deployments that never use GitHub mode.
- **An OAuth App instead of a GitHub App:** its tokens reach every repository the person can reach. A GitHub App's token reaches only the repositories the App is installed on, and only with Contents permission.

## Consequences
- GitHub mode is no longer strictly serverless when sign-in is on. The helper holds one secret. It must be deployed and kept running by whoever serves the Pages site. If it is down, sign-in and refresh fail as offline, and token paste still works.
- The App's slug and client ID, the helper URL and `ALLOWED_ORIGINS` are per deployment. A fork either registers its own App and helper, or adds its own callback URL and origin to an existing one.
- The App is installed per repository. Onboarding checks `GET /user/installations` and shows an install link when the chosen repo isn't covered.
- Three string sentinels (`login/oauth`, `ledger:github-signin`, `user/installations`) join the isolation check's forbidden list for the default build.
- Revoking access is done on github.com (Settings, Applications), not in the app.
