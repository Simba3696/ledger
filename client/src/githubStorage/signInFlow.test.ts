import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SIGN_IN_EXPIRED, SIGN_IN_INCOMPLETE, type AppTokens, type SignInResult } from "../backend/github/appAuth";
import { forgetDevice, type Connection } from "../backend/github/deviceStore";
import { createFakeGitHub, type FakeGitHub } from "../backend/github/fakeGitHub";
import { loadSaved, remember, resetMemoryForTests } from "./connection";
import type { Deps } from "./ledgerAccess";
import { connectSignedIn, expireOnReplace, INSTALLED, planReturn, replaceCredentials, replaceSignIn } from "./signInFlow";
import { OTHER_REPO } from "./token";

// The gate's Sign in with GitHub decisions (#10), without React: what a
// return from github.com leads to, Replace token with either kind of
// credentials, the install prompt's Check again, and the sign-in-expired
// screen. Against the fake GitHub. Fictional data only.

const FULL = "alex/ledger-data";
const HOUR = 3600_000;
const tokens = (token: string): AppTokens => ({
  token,
  expiresAt: new Date(Date.now() + 8 * HOUR).toISOString(),
  refreshToken: `ghr_${token.slice(4)}`,
  refreshTokenExpiresAt: new Date(Date.now() + 4000 * HOUR).toISOString(),
});
const resume = { path: "household", org: "smith-household", owner: "smith-household", repo: "ledger-data" };

let fake: FakeGitHub;
let deps: Deps;

beforeEach(() => {
  fake = createFakeGitHub({
    repos: [
      { owner: "alex", name: "ledger-data", private: true },
      { owner: "alex", name: "other-data", private: true },
    ],
    tokens: {
      github_pat_alex: { login: "alex", repos: [FULL], permission: "write" },
      ghu_alex1: { login: "alex", repos: [FULL, "alex/other-data"], permission: "write" },
      ghu_sam1: { login: "sam", repos: [FULL], permission: "write" },
    },
    installations: [{ id: 7, account: "alex", repos: [FULL] }],
  });
  deps = { fetch: fake.fetch, signInConfig: { clientId: "Iv1.fakeclientid", slug: "ledger-fake", helperUrl: "https://signin.example.workers.dev" }, locks: null };
});

afterEach(async () => {
  resetMemoryForTests();
  await forgetDevice();
});

const pat: Connection = { kind: "pat", token: "github_pat_alex", owner: "alex", repo: "ledger-data", path: "ledger", login: "alex", branch: "main" };
const app: Connection = { ...pat, kind: "app", ...tokens("ghu_alex0") };

describe("back from github.com: what the gate does (#10)", () => {
  it("plans each kind of return, with and without a saved connection", () => {
    const signedIn: SignInResult = { kind: "signedIn", tokens: tokens("ghu_alex1"), resume };
    const failed: SignInResult = { kind: "failed", message: SIGN_IN_INCOMPLETE, resume };
    expect(planReturn({ kind: "none" }, false)).toEqual({ kind: "none" });
    expect(planReturn({ kind: "installed" }, true)).toEqual({ kind: "notice", message: INSTALLED });
    // Nothing saved: the connect card of the path the sign-in started on.
    expect(planReturn(signedIn, false)).toEqual({
      kind: "connect",
      event: { type: "signInReturned", path: "household", org: "smith-household", owner: "smith-household", repo: "ledger-data", error: null },
      tokens: signedIn.tokens,
    });
    expect(planReturn(failed, false)).toMatchObject({ kind: "connect", event: { error: SIGN_IN_INCOMPLETE }, tokens: null });
    expect(planReturn({ ...signedIn, resume: { ...resume, path: "bogus" } }, false)).toMatchObject({ event: { path: "personal" } });
    // Saved: signing in again from Replace token.
    expect(planReturn(signedIn, true)).toEqual({ kind: "replace", tokens: signedIn.tokens });
    expect(planReturn(failed, true)).toEqual({ kind: "replaceFailed", message: SIGN_IN_INCOMPLETE });
    // A return this tab didn't start: only a notice.
    expect(planReturn({ kind: "failed", message: SIGN_IN_INCOMPLETE, resume: null }, true)).toEqual({ kind: "notice", message: SIGN_IN_INCOMPLETE });
  });

  it("Replace token with a new sign-in turns a pasted-token connection into an App one, and a pasted token turns it back", async () => {
    const toApp = await replaceCredentials(pat, tokens("ghu_alex1"), deps);
    if (!toApp.ok) throw new Error(toApp.message);
    expect(toApp.next).toMatchObject({ kind: "app", token: "ghu_alex1", refreshToken: "ghr_alex1", owner: "alex", repo: "ledger-data", login: "alex" });
    expect(toApp.connected.token.app).not.toBeNull();

    const toPat = await replaceCredentials(toApp.next, "github_pat_alex", deps);
    if (!toPat.ok) throw new Error(toPat.message);
    expect(toPat.next).toEqual({ ...pat, kind: "pat", token: "github_pat_alex" });
    expect(toPat.connected.token.app).toBeNull();
  });

  it("a sign-in as another GitHub account is refused as that, before anything about the repo is asked", async () => {
    const result = await replaceCredentials(app, tokens("ghu_sam1"), deps);
    expect(result).toEqual({ ok: false, message: "This token belongs to another GitHub account. Use a token from alex's account." });
    expect(fake.requests.map((r) => r.path)).toEqual(["/user"]);
  });

  it("a sign-in whose App doesn't reach this repo is for another repository; a refused one didn't complete", async () => {
    expect(await replaceCredentials({ ...app, repo: "other-data" }, tokens("ghu_alex1"), deps)).toEqual({ ok: false, message: OTHER_REPO });
    expect(await replaceCredentials(app, tokens("ghu_unknown"), deps)).toEqual({ ok: false, message: SIGN_IN_INCOMPLETE });
  });

  it("the install prompt, then Check again with the same tokens once the App is installed", async () => {
    const signedIn = tokens("ghu_alex1");
    expect(await connectSignedIn("personal", signedIn, null, "other-data", deps)).toEqual({ kind: "install", owner: "alex", repo: "other-data" });
    fake.install({ id: 7, account: "alex", repos: "all" });
    const again = await connectSignedIn("personal", signedIn, null, "other-data", deps);
    expect(again).toMatchObject({ kind: "connected", connected: { connection: { kind: "app", owner: "alex", repo: "other-data", token: "ghu_alex1" } } });
    expect(await connectSignedIn("personal", tokens("ghu_unknown"), null, "ledger-data", deps)).toEqual({ kind: "failed", message: SIGN_IN_INCOMPLETE });
  });

  it("reaching Replace token in an App session clears its saved tokens; a pasted token's are left alone", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const record = { ...app };
    await remember(record, { key, salt: "c2FsdA==", iter: 600_000 });
    await expireOnReplace(record, deps);
    expect((await loadSaved()).connection).toEqual({ ...pat, kind: "app", token: "" });

    await remember(pat, { key, salt: "c2FsdA==", iter: 600_000 });
    await expireOnReplace(pat, deps);
    expect((await loadSaved()).connection).toEqual(pat);
  });

  it("Replace token offers signing in again only in an App session", () => {
    expect(replaceSignIn("pat", true)).toBeNull();
    expect(replaceSignIn("app", true)).toEqual({ message: SIGN_IN_EXPIRED, canSignIn: true });
    expect(replaceSignIn("app", false)).toEqual({ message: SIGN_IN_EXPIRED, canSignIn: false });
  });
});
