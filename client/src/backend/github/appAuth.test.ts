import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppSession,
  appReaches,
  clearSignInState,
  codeChallenge,
  completeSignIn,
  SIGN_IN_EXPIRED,
  SIGN_IN_INCOMPLETE,
  signInConfig,
  startSignIn,
  isSignInReturn,
  type AppTokens,
  type SignInConfig,
  type TokenStore,
} from "./appAuth";
import { createGitHubClient, GitHubAuthError } from "./contents";
import { createFakeGitHub, type FakeGitHub } from "./fakeGitHub";
import { FakeLocks } from "../sync/localTestkit";

// Sign in with GitHub (#10): the build's settings, PKCE, the return from
// github.com, and the App session's token source and one refresh, against
// a fake helper and the fake GitHub. Fictional ids, origins and tokens.

const KEY = "ledger:github-signin";
const HELPER = "https://signin.example.workers.dev";
const CONFIG: SignInConfig = { clientId: "Iv1.fakeclientid", slug: "ledger-fake", helperUrl: HELPER };
const PAGE = { origin: "https://alex.github.io", pathname: "/ledger/" };
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const RESUME = { path: "personal", org: null, owner: null, repo: "ledger-data" };

/** sessionStorage as a Map. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

/** The address bar: replaceState moves `href`. */
function addressBar(href: string) {
  const bar = { href, state: null as unknown, replaced: [] as string[] };
  return {
    bar,
    location: {
      get href() {
        return bar.href;
      },
    },
    history: {
      get state() {
        return bar.state;
      },
      replaceState(_data: unknown, _unused: string, url?: string | URL | null) {
        bar.href = new URL(String(url), bar.href).href;
        bar.replaced.push(bar.href);
      },
    },
  };
}

/** A helper whose answers the test sets, recording each call. */
function fakeHelper(answer: (path: string, body: Record<string, string>) => Response) {
  const calls: { path: string; body: Record<string, string> }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    calls.push({ path: url.pathname, body });
    return answer(url.pathname, body);
  }) as typeof fetch;
  return { calls, fetch: fetchFn };
}

/** One saved token record, compare-and-set on its refresh token, as
 * connection.ts keeps the deviceStore's. */
function memoryStore(initial: AppTokens): TokenStore & { saved: AppTokens | null } {
  const store = {
    saved: { ...initial } as AppTokens | null,
    load: async () => (store.saved ? { ...store.saved } : null),
    save: async (next: AppTokens, expected: string | undefined) => {
      if (!store.saved || store.saved.refreshToken !== expected) return false;
      store.saved = { ...next };
      return true;
    },
  };
  return store;
}

const tokenAnswer = (token: string, expiresIn = 8 * 3600_000) =>
  Response.json({ access_token: token, expires_at: Date.now() + expiresIn, refresh_token: `ghr_${token.slice(4)}`, refresh_token_expires_at: Date.now() + 180 * 86_400_000 });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("the build's sign-in settings", () => {
  it("signInConfig() is null unless all three are set and non-blank", () => {
    const all = { VITE_GITHUB_APP_CLIENT_ID: "Iv1.fakeclientid", VITE_GITHUB_APP_SLUG: "ledger-fake", VITE_GITHUB_SIGNIN_HELPER_URL: `${HELPER}/` };
    for (const [name, value] of Object.entries(all)) vi.stubEnv(name, value);
    expect(signInConfig()).toEqual(CONFIG);
    for (const name of Object.keys(all)) {
      for (const blank of ["", "   "]) {
        vi.stubEnv(name, blank);
        expect(signInConfig()).toBeNull();
      }
      vi.stubEnv(name, all[name as keyof typeof all]);
    }
  });
});

describe("starting a sign-in", () => {
  it("PKCE S256 matches RFC 7636's Appendix B example", async () => {
    expect(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("redirects to GitHub's authorize URL with the client id, the page as redirect_uri, a random state and the stored verifier's S256 challenge", async () => {
    const storage = memoryStorage();
    const sent: string[] = [];
    await startSignIn(CONFIG, RESUME, { page: PAGE, storage, navigate: (url) => sent.push(url) });
    expect(sent).toHaveLength(1);
    const url = new URL(sent[0]);
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/login/oauth/authorize");
    const params = Object.fromEntries(url.searchParams);
    const stored = JSON.parse(storage.getItem(KEY)!) as { state: string; verifier: string; redirectUri: string; resume: unknown };
    expect(params).toEqual({
      client_id: CONFIG.clientId,
      redirect_uri: "https://alex.github.io/ledger/",
      state: stored.state,
      code_challenge: await codeChallenge(stored.verifier),
      code_challenge_method: "S256",
    });
    expect(params.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // At least 128 random bits: 32 bytes as base64url.
    expect(stored.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stored.redirectUri).toBe("https://alex.github.io/ledger/");
    expect(stored.resume).toEqual(RESUME);

    // A second start makes a new state and verifier.
    await startSignIn(CONFIG, RESUME, { page: PAGE, storage, navigate: (url) => sent.push(url) });
    expect(new URL(sent[1]).searchParams.get("state")).not.toBe(stored.state);
  });

  it("returns to the site's directory when the page was opened as index.html", async () => {
    const storage = memoryStorage();
    const sent: string[] = [];
    await startSignIn(CONFIG, RESUME, { page: { origin: PAGE.origin, pathname: "/ledger/index.html" }, storage, navigate: (url) => sent.push(url) });
    expect(new URL(sent[0]).searchParams.get("redirect_uri")).toBe("https://alex.github.io/ledger/");
  });

  it("clearSignInState() removes the stored entry", async () => {
    const storage = memoryStorage();
    await startSignIn(CONFIG, RESUME, { page: PAGE, storage, navigate: () => {} });
    clearSignInState(storage);
    expect(storage.getItem(KEY)).toBeNull();
  });
});

describe("returning from github.com", () => {
  async function started() {
    const storage = memoryStorage();
    let sent = "";
    await startSignIn(CONFIG, RESUME, { page: PAGE, storage, navigate: (url) => (sent = url) });
    return { storage, state: new URL(sent).searchParams.get("state")!, entry: JSON.parse(storage.getItem(KEY)!) as { verifier: string } };
  }

  it("isSignInReturn() tells a return from github.com from a plain load", () => {
    expect(isSignInReturn("https://alex.github.io/ledger/?code=c&state=s")).toBe(true);
    expect(isSignInReturn("https://alex.github.io/ledger/?error=access_denied&state=s")).toBe(true);
    expect(isSignInReturn("https://alex.github.io/ledger/?owner=alex&repo=ledger-data")).toBe(false);
  });

  it("strips code and state from the address bar before calling the helper, exchanges the code, and removes the entry", async () => {
    const { storage, state, entry } = await started();
    const { bar, location, history } = addressBar(`https://alex.github.io/ledger/?code=fake-code&state=${state}&keep=1#top`);
    const helper = fakeHelper(() => {
      // The address bar was cleaned before this request.
      expect(bar.href).toBe("https://alex.github.io/ledger/?keep=1#top");
      return tokenAnswer("ghu_alexfresh");
    });
    const result = await completeSignIn(CONFIG, { location, history, storage, fetch: helper.fetch });
    expect(helper.calls).toEqual([{ path: "/token", body: { code: "fake-code", code_verifier: entry.verifier, redirect_uri: "https://alex.github.io/ledger/" } }]);
    expect(result).toEqual({
      kind: "signedIn",
      resume: RESUME,
      tokens: {
        token: "ghu_alexfresh",
        expiresAt: new Date(NOW + 8 * 3600_000).toISOString(),
        refreshToken: "ghr_alexfresh",
        refreshTokenExpiresAt: new Date(NOW + 180 * 86_400_000).toISOString(),
      },
    });
    expect(storage.getItem(KEY)).toBeNull();
  });

  it("refuses a mismatched or missing state without calling the helper, and removes the entry either way", async () => {
    for (const query of ["code=fake-code&state=not-the-state", "code=fake-code", "error=access_denied&state=x"]) {
      const { storage } = await started();
      const { bar, location, history } = addressBar(`https://alex.github.io/ledger/?${query}`);
      const helper = fakeHelper(() => tokenAnswer("ghu_never"));
      expect(await completeSignIn(CONFIG, { location, history, storage, fetch: helper.fetch })).toEqual({ kind: "failed", message: SIGN_IN_INCOMPLETE, resume: RESUME });
      expect(helper.calls).toEqual([]);
      expect(bar.href).toBe("https://alex.github.io/ledger/");
      expect(storage.getItem(KEY)).toBeNull();
    }
  });

  it("a failed exchange still removes the entry; a plain load and an App install's return exchange nothing", async () => {
    const { storage, state } = await started();
    const failing = addressBar(`https://alex.github.io/ledger/?code=fake-code&state=${state}`);
    const helper = fakeHelper(() => Response.json({ error: "bad_verification_code" }, { status: 400 }));
    expect(await completeSignIn(CONFIG, { ...failing, storage, fetch: helper.fetch })).toMatchObject({ kind: "failed", message: SIGN_IN_INCOMPLETE });
    expect(storage.getItem(KEY)).toBeNull();

    const plain = addressBar("https://alex.github.io/ledger/?owner=alex&repo=ledger-data");
    expect(await completeSignIn(CONFIG, { ...plain, storage, fetch: helper.fetch })).toEqual({ kind: "none" });
    expect(plain.bar.replaced).toEqual([]);

    const installed = addressBar("https://alex.github.io/ledger/?code=install-code&installation_id=42&setup_action=install");
    expect(await completeSignIn(CONFIG, { ...installed, storage, fetch: helper.fetch })).toEqual({ kind: "installed" });
    expect(installed.bar.href).toBe("https://alex.github.io/ledger/");
    expect(helper.calls).toHaveLength(1);
  });
});

describe("the App session (token source and one refresh)", () => {
  const record = (token: string, expiresIn: number): AppTokens => ({
    token,
    expiresAt: new Date(NOW + expiresIn).toISOString(),
    refreshToken: `ghr_${token.slice(4)}`,
    refreshTokenExpiresAt: new Date(NOW + 180 * 86_400_000).toISOString(),
  });

  it("refreshes before a request once the token has under 5 minutes left, and not before", async () => {
    const helper = fakeHelper(() => tokenAnswer("ghu_alexnew"));
    const fresh = new AppSession(record("ghu_alexold", 6 * 60_000), { helperUrl: HELPER, fetch: helper.fetch, locks: null });
    expect(await fresh.token()).toBe("ghu_alexold");
    expect(helper.calls).toEqual([]);

    const tokens = record("ghu_alexold", 4 * 60_000);
    const store = memoryStore(tokens);
    const near = new AppSession(tokens, { helperUrl: HELPER, fetch: helper.fetch, store, locks: null });
    // Two requests at once share one refresh.
    expect(await Promise.all([near.token(), near.token()])).toEqual(["ghu_alexnew", "ghu_alexnew"]);
    expect(helper.calls).toEqual([{ path: "/refresh", body: { refresh_token: "ghr_alexold" } }]);
    // The record itself is updated, and the saved copy follows.
    expect(tokens).toMatchObject({ token: "ghu_alexnew", refreshToken: "ghr_alexnew" });
    expect(store.saved).toMatchObject({ token: "ghu_alexnew", refreshToken: "ghr_alexnew" });
  });

  it("takes the token's lifetime from expires_in on this device's clock, not the helper's expires_at", async () => {
    // The helper's clock is an hour behind: its expires_at is already near.
    const skewed = (token: string) =>
      Response.json({ access_token: token, expires_in: 8 * 3600, expires_at: NOW - 3600_000 + 60_000, refresh_token: "ghr_alexnew", refresh_token_expires_in: 180 * 86_400, refresh_token_expires_at: NOW - 3600_000 });
    const helper = fakeHelper(() => skewed("ghu_alexnew"));
    const tokens = record("ghu_alexold", 60_000);
    const session = new AppSession(tokens, { helperUrl: HELPER, fetch: helper.fetch, locks: null });
    expect(await session.token()).toBe("ghu_alexnew");
    expect(tokens.expiresAt).toBe(new Date(NOW + 8 * 3600_000).toISOString());
    expect(tokens.refreshTokenExpiresAt).toBe(new Date(NOW + 180 * 86_400_000).toISOString());
    // So the next request doesn't refresh again.
    expect(await session.token()).toBe("ghu_alexnew");
    expect(helper.calls).toHaveLength(1);
  });

  let fake: FakeGitHub;
  beforeEach(() => {
    fake = createFakeGitHub({
      repos: [{ owner: "alex", name: "ledger-data", private: true }],
      tokens: { ghu_alexnew: { login: "alex", repos: ["alex/ledger-data"], permission: "write" } },
      installations: [{ id: 7, account: "alex", repos: ["alex/ledger-data"] }],
    });
  });

  function clientOver(session: AppSession, helperFetch: typeof fetch) {
    const both = ((input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith(HELPER) ? helperFetch(input, init) : fake.fetch(input, init))) as typeof fetch;
    return createGitHubClient({ owner: "alex", repo: "ledger-data", token: session.token, onUnauthorized: session.onUnauthorized, fetch: both });
  }

  it("a 401 refreshes once and the request is retried once with the new token", async () => {
    const helper = fakeHelper(() => tokenAnswer("ghu_alexnew"));
    // GitHub no longer accepts ghu_alexold (revoked early, say).
    const session = new AppSession(record("ghu_alexold", 3600_000), { helperUrl: HELPER, fetch: helper.fetch, locks: null });
    await expect(clientOver(session, helper.fetch).verifyRepo()).resolves.toEqual({ defaultBranch: "main" });
    expect(helper.calls.map((c) => c.path)).toEqual(["/refresh"]);
    expect(fake.requests.map((r) => r.headers.authorization)).toEqual(["Bearer ghu_alexold", "Bearer ghu_alexnew"]);
    // Another request sent with the old token, answered 401 after the
    // refresh landed: retried with the new token, no second refresh.
    expect(await session.onUnauthorized()).toBe(true);
    expect(helper.calls).toHaveLength(1);

    // A refreshed token that is refused too: one refresh, one retry, then the 401.
    fake.revokeToken("ghu_alexnew");
    const again = fakeHelper(() => tokenAnswer("ghu_alexnewer"));
    const second = new AppSession(record("ghu_alexold", 3600_000), { helperUrl: HELPER, fetch: again.fetch, locks: null });
    await expect(clientOver(second, again.fetch).verifyRepo()).rejects.toBeInstanceOf(GitHubAuthError);
    expect(again.calls).toHaveLength(1);
  });

  it("a refresh GitHub refuses (bad_refresh_token) clears the tokens, here and saved, and later requests are refused without calling anyone", async () => {
    const helper = fakeHelper(() => Response.json({ error: "bad_refresh_token" }, { status: 400 }));
    const tokens = record("ghu_alexold", 3600_000);
    const store = memoryStore(tokens);
    const session = new AppSession(tokens, { helperUrl: HELPER, fetch: helper.fetch, store, locks: null });
    await expect(clientOver(session, helper.fetch).verifyRepo()).rejects.toBeInstanceOf(GitHubAuthError);
    expect(session.expired).toBe(true);
    expect(tokens).toEqual({ token: "" });
    expect(store.saved).toEqual({ token: "" });
    const before = fake.requests.length;
    await expect(session.token()).rejects.toThrow(SIGN_IN_EXPIRED);
    expect(await session.onUnauthorized()).toBe(false);
    expect(fake.requests).toHaveLength(before);
    expect(helper.calls).toHaveLength(1);
  });

  it("any other refresh failure (a helper misconfigured or unreachable) keeps the tokens: the request fails as offline, not signed out", async () => {
    const answers = [
      () => Response.json({ error: "incorrect_client_credentials" }, { status: 400 }),
      () => Response.json({ error: "invalid_request" }, { status: 400 }),
      () => Response.json({ error: "not_found" }, { status: 404 }),
      () => Response.json({ error: "origin_not_allowed" }, { status: 403 }),
      () => Response.json({ error: "helper_not_configured" }, { status: 500 }),
      () => Response.json({ error: "upstream_unavailable" }, { status: 502 }),
      () => {
        throw new TypeError("Failed to fetch");
      },
    ];
    for (const answer of answers) {
      const tokens = record("ghu_alexold", 3600_000);
      const store = memoryStore(tokens);
      const session = new AppSession(tokens, { helperUrl: HELPER, fetch: fakeHelper(answer).fetch, store, locks: null });
      await expect(session.onUnauthorized()).rejects.toMatchObject({ name: "GitHubNetworkError" });
      expect(session.expired).toBe(false);
      expect(tokens.token).toBe("ghu_alexold");
      expect(store.saved?.refreshToken).toBe("ghr_alexold");
    }
  });
});

describe("the App session across tabs (one saved record)", () => {
  const T1: AppTokens = { token: "ghu_alex1", expiresAt: new Date(NOW + 3600_000).toISOString(), refreshToken: "ghr_alex1", refreshTokenExpiresAt: new Date(NOW + 180 * 86_400_000).toISOString() };

  /** The helper as GitHub runs it: each refresh token works once. */
  function rotatingHelper() {
    let n = 1;
    const spent = new Set<string>();
    return fakeHelper((_path, body) => {
      if (spent.has(body.refresh_token) || body.refresh_token !== `ghr_alex${n}`) return Response.json({ error: "bad_refresh_token" }, { status: 400 });
      spent.add(body.refresh_token);
      n++;
      return tokenAnswer(`ghu_alex${n}`);
    });
  }

  it("a second tab with the old tokens takes the first tab's refresh instead of spending the used refresh token", async () => {
    const store = memoryStore({ ...T1 });
    const locks = new FakeLocks().asLockManager();
    const helper = rotatingHelper();
    const tabA = { ...T1 };
    const tabB = { ...T1 };
    const a = new AppSession(tabA, { helperUrl: HELPER, fetch: helper.fetch, store, locks });
    const b = new AppSession(tabB, { helperUrl: HELPER, fetch: helper.fetch, store, locks });
    expect(await a.onUnauthorized()).toBe(true);
    expect(store.saved).toMatchObject({ token: "ghu_alex2", refreshToken: "ghr_alex2" });
    expect(await b.onUnauthorized()).toBe(true);
    expect(tabB).toMatchObject({ token: "ghu_alex2", refreshToken: "ghr_alex2" });
    expect(helper.calls).toHaveLength(1);
    expect(store.saved).toMatchObject({ token: "ghu_alex2", refreshToken: "ghr_alex2" });
  });

  it("two tabs refreshing at once make one refresh between them", async () => {
    const store = memoryStore({ ...T1 });
    const locks = new FakeLocks().asLockManager();
    const helper = rotatingHelper();
    const a = new AppSession({ ...T1 }, { helperUrl: HELPER, fetch: helper.fetch, store, locks });
    const b = new AppSession({ ...T1 }, { helperUrl: HELPER, fetch: helper.fetch, store, locks });
    expect(await Promise.all([a.onUnauthorized(), b.onUnauthorized()])).toEqual([true, true]);
    expect(helper.calls).toHaveLength(1);
    expect(store.saved).toMatchObject({ token: "ghu_alex2", refreshToken: "ghr_alex2" });
  });

  it("a tab whose refresh token was refused, or that ends its session, never clears tokens another tab saved since", async () => {
    const store = memoryStore({ ...T1, token: "ghu_alex2", refreshToken: "ghr_alex2" });
    // This tab couldn't read the saved record (null), so it spends its own
    // old refresh token, which GitHub refuses.
    const blind: TokenStore = { load: async () => null, save: (next, expected) => store.save(next, expected) };
    const refused = fakeHelper(() => Response.json({ error: "bad_refresh_token" }, { status: 400 }));
    const stale = new AppSession({ ...T1 }, { helperUrl: HELPER, fetch: refused.fetch, store: blind, locks: null });
    expect(await stale.onUnauthorized()).toBe(false);
    expect(stale.expired).toBe(true);
    expect(store.saved).toMatchObject({ token: "ghu_alex2", refreshToken: "ghr_alex2" });

    // Replace token's expire, from a tab still holding the old tokens.
    const other = new AppSession({ ...T1 }, { helperUrl: HELPER, fetch: refused.fetch, store, locks: null });
    await other.expire();
    expect(other.expired).toBe(true);
    expect(store.saved).toMatchObject({ token: "ghu_alex2", refreshToken: "ghr_alex2" });

    // The tab holding the saved tokens does clear them.
    const current = new AppSession({ ...T1, token: "ghu_alex2", refreshToken: "ghr_alex2" }, { helperUrl: HELPER, fetch: refused.fetch, store, locks: null });
    await current.expire();
    expect(store.saved).toEqual({ token: "" });
  });
});

describe("whether the App reaches a repo", () => {
  it("looks through every installation's repositories, page by page", async () => {
    const fake = createFakeGitHub({
      repos: [
        { owner: "alex", name: "ledger-data", private: true },
        { owner: "smith-household", name: "ledger-data", private: true },
      ],
      tokens: { ghu_alex: { login: "alex", repos: ["alex/ledger-data", "smith-household/ledger-data"], permission: "write" } },
      installations: [{ id: 7, account: "alex", repos: ["alex/ledger-data"] }],
    });
    const token = () => Promise.resolve("ghu_alex");
    expect(await appReaches(token, "Alex", "Ledger-Data", fake.fetch)).toBe(true);
    expect(await appReaches(token, "smith-household", "ledger-data", fake.fetch)).toBe(false);
    fake.install({ id: 8, account: "smith-household", repos: "all" });
    expect(await appReaches(token, "smith-household", "ledger-data", fake.fetch)).toBe(true);
    expect(fake.unhandled).toEqual([]);
  });

  it("pages past 100 installations, and past 100 repositories in one", async () => {
    const repos = [
      ...Array.from({ length: 105 }, (_, i) => ({ owner: `family${i}`, name: "ledger-data", private: true })),
      ...Array.from({ length: 150 }, (_, i) => ({ owner: "big-household", name: `repo${String(i).padStart(3, "0")}`, private: true })),
    ];
    const fake = createFakeGitHub({
      repos,
      tokens: { ghu_alex: { login: "alex", repos: repos.map((r) => `${r.owner}/${r.name}`), permission: "write" } },
      installations: [
        ...Array.from({ length: 105 }, (_, i) => ({ id: i + 1, account: `family${i}`, repos: [`family${i}/ledger-data`] })),
        { id: 500, account: "big-household", repos: "all" as const },
      ],
    });
    const token = () => Promise.resolve("ghu_alex");
    expect(await appReaches(token, "family104", "ledger-data", fake.fetch)).toBe(true);
    expect(await appReaches(token, "big-household", "repo149", fake.fetch)).toBe(true);
    expect(await appReaches(token, "big-household", "repo150", fake.fetch)).toBe(false);
    const pages = fake.requests.map((r) => r.path).filter((p) => p.includes("page=2"));
    expect(pages).toEqual(expect.arrayContaining([expect.stringMatching(/^\/user\/installations\?per_page=100&page=2$/), expect.stringMatching(/^\/user\/installations\/500\/repositories\?per_page=100&page=2$/)]));
  }, 30_000);
});
