import type { RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

// API authentication (LLD §6): every /api request carries the Supabase
// access token as `Authorization: Bearer <jwt>`. It is verified against the
// project's published signing keys (JWKS), then the email it names must be
// the single owner's. There are no other users and no roles (ADR-0002).

export interface AuthConfig {
  /** Skip verification entirely (local dev and tests only). */
  disabled: boolean;
  supabaseUrl?: string;
  ownerEmail?: string;
}

/** True when this process is a deployed function rather than a local
 * server. `NETLIFY` is set during Netlify builds but isn't guaranteed at
 * function runtime, so the AWS Lambda variables (always set inside the
 * function) are checked too. */
export function isDeployedRuntime(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NETLIFY || env.AWS_LAMBDA_FUNCTION_NAME || env.LAMBDA_TASK_ROOT);
}

/** Reads and validates the auth settings, throwing at startup rather than
 * at the first request: AUTH_DISABLED anywhere it could reach real data is
 * refused, and an enabled auth without SUPABASE_URL/OWNER_EMAIL could
 * never let anyone in. */
export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  if (env.AUTH_DISABLED === "true") {
    if (env.NODE_ENV === "production" || isDeployedRuntime(env)) {
      throw new Error(
        "AUTH_DISABLED=true is refused in production and on Netlify. It exists only for local development and tests.",
      );
    }
    return { disabled: true };
  }
  const supabaseUrl = env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const ownerEmail = env.OWNER_EMAIL?.trim();
  const missing = [!supabaseUrl && "SUPABASE_URL", !ownerEmail && "OWNER_EMAIL"].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `${missing.join(" and ")} must be set for API authentication (or AUTH_DISABLED=true for local development only). See server/.env.example.`,
    );
  }
  return { disabled: false, supabaseUrl, ownerEmail };
}

// createRemoteJWKSet fetches lazily and caches the keys (refetching on an
// unknown `kid`), so one instance per URL per process (or warm function
// instance) is all that's needed.
const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function remoteKeySet(supabaseUrl: string): JWTVerifyGetKey {
  let keySet = remoteKeySets.get(supabaseUrl);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));
    remoteKeySets.set(supabaseUrl, keySet);
  }
  return keySet;
}

// jose error codes that mean "this token is no good" (401). Anything else
// (the JWKS endpoint timing out or answering non-200) is a server-side
// problem and goes to the error handler as a 500, so a Supabase outage
// doesn't look like a sign-out.
const INVALID_TOKEN_CODES = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
]);

/** Express middleware enforcing the bearer token. `keySet` replaces the
 * project's remote JWKS; only tests pass it, to sign tokens with a local
 * key pair. */
export function requireOwner(config: AuthConfig, keySet?: JWTVerifyGetKey): RequestHandler {
  if (config.disabled) return (_req, _res, next) => next();

  const supabaseUrl = config.supabaseUrl!;
  const owner = config.ownerEmail!.toLowerCase();
  const issuer = `${supabaseUrl}/auth/v1`;
  const getKey = keySet ?? remoteKeySet(supabaseUrl);

  return async (req, res, next) => {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
    if (!match) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }
    let email: unknown;
    try {
      // requiredClaims: jose only checks `exp` when present, and a token
      // that never expires must never authorize this API.
      const { payload } = await jwtVerify(match[1], getKey, {
        issuer,
        audience: "authenticated",
        algorithms: ["ES256", "RS256", "EdDSA"],
        requiredClaims: ["exp", "sub", "email"],
      });
      email = payload.email;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code === "string" && INVALID_TOKEN_CODES.has(code)) {
        res.status(401).json({ error: "Your session has expired. Sign in again." });
        return;
      }
      next(err);
      return;
    }
    if (typeof email !== "string" || email.trim().toLowerCase() !== owner) {
      res.status(403).json({ error: "This account isn't allowed to use this app" });
      return;
    }
    next();
  };
}
