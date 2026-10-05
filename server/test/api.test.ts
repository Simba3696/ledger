import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
// dbHelpers must load before any store module (it sets DATABASE_URL).
import { sql, resetTables, closeSql } from "./dbHelpers.js";
import request from "supertest";
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTVerifyGetKey } from "jose";
import { createApp } from "../src/app.js";
import { listDebts } from "../src/store/debts.js";

// API layer tests (LLD §10): authentication and error mapping on
// createApp(), plus the Netlify function's wiring. Tokens are signed with a
// key pair generated here and verified against an injected local JWKS, so
// nothing reaches a real (or the local) Supabase Auth.

// Lets one test make a store call fail with an arbitrary (non-Ledger) error;
// every other call goes to the real implementation.
vi.mock("../src/store/debts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/debts.js")>();
  return { ...actual, listDebts: vi.fn(actual.listDebts) };
});

const SUPABASE_URL = "https://example-project.supabase.test";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const OWNER = "owner@example.com";

let ownerKey: CryptoKey;
let strangerKey: CryptoKey;
let keySet: JWTVerifyGetKey;

beforeAll(async () => {
  const owner = await generateKeyPair("ES256");
  ownerKey = owner.privateKey;
  strangerKey = (await generateKeyPair("ES256")).privateKey;
  const jwk = { ...(await exportJWK(owner.publicKey)), kid: "test-key", alg: "ES256", use: "sig" };
  keySet = createLocalJWKSet({ keys: [jwk] });

  await resetTables("categories", "debts", "expenses", "month_locks", "ledger_years");
  await sql`insert into categories (id, label, bg, fg, position) values ('food', 'Food', '#FFFF00', '#3d3d00', 0)`;
});

afterAll(async () => {
  // Leave an empty table so the next reader re-creates the defaults.
  await resetTables("categories", "debts", "expenses", "month_locks", "ledger_years");
  await closeSql();
});

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("AUTH_DISABLED", undefined);
  vi.stubEnv("NETLIFY", undefined);
  vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", undefined);
  vi.stubEnv("LAMBDA_TASK_ROOT", undefined);
  vi.stubEnv("SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("OWNER_EMAIL", OWNER);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

interface TokenOptions {
  email?: string;
  iss?: string;
  aud?: string;
  key?: CryptoKey;
  kid?: string;
  /** null leaves the `exp` claim out. */
  expiresIn?: string | number | null;
}

function token({ email = OWNER, iss = ISSUER, aud = "authenticated", key, kid = "test-key", expiresIn = "1h" }: TokenOptions = {}) {
  const jwt = new SignJWT({ email, role: "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" })
    .setSubject("00000000-0000-4000-8000-000000000001")
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt();
  if (expiresIn !== null) jwt.setExpirationTime(expiresIn);
  return jwt.sign(key ?? ownerKey);
}

function app(log: (line: string) => void = () => {}) {
  return createApp({ authKeySet: keySet, log });
}

describe("authentication", () => {
  it("rejects a request with no token (401)", async () => {
    const res = await request(app()).get("/api/categories");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Sign in required" });
  });

  it("rejects a non-Bearer Authorization header (401)", async () => {
    const res = await request(app()).get("/api/categories").set("Authorization", `Basic ${btoa("a:b")}`);
    expect(res.status).toBe(401);
  });

  it("rejects a malformed token (401)", async () => {
    for (const garbage of ["garbage", "a.b.c", "eyJhbGciOiJFUzI1NiJ9.e30.AAAA"]) {
      const res = await request(app()).get("/api/categories").set("Authorization", `Bearer ${garbage}`);
      expect(res.status, garbage).toBe(401);
      expect(res.body).toEqual({ error: "Your session has expired. Sign in again." });
    }
  });

  it("rejects a token signed by a key that isn't in the JWKS (401)", async () => {
    const res = await request(app())
      .get("/api/categories")
      .set("Authorization", `Bearer ${await token({ key: strangerKey })}`);
    expect(res.status).toBe(401);
  });

  it("rejects a token whose kid isn't in the JWKS (401)", async () => {
    const res = await request(app())
      .get("/api/categories")
      .set("Authorization", `Bearer ${await token({ key: strangerKey, kid: "unknown-key" })}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Your session has expired. Sign in again." });
  });

  it("rejects a validly signed token with no exp claim (401)", async () => {
    const res = await request(app())
      .get("/api/categories")
      .set("Authorization", `Bearer ${await token({ expiresIn: null })}`);
    expect(res.status).toBe(401);
  });

  it("treats a JWKS fetch failure as a server error (500), not a sign-out", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: JWTVerifyGetKey = async () => {
      throw new errors.JWKSTimeout();
    };
    const res = await request(createApp({ authKeySet: failing, log: () => {} }))
      .get("/api/categories")
      .set("Authorization", `Bearer ${await token()}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(consoleError).toHaveBeenCalled();
  });

  it("rejects an expired token (401)", async () => {
    const expired = await token({ expiresIn: Math.floor(Date.now() / 1000) - 120 });
    const res = await request(app()).get("/api/categories").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it("rejects a token for the wrong audience (401)", async () => {
    const res = await request(app())
      .get("/api/categories")
      .set("Authorization", `Bearer ${await token({ aud: "anon" })}`);
    expect(res.status).toBe(401);
  });

  it("rejects a token from another issuer (401)", async () => {
    const res = await request(app())
      .get("/api/categories")
      .set("Authorization", `Bearer ${await token({ iss: "https://other-project.supabase.test/auth/v1" })}`);
    expect(res.status).toBe(401);
  });

  it("refuses a valid token for an account that isn't the owner (403)", async () => {
    const res = await request(app())
      .get("/api/categories")
      .set("Authorization", `Bearer ${await token({ email: "someone-else@example.com" })}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "This account isn't allowed to use this app" });
  });

  it("lets the owner through (200), matching the email case-insensitively", async () => {
    vi.stubEnv("OWNER_EMAIL", "  Owner@Example.COM ");
    const res = await request(app())
      .get("/api/categories")
      .set("Authorization", `Bearer ${await token({ email: "OWNER@example.com" })}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: "food", label: "Food", bg: "#FFFF00", fg: "#3d3d00" }]);
  });

  it("accepts a SUPABASE_URL with a trailing slash", async () => {
    vi.stubEnv("SUPABASE_URL", `${SUPABASE_URL}/`);
    const res = await request(app()).get("/api/categories").set("Authorization", `Bearer ${await token()}`);
    expect(res.status).toBe(200);
  });

  it("guards writes too, not just reads", async () => {
    const res = await request(app()).post("/api/debts").send({ name: "Alex", amount: 100 });
    expect(res.status).toBe(401);
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from debts`;
    expect(count).toBe(0);
  });

  it("checks the token before parsing the body: malformed JSON without a token is a 401", async () => {
    const res = await request(app())
      .post("/api/debts")
      .set("Content-Type", "application/json")
      .send("{bad");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Sign in required" });
    expect(res.text).not.toContain("at ");
  });
});

describe("auth configuration", () => {
  it("fails fast when SUPABASE_URL or OWNER_EMAIL is missing", () => {
    vi.stubEnv("SUPABASE_URL", undefined);
    expect(() => createApp()).toThrow(/SUPABASE_URL must be set/);
    vi.stubEnv("SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("OWNER_EMAIL", " ");
    expect(() => createApp()).toThrow(/OWNER_EMAIL must be set/);
  });

  it("AUTH_DISABLED=true skips authentication locally", async () => {
    vi.stubEnv("AUTH_DISABLED", "true");
    vi.stubEnv("SUPABASE_URL", undefined);
    vi.stubEnv("OWNER_EMAIL", undefined);
    const res = await request(createApp({ log: () => {} })).get("/api/categories");
    expect(res.status).toBe(200);
  });

  it("only the exact value AUTH_DISABLED=true disables it", async () => {
    vi.stubEnv("AUTH_DISABLED", "1");
    const res = await request(app()).get("/api/categories");
    expect(res.status).toBe(401);
  });

  it.each([
    ["NODE_ENV", "production"],
    ["NETLIFY", "true"],
    ["AWS_LAMBDA_FUNCTION_NAME", "ledger-api"],
    ["LAMBDA_TASK_ROOT", "/var/task"],
  ])("refuses AUTH_DISABLED=true when %s is set", (name, value) => {
    vi.stubEnv("AUTH_DISABLED", "true");
    vi.stubEnv(name, value);
    expect(() => createApp()).toThrow(/AUTH_DISABLED=true is refused/);
  });
});

describe("error mapping", () => {
  async function authed(path: string) {
    return request(app()).get(path).set("Authorization", `Bearer ${await token()}`);
  }

  it("turns a LedgerError into { error } with its status", async () => {
    const res = await authed("/api/months/2018/1");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No workbook found for year 2018" });
  });

  it("turns an unknown error into a generic 500 without leaking its message", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listDebts).mockRejectedValueOnce(new Error('relation "debts" secret detail'));
    const res = await authed("/api/debts");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(consoleError).toHaveBeenCalled();
  });

  it("logs only the SQLSTATE and constraint of a mapped database error, never its message or detail", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(listDebts).mockRejectedValueOnce(
      Object.assign(new Error('duplicate key value violates unique constraint "debts_name_key"'), {
        code: "23505",
        constraint_name: "debts_name_key",
        detail: "Key (name, amount)=(Car Loan, 12345.67) already exists.",
      }),
    );
    const res = await authed("/api/debts");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "That already exists" });
    const logged = consoleError.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("23505");
    expect(logged).not.toContain("12345");
    expect(logged).not.toContain("Car Loan");
  });

  it("answers an authenticated malformed-JSON body with a 400 that carries no stack trace when deployed", async () => {
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "ledger-api");
    const res = await request(app())
      .post("/api/debts")
      .set("Authorization", `Bearer ${await token()}`)
      .set("Content-Type", "application/json")
      .send("{bad");
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("SyntaxError");
    expect(res.text).not.toMatch(/\bat \S+ \(/);
  });
});

describe("request logging", () => {
  it("logs method, path, status and duration only: no token, query or body", async () => {
    const lines: string[] = [];
    const bearer = await token();
    await request(app((l) => lines.push(l)))
      .put("/api/debts/999?secret=1")
      .set("Authorization", `Bearer ${bearer}`)
      .send({ name: "Car Loan", amount: 12345.67 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^PUT \/api\/debts\/999 \d{3} \d+ms$/);
    expect(lines[0]).not.toContain(bearer);
    expect(lines[0]).not.toContain("12345");
    expect(lines[0]).not.toContain("secret");
  });
});

describe("mounting", () => {
  it("serves the API at basePath as well as /api", async () => {
    const withBase = createApp({ basePath: "/.netlify/functions/api", authKeySet: keySet, log: () => {} });
    const bearer = `Bearer ${await token()}`;
    expect((await request(withBase).get("/.netlify/functions/api/categories").set("Authorization", bearer)).status).toBe(200);
    expect((await request(withBase).get("/api/categories").set("Authorization", bearer)).status).toBe(200);
    expect((await request(withBase).get("/.netlify/functions/api/categories")).status).toBe(401);
  });
});

describe("Netlify function handler", () => {
  type LambdaResult = { statusCode: number; body: string };
  let handler: (event: object, context: object) => Promise<LambdaResult>;

  beforeAll(async () => {
    // The function builds its app at import time, from the environment.
    // AUTH_DISABLED is fine here: NODE_ENV is "test" and no Lambda variable
    // is set. A non-literal specifier keeps the server's tsc (NodeNext, ESM)
    // from pulling in a file that netlify/tsconfig.json typechecks instead.
    vi.stubEnv("AUTH_DISABLED", "true");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fnUrl = new URL("../../netlify/functions/api.ts", import.meta.url).href;
    ({ handler } = await import(fnUrl));
    vi.unstubAllEnvs();
  });

  function apiGatewayV1Event(path: string, httpMethod = "GET", body: unknown = null) {
    return {
      httpMethod,
      path,
      headers: body === null ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      multiValueHeaders: {},
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      body: body === null ? null : JSON.stringify(body),
      isBase64Encoded: false,
      requestContext: {},
    };
  }

  it.each(["/api/categories", "/.netlify/functions/api/categories"])("routes GET %s to the API", async (path) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await handler(apiGatewayV1Event(path), {});
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([{ id: "food", label: "Food", bg: "#FFFF00", fg: "#3d3d00" }]);
  });

  it("passes a JSON request body through to the route", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await handler(apiGatewayV1Event("/api/debts", "POST", { name: "Alex", amount: 250 }), {});
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({ name: "Alex", amount: 250 });
  });
});
