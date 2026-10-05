# ADR-0001: Host the `main` edition on Netlify + Supabase

**Status:** Accepted (2026-10-05)

## Context
The Excel edition runs on one home PC and is reached over Tailscale. A multi-day home internet outage left it unreachable even though the PC and server were fine. The goal for `main` is reachability from anywhere, cheaply, for one owner.

## Decision
Serve the React client from Netlify's CDN, run the API as a Netlify Function, and store all data in a Supabase Postgres project with Supabase Auth for sign-in.

## Alternatives considered
- **GitHub Pages:** static only, so it can't run the API or persist writes. Pages sites are also public. Rejected.
- **Netlify + OneDrive (Microsoft Graph):** keeps Excel as the store, but every write becomes a whole-file download, edit and upload over the Graph API. The in-process `withFileLock` can't serialise writes across separate function invocations, which brings back the lost-update bug that lock was added to fix. It also needs OAuth token handling and risks Netlify's ~10 s function timeout on large workbooks. Rejected as fragile.
- **A small always-on VM:** keeps the Express server as-is, but adds OS maintenance, patching and a monthly cost. That's more operational work than one owner wants.

## Consequences
- Every storage module is rewritten for SQL ([ADR-0003](0003-replace-excel-storage-on-main.md)).
- Login becomes mandatory, because the app is on the public internet.
- Free-tier limits apply: Supabase pauses inactive projects after about 7 days, and the free tier has no point-in-time recovery.
