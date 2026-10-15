/**
 * Sign in with GitHub end to end (issue #10, `npm run test:e2e:github`,
 * after #11's e2e/githubStorage.ts). The real Pages bundle, built twice
 * with #11's build-and-preview helper: once without the three
 * VITE_GITHUB_* settings (no button, no helper in the CSP or the bundle),
 * once with them in the spawned build's environment only. Chromium drives
 * it against #11's routing adapter over the unit tests' fake GitHub, with
 * two more Playwright routes: a fake sign-in helper on its own origin, and
 * GitHub's authorize page answering with a redirect back carrying a code
 * and the state.
 *
 * Starts only the preview server (stopped by PID by the helper), never
 * kill-ports.js, so it can't stop a live server. No network, no Supabase.
 * Fictional data only: the login alex-signin-e2e, the repo ledger-data, a
 * passphrase made per run.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { ROOT } from "./devServer.js";
import { createFakeGitHubAdapter, type FakeGitHubAdapter } from "./fakeGithub.js";
import { buildAndPreview, type PagesPreview } from "./githubStorage.js";
import { deriveKey, parseHeader } from "../client/src/backend/crypto.js";
import type { LedgerDocument } from "../client/src/backend/document/types.js";
import { parseRepoFileName, winningEpoch } from "../client/src/backend/sync/epoch.js";
import { materialize } from "../client/src/backend/sync/materialize.js";
import { LEDGER_DIR, openRepoFile } from "../client/src/backend/sync/repoFiles.js";
import { applyOp, genesisState, type Op } from "../client/src/backend/sync/state.js";

const ALEX = "alex-signin-e2e";
const REPO = "ledger-data";
const FULL = `${ALEX}/${REPO}`;
const PASS = `signin ${randomBytes(9).toString("base64url")}`;
const HELPER = "https://signin-e2e.example.workers.dev";
const CLIENT_ID = "Iv1.e2eclientid";
const SLUG = "ledger-e2e";
const SIGN_IN_SETTINGS = { VITE_GITHUB_APP_CLIENT_ID: CLIENT_ID, VITE_GITHUB_APP_SLUG: SLUG, VITE_GITHUB_SIGNIN_HELPER_URL: HELPER };
/** Blank, so a developer's client/.env can't turn the button on in the
 * build that must not have it (a variable in the environment wins). */
const NO_SIGN_IN = { VITE_GITHUB_APP_CLIENT_ID: "", VITE_GITHUB_APP_SLUG: "", VITE_GITHUB_SIGNIN_HELPER_URL: "" };
const HOUR_S = 3600;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(test: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await test()) return true;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

const results: { label: string; ok: boolean }[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${!ok && detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

interface ConsoleProblem {
  level: "error" | "warning";
  text: string;
}

/** The sign-in helper, as signin-helper/src/worker.ts answers, with
 * GitHub's rotation behind it: a code works once, and so does a refresh
 * token. Each token it issues is added to the fake GitHub for the login. */
function fakeHelper(adapter: FakeGitHubAdapter, origin: string) {
  const state = {
    calls: [] as { path: string; refreshToken?: string }[],
    codes: new Map<string, string>(),
    refreshTokens: new Map<string, string>(),
    /** Lifetime of the next token /token hands out, in seconds. */
    tokenLifetime: 8 * HOUR_S,
    /** Every refresh is refused as bad_refresh_token (the sign-in expired). */
    refuseRefresh: false,
    issued: 0,
    latest: "",
  };
  function issue(login: string, lifetime: number) {
    state.issued++;
    const token = `ghu_e2e${state.issued}${randomBytes(6).toString("hex")}`;
    const refresh = `ghr_e2e${state.issued}${randomBytes(6).toString("hex")}`;
    adapter.addToken(token, { login, repos: [FULL], permission: "write" });
    state.refreshTokens.set(refresh, login);
    state.latest = token;
    const now = Date.now();
    return {
      access_token: token,
      expires_in: lifetime,
      expires_at: now + lifetime * 1000,
      refresh_token: refresh,
      refresh_token_expires_in: 180 * 24 * HOUR_S,
      refresh_token_expires_at: now + 180 * 24 * HOUR_S * 1000,
    };
  }
  async function handle(route: Route) {
    const request = route.request();
    const cors = { "access-control-allow-origin": origin, vary: "Origin", "cache-control": "no-store" };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "Content-Type" } });
      return;
    }
    const pathname = new URL(request.url()).pathname;
    const body = JSON.parse(request.postData() ?? "{}") as Record<string, string>;
    const answer = (status: number, json: unknown) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(json) });
    if (pathname === "/token") {
      state.calls.push({ path: "/token" });
      const login = state.codes.get(body.code);
      state.codes.delete(body.code);
      return void (await (login ? answer(200, issue(login, state.tokenLifetime)) : answer(400, { error: "bad_verification_code" })));
    }
    if (pathname === "/refresh") {
      state.calls.push({ path: "/refresh", refreshToken: body.refresh_token });
      const login = state.refreshTokens.get(body.refresh_token);
      state.refreshTokens.delete(body.refresh_token);
      return void (await (state.refuseRefresh || !login ? answer(400, { error: "bad_refresh_token" }) : answer(200, issue(login, 8 * HOUR_S))));
    }
    await answer(404, { error: "not_found" });
  }
  return { state, handle };
}

/** GitHub's authorize page, approving at once (or returning the wrong
 * state): held until the check releases it, so the check can read the
 * page's stored verifier first. */
function fakeAuthorize(helper: ReturnType<typeof fakeHelper>) {
  const pending: { url: URL; release: (mode: "approve" | "badstate") => Promise<void> }[] = [];
  async function handle(route: Route) {
    const url = new URL(route.request().url());
    await new Promise<void>((done) => {
      pending.push({
        url,
        release: async (mode) => {
          const back = new URL(url.searchParams.get("redirect_uri")!);
          const code = `code-${randomBytes(6).toString("hex")}`;
          helper.state.codes.set(code, ALEX);
          back.searchParams.set("code", code);
          back.searchParams.set("state", mode === "badstate" ? "not-the-state-this-tab-made" : url.searchParams.get("state")!);
          await route.fulfill({ status: 302, headers: { location: back.href } });
          done();
        },
      });
    });
  }
  return { pending, handle };
}

/** The connection record in the page's device store, read without
 * creating the database when it isn't there. */
async function storedConnection(page: Page): Promise<{ kind: string; token: string; refreshToken?: string; login: string } | null> {
  return page.evaluate(async () => {
    if (!(await indexedDB.databases()).some((d) => d.name === "ledger:github")) return null;
    return new Promise((resolve) => {
      const open = indexedDB.open("ledger:github");
      open.onsuccess = () => {
        const get = open.result.transaction("device").objectStore("device").get("ledger:connection");
        get.onsuccess = () => {
          open.result.close();
          resolve(get.result ?? null);
        };
        get.onerror = () => resolve(null);
      };
      open.onerror = () => resolve(null);
    });
  });
}

const cspOf = async (page: Page) => (await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")) ?? "";
const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });

async function walkToConnect(page: Page) {
  await heading(page, "Set up Ledger").waitFor();
  await page.click('[data-testid="gh-welcome-personal"]');
  await heading(page, "Create your data repository").waitFor();
  await page.click('[data-testid="gh-step-next"]');
  await heading(page, "Create a token for Ledger").waitFor();
  await page.click('[data-testid="gh-step-next"]');
  await heading(page, "Paste your token").waitFor();
}

async function addExpense(page: Page, amount: string, remarks: string) {
  if ((await page.locator(".add-expense-form").count()) === 0) await page.locator(".tabs button", { hasText: "Expenses" }).click();
  await page.waitForSelector(".add-expense-form");
  await page.fill('.add-expense-form input[type="number"]', amount);
  await page.fill('.add-expense-form input[type="text"]', remarks);
  await page.click('.add-expense-form button.category-chip:has-text("Food")');
  await page.click('button.submit-btn:has-text("Add Expense")');
  await page.locator(".entry-remarks", { hasText: new RegExp(`^${remarks}$`) }).first().waitFor();
}

async function waitSaved(page: Page, timeout = 45_000): Promise<boolean> {
  return waitUntil(async () => (await page.locator(".sync-status [role=status]").innerText({ timeout: 2000 })).trim() === "Saved", timeout);
}

/** The repo's document as every device will see it: the genesis joined
 * with each device's log (no snapshots this early). */
async function folded(adapter: FakeGitHubAdapter): Promise<{ doc: LedgerDocument; logs: number }> {
  const { fake } = adapter;
  const paths = [...new Set(fake.versions(FULL).map((v) => v.path))].filter((p) => p.startsWith(`${LEDGER_DIR}/`));
  const files = paths.flatMap((p) => {
    const now = fake.file(FULL, p);
    const file = parseRepoFileName(p.slice(LEDGER_DIR.length + 1));
    return now && file ? [{ name: p.slice(LEDGER_DIR.length + 1), file, text: now.text }] : [];
  });
  const epoch = winningEpoch(files.map((f) => f.name));
  const genesisFile = files.find((f) => f.file.kind === "genesis" && f.file.epoch === epoch);
  if (!genesisFile) throw new Error(`no ledger in ${FULL}`);
  const header = parseHeader(genesisFile.text);
  const key = { key: await deriveKey(PASS, header.salt, header.iter), salt: header.salt, iter: header.iter };
  const genesis = await openRepoFile(genesisFile.file, genesisFile.text, key);
  if (!genesis.ok) throw new Error(`genesis unreadable: ${genesis.detail}`);
  const state = genesisState((genesis.read.file as unknown as { doc: LedgerDocument }).doc);
  const logs = files.filter((f) => f.file.kind === "log" && f.file.epoch === epoch);
  for (const f of logs) {
    const read = await openRepoFile(f.file, f.text, key);
    if (!read.ok || f.file.kind !== "log") throw new Error(`${f.name} unreadable`);
    for (const op of (read.read.file as unknown as { ops: Op[] }).ops) applyOp(state, f.file.device, op);
  }
  return { doc: materialize(state), logs: logs.length };
}
const expenseNamed = (doc: LedgerDocument, remarks: string) => Object.values(doc.expenses).flat().find((e) => e.remarks === remarks);

async function main() {
  const consoleProblems: ConsoleProblem[] = [];
  const provoked = new Map<string, number>();
  let browser: Browser | undefined;
  let preview: PagesPreview | undefined;
  let adapter: FakeGitHubAdapter | undefined;

  async function provoking<T>(patterns: RegExp[], step: () => Promise<T>): Promise<T> {
    const from = consoleProblems.length;
    try {
      return await step();
    } finally {
      await sleep(300);
      for (let i = consoleProblems.length - 1; i >= from; i--) {
        if (patterns.some((p) => p.test(consoleProblems[i].text))) {
          const [dropped] = consoleProblems.splice(i, 1);
          const text = `${dropped.level}: ${dropped.text}`.replace(/https?:\/\/\S+/g, "<url>");
          provoked.set(text, (provoked.get(text) ?? 0) + 1);
        }
      }
    }
  }
  const status = (...codes: number[]) => new RegExp(`status of (${codes.join("|")})\\b`);

  async function newDevice(): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser!.newContext({ timezoneId: "America/New_York", viewport: { width: 1280, height: 900 } });
    await adapter!.install(context, "signin");
    const page = await context.newPage();
    page.on("console", (msg) => {
      const type = msg.type();
      if (type === "error" || type === "warning") consoleProblems.push({ level: type, text: msg.text() });
    });
    page.on("pageerror", (err) => consoleProblems.push({ level: "error", text: `pageerror: ${err.message}` }));
    return { context, page };
  }

  try {
    browser = await chromium.launch();

    // ============ S1. A build without the three settings ============
    preview = await buildAndPreview({ env: NO_SIGN_IN });
    adapter = createFakeGitHubAdapter({ origin: preview.origin, repos: [{ owner: ALEX, name: REPO, private: true }], tokens: {} });
    {
      const plain = await newDevice();
      await plain.page.goto(preview.url);
      await walkToConnect(plain.page);
      const button = await plain.page.locator('[data-testid="gh-signin"]').count();
      const csp = await cspOf(plain.page);
      const bundle = fs
        .readdirSync(path.join(ROOT, "client", "dist-pages"), { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .filter((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf8").includes("signin-e2e.example.workers.dev"))
        .map((e) => e.name);
      check(
        "S1. Without the three settings: no Sign in with GitHub button, the paste card as #8 shipped it, and no helper in the CSP or the bundle (AC2)",
        button === 0 && (await plain.page.locator('[data-testid="gh-token"]').count()) === 1 && !csp.includes(HELPER) && csp.includes("connect-src 'self' https://api.github.com") && bundle.length === 0,
        { button, csp, bundle },
      );
      await plain.context.close();
    }
    if (adapter.problems().length > 0) check("S1. The fake saw nothing it doesn't model", false, adapter.problems());
    preview.stop();

    // ============ S2. A build with them ============
    preview = await buildAndPreview({ env: SIGN_IN_SETTINGS });
    adapter = createFakeGitHubAdapter({ origin: preview.origin, repos: [{ owner: ALEX, name: REPO, private: true }], tokens: {} });
    const helper = fakeHelper(adapter, preview.origin);
    const authorize = fakeAuthorize(helper);
    const { fake } = adapter;
    const { context, page } = await newDevice();
    // What the page stores for a sign-in it starts, as it writes it: the
    // page can't be asked while the fake authorize page holds its
    // navigation. A string, not a function: tsx would wrap a function in
    // helpers the page doesn't have.
    const signInEntries: string[] = [];
    await context.exposeBinding("__ledgerSignInEntry", (_source, value: string) => void signInEntries.push(value));
    await context.addInitScript({
      content:
        'const set = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key === "ledger:github-signin") window.__ledgerSignInEntry(String(value)); return set.call(this, key, value); };',
    });
    // Registered after the adapter's catch-all, so these win for their hosts.
    await context.route((url) => url.origin === HELPER, (route) => helper.handle(route));
    await context.route((url) => url.origin === "https://github.com" && url.pathname === "/login/oauth/authorize", (route) => authorize.handle(route));
    const base = preview.url;
    await page.goto(base);
    await walkToConnect(page);
    const csp = await cspOf(page);
    check(
      "S2. With the three settings: the button shows above the paste field, and the CSP's connect-src lists the helper's origin (AC3)",
      (await page.locator('[data-testid="gh-signin"]').count()) === 1 && (await page.locator('[data-testid="gh-token"]').count()) === 1 && /connect-src 'self' https:\/\/api\.github\.com https:\/\/signin-e2e\.example\.workers\.dev(;|$)/.test(csp),
      csp,
    );

    // ============ S3. A return whose state doesn't match ============
    // noWaitAfter: the navigation it starts is held by the fake authorize
    // page until the check releases it.
    await page.click('[data-testid="gh-signin"]', { noWaitAfter: true });
    await waitUntil(() => authorize.pending.length === 1);
    await authorize.pending.shift()!.release("badstate");
    await page.locator(".error", { hasText: "Sign-in didn't complete. Try again." }).waitFor();
    check(
      "S3. A mismatched state: \"Sign-in didn't complete. Try again.\", no helper call, the code and state gone from the address bar and the sign-in entry removed (AC4)",
      helper.state.calls.length === 0 &&
        !/[?&](code|state)=/.test(page.url()) &&
        (await page.evaluate(() => sessionStorage.getItem("ledger:github-signin"))) === null &&
        (await heading(page, "Paste your token").count()) === 1,
      { calls: helper.state.calls, url: page.url() },
    );

    // ============ S4. Sign in: the authorize URL, then the install prompt ============
    // The sign-in's token has 4 minutes left: it must be refreshed before
    // its first request, so it never reaches GitHub.
    helper.state.tokenLifetime = 240;
    await page.click('[data-testid="gh-signin"]', { noWaitAfter: true });
    await waitUntil(() => authorize.pending.length === 1);
    const asked = authorize.pending[0].url;
    const entry = JSON.parse(signInEntries.at(-1) ?? "{}") as { verifier?: string; state?: string };
    const params = Object.fromEntries(asked.searchParams);
    const challenge = createHash("sha256").update(entry.verifier ?? "").digest("base64url");
    check(
      "S4. The authorize URL: client_id, redirect_uri the site's base URL, the S256 challenge of the stored verifier (43 characters), and a state of at least 128 bits (AC3)",
      `${asked.origin}${asked.pathname}` === "https://github.com/login/oauth/authorize" &&
        params.client_id === CLIENT_ID &&
        params.redirect_uri === base &&
        params.code_challenge_method === "S256" &&
        params.code_challenge === challenge &&
        /^[A-Za-z0-9_-]{43}$/.test(params.code_challenge) &&
        params.state === entry.state &&
        /^[A-Za-z0-9_-]{22,}$/.test(params.state ?? ""),
      { params, entry: { state: entry.state, verifier: entry.verifier ? "(present)" : null } },
    );
    await authorize.pending.shift()!.release("approve");
    await page.locator('[data-testid="gh-install-prompt"]').waitFor({ timeout: 30_000 });
    const prompt = await page.locator('[data-testid="gh-install-prompt"]').innerText();
    const installHref = await page.locator('[data-testid="gh-install-link"]').getAttribute("href");
    check(
      "S5. The App not installed on the repo: \"Give Ledger access to alex-signin-e2e/ledger-data\" with the install link, and no contents request made (AC6)",
      prompt.includes(`Give Ledger access to ${FULL}`) && installHref === `https://github.com/apps/${SLUG}/installations/new` && !adapter.log.some((r) => r.path.startsWith("/repos/")),
      { prompt, installHref, log: adapter.log.map((r) => `${r.method} ${r.path} ${r.status}`) },
    );
    check(
      "S6. A token with under 5 minutes left is refreshed before the first request: /token, then /refresh, and GitHub never saw a 401 (AC7)",
      helper.state.calls.map((c) => c.path).join(",") === "/token,/refresh" && adapter.log.length > 0 && adapter.log.every((r) => r.status !== 401),
      { calls: helper.state.calls, log: adapter.log.map((r) => `${r.method} ${r.path} ${r.status}`) },
    );

    // ============ S7. Installed: Check again, then Create, and a saved expense ============
    fake.install({ id: 1, account: ALEX, repos: [FULL] });
    // An empty repo's branch ref answers 409, as #11's connect step allows.
    await provoking([status(409)], async () => {
      await page.click('[data-testid="gh-install-check"]');
      await heading(page, "Create your ledger").waitFor({ timeout: 30_000 });
    });
    check("S7. After installing, Check again goes on to Create your ledger without signing in again (AC6)", helper.state.calls.filter((c) => c.path === "/token").length === 1);
    await provoking([status(404, 409)], async () => {
      for (const section of ["expenses", "finances", "debts", "emi", "credit-cards", "subscriptions"]) await page.check(`[data-testid="gh-section-${section}"]`);
      await page.fill('[data-testid="gh-passphrase"]', PASS);
      await page.fill('[data-testid="gh-passphrase-confirm"]', PASS);
      await page.check('[data-testid="gh-passphrase-saved"]');
      await page.click('[data-testid="gh-create"]');
      await page.waitForSelector(".tabs", { timeout: 30_000 });
    });
    await addExpense(page, "42", "E2E Signed In");
    const savedFirst = await waitSaved(page);
    const first = await folded(adapter);
    const record = await storedConnection(page);
    check(
      "S8. Signed in, the expense reaches the repo in this device's op log, updatedBy is the GitHub login, and the saved ledger:connection record has kind \"app\" (AC5)",
      savedFirst && first.logs === 1 && expenseNamed(first.doc, "E2E Signed In")?.updatedBy === ALEX && record?.kind === "app" && record.login === ALEX && record.token.startsWith("ghu_"),
      { savedFirst, logs: first.logs, updatedBy: expenseNamed(first.doc, "E2E Signed In")?.updatedBy, kind: record?.kind },
    );

    // ============ S9. A 401: one refresh, one retry ============
    const refreshesBefore = helper.state.calls.filter((c) => c.path === "/refresh").length;
    const mark = adapter.log.length;
    fake.revokeToken(helper.state.latest);
    await provoking([status(401)], async () => {
      await addExpense(page, "7", "E2E After 401");
      await waitSaved(page);
    });
    const since = adapter.log.slice(mark);
    const firstRefused = since.findIndex((r) => r.status === 401);
    const retried = firstRefused >= 0 && since.slice(firstRefused + 1).some((r) => r.method === since[firstRefused].method && r.path === since[firstRefused].path && r.status !== 401);
    const afterRefresh = await folded(adapter);
    check(
      "S9. A 401 from the contents API: exactly one refresh, the refused request retried with the new token, and the change saved (AC7)",
      helper.state.calls.filter((c) => c.path === "/refresh").length === refreshesBefore + 1 && retried && expenseNamed(afterRefresh.doc, "E2E After 401") !== undefined,
      { refreshes: helper.state.calls.length, since: since.map((r) => `${r.method} ${r.path} ${r.status}`) },
    );

    // ============ S10. The sign-in expires ============
    helper.state.refuseRefresh = true;
    fake.revokeToken(helper.state.latest);
    await provoking([status(400, 401)], async () => {
      await addExpense(page, "19", "E2E Pending");
      await heading(page, "Replace your token").waitFor({ timeout: 45_000 });
    });
    const expiredShown = (await page.getByText("Your GitHub sign-in expired. Sign in again.").count()) === 1;
    const cleared = await storedConnection(page);
    const pendingRemote = expenseNamed((await folded(adapter)).doc, "E2E Pending") !== undefined;
    check(
      "S10. A refused refresh: Replace token says \"Your GitHub sign-in expired. Sign in again.\" with the button beside the paste field, the stored App tokens are cleared, and the unsynced change isn't on GitHub yet (AC7)",
      expiredShown &&
        (await page.locator('[data-testid="gh-signin"]').count()) === 1 &&
        (await page.locator('[data-testid="gh-replace-token"]').count()) === 1 &&
        cleared?.kind === "app" &&
        cleared.token === "" &&
        cleared.refreshToken === undefined &&
        !pendingRemote,
      { expiredShown, cleared, pendingRemote },
    );

    // ============ S11. Signing in again, across the reload ============
    helper.state.refuseRefresh = false;
    helper.state.tokenLifetime = 8 * HOUR_S;
    await page.click('[data-testid="gh-signin"]', { noWaitAfter: true });
    await waitUntil(() => authorize.pending.length === 1);
    await authorize.pending.shift()!.release("approve");
    await page.waitForSelector(".tabs", { timeout: 45_000 });
    const savedAgain = await waitSaved(page);
    const after = await folded(adapter);
    const renewed = await storedConnection(page);
    check(
      "S11. Signing in again reloads the page, and the change made while signed out is still pending and reaches GitHub, with the App tokens saved again (AC7)",
      savedAgain &&
        expenseNamed(after.doc, "E2E Pending")?.updatedBy === ALEX &&
        expenseNamed(after.doc, "E2E Signed In") !== undefined &&
        renewed?.kind === "app" &&
        renewed.token === helper.state.latest &&
        !/[?&](code|state)=/.test(page.url()),
      { savedAgain, renewed: renewed?.kind, url: page.url() },
    );

    // ============ S12. Forget this device ============
    // A sign-in started and never finished, as if this tab left for GitHub.
    await page.evaluate(() => sessionStorage.setItem("ledger:github-signin", JSON.stringify({ state: "s", verifier: "v", redirectUri: location.href, resume: { path: null, org: null, owner: null, repo: "ledger-data" } })));
    await page.click('[data-testid="gh-settings"]');
    await heading(page, "Settings").waitFor();
    await page.click('[data-testid="gh-forget"]');
    await page.waitForSelector(".dialog-card");
    await page.click(".dialog-confirm");
    await heading(page, "Set up Ledger").waitFor({ timeout: 30_000 });
    const left = await page.evaluate(async () => ({
      databases: (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith("ledger:")),
      session: Object.keys(sessionStorage).filter((k) => k.startsWith("ledger:")),
      local: Object.entries(localStorage).filter(([k, v]) => k.startsWith("ledger:") && /gh[ur]_/.test(v)).map(([k]) => k),
    }));
    check(
      "S12. Forget this device removes the App tokens and key (ledger:github), the sync state (ledger:sync) and the sign-in entry; no ledger: key with a token is left in any storage (AC8)",
      left.databases.length === 0 && left.session.length === 0 && left.local.length === 0,
      left,
    );
    await context.close();
  } catch (err) {
    console.error(err);
    check("The run went through every step", false, err instanceof Error ? err.message : String(err));
  } finally {
    await browser?.close();
    preview?.stop();
  }

  check("S13. The fake GitHub saw no request it doesn't model and no host outside the allow-list", adapter !== undefined && adapter.problems().length === 0, adapter?.problems());
  check("S14. No console errors or page errors, except those a step provokes on purpose", consoleProblems.filter((p) => p.level === "error").length === 0, consoleProblems.filter((p) => p.level === "error"));
  check("S14. No console warnings, except those a step provokes on purpose", consoleProblems.filter((p) => p.level === "warning").length === 0, consoleProblems.filter((p) => p.level === "warning"));

  const failed = results.filter((r) => !r.ok);
  console.log("\n=== e2e Sign in with GitHub summary ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.label}`);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  console.log("Console errors provoked on purpose and dropped:", provoked.size ? Object.fromEntries(provoked) : "none");
  if (failed.length) {
    console.error("\ne2e Sign in with GitHub FAILED");
    process.exit(1);
  }
  console.log("\ne2e Sign in with GitHub PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
