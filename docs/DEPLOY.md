# Deploying your own copy (Netlify + Supabase)

This guide stands up one private copy of Ledger on the free tiers of
[Netlify](https://www.netlify.com) (website and API) and
[Supabase](https://supabase.com) (database and sign-in). It assumes no
prior experience with either. Plan on about an hour the first time.

Each copy has **one user**, its owner, and starts with **no data**: there is
no import step. The example throughout is an expenses-only copy for a
family member, but every step is the same for a full copy. Only
`ENABLED_MODULES` changes ([step 7](#7-set-the-environment-variables)).

How the pieces fit together is in the [HLD](architecture/HLD.md). The exact
settings the code reads are in [LLD §9](architecture/LLD.md#9-configuration).

- [What you need](#what-you-need)
- [1. Create the Supabase project](#1-create-the-supabase-project)
- [2. Turn off public sign-ups](#2-turn-off-public-sign-ups)
- [3. Check the project signs tokens with an asymmetric key](#3-check-the-project-signs-tokens-with-an-asymmetric-key)
- [4. Create the database tables](#4-create-the-database-tables)
- [5. Create the owner's account](#5-create-the-owners-account)
- [6. Collect the connection details](#6-collect-the-connection-details)
- [7. Set the environment variables](#7-set-the-environment-variables)
- [8. Create the Netlify site and deploy](#8-create-the-netlify-site-and-deploy)
- [9. First sign-in](#9-first-sign-in)
- [Turning on another section later](#turning-on-another-section-later)
- [Updating to a newer version](#updating-to-a-newer-version)
- [Free-tier pausing](#free-tier-pausing)
- [Backups](#backups)
- [Troubleshooting](#troubleshooting)

## What you need

- A **GitHub** account that can see this repository (your fork, or the
  original if it's yours). Netlify deploys straight from it.
- A **Netlify** account and a **Supabase** account. Signing in to both with
  GitHub is simplest. The free plans are enough for one person.
- On your own computer: [Node.js](https://nodejs.org) 22 or newer and
  [git](https://git-scm.com), and a clone of the repository:

  ```
  git clone <your repository URL>
  cd ledger
  ```

  The Supabase commands below run through `npx supabase`. The first time,
  `npx` asks to download the Supabase CLI: answer yes. Docker is **not**
  needed for anything in this guide except the optional `db dump` backup.
- The **email address** the owner will sign in with, and a password for
  them.
- The owner's **time zone** as an [IANA name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)
  (for example `Asia/Kolkata`, `Europe/London`, `America/New_York`).

Keep a scratch note open while you work. Steps 1 to 6 produce a handful of
values (a project URL, a key, a password, a connection string) that step 7
needs.

## 1. Create the Supabase project

1. In the [Supabase dashboard](https://supabase.com/dashboard), click
   **New project**. Create an organization first if it asks (the free plan
   is fine).
2. **Name:** anything, for example `ledger-alex`.
3. **Database password:** click **Generate a password**, or type your own.
   Copy it into your note now: you need it twice later, and Supabase never
   shows it again. A password of only letters and digits saves you from
   having to escape it in step 6. (If you lose it: **Project Settings →
   Database → Reset database password**.)
4. **Region:** pick **East US (Ohio)** (`us-east-2`), or **East US (North
   Virginia)** (`us-east-1`), even if the owner lives elsewhere. It can't be
   changed later. What matters is the distance to the API, not to the
   owner: on Netlify's free plan the API function always runs in the US
   (`us-east-2`), so the owner's requests travel there wherever the
   database is, and the function then makes many trips to the database for
   each one (a write is about eight). A database next to the function makes
   those trips nearly free; one on another continent adds a fifth of a
   second or more to each, and every screen takes seconds to load. (On a
   paid Netlify plan you can move the function's region instead, under
   the project's **Functions** settings (functions region), and then
   put both close to the owner.)
5. Click **Create new project** and wait a minute or two while it starts.
6. Note the **project ref**: the random string in the dashboard's URL
   (`https://supabase.com/dashboard/project/<project-ref>`). Your
   **project URL** is `https://<project-ref>.supabase.co`.

## 2. Turn off public sign-ups

The app has no sign-up screen, but Supabase's sign-in service would still
accept sign-ups sent straight to it. Turn them off so the only account is
the one you create in step 5.

1. Go to **Authentication → Sign In / Providers**. (Older dashboards call
   this **Authentication → Providers** or put it under **Auth settings**.)
2. Turn **off** "Allow new users to sign up" and save.
3. Leave the **Email** provider **enabled**: the owner signs in with email
   and password.

## 3. Check the project signs tokens with an asymmetric key

When the owner signs in, Supabase hands the browser a signed token, and the
API checks that signature against the public keys the project publishes
(`server/src/auth.ts`, [LLD §6](architecture/LLD.md#6-authentication)). It
only accepts asymmetric keys (`ES256`, `RS256` or `EdDSA`). Projects
created recently use one by default. Older ones may still use the legacy
shared secret (`HS256`), which the API rejects.

**Check:** open this address in a browser (no key or sign-in needed):

```
https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json
```

- You see a `"keys"` list with at least one entry containing
  `"alg":"ES256"` (or `RS256`): you're done, go to step 4.
- You see `{"keys":[]}`: the project still uses the legacy secret. Go to
  **Project Settings → JWT Keys**, start using JWT signing keys (the
  dashboard offers to migrate the legacy secret), then **rotate** so the new
  asymmetric key is the one in use. Open the address again and check that a
  key is listed.

If you skip this on a legacy project, sign-in itself works, but every API
call immediately answers 401 and the app sends you back to the sign-in
screen with "Your session has expired. Sign in again."

## 4. Create the database tables

The tables are defined by the files in `supabase/migrations/`. Apply them
from your clone with the Supabase CLI:

```
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push
```

- `login` opens a browser to authorize the CLI with your Supabase account.
- `link` asks for the database password from step 1. It connects this clone
  to the project; nothing is changed yet.
- `db push` lists the migrations it will apply and asks to confirm. Answer
  yes. Run it again whenever you update to a newer version that adds a
  migration.

**Never add `--include-seed`.** `supabase/seed.sql` is for the local
development database only: it creates a test account with a password
published in this repository. A hosted project doesn't need it. The four
default expense categories (Food, Transportation, Rent, Other) are created
by the app itself the first time it loads, and every other table starts
empty.

To confirm, open **Table Editor** in the dashboard. You should see
`categories`, `expenses`, `month_locks`, `ledger_years`, `finance_months`,
`savings_balances`, `debts`, `emis`, `subscriptions` and `card_bills`, all
empty. Each one shows as "RLS enabled" with no policies. That's deliberate:
Supabase's built-in public data API can't read or write any of them, and
only this app's own API (which connects with the database password) can.

## 5. Create the owner's account

1. Go to **Authentication → Users → Add user → Create new user**.
2. Enter the owner's **email** and **password**.
3. Tick **Auto Confirm User**, so no confirmation email is involved.
4. Click **Create user**.

This email goes into `OWNER_EMAIL` in step 7. Any other account is refused
by the API, even if one somehow existed.

There's no "forgot password" in the app. To change the owner's password
later, use the user's menu in **Authentication → Users**, or delete the
user and create it again with the same email and a new password. Nothing in
the database is tied to the account itself, only to its email address, so
recreating it loses nothing.

## 6. Collect the connection details

**`DATABASE_URL`** (the API's database connection):

1. Click **Connect** at the top of the project dashboard.
2. Under **Connection String**, choose **Transaction pooler**. Its port is
   **6543**. Don't use "Direct connection" (port 5432 on `db.<project-ref>.supabase.co`):
   it's IPv6-only on the free plan, and Netlify's functions can't reach it.
3. Copy the URI. It looks like:

   ```
   postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```

4. Replace `[YOUR-PASSWORD]`, brackets included, with the database password
   from step 1. If the password contains characters other than letters and
   digits, percent-encode them (`@` → `%40`, `#` → `%23`, `/` → `%2F`,
   `:` → `%3A`, `%` → `%25`), or reset it to one that doesn't.

**Project URL and public key** (for sign-in): under **Project Settings →
API Keys** (older dashboards: **Project Settings → API**):

- The **project URL** is `https://<project-ref>.supabase.co`.
- The **public key** is the **publishable** key (`sb_publishable_...`) or,
  on the legacy keys tab, the **anon / public** key. Either works. It's
  meant to be public: it ends up in the website's JavaScript, and the
  database's row-level security makes it useless for reading data.

Never use the **secret** or **service_role** key anywhere in this app.

**Optional check that sign-ups are refused** (step 2). From a terminal, with
the project URL and public key filled in:

```
curl -X POST "https://<project-ref>.supabase.co/auth/v1/signup" -H "apikey: <public key>" -H "Content-Type: application/json" -d "{\"email\":\"stranger@example.com\",\"password\":\"not-the-owner-123\"}"
```

The answer must contain `signup_disabled`. If it instead returns a user,
sign-ups are still on: go back to step 2, then delete that `stranger@`
user under **Authentication → Users**.

## 7. Set the environment variables

These are all the settings a deployment needs. Nothing goes in the
repository: you enter them in Netlify (step 8). Names are exact and
case-sensitive.

| Variable | Example | Used | What it is |
|---|---|---|---|
| `DATABASE_URL` | `postgresql://postgres.abcd…:…@aws-0-us-east-2.pooler.supabase.com:6543/postgres` | runtime (API function) | The transaction-pooler URI from step 6, password filled in. Secret. |
| `SUPABASE_URL` | `https://abcd….supabase.co` | runtime | The project URL. The API fetches the signing keys from it and checks that tokens were issued by it. |
| `OWNER_EMAIL` | `alex@example.com` | runtime | The owner's email from step 5. Compared case-insensitively. |
| `APP_TIMEZONE` | `Asia/Kolkata` | runtime | The owner's IANA time zone. Decides which calendar day "today" is for due dates, renewals and reminders, since the function itself runs in UTC ([ADR-0005](adr/0005-explicit-app-timezone.md)). Defaults to `Asia/Kolkata` if unset. |
| `ENABLED_MODULES` | `expenses` | runtime | Which sections this copy shows: a comma-separated list of `expenses`, `finances`, `debts`, `emi`, `credit-cards`, `subscriptions`. Unset or blank shows all of them. The Dashboard is always on. An unknown name stops the API from starting ([ADR-0006](adr/0006-enabled-modules-per-deployment.md)). |
| `VITE_SUPABASE_URL` | `https://abcd….supabase.co` | **build time** (website) | The same project URL, built into the website for sign-in. |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_…` | **build time** | The public key from step 6. |

**Runtime** variables are read by the API function each time it starts, so
a new deploy picks up a changed value. **Build-time** (`VITE_*`) variables
are copied into the website's JavaScript when Netlify builds it, so changing
one needs a new build. A normal Netlify deploy always rebuilds, so in
practice "redeploy" covers both.

For the family member's expenses-only copy: `ENABLED_MODULES=expenses`, and
`APP_TIMEZONE` set to where they live.

Don't set these on Netlify:

- `AUTH_DISABLED`: switches sign-in checks off, for local development only.
  The API refuses to start if it's set to `true` on Netlify.
- `PORT`, `VITE_DEV_PORT`, `VITE_API_PROXY_TARGET`: local development only.
- `TZ`: the function's runtime reserves it. Use `APP_TIMEZONE`.
- `NODE_ENV`: leave it to Netlify. Setting it to `production` for the build
  would skip installing the tools the build needs.

## 8. Create the Netlify site and deploy

1. In Netlify, choose **Add new project → Import an existing project →
   GitHub**, authorize Netlify if asked, and pick the repository.
   The repository is an npm workspace (`server` and `client`), so Netlify
   may ask which project or package to deploy, or fill in a **Base
   directory** or **Package directory** such as `client`. Choose the
   **repository root**, and leave both directories **empty**: only then does
   the root `netlify.toml` (website, API function and redirects) apply.
2. **Branch to deploy:** the branch that contains `netlify.toml` and
   `supabase/migrations/` (the hosted edition): `main` once the
   `supabase-migration` branch has been merged into it, and
   `supabase-migration` until then. An older `main` is the Excel edition,
   with no `netlify.toml` and no function, so it would not deploy.
3. Leave the build settings as Netlify fills them in (apart from the base
   and package directory above, which must be empty). They come from the
   repository's `netlify.toml`: build command `npm ci && npm run build -w client`,
   publish directory `client/dist`, functions directory `netlify/functions`,
   Node 22.
4. Add the seven variables from step 7. If the import screen has an **Add
   environment variables** button, use it. Otherwise finish the import and
   add them under **Project configuration → Environment variables**. Leave
   each one's scope as **All scopes** (the `VITE_*` ones must be available
   to **Builds**, the others to **Functions**). Mark `DATABASE_URL` as a
   secret if offered.
5. Deploy. If the first deploy ran before the variables were in place, run
   another: **Deploys → Trigger deploy → Deploy project**
   (older UI: **Deploy site**).
6. When the deploy shows **Published**, open the site's address
   (`https://<site-name>.netlify.app`). You can rename the site under
   **Project configuration → General**, or add your own domain under
   **Domain management**.

Every later push to the deploy branch redeploys automatically.

## 9. First sign-in

1. Open the site. You see a sign-in form with the Ledger logo.
   - If it says "Sign-in isn't configured: set VITE_SUPABASE_URL and
     VITE_SUPABASE_ANON_KEY", the build didn't see those two variables. Check
     their names and scopes, then trigger a deploy.
2. Sign in with the owner's email and password from step 5.
3. An expenses-only copy shows two tabs, **Dashboard** and **Expenses**. The
   Dashboard has the yearly spending chart and no Net Worth or Upcoming
   cards, since those come from sections that are off.
4. Open **Expenses**. On a brand-new copy it shows "No workbook found for
   year N" under the form. That's expected (the wording dates from the
   Excel edition) and goes away once the year has its first expense. Add a
   test expense, check it appears on the Dashboard chart, then delete it.
5. On a phone, the browser's **Add to Home Screen** gives it an app icon.
   The session is remembered on each device until you tap the sign-out
   button in the header.

The categories (Food, Transportation, Rent, Other) are created on that
first load. To rename, recolor, add or remove them, edit the `categories`
table in Supabase's **Table Editor**. See
[Configuring categories](../README.md#configuring-categories) for what each
column means.

## Turning on another section later

1. In Netlify, edit `ENABLED_MODULES` under **Project configuration →
   Environment variables**, for example from `expenses` to `expenses,debts`.
2. **Deploys → Trigger deploy → Deploy project.** Environment variable
   changes only reach the function on a new deploy.
3. Reload the app. The new tab appears.

No code change and no database step is needed. Every table already exists,
and the website asks the API which sections are on (`GET /api/config`) each
time it loads, so the setting lives only on the server. (The deploy does
rebuild the website as well. That's just how Netlify deploys, not something
this setting needs.) Turning a section off again hides it but keeps its
data, which reappears if you turn it back on.

## Updating to a newer version

Pushing (or merging) a newer version to the deploy branch redeploys the site
automatically. If the update adds files under `supabase/migrations/`, apply
them from an up-to-date clone **before** the new version goes live:

```
git pull
npx supabase db push
```

`db push` only applies migrations the project doesn't have yet.

## Free-tier pausing

Supabase pauses a free-plan project after about a week without activity and
emails the account owner. A paused project keeps all its data, but the app
can't sign in or load anything until it's restored: sign-in fails, or the
API answers 500.

- **To unpause:** open the project in the Supabase dashboard and click
  **Restore project**. It takes a few minutes. Nothing needs redeploying.
  Supabase only keeps a paused free project restorable for a limited time
  (90 days at the time of writing), so don't leave it paused indefinitely.
- **To avoid it:** use the app at least once a week. Simply opening it
  signs in and queries the database. A ping from outside without signing in
  isn't enough: the API refuses it before it reaches the database.
- **To rule it out:** upgrade that project to a paid plan.

## Backups

The free plan has no backups you can restore from. If the data matters, take
your own copy now and then. Either:

- **Table Editor CSV export (no tools needed):** open each table in the
  **Table Editor** and use its export option to download it as CSV. For an
  expenses-only copy, `expenses`, `month_locks`, `ledger_years` and
  `categories` hold everything.
- **A full SQL dump** from your linked clone. This uses Docker, so start
  Docker Desktop first:

  ```
  npx supabase db dump --linked --data-only --schema public -f ledger-backup.sql
  ```

  Or, with PostgreSQL's own `pg_dump` (at least the project's Postgres
  major version, shown under **Project Settings → Infrastructure**) and the
  **Session pooler** connection string from **Connect** (port 5432; `pg_dump`
  doesn't work through the transaction pooler):

  ```
  pg_dump "postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" --schema=public --data-only -f ledger-backup.sql
  ```

  To restore a data-only dump into a fresh project, create its tables with
  `db push` first (step 4), then run the file against it with `psql`.

The dump contains real financial data: keep it somewhere private and never
commit it.

## Troubleshooting

**Where the API's log is:** in Netlify, **Logs → Functions → api** (older
UI: **Functions → api**). Each request is one line,
`<METHOD> <path> <status> <ms>ms`. An unexpected error is printed with its
stack or, for a database error, its code and (for connection and schema
problems) its message. Request bodies, amounts and tokens are never logged
([LLD §11](architecture/LLD.md#11-error-handling-and-logging)). A setting
that stops the API from starting (below) appears there as an error at
startup.

| Symptom | Likely cause and fix |
|---|---|
| "Sign-in isn't configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY" | The website was built without them. Check the names, that their scope includes Builds, then trigger a deploy. |
| "Invalid login credentials" | Wrong email or password, or the user isn't in **Authentication → Users**. Re-create it (step 5). |
| Signs in, then straight back to sign-in with "Your session has expired. Sign in again." (a **401** in the function log) | The API rejected the token. Most often the project still signs with the legacy `HS256` secret (step 3), or `SUPABASE_URL` doesn't exactly match the project in `VITE_SUPABASE_URL` (a different project, or `http` instead of `https`). A real expiry after a long idle period is normal: sign in again. |
| "This account is not allowed on this deployment." (a **403** on `/api/config`) | The signed-in email isn't `OWNER_EMAIL`. Check for a typo in either. Case and surrounding spaces don't matter. |
| A **403** when adding or editing an expense | That month is locked. Unlock it from the banner above the form. |
| A **404** "… is not enabled on this deployment" | That section is off in `ENABLED_MODULES`. |
| Every API call fails right after a deploy: the browser's network tab shows a **502** (or "Function invocation failed") with no JSON body, so the app shows a generic error or keeps loading. The function log shows "SUPABASE_URL and OWNER_EMAIL must be set…", "Unknown module in ENABLED_MODULES…" or "AUTH_DISABLED=true is refused…" | A missing or mistyped runtime variable stops the API at startup. Fix the variable and trigger a deploy. |
| **500** "Internal server error", log shows `DATABASE_URL is not set` | Add `DATABASE_URL` (scope must include Functions) and redeploy. |
| **500**, log shows a timeout, `ENOTFOUND`, `ENETUNREACH`, "Tenant or user not found" or "password authentication failed" | `DATABASE_URL` is wrong. Use the **Transaction pooler** string on port **6543**, not the direct connection (`db.<project-ref>.supabase.co`, IPv6-only). Check the user part is `postgres.<project-ref>`, the password has no leftover `[ ]` and is percent-encoded. Also check the project isn't paused. |
| **500**, log shows `RangeError: Invalid time zone specified` | `APP_TIMEZONE` isn't a valid IANA name. Use the exact spelling from the tz database list, for example `Asia/Kolkata`. |
| **500**, and it isn't any of the above | Read the full error in the function log. If it mentions the signing keys (`jwks.json`), Supabase Auth was unreachable; try again shortly. |
| Due dates, renewals or the "today" month are a day off around midnight | `APP_TIMEZONE` is unset or set to another zone. It defaults to `Asia/Kolkata`, not the owner's location. |
| Sign-in fails or the app spins forever after a quiet week | The Supabase project is paused. See [Free-tier pausing](#free-tier-pausing). |
