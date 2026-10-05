import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import type { JWTVerifyGetKey } from "jose";
import { isDeployedRuntime, readAuthConfig, requireOwner } from "./auth.js";
import { mapDatabaseError } from "./dbErrors.js";
import { LedgerError } from "./errors.js";
import { parseEnabledModules, requireEnabledModule } from "./modules.js";
import { router } from "./routes.js";

export interface AppOptions {
  /** Extra mount point for the API, besides `/api`. The Netlify function
   * passes its own path (`/.netlify/functions/api`): a direct call to the
   * function arrives under that prefix, while a request through the
   * `/api/*` redirect keeps its original `/api/...` path (LLD §7). */
  basePath?: string;
  /** Replaces the Supabase project's remote JWKS. Tests only. */
  authKeySet?: JWTVerifyGetKey;
  /** Where the one-line request log goes. Defaults to console.log. */
  log?: (line: string) => void;
}

/** Method, path, status and duration only (LLD §11). Never bodies, headers
 * (the bearer token) or query strings, so no amount or token reaches a log. */
function requestLogger(log: (line: string) => void): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    const path = req.originalUrl.split("?")[0];
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      log(`${req.method} ${path} ${res.statusCode} ${ms.toFixed(0)}ms`);
    });
    next();
  };
}

const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof LedgerError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // body-parser's own client errors (malformed JSON, oversized body) keep
  // Express's default response, as before this handler moved here from
  // routes.ts.
  if (err?.expose === true && typeof err.status === "number" && err.status < 500) {
    next(err);
    return;
  }
  const mapped = mapDatabaseError(err);
  if (mapped) {
    // Only the SQLSTATE and constraint name: Postgres's message and detail
    // for these codes echo the offending input (e.g. `Key (...)=(...)`), and
    // that input can be an amount from the request body (LLD §11).
    console.error(`Database refused the request: ${err.code}${err.constraint_name ? ` (${err.constraint_name})` : ""}`);
    res.status(mapped.status).json({ error: mapped.message });
    return;
  }
  console.error(describeUnexpectedError(err));
  res.status(500).json({ error: "Internal server error" });
};

// SQLSTATE classes whose message is about the connection, the server or the
// schema, never about a row: 08 connection, 28 authentication ("password
// authentication failed"), 3D unknown database, 42 a missing table or column
// (e.g. a migration not yet pushed), 53/54 resources and limits, 57/58
// operator intervention and system errors, XX internal (the pooler's "Tenant
// or user not found"). Any other class's message (22 data exception, 23
// constraint, P0 raise, ...) can quote the offending value.
const SAFE_MESSAGE_CLASSES = new Set(["08", "28", "3D", "42", "53", "54", "57", "58", "XX"]);

/** What the 500 path logs (LLD §11). A Postgres error is reduced to its
 * SQLSTATE, routine and the names of the constraint, table and column
 * involved, plus its message only for the classes above. Its `detail` and
 * `where` are never logged: they echo row values, amounts included. Any other
 * error keeps its stack, which is code locations, not data. */
function describeUnexpectedError(err: unknown): string {
  const e = err as Record<string, unknown> | null | undefined;
  if (e && typeof e.code === "string" && (e.name === "PostgresError" || typeof e.severity === "string")) {
    const names = (["constraint_name", "table_name", "column_name"] as const)
      .filter((key) => typeof e[key] === "string")
      .map((key) => `${key}=${e[key]}`);
    const parts = [`Database error ${e.code}`];
    if (typeof e.routine === "string") parts.push(`routine=${e.routine}`);
    parts.push(...names);
    if (SAFE_MESSAGE_CLASSES.has(e.code.slice(0, 2)) && typeof e.message === "string") parts.push(`message=${e.message}`);
    return parts.join(" ");
  }
  if (err instanceof Error) return err.stack ?? String(err);
  return String(err);
}

/** API responses carry financial figures: never let a browser or proxy keep
 * a copy (Express's ETag would otherwise make them cacheable). */
const noStore: RequestHandler = (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
};

/** Builds the API app shared by the local server (index.ts) and the Netlify
 * function (netlify/functions/api.ts). Throws on a bad auth configuration or
 * an unknown ENABLED_MODULES name, so a misconfigured deploy fails at startup
 * instead of per request. */
export function createApp({ basePath, authKeySet, log = console.log }: AppOptions = {}): Express {
  const auth = requireOwner(readAuthConfig(), authKeySet);
  const modules = parseEnabledModules(process.env.ENABLED_MODULES);
  const app = express();
  app.disable("x-powered-by");
  // Read by GET /api/config and GET /api/overview (modules.ts's enabledModules).
  app.locals.enabledModules = modules;
  // Express decides from its "env" setting whether its default error page
  // (used for body-parser's 400s) includes the stack trace. Netlify doesn't
  // set NODE_ENV=production at function runtime, so pin it here: a deployed
  // function must never send its bundle's paths and line numbers to a client.
  if (isDeployedRuntime(process.env)) app.set("env", "production");
  app.use(requestLogger(log));
  // Authentication runs before the body is parsed, so a request without a
  // valid token is a 401 whatever its body, and never costs a JSON parse.
  // A disabled module's routes are a 404 after authentication, so an
  // anonymous caller can't probe which sections a deployment has.
  const moduleGate = requireEnabledModule(modules);
  for (const mount of new Set(["/api", basePath ?? "/api"])) {
    app.use(mount, noStore, auth, moduleGate, express.json(), router);
  }
  app.use(errorHandler);
  return app;
}
