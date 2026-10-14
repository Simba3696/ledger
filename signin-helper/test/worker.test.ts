import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/worker";

// The sign-in helper against a stubbed GitHub token endpoint. Fictional
// origins, ids and tokens only.

const ORIGIN = "https://alex.github.io";
const SECRET = "fake-client-secret-0123456789";
const ENV: Env = { GITHUB_APP_CLIENT_ID: "Iv1.fakeclientid", GITHUB_APP_CLIENT_SECRET: SECRET, ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:5173` };
const REDIRECT = `${ORIGIN}/ledger/`;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

let github: ReturnType<typeof vi.fn>;
const responses: Response[] = [];

function githubAnswers(body: unknown) {
  github.mockImplementationOnce(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
}

async function call(path: string, init: RequestInit & { origin?: string | null; env?: Env } = {}): Promise<Response> {
  const { origin = ORIGIN, env = ENV, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (origin !== null) headers.set("Origin", origin);
  if (rest.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await worker.fetch(new Request(`https://signin.example.workers.dev${path}`, { method: "POST", ...rest, headers }), env);
  responses.push(res.clone());
  return res;
}

const tokenBody = (over: Record<string, unknown> = {}) => JSON.stringify({ code: "fake-code", code_verifier: "v".repeat(43), redirect_uri: REDIRECT, ...over });

beforeEach(() => {
  github = vi.fn();
  vi.stubGlobal("fetch", github);
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});

afterEach(async () => {
  // Every response: never cached, and never carrying the client secret.
  for (const res of responses.splice(0)) {
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
    expect(await res.text()).not.toContain(SECRET);
    expect([...res.headers.values()].join("\n")).not.toContain(SECRET);
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CORS and request checks", () => {
  it("echoes an allowed origin, never *", async () => {
    githubAnswers({ access_token: "ghu_fake", expires_in: 28800, refresh_token: "ghr_fake", refresh_token_expires_in: 15897600 });
    const res = await call("/token", { body: tokenBody() });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("refuses another origin, or none, with a 403 and no Access-Control-Allow-Origin", async () => {
    for (const origin of ["https://mallory.example", null]) {
      const res = await call("/token", { origin, body: tokenBody() });
      expect(res.status).toBe(403);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(await res.json()).toEqual({ error: "origin_not_allowed" });
    }
    expect(github).not.toHaveBeenCalled();
  });

  it("answers an allowed preflight with 204", async () => {
    const res = await call("/token", { method: "OPTIONS", origin: "http://localhost:5173" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type");
  });

  it("answers any method but POST and OPTIONS with 405", async () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const res = await call("/token", { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST, OPTIONS");
    }
  });

  it("refuses a body over 4 KB with 413, declared or not", async () => {
    const big = tokenBody({ code: "c".repeat(5000) });
    expect((await call("/token", { body: big })).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const res = await call("/token", { body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request_too_large" });
    expect(github).not.toHaveBeenCalled();
  });

  it("refuses missing or non-string fields, and a body that isn't JSON, with 400 invalid_request", async () => {
    for (const body of [tokenBody({ code: undefined }), tokenBody({ code_verifier: 42 }), "not json", "[]", JSON.stringify({ refresh_token: "" })]) {
      const path = body.includes("refresh_token") ? "/refresh" : "/token";
      const res = await call(path, { body });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
    }
    expect((await call("/token", { body: tokenBody(), headers: { "Content-Type": "text/plain" } })).status).toBe(400);
    expect(github).not.toHaveBeenCalled();
  });

  it("refuses a redirect_uri on an origin not allowed with 400", async () => {
    for (const redirect of ["https://mallory.example/ledger/", "not a url"]) {
      const res = await call("/token", { body: tokenBody({ redirect_uri: redirect }) });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_redirect_uri" });
    }
    expect(github).not.toHaveBeenCalled();
  });
});

describe("the exchange", () => {
  it("/token sends the code, verifier, redirect and the App's credentials, and answers with expiry times in epoch ms", async () => {
    githubAnswers({ access_token: "ghu_fake", expires_in: 28800, refresh_token: "ghr_fake", refresh_token_expires_in: 15897600, token_type: "bearer", scope: "" });
    const res = await call("/token", { body: tokenBody() });
    expect(await res.json()).toEqual({
      access_token: "ghu_fake",
      expires_at: NOW + 28800_000,
      refresh_token: "ghr_fake",
      refresh_token_expires_at: NOW + 15897600_000,
    });
    const [url, init] = github.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://github.com/login/oauth/access_token");
    expect(new Headers(init.headers).get("Accept")).toBe("application/json");
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      client_id: "Iv1.fakeclientid",
      client_secret: SECRET,
      code: "fake-code",
      redirect_uri: REDIRECT,
      code_verifier: "v".repeat(43),
    });
  });

  it("/refresh sends grant_type=refresh_token and answers the same shape", async () => {
    githubAnswers({ access_token: "ghu_fresh", expires_in: 28800, refresh_token: "ghr_fresh", refresh_token_expires_in: 15897600 });
    const res = await call("/refresh", { body: JSON.stringify({ refresh_token: "ghr_old" }) });
    expect(await res.json()).toEqual({ access_token: "ghu_fresh", expires_at: NOW + 28800_000, refresh_token: "ghr_fresh", refresh_token_expires_at: NOW + 15897600_000 });
    const sent = Object.fromEntries(new URLSearchParams(String((github.mock.calls[0] as [string, RequestInit])[1].body)));
    expect(sent).toEqual({ client_id: "Iv1.fakeclientid", client_secret: SECRET, grant_type: "refresh_token", refresh_token: "ghr_old" });
  });

  it("passes GitHub's OAuth error code through as a 400, and nothing else of it", async () => {
    githubAnswers({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired.", error_uri: "https://docs.github.com/" });
    const res = await call("/token", { body: tokenBody() });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_verification_code" });
    githubAnswers({ error: "bad_refresh_token" });
    expect(await (await call("/refresh", { body: JSON.stringify({ refresh_token: "ghr_old" }) })).json()).toEqual({ error: "bad_refresh_token" });
  });

  it("answers 502 upstream_unavailable when GitHub can't be reached or sends no JSON", async () => {
    github.mockRejectedValueOnce(new TypeError("fetch failed"));
    const offline = await call("/token", { body: tokenBody() });
    expect(offline.status).toBe(502);
    expect(await offline.json()).toEqual({ error: "upstream_unavailable" });
    github.mockResolvedValueOnce(new Response("<html>unicorn</html>", { status: 503 }));
    expect(await (await call("/token", { body: tokenBody() })).json()).toEqual({ error: "upstream_unavailable" });
  });

  it("answers every request 500 helper_not_configured while a setting is missing or blank", async () => {
    for (const env of [{}, { ...ENV, GITHUB_APP_CLIENT_SECRET: " " }, { ...ENV, ALLOWED_ORIGINS: "" }, { ...ENV, GITHUB_APP_CLIENT_ID: undefined }]) {
      for (const method of ["POST", "OPTIONS", "GET"]) {
        const res = await call("/token", { method, env, body: method === "POST" ? tokenBody() : undefined });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "helper_not_configured" });
      }
    }
    expect(github).not.toHaveBeenCalled();
  });

  it("never sends the client secret back, even when GitHub's answer echoes it", async () => {
    githubAnswers({ error: SECRET, error_description: `client_secret=${SECRET}` });
    const res = await call("/token", { body: tokenBody() });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "oauth_error" });
    // The afterEach checks every response of every test for the secret.
  });
});
