import { base64ToBytes, bytesToBase64 } from "../base64";

// The GitHub REST client for GitHub storage mode (ADR-0007): reads and
// writes the one encrypted data file in the person's private repo, with the
// blob `sha` as the optimistic-concurrency check. It moves bytes only; the
// file is already encrypted. The base URL, fetch and the token source are
// parameters so tests and the e2e can point it at a fake. It builds no
// github.com web links.

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_PATH = "ledger.json.enc";
const TIMEOUT_MS = 30_000;
const JSON_ACCEPT = "application/vnd.github+json";
const RAW_ACCEPT = "application/vnd.github.raw+json";

/** The only commit messages this client writes, so no caller can put data
 * (amounts, remarks, counts) in commit metadata. */
export type CommitMessage = "Update ledger.json.enc" | "Restore from backup";

/** A token, or a function returning the current one (called before every
 * request, so a GitHub App token can refresh between calls). */
export type TokenSource = string | (() => Promise<string>);

// --- Errors ---------------------------------------------------------------

/** Any failed GitHub request. `status` is the HTTP status (0 when no
 * response arrived). */
export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

/** 401: the token is missing, expired or revoked. */
export class GitHubAuthError extends GitHubError {
  constructor(message = "GitHub did not accept the token. It may have expired or been revoked.") {
    super(401, message);
    this.name = "GitHubAuthError";
  }
}

/** 403 that isn't a rate limit, typically "Resource not accessible by
 * personal access token": the token lacks Contents read and write on the
 * repo. */
export class GitHubForbiddenError extends GitHubError {
  constructor(message: string) {
    super(403, message);
    this.name = "GitHubForbiddenError";
  }
}

/** 403 or 429 from GitHub's rate limiter. `resetAt` (ISO) is when it lifts,
 * or null when GitHub didn't say. */
export class GitHubRateLimitError extends GitHubError {
  readonly resetAt: string | null;
  constructor(status: number, resetAt: string | null) {
    super(status, "GitHub's rate limit was reached. Try again in a few minutes.");
    this.name = "GitHubRateLimitError";
    this.resetAt = resetAt;
  }
}

/** 404 for the repo. GitHub answers the same for a repo that doesn't exist
 * and one the token can't reach. */
export class RepoNotFoundError extends GitHubError {
  constructor() {
    super(404, "The repository was not found, or the token can't reach it.");
    this.name = "RepoNotFoundError";
  }
}

/** The repo is public. Ledger only stores its file in a private repo. */
export class PublicRepoError extends GitHubError {
  constructor(status: number) {
    super(status, "The repository is public. Ledger only stores data in a private repository.");
    this.name = "PublicRepoError";
  }
}

/** 409, or 422 about the `sha`: the file changed since it was read. */
export class ShaConflictError extends GitHubError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "ShaConflictError";
  }
}

/** No response: fetch rejected (offline, DNS, CORS) or timed out. */
export class GitHubNetworkError extends GitHubError {
  constructor(message = "Could not reach GitHub.") {
    super(0, message);
    this.name = "GitHubNetworkError";
  }
}

// --- Tokens -----------------------------------------------------------------

export type TokenCheck = { ok: true; kind: "fine-grained" | "app" } | { ok: false; message: string };

const FINE_GRAINED_HINT =
  "Create a fine-grained personal access token (it starts with github_pat_) limited to your one data repository.";

/** Accepts fine-grained tokens (`github_pat_`) and GitHub App user tokens
 * (`ghu_`). Refuses classic (`ghp_`) and OAuth (`gho_`) tokens, which reach
 * every repo the person owns. */
export function classifyToken(token: string): TokenCheck {
  const t = token.trim();
  if (t.startsWith("github_pat_")) return { ok: true, kind: "fine-grained" };
  if (t.startsWith("ghu_")) return { ok: true, kind: "app" };
  if (t.startsWith("ghp_")) {
    return { ok: false, message: `This is a classic token, which can reach every repository you own. ${FINE_GRAINED_HINT}` };
  }
  if (t.startsWith("gho_")) {
    return { ok: false, message: `This is an OAuth app token, which can reach every repository you own. ${FINE_GRAINED_HINT}` };
  }
  return { ok: false, message: `This doesn't look like a GitHub token. ${FINE_GRAINED_HINT}` };
}

// --- Transport --------------------------------------------------------------

interface TransportOptions {
  token: TokenSource;
  apiBase?: string;
  fetch?: typeof fetch;
  onUnauthorized?: () => Promise<boolean>;
}

/** GitHub's `github-authentication-token-expiration` header, for example
 * `2026-11-01 12:00:00 UTC` or `2026-11-01 12:00:00 +0200`, as ISO. */
function parseExpiration(value: string | null): string | null {
  if (!value) return null;
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const zone = !m[3] || m[3] === "UTC" || m[3] === "Z" ? "Z" : m[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** When a rate limit lifts, in GitHub's documented order: `retry-after`
 * when present (a secondary limit, usually about a minute), otherwise
 * `x-ratelimit-reset` when the primary limit is spent. GitHub sends
 * `x-ratelimit-reset` on every response, so on a secondary limit it names
 * the hourly window's reset, not when to retry. */
function rateLimitReset(res: Response): string | null {
  const retryAfter = Number(res.headers.get("retry-after"));
  if (res.headers.has("retry-after") && retryAfter >= 0) return new Date(Date.now() + retryAfter * 1000).toISOString();
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (res.headers.get("x-ratelimit-remaining") === "0" && reset > 0) return new Date(reset * 1000).toISOString();
  return null;
}

async function errorMessage(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : `GitHub request failed (${res.status})`;
}

/** Maps a non-2xx response to its typed error. 404 is the caller's to
 * interpret (a missing repo, or an empty one), so it gets a plain
 * GitHubError here. */
async function toError(res: Response): Promise<GitHubError> {
  const message = await errorMessage(res);
  const rateLimited =
    res.status === 429 || (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after")));
  if (rateLimited) return new GitHubRateLimitError(res.status, rateLimitReset(res));
  if (res.status === 401) return new GitHubAuthError();
  if (res.status === 403) return new GitHubForbiddenError(message);
  if (res.status === 409 || (res.status === 422 && /\bsha\b/i.test(message))) return new ShaConflictError(res.status, message);
  return new GitHubError(res.status, message);
}

function createTransport({ token, apiBase = DEFAULT_API_BASE, fetch: fetchFn = globalThis.fetch, onUnauthorized }: TransportOptions) {
  const tokenSource = typeof token === "string" ? () => Promise.resolve(token) : token;
  const base = apiBase.replace(/\/+$/, "");
  const state = { tokenExpiresAt: null as string | null };

  async function attempt(method: string, path: string, accept: string, body?: string): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await tokenSource()}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method,
        headers,
        body,
        // GitHub's API responses carry max-age=60: a cached read would hand
        // the next write a stale sha.
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new GitHubNetworkError(timedOut ? "GitHub did not answer in time." : "Could not reach GitHub.");
    }
    const expiration = res.headers.get("github-authentication-token-expiration");
    if (expiration) state.tokenExpiresAt = parseExpiration(expiration);
    return res;
  }

  /** Sends one request. A 401 is retried once, with the token source asked
   * again, only when onUnauthorized resolves true (a refreshed token). */
  async function send(method: string, path: string, { accept = JSON_ACCEPT, body }: { accept?: string; body?: string } = {}) {
    const res = await attempt(method, path, accept, body);
    if (res.status === 401 && onUnauthorized && (await onUnauthorized())) {
      return attempt(method, path, accept, body);
    }
    return res;
  }

  return { send, state };
}

/** Throws the typed error for a failed response, then returns the parsed
 * JSON body of a successful one. */
async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

// --- API ----------------------------------------------------------------------

/** Who the token belongs to, before the owner and repo are known. `login`
 * is later written as `updatedBy`; `tokenExpiresAt` is the token's expiry
 * (ISO), or null when it has none. */
export async function getLogin(options: {
  token: TokenSource;
  apiBase?: string;
  fetch?: typeof fetch;
}): Promise<{ login: string; tokenExpiresAt: string | null }> {
  const transport = createTransport(options);
  const user = await json<{ login: string }>(await transport.send("GET", "/user"));
  return { login: user.login, tokenExpiresAt: transport.state.tokenExpiresAt };
}

export interface GitHubClientOptions extends TransportOptions {
  owner: string;
  repo: string;
  /** Path of the data file in the repo. */
  path?: string;
}

export interface GitHubClient {
  /** The last token expiry GitHub reported (ISO), or null when it sent none. */
  readonly tokenExpiresAt: string | null;
  /** Checks the repo exists, the token reaches it, and it is private. */
  verifyRepo(): Promise<void>;
  /** The data file and its blob sha, or null when it (or the whole repo) is
   * empty. Call verifyRepo first: a 404 here is read as "no file yet". */
  readFile(): Promise<{ text: string; sha: string } | null>;
  /** Creates the file (`sha` null) or replaces the version `sha` names, on
   * the default branch. Returns the new sha. */
  writeFile(text: string, sha: string | null, message?: CommitMessage): Promise<string>;
}

interface ContentsResponse {
  type?: string;
  encoding?: string;
  content?: string;
  size?: number;
  sha: string;
}

export function createGitHubClient({ owner, repo, path = DEFAULT_PATH, ...transportOptions }: GitHubClientOptions): GitHubClient {
  const { send, state } = createTransport(transportOptions);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const contentsPath = `${repoPath}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;

  async function readBlob(sha: string): Promise<string> {
    const res = await send("GET", `${repoPath}/git/blobs/${encodeURIComponent(sha)}`, { accept: RAW_ACCEPT });
    if (!res.ok) throw await toError(res);
    return new TextDecoder().decode(await res.arrayBuffer());
  }

  return {
    get tokenExpiresAt() {
      return state.tokenExpiresAt;
    },

    async verifyRepo() {
      const res = await send("GET", repoPath);
      if (res.status === 404) throw new RepoNotFoundError();
      const info = await json<{ private?: boolean }>(res);
      if (info.private !== true) throw new PublicRepoError(res.status);
    },

    async readFile() {
      const res = await send("GET", contentsPath);
      if (res.status === 404) return null;
      const file = await json<ContentsResponse | ContentsResponse[]>(res);
      if (Array.isArray(file) || (file.type !== undefined && file.type !== "file")) {
        throw new GitHubError(res.status, `${path} in the repository is not a file`);
      }
      // Files over 1 MB come back without inline content. The blob is read
      // by sha, so the bytes are exactly the version that sha names.
      const inline = file.encoding === "base64" && typeof file.content === "string" && (file.content !== "" || file.size === 0);
      const text = inline ? new TextDecoder().decode(base64ToBytes(file.content ?? "")) : await readBlob(file.sha);
      return { text, sha: file.sha };
    },

    async writeFile(text, sha, message = "Update ledger.json.enc") {
      const body: { message: CommitMessage; content: string; sha?: string } = {
        message,
        content: bytesToBase64(new TextEncoder().encode(text)),
      };
      if (sha !== null) body.sha = sha;
      const res = await send("PUT", contentsPath, { body: JSON.stringify(body) });
      if (res.status === 404) throw new RepoNotFoundError();
      const result = await json<{ content: { sha: string } }>(res);
      return result.content.sha;
    },
  };
}
