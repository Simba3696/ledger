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
  type AppTokens,
  type SignInConfig,
} from "./appAuth";
import { createGitHubClient, GitHubAuthError } from "./contents";
import { createFakeGitHub, type FakeGitHub } from "./fakeGitHub";

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
    const changes: string[] = [];
    const fresh = new AppSession(record("ghu_alexold", 6 * 60_000), { helperUrl: HELPER, fetch: helper.fetch, onChange: (r) => changes.push(r.token) });
    expect(await fresh.token()).toBe("ghu_alexold");
    expect(helper.calls).toEqual([]);

    const tokens = record("ghu_alexold", 4 * 60_000);
    const near = new AppSession(tokens, { helperUrl: HELPER, fetch: helper.fetch, onChange: (r) => changes.push(r.token) });
    // Two requests at once share one refresh.
    expect(await Promise.all([near.token(), near.token()])).toEqual(["ghu_alexnew", "ghu_alexnew"]);
    expect(helper.calls).toEqual([{ path: "/refresh", body: { refresh_token: "ghr_alexold" } }]);
    // The record itself is updated, and whoever keeps it is told.
    expect(tokens).toMatchObject({ token: "ghu_alexnew", refreshToken: "ghr_alexnew" });
    expect(changes).toEqual(["ghu_alexnew"]);
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
    const session = new AppSession(record("ghu_alexold", 3600_000), { helperUrl: HELPER, fetch: helper.fetch });
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
    const second = new AppSession(record("ghu_alexold", 3600_000), { helperUrl: HELPER, fetch: again.fetch });
    await expect(clientOver(second, again.fetch).verifyRepo()).rejects.toBeInstanceOf(GitHubAuthError);
    expect(again.calls).toHaveLength(1);
  });

  it("a refused refresh clears the tokens, says the sign-in expired, and refuses later requests without calling anyone", async () => {
    const helper = fakeHelper(() => Response.json({ error: "bad_refresh_token" }, { status: 400 }));
    const tokens = record("ghu_alexold", 3600_000);
    const changes: AppTokens[] = [];
    const session = new AppSession(tokens, { helperUrl: HELPER, fetch: helper.fetch, onChange: (r) => changes.push({ ...r }) });
    await expect(clientOver(session, helper.fetch).verifyRepo()).rejects.toBeInstanceOf(GitHubAuthError);
    expect(session.expired).toBe(true);
    expect(tokens).toEqual({ token: "" });
    expect(changes).toEqual([{ token: "" }]);
    const before = fake.requests.length;
    await expect(session.token()).rejects.toThrow(SIGN_IN_EXPIRED);
    expect(await session.onUnauthorized()).toBe(false);
    expect(fake.requests).toHaveLength(before);
    expect(helper.calls).toHaveLength(1);
  });

  it("a helper that can't be reached keeps the tokens: the request fails as offline, not signed out", async () => {
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const tokens = record("ghu_alexold", 3600_000);
    const session = new AppSession(tokens, { helperUrl: HELPER, fetch: offline });
    await expect(session.onUnauthorized()).rejects.toMatchObject({ name: "GitHubNetworkError" });
    expect(session.expired).toBe(false);
    expect(tokens.token).toBe("ghu_alexold");
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
});
