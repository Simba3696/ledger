import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { completeSignIn, type SignInConfig } from "../backend/github/appAuth";
import { createFakeGitHub, type FakeGitHub } from "../backend/github/fakeGitHub";
import { SECTIONS } from "./defaults";
import { GitHubGate } from "./GitHubGate";
import { connect, createNew, type Deps } from "./ledgerAccess";

// A development page only (client/fake.html, served by `vite --mode github`
// and never built: the build's one entry is index.html). It runs the real
// gate over an in-memory fake GitHub, so the onboarding screens can be
// clicked through without a GitHub account: the browser check of #8, and
// #11's e2e. Fictional data only; the fake resets on every reload.
//
//   fake.html                  an empty repo: Create
//   fake.html?ledger=existing  a ledger already in it: Unlock, passphrase
//                              "correct horse battery staple"
//   fake.html?owner=smith-household&repo=ledger-data   an invite link
//   fake.html?keep             keep what the last load saved on this origin
//   fake.html?signin           Sign in with GitHub (#10), as alex; also
//                              ?signin=sam, and ?signin=deny or
//                              ?signin=badstate for a sign-in that fails
//
// Tokens: github_pat_alex and github_pat_alex2 (alex's repo and the
// household's), github_pat_sam (the household's only), github_pat_stranger
// (none). The fake is window.ledgerFake, so a check can revoke a token
// mid-session (ledgerFake.revokeToken("github_pat_alex")) to reach
// Replace token.
//
// With ?signin, the button leaves for a fake authorize page that returns
// at once with a code (no reload: the gate is mounted again, so the fake
// GitHub keeps its state), and a fake helper exchanges it for a ghu_ token.
// The App is installed on alex/ledger-data only, so the household path
// shows the install prompt; ledgerFake.install({ id: 2, account:
// "smith-household", repos: "all" }) in the console, then Check again.
// window.ledgerFakeHelper.refuseRefresh = true makes the next refresh fail
// (with ledgerFake.revokeToken(<the ghu_ token>), the sign-in expires).
// Signing in again from Replace token needs a real reload, which empties
// the fake, so it isn't simulated here.

const PASSPHRASE = "correct horse battery staple";

const fake = createFakeGitHub({
  repos: [
    { owner: "alex", name: "ledger-data", private: true },
    { owner: "smith-household", name: "ledger-data", private: true },
  ],
  tokens: {
    github_pat_alex: { login: "alex", repos: ["alex/ledger-data", "smith-household/ledger-data"], permission: "write" },
    github_pat_alex2: { login: "alex", repos: ["alex/ledger-data", "smith-household/ledger-data"], permission: "write" },
    github_pat_sam: { login: "sam", repos: ["smith-household/ledger-data"], permission: "write" },
    github_pat_stranger: { login: "stranger", repos: [], permission: "write" },
  },
  installations: [{ id: 1, account: "alex", repos: ["alex/ledger-data"] }],
});

(globalThis as { ledgerFake?: FakeGitHub }).ledgerFake = fake;

const params = new URLSearchParams(location.search);

// Sign in with GitHub (#10), with ?signin.
const signInMode = params.get("signin");
const SIGN_IN: SignInConfig | null = signInMode === null ? null : { clientId: "Iv1.fakeclientid", slug: "ledger-fake", helperUrl: "https://signin.fake.invalid" };
const grants: Record<string, string[]> = { alex: ["alex/ledger-data", "smith-household/ledger-data"], sam: ["smith-household/ledger-data"] };
const helper = { refuseRefresh: false, issued: 0, codes: new Map<string, string>() };
(globalThis as { ledgerFakeHelper?: typeof helper }).ledgerFakeHelper = helper;

/** A new ghu_ token for `login`, as the helper answers. */
function issue(login: string): Response {
  helper.issued++;
  const token = `ghu_${login}${helper.issued}`;
  fake.setToken(token, { login, repos: grants[login] ?? [], permission: "write" });
  return Response.json({ access_token: token, expires_at: Date.now() + 8 * 3600_000, refresh_token: `ghr_${login}${helper.issued}`, refresh_token_expires_at: Date.now() + 180 * 86_400_000 });
}

/** The sign-in helper, in the page. */
async function fakeHelper(path: string, body: Record<string, string>): Promise<Response> {
  if (path === "/token") {
    const login = helper.codes.get(body.code);
    helper.codes.delete(body.code);
    return login ? issue(login) : Response.json({ error: "bad_verification_code" }, { status: 400 });
  }
  const login = body.refresh_token?.match(/^ghr_([a-z]+)\d+$/)?.[1];
  if (helper.refuseRefresh || !login) return Response.json({ error: "bad_refresh_token" }, { status: 400 });
  return issue(login);
}

/** GitHub's authorize page, approving at once: back to the redirect URI
 * with a code and the state (or a failure, with ?signin=deny or
 * badstate), keeping this page's own parameters, then mounted again. */
function fakeAuthorize(url: string): void {
  const asked = new URL(url).searchParams;
  const back = new URL(asked.get("redirect_uri")!);
  back.search = location.search;
  if (signInMode === "deny") {
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("state", asked.get("state")!);
  } else {
    const code = `fake-code-${helper.issued}-${Math.random().toString(36).slice(2)}`;
    helper.codes.set(code, signInMode === "sam" ? "sam" : "alex");
    back.searchParams.set("code", code);
    back.searchParams.set("state", signInMode === "badstate" ? "not-the-state" : asked.get("state")!);
  }
  history.pushState(null, "", back);
  void mount();
}
// A ledger made before the page shows, as another device would have.
const seeded =
  params.get("ledger") === "existing"
    ? connect("github_pat_alex", { owner: null, repo: "ledger-data" }, { fetch: fake.fetch }).then((c) => createNew(c, PASSPHRASE, { modules: [...SECTIONS], timeZone: "Asia/Kolkata" }))
    : Promise.resolve();
const fetchAfterSeed: typeof fetch = async (input, init) => {
  if (SIGN_IN && String(input).startsWith(SIGN_IN.helperUrl)) {
    return fakeHelper(new URL(String(input)).pathname, JSON.parse(String(init?.body)) as Record<string, string>);
  }
  await seeded;
  return fake.fetch(input, init);
};

// The fake starts empty on every load, so what this origin saved before
// (a connection, a key, sync state) would point at a ledger that is no
// longer there: each load starts clean, unless ?keep is given (to check a
// reload opens without the passphrase; the fake repo is empty then).
const cleared = params.has("keep")
  ? Promise.resolve()
  : Promise.all(["ledger:github", "ledger:sync"].map((name) => new Promise<void>((done) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => done();
    })));

const deps: Deps = { fetch: fetchAfterSeed, signInConfig: SIGN_IN, navigate: fakeAuthorize };
const root = createRoot(document.getElementById("root")!);
let mounts = 0;

/** As startGithubStorage: finish a sign-in return, then the gate. */
async function mount(): Promise<void> {
  const signIn = await completeSignIn(SIGN_IN, { fetch: fetchAfterSeed });
  mounts++;
  root.render(
    <StrictMode>
      <GitHubGate key={mounts} deps={deps} signIn={signIn} />
    </StrictMode>,
  );
}

document.documentElement.dataset.storage = "github";
void cleared.then(mount);
