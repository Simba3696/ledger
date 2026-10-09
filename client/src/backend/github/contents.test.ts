import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptDocument, DEFAULT_ITERATIONS, deriveKey, encryptDocument, newSalt, WrongPassphraseError } from "../crypto";
import {
  classifyToken,
  createGitHubClient,
  getLogin,
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

  it("getLogin needs only a token, and reports the token expiry", async () => {
    expect(await getLogin({ token: WRITE, fetch: fake.fetch })).toEqual({ login: "alex", tokenExpiresAt: EXPIRES });
    expect(await getLogin({ token: NO_EXPIRY, fetch: fake.fetch })).toEqual({ login: "alex", tokenExpiresAt: null });
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /user", "GET /user"]);
    await expect(getLogin({ token: "github_pat_unknown", fetch: fake.fetch })).rejects.toBeInstanceOf(GitHubAuthError);

    const gh = client();
    expect(gh.tokenExpiresAt).toBeNull();
    await gh.verifyRepo();
    expect(gh.tokenExpiresAt).toBe(EXPIRES);
    expect(client({ token: NO_EXPIRY }).tokenExpiresAt).toBeNull();
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
