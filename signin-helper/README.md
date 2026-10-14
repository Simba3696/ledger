# Ledger sign-in helper

An optional, tiny token-exchange service that lets GitHub storage mode offer
a **Sign in with GitHub** button, as a shortcut past pasting a fine-grained
token. Without it, Ledger works exactly the same, with token paste only.

Why it exists ([ADR-0009](../docs/adr/0009-github-signin-helper.md)): the
button uses a GitHub App, and GitHub's token endpoint
(`https://github.com/login/oauth/access_token`) needs the App's client
secret and sends no CORS headers, so a web page can't call it. This helper
holds the secret and passes the exchange through. It stores nothing and
logs nothing.

- `POST /token` with `{ code, code_verifier, redirect_uri }` exchanges a
  sign-in code (PKCE, S256).
- `POST /refresh` with `{ refresh_token }` renews an expired access token.
- Both answer `{ access_token, expires_at, refresh_token,
  refresh_token_expires_at }`, times in epoch milliseconds.
- Only origins in `ALLOWED_ORIGINS` may call it (403 otherwise), and a
  `redirect_uri` must be on one of them.

The steps below use placeholder names: replace `<owner>` with the GitHub
account or organization that serves Ledger's Pages site and `<repo>` with
that repository's name.

## 1. Register the GitHub App

On github.com: **Settings → Developer settings → GitHub Apps → New GitHub
App** (for an organization: the organization's **Settings → Developer
settings → GitHub Apps**).

- **GitHub App name:** anything, for example `Ledger for <owner>`. Its URL
  name (the *slug*, shown in the App's public link
  `https://github.com/apps/<slug>`) is needed later.
- **Homepage URL:** the Pages site, for example `https://<owner>.github.io/<repo>/`.
- **Callback URL:** the Pages site's base URL, exactly as people open it,
  for example `https://<owner>.github.io/<repo>/`. A fork serving its own
  copy adds its own callback URL here (or registers its own App).
  Ledger sends the page's own address as the `redirect_uri`, with a
  trailing `index.html` taken off, and GitHub accepts only a registered
  callback URL or a path under it. So register the directory, with its
  trailing slash (`/<repo>/`, not `/<repo>` or `/<repo>/index.html`), and
  the scheme and host exactly as served (a custom domain is its own
  callback URL).
- **Expire user authorization tokens:** leave it **on** (GitHub's default).
  Access tokens then last 8 hours and come with a refresh token, which
  Ledger renews through `/refresh`.
- **Request user authorization (OAuth) during installation:** **on**, so
  installing the App and signing in is one trip.
- **Enable Device Flow:** off.
- **Webhook:** untick **Active**. The App needs no webhook.
- **Permissions:** under **Repository permissions**, set **Contents** to
  **Read and write**. **Metadata: Read-only** is added by GitHub and is
  mandatory. Leave every other repository permission, and every
  organization and account permission, at **No access**.
- **Where can this GitHub App be installed?** **Any account**, so a
  household can install it on its free organization.

Create it, then on the App's page:

1. Note the **Client ID** (it starts with `Iv`).
2. **Generate a new client secret** and copy it now: GitHub shows it once.
   Treat it like a password.
3. Note the slug from the App's public link.

Each person (or a household's organization owner, once for the data
repository) installs the App from `https://github.com/apps/<slug>`,
choosing **Only select repositories** and the `ledger-data` repository.
Ledger shows that link itself when the App can't reach the repository yet.

## 2. Deploy the helper to Cloudflare Workers

You need a free Cloudflare account and Node 22. From this folder
(`signin-helper/`):

```bash
npx wrangler login
npx wrangler deploy
npx wrangler secret put GITHUB_APP_CLIENT_ID      # the Client ID
npx wrangler secret put GITHUB_APP_CLIENT_SECRET  # the client secret
npx wrangler secret put ALLOWED_ORIGINS           # https://<owner>.github.io
```

`ALLOWED_ORIGINS` is a comma-separated list of origins (scheme and host,
no path), never `*`. `wrangler deploy` prints the helper's URL, for example
`https://ledger-signin-helper.<your-subdomain>.workers.dev`. Until all three
settings are set, every request answers 500 `helper_not_configured`.

To try it locally, copy `.dev.vars.example` to `.dev.vars` (gitignored),
fill it in, and run `npx wrangler dev`.

The handler is a plain Web-standard `fetch(request, env)` with no
dependencies, so another runtime that takes a `(Request) => Response`
handler can run it, but only Workers is documented here. Never deploy it
under `netlify/functions/`: every Netlify site built from this repository
deploys that folder.

## 3. Turn the button on in the Pages build

In the repository that builds the Pages site: **Settings → Secrets and
variables → Actions → Variables** (variables, not secrets: all three are
public), add:

| Variable | Value |
|---|---|
| `VITE_GITHUB_APP_CLIENT_ID` | the App's Client ID |
| `VITE_GITHUB_APP_SLUG` | the App's slug |
| `VITE_GITHUB_SIGNIN_HELPER_URL` | the helper's URL from step 2 |

The next Pages build shows the button, and its Content-Security-Policy
allows the helper's origin. If any of the three is missing, the build has no
button and no helper URL, and token paste works as before.

## Revoking access

A person can revoke Ledger's sign-in at any time on github.com under
**Settings → Applications → Authorized GitHub Apps**
(`https://github.com/settings/apps/authorizations`), and remove the App
from a repository under **Settings → Applications → Installed GitHub
Apps**. Ledger then asks them to sign in again or paste a token.

## Tests

`npm run test:helper` from the repository root runs the unit tests (GitHub
stubbed). `npm run typecheck -w signin-helper` and `npm run lint -w
signin-helper` check the code.
