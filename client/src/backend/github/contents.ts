import { base64ToBytes, bytesToBase64 } from "../base64";
import { isDeviceId } from "../sync/tags";

// The GitHub REST client for GitHub storage mode (ADR-0007, ADR-0008): reads
// and writes encrypted files in the person's private repo, with each file's
// blob `sha` as the optimistic-concurrency check, and reads the branch ref,
// a commit's file listing and blobs by sha for the sync cycle (design
// section 7). It moves bytes only; every file is already encrypted. The base
// URL, fetch and the token source are parameters so tests and the e2e can
// point it at a fake. It builds no github.com web links.
//
// What GitHub really does for each call is recorded in
// docs/architecture/github-api-behaviour.md.

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_PATH = "ledger.json.enc";
const TIMEOUT_MS = 30_000;
// One Accept for every JSON request: GitHub's ETags differ per Accept, so a
// poll that changed it would never get a 304.
const JSON_ACCEPT = "application/vnd.github+json";
const RAW_ACCEPT = "application/vnd.github.raw+json";
/** What git/* endpoints answer, with 409, on a repo with no commits. */
const EMPTY_REPO_MESSAGE = "Git Repository is empty.";
/** A PUT that lost the branch-ref compare-and-swap to another commit. */
const BRANCH_RACE = /^is at [0-9a-f]{40} but expected [0-9a-f]{40}$/;
const SHA = /^[0-9a-f]{40}$/;
/** A 403 or 429 whose message says this is a rate limit. */
const RATE_LIMIT_MESSAGE = /rate limit/i;
/** How long to wait on a rate limit GitHub gave no time for: its documented
 * floor for a secondary limit. */
const RATE_LIMIT_FLOOR_MS = 60_000;

/** The only commit messages this client writes, so no caller can put data
 * (amounts, remarks, counts) in commit metadata. "Sync <dev8>" and
 * "Snapshot <dev8>" carry 8 hex digits of the device id; build them with
 * deviceCommitMessage. putFile refuses anything else. */
export type CommitMessage =
  | "Update ledger.json.enc"
  | "Create ledger"
  | "Restore from backup"
  | `Sync ${string}`
  | `Snapshot ${string}`;

const COMMIT_MESSAGE = /^(?:Update ledger\.json\.enc|Create ledger|Restore from backup|(?:Sync|Snapshot) [0-9a-f]{8})$/;

/** "Sync <dev8>" or "Snapshot <dev8>" for a device id ("d" and 16 hex
 * digits): its first 8 hex digits, enough to tell devices apart in the
 * repo's history without naming anything else. */
export function deviceCommitMessage(kind: "Sync" | "Snapshot", deviceId: string): CommitMessage {
  if (!isDeviceId(deviceId)) throw new TypeError("Not a device id");
  return `${kind} ${deviceId.slice(1, 9)}`;
}

/** The git blob id of `text` as UTF-8: SHA-1 of "blob <size>\0" and the
 * bytes. It equals the `content.sha` GitHub answers a PUT of that text
 * with, so a caller can know a write's sha before sending it, and skip a
 * PUT whose bytes the file already holds (GitHub would still make an empty
 * commit for it, moving the branch for every other device). */
export async function gitBlobSha(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const data = new Uint8Array(prefix.length + bytes.length);
  data.set(prefix);
  data.set(bytes, prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

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

/** 403 or 429 from GitHub's rate limiter: one with `x-ratelimit-remaining:
 * 0` or `retry-after`, or whose message names a rate limit. `resetAt` (ISO)
 * is when it lifts; when GitHub didn't say, a minute from now, its
 * documented floor for a secondary limit. */
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

/** 409, or 422 about the `sha`: the write was not applied.
 *
 * `reason` tells the two kinds apart by GitHub's message:
 * - "branch-race": "is at <head> but expected <base>". The PUT was checked
 *   against a head that has since moved. The file's own sha is usually
 *   still current (another path moved the branch), so the same PUT may be
 *   retried, but not always: a PUT to the same path that won the race gets
 *   the loser this same message, and then the retry gets "does not match".
 * - "stale-sha": "<path> does not match <sha>", or a 422 "sha" wasn't
 *   supplied. The sha sent is not the file's current one. */
export class ShaConflictError extends GitHubError {
  readonly reason: "branch-race" | "stale-sha";
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "ShaConflictError";
    this.reason = status === 409 && BRANCH_RACE.test(message) ? "branch-race" : "stale-sha";
  }
}

/** 409 "Git Repository is empty." from a git/* endpoint: the repo has no
 * commits, so there is no ledger yet. Not a sha conflict. */
export class EmptyRepoError extends GitHubError {
  constructor() {
    super(409, "The repository is empty.");
    this.name = "EmptyRepoError";
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
 * `2026-11-01 12:00:00 UTC` or `2026-11-01 12:00:00 +0200`, as ISO.
 *
 * Best-effort only. api.github.com is cross-origin to the app, and GitHub's
 * Access-Control-Expose-Headers list doesn't include this header, so a
 * browser hides it and the expiry stays null there. It is read anyway for
 * callers outside a browser, and in case GitHub ever exposes it. */
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
  // GitHub's docs allow a secondary limit with neither header ("otherwise,
  // wait at least one minute"); its message names the rate limit.
  const namesRateLimit = (res.status === 403 || res.status === 429) && RATE_LIMIT_MESSAGE.test(message);
  if (rateLimited || namesRateLimit) {
    return new GitHubRateLimitError(res.status, rateLimitReset(res) ?? new Date(Date.now() + RATE_LIMIT_FLOOR_MS).toISOString());
  }
  if (res.status === 401) return new GitHubAuthError();
  if (res.status === 403) return new GitHubForbiddenError(message);
  if (res.status === 409 && message === EMPTY_REPO_MESSAGE) return new EmptyRepoError();
  if (res.status === 409 || (res.status === 422 && /\bsha\b/i.test(message))) return new ShaConflictError(res.status, message);
  return new GitHubError(res.status, message);
}

function networkError(err: unknown): GitHubNetworkError {
  const timedOut = err instanceof Error && err.name === "TimeoutError";
  return new GitHubNetworkError(timedOut ? "GitHub did not answer in time." : "Could not reach GitHub.");
}

/** Reads a response body with its failures typed. fetch resolves once the
 * headers arrive, and the request's timeout signal also aborts the body,
 * so a timeout or a dropped connection mid-download rejects here rather
 * than in fetch: it is still GitHubNetworkError. A body that isn't JSON is
 * a plain GitHubError. */
async function readBody<T>(res: Response, read: (res: Response) => Promise<T>): Promise<T> {
  try {
    return await read(res);
  } catch (err) {
    if (err instanceof SyntaxError) throw new GitHubError(res.status, "GitHub sent a response that isn't valid JSON.");
    throw networkError(err);
  }
}

interface SendOptions {
  accept: string;
  body?: string;
  ifNoneMatch?: string;
  /** Lets the request outlive the page (a push on pagehide). */
  keepalive?: boolean;
}

function createTransport({ token, apiBase = DEFAULT_API_BASE, fetch: fetchFn = globalThis.fetch, onUnauthorized }: TransportOptions) {
  const tokenSource = typeof token === "string" ? () => Promise.resolve(token) : token;
  const base = apiBase.replace(/\/+$/, "");
  const state = { tokenExpiresAt: null as string | null };

  async function attempt(method: string, path: string, { accept, body, ifNoneMatch, keepalive }: SendOptions): Promise<Response> {
    // Only headers GitHub's CORS preflight allows. Never Cache-Control or
    // Pragma, which it doesn't: `cache: "no-store"` below does that job.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await tokenSource()}`,
      Accept: accept,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (ifNoneMatch !== undefined) headers["If-None-Match"] = ifNoneMatch;
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method,
        headers,
        body,
        // GitHub's API responses carry max-age=60: a cached read would hand
        // the next write a stale sha. A conditional request still reaches
        // GitHub, which answers 304 when nothing changed.
        cache: "no-store",
        ...(keepalive ? { keepalive: true } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError(err);
    }
    const expiration = res.headers.get("github-authentication-token-expiration");
    if (expiration) state.tokenExpiresAt = parseExpiration(expiration);
    return res;
  }

  /** Sends one request. A 401 is retried once, with the token source asked
   * again, only when onUnauthorized resolves true (a refreshed token). */
  async function send(method: string, path: string, options: Partial<SendOptions> = {}) {
    const full: SendOptions = { accept: JSON_ACCEPT, ...options };
    const res = await attempt(method, path, full);
    if (res.status === 401 && onUnauthorized && (await onUnauthorized())) {
      return attempt(method, path, full);
    }
    return res;
  }

  return { send, state };
}

/** Throws the typed error for a failed response, then returns the parsed
 * JSON body of a successful one. */
async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await toError(res);
  return readBody(res, (r) => r.json() as Promise<T>);
}

// --- API ----------------------------------------------------------------------

/** Who the token belongs to, before the owner and repo are known. `login`
 * is later written as `updatedBy`. `tokenExpiresAt` is the token's expiry
 * (ISO) when GitHub's expiration header could be read, else null: always
 * null in a browser, which CORS keeps from seeing that header. Null does
 * not mean the token never expires. */
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
  /** Path of the file readFile and writeFile use when given none. */
  path?: string;
}

/** The branch head, from a (conditional) ref read. */
export type RefRead =
  /** 304: the ref is as it was when `etag` was read. Uncounted by GitHub. */
  | { kind: "unchanged" }
  /** The repo has no commits: no ledger yet. */
  | { kind: "empty" }
  /** The commit the branch points at, and the ETag to send next time. */
  | { kind: "head"; commitSha: string; etag: string | null };

/** One file directly in the listed directory. */
export interface ListedFile {
  name: string;
  /** Its git blob sha: readBlob(sha) returns exactly this version. */
  sha: string;
  size: number;
}

export interface DirListing {
  files: ListedFile[];
  /** GitHub cut the tree short (over 100,000 entries or 7 MB). The listing
   * is then incomplete, and no absence may be read into it. */
  truncated: boolean;
}

export interface FileWrite {
  path: string;
  text: string;
  /** The file's current blob sha, or null to create it. */
  sha: string | null;
  message: CommitMessage;
  /** Send with fetch's keepalive, so the PUT can outlive the page. */
  keepalive?: boolean;
}

export interface PutResult {
  /** The file's new blob sha (equal to gitBlobSha(text)). */
  sha: string;
  /** The commit the PUT made. */
  commitSha: string;
  /** The commit GitHub applied it on (commit.parents[0].sha), or null for
   * the repo's first commit. When it equals the head this device last saw,
   * no other commit came in between. */
  parentSha: string | null;
}

export interface GitHubClient {
  /** The last token expiry read from GitHub's expiration header (ISO), or
   * null when none could be read. Best-effort: always null in a browser,
   * because GitHub's CORS policy doesn't expose that header. */
  readonly tokenExpiresAt: string | null;
  /** Checks the repo exists, the token reaches it, and it is private.
   * Returns its default branch, the one every read and write uses. */
  verifyRepo(): Promise<{ defaultBranch: string }>;
  /** A file (default: the client's `path`) and its blob sha at the branch
   * head, or null when it (or the whole repo) is empty. Call verifyRepo
   * first: a 404 here is read as "no file yet". */
  readFile(path?: string): Promise<{ text: string; sha: string } | null>;
  /** Creates the client's file (`sha` null) or replaces the version `sha`
   * names, on the default branch. Returns the new sha. */
  writeFile(text: string, sha: string | null, message?: CommitMessage): Promise<string>;
  /** Creates (`sha` null) or replaces the file at `path`, on the default
   * branch. Throws ShaConflictError when GitHub refused it for its sha or
   * lost a branch race. */
  putFile(write: FileWrite): Promise<PutResult>;
  /** `GET git/ref/heads/{branch}`, conditional on `etag` when given. */
  getRef(branch: string, etag?: string | null): Promise<RefRead>;
  /** The files directly in `dir` (default `ledger`) at `ref`, a commit sha,
   * in one git trees request. A missing directory lists no files. */
  listDir(ref: string, dir?: string): Promise<DirListing>;
  /** The blob `sha` names, as text. Never stale: a blob is immutable. */
  readBlob(sha: string): Promise<string>;
}

interface ContentsResponse {
  type?: string;
  encoding?: string;
  content?: string;
  size?: number;
  sha: string;
}

interface TreeResponse {
  tree?: unknown;
  truncated?: unknown;
}

interface PutResponse {
  content?: { sha?: unknown };
  commit?: { sha?: unknown; parents?: unknown };
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export function createGitHubClient({ owner, repo, path: defaultPath = DEFAULT_PATH, ...transportOptions }: GitHubClientOptions): GitHubClient {
  const { send, state } = createTransport(transportOptions);
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const contentsPath = (path: string) => `${repoPath}/contents/${encodePath(path)}`;

  async function readBlob(sha: string): Promise<string> {
    const res = await send("GET", `${repoPath}/git/blobs/${encodeURIComponent(sha)}`, { accept: RAW_ACCEPT });
    if (!res.ok) throw await toError(res);
    // Decoded as text whatever the Content-Type: GitHub labels raw blobs
    // text/plain.
    return new TextDecoder().decode(await readBody(res, (r) => r.arrayBuffer()));
  }

  async function putFile({ path, text, sha, message, keepalive }: FileWrite): Promise<PutResult> {
    if (!COMMIT_MESSAGE.test(message)) throw new TypeError("Refusing a commit message outside the fixed set");
    const body: { message: CommitMessage; content: string; sha?: string } = {
      message,
      content: bytesToBase64(new TextEncoder().encode(text)),
    };
    if (sha !== null) body.sha = sha;
    const res = await send("PUT", contentsPath(path), { body: JSON.stringify(body), keepalive });
    if (res.status === 404) throw new RepoNotFoundError();
    const result = await json<PutResponse>(res);
    const contentSha = result.content?.sha;
    const commitSha = result.commit?.sha;
    const parents = result.commit?.parents;
    // parents[0] is an object; the repo's first commit has none.
    const parent: unknown = Array.isArray(parents) && parents.length > 0 ? (parents[0] as { sha?: unknown } | null)?.sha : null;
    if (typeof contentSha !== "string" || typeof commitSha !== "string" || !Array.isArray(parents) || (parent !== null && typeof parent !== "string")) {
      throw new GitHubError(res.status, "GitHub's answer to a write is missing its commit.");
    }
    return { sha: contentSha, commitSha, parentSha: parent };
  }

  return {
    get tokenExpiresAt() {
      return state.tokenExpiresAt;
    },

    async verifyRepo() {
      const res = await send("GET", repoPath);
      if (res.status === 404) throw new RepoNotFoundError();
      const info = await json<{ private?: boolean; default_branch?: unknown }>(res);
      if (info.private !== true) throw new PublicRepoError(res.status);
      if (typeof info.default_branch !== "string" || info.default_branch === "") {
        throw new GitHubError(res.status, "GitHub did not name the repository's default branch.");
      }
      return { defaultBranch: info.default_branch };
    },

    async readFile(path = defaultPath) {
      const res = await send("GET", contentsPath(path));
      if (res.status === 404) return null;
      const file = await json<ContentsResponse | ContentsResponse[]>(res);
      if (Array.isArray(file) || (file.type !== undefined && file.type !== "file")) {
        throw new GitHubError(res.status, `${path} in the repository is not a file`);
      }
      // From 1 MiB up, files come back without inline content. The blob is
      // read by sha, so the bytes are exactly the version that sha names.
      const inline = file.encoding === "base64" && typeof file.content === "string" && (file.content !== "" || file.size === 0);
      const text = inline ? new TextDecoder().decode(base64ToBytes(file.content ?? "")) : await readBlob(file.sha);
      return { text, sha: file.sha };
    },

    async writeFile(text, sha, message = "Update ledger.json.enc") {
      return (await putFile({ path: defaultPath, text, sha, message })).sha;
    },

    putFile,

    async getRef(branch, etag = null) {
      const res = await send("GET", `${repoPath}/git/ref/heads/${encodePath(branch)}`, etag ? { ifNoneMatch: etag } : {});
      // A browser hands GitHub's 304 to script as a Response with ok false,
      // so it is checked before ok.
      if (res.status === 304) return { kind: "unchanged" };
      if (!res.ok) {
        const err = await toError(res);
        if (err instanceof EmptyRepoError) return { kind: "empty" };
        throw err;
      }
      const ref = await readBody(res, (r) => r.json() as Promise<{ object?: { sha?: unknown; type?: unknown } } | null>);
      const commitSha = ref?.object?.sha;
      if (ref?.object?.type !== "commit" || typeof commitSha !== "string" || !SHA.test(commitSha)) {
        throw new GitHubError(res.status, `The branch ${branch} does not point at a commit.`);
      }
      return { kind: "head", commitSha, etag: res.headers.get("etag") };
    },

    async listDir(ref, dir = "ledger") {
      // A recursive tree, not the contents API's directory listing, which
      // silently stops at 1,000 entries: a newer epoch's genesis sorts last
      // and would be the first thing dropped.
      const res = await send("GET", `${repoPath}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      const tree = await json<TreeResponse>(res);
      if (!Array.isArray(tree.tree) || typeof tree.truncated !== "boolean") {
        throw new GitHubError(res.status, "GitHub sent a file listing Ledger can't read.");
      }
      const prefix = dir === "" ? "" : `${dir.replace(/\/+$/, "")}/`;
      const files: ListedFile[] = [];
      for (const entry of tree.tree as ({ path?: unknown; type?: unknown; sha?: unknown; size?: unknown } | null)[]) {
        if (entry?.type !== "blob" || typeof entry.path !== "string" || !entry.path.startsWith(prefix)) continue;
        const name = entry.path.slice(prefix.length);
        if (name.includes("/")) continue;
        if (typeof entry.sha !== "string" || !SHA.test(entry.sha) || typeof entry.size !== "number") {
          throw new GitHubError(res.status, "GitHub sent a file listing Ledger can't read.");
        }
        files.push({ name, sha: entry.sha, size: entry.size });
      }
      return { files, truncated: tree.truncated };
    },

    readBlob,
  };
}
