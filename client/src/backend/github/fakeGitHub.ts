import { base64ToBytes, bytesToBase64 } from "../base64";
import { parseRepoFileName } from "../sync/epoch";

// An in-memory GitHub REST API for tests: a fetch-compatible function with
// no DOM dependency, so it runs in Vitest and in Node. The e2e wraps this
// same fake in a Playwright route rather than keeping a second one.
//
// It models only what GitHub storage mode uses, closely enough to trust, as
// recorded against the real API in docs/architecture/github-api-behaviour.md
// and __fixtures__/github-behaviour.json (fakeGitHub.fidelity.test.ts holds
// the fake to that record):
//   GET /user, GET /repos/{o}/{r},
//   GET and PUT /repos/{o}/{r}/contents/{path} (a file, or a directory
//     listing, at the branch head or ?ref=),
//   GET /repos/{o}/{r}/git/ref/heads/{branch},
//   GET /repos/{o}/{r}/git/trees/{sha|branch}[?recursive=1],
//   GET /repos/{o}/{r}/git/blobs/{sha}.
// Repos are pre-seeded (standing in for the person creating one on
// github.com), have one branch, `main`, and start empty; there is no
// repo-create endpoint, and any request it doesn't model fails with 501 and
// is recorded in `unhandled`: the `{commitSha}:{path}` tree form, and a PUT
// onto a directory or under a file (GitHub's answer not recorded), included. Tokens are an allow-list. Blob and tree shas
// are real git object ids (a tree is hashed as git hashes it), commits form
// a history the branch ref moves along, and contents come back as base64
// with a newline every 60 characters.
//
// Every PUT is a compare-and-swap on the branch ref, as on GitHub: a PUT is
// applied against the head as it was when the request arrived, so two PUTs
// in flight at once race even when they write different paths, and the
// loser gets 409 "is at <head> but expected <base>". The check of the file's
// sha and the ref move happen in one synchronous step, so no interleaving
// can lose an update. By default a PUT is in flight only until the current
// synchronous section ends, so only PUTs sent in the same tick race. On
// GitHub a PUT took about 1.5 s and PUTs sent ~30 ms apart raced routinely
// (github-api-behaviour.md section 4); `putLatencyMs` keeps each PUT in
// flight that long, so tests of devices syncing at once reach the race.
//
// GETs answer If-None-Match with a 304 that doesn't count against the rate
// limit. Reads and writes keep separate rate-limit counters, as GitHub
// reports them; errors count, injected ones (failNext) included, and carry
// the same x-ratelimit-* headers.
//
// By default responses carry only the headers a browser on another origin
// can read: the CORS-safelisted ones plus GitHub's
// Access-Control-Expose-Headers list, so code under test can't come to
// depend on a header the browser would hide. A request carrying a header
// GitHub's preflight doesn't allow fails as a browser fails it: fetch
// rejects. `cors: false` shows every header and skips that check, as
// outside a browser.

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
  keepalive: boolean | undefined;
  body: string | undefined;
  /** The device whose fetchAs() fetch sent it, if any. */
  device: string | undefined;
}

interface FakeCommit {
  repo: string;
  path: string;
  message: string;
  /** The blob sha the PUT stored. */
  sha: string;
  /** The commit the PUT made. */
  commit: string;
  /** The commit it was applied on, or null for the repo's first commit. */
  parent: string | null;
}

/** Which requests a fault applies to: the next one using `method`, and
 * whose path (after the API base, without the query) contains `path` or
 * matches it. Both optional. */
interface RequestMatch {
  method?: string;
  path?: string | RegExp;
}

/** A one-shot failure for the next matching request. `rateLimit` turns a
 * 403 into one of GitHub's rate-limit answers: "primary" (the hourly limit
 * spent, `x-ratelimit-remaining: 0`, resetting in a minute) or "secondary"
 * (`retry-after: 60` with requests still left in the hour); `network` makes
 * fetch reject as it does offline. The request is not applied. An injected
 * HTTP failure on an authenticated request (any but 401) counts against the
 * read or write counter and carries the x-ratelimit-* headers, as GitHub's
 * errors do; a network failure has no response, so neither. */
type FakeFailure = RequestMatch &
  (
    | { status: 401 | 403 | 404 | 409 | 422 | 429 | 500; rateLimit?: "primary" | "secondary"; message?: string }
    | { network: true }
  );

export interface FakeGitHub {
  fetch: typeof fetch;
  /** A fetch that tags each request with `device` and asserts, on every
   * PUT, that the device writes only its own files: under `ledger/`, a
   * `<epoch>.<device>.<log|snap>.enc` with its own id, or a genesis it
   * creates (no `sha`). A PUT that breaks this is refused and recorded in
   * `violations` (design section 6, AC10). */
  fetchAs(device: string): typeof fetch;
  /** Every request, in order. */
  readonly requests: RecordedRequest[];
  /** Requests for endpoints the fake doesn't model. */
  readonly unhandled: RecordedRequest[];
  /** Every PUT that landed, in order. */
  readonly commits: FakeCommit[];
  /** Path-ownership breaches and DELETE requests. Tests expect it empty. */
  readonly violations: string[];
  addRepo(repo: FakeRepo): void;
  setToken(token: string, grant: FakeToken): void;
  revokeToken(token: string): void;
  /** Stores a file as one commit on `main`, without a request. Returns its
   * blob sha. */
  seedFile(repo: string, path: string, text: string): Promise<string>;
  /** Stores several files as one commit. Returns each path's blob sha. */
  seedFiles(repo: string, files: Record<string, string>): Promise<Record<string, string>>;
  /** Deletes a file as one commit on `main`, without a request: a person
   * deleting it in GitHub's web UI, which the app never does (ADR-0008
   * D26). */
  removeFile(repo: string, path: string): void;
  /** The file as stored at the head now, or null. */
  file(repo: string, path: string): { text: string; sha: string } | null;
  /** The commit `main` points at now, or null while the repo is empty. */
  head(repo: string): string | null;
  failNext(failure: FakeFailure): void;
  /** The next matching request is applied, but its response is lost: fetch
   * rejects as it does when the connection drops. */
  landThenDropResponse(match?: RequestMatch): void;
  /** The next matching request times out at once (fetch rejects with a
   * TimeoutError), but is applied later: after `afterRequests` more
   * requests have been answered, against the head at that moment. */
  landLater(afterRequests: number, match?: RequestMatch): void;
  /** Applies every request landLater still holds, now. */
  landPending(): void;
  /** The next matching request reaches GitHub twice; the caller sees the
   * second answer (for a PUT that landed, a 409). */
  duplicateRequest(match?: RequestMatch): void;
  /** From now on, reads that name the branch (the ref, a contents file or
   * listing without a commit sha, a tree by branch name) see the branch as
   * it was `lag` commits ago; 0 ends it. Reads by sha are never stale.
   * Never observed on real GitHub (github-api-behaviour.md section 13), so
   * this is how tests show stale reads are harmless. A lag past the first
   * commit shows an empty repo to every branch-named read: the ref and the
   * tree by branch answer 409 "Git Repository is empty.", contents 404
   * "This repository is empty.", as GitHub answers an empty repo. */
  staleReads(lag: number): void;
  /** From now on a tree response lists at most `limit` entries and sets
   * `truncated`, as GitHub does past its 100,000 entries or 7 MB; null goes
   * back to the limit the fake was made with. A cut listing at will. */
  cutTrees(limit: number | null): void;
  /** Every file version the branch has held, each (path, blob sha) once:
   * the files at every commit of its history, overwritten and deleted ones
   * included. A test's view, not a request. */
  versions(repo: string): { path: string; sha: string; text: string }[];
}

/** Response headers a cross-origin page can read from api.github.com: the
 * CORS-safelisted response headers, plus GitHub's
 * Access-Control-Expose-Headers as api.github.com sent it in October 2026. */
export const BROWSER_VISIBLE_HEADERS = new Set(
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

/** Request headers api.github.com's CORS preflight allows (October 2026),
 * plus the CORS-safelisted Accept. Cache-Control and Pragma are not among
 * them. */
export const PREFLIGHT_ALLOWED_HEADERS = new Set(
  [
    "Authorization",
    "Content-Type",
    "If-Match",
    "If-Modified-Since",
    "If-None-Match",
    "If-Unmodified-Since",
    "Accept-Encoding",
    "X-GitHub-OTP",
    "X-Requested-With",
    "User-Agent",
    "GraphQL-Features",
    "X-Github-Next-Global-ID",
    "X-GitHub-Api-Version",
    "X-Fetch-Nonce",
    "Copilot-Integration-Id",
    "DD-CLIENT-TOKEN",
    "X-Client-Application",
    "Accept",
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

/** GitHub's contents API inlines a file's content only below 1 MiB. */
const INLINE_BELOW = 1024 * 1024;
/** The contents API lists at most this many directory entries, silently. */
const LISTING_CAP = 1000;
/** A tree response lists at most this many entries, then sets truncated. */
const TREE_ENTRY_LIMIT = 100_000;
/** Content-creating requests before GitHub's secondary limit answers. */
const SECONDARY_PER_MINUTE = 80;
/** GitHub's hourly limit for requests with no token (recorded, section 14). */
const UNAUTHENTICATED_LIMIT = 60;
const SECONDARY_PER_HOUR = 500;
const BRANCH = "main";

const CACHE_SHORT = "private, max-age=60, s-maxage=60";
const CACHE_LONG = "private, max-age=86400, s-maxage=86400";

const DOCS = {
  rest: "https://docs.github.com/rest",
  repo: "https://docs.github.com/rest/repos/repos#get-a-repository",
  contents: "https://docs.github.com/rest/repos/contents#get-repository-content",
  contentsEmpty: "https://docs.github.com/v3/repos/contents/#get-contents",
  contentsRef: "https://docs.github.com/v3/repos/contents/",
  put: "https://docs.github.com/rest/repos/contents#create-or-update-file-contents",
  ref: "https://docs.github.com/rest/git/refs#get-a-reference",
  trees: "https://docs.github.com/rest/git/trees#get-a-tree",
  blobs: "https://docs.github.com/rest/git/blobs#get-a-blob",
};

const EMPTY_REPO = "Git Repository is empty.";
/** git's id for "no object". */
const NULL_SHA = "0".repeat(40);

/** The documentation_url GitHub names in an error from this endpoint. */
function docsFor(target: { kind: string }, method: string): string {
  switch (target.kind) {
    case "contents":
      return method === "PUT" ? DOCS.put : DOCS.contents;
    case "blob":
      return DOCS.blobs;
    case "tree":
      return DOCS.trees;
    case "ref":
      return DOCS.ref;
    case "repo":
      return DOCS.repo;
    default:
      return DOCS.rest;
  }
}

interface TreeEntry {
  name: string;
  mode: "100644" | "040000";
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

interface CommitObject {
  sha: string;
  /** The root tree sha. */
  tree: string;
  /** Every file's path and blob sha. */
  files: ReadonlyMap<string, string>;
  /** Each directory's tree sha, keyed by its path ("" is the root). */
  dirs: ReadonlyMap<string, string>;
  parents: string[];
}

interface RepoState {
  info: FakeRepo;
  blobs: Map<string, Uint8Array>;
  trees: Map<string, TreeEntry[]>;
  commitObjects: Map<string, CommitObject>;
  /** The commits `main` has pointed at, oldest first. */
  history: string[];
}

interface Counter {
  used: number;
  /** Unix seconds the window ends. */
  reset: number;
}

interface Budget {
  read: Counter;
  write: Counter;
  /** Times (ms) of content-creating requests, for the secondary limit. */
  writes: number[];
}

/** What a route answers, before conditional handling and rate headers. */
interface Reply {
  status: number;
  json?: unknown;
  raw?: Uint8Array;
  contentType?: string;
  etag?: string;
  cacheControl?: string;
  headers?: Record<string, string>;
}

const encoder = new TextEncoder();

function repoKey(fullName: string): string {
  return fullName.toLowerCase();
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** SHA-1, synchronously, so a PUT's check-and-store needs no await (Web
 * Crypto's digest is async). Used only for git object ids. */
function sha1(data: Uint8Array): string {
  const padded = new Uint8Array((((data.length + 8) >> 6) + 1) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(data.length / 0x20000000));
  view.setUint32(padded.length - 4, (data.length << 3) >>> 0);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** A git object id: SHA-1 of "<type> <size>\0" followed by the body. */
function objectSha(type: "blob" | "tree" | "commit", body: Uint8Array): string {
  return sha1(concat([encoder.encode(`${type} ${body.length}\0`), body]));
}

/** 64 hex digits standing for one of GitHub's weak ETags. */
function etag64(seed: string): string {
  return (sha1(encoder.encode(`0${seed}`)) + sha1(encoder.encode(`1${seed}`))).slice(0, 64);
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
function rateLimitHeaders(remaining: number, used = 5000 - remaining, reset = Math.floor(Date.now() / 1000) + 3600, limit = 5000) {
  return {
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-used": String(used),
    "x-ratelimit-reset": String(reset),
    "x-ratelimit-resource": "core",
  };
}

function errorBody(status: number, message: string, documentationUrl: string) {
  return { message, documentation_url: documentationUrl, status: String(status) };
}

function error(status: number, message: string, documentationUrl: string, headers?: Record<string, string>): Reply {
  return { status, json: errorBody(status, message, documentationUrl), headers };
}

function toResponse(reply: Reply, headers: Record<string, string>): Response {
  const all: Record<string, string> = { ...headers, ...reply.headers };
  if (reply.cacheControl) all["cache-control"] = reply.cacheControl;
  if (reply.etag) all.etag = reply.etag;
  if (reply.raw) {
    return new Response(new Uint8Array(reply.raw), {
      status: reply.status,
      headers: { "content-type": reply.contentType ?? "application/octet-stream", ...all },
    });
  }
  return new Response(JSON.stringify(reply.json), {
    status: reply.status,
    headers: { "content-type": "application/json; charset=utf-8", ...all },
  });
}

/** If-None-Match against an ETag, as GitHub compares them: weak and strong
 * forms match each other, and `*` matches anything. */
function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || strip(tag) === strip(etag));
}

function matches(match: RequestMatch, request: RecordedRequest): boolean {
  if (match.method && match.method.toUpperCase() !== request.method) return false;
  const path = request.path.split("?")[0];
  if (match.path === undefined) return true;
  return typeof match.path === "string" ? path.includes(match.path) : match.path.test(path);
}

type Fault =
  | { kind: "fail"; match: RequestMatch; failure: FakeFailure }
  | { kind: "drop" | "duplicate"; match: RequestMatch }
  | { kind: "late"; match: RequestMatch; after: number };

export function createFakeGitHub({
  apiBase = "https://api.github.com",
  repos = [],
  tokens = {},
  cors = true,
  branchRace = "conflict",
  putLatencyMs = 0,
  rateLimit = 5000,
  treeEntryLimit = TREE_ENTRY_LIMIT,
  now = () => Date.now(),
}: {
  apiBase?: string;
  repos?: FakeRepo[];
  tokens?: Record<string, FakeToken>;
  cors?: boolean;
  /** What a PUT does when another commit moved the branch since it
   * arrived and its own file is unchanged: "conflict" (409 "is at … but
   * expected …", what GitHub did 22 times in 23) or "rebase" (applied on
   * the new head, what it did once). */
  branchRace?: "conflict" | "rebase";
  /** How long a PUT is in flight: it is checked against the head as it
   * arrived, but applied only this many ms later, so PUTs sent within that
   * window race as they did on GitHub (about 1.5 s a PUT there). 0, the
   * default, applies it in the same tick, so only PUTs sent in the same
   * synchronous section race. Real timers: don't combine it with
   * vi.useFakeTimers unless the test advances them. */
  putLatencyMs?: number;
  /** Requests an hour, per counter. */
  rateLimit?: number;
  /** Entries a tree response holds before it sets `truncated`. */
  treeEntryLimit?: number;
  /** The clock rate limits and token expiry are measured on (ms). Default
   * Date.now; a simulation that runs hours of device time in seconds
   * passes its own, so GitHub's per-minute and per-hour limits follow it. */
  now?: () => number;
} = {}): FakeGitHub {
  const base = apiBase.replace(/\/+$/, "");
  const repoStates = new Map<string, RepoState>();
  const grants = new Map<string, FakeToken>();
  const budgets = new Map<string, Budget>();
  /** Requests with no token. GitHub counts them by IP; the fake has one. */
  const anonymous: Counter = { used: 0, reset: 0 };
  const faults: Fault[] = [];
  const late: { request: RecordedRequest; remaining: number }[] = [];
  const requests: RecordedRequest[] = [];
  const unhandled: RecordedRequest[] = [];
  const commits: FakeCommit[] = [];
  const violations: string[] = [];
  let lag = 0;
  let commitCounter = 0;
  let treeCut: number | null = null;

  const addRepo = (info: FakeRepo) => {
    repoStates.set(repoKey(`${info.owner}/${info.name}`), {
      info: { ...info },
      blobs: new Map(),
      trees: new Map(),
      commitObjects: new Map(),
      history: [],
    });
  };
  repos.forEach(addRepo);
  for (const [token, grant] of Object.entries(tokens)) grants.set(token, grant);

  function repoState(fullName: string): RepoState {
    const state = repoStates.get(repoKey(fullName));
    if (!state) throw new Error(`fakeGitHub: no repo ${fullName}`);
    return state;
  }

  const headOf = (state: RepoState): string | null => state.history.at(-1) ?? null;
  /** The head a branch-named read sees: `lag` commits back while
   * staleReads is on (null, an empty repo, before the first commit). */
  const visibleHeadOf = (state: RepoState): string | null => state.history[state.history.length - 1 - lag] ?? null;
  const filesAt = (state: RepoState, commit: string | null): ReadonlyMap<string, string> =>
    commit === null ? new Map() : state.commitObjects.get(commit)!.files;

  function storeBlob(state: RepoState, bytes: Uint8Array): string {
    const sha = objectSha("blob", bytes);
    state.blobs.set(sha, bytes);
    return sha;
  }

  /** Hashes every directory of `files` as a git tree object. */
  function writeTrees(state: RepoState, files: ReadonlyMap<string, string>): { root: string; dirs: Map<string, string> } {
    type Dir = Map<string, string | Dir>;
    const root: Dir = new Map();
    for (const [path, sha] of files) {
      const parts = path.split("/");
      let dir = root;
      for (const part of parts.slice(0, -1)) {
        let next = dir.get(part);
        if (typeof next !== "object") {
          next = new Map();
          dir.set(part, next);
        }
        dir = next;
      }
      dir.set(parts.at(-1)!, sha);
    }
    const dirs = new Map<string, string>();
    const write = (dir: Dir, prefix: string): string => {
      const entries: TreeEntry[] = [...dir].map(([name, node]) =>
        typeof node === "string"
          ? { name, mode: "100644", type: "blob", sha: node, size: state.blobs.get(node)!.length }
          : { name, mode: "040000", type: "tree", sha: write(node, prefix === "" ? name : `${prefix}/${name}`) },
      );
      // Git's order: by name, with a directory compared as "name/".
      const key = (e: TreeEntry) => (e.type === "tree" ? `${e.name}/` : e.name);
      entries.sort((x, y) => (key(x) < key(y) ? -1 : 1));
      const body = concat(
        entries.flatMap((e) => [encoder.encode(`${e.type === "tree" ? "40000" : e.mode} ${e.name}\0`), hexToBytes(e.sha)]),
      );
      const sha = objectSha("tree", body);
      state.trees.set(sha, entries);
      dirs.set(prefix, sha);
      return sha;
    };
    return { root: write(root, ""), dirs };
  }

  /** Commits `changes` on top of `parent` and moves `main` to it: each path
   * to its new blob sha, or null to delete it. */
  function commit(state: RepoState, parent: string | null, changes: Map<string, string | null>, message: string): CommitObject {
    const files = new Map(filesAt(state, parent));
    for (const [path, sha] of changes) {
      if (sha === null) files.delete(path);
      else files.set(path, sha);
    }
    const { root, dirs } = writeTrees(state, files);
    const parents = parent === null ? [] : [parent];
    commitCounter++;
    const body = [
      `tree ${root}`,
      ...parents.map((p) => `parent ${p}`),
      `author Fake <fake@example.com> ${commitCounter} +0000`,
      `committer Fake <fake@example.com> ${commitCounter} +0000`,
      "",
      message,
    ].join("\n");
    const object: CommitObject = { sha: objectSha("commit", encoder.encode(body)), tree: root, files, dirs, parents };
    state.commitObjects.set(object.sha, object);
    state.history.push(object.sha);
    return object;
  }

  function seed(fullName: string, texts: Record<string, string>): Record<string, string> {
    const state = repoState(fullName);
    const shas: Record<string, string> = {};
    const changes = new Map<string, string>();
    for (const [path, text] of Object.entries(texts)) {
      shas[path] = storeBlob(state, encoder.encode(text));
      changes.set(path, shas[path]);
    }
    commit(state, headOf(state), changes, "Seed");
    return shas;
  }

  function budgetFor(login: string): Budget {
    let budget = budgets.get(login);
    if (!budget) {
      budget = { read: { used: 0, reset: 0 }, write: { used: 0, reset: 0 }, writes: [] };
      budgets.set(login, budget);
    }
    const nowSeconds = Math.floor(now() / 1000);
    for (const counter of [budget.read, budget.write]) {
      if (nowSeconds >= counter.reset) {
        counter.used = 0;
        counter.reset = nowSeconds + 3600;
      }
    }
    return budget;
  }

  /** Counts one request with no token and returns its rate headers. Ledger
   * always sends a token, so running past the limit is not modelled. */
  function anonymousHeaders(): Record<string, string> {
    const nowSeconds = Math.floor(now() / 1000);
    if (nowSeconds >= anonymous.reset) {
      anonymous.used = 0;
      anonymous.reset = nowSeconds + 3600;
    }
    anonymous.used++;
    const remaining = Math.max(0, UNAUTHENTICATED_LIMIT - anonymous.used);
    return rateLimitHeaders(remaining, anonymous.used, anonymous.reset, UNAUTHENTICATED_LIMIT);
  }

  const counterHeaders = (counter: Counter) =>
    rateLimitHeaders(Math.max(0, rateLimit - counter.used), counter.used, counter.reset, rateLimit);

  /** The grant behind an Authorization header, unless the token is
   * unknown, revoked or expired. */
  function validGrant(authorization: string | undefined): FakeToken | undefined {
    const token = authorization?.match(/^(?:Bearer|token)\s+(.+)$/i)?.[1];
    const grant = token === undefined ? undefined : grants.get(token);
    return grant && !(grant.expiresAt && Date.parse(grant.expiresAt) <= now()) ? grant : undefined;
  }

  /** The token's read or write counter for an authenticated request, as
   * handle() resolves it, or null when GitHub would not count it (no token,
   * or one it refuses). */
  function counterFor(request: RecordedRequest): Counter | null {
    const grant = validGrant(request.headers.authorization);
    if (!grant) return null;
    const budget = budgetFor(grant.login);
    return request.method === "GET" ? budget.read : budget.write;
  }

  /** An injected failure, counted and with GitHub's rate headers like any
   * error on an authenticated request. A 401 is GitHub refusing the token,
   * so it is neither. */
  function failureResponse(failure: Exclude<FakeFailure, { network: true }>, request: RecordedRequest): Response {
    const counter = failure.status === 401 ? null : counterFor(request);
    if (counter && !(failure.status === 403 && failure.rateLimit === "primary")) counter.used++;
    const counted = counter ? counterHeaders(counter) : {};
    const secondary = { ...(counter ? counted : rateLimitHeaders(4990, undefined, Math.floor(now() / 1000) + 3600)), "retry-after": "60" };
    const reply = (status: number, message: string, headers?: Record<string, string>) =>
      toResponse(error(status, message, DOCS.rest), headers ?? counted);
    switch (failure.status) {
      case 401:
        return reply(401, failure.message ?? "Bad credentials");
      case 403:
        if (failure.rateLimit === "primary") {
          // The hour spent, with its window ending in a minute.
          const spent = {
            ...rateLimitHeaders(0, rateLimit, Math.floor(now() / 1000) + 3600, rateLimit),
            "x-ratelimit-reset": String(Math.floor(now() / 1000) + 60),
          };
          return reply(403, failure.message ?? "API rate limit exceeded", spent);
        }
        if (failure.rateLimit === "secondary") {
          return reply(403, failure.message ?? "You have exceeded a secondary rate limit.", secondary);
        }
        return reply(403, failure.message ?? "Resource not accessible by personal access token");
      case 404:
        return reply(404, failure.message ?? "Not Found");
      case 409:
        return reply(409, failure.message ?? `is at ${"0".repeat(40)} but expected ${"1".repeat(40)}`);
      case 422:
        return reply(422, failure.message ?? 'Invalid request.\n\n"sha" wasn\'t supplied.');
      case 429:
        return reply(429, failure.message ?? "Too many requests", secondary);
      case 500:
        return reply(500, failure.message ?? "Server Error");
    }
  }

  async function record(input: RequestInfo | URL, init: RequestInit | undefined, device: string | undefined) {
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
      keepalive: init?.keepalive ?? req?.keepalive,
      body,
      device,
    };
    requests.push(request);
    return request;
  }

  type Route =
    | { kind: "user" }
    | { kind: "repo"; repo: string }
    | { kind: "contents"; repo: string; path: string }
    | { kind: "blob"; repo: string; sha: string }
    | { kind: "tree"; repo: string; ref: string }
    | { kind: "ref"; repo: string; branch: string };

  function route(request: RecordedRequest): Route | null {
    if (!request.path.startsWith("/")) return null;
    const [path] = request.path.split("?");
    const segments = path.split("/").slice(1).map(decodeURIComponent);
    const method = request.method;
    if (method === "GET" && path === "/user") return { kind: "user" };
    if (segments[0] !== "repos" || segments.length < 3) return null;
    const repo = `${segments[1]}/${segments[2]}`;
    if (method === "GET" && segments.length === 3) return { kind: "repo", repo };
    if ((method === "GET" || method === "PUT") && segments[3] === "contents" && segments.length > 4) {
      return { kind: "contents", repo, path: segments.slice(4).join("/").replace(/\/+$/, "") };
    }
    if (method !== "GET" || segments[3] !== "git") return null;
    if (segments[4] === "blobs" && segments.length === 6) return { kind: "blob", repo, sha: segments[5] };
    // GitHub also accepts `{commitSha}:{path}` (section 9); Ledger never
    // sends it, so it is left unmodelled rather than answered as a bad ref.
    if (segments[4] === "trees" && segments.length === 6 && !segments[5].includes(":")) {
      return { kind: "tree", repo, ref: segments[5] };
    }
    if (segments[4] === "ref" && segments[5] === "heads" && segments.length > 6) {
      return { kind: "ref", repo, branch: segments.slice(6).join("/") };
    }
    return null;
  }

  /** Answers one request. `arrivalHead` is the branch head when it arrived:
   * a PUT is applied against it. Synchronous, so nothing interleaves
   * between a PUT's checks and its commit. */
  function handle(request: RecordedRequest, arrivalHead: (repo: string) => string | null): Response {
    const method = request.method;
    if (method === "DELETE") violations.push(`DELETE ${request.path}`);
    const target = route(request);
    if (!target) {
      unhandled.push(request);
      return toResponse({ status: 501, json: { message: `fakeGitHub does not model ${method} ${request.path}` } }, {});
    }

    // Authentication, as GitHub: no token is anonymous, which can't see a
    // private repo (404, recorded) or a public one (not recorded; Ledger
    // never reads one), and is counted against the unauthenticated limit of
    // 60. An unknown, revoked or expired token is 401.
    const authorization = request.headers.authorization;
    if (authorization === undefined) {
      if (target.kind === "user") return toResponse(error(401, "Requires authentication", DOCS.rest), anonymousHeaders());
      return toResponse(error(404, "Not Found", docsFor(target, method)), anonymousHeaders());
    }
    const grant = validGrant(authorization);
    if (!grant) return toResponse(error(401, "Bad credentials", DOCS.rest), {});

    // Rate limits: GETs and writes count separately; 304s don't count.
    const budget = budgetFor(grant.login);
    const counter = method === "GET" ? budget.read : budget.write;
    const common: Record<string, string> = {};
    if (grant.expiresAt) common["github-authentication-token-expiration"] = expirationHeader(grant.expiresAt);
    if (counter.used >= rateLimit) {
      return toResponse(error(403, "API rate limit exceeded", DOCS.rest), { ...common, ...counterHeaders(counter) });
    }
    if (method === "PUT") {
      const at = now();
      budget.writes = budget.writes.filter((t) => at - t < 3_600_000);
      const lastMinute = budget.writes.filter((t) => at - t < 60_000).length;
      if (lastMinute >= SECONDARY_PER_MINUTE || budget.writes.length >= SECONDARY_PER_HOUR) {
        counter.used++;
        return toResponse(error(403, "You have exceeded a secondary rate limit.", DOCS.rest), {
          ...common,
          ...counterHeaders(counter),
          "retry-after": "60",
        });
      }
      budget.writes.push(at);
    }

    const reply = answer(request, target, grant, arrivalHead);
    const ifNoneMatch = request.headers["if-none-match"];
    if (method === "GET" && reply.status === 200 && reply.etag && ifNoneMatch !== undefined && etagMatches(ifNoneMatch, reply.etag)) {
      // Uncounted, with no body, and the ETag in its strong form.
      return new Response(null, {
        status: 304,
        headers: {
          ...common,
          ...counterHeaders(counter),
          etag: reply.etag.replace(/^W\//, ""),
          ...(reply.cacheControl ? { "cache-control": reply.cacheControl } : {}),
        },
      });
    }
    counter.used++;
    return toResponse(reply, { ...common, ...counterHeaders(counter) });
  }

  function answer(request: RecordedRequest, target: Route, grant: FakeToken, arrivalHead: (repo: string) => string | null): Reply {
    if (target.kind === "user") return { status: 200, json: { login: grant.login } };

    // A repo the token can't reach looks exactly like a missing one.
    const state = repoStates.get(repoKey(target.repo));
    if (!state || !grant.repos.some((r) => repoKey(r) === repoKey(target.repo))) {
      return error(404, "Not Found", docsFor(target, request.method));
    }
    const fullName = `${state.info.owner}/${state.info.name}`;
    const api = `${base}/repos/${fullName}`;
    const accept = request.headers.accept ?? "";
    const wantsRaw = accept.includes("vnd.github.raw");
    const query = new URLSearchParams(request.path.split("?")[1] ?? "");

    if (target.kind === "repo") {
      const { owner, name } = state.info;
      return {
        status: 200,
        json: { name, full_name: fullName, owner: { login: owner }, private: state.info.private, default_branch: BRANCH },
      };
    }

    if (target.kind === "ref") {
      const head = visibleHeadOf(state);
      if (head === null) return error(409, EMPTY_REPO, DOCS.ref);
      if (target.branch !== BRANCH) return error(404, "Not Found", DOCS.ref);
      return {
        status: 200,
        json: {
          ref: `refs/heads/${BRANCH}`,
          node_id: `REF_${etag64(fullName).slice(0, 24)}`,
          url: `${api}/git/refs/heads/${BRANCH}`,
          object: { sha: head, type: "commit", url: `${api}/git/commits/${head}` },
        },
        // Weak, and different per Accept, as GitHub's.
        etag: `W/"${etag64(`${head}\n${accept}`)}"`,
        cacheControl: CACHE_SHORT,
      };
    }

    if (target.kind === "blob") {
      if (headOf(state) === null) return error(409, EMPTY_REPO, DOCS.blobs);
      if (!/^[0-9a-f]{40}$/.test(target.sha)) {
        return error(422, "The sha parameter must be exactly 40 characters and contain only [0-9a-f].", DOCS.blobs);
      }
      const bytes = state.blobs.get(target.sha);
      if (!bytes) return error(404, "Not Found", DOCS.blobs);
      const etag = `W/"${etag64(`${target.sha}\n${accept}`)}"`;
      if (wantsRaw) return { status: 200, raw: bytes, contentType: "text/plain; charset=utf-8", etag, cacheControl: CACHE_LONG };
      return {
        status: 200,
        json: {
          sha: target.sha,
          node_id: `B_${target.sha.slice(0, 24)}`,
          size: bytes.length,
          url: `${api}/git/blobs/${target.sha}`,
          content: wrap60(bytesToBase64(bytes)),
          encoding: "base64",
        },
        etag,
        cacheControl: CACHE_LONG,
      };
    }

    if (target.kind === "tree") {
      if (headOf(state) === null) return error(409, EMPTY_REPO, DOCS.trees);
      let treeSha: string | undefined;
      let byBranch = false;
      if (state.trees.has(target.ref)) treeSha = target.ref;
      else if (state.commitObjects.has(target.ref)) treeSha = state.commitObjects.get(target.ref)!.tree;
      else if (target.ref === BRANCH) {
        // A stale view from before the first commit sees an empty repo, as
        // the ref read does.
        const head = visibleHeadOf(state);
        if (head === null) return error(409, EMPTY_REPO, DOCS.trees);
        treeSha = state.commitObjects.get(head)!.tree;
        byBranch = true;
      }
      if (treeSha === undefined) return error(404, "Not Found", DOCS.trees);
      const entries: object[] = [];
      const list = (sha: string, prefix: string, recursive: boolean) => {
        for (const e of state.trees.get(sha)!) {
          const path = prefix + e.name;
          entries.push(
            e.type === "blob"
              ? { path, mode: e.mode, type: e.type, sha: e.sha, size: e.size, url: `${api}/git/blobs/${e.sha}` }
              : { path, mode: e.mode, type: e.type, sha: e.sha, url: `${api}/git/trees/${e.sha}` },
          );
          if (recursive && e.type === "tree") list(e.sha, `${path}/`, true);
        }
      };
      list(treeSha, "", query.has("recursive"));
      const limit = treeCut ?? treeEntryLimit;
      const truncated = entries.length > limit;
      return {
        status: 200,
        json: { sha: treeSha, url: `${api}/git/trees/${treeSha}`, tree: truncated ? entries.slice(0, limit) : entries, truncated },
        etag: `W/"${etag64(`${treeSha}\n${accept}`)}"`,
        cacheControl: byBranch ? CACHE_SHORT : CACHE_LONG,
      };
    }

    // Contents.
    const path = target.path;
    const fileUrls = (p: string, sha: string, type: "file" | "dir") => {
      const self = `${api}/contents/${p}?ref=${BRANCH}`;
      const git = `${api}/git/${type === "file" ? "blobs" : "trees"}/${sha}`;
      const html = `https://github.com/${fullName}/${type === "file" ? "blob" : "tree"}/${BRANCH}/${p}`;
      return {
        url: self,
        html_url: html,
        git_url: git,
        download_url: type === "file" ? `https://raw.githubusercontent.com/${fullName}/${BRANCH}/${p}?token=FAKE` : null,
        _links: { self, git, html },
      };
    };

    if (request.method === "GET") {
      const ref = query.get("ref");
      let at: CommitObject | null;
      if (ref === null || ref === BRANCH) {
        const head = visibleHeadOf(state);
        if (head === null) return error(404, "This repository is empty.", DOCS.contentsEmpty);
        at = state.commitObjects.get(head)!;
      } else {
        if (headOf(state) === null) return error(404, "This repository is empty.", DOCS.contentsEmpty);
        at = state.commitObjects.get(ref) ?? null;
        if (!at) return error(404, `No commit found for the ref ${ref}`, DOCS.contentsRef);
      }
      const blob = at.files.get(path);
      if (blob !== undefined) {
        const bytes = state.blobs.get(blob)!;
        const etag = `"${blob}"`;
        if (wantsRaw) {
          const contentType = accept.includes("raw+json")
            ? "application/vnd.github.raw+json; charset=utf-8"
            : "application/vnd.github.raw; charset=utf-8";
          return { status: 200, raw: bytes, contentType, etag, cacheControl: CACHE_SHORT };
        }
        const inline = bytes.length < INLINE_BELOW;
        return {
          status: 200,
          json: {
            name: path.split("/").pop(),
            path,
            sha: blob,
            size: bytes.length,
            ...fileUrls(path, blob, "file"),
            type: "file",
            content: inline ? wrap60(bytesToBase64(bytes)) : "",
            encoding: inline ? "base64" : "none",
          },
          etag,
          cacheControl: CACHE_SHORT,
        };
      }
      const dirSha = at.dirs.get(path);
      if (dirSha === undefined) return error(404, "Not Found", DOCS.contents);
      // Sorted by name, and silently cut at 1,000 entries (section 8).
      const listing = state.trees
        .get(dirSha)!
        .map((e) => {
          const p = path === "" ? e.name : `${path}/${e.name}`;
          const type = e.type === "blob" ? "file" : "dir";
          return { name: e.name, path: p, sha: e.sha, size: e.size ?? 0, ...fileUrls(p, e.sha, type), type };
        })
        .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
        .slice(0, LISTING_CAP);
      // Strong, and the root tree's sha, so any change in the repo changes it.
      return { status: 200, json: listing, etag: `"${at.tree}"`, cacheControl: CACHE_SHORT };
    }

    // PUT contents
    if (grant.permission !== "write") return error(403, "Resource not accessible by personal access token", DOCS.put);
    let payload: { message?: unknown; content?: unknown; sha?: unknown };
    try {
      payload = JSON.parse(request.body ?? "");
    } catch {
      return error(400, "Problems parsing JSON", DOCS.put);
    }
    if (typeof payload.message !== "string") return error(422, 'Invalid request.\n\n"message" wasn\'t supplied.', DOCS.put);
    let bytes: Uint8Array;
    try {
      if (typeof payload.content !== "string") throw new Error("no content");
      bytes = base64ToBytes(payload.content);
    } catch {
      return error(422, "content is not valid Base64", DOCS.put);
    }
    if (request.device !== undefined && !ownsPath(request.device, path, payload.sha)) {
      violations.push(`${request.device} wrote ${path}`);
      return error(403, "fakeGitHub: a device may write only its own files", DOCS.put);
    }

    // Checked against the head the request arrived at, as GitHub does.
    const based = arrivalHead(fullName);
    const baseSha = filesAt(state, based).get(path);
    if (baseSha !== undefined && payload.sha === undefined) {
      return error(422, 'Invalid request.\n\n"sha" wasn\'t supplied.', DOCS.put);
    }
    // A sha sent for a path that doesn't exist is ignored (201).
    if (baseSha !== undefined && payload.sha !== baseSha) {
      return error(409, `${path} does not match ${String(payload.sha)}`, DOCS.put);
    }
    const head = headOf(state);
    let parent = based;
    if (head !== based) {
      // The branch moved while this request was in flight.
      const untouched = filesAt(state, head).get(path) === baseSha;
      // On an empty repo there was no head to expect. GitHub's answer to two
      // first commits at once was never probed; git's null id keeps the
      // recorded 40-hex shape (github-api-behaviour.md section 19).
      if (branchRace === "conflict" || !untouched) {
        return error(409, `is at ${head} but expected ${based ?? NULL_SHA}`, DOCS.put);
      }
      parent = head;
    }
    // Git can't hold a file and a directory at one path. GitHub's answer to
    // such a PUT was never recorded, so it fails as unmodelled rather than
    // committing a tree that contradicts its own file map.
    if (pathClashes(state, based, path) || pathClashes(state, parent, path)) {
      unhandled.push(request);
      return { status: 501, json: { message: `fakeGitHub does not model a PUT whose path is a directory or under a file: ${path}` } };
    }
    const sha = storeBlob(state, bytes);
    const made = commit(state, parent, new Map([[path, sha]]), payload.message);
    commits.push({ repo: fullName, path, message: payload.message, sha, commit: made.sha, parent });
    const author = { name: "Fake", email: "fake@example.com", date: new Date().toISOString().slice(0, 19) + "Z" };
    return {
      status: baseSha === undefined ? 201 : 200,
      json: {
        content: { name: path.split("/").pop(), path, sha, size: bytes.length, ...fileUrls(path, sha, "file"), type: "file" },
        commit: {
          sha: made.sha,
          node_id: `C_${made.sha.slice(0, 24)}`,
          url: `${api}/git/commits/${made.sha}`,
          html_url: `https://github.com/${fullName}/commit/${made.sha}`,
          author,
          committer: author,
          tree: { sha: made.tree, url: `${api}/git/trees/${made.tree}` },
          message: payload.message,
          parents: made.parents.map((p) => ({
            sha: p,
            url: `${api}/git/commits/${p}`,
            html_url: `https://github.com/${fullName}/commit/${p}`,
          })),
          verification: { verified: false, reason: "unsigned", signature: null, payload: null, verified_at: null },
        },
      },
    };
  }

  /** Whether `path` is a directory, or lies under a file, at `at`. */
  function pathClashes(state: RepoState, at: string | null, path: string): boolean {
    if (at === null) return false;
    const { files, dirs } = state.commitObjects.get(at)!;
    if (dirs.has(path)) return true;
    const parts = path.split("/");
    return parts.slice(1).some((_, i) => files.has(parts.slice(0, i + 1).join("/")));
  }

  /** Design section 6: a device writes only `ledger/<epoch>.<its id>.*`,
   * plus a genesis it creates. */
  function ownsPath(device: string, path: string, sha: unknown): boolean {
    if (!path.startsWith("ledger/")) return false;
    const file = parseRepoFileName(path.slice("ledger/".length));
    if (!file) return false;
    return file.kind === "genesis" ? sha === undefined : file.device === device;
  }

  function takeFault(request: RecordedRequest): Fault | undefined {
    const i = faults.findIndex((f) => matches(f.match, request));
    return i < 0 ? undefined : faults.splice(i, 1)[0];
  }

  const currentHead = (repo: string) => headOf(repoState(repo));

  /** Counts down requests held by landLater, landing those that are due. */
  function tick() {
    for (const held of [...late]) {
      if (--held.remaining <= 0) {
        late.splice(late.indexOf(held), 1);
        handle(held.request, currentHead);
      }
    }
  }

  function corsRefuses(request: RecordedRequest): boolean {
    return Object.keys(request.headers).some((name) => !PREFLIGHT_ALLOWED_HEADERS.has(name));
  }

  async function fakeFetch(input: RequestInfo | URL, init: RequestInit | undefined, device: string | undefined): Promise<Response> {
    // The head each repo had when the request arrived, before any await.
    const arrived = new Map([...repoStates].map(([key, state]) => [key, headOf(state)]));
    const arrivalHead = (repo: string) => arrived.get(repoKey(repo)) ?? null;
    const request = await record(input, init, device);
    if (cors && corsRefuses(request)) throw new TypeError("Failed to fetch");
    const fault = takeFault(request);
    // A PUT stays in flight for putLatencyMs, keeping its arrival head.
    if (putLatencyMs > 0 && request.method === "PUT" && (fault === undefined || fault.kind === "drop" || fault.kind === "duplicate")) {
      await new Promise((resolve) => setTimeout(resolve, putLatencyMs));
    }
    let res: Response;
    switch (fault?.kind) {
      case "fail":
        if ("network" in fault.failure) {
          tick();
          throw new TypeError("Failed to fetch");
        }
        res = failureResponse(fault.failure, request);
        break;
      case "drop":
        handle(request, arrivalHead);
        tick();
        throw new TypeError("Failed to fetch");
      case "late":
        tick();
        late.push({ request, remaining: fault.after });
        throw new DOMException("The operation timed out.", "TimeoutError");
      case "duplicate":
        handle(request, arrivalHead);
        res = handle(request, currentHead);
        break;
      default:
        res = handle(request, arrivalHead);
    }
    tick();
    return cors ? asBrowserSeesIt(res) : res;
  }

  return {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => fakeFetch(input, init, undefined)) as typeof fetch,
    fetchAs(device) {
      return ((input: RequestInfo | URL, init?: RequestInit) => fakeFetch(input, init, device)) as typeof fetch;
    },
    requests,
    unhandled,
    commits,
    violations,
    addRepo,
    setToken(token, grant) {
      grants.set(token, grant);
    },
    revokeToken(token) {
      grants.delete(token);
    },
    async seedFile(repo, path, text) {
      return seed(repo, { [path]: text })[path];
    },
    async seedFiles(repo, files) {
      return seed(repo, files);
    },
    removeFile(repo, path) {
      const state = repoState(repo);
      const head = headOf(state);
      if (!filesAt(state, head).has(path)) throw new Error(`No file ${path} to remove`);
      commit(state, head, new Map([[path, null]]), "Delete");
    },
    file(repo, path) {
      const state = repoState(repo);
      const sha = filesAt(state, headOf(state)).get(path);
      if (sha === undefined) return null;
      return { text: new TextDecoder().decode(state.blobs.get(sha)), sha };
    },
    head(repo) {
      return headOf(repoState(repo));
    },
    failNext(failure) {
      faults.push({ kind: "fail", match: { method: failure.method, path: failure.path }, failure });
    },
    landThenDropResponse(match = {}) {
      faults.push({ kind: "drop", match });
    },
    landLater(afterRequests, match = {}) {
      faults.push({ kind: "late", match, after: afterRequests });
    },
    landPending() {
      for (const held of late.splice(0)) handle(held.request, currentHead);
    },
    duplicateRequest(match = {}) {
      faults.push({ kind: "duplicate", match });
    },
    staleReads(n) {
      lag = Math.max(0, Math.floor(n));
    },
    cutTrees(limit) {
      treeCut = limit === null ? null : Math.max(0, Math.floor(limit));
    },
    versions(repo) {
      const state = repoState(repo);
      const out = new Map<string, { path: string; sha: string; text: string }>();
      for (const commitSha of state.history) {
        for (const [path, sha] of state.commitObjects.get(commitSha)!.files) {
          const key = `${path}@${sha}`;
          if (!out.has(key)) out.set(key, { path, sha, text: new TextDecoder().decode(state.blobs.get(sha)) });
        }
      }
      return [...out.values()];
    },
  };
}
