import { base64ToBytes, bytesToBase64 } from "../base64";

// An in-memory GitHub REST API for tests: a fetch-compatible function with
// no DOM dependency, so it runs in Vitest and in Node. The e2e wraps this
// same fake in a Playwright route rather than keeping a second one.
//
// It models only what GitHub storage mode uses, closely enough to trust:
// GET /user, GET /repos/{o}/{r}, GET and PUT /repos/{o}/{r}/contents/{path},
// GET /repos/{o}/{r}/git/blobs/{sha}. Repos are pre-seeded (standing in for
// the person creating one on github.com); there is no repo-create endpoint,
// and any request it doesn't model fails with 501 and is recorded in
// `unhandled`. Tokens are an allow-list. Shas are real git blob SHA-1s, and
// contents come back as base64 with a newline every 60 characters.
//
// By default responses carry only the headers a browser on another origin
// can read: the CORS-safelisted ones plus GitHub's
// Access-Control-Expose-Headers list, so code under test can't come to
// depend on a header the browser would hide. `cors: false` shows every
// header, as outside a browser.

export interface FakeRepo {
  owner: string;
  name: string;
  private: boolean;
}

export interface FakeToken {
  login: string;
  /** "owner/name" of each repo the token can reach. */
  repos: string[];
  permission: "read" | "write";
  /** ISO time the token expires. Sent as GitHub's
   * github-authentication-token-expiration header (which CORS hides from a
   * browser); after it, 401. */
  expiresAt?: string;
}

interface RecordedRequest {
  method: string;
  /** Path and query after the API base, e.g. "/repos/o/r/contents/f". */
  path: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  cache: RequestCache | undefined;
  body: string | undefined;
}

interface FakeCommit {
  repo: string;
  path: string;
  message: string;
  sha: string;
}

/** A one-shot failure for the next request (with `method`, the next request
 * using it). `rateLimit` turns a 403 into one of GitHub's rate-limit
 * answers: "primary" (the hourly limit spent, `x-ratelimit-remaining: 0`)
 * or "secondary" (`retry-after: 60` with requests still left in the hour);
 * `network` makes fetch reject as it does offline. */
type FakeFailure =
  | { status: 401 | 403 | 404 | 409 | 422 | 429 | 500; method?: string; rateLimit?: "primary" | "secondary"; message?: string }
  | { network: true; method?: string };

export interface FakeGitHub {
  fetch: typeof fetch;
  /** Every request, in order. */
  readonly requests: RecordedRequest[];
  /** Requests for endpoints the fake doesn't model. */
  readonly unhandled: RecordedRequest[];
  /** Every successful PUT, in order. */
  readonly commits: FakeCommit[];
  addRepo(repo: FakeRepo): void;
  setToken(token: string, grant: FakeToken): void;
  revokeToken(token: string): void;
  /** Stores a file as if committed, without a request. Returns its sha. */
  seedFile(repo: string, path: string, text: string): Promise<string>;
  /** The file as stored now, or null. */
  file(repo: string, path: string): { text: string; sha: string } | null;
  failNext(failure: FakeFailure): void;
}

/** Response headers a cross-origin page can read from api.github.com: the
 * CORS-safelisted response headers, plus GitHub's
 * Access-Control-Expose-Headers as api.github.com sent it in October 2026. */
const BROWSER_VISIBLE_HEADERS = new Set(
  [
    "Cache-Control",
    "Content-Language",
    "Content-Length",
    "Content-Type",
    "Expires",
    "Last-Modified",
    "Pragma",
    "ETag",
    "Link",
    "Location",
    "Retry-After",
    "X-GitHub-OTP",
    "X-RateLimit-Limit",
    "X-RateLimit-Remaining",
    "X-RateLimit-Used",
    "X-RateLimit-Resource",
    "X-RateLimit-Reset",
    "X-OAuth-Scopes",
    "X-Accepted-OAuth-Scopes",
    "X-Poll-Interval",
    "X-GitHub-Media-Type",
    "X-GitHub-SSO",
    "X-GitHub-Request-Id",
    "Deprecation",
    "Sunset",
    "Warning",
  ].map((name) => name.toLowerCase()),
);

/** The response as a browser's fetch shows it across origins. */
function asBrowserSeesIt(res: Response): Response {
  const headers = new Headers();
  res.headers.forEach((value, name) => {
    if (BROWSER_VISIBLE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** GitHub's contents API stops inlining file content above 1 MB. */
const INLINE_LIMIT = 1024 * 1024;

interface RepoState {
  info: FakeRepo;
  files: Map<string, string>;
  blobs: Map<string, Uint8Array>;
}

function repoKey(fullName: string): string {
  return fullName.toLowerCase();
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The git blob id: SHA-1 of "blob <size>\0" followed by the bytes. */
async function blobSha(bytes: Uint8Array): Promise<string> {
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const data = new Uint8Array(prefix.length + bytes.length);
  data.set(prefix);
  data.set(bytes, prefix.length);
  return hex(await crypto.subtle.digest("SHA-1", data));
}

function wrap60(base64: string): string {
  return base64 === "" ? "" : `${base64.match(/.{1,60}/g)!.join("\n")}\n`;
}

/** "2026-11-01 12:00:00 UTC", the format GitHub sends. */
function expirationHeader(iso: string): string {
  return `${new Date(iso).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** The x-ratelimit-* headers GitHub sends on every authenticated response.
 * `x-ratelimit-reset` is the end of the hourly window, even when another
 * limit is what stopped the request. */
function rateLimitHeaders(remaining: number): Record<string, string> {
  return {
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-used": String(5000 - remaining),
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    "x-ratelimit-resource": "core",
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function raw(bytes: Uint8Array, headers: Record<string, string>): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "application/vnd.github.raw; charset=utf-8", ...headers },
  });
}

export function createFakeGitHub({
  apiBase = "https://api.github.com",
  repos = [],
  tokens = {},
  cors = true,
}: { apiBase?: string; repos?: FakeRepo[]; tokens?: Record<string, FakeToken>; cors?: boolean } = {}): FakeGitHub {
  const base = apiBase.replace(/\/+$/, "");
  const repoStates = new Map<string, RepoState>();
  const grants = new Map<string, FakeToken>();
  const failures: FakeFailure[] = [];
  const requests: RecordedRequest[] = [];
  const unhandled: RecordedRequest[] = [];
  const commits: FakeCommit[] = [];

  const addRepo = (info: FakeRepo) => {
    repoStates.set(repoKey(`${info.owner}/${info.name}`), { info: { ...info }, files: new Map(), blobs: new Map() });
  };
  repos.forEach(addRepo);
  for (const [token, grant] of Object.entries(tokens)) grants.set(token, grant);

  function repoState(fullName: string): RepoState {
    const state = repoStates.get(repoKey(fullName));
    if (!state) throw new Error(`fakeGitHub: no repo ${fullName}`);
    return state;
  }

  async function store(state: RepoState, path: string, bytes: Uint8Array): Promise<string> {
    const sha = await blobSha(bytes);
    state.blobs.set(sha, bytes);
    state.files.set(path, sha);
    return sha;
  }

  function takeFailure(method: string): FakeFailure | undefined {
    const i = failures.findIndex((f) => !f.method || f.method.toUpperCase() === method);
    return i < 0 ? undefined : failures.splice(i, 1)[0];
  }

  function failureResponse(failure: Exclude<FakeFailure, { network: true }>): Response {
    const secondary = { ...rateLimitHeaders(4990), "retry-after": "60" };
    switch (failure.status) {
      case 401:
        return json(401, { message: failure.message ?? "Bad credentials" });
      case 403:
        if (failure.rateLimit === "primary") {
          const spent = { ...rateLimitHeaders(0), "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) };
          return json(403, { message: failure.message ?? "API rate limit exceeded" }, spent);
        }
        if (failure.rateLimit === "secondary") {
          return json(403, { message: failure.message ?? "You have exceeded a secondary rate limit." }, secondary);
        }
        return json(403, { message: failure.message ?? "Resource not accessible by personal access token" });
      case 404:
        return json(404, { message: failure.message ?? "Not Found" });
      case 409:
        return json(409, { message: failure.message ?? "is at 0000000 but expected 1111111" });
      case 422:
        return json(422, { message: failure.message ?? 'Invalid request.\n\n"sha" wasn\'t supplied.' });
      case 429:
        return json(429, { message: failure.message ?? "Too many requests" }, secondary);
      case 500:
        return json(500, { message: failure.message ?? "Server Error" });
    }
  }

  async function record(input: RequestInfo | URL, init: RequestInit | undefined): Promise<RecordedRequest> {
    const req = input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? req?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    let body: string | undefined;
    if (typeof init?.body === "string") body = init.body;
    else if (init?.body == null && req && req.body) body = await req.text();
    // A URL outside the API base keeps its full href, so it can't match a route.
    const full = `${url.origin}${url.pathname}`;
    const request: RecordedRequest = {
      method: (init?.method ?? req?.method ?? "GET").toUpperCase(),
      path: full.startsWith(base) ? full.slice(base.length) + url.search : url.href,
      headers,
      cache: init?.cache ?? req?.cache,
      body,
    };
    requests.push(request);
    return request;
  }

  async function handle(request: RecordedRequest): Promise<Response> {
    const path = request.path.split("?")[0];
    const segments = path.split("/").slice(1).map(decodeURIComponent);
    const method = request.method;

    type Route =
      | { kind: "user" }
      | { kind: "repo"; repo: string }
      | { kind: "contents"; repo: string; file: string }
      | { kind: "blob"; repo: string; sha: string };
    let route: Route | null = null;
    if (method === "GET" && path === "/user") route = { kind: "user" };
    else if (segments[0] === "repos" && segments.length >= 3) {
      const repo = `${segments[1]}/${segments[2]}`;
      if (method === "GET" && segments.length === 3) route = { kind: "repo", repo };
      else if ((method === "GET" || method === "PUT") && segments[3] === "contents" && segments.length > 4) {
        route = { kind: "contents", repo, file: segments.slice(4).join("/") };
      } else if (method === "GET" && segments[3] === "git" && segments[4] === "blobs" && segments.length === 6) {
        route = { kind: "blob", repo, sha: segments[5] };
      }
    }
    if (!route || !request.path.startsWith("/")) {
      unhandled.push(request);
      return json(501, { message: `fakeGitHub does not model ${method} ${request.path}` });
    }

    // Authentication, as GitHub: an unknown, revoked or expired token is 401.
    const token = request.headers.authorization?.match(/^(?:Bearer|token)\s+(.+)$/i)?.[1];
    const grant = token === undefined ? undefined : grants.get(token);
    if (!grant || (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now())) {
      return json(401, { message: "Bad credentials" });
    }
    const common: Record<string, string> = rateLimitHeaders(4999);
    if (grant.expiresAt) common["github-authentication-token-expiration"] = expirationHeader(grant.expiresAt);

    if (route.kind === "user") return json(200, { login: grant.login }, common);

    // A repo the token can't reach looks exactly like a missing one.
    const state = repoStates.get(repoKey(route.repo));
    if (!state || !grant.repos.some((r) => repoKey(r) === repoKey(route.repo))) {
      return json(404, { message: "Not Found" }, common);
    }
    const fullName = `${state.info.owner}/${state.info.name}`;
    const wantsRaw = (request.headers.accept ?? "").includes("raw");

    if (route.kind === "repo") {
      const { owner, name } = state.info;
      return json(
        200,
        { name, full_name: fullName, owner: { login: owner }, private: state.info.private, default_branch: "main" },
        common,
      );
    }

    if (route.kind === "blob") {
      const bytes = state.blobs.get(route.sha);
      if (!bytes) return json(404, { message: "Not Found" }, common);
      if (wantsRaw) return raw(bytes, common);
      return json(200, { sha: route.sha, size: bytes.length, encoding: "base64", content: wrap60(bytesToBase64(bytes)) }, common);
    }

    const file = route.file;
    const currentSha = state.files.get(file);
    if (method === "GET") {
      if (currentSha === undefined) {
        return json(404, { message: state.files.size === 0 ? "This repository is empty." : "Not Found" }, common);
      }
      const bytes = state.blobs.get(currentSha)!;
      if (wantsRaw) return raw(bytes, common);
      const inline = bytes.length <= INLINE_LIMIT;
      return json(
        200,
        {
          type: "file",
          name: file.split("/").pop(),
          path: file,
          sha: currentSha,
          size: bytes.length,
          encoding: inline ? "base64" : "none",
          content: inline ? wrap60(bytesToBase64(bytes)) : "",
        },
        common,
      );
    }

    // PUT contents
    if (grant.permission !== "write") {
      return json(403, { message: "Resource not accessible by personal access token" }, common);
    }
    let payload: { message?: unknown; content?: unknown; sha?: unknown };
    try {
      payload = JSON.parse(request.body ?? "");
    } catch {
      return json(400, { message: "Problems parsing JSON" }, common);
    }
    if (typeof payload.message !== "string") {
      return json(422, { message: 'Invalid request.\n\n"message" wasn\'t supplied.' }, common);
    }
    let bytes: Uint8Array;
    try {
      if (typeof payload.content !== "string") throw new Error("no content");
      bytes = base64ToBytes(payload.content);
    } catch {
      return json(422, { message: "content is not valid Base64" }, common);
    }
    if (currentSha !== undefined && payload.sha === undefined) {
      return json(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }, common);
    }
    if (payload.sha !== undefined && payload.sha !== currentSha) {
      return json(409, { message: `${file} does not match ${String(payload.sha)}` }, common);
    }
    const sha = await store(state, file, bytes);
    const commitSha = hex(crypto.getRandomValues(new Uint8Array(20)));
    commits.push({ repo: fullName, path: file, message: payload.message, sha });
    return json(
      currentSha === undefined ? 201 : 200,
      {
        content: { type: "file", name: file.split("/").pop(), path: file, sha, size: bytes.length },
        commit: { sha: commitSha, message: payload.message },
      },
      common,
    );
  }

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = await record(input, init);
    const failure = takeFailure(request.method);
    if (failure && "network" in failure) throw new TypeError("Failed to fetch");
    const res = failure ? failureResponse(failure) : await handle(request);
    return cors ? asBrowserSeesIt(res) : res;
  };

  return {
    fetch: fakeFetch as typeof fetch,
    requests,
    unhandled,
    commits,
    addRepo,
    setToken(token, grant) {
      grants.set(token, grant);
    },
    revokeToken(token) {
      grants.delete(token);
    },
    seedFile(repo, path, text) {
      return store(repoState(repo), path, new TextEncoder().encode(text));
    },
    file(repo, path) {
      const state = repoState(repo);
      const sha = state.files.get(path);
      if (sha === undefined) return null;
      return { text: new TextDecoder().decode(state.blobs.get(sha)), sha };
    },
    failNext(failure) {
      failures.push(failure);
    },
  };
}
