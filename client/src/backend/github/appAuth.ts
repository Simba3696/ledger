import { authorizeUrl } from "../../githubStorage/links";
import { bytesToBase64 } from "../base64";
import { classifyToken, GitHubAuthError, GitHubError, GitHubNetworkError } from "./contents";

// Sign in with GitHub (#10, ADR-0009): an optional shortcut past pasting a
// fine-grained token, through a GitHub App's web flow with PKCE and
// `state`. The code is exchanged by the sign-in helper (signin-helper/),
// which holds the App's client secret; nothing here ever sees that secret.
//
// - signInConfig(): this build's three settings, or null (no button).
// - startSignIn(): a state and a PKCE verifier into sessionStorage, then
//   GitHub's authorize page.
// - completeSignIn(): on the way back, the code and state are taken out of
//   the address bar at once, the state checked, and the code exchanged.
// - AppSession: the App token's source for #6's contents client, refreshed
//   when under 5 minutes are left, and its onUnauthorized handler, which
//   refreshes once on a 401.
//
// The tokens are kept only in #6's deviceStore connection record (kind
// "app"), never here: a session updates the record it was given, and the
// saved copy through a TokenStore. Every tab holds its own copy of the
// record, and a refresh token works once, so refreshes take a lock shared
// by the browser's tabs and adopt another tab's refresh when the saved
// record has moved on; saves are compare-and-set on the refresh token.

const STATE_KEY = "ledger:github-signin";
/** The Web Lock every tab's refresh takes. */
const REFRESH_LOCK = "ledger:github-refresh";
const API_BASE = "https://api.github.com";
const TIMEOUT_MS = 30_000;
/** Refresh an access token with less than this left. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** A 401 this soon after a refresh came from a request sent with the old
 * token (one in flight while it refreshed): its retry uses the new token,
 * and no second refresh is made. The longest a request can be in flight. */
const STALE_401_MS = TIMEOUT_MS;
/** The callback's query parameters, all removed from the address bar. */
const CALLBACK_PARAMS = ["code", "state", "installation_id", "setup_action", "error", "error_description", "error_uri"];

export const SIGN_IN_INCOMPLETE = "Sign-in didn't complete. Try again.";
export const SIGN_IN_EXPIRED = "Your GitHub sign-in expired. Sign in again.";
const SIGN_IN_UNREACHABLE = "Couldn't reach the sign-in service. Check your connection and try again.";

/** The GitHub App and helper this build was given. All public. */
export interface SignInConfig {
  clientId: string;
  slug: string;
  /** The helper's base URL, without a trailing slash. */
  helperUrl: string;
}

/** This build's sign-in settings, or null unless all three are set and
 * non-blank: then there is no button, and no helper is ever called. */
export function signInConfig(): SignInConfig | null {
  const clientId = String(import.meta.env.VITE_GITHUB_APP_CLIENT_ID ?? "").trim();
  const slug = String(import.meta.env.VITE_GITHUB_APP_SLUG ?? "").trim();
  const helperUrl = String(import.meta.env.VITE_GITHUB_SIGNIN_HELPER_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  return clientId && slug && helperUrl ? { clientId, slug, helperUrl } : null;
}

/** Where the person was when they chose to sign in, so the way back lands
 * there: the walkthrough path (null from Replace token), and the repo they
 * were connecting. Never a token. */
export interface SignInResume {
  path: string | null;
  org: string | null;
  owner: string | null;
  repo: string;
}

/** An App user token and its refresh fields: the token part of #6's
 * Connection record, with the same names. An expired session has only
 * `token: ""`. */
export interface AppTokens {
  token: string;
  expiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

interface Entry {
  state: string;
  verifier: string;
  redirectUri: string;
  resume: SignInResume;
}

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes as base64url: 43 characters, 256 bits. */
function randomString(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** RFC 7636's S256 code challenge for a verifier. */
export async function codeChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function sessionStore(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether `href` is a return from github.com (a sign-in or an App
 * install), so the page can say "Signing in" while it is finished. */
export function isSignInReturn(href: string): boolean {
  const params = new URL(href).searchParams;
  return CALLBACK_PARAMS.some((name) => params.has(name));
}

/** Removes the in-progress sign-in's state and verifier, if any. */
export function clearSignInState(storage: Storage | null = sessionStore()): void {
  try {
    storage?.removeItem(STATE_KEY);
  } catch {
    // A browser that refuses sessionStorage has nothing kept in it.
  }
}

/** Reads and removes the stored entry, or null when there is none (or it
 * isn't one this code wrote). */
function takeEntry(storage: Storage | null): Entry | null {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(STATE_KEY) ?? null;
  } catch {
    raw = null;
  }
  clearSignInState(storage);
  if (raw === null) return null;
  try {
    const entry = JSON.parse(raw) as Partial<Entry> | null;
    const resume = entry?.resume;
    const nullableString = (v: unknown) => v === null || typeof v === "string";
    if (
      typeof entry?.state !== "string" ||
      typeof entry.verifier !== "string" ||
      typeof entry.redirectUri !== "string" ||
      typeof resume !== "object" ||
      resume === null ||
      !nullableString(resume.path) ||
      !nullableString(resume.org) ||
      !nullableString(resume.owner) ||
      typeof resume.repo !== "string"
    ) {
      return null;
    }
    return entry as Entry;
  } catch {
    return null;
  }
}

/** Starts a sign-in: keeps a fresh state and PKCE verifier for this tab,
 * then sends the browser to GitHub's authorize page. The redirect URI is
 * the page's own address, as #8 builds links, with a trailing index.html
 * taken off so it matches the site's registered callback URL. */
export async function startSignIn(
  config: SignInConfig,
  resume: SignInResume,
  { page = globalThis.location, storage = sessionStore(), navigate = (url: string) => globalThis.location.assign(url) }: {
    page?: Pick<Location, "origin" | "pathname">;
    storage?: Storage | null;
    navigate?: (url: string) => void;
  } = {},
): Promise<void> {
  const state = randomString();
  const verifier = randomString();
  const redirectUri = `${page.origin}${page.pathname.replace(/\/index\.html$/, "/")}`;
  const entry: Entry = { state, verifier, redirectUri, resume };
  storage?.setItem(STATE_KEY, JSON.stringify(entry));
  navigate(authorizeUrl({ clientId: config.clientId, redirectUri, state, codeChallenge: await codeChallenge(verifier) }));
}

/** What the helper answered, as the record's token fields, or null when
 * it isn't an App user token answer. The lifetimes are taken from
 * `expires_in` and `refresh_token_expires_in` on this device's clock when
 * the helper sends them, so a clock that differs from the helper's doesn't
 * matter; its epoch-ms times are the fallback. */
function tokensOf(answer: unknown): AppTokens | null {
  if (typeof answer !== "object" || answer === null) return null;
  const a = answer as Record<string, unknown>;
  if (typeof a.access_token !== "string") return null;
  const check = classifyToken(a.access_token);
  if (!check.ok || check.kind !== "app") return null;
  const now = Date.now();
  const iso = (seconds: unknown, ms: unknown) => {
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) return new Date(now + seconds * 1000).toISOString();
    return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
  };
  const tokens: AppTokens = { token: a.access_token };
  const expiresAt = iso(a.expires_in, a.expires_at);
  const refreshTokenExpiresAt = iso(a.refresh_token_expires_in, a.refresh_token_expires_at);
  if (expiresAt) tokens.expiresAt = expiresAt;
  if (typeof a.refresh_token === "string" && a.refresh_token !== "") tokens.refreshToken = a.refresh_token;
  if (refreshTokenExpiresAt) tokens.refreshTokenExpiresAt = refreshTokenExpiresAt;
  return tokens;
}

async function postHelper(fetchFn: typeof fetch, url: string, body: Record<string, string>): Promise<Response> {
  return fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export type SignInResult =
  /** Not a return from github.com (or no sign-in in this build). */
  | { kind: "none" }
  /** The return from installing the App on github.com, which this tab
   * didn't start: nothing to exchange. */
  | { kind: "installed" }
  | { kind: "failed"; message: string; resume: SignInResume | null }
  | { kind: "signedIn"; tokens: AppTokens; resume: SignInResume };

/** On page load: finishes a sign-in GitHub returned from. The callback's
 * parameters leave the address bar first, before anything else runs, and
 * the stored state and verifier are removed whatever happens. A missing or
 * mismatched state is refused without calling the helper. */
export async function completeSignIn(
  config: SignInConfig | null,
  {
    location = globalThis.location,
    history = globalThis.history,
    storage = sessionStore(),
    fetch: fetchFn = globalThis.fetch,
  }: {
    location?: Pick<Location, "href">;
    history?: Pick<History, "replaceState" | "state">;
    storage?: Storage | null;
    fetch?: typeof fetch;
  } = {},
): Promise<SignInResult> {
  if (!config) return { kind: "none" };
  const url = new URL(location.href);
  const params = url.searchParams;
  if (!CALLBACK_PARAMS.some((name) => params.has(name))) return { kind: "none" };
  const code = params.get("code");
  const state = params.get("state");
  const failedOnGitHub = params.has("error");
  const installReturn = params.has("setup_action");
  for (const name of CALLBACK_PARAMS) params.delete(name);
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);

  const entry = takeEntry(storage);
  if (state === null && installReturn && !failedOnGitHub) return { kind: "installed" };
  const resume = entry?.resume ?? null;
  if (failedOnGitHub || !entry || state === null || state !== entry.state || !code) return { kind: "failed", message: SIGN_IN_INCOMPLETE, resume };

  let res: Response;
  try {
    res = await postHelper(fetchFn, `${config.helperUrl}/token`, { code, code_verifier: entry.verifier, redirect_uri: entry.redirectUri });
  } catch {
    return { kind: "failed", message: SIGN_IN_UNREACHABLE, resume: entry.resume };
  }
  const tokens = res.ok ? tokensOf(await res.json().catch(() => null)) : null;
  if (!tokens) return { kind: "failed", message: SIGN_IN_INCOMPLETE, resume: entry.resume };
  return { kind: "signedIn", tokens, resume: entry.resume };
}

type RefreshOutcome = "ok" | "refused" | "unreachable";

/** Where a session's tokens are saved: the deviceStore connection record
 * (connection.ts). `load` is the saved tokens when the saved record is
 * this session's (same account and repo, kind "app"), else null. `save`
 * is compare-and-set: it writes only while the saved refresh token is
 * still `expected`, and says whether it wrote. */
export interface TokenStore {
  load(): Promise<AppTokens | null>;
  save(next: AppTokens, expected: string | undefined): Promise<boolean>;
}

const TOKEN_FIELDS = ["expiresAt", "refreshToken", "refreshTokenExpiresAt"] as const;

/** A signed-in GitHub App session over a token record (a Connection of
 * kind "app", or the tokens a sign-in just returned). It updates that
 * record in place on every refresh, and the saved copy through `store`.
 *
 * `token` and `onUnauthorized` are #6's `TokenSource` and `onUnauthorized`
 * options. Only GitHub refusing the refresh token (`bad_refresh_token`)
 * ends the session. Anything else that stops a refresh (the helper down or
 * misconfigured, the network) is an offline error: the tokens are kept and
 * the request fails as offline. */
export class AppSession {
  readonly #record: AppTokens;
  readonly #helperUrl: string | null;
  readonly #fetch: typeof fetch;
  readonly #store: TokenStore | null;
  readonly #locks: LockManager | null;
  #refreshing: Promise<RefreshOutcome> | null = null;
  /** When the last refresh landed (Date.now()), or null. */
  #refreshedAt: number | null = null;

  constructor(
    record: AppTokens,
    {
      helperUrl,
      fetch: fetchFn = globalThis.fetch,
      store = null,
      locks = globalThis.navigator?.locks ?? null,
    }: { helperUrl: string | null; fetch?: typeof fetch; store?: TokenStore | null; locks?: LockManager | null },
  ) {
    this.#record = record;
    this.#helperUrl = helperUrl;
    this.#fetch = fetchFn;
    this.#store = store;
    this.#locks = locks;
  }

  /** The sign-in can't be renewed: only signing in again (or a pasted
   * token) brings the device back. */
  get expired(): boolean {
    return this.#record.token === "";
  }

  /** The current access token, refreshed first when under 5 minutes are
   * left. Throws GitHubAuthError once the sign-in has expired. */
  readonly token = async (): Promise<string> => {
    if (this.expired) throw new GitHubAuthError(SIGN_IN_EXPIRED);
    const expiresAt = Date.parse(this.#record.expiresAt ?? "");
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      const outcome = await this.#refresh();
      if (outcome === "refused") throw new GitHubAuthError(SIGN_IN_EXPIRED);
      // Unreachable: the old token still works until it expires.
      if (outcome === "unreachable" && expiresAt <= Date.now()) throw new GitHubNetworkError(SIGN_IN_UNREACHABLE);
    }
    return this.#record.token;
  };

  /** A 401 from api.github.com: one refresh. True when the request should
   * be retried with the new token; false when the sign-in expired. A 401
   * for a request sent just before a refresh landed is retried with the
   * new token without refreshing again. */
  readonly onUnauthorized = async (): Promise<boolean> => {
    if (this.expired) return false;
    if (this.#refreshing === null && this.#refreshedAt !== null && Date.now() - this.#refreshedAt < STALE_401_MS) return true;
    const outcome = await this.#refresh();
    if (outcome === "unreachable") throw new GitHubNetworkError(SIGN_IN_UNREACHABLE);
    return outcome === "ok";
  };

  /** Ends the session (GitHub refused it even after a refresh): this
   * record keeps no token, and the saved one is emptied too, unless
   * another tab has refreshed it since. */
  expire(): Promise<void> {
    return this.#locked(() => this.#clear(this.#record.refreshToken));
  }

  /** `fn` under the lock every tab's refresh takes, when the browser has
   * Web Locks. */
  #locked<T>(fn: () => Promise<T>): Promise<T> {
    return this.#locks ? (this.#locks.request(REFRESH_LOCK, fn) as Promise<T>) : fn();
  }

  /** Empties this record, and the saved one while it still holds `held`. */
  async #clear(held: string | undefined): Promise<void> {
    this.#adopt({ token: "" });
    await this.#store?.save({ token: "" }, held).catch(() => false);
  }

  #adopt(tokens: AppTokens): void {
    this.#record.token = tokens.token;
    for (const key of TOKEN_FIELDS) {
      if (tokens[key] === undefined) delete this.#record[key];
      else this.#record[key] = tokens[key];
    }
  }

  /** One refresh at a time: requests that need one meanwhile share it. */
  #refresh(): Promise<RefreshOutcome> {
    this.#refreshing ??= this.#locked(() => this.#refreshOnce()).finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  /** Runs under the lock, so no other tab refreshes meanwhile. */
  async #refreshOnce(): Promise<RefreshOutcome> {
    const held = this.#record.refreshToken;
    // Another tab refreshed (or ended) the sign-in since this one read it:
    // its tokens are the live ones, and this tab's refresh token is spent.
    const saved = this.#store ? await this.#store.load().catch(() => null) : null;
    if (saved !== null && saved.refreshToken !== held) {
      this.#adopt(saved);
      if (this.expired) return "refused";
      this.#refreshedAt = Date.now();
      return "ok";
    }
    if (this.#helperUrl === null || !held || Date.parse(this.#record.refreshTokenExpiresAt ?? "") <= Date.now()) {
      await this.#clear(held);
      return "refused";
    }
    let res: Response;
    let answer: unknown;
    try {
      res = await postHelper(this.#fetch, `${this.#helperUrl}/refresh`, { refresh_token: held });
      answer = await res.json().catch(() => null);
    } catch {
      return "unreachable";
    }
    if (res.status === 400 && (answer as { error?: unknown } | null)?.error === "bad_refresh_token") {
      await this.#clear(held);
      return "refused";
    }
    const tokens = res.ok ? tokensOf(answer) : null;
    if (!tokens) return "unreachable";
    this.#adopt(tokens);
    this.#refreshedAt = Date.now();
    // A save that fails leaves the spent refresh token saved: the next
    // start then asks to sign in again, which loses nothing.
    await this.#store?.save(tokens, held).catch(() => false);
    return "ok";
  }
}

/** The App isn't installed on the repo (or the person can't reach it
 * through an installation): #10's "Give Ledger access" prompt. */
export class AppNotInstalledError extends Error {
  readonly owner: string;
  readonly repo: string;
  constructor(owner: string, repo: string) {
    super(`Ledger's GitHub App can't reach ${owner}/${repo}.`);
    this.name = "AppNotInstalledError";
    this.owner = owner;
    this.repo = repo;
  }
}

/** GET one page of a list endpoint, with the contents client's headers
 * and errors. */
async function getJson(fetchFn: typeof fetch, token: () => Promise<string>, path: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchFn(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${await token()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GitHubNetworkError();
  }
  if (res.status === 401) throw new GitHubAuthError();
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || body === null) {
    const message = typeof body?.message === "string" ? body.message : `GitHub request failed (${res.status})`;
    throw new GitHubError(res.status, message);
  }
  return body;
}

/** Every item of a paged list, 100 at a time. */
async function listAll(fetchFn: typeof fetch, token: () => Promise<string>, path: string, field: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for (let page = 1; ; page++) {
    const body = await getJson(fetchFn, token, `${path}?per_page=100&page=${page}`);
    const batch = Array.isArray(body[field]) ? (body[field] as Record<string, unknown>[]) : [];
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

/** Whether an App user token reaches owner/repo through one of the App's
 * installations: GET /user/installations, then each one's repositories.
 * Checked before the contents API, which would only say 404. */
export async function appReaches(token: () => Promise<string>, owner: string, repo: string, fetchFn: typeof fetch = globalThis.fetch): Promise<boolean> {
  const wanted = `${owner}/${repo}`.toLowerCase();
  for (const installation of await listAll(fetchFn, token, "/user/installations", "installations")) {
    if (typeof installation.id !== "number") continue;
    let repos: Record<string, unknown>[];
    try {
      repos = await listAll(fetchFn, token, `/user/installations/${installation.id}/repositories`, "repositories");
    } catch (err) {
      // An installation removed meanwhile.
      if (err instanceof GitHubError && err.status === 404) continue;
      throw err;
    }
    if (repos.some((r) => typeof r.full_name === "string" && r.full_name.toLowerCase() === wanted)) return true;
  }
  return false;
}
