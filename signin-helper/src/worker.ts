// Ledger's sign-in helper (#10, ADR-0009): the one server-side piece of
// GitHub storage mode, and an optional one. GitHub's token endpoint
// (github.com/login/oauth/access_token) sends no CORS headers and wants the
// GitHub App's client secret, so a page can't call it. This handler adds the
// secret and passes the exchange through, nothing more:
//
//   POST /token    { code, code_verifier, redirect_uri }
//   POST /refresh  { refresh_token }
//
// Both answer { access_token, expires_in, expires_at, refresh_token,
// refresh_token_expires_in, refresh_token_expires_at }: the lifetimes in
// seconds as GitHub sent them, and the same as epoch ms on this helper's
// clock (null when GitHub sent none). The page uses the seconds, on its
// own clock. It keeps no state and logs nothing: no body, code, token or secret
// is ever written anywhere. A Web-standard fetch handler with no
// dependencies: Cloudflare Workers is the documented host (README.md), and
// any runtime that takes a (Request) => Response can run it.

export interface Env {
  GITHUB_APP_CLIENT_ID?: string;
  /** A Workers secret (`npx wrangler secret put`), never in wrangler.toml. */
  GITHUB_APP_CLIENT_SECRET?: string;
  /** Comma-separated origins allowed to call this helper, for example
   * https://<owner>.github.io. Never "*". */
  ALLOWED_ORIGINS?: string;
}

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const MAX_BODY_BYTES = 4096;
/** GitHub's OAuth error codes are snake_case words; anything else is
 * reported as a generic one rather than echoed. */
const OAUTH_ERROR = /^[a-z][a-z0-9_]{0,63}$/;

interface Settings {
  clientId: string;
  clientSecret: string;
  origins: Set<string>;
}

/** ALLOWED_ORIGINS as origins (scheme, host and port: a path or trailing
 * slash is dropped). "*", "null" and anything that isn't a URL never
 * match. */
function originsOf(env: Env): Set<string> {
  const origins = new Set<string>();
  for (const entry of (env.ALLOWED_ORIGINS ?? "").split(",")) {
    let origin: string;
    try {
      origin = new URL(entry.trim()).origin;
    } catch {
      continue;
    }
    if (origin !== "null") origins.add(origin);
  }
  return origins;
}

function settingsOf(env: Env, origins: Set<string>): Settings | null {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim() ?? "";
  if (clientId === "" || clientSecret === "" || origins.size === 0) return null;
  return { clientId, clientSecret, origins };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

/** The CORS headers for an allowed origin: that origin, never "*". */
function cors(origin: string): Record<string, string> {
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

/** The body as text, or null when it is over the cap. Read in chunks, so
 * an oversized body is never buffered whole. */
async function readCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The named fields, each a non-empty string, or null. */
function fields<K extends string>(text: string, names: readonly K[]): Record<K, string> | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const out = {} as Record<K, string>;
  for (const name of names) {
    const value = (body as Record<string, unknown>)[name];
    if (typeof value !== "string" || value === "") return null;
    out[name] = value;
  }
  return out;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** A lifetime GitHub sent, in seconds, or null. */
function lifetime(seconds: unknown): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Epoch ms `seconds` from now, or null when GitHub sent no lifetime. */
function expiry(seconds: number | null, now: number): number | null {
  return seconds === null ? null : now + seconds * 1000;
}

/** One call to GitHub's token endpoint, mapped to this helper's answer. */
async function exchange(params: Record<string, string>, secret: string, headers: Record<string, string>): Promise<Response> {
  let reply: unknown;
  try {
    const res = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    reply = await res.json();
  } catch {
    return json(502, { error: "upstream_unavailable" }, headers);
  }
  if (typeof reply !== "object" || reply === null) return json(502, { error: "upstream_unavailable" }, headers);
  const answer = reply as Record<string, unknown>;
  if (answer.error !== undefined) {
    // Only the code: GitHub's error_description and error_uri are not passed on.
    const code = typeof answer.error === "string" && OAUTH_ERROR.test(answer.error) && !answer.error.includes(secret) ? answer.error : "oauth_error";
    return json(400, { error: code }, headers);
  }
  if (typeof answer.access_token !== "string" || answer.access_token === "") return json(502, { error: "upstream_unavailable" }, headers);
  const now = Date.now();
  const expiresIn = lifetime(answer.expires_in);
  const refreshExpiresIn = lifetime(answer.refresh_token_expires_in);
  return json(
    200,
    {
      access_token: answer.access_token,
      expires_in: expiresIn,
      expires_at: expiry(expiresIn, now),
      refresh_token: typeof answer.refresh_token === "string" && answer.refresh_token !== "" ? answer.refresh_token : null,
      refresh_token_expires_in: refreshExpiresIn,
      refresh_token_expires_at: expiry(refreshExpiresIn, now),
    },
    headers,
  );
}

async function handle(request: Request, env: Env): Promise<Response> {
  const origins = originsOf(env);
  const origin = request.headers.get("Origin");
  const allowed = origin !== null && origins.has(origin);
  // Only an allowed origin may read any answer, errors included, so its
  // page can tell a misconfigured helper from one it can't reach.
  const headers = allowed ? cors(origin) : {};
  const settings = settingsOf(env, origins);
  if (!settings) return json(500, { error: "helper_not_configured" }, headers);
  if (request.method !== "POST" && request.method !== "OPTIONS") return json(405, { error: "method_not_allowed" }, { Allow: "POST, OPTIONS", ...headers });
  if (!allowed) return json(403, { error: "origin_not_allowed" });

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...headers,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
        "Cache-Control": "no-store",
      },
    });
  }

  const path = new URL(request.url).pathname;
  if (path !== "/token" && path !== "/refresh") return json(404, { error: "not_found" }, headers);
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) return json(400, { error: "invalid_request" }, headers);
  const text = await readCapped(request);
  if (text === null) return json(413, { error: "request_too_large" }, headers);

  const client = { client_id: settings.clientId, client_secret: settings.clientSecret };
  if (path === "/token") {
    const body = fields(text, ["code", "code_verifier", "redirect_uri"] as const);
    if (!body) return json(400, { error: "invalid_request" }, headers);
    const redirectOrigin = originOf(body.redirect_uri);
    if (redirectOrigin === null || !settings.origins.has(redirectOrigin)) return json(400, { error: "invalid_redirect_uri" }, headers);
    return exchange({ ...client, code: body.code, redirect_uri: body.redirect_uri, code_verifier: body.code_verifier }, settings.clientSecret, headers);
  }
  const body = fields(text, ["refresh_token"] as const);
  if (!body) return json(400, { error: "invalid_request" }, headers);
  return exchange({ ...client, grant_type: "refresh_token", refresh_token: body.refresh_token }, settings.clientSecret, headers);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
