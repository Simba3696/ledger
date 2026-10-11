import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptDocument, DEFAULT_ITERATIONS, deriveKey, encryptDocument, newSalt, WrongPassphraseError } from "../crypto";
import recorded from "./__fixtures__/github-behaviour.json";
import {
  classifyToken,
  createGitHubClient,
  deviceCommitMessage,
  EmptyRepoError,
  getLogin,
  gitBlobSha,
  GitHubAuthError,
  GitHubError,
  GitHubForbiddenError,
  GitHubNetworkError,
  GitHubRateLimitError,
  PublicRepoError,
  RepoNotFoundError,
  ShaConflictError,
} from "./contents";
import { createFakeGitHub, type FakeGitHub } from "./fakeGitHub";

// The contents client against the in-memory fake GitHub API. Fictional
// owner, repo and tokens only.

const REPO = "alex/ledger-data";
const WRITE = "github_pat_write";
const READ = "github_pat_read";
const NO_EXPIRY = "github_pat_noexpiry";
// A year from now, in whole seconds so it survives GitHub's header format.
// A fixed date would turn every test using these tokens into a 401 once it
// passed.
const EXPIRES = new Date(Math.floor(Date.now() / 1000 + 365 * 86_400) * 1000).toISOString();

let fake: FakeGitHub;

beforeEach(() => {
  fake = createFakeGitHub({
    repos: [
      { owner: "alex", name: "ledger-data", private: true },
      { owner: "alex", name: "blog", private: false },
      { owner: "sam", name: "ledger-data", private: true },
    ],
    tokens: {
      [WRITE]: { login: "alex", repos: [REPO, "alex/blog"], permission: "write", expiresAt: EXPIRES },
      [READ]: { login: "alex", repos: [REPO], permission: "read", expiresAt: EXPIRES },
      [NO_EXPIRY]: { login: "alex", repos: [REPO], permission: "write" },
    },
  });
});

function client(options: Partial<Parameters<typeof createGitHubClient>[0]> = {}) {
  return createGitHubClient({ token: WRITE, owner: "alex", repo: "ledger-data", fetch: fake.fetch, ...options });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

describe("contents client", () => {
  it("reads null from an empty repo after verifying it", async () => {
    const gh = client();
    await gh.verifyRepo();
    expect(await gh.readFile()).toBeNull();
    expect(fake.unhandled).toEqual([]);
  });

  it("creates the file, reads it back, and updates it with its sha", async () => {
    const gh = client();
    const sha1 = await gh.writeFile("first version", null);
    expect(sha1).toMatch(/^[0-9a-f]{40}$/);
    // The real git blob id of "first version" (`git hash-object`).
    expect(sha1).toBe("bde942a2105e7746b71aea43d5b29f539937d18e");
    expect(await gh.readFile()).toEqual({ text: "first version", sha: sha1 });

    const sha2 = await gh.writeFile("second version", sha1);
    expect(sha2).not.toBe(sha1);
    expect(await gh.readFile()).toEqual({ text: "second version", sha: sha2 });
    expect(fake.file(REPO, "ledger.json.enc")).toEqual({ text: "second version", sha: sha2 });
  });

  it("throws ShaConflictError for a stale sha (409) and leaves the file unchanged", async () => {
    const gh = client();
    const sha1 = await gh.writeFile("first version", null);
    const sha2 = await gh.writeFile("second version", sha1);

    const err = await rejection(gh.writeFile("lost update", sha1));
    expect(err).toBeInstanceOf(ShaConflictError);
    expect((err as ShaConflictError).status).toBe(409);
    expect(fake.file(REPO, "ledger.json.enc")).toEqual({ text: "second version", sha: sha2 });

    fake.failNext({ status: 409, method: "PUT" });
    await expect(gh.writeFile("lost update", sha2)).rejects.toBeInstanceOf(ShaConflictError);
    expect(fake.file(REPO, "ledger.json.enc")).toEqual({ text: "second version", sha: sha2 });
  });

  it("throws ShaConflictError for a 422 about the sha and leaves the file unchanged", async () => {
    const gh = client();
    const sha = await gh.writeFile("first version", null);

    // Creating over an existing file: GitHub answers 422 "sha" wasn't supplied.
    const err = await rejection(gh.writeFile("lost create", null));
    expect(err).toBeInstanceOf(ShaConflictError);
    expect((err as ShaConflictError).status).toBe(422);

    fake.failNext({ status: 422, method: "PUT" });
    await expect(gh.writeFile("lost update", sha)).rejects.toBeInstanceOf(ShaConflictError);
    expect(fake.file(REPO, "ledger.json.enc")).toEqual({ text: "first version", sha });

    // A 422 about something else is not a conflict.
    fake.failNext({ status: 422, method: "PUT", message: "Invalid request.\n\n\"content\" wasn't supplied." });
    const other = await rejection(gh.writeFile("x", sha));
    expect(other).toBeInstanceOf(GitHubError);
    expect(other).not.toBeInstanceOf(ShaConflictError);
  });

  it("commits with a fixed message only", async () => {
    const gh = client();
    const sha = await gh.writeFile("v1", null);
    await gh.writeFile("v2", sha, "Restore from backup");
    expect(fake.commits.map((c) => c.message)).toEqual(["Update ledger.json.enc", "Restore from backup"]);
    // No branch (the default branch only) and nothing beyond the file itself.
    const bodies = fake.requests.filter((r) => r.method === "PUT").map((r) => JSON.parse(r.body!) as object);
    expect(bodies.map((b) => Object.keys(b).sort())).toEqual([
      ["content", "message"],
      ["content", "message", "sha"],
    ]);
  });

  it("reads a file over 1 MB through the blobs route, byte for byte", async () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const big = `{"v":1}\n${Array.from({ length: 1_500_000 }, (_, i) => chars[(i * 7 + (i >> 5)) % 64]).join("")}`;
    const sha = await fake.seedFile(REPO, "ledger.json.enc", big);

    const file = await client().readFile();
    expect(file?.sha).toBe(sha);
    expect(file?.text.length).toBe(big.length);
    expect(file?.text === big).toBe(true);
    const blobRead = fake.requests.find((r) => r.path === `/repos/alex/ledger-data/git/blobs/${sha}`);
    expect(blobRead?.headers.accept).toBe("application/vnd.github.raw+json");
  });

  it("maps 401, 403, rate limits, 404, public repos and network failures to typed errors", async () => {
    await expect(client({ token: "github_pat_unknown" }).readFile()).rejects.toBeInstanceOf(GitHubAuthError);

    const forbidden = await rejection(client({ token: READ }).writeFile("x", null));
    expect(forbidden).toBeInstanceOf(GitHubForbiddenError);
    expect((forbidden as GitHubForbiddenError).message).toBe("Resource not accessible by personal access token");
    expect((forbidden as GitHubForbiddenError).status).toBe(403);

    fake.failNext({ status: 403, rateLimit: "primary" });
    await expect(client().readFile()).rejects.toBeInstanceOf(GitHubRateLimitError);
    fake.failNext({ status: 429 });
    await expect(client().readFile()).rejects.toBeInstanceOf(GitHubRateLimitError);

    await expect(client({ owner: "sam" }).verifyRepo()).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(client({ repo: "missing" }).verifyRepo()).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(client({ repo: "blog" }).verifyRepo()).rejects.toBeInstanceOf(PublicRepoError);

    fake.failNext({ network: true });
    await expect(client().readFile()).rejects.toBeInstanceOf(GitHubNetworkError);
    const timeout = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(client({ fetch: timeout }).readFile()).rejects.toBeInstanceOf(GitHubNetworkError);
    const typed = [
      GitHubAuthError,
      GitHubForbiddenError,
      GitHubRateLimitError,
      RepoNotFoundError,
      PublicRepoError,
      ShaConflictError,
      EmptyRepoError,
      GitHubNetworkError,
    ];
    for (const ErrorType of typed) {
      expect(ErrorType.prototype).toBeInstanceOf(GitHubError);
    }
  });

  it("reports when a rate limit lifts: retry-after first, x-ratelimit-reset only when the hour is spent", async () => {
    const secondsFromNow = (err: unknown) => (Date.parse((err as GitHubRateLimitError).resetAt!) - Date.now()) / 1000;

    // Primary: x-ratelimit-remaining 0, reset 60 s out.
    fake.failNext({ status: 403, rateLimit: "primary" });
    const primary = await rejection(client().readFile());
    expect(primary).toBeInstanceOf(GitHubRateLimitError);
    expect(secondsFromNow(primary)).toBeGreaterThan(55);
    expect(secondsFromNow(primary)).toBeLessThanOrEqual(60);

    // Secondary (403 or 429): retry-after 60 with requests left in the hour.
    // x-ratelimit-reset still names the hourly window, about 3600 s out,
    // and must not win.
    for (const failure of [{ status: 403, rateLimit: "secondary" }, { status: 429 }] as const) {
      fake.failNext(failure);
      const secondary = await rejection(client().readFile());
      expect(secondary).toBeInstanceOf(GitHubRateLimitError);
      expect(secondsFromNow(secondary)).toBeGreaterThan(55);
      expect(secondsFromNow(secondary)).toBeLessThanOrEqual(60);
    }
  });

  it("types a 403 or 429 that names a rate limit as GitHubRateLimitError even without retry-after, with the 60 s floor", async () => {
    const secondsFromNow = (err: unknown) => (Date.parse((err as GitHubRateLimitError).resetAt!) - Date.now()) / 1000;
    for (const status of [403, 429] as const) {
      fake.failNext({ status, message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." });
      const err = await rejection(client().readFile());
      expect(err).toBeInstanceOf(GitHubRateLimitError);
      expect(secondsFromNow(err)).toBeGreaterThan(55);
      expect(secondsFromNow(err)).toBeLessThanOrEqual(60);
    }
    // A permission 403 stays a permission problem.
    fake.failNext({ status: 403 });
    await expect(client().readFile()).rejects.toBeInstanceOf(GitHubForbiddenError);
  });

  it("types a failure while reading the response body as GitHubNetworkError", async () => {
    // fetch resolves at the headers; the body stream then fails, as it does
    // when the 30 s timeout fires mid-download or the connection drops.
    const failingBody = (err: Error) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"lo'));
          controller.error(err);
        },
      });
    const breakBody = (pattern: RegExp, err: Error): typeof fetch =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await fake.fetch(input, init);
        if (!pattern.test(String(input))) return res;
        return new Response(failingBody(err), { status: res.status, headers: res.headers });
      }) as typeof fetch;

    const dropped = breakBody(/\/user$/, new TypeError("network error"));
    const lost = await rejection(getLogin({ token: WRITE, fetch: dropped }));
    expect(lost).toBeInstanceOf(GitHubNetworkError);
    expect((lost as GitHubNetworkError).message).toBe("Could not reach GitHub.");

    const sha = await fake.seedFile(REPO, "ledger.json.enc", "x".repeat(1_100_000));
    const slow = breakBody(new RegExp(`/git/blobs/${sha}$`), new DOMException("The operation timed out.", "TimeoutError"));
    const timedOut = await rejection(client({ fetch: slow }).readFile());
    expect(timedOut).toBeInstanceOf(GitHubNetworkError);
    expect((timedOut as GitHubNetworkError).message).toBe("GitHub did not answer in time.");

    const notJson: typeof fetch = async () => new Response("<html>", { status: 200 });
    const garbled = await rejection(getLogin({ token: WRITE, fetch: notJson }));
    expect(garbled).toBeInstanceOf(GitHubError);
    expect(garbled).not.toBeInstanceOf(GitHubNetworkError);
  });

  it("retries a 401 once with a fresh token when onUnauthorized resolves true", async () => {
    const tokens = ["github_pat_expired", WRITE];
    const tokenSource = vi.fn(async () => tokens.shift() ?? "github_pat_never");
    const onUnauthorized = vi.fn(async () => true);
    expect(await client({ token: tokenSource, onUnauthorized }).readFile()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fake.requests.map((r) => r.headers.authorization)).toEqual(["Bearer github_pat_expired", `Bearer ${WRITE}`]);

    // A second 401 is final.
    fake.requests.length = 0;
    const alwaysBad = vi.fn(async () => "github_pat_revoked");
    const refresh = vi.fn(async () => true);
    await expect(client({ token: alwaysBad, onUnauthorized: refresh }).readFile()).rejects.toBeInstanceOf(GitHubAuthError);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fake.requests).toHaveLength(2);

    // onUnauthorized resolving false, or a plain string token: no retry.
    fake.requests.length = 0;
    const declined = client({ token: "github_pat_revoked", onUnauthorized: async () => false });
    await expect(declined.readFile()).rejects.toBeInstanceOf(GitHubAuthError);
    await expect(client({ token: "github_pat_revoked" }).readFile()).rejects.toBeInstanceOf(GitHubAuthError);
    expect(fake.requests).toHaveLength(2);
  });

  it("answers 401 for a token past its expiry", async () => {
    fake.setToken("github_pat_expired", { login: "alex", repos: [REPO], permission: "write", expiresAt: "2020-01-01T00:00:00.000Z" });
    await expect(client({ token: "github_pat_expired" }).readFile()).rejects.toBeInstanceOf(GitHubAuthError);
    await expect(getLogin({ token: "github_pat_expired", fetch: fake.fetch })).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("getLogin needs only a token; the token expiry is null in a browser", async () => {
    // As a browser sees api.github.com: CORS hides the expiration header.
    expect(await getLogin({ token: WRITE, fetch: fake.fetch })).toEqual({ login: "alex", tokenExpiresAt: null });
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /user"]);
    await expect(getLogin({ token: "github_pat_unknown", fetch: fake.fetch })).rejects.toBeInstanceOf(GitHubAuthError);
    const gh = client();
    await gh.verifyRepo();
    expect(gh.tokenExpiresAt).toBeNull();

    // Outside a browser the header is readable, and parsed.
    const direct = createFakeGitHub({
      cors: false,
      repos: [{ owner: "alex", name: "ledger-data", private: true }],
      tokens: {
        [WRITE]: { login: "alex", repos: [REPO], permission: "write", expiresAt: EXPIRES },
        [NO_EXPIRY]: { login: "alex", repos: [REPO], permission: "write" },
      },
    });
    expect(await getLogin({ token: WRITE, fetch: direct.fetch })).toEqual({ login: "alex", tokenExpiresAt: EXPIRES });
    expect(await getLogin({ token: NO_EXPIRY, fetch: direct.fetch })).toEqual({ login: "alex", tokenExpiresAt: null });
    const directClient = client({ fetch: direct.fetch });
    expect(directClient.tokenExpiresAt).toBeNull();
    await directClient.verifyRepo();
    expect(directClient.tokenExpiresAt).toBe(EXPIRES);
  });

  it("reads a file a wrong passphrase can't decrypt without writing anything", async () => {
    const salt = newSalt();
    const [key, wrongKey] = await Promise.all([
      deriveKey("correct horse battery staple", salt, DEFAULT_ITERATIONS),
      deriveKey("not the passphrase", salt, DEFAULT_ITERATIONS),
    ]);
    const text = await encryptDocument({ remarks: "Groceries test" }, key, { salt, iter: DEFAULT_ITERATIONS });
    await fake.seedFile(REPO, "ledger.json.enc", text);
    const gh = client();
    await gh.verifyRepo();
    const file = await gh.readFile();
    const failure = decryptDocument(file!.text, wrongKey);
    await expect(failure).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(failure).rejects.toThrow(/^Wrong passphrase$/);
    expect(fake.requests.map((r) => r.method)).toEqual(["GET", "GET"]);
    expect(fake.commits).toEqual([]);
  });

  it("sends the GitHub headers and no-store on every request, and never the passphrase or plaintext", async () => {
    const passphrase = "correct horse battery staple";
    const salt = newSalt();
    const key = await deriveKey(passphrase, salt, DEFAULT_ITERATIONS);
    const gh = client();
    await getLogin({ token: WRITE, fetch: fake.fetch });
    await gh.verifyRepo();
    expect(await gh.readFile()).toBeNull();
    const sha = await gh.writeFile(await encryptDocument({ remarks: "Groceries test" }, key, { salt, iter: DEFAULT_ITERATIONS }), null);
    await gh.readFile();
    await gh.writeFile(await encryptDocument({ remarks: "Groceries test 2" }, key, { salt, iter: DEFAULT_ITERATIONS }), sha);
    await fake.seedFile(REPO, "ledger.json.enc", "x".repeat(1_100_000));
    await gh.readFile();

    expect(fake.requests.length).toBeGreaterThanOrEqual(8);
    for (const request of fake.requests) {
      expect(request.headers.authorization).toBe(`Bearer ${WRITE}`);
      expect(request.headers.accept).toMatch(/^application\/vnd\.github(\.raw)?\+json$/);
      expect(request.headers["x-github-api-version"]).toBe("2022-11-28");
      expect(request.cache).toBe("no-store");
      const sent = JSON.stringify(request);
      expect(sent).not.toContain(passphrase);
      expect(sent).not.toContain("Groceries");
      if (request.body) expect(atob(JSON.parse(request.body).content)).not.toContain("Groceries");
    }
    expect(fake.unhandled).toEqual([]);
  });
});

// The calls the sync cycle makes (design section 7), as adjusted by
// docs/architecture/github-api-behaviour.md.
describe("contents client: sync calls", () => {
  const EPOCH = "e000001-9c1f22aa";
  const DEVICE = "d0123456789abcdef";
  const LOG = `ledger/${EPOCH}.${DEVICE}.log.enc`;
  const GENESIS = `ledger/${EPOCH}.genesis.enc`;
  const SYNC = deviceCommitMessage("Sync", DEVICE);

  it("names the default branch from verifyRepo", async () => {
    expect(await client().verifyRepo()).toEqual({ defaultBranch: "main" });
  });

  it("getRef: an empty repo is 'empty', not a sha conflict", async () => {
    const gh = client();
    expect(await gh.getRef("main")).toEqual({ kind: "empty" });
    // The same 409 from any other git/* read is EmptyRepoError.
    const err = await rejection(gh.listDir("main"));
    expect(err).toBeInstanceOf(EmptyRepoError);
    expect(err).not.toBeInstanceOf(ShaConflictError);
    expect((err as EmptyRepoError).status).toBe(409);
  });

  it("getRef: the head and its ETag, then 'unchanged' on a 304 until a write lands", async () => {
    const gh = client();
    const first = await gh.putFile({ path: GENESIS, text: "genesis", sha: null, message: "Create ledger" });
    const head = await gh.getRef("main");
    expect(head).toMatchObject({ kind: "head", commitSha: first.commitSha });
    const etag = head.kind === "head" ? head.etag : null;
    expect(etag).toMatch(/^W\/"[0-9a-f]{64}"$/);

    expect(await gh.getRef("main", etag)).toEqual({ kind: "unchanged" });
    expect(await gh.getRef("main", etag)).toEqual({ kind: "unchanged" });
    const second = await gh.putFile({ path: LOG, text: "log", sha: null, message: SYNC });
    expect(await gh.getRef("main", etag)).toMatchObject({ kind: "head", commitSha: second.commitSha });

    // Every poll sends one Accept (the ETag varies with it), and the ETag
    // only when it has one.
    const polls = fake.requests.filter((r) => r.path.includes("/git/ref/"));
    expect(new Set(polls.map((r) => r.headers.accept))).toEqual(new Set(["application/vnd.github+json"]));
    expect(polls.map((r) => r.headers["if-none-match"])).toEqual([undefined, etag, etag, etag]);
    // The 304s were free.
    expect(polls).toHaveLength(4);

    await expect(gh.getRef("nobranch")).rejects.toMatchObject({ status: 404 });
  });

  it("getRef: a 304 is 'unchanged' even though fetch reports ok false", async () => {
    const notModified: typeof fetch = async () => new Response(null, { status: 304 });
    expect(await client({ fetch: notModified }).getRef("main", 'W/"x"')).toEqual({ kind: "unchanged" });
  });

  it("listDir: every file directly in ledger/ with its sha and size, past the contents API's 1,000 cap", async () => {
    const names = Array.from({ length: 1005 }, (_, i) => `${EPOCH}.d${i.toString(16).padStart(16, "0")}.log.enc`);
    const shas = await fake.seedFiles(REPO, {
      ...Object.fromEntries(names.map((n) => [`ledger/${n}`, n])),
      "ledger/old/nested.enc": "ignored",
      "README.md": "ignored",
    });
    const gh = client();
    const head = await gh.getRef("main");
    const listing = await gh.listDir(head.kind === "head" ? head.commitSha : "");
    expect(listing.truncated).toBe(false);
    expect(listing.files).toHaveLength(1005);
    expect(listing.files.map((f) => f.name).sort()).toEqual([...names].sort());
    for (const file of listing.files) {
      expect(file.sha).toBe(shas[`ledger/${file.name}`]);
      expect(file.size).toBe(file.name.length);
    }
    expect(fake.requests.filter((r) => r.path.includes("/git/trees/"))).toHaveLength(1);
  });

  it("listDir: no ledger/ lists nothing, and a truncated tree says so", async () => {
    const readmeOnly = await fake.seedFile(REPO, "README.md", "hello");
    expect(readmeOnly).toMatch(/^[0-9a-f]{40}$/);
    expect(await client().listDir(fake.head(REPO)!)).toEqual({ files: [], truncated: false });

    const small = createFakeGitHub({
      repos: [{ owner: "alex", name: "ledger-data", private: true }],
      tokens: { [WRITE]: { login: "alex", repos: [REPO], permission: "write" } },
      treeEntryLimit: 2,
    });
    await small.seedFiles(REPO, { "ledger/a.enc": "a", "ledger/b.enc": "b", "ledger/c.enc": "c" });
    const listing = await client({ fetch: small.fetch }).listDir(small.head(REPO)!);
    expect(listing.truncated).toBe(true);
  });

  it("listDir: a commit's listing, not the branch's, by commit sha", async () => {
    const gh = client();
    const first = await gh.putFile({ path: GENESIS, text: "genesis", sha: null, message: "Create ledger" });
    await gh.putFile({ path: LOG, text: "log", sha: null, message: SYNC });
    expect((await gh.listDir(first.commitSha)).files.map((f) => f.name)).toEqual([`${EPOCH}.genesis.enc`]);
  });

  it("readBlob: the exact bytes by sha, through the raw media type, above 1 MiB", async () => {
    const big = "y".repeat(1_500_000);
    const sha = await fake.seedFile(REPO, LOG, big);
    expect((await client().readBlob(sha)) === big).toBe(true);
    expect(fake.requests.at(-1)?.headers.accept).toBe("application/vnd.github.raw+json");
  });

  it("readFile: inline below 1 MiB, through the blob from exactly 1 MiB", async () => {
    const inline = recorded.contents.inline.inlineIffSizeBelow;
    for (const size of [inline - 1, inline]) {
      const path = `big/${size}.enc`;
      await fake.seedFile(REPO, path, "z".repeat(size));
      fake.requests.length = 0;
      const file = await client().readFile(path);
      expect(file?.text.length).toBe(size);
      expect(fake.requests.some((r) => r.path.includes("/git/blobs/"))).toBe(size >= inline);
    }
  });

  it("putFile: any path; the new sha is gitBlobSha(text), with the commit and its parent", async () => {
    const gh = client();
    const first = await gh.putFile({ path: GENESIS, text: "genesis", sha: null, message: "Create ledger" });
    expect(first.sha).toBe(await gitBlobSha("genesis"));
    expect(first.parentSha).toBeNull();
    expect(first.commitSha).toBe(fake.head(REPO));

    const log = await gh.putFile({ path: LOG, text: "log v1", sha: null, message: SYNC });
    expect(log.parentSha).toBe(first.commitSha);
    const next = await gh.putFile({ path: LOG, text: "log v2", sha: log.sha, message: SYNC });
    expect(next).toEqual({ sha: await gitBlobSha("log v2"), commitSha: fake.head(REPO), parentSha: log.commitSha });
    expect(await gh.readFile(LOG)).toEqual({ text: "log v2", sha: next.sha });
    expect(fake.commits.map((c) => [c.path, c.message])).toEqual([
      [GENESIS, "Create ledger"],
      [LOG, "Sync 01234567"],
      [LOG, "Sync 01234567"],
    ]);
  });

  it("gitBlobSha: git's blob id of the UTF-8 bytes", async () => {
    expect(await gitBlobSha("first version")).toBe("bde942a2105e7746b71aea43d5b29f539937d18e");
    expect(await gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("putFile: tells a lost branch race from a stale sha", async () => {
    const gh = client();
    const a = await gh.putFile({ path: LOG, text: "a", sha: null, message: SYNC });
    const otherLog = `ledger/${EPOCH}.dfedcba9876543210.log.enc`;
    const b = await gh.putFile({ path: otherLog, text: "b", sha: null, message: "Sync fedcba98" });

    // Two devices pushing their own logs at once: GitHub applies one.
    const results = await Promise.allSettled([
      gh.putFile({ path: LOG, text: "a2", sha: a.sha, message: SYNC }),
      gh.putFile({ path: otherLog, text: "b2", sha: b.sha, message: "Sync fedcba98" }),
    ]);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(lost.reason).toBeInstanceOf(ShaConflictError);
    expect((lost.reason as ShaConflictError).reason).toBe("branch-race");

    const stale = await rejection(gh.putFile({ path: LOG, text: "a3", sha: "6abd7d5cdfbf9c44a806872d2e0f200e39cf70c5", message: SYNC }));
    expect((stale as ShaConflictError).reason).toBe("stale-sha");
    const unsupplied = await rejection(gh.putFile({ path: LOG, text: "a3", sha: null, message: SYNC }));
    expect(unsupplied).toBeInstanceOf(ShaConflictError);
    expect((unsupplied as ShaConflictError).reason).toBe("stale-sha");
  });

  it("putFile: refuses a commit message outside the fixed set without sending anything", async () => {
    const gh = client();
    for (const message of ["Sync groceries 40", "Snapshot 0123", "Update ledger", "Sync 01234567\nAmount 12.00"]) {
      await expect(gh.putFile({ path: LOG, text: "x", sha: null, message: message as "Create ledger" })).rejects.toBeInstanceOf(TypeError);
    }
    expect(fake.requests).toEqual([]);
    expect(deviceCommitMessage("Snapshot", DEVICE)).toBe("Snapshot 01234567");
    expect(() => deviceCommitMessage("Sync", "alex")).toThrow(TypeError);
  });

  it("putFile: keepalive only when asked", async () => {
    const gh = client();
    const v1 = await gh.putFile({ path: LOG, text: "v1", sha: null, message: SYNC });
    await gh.putFile({ path: LOG, text: "v2", sha: v1.sha, message: SYNC, keepalive: true });
    expect(fake.requests.map((r) => r.keepalive)).toEqual([undefined, true]);
  });

  it("sends only headers GitHub's CORS preflight allows, never Cache-Control or Pragma, always no-store", async () => {
    const allowed = new Set([...recorded.cors.preflight.allowHeaders, "Accept"].map((h) => h.toLowerCase()));
    const gh = client();
    await gh.verifyRepo();
    const first = await gh.putFile({ path: LOG, text: "v1", sha: null, message: SYNC });
    const head = await gh.getRef("main");
    await gh.getRef("main", head.kind === "head" ? head.etag : null);
    await gh.listDir(first.commitSha);
    await gh.readBlob(first.sha);
    await gh.readFile(LOG);
    expect(fake.requests).toHaveLength(7);
    for (const request of fake.requests) {
      for (const name of Object.keys(request.headers)) expect(allowed.has(name), name).toBe(true);
      for (const name of recorded.cors.preflight.notAllowedRequestHeaders) expect(request.headers[name.toLowerCase()]).toBeUndefined();
      expect(request.cache).toBe("no-store");
    }
    expect(fake.unhandled).toEqual([]);
  });
});

describe("classifyToken", () => {
  it("accepts fine-grained and GitHub App user tokens only", () => {
    expect(classifyToken("github_pat_11AAAAAAA0example")).toEqual({ ok: true, kind: "fine-grained" });
    expect(classifyToken("  ghu_exampleUserToken\n")).toEqual({ ok: true, kind: "app" });
    for (const token of ["ghp_classicExample", "gho_oauthExample", "ghs_installationExample", "", "hunter2"]) {
      const result = classifyToken(token);
      expect(result.ok, token).toBe(false);
      expect(!result.ok && result.message).toMatch(/fine-grained .* limited to your one data repository/);
    }
  });
});
