// The whole API as one Netlify function (ADR-0004, LLD §7). Netlify bundles
// this file with esbuild from the repo root; esbuild resolves the server's
// `.js` import specifiers to their `.ts` sources. Typecheck with the
// server's TypeScript: `cd server && npx tsc -p ../netlify/tsconfig.json`.
import serverless from "serverless-http";
import { createApp } from "../../server/src/app.js";

// Built once per function instance, at cold start, so a bad auth
// configuration fails the deploy's first request loudly rather than
// silently letting requests through.
export const handler = serverless(createApp({ basePath: "/.netlify/functions/api" }));
