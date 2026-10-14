/**
 * The GitHub storage mode end to end (`npm run test:e2e:github`, epic #1,
 * issue #11): the real Pages bundle, built with
 * `npm run build:pages -w client -- --base /ledger/` into client/dist-pages
 * and served by `vite preview` under /ledger/ on CLIENT_PORT + 1, driven in
 * Chromium against the in-memory fake of GitHub's API (e2e/fakeGithub.ts,
 * a routing adapter over the unit tests' own fake). Each simulated device
 * is its own browser context, in America/New_York.
 *
 * Needs no Supabase stack, no server/.env, no database and no network: the
 * only process it starts is the preview server, which it stops by PID. It
 * never runs scripts/kill-ports.js or `npm run dev`, so it can't stop a
 * live server on SERVER_PORT or CLIENT_PORT.
 *
 * The stored files are seeded and inspected in Node with the sync engine's
 * own modules (crypto, epoch, repoFiles, codec, state, materialize, and the
 * pure ten-year plan in tenYearPlan.ts), never
 * deviceStore.ts. Fictional data only: logins alex-e2e and sam-e2e, the
 * organization household-e2e, the repo ledger-data, passphrases made per
 * run.
 */
import { spawn, spawnSync, execSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { CLIENT_PORT, ROOT } from "./devServer.js";
import { createFakeGitHubAdapter, type RoutedRequest } from "./fakeGithub.js";
import { DEFAULT_ITERATIONS, deriveKey, encryptDocument, newSalt, parseHeader } from "../client/src/backend/crypto.js";
import { base64ToBytes, bytesToBase64 } from "../client/src/backend/base64.js";
import { createEmptyDocument } from "../client/src/backend/document/createDocument.js";
import type { LedgerDocument } from "../client/src/backend/document/types.js";
import { FORMAT_VERSION } from "../client/src/backend/sync/codec.js";
import { nextEpochKey, parseRepoFileName, winningEpoch, type RepoFile } from "../client/src/backend/sync/epoch.js";
import { materialize } from "../client/src/backend/sync/materialize.js";
import type { DeviceKey } from "../client/src/backend/sync/records.js";
import { LEDGER_DIR, openRepoFile } from "../client/src/backend/sync/repoFiles.js";
import { applyOp, cloneState, genesisState, joinInto, type Op } from "../client/src/backend/sync/state.js";

// --- Build and preview (exported: #10's e2e reuses it) ----------------------------

/** Where the Pages build is served: a sub-path, as a project site is, so an
 * absolute-path regression shows up as a 404. */
export const PAGES_BASE = "/ledger/";
export const PREVIEW_PORT = CLIENT_PORT + 1;

export interface PagesPreview {
  /** e.g. http://localhost:5274 */
  origin: string;
  /** The app's URL: origin + PAGES_BASE. */
  url: string;
  stop(): void;
}

/** Kills the process tree rooted at `child`, and nothing else. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
}

/** Whether anything accepts connections on localhost:`port` (IPv4 or IPv6). */
async function portInUse(port: number): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
  return (await tryHost("127.0.0.1")) || (await tryHost("::1"));
}

/** The build's environment: VITE_DEFAULT_MODULES pinned to every section,
 * so a fork's committed client/.env.github or a developer's client/.env
 * can't change what the checks expect (Vite lets a variable already in the
 * environment win over its .env files). */
const BUILD_ENV = { ...process.env, VITE_DEFAULT_MODULES: "expenses,finances,debts,emi,credit-cards,subscriptions" };

/** Builds the GitHub Pages bundle (client/dist-pages, never client/dist)
 * with `--base /ledger/`, then serves it with `vite preview --mode github`
 * on CLIENT_PORT + 1 (strictPort: a busy port fails rather than moving).
 * Refuses to start when something already listens there (another
 * worktree's preview), and resolves only once its own server answers with
 * this build's index.html. `stop()` kills only the preview's own process
 * tree; so do Ctrl+C, SIGTERM and the process exiting. */
export async function buildAndPreview({ build = true }: { build?: boolean } = {}): Promise<PagesPreview> {
  if (build) {
    console.log(`Building the GitHub Pages bundle (--base ${PAGES_BASE})...`);
    const built = spawnSync("npm", ["run", "build:pages", "-w", "client", "--", "--base", PAGES_BASE], {
      cwd: ROOT,
      env: BUILD_ENV,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      encoding: "utf8",
    });
    if (built.status !== 0) throw new Error(`build:pages failed:
${built.stdout}
${built.stderr}`);
  }
  if (await portInUse(PREVIEW_PORT)) {
    throw new Error(`Port ${PREVIEW_PORT} is already in use (another checkout's preview?). Stop it, or give this checkout another VITE_DEV_PORT in client/.env.`);
  }
  const origin = `http://localhost:${PREVIEW_PORT}`;
  const builtIndex = fs.readFileSync(path.join(ROOT, "client", "dist-pages", "index.html"), "utf8");
  console.log(`Serving client/dist-pages at ${origin}${PAGES_BASE}...`);
  // Vite's own script, run by this Node: no shell, so the PID is vite's.
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "preview", "--mode", "github", "--base", PAGES_BASE, "--strictPort", "--port", String(PREVIEW_PORT)],
    { cwd: path.join(ROOT, "client"), env: BUILD_ENV, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => (output += String(chunk)));
  child.stderr?.on("data", (chunk) => (output += String(chunk)));
  const onSignal = (signal: NodeJS.Signals) => {
    stop();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const stop = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", stop);
    killTree(child);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", stop);
  const alive = () => child.exitCode === null && child.signalCode === null;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (!alive()) {
      stop();
      throw new Error(`vite preview exited (${child.exitCode ?? child.signalCode}):
${output}`);
    }
    try {
      const res = await fetch(`${origin}${PAGES_BASE}`);
      // Ours, still running after it answered, and serving this build.
      if (res.ok && (await res.text()) === builtIndex) {
        await sleep(300);
        if (alive()) break;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      stop();
      throw new Error(`vite preview didn't serve client/dist-pages on ${origin}${PAGES_BASE}:
${output}`);
    }
    await sleep(250);
  }
  return { origin, url: `${origin}${PAGES_BASE}`, stop };
}

// --- The run --------------------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const results: { label: string; ok: boolean }[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${!ok && detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}

/** Polls `test` until it holds or `timeoutMs` passes; false on timeout. */
async function waitUntil(test: () => boolean | Promise<boolean>, timeoutMs = 30_000, everyMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await test()) return true;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) return false;
    await sleep(everyMs);
  }
}

const TIME_ZONE = "America/New_York";
const ALEX = "alex-e2e";
const SAM = "sam-e2e";
const ORG = "household-e2e";
const REPO = "ledger-data";
const PERSONAL_REPO = `${ALEX}/${REPO}`;
const HOUSEHOLD_REPO = `${ORG}/${REPO}`;
const RESTORE_REPO = `${ORG}/ledger-restore`;
const TEN_YEAR_REPO = `${ALEX}/ledger-ten`;

/** Fine-grained tokens, fictional; the fake knows all but the first. */
const TOKEN = {
  unknown: "github_pat_e2e_unknown_0000",
  alexPersonal: "github_pat_e2e_alex_personal",
  alexHousehold: "github_pat_e2e_alex_household",
  alexElsewhere: "github_pat_e2e_alex_elsewhere",
  alexRenewed: "github_pat_e2e_alex_renewed",
  sam: "github_pat_e2e_sam_household",
};

const passphrase = (label: string) => `${label} ${randomBytes(9).toString("base64url")}`;
const PASS = { personal: passphrase("personal"), household: passphrase("household"), other: passphrase("other"), tenYear: passphrase("ten year") };

const SECTION_IDS = ["expenses", "finances", "debts", "emi", "credit-cards", "subscriptions"];
const ALLOWED_KEYS = new Set(["ledger-theme", "ledger-upcoming-collapsed", "ledger-emi-projection-scale"]);
const LOCKED_TAIL = "is locked. Unlock it first from the app if you really need to add an entry there.";

/** A console error or warning (or an uncaught page error). */
interface ConsoleError {
  context: string;
  level: "error" | "warning";
  text: string;
}

async function main() {
  const preview = await buildAndPreview();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-e2e-github-"));
  const adapter = createFakeGitHubAdapter({
    origin: preview.origin,
    repos: [
      { owner: ALEX, name: REPO, private: true },
      { owner: ORG, name: REPO, private: true },
      { owner: ORG, name: "ledger-restore", private: true },
      { owner: ALEX, name: "ledger-ten", private: true },
    ],
    tokens: {
      [TOKEN.alexPersonal]: { login: ALEX, repos: [PERSONAL_REPO, TEN_YEAR_REPO], permission: "write" },
      [TOKEN.alexHousehold]: { login: ALEX, repos: [HOUSEHOLD_REPO, RESTORE_REPO], permission: "write" },
      // A token whose resource owner is alex, not the household: GitHub
      // answers the household's repo with 404.
      [TOKEN.alexElsewhere]: { login: ALEX, repos: [PERSONAL_REPO], permission: "write" },
      [TOKEN.sam]: { login: SAM, repos: [HOUSEHOLD_REPO], permission: "write" },
    },
  });
  const { fake } = adapter;
  const consoleErrors: ConsoleError[] = [];
  /** What provoking() dropped, printed in the summary. */
  const provoked = new Map<string, number>();
  /** Preview-origin responses: every asset must load under the base. */
  const previewResponses: { url: string; status: number }[] = [];
  const allRequestUrls: string[] = [];
  let browser: Browser | undefined;
  let serviceWorkers = -1;
  /** Every simulated device's page, for screenshots when a step fails. */
  const pages = new Map<string, Page>();

  /** Console errors and warnings a step provokes on purpose (a status
   * GitHub answers it with, the browser going offline), dropped as
   * e2e/auth.ts drops its 400s: only from those contexts, only while the
   * step runs. */
  async function provoking<T>(context: string | string[], patterns: RegExp[], step: () => Promise<T>): Promise<T> {
    const contexts = Array.isArray(context) ? context : [context];
    const from = consoleErrors.length;
    try {
      return await step();
    } finally {
      await sleep(300);
      for (let i = consoleErrors.length - 1; i >= from; i--) {
        if (contexts.includes(consoleErrors[i].context) && patterns.some((p) => p.test(consoleErrors[i].text))) {
          const [dropped] = consoleErrors.splice(i, 1);
          const text = `${dropped.level}: ${dropped.text}`.replace(/https?:\/\/\S+/g, "<url>");
          provoked.set(text, (provoked.get(text) ?? 0) + 1);
        }
      }
    }
  }
  const status = (...codes: number[]) => new RegExp(`status of (${codes.join("|")})\\b`);
  const OFFLINE_ERRORS = /net::ERR_INTERNET_DISCONNECTED/;

  async function device(name: string, { insecure = false }: { insecure?: boolean } = {}): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser!.newContext({ timezoneId: TIME_ZONE, acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    await adapter.install(context, name);
    if (insecure) {
      // As on plain http://: the page has no crypto.subtle.
      // A string, not a function: tsx's transform would wrap a function in
      // helpers the page doesn't have.
      await context.addInitScript({ content: 'Object.defineProperty(Crypto.prototype, "subtle", { get: () => undefined, configurable: true });' });
    }
    context.on("request", (request) => allRequestUrls.push(request.url()));
    context.on("response", (response) => {
      if (response.url().startsWith(preview.origin)) previewResponses.push({ url: response.url(), status: response.status() });
    });
    const page = await context.newPage();
    pages.set(name, page);
    page.on("console", (msg) => {
      const type = msg.type();
      if (type === "error" || type === "warning") {
        consoleErrors.push({ context: name, level: type, text: msg.text() });
        if (type === "warning") console.log(`      console warning (${name}): ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => consoleErrors.push({ context: name, level: "error", text: `pageerror: ${err.message}` }));
    return { context, page };
  }

  // --- Repo inspection in Node, with the engine's own modules ---

  const keys = new Map<string, Promise<CryptoKey>>();
  function keyFor(pass: string, salt: string, iter: number): Promise<CryptoKey> {
    const id = `${pass}\n${salt}\n${iter}`;
    if (!keys.has(id)) keys.set(id, deriveKey(pass, salt, iter));
    return keys.get(id)!;
  }

  /** The files under ledger/ at the head of `repo`. */
  function ledgerFiles(repo: string): { name: string; file: RepoFile; text: string }[] {
    const paths = [...new Set(fake.versions(repo).map((v) => v.path))].filter((p) => p.startsWith(`${LEDGER_DIR}/`));
    return paths.flatMap((p) => {
      const now = fake.file(repo, p);
      const name = p.slice(LEDGER_DIR.length + 1);
      const file = parseRepoFileName(name);
      return now && file ? [{ name, file, text: now.text }] : [];
    });
  }

  interface Folded {
    doc: LedgerDocument;
    epoch: string;
    /** Each device's log ops in the winning epoch. */
    logs: Map<string, Op[]>;
  }

  /** The household's document as every device will see it: the winning
   * epoch's genesis, joined with each device's snapshot and log. */
  async function fold(repo: string, pass: string): Promise<Folded> {
    const files = ledgerFiles(repo);
    const epoch = winningEpoch(files.map((f) => f.name));
    if (epoch === null) throw new Error(`no ledger in ${repo}`);
    const genesisFile = files.find((f) => f.file.kind === "genesis" && f.file.epoch === epoch)!;
    const header = parseHeader(genesisFile.text);
    const key: DeviceKey = { key: await keyFor(pass, header.salt, header.iter), salt: header.salt, iter: header.iter };
    const genesis = await openRepoFile(genesisFile.file, genesisFile.text, key);
    if (!genesis.ok || genesis.read.file.kind !== "genesis") throw new Error(`genesis unreadable: ${genesis.ok ? "" : genesis.detail}`);
    const state = genesisState((genesis.read.file as unknown as { doc: LedgerDocument }).doc);
    const base = cloneState(state);
    const logs = new Map<string, Op[]>();
    for (const f of files.filter((x) => x.file.kind === "snap" && x.file.epoch === epoch)) {
      const read = await openRepoFile(f.file, f.text, key, base);
      if (!read.ok || !read.read.state) throw new Error(`${f.name} unreadable`);
      joinInto(state, read.read.state);
    }
    for (const f of files.filter((x) => x.file.kind === "log" && x.file.epoch === epoch)) {
      const read = await openRepoFile(f.file, f.text, key);
      if (!read.ok || f.file.kind !== "log") throw new Error(`${f.name} unreadable`);
      const ops = (read.read.file as unknown as { ops: Op[] }).ops;
      logs.set(f.file.device, ops);
      for (const op of ops) applyOp(state, f.file.device, op);
    }
    return { doc: materialize(state), epoch, logs };
  }

  const allExpenses = (doc: LedgerDocument) => Object.values(doc.expenses).flat();
  const expenseNamed = (doc: LedgerDocument, remarks: string) => allExpenses(doc).find((e) => e.remarks === remarks);
  async function remoteHas(repo: string, pass: string, remarks: string): Promise<boolean> {
    return expenseNamed((await fold(repo, pass)).doc, remarks) !== undefined;
  }

  /** The file format's header as the checks read it (AC5). */
  function headerProblem(text: string, salt?: string): string | null {
    try {
      JSON.parse(text);
      return "the whole file parses as JSON";
    } catch {
      // as it must
    }
    const header = JSON.parse(text.slice(0, text.indexOf("\n"))) as Record<string, unknown>;
    if (header.alg !== "AES-GCM-256" || header.kdf !== "PBKDF2-SHA256" || header.iter !== 600000) return `header ${JSON.stringify(header)}`;
    if (base64ToBytes(String(header.salt)).length !== 16) return "the salt isn't 16 bytes";
    if (salt !== undefined && header.salt !== salt) return "a file carries another salt than the genesis";
    return null;
  }

  const logOf = (name: string) => adapter.log.filter((r) => r.context === name);
  const putsOf = (name: string, from = 0) => adapter.log.slice(from).filter((r) => r.context === name && r.method === "PUT");

  // --- UI helpers ---

  const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });
  async function waitHeading(page: Page, name: string, timeout = 30_000) {
    await heading(page, name).waitFor({ timeout });
  }
  const tabNames = async (page: Page) => (await page.locator(".tabs button .tab-label-full, .tabs button:not(:has(.tab-label-full))").allInnerTexts()).map((t) => t.trim());
  async function statusText(page: Page): Promise<string> {
    return (await page.locator(".sync-status [role=status]").innerText({ timeout: 2000 })).trim();
  }
  /** The app brought back to the front: the engine syncs (section 7). */
  async function nudge(page: Page) {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))).catch(() => {});
  }
  async function waitSaved(page: Page, timeout = 45_000): Promise<boolean> {
    return waitUntil(async () => (await statusText(page)) === "Saved", timeout);
  }
  /** Opens the Expenses tab. Another device's change, once joined,
   * remounts the ledger on its Dashboard (SyncHost re-keys it), so this
   * tries again when that happens under it. */
  async function openExpenses(page: Page) {
    for (let attempt = 1; ; attempt++) {
      try {
        if ((await page.locator(".add-expense-form").count()) === 0) await page.locator(".tabs button", { hasText: "Expenses" }).click({ timeout: 5000 });
        await page.waitForSelector(".add-expense-form", { timeout: 5000 });
        await page.waitForSelector(".loading-overlay", { state: "detached", timeout: 10_000 });
        return;
      } catch (err) {
        if (attempt >= 6) {
          console.log(`      ${page.url()} shows: ${(await page.locator("body").innerText().catch(() => "?")).slice(0, 600)}`);
          throw err;
        }
      }
    }
  }
  /** The current month's expenses as listed, top first. A remote join
   * remounts the ledger on its Dashboard, so this opens Expenses again. */
  async function listed(page: Page): Promise<string[]> {
    await openExpenses(page);
    return (await page.locator(".entry-row:not(.row-editing) .entry-remarks").allInnerTexts()).map((t) => t.trim());
  }
  const row = (page: Page, remarks: string) => page.locator(".entry-row", { has: page.locator(".entry-remarks", { hasText: new RegExp(`^${remarks}$`) }) });
  async function menu(page: Page, remarks: string, item: string) {
    await row(page, remarks).locator(".overflow-menu-trigger").click();
    await row(page, remarks).locator(".overflow-menu-list").getByRole("menuitem", { name: item }).click();
  }
  async function addExpense(page: Page, amount: string, remarks: string, category = "Food") {
    await openExpenses(page);
    await page.fill('.add-expense-form input[type="number"]', amount);
    await page.fill('.add-expense-form input[type="text"]', remarks);
    await page.click(`.add-expense-form button.category-chip:has-text("${category}")`);
    await page.click('button.submit-btn:has-text("Add Expense")');
    await row(page, remarks).waitFor();
  }
  async function editExpense(page: Page, remarks: string, amount: string, newRemarks = remarks) {
    await openExpenses(page);
    await menu(page, remarks, "Edit");
    await page.waitForSelector(".row-editing");
    const inputs = page.locator(".row-editing .edit-fields input");
    await inputs.nth(0).fill(amount);
    await inputs.nth(1).fill(newRemarks);
    await page.click('.row-editing button:has-text("Save")');
    await page.waitForSelector(".row-editing", { state: "detached" });
  }
  async function deleteExpense(page: Page, remarks: string) {
    await openExpenses(page);
    await menu(page, remarks, "Delete");
    await page.waitForSelector(".dialog-card");
    await page.click(".dialog-confirm");
    await row(page, remarks).waitFor({ state: "detached" });
  }
  const amountOf = async (page: Page, remarks: string) => (await row(page, remarks).locator(".entry-amount").innerText({ timeout: 5000 })).trim();
  async function shownAmount(page: Page, remarks: string): Promise<string> {
    await openExpenses(page);
    return amountOf(page, remarks);
  }

  /** Welcome to the paste-the-token card, by one of the three paths. */
  async function walkToConnect(page: Page, way: "personal" | "household" | "member") {
    await waitHeading(page, "Set up Ledger");
    await page.click(`[data-testid="gh-welcome-${way}"]`);
    const next = () => page.click('[data-testid="gh-step-next"]');
    if (way === "personal") {
      await waitHeading(page, "Create your data repository");
      await next();
      await waitHeading(page, "Create a token for Ledger");
      await next();
    } else if (way === "household") {
      await waitHeading(page, "Create a free organization for your household");
      await page.fill('[data-testid="gh-org-name"]', ORG);
      await next();
      for (const title of ["Create your data repository", "Token approval", "Invite your household", "Create a token for Ledger"]) {
        await waitHeading(page, title);
        await next();
      }
    } else {
      await waitHeading(page, "Accept the invitation");
      await page.fill('[data-testid="gh-org-name"]', ORG);
      await next();
      await waitHeading(page, "Create a token for Ledger");
      await next();
    }
    await waitHeading(page, "Paste your token");
  }
  async function connectWith(page: Page, token: string, repo?: string) {
    if (repo !== undefined) {
      await page.locator("summary", { hasText: "Different repository?" }).click();
      await page.fill('[data-testid="gh-repo"]', repo);
    }
    await page.fill('[data-testid="gh-token"]', token);
    await page.click('[data-testid="gh-connect"]');
  }
  /** Every section ticked, whatever this build ticks by default, so the
   * sections checks start from all six. */
  async function createLedger(page: Page, pass: string, confirm = pass) {
    for (const section of SECTION_IDS) await page.check(`[data-testid="gh-section-${section}"]`);
    await page.fill('[data-testid="gh-passphrase"]', pass);
    await page.fill('[data-testid="gh-passphrase-confirm"]', confirm);
    await page.check('[data-testid="gh-passphrase-saved"]');
    await page.click('[data-testid="gh-create"]');
  }
  async function unlockWith(page: Page, pass: string) {
    await page.fill('[data-testid="gh-unlock-passphrase"]', pass);
    await page.click('[data-testid="gh-unlock"]');
  }
  async function openSettings(page: Page) {
    await page.click('[data-testid="gh-settings"]');
    await waitHeading(page, "Settings");
  }
  async function closeSettings(page: Page) {
    await page.click('[data-testid="gh-settings-done"]');
    await page.waitForSelector(".tabs");
  }
  const errorText = async (page: Page) => (await page.locator(".error").allInnerTexts()).map((t) => t.trim());

  try {
    browser = await chromium.launch();
    const base = preview.url;

    // ================= 1. Build and isolation (first page load) =================
    const personal = await device("personal");
    await personal.page.goto(base);
    await waitHeading(personal.page, "Set up Ledger");
    serviceWorkers = await personal.page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);

    // ================= 2. Needs HTTPS (AC8) =================
    const insecure = await device("insecure", { insecure: true });
    await insecure.page.goto(base);
    await waitHeading(insecure.page, "This browser can't run Ledger");
    check(
      "2. Needs HTTPS: without crypto.subtle the app shows checkEnvironment's message and makes no GitHub request (AC8)",
      (await insecure.page.getByText("Ledger needs a secure (HTTPS) address to encrypt your data. Open it from an https:// link.").count()) === 1 &&
        logOf("insecure").length === 0,
      logOf("insecure"),
    );
    await insecure.context.close();

    // ================= 3. Onboarding, personal account =================
    check(
      "3. A fresh context shows onboarding: Welcome, no .tabs, no Supabase sign-in form",
      (await heading(personal.page, "Set up Ledger").count()) === 1 &&
        (await personal.page.locator(".tabs").count()) === 0 &&
        (await personal.page.locator("form.auth-card").count()) === 0,
    );
    await walkToConnect(personal.page, "personal");
    await provoking("personal", [status(409)], async () => {
      await connectWith(personal.page, TOKEN.alexPersonal);
      await waitHeading(personal.page, "Create your ledger");
    });
    const personalNamed = (await personal.page.locator("strong", { hasText: PERSONAL_REPO }).count()) === 1;
    const putsBeforePersonalCreate = putsOf("personal").length;
    const personalMark = adapter.log.length;
    await provoking("personal", [status(404, 409)], async () => {
      await createLedger(personal.page, PASS.personal);
      await personal.page.waitForSelector(".tabs", { timeout: 30_000 });
    });
    {
      const puts = putsOf("personal", personalMark);
      const genesisPuts = puts.filter((p) => p.put && /\.genesis\.enc$/.test(p.put.path));
      const files = ledgerFiles(PERSONAL_REPO);
      check(
        "3. Personal: connects to the private alex-e2e/ledger-data, writes nothing before the passphrase, then creates ledger/<epoch>.genesis.enc with one PUT without sha and opens the app",
        personalNamed &&
          putsBeforePersonalCreate === 0 &&
          genesisPuts.length === 1 &&
          puts[0] === genesisPuts[0] &&
          genesisPuts[0].put!.hadSha === false &&
          genesisPuts[0].status === 201 &&
          files.some((f) => f.file.kind === "genesis"),
        { personalNamed, putsBeforePersonalCreate, puts },
      );
    }

    // ================= 4. Onboarding, household org, device A =================
    const A = await device("A");
    await A.page.goto(base);
    await walkToConnect(A.page, "household");
    await provoking("A", [status(401)], async () => {
      await connectWith(A.page, TOKEN.unknown);
      await A.page.locator(".error", { hasText: "GitHub didn't accept this token." }).waitFor();
    });
    check(
      "4. Household: an unknown token shows the token error and stays on the step (401)",
      (await heading(A.page, "Paste your token").count()) === 1 &&
        (await errorText(A.page)).includes("GitHub didn't accept this token. Check you copied all of it.") &&
        logOf("A").some((r) => r.status === 401),
    );
    await provoking("A", [status(404)], async () => {
      await connectWith(A.page, TOKEN.alexElsewhere);
      await A.page.locator(".error", { hasText: "Can't find" }).waitFor();
    });
    check(
      "4. Household: a token without access to the repo shows the can't-reach-this-repo message with the approval hint (404), and offers Check again",
      (await heading(A.page, "Paste your token").count()) === 1 &&
        (await errorText(A.page)).includes(`Can't find ${HOUSEHOLD_REPO}, or this token wasn't given access to it. Your token may be waiting for approval by an owner of ${ORG}.`) &&
        (await A.page.locator('[data-testid="gh-check-again"]').count()) === 1 &&
        logOf("A").some((r) => r.status === 404),
      await errorText(A.page),
    );
    await provoking("A", [status(409)], async () => {
      await A.page.fill('[data-testid="gh-token"]', TOKEN.alexHousehold);
      await A.page.click('[data-testid="gh-check-again"]');
      await waitHeading(A.page, "Create your ledger");
    });
    check(
      "4. Household: a valid org-owned token connects to the private household-e2e/ledger-data, and nothing is written before the passphrase",
      (await A.page.getByText(HOUSEHOLD_REPO).count()) > 0 && putsOf("A").length === 0 && ledgerFiles(HOUSEHOLD_REPO).length === 0,
    );
    await createLedger(A.page, PASS.household, `${PASS.household}x`);
    await A.page.locator(".error", { hasText: "The two passphrases don't match." }).waitFor();
    check(
      "4. Household: a passphrase mismatch is blocked and sends nothing",
      (await heading(A.page, "Create your ledger").count()) === 1 && putsOf("A").length === 0,
    );
    const aCreateMark = adapter.log.length;
    await provoking("A", [status(404, 409)], async () => {
      await createLedger(A.page, PASS.household);
      await A.page.waitForSelector(".tabs", { timeout: 30_000 });
    });
    {
      const puts = putsOf("A", aCreateMark);
      const genesisPuts = puts.filter((p) => p.put && /\.genesis\.enc$/.test(p.put.path));
      check(
        "4. Household: after the passphrase the app opens on Dashboard, and the repo holds the genesis written by one PUT without sha",
        (await A.page.locator(".tabs button.selected").innerText()).includes("Dashboard") &&
          genesisPuts.length === 1 &&
          puts[0] === genesisPuts[0] &&
          genesisPuts[0].put!.hadSha === false &&
          ledgerFiles(HOUSEHOLD_REPO).some((f) => f.file.kind === "genesis"),
        puts,
      );
    }
    // The engine writes its first log only with a change; one makes sure
    // every kind of file the epoch will hold is checked.
    await addExpense(A.page, "120", "E2E Groceries");
    await waitUntil(() => ledgerFiles(HOUSEHOLD_REPO).some((f) => f.file.kind === "log"), 45_000);
    {
      const files = ledgerFiles(HOUSEHOLD_REPO);
      const genesis = files.find((f) => f.file.kind === "genesis")!;
      const salt = (JSON.parse(genesis.text.slice(0, genesis.text.indexOf("\n"))) as { salt: string }).salt;
      const problems = files.map((f) => [f.name, headerProblem(f.text, salt)]).filter(([, p]) => p !== null);
      check(
        "4. Every stored file fails JSON.parse, its header reads AES-GCM-256, PBKDF2-SHA256, 600000 and a 16-byte salt, and every file carries the genesis's salt (AC5)",
        files.length >= 2 && problems.length === 0,
        { files: files.map((f) => f.name), problems },
      );
    }
    {
      const { doc } = await fold(HOUSEHOLD_REPO, PASS.household);
      check(
        "4. Folded in Node: version 1, the 4 default categories, and the browser's time zone America/New_York",
        doc.version === 1 &&
          doc.categories.map((c) => c.id).join(",") === "food,transportation,rent,other" &&
          doc.settings.timeZone === TIME_ZONE,
        { version: doc.version, categories: doc.categories.map((c) => c.id), timeZone: doc.settings.timeZone },
      );
    }

    // ================= 5. Expenses =================
    // The first expense went in above, to have a log to check; the empty
    // month is checked on a month nobody has written to.
    {
      await openExpenses(A.page);
      const picker = A.page.locator(".month-picker select").first();
      const shown = await picker.inputValue();
      const other = shown === "1" ? "2" : "1";
      await picker.selectOption(other);
      await A.page.waitForSelector(".loading-overlay", { state: "detached" });
      const empty = (await A.page.locator(".entry-row").count()) === 0 && (await A.page.locator(".error").count()) === 0;
      await picker.selectOption(shown);
      await A.page.waitForSelector(".loading-overlay", { state: "detached" });
      check("5. Expenses: a month with no expenses shows an empty list and no error", empty);
    }
    check(
      "5. Expenses: adding lists the expense, and the remote document holds it after sync",
      (await listed(A.page)).includes("E2E Groceries") && (await waitUntil(() => remoteHas(HOUSEHOLD_REPO, PASS.household, "E2E Groceries"), 45_000, 1000)),
    );
    await editExpense(A.page, "E2E Groceries", "135", "E2E Groceries Edited");
    check("5. Expenses: editing updates the row", (await amountOf(A.page, "E2E Groceries Edited")) === "₹135.00", await amountOf(A.page, "E2E Groceries Edited"));

    await addExpense(A.page, "900", "E2E Rent", "Rent");
    const beforeMove = await listed(A.page);
    await menu(A.page, beforeMove[0], "Move down");
    await waitUntil(async () => (await listed(A.page)).join() !== beforeMove.join(), 10_000);
    const afterMove = await listed(A.page);
    await waitSaved(A.page);
    await A.page.reload();
    await A.page.waitForSelector(".tabs", { timeout: 30_000 });
    const afterReload = await listed(A.page);
    check(
      "5. Expenses: reordering moves the row, and the order is kept after a reload",
      afterMove.join() !== beforeMove.join() && afterReload.join() === afterMove.join(),
      { beforeMove, afterMove, afterReload },
    );

    const rentId = await (async () => {
      await waitUntil(() => remoteHas(HOUSEHOLD_REPO, PASS.household, "E2E Rent"), 45_000, 1000);
      return expenseNamed((await fold(HOUSEHOLD_REPO, PASS.household)).doc, "E2E Rent")?.id;
    })();
    await deleteExpense(A.page, "E2E Rent");
    const tombstoned = await waitUntil(
      async () => {
        const { logs } = await fold(HOUSEHOLD_REPO, PASS.household);
        return [...logs.values()].some((ops) => ops.some((op) => op.del.includes(`e/${rentId}`)));
      },
      45_000,
      1000,
    );
    check(
      "5. Expenses: deleting removes the row and leaves a del in the device's op log",
      rentId !== undefined && !(await listed(A.page)).includes("E2E Rent") && tombstoned && !(await remoteHas(HOUSEHOLD_REPO, PASS.household, "E2E Rent")),
    );

    // The add form's amount field steps by 0.01, as on the Supabase build,
    // so 1.005 is typed where nothing blocks it: the edit row.
    await addExpense(A.page, "2", "E2E Rounding");
    await editExpense(A.page, "E2E Rounding", "1.005");
    const roundedShown = await amountOf(A.page, "E2E Rounding");
    const roundedStored = await waitUntil(async () => expenseNamed((await fold(HOUSEHOLD_REPO, PASS.household)).doc, "E2E Rounding")?.amount === "1.01", 45_000, 1000);
    check("5. Expenses: 1.005 shows as 1.01 and is stored as \"1.01\"", roundedShown === "₹1.01" && roundedStored, roundedShown);

    {
      const nowParts = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, year: "numeric", month: "long" }).formatToParts(new Date());
      const monthName = nowParts.find((p) => p.type === "month")!.value;
      const year = nowParts.find((p) => p.type === "year")!.value;
      const lockedMessage = `${monthName} ${year} ${LOCKED_TAIL}`;
      const serverSaysTheSame = fs.readFileSync(path.join(ROOT, "server", "src", "store", "ledger.ts"), "utf8").includes(LOCKED_TAIL);
      // An edit already open when the month is locked, as a second person
      // might have one open: its save must be refused by the store itself.
      await openExpenses(A.page);
      await menu(A.page, "E2E Groceries Edited", "Edit");
      await A.page.waitForSelector(".row-editing");
      await A.page.click(".month-lock-toggle");
      await A.page.locator(".month-lock-toggle", { hasText: "Unlock" }).waitFor();
      const addDisabled = await A.page.locator('.add-expense-form input[type="number"]').isDisabled();
      await A.page.locator(".row-editing .edit-fields input").nth(0).fill("140");
      await A.page.click('.row-editing button:has-text("Save")');
      await A.page.locator(".row-editing .error").waitFor();
      const refusal = (await A.page.locator(".row-editing .error").innerText()).trim();
      check(
        "5. Expenses: a locked month refuses add (the form is disabled) and edit, with the Supabase build's 403 message",
        addDisabled && refusal === lockedMessage && serverSaysTheSame && (await A.page.locator(".row-editing").count()) === 1,
        { addDisabled, refusal, lockedMessage, serverSaysTheSame },
      );
      await A.page.click(".month-lock-toggle");
      await A.page.locator(".month-lock-toggle", { hasText: "Lock this month" }).waitFor();
      const addEnabled = await A.page.locator('.add-expense-form input[type="number"]').isEnabled();
      await A.page.click('.row-editing button:has-text("Save")');
      await A.page.waitForSelector(".row-editing", { state: "detached" });
      check(
        "5. Expenses: unlocking enables the form again, and the same edit now saves",
        addEnabled && (await amountOf(A.page, "E2E Groceries Edited")) === "₹140.00",
      );
    }

    // ================= 6. Key on this device =================
    await waitSaved(A.page);
    await A.page.reload();
    const reopened = await waitUntil(async () => (await A.page.locator(".tabs").count()) === 1, 30_000);
    check(
      "6. A reload opens the ledger without asking for the passphrase",
      reopened && (await heading(A.page, "Enter your passphrase").count()) === 0,
    );
    const stored = await A.page.evaluate(
      () =>
        new Promise<{ isKey: boolean; extractable: boolean | null; usages: string[] }>((resolve, reject) => {
          const open = indexedDB.open("ledger:github");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const get = open.result.transaction("device").objectStore("device").get("ledger:key");
            get.onerror = () => reject(get.error);
            get.onsuccess = () => {
              const key = (get.result as { key?: CryptoKey } | undefined)?.key;
              open.result.close();
              resolve({ isKey: key instanceof CryptoKey, extractable: key?.extractable ?? null, usages: key ? [...key.usages] : [] });
            };
          };
        }),
    );
    check("6. The stored CryptoKey is non-extractable", stored.isKey && stored.extractable === false, stored);
    const names = await A.page.evaluate(async () => ({
      databases: (await indexedDB.databases()).map((d) => d.name ?? ""),
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    }));
    const badNames = [...names.databases, ...names.local, ...names.session].filter((n) => !n.startsWith("ledger:") && !ALLOWED_KEYS.has(n));
    check(
      "6. Every IndexedDB and Web Storage name this build adds starts with ledger: (the three ledger-* keys allowed)",
      badNames.length === 0 && names.databases.includes("ledger:github"),
      names,
    );

    await waitSaved(A.page);
    await openSettings(A.page);
    await A.page.click('[data-testid="gh-forget"]');
    await A.page.waitForSelector(".dialog-card");
    const forgetQuestion = await A.page.locator(".dialog-card").innerText();
    await A.page.click(".dialog-confirm");
    await waitHeading(A.page, "Set up Ledger");
    // Read without opening the database, which would create it again.
    const keyAfterForget = await A.page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === "ledger:github"));
    adapter.newDevice("A");
    await walkToConnect(A.page, "household");
    await connectWith(A.page, TOKEN.alexHousehold);
    await waitHeading(A.page, "Enter your passphrase");
    check(
      "6. Forget this device (nothing unsynced) removes the stored key and returns to Welcome, and reconnecting with the token asks for the passphrase",
      forgetQuestion.includes("Forget this device?") && !keyAfterForget && (await A.page.locator('[data-testid="gh-unlock-passphrase"]').count()) === 1,
      { forgetQuestion, keyAfterForget },
    );
    const wrongMark = adapter.log.length;
    await unlockWith(A.page, PASS.other);
    await A.page.locator(".error", { hasText: "Wrong passphrase" }).waitFor({ timeout: 30_000 });
    const wrongPuts = putsOf("A", wrongMark).length;
    await unlockWith(A.page, PASS.household);
    await A.page.waitForSelector(".tabs", { timeout: 30_000 });
    const afterUnlock = await listed(A.page);
    check(
      "6. A wrong passphrase shows Wrong passphrase and sends no PUT; the right one reopens the same data",
      wrongPuts === 0 && afterUnlock.includes("E2E Groceries Edited") && afterUnlock.includes("E2E Rounding"),
      { wrongPuts, afterUnlock },
    );

    // ================= 7. Sections =================
    // The checks below start from every section on (createLedger ticks all
    // six, whatever this build's VITE_DEFAULT_MODULES ticks).
    const allOn = (await fold(HOUSEHOLD_REPO, PASS.household)).doc.settings.modules;
    if (SECTION_IDS.some((section) => !(allOn as readonly string[]).includes(section))) throw new Error(`section checks need every section on; the ledger has ${allOn.join(",")}`);
    await openSettings(A.page);
    await A.page.uncheck('[data-testid="gh-settings-section-debts"]');
    await A.page.click('[data-testid="gh-settings-save"]');
    await A.page.getByText("Saved.", { exact: true }).waitFor();
    await closeSettings(A.page);
    check("7. Turning a section off hides its tab without a reload", !(await tabNames(A.page)).includes("Debts") && (await tabNames(A.page)).includes("Expenses"), await tabNames(A.page));
    await waitUntil(async () => !(await fold(HOUSEHOLD_REPO, PASS.household)).doc.settings.modules.includes("debts"), 45_000, 1000);
    await A.page.reload();
    await A.page.waitForSelector(".tabs", { timeout: 30_000 });
    const remoteModules = (await fold(HOUSEHOLD_REPO, PASS.household)).doc.settings.modules;
    check(
      "7. The tab stays hidden after a reload, and the setting is stored in the document",
      !(await tabNames(A.page)).includes("Debts") && !remoteModules.includes("debts") && remoteModules.includes("expenses"),
      { tabs: await tabNames(A.page), remoteModules },
    );
    await openSettings(A.page);
    for (const section of ["finances", "emi", "credit-cards", "subscriptions"]) await A.page.uncheck(`[data-testid="gh-settings-section-${section}"]`);
    await A.page.click('[data-testid="gh-settings-save"]');
    await A.page.getByText("Saved.", { exact: true }).waitFor();
    await closeSettings(A.page);
    check(
      "7. An expenses-only setting shows exactly Dashboard,Expenses (as e2e/expensesOnly.ts checks the Supabase build)",
      (await A.page.locator(".tabs button").allInnerTexts()).join(",") === "Dashboard,Expenses",
      await A.page.locator(".tabs button").allInnerTexts(),
    );

    // ================= 8. Two devices =================
    await waitSaved(A.page);
    const B = await device("B");
    await B.page.goto(base);
    await walkToConnect(B.page, "member");
    await connectWith(B.page, TOKEN.sam);
    await waitHeading(B.page, "Enter your passphrase");
    await unlockWith(B.page, PASS.household);
    await B.page.waitForSelector(".tabs", { timeout: 30_000 });
    const bSees = await listed(B.page);
    await addExpense(B.page, "10", "E2E From Sam");
    await waitUntil(() => remoteHas(HOUSEHOLD_REPO, PASS.household, "E2E From Sam"), 45_000, 1000);
    {
      const genesisPaths = new Set(ledgerFiles(HOUSEHOLD_REPO).filter((f) => f.file.kind === "genesis").map((f) => `${LEDGER_DIR}/${f.name}`));
      const bPuts = putsOf("B");
      check(
        "8. Device B (sam-e2e) joins: reads the genesis and A's files, writes no genesis and no PUT without sha to an existing path, and sees A's expenses",
        bSees.includes("E2E Groceries Edited") &&
          bSees.includes("E2E Rounding") &&
          bPuts.length > 0 &&
          bPuts.every((p) => p.put && !genesisPaths.has(p.put.path) && (p.put.hadSha || p.status === 201)),
        { bSees, bPuts },
      );
    }
    await Promise.all([waitSaved(A.page), waitSaved(B.page)]);
    // Each person is on Expenses when the connection drops: the Pages build
    // has no service worker, so a section's code not loaded yet can't load
    // offline (and Playwright's routing turns the HTTP cache off).
    await Promise.all([listed(A.page), listed(B.page)]);
    // The browser logs each request refused while offline: provoked here.
    await provoking(["A", "B"], [OFFLINE_ERRORS], async () => {
      await adapter.setOffline(A.context, "A", true);
      await adapter.setOffline(B.context, "B", true);
      const offlineMark = adapter.log.length;
      await addExpense(A.page, "50", "E2E Offline A");
      await addExpense(B.page, "60", "E2E Offline B");
      // Each tried to send its change and found itself offline.
      await waitUntil(async () => (await statusText(A.page)).startsWith("Offline") && (await statusText(B.page)).startsWith("Offline"), 30_000);
      const whileOffline = adapter.log.slice(offlineMark).filter((r) => r.context === "A" || r.context === "B");
      check(
        "8. Offline, each device adds an expense, lists it, and nothing reaches GitHub",
        (await listed(A.page)).includes("E2E Offline A") && (await listed(B.page)).includes("E2E Offline B") && whileOffline.every((r) => r.status === "offline"),
        whileOffline,
      );
      await adapter.setOffline(A.context, "A", false);
      await adapter.setOffline(B.context, "B", false);
    });
    const bothSeeBoth = await waitUntil(
      async () => {
        await nudge(A.page);
        await nudge(B.page);
        const [a, b] = [await listed(A.page), await listed(B.page)];
        return ["E2E Offline A", "E2E Offline B"].every((n) => a.includes(n) && b.includes(n));
      },
      90_000,
      3000,
    );
    check(
      "8. Back online, both sync with no conflict prompt and both list both expenses (AC6)",
      bothSeeBoth && (await A.page.locator(".dialog-card, .sync-status-review").count()) === 0 && (await B.page.locator(".dialog-card, .sync-status-review").count()) === 0,
    );
    {
      await waitUntil(async () => {
        const { doc } = await fold(HOUSEHOLD_REPO, PASS.household);
        return expenseNamed(doc, "E2E Offline A") !== undefined && expenseNamed(doc, "E2E Offline B") !== undefined;
      }, 45_000, 1000);
      const { doc } = await fold(HOUSEHOLD_REPO, PASS.household);
      check(
        "8. updatedBy in the remote document names each device's login",
        expenseNamed(doc, "E2E Offline A")?.updatedBy === ALEX && expenseNamed(doc, "E2E Offline B")?.updatedBy === SAM,
        { a: expenseNamed(doc, "E2E Offline A")?.updatedBy, b: expenseNamed(doc, "E2E Offline B")?.updatedBy },
      );
    }

    /** B's PUTs of its own files from `mark` until the first that landed. */
    const attemptsUntilLanded = (mark: number): RoutedRequest[] => {
      const own = putsOf("B", mark).filter((p) => p.put && !/\.genesis\.enc$/.test(p.put.path));
      const landed = own.findIndex((p) => p.status === 200 || p.status === 201);
      return landed < 0 ? own : own.slice(0, landed + 1);
    };
    for (const code of [409, 422] as const) {
      await waitSaved(B.page);
      const mark = adapter.log.length;
      fake.failNext({ method: "PUT", path: `.${adapter.deviceOf("B")}.`, status: code });
      await provoking("B", [status(code)], async () => {
        await addExpense(B.page, "7", `E2E Retry ${code}`);
        await waitUntil(() => remoteHas(HOUSEHOLD_REPO, PASS.household, `E2E Retry ${code}`), 60_000, 1000);
      });
      const attempts = attemptsUntilLanded(mark);
      check(
        `8. A forced ${code} on B's PUT is retried and succeeds within 3 PUT attempts`,
        attempts.length >= 2 && attempts.length <= 3 && attempts[0].status === code && (await remoteHas(HOUSEHOLD_REPO, PASS.household, `E2E Retry ${code}`)),
        attempts.map((a) => a.status),
      );
    }

    await Promise.all([waitSaved(A.page), waitSaved(B.page)]);
    // B must hold A's latest too before both edit offline.
    await waitUntil(async () => {
      await nudge(A.page);
      await nudge(B.page);
      return (await listed(A.page)).includes("E2E Retry 422") && (await listed(B.page)).includes("E2E Retry 422");
    }, 60_000, 2000);
    await Promise.all([listed(A.page), listed(B.page)]);
    await provoking(["A", "B"], [OFFLINE_ERRORS], async () => {
      await adapter.setOffline(A.context, "A", true);
      await adapter.setOffline(B.context, "B", true);
      await editExpense(A.page, "E2E Groceries Edited", "150");
      await editExpense(B.page, "E2E Groceries Edited", "160");
      await waitUntil(async () => (await statusText(A.page)).startsWith("Offline") && (await statusText(B.page)).startsWith("Offline"), 30_000);
      await adapter.setOffline(A.context, "A", false);
      await adapter.setOffline(B.context, "B", false);
    });
    const converged = await waitUntil(
      async () => {
        await nudge(A.page);
        await nudge(B.page);
        const a = await shownAmount(A.page, "E2E Groceries Edited").catch(() => "?a");
        const b = await shownAmount(B.page, "E2E Groceries Edited").catch(() => "?b");
        const notices = (await A.page.locator(".sync-status-review").count()) + (await B.page.locator(".sync-status-review").count());
        return a === b && notices === 1;
      },
      90_000,
      3000,
    );
    // Settled: one more sync cycle on each side, then both saved.
    {
      const mark = adapter.log.length;
      await nudge(A.page);
      await nudge(B.page);
      await waitUntil(
        async () =>
          ["A", "B"].every((name) => adapter.log.slice(mark).some((r) => r.context === name && r.method === "GET")) &&
          (await statusText(A.page)) === "Saved" &&
          (await statusText(B.page)) === "Saved",
        45_000,
      );
    }
    {
      const a = await shownAmount(A.page, "E2E Groceries Edited");
      const b = await shownAmount(B.page, "E2E Groceries Edited");
      const aNotice = await A.page.locator(".sync-status-review").count();
      const bNotice = await B.page.locator(".sync-status-review").count();
      // The device whose value lost holds the notice, naming its value.
      const [loser, lost] = a === "₹150.00" ? [B.page, "160.00"] : [A.page, "150.00"];
      let noticeText = "";
      if ((await loser.locator(".sync-status-review").count()) === 1) {
        await loser.locator(".sync-status-review").click();
        noticeText = (await loser.locator(".sync-review-text").first().innerText()).trim();
      }
      check(
        "8. Both edit one expense's amount offline: afterwards both show the same amount, only the device whose value lost shows an overwrite notice naming its value, the winner none",
        converged && a === b && ["₹150.00", "₹160.00"].includes(a) && aNotice + bNotice === 1 && noticeText.endsWith(`your ${lost} was replaced.`),
        { a, b, aNotice, bNotice, noticeText },
      );
    }

    // ================= 9. Backup =================
    await Promise.all([waitSaved(A.page), waitSaved(B.page)]);
    const exportedList = await listed(A.page);
    await openSettings(A.page);
    const [download] = await Promise.all([A.page.waitForEvent("download"), A.page.click('[data-testid="gh-export"]')]);
    const backupPath = path.join(scratch, download.suggestedFilename());
    await download.saveAs(backupPath);
    const backupText = fs.readFileSync(backupPath, "utf8");
    check(
      "9. Export on A downloads ledger-backup-YYYY-MM-DD.enc, which fails JSON.parse and has the same header shape",
      /^ledger-backup-\d{4}-\d{2}-\d{2}\.enc$/.test(download.suggestedFilename()) && headerProblem(backupText) === null,
      { name: download.suggestedFilename(), problem: headerProblem(backupText) },
    );
    await closeSettings(A.page);

    await deleteExpense(A.page, "E2E Offline B");
    await waitUntil(async () => !(await remoteHas(HOUSEHOLD_REPO, PASS.household, "E2E Offline B")), 45_000, 1000);
    await waitSaved(A.page);
    // B has the delete too, so seeing the expense again on B can only come
    // from the restore.
    const bHadDelete = await waitUntil(
      async () => {
        await nudge(B.page);
        return !(await listed(B.page)).includes("E2E Offline B");
      },
      90_000,
      3000,
    );
    const epochBefore = winningEpoch(ledgerFiles(HOUSEHOLD_REPO).map((f) => f.name));
    await openSettings(A.page);
    await A.page.setInputFiles('[data-testid="gh-restore-file"]', backupPath);
    await A.page.locator('[data-testid="gh-restore-summary"]').waitFor();
    await A.page.click('[data-testid="gh-restore"]');
    await A.page.waitForSelector(".dialog-card");
    await A.page.click(".dialog-confirm");
    await A.page.locator('[data-testid="gh-restore-note"]').waitFor({ timeout: 60_000 });
    const restoreNote = (await A.page.locator('[data-testid="gh-restore-note"]').innerText()).trim();
    const restoredOnA = await listed(A.page);
    const epochAfter = winningEpoch(ledgerFiles(HOUSEHOLD_REPO).map((f) => f.name));
    const bSwitched = await waitUntil(
      async () => {
        await nudge(B.page);
        return (await listed(B.page)).includes("E2E Offline B");
      },
      90_000,
      3000,
    );
    // B moved epochs: its next own file is written in the restored one.
    const bMark = adapter.log.length;
    await addExpense(B.page, "5", "E2E After Restore B");
    const bWroteInNewEpoch = await waitUntil(
      () => putsOf("B", bMark).some((r) => r.put?.path.startsWith(`${LEDGER_DIR}/${epochAfter}.`) && (r.status === 200 || r.status === 201)),
      45_000,
    );
    check(
      "9. Restore on A after a delete: the expense is back, the commit says \"Restore from backup\", and B, which had the delete, switches to the restored ledger (new epoch) on its next sync",
      restoreNote.startsWith("Restored from the backup.") &&
        restoredOnA.includes("E2E Offline B") &&
        fake.commits.some((c) => c.repo === HOUSEHOLD_REPO && c.message === "Restore from backup") &&
        bHadDelete &&
        epochAfter !== epochBefore &&
        bSwitched &&
        bWroteInNewEpoch &&
        putsOf("B", bMark).every((r) => !r.put || r.put.path.startsWith(`${LEDGER_DIR}/${epochAfter}.`)),
      { restoreNote, restoredOnA, bHadDelete, epochBefore, epochAfter, bSwitched, bWroteInNewEpoch, bPuts: putsOf("B", bMark).map((r) => r.put?.path) },
    );

    const C = await device("C");
    await C.page.goto(base);
    await walkToConnect(C.page, "household");
    await provoking("C", [status(409, 404)], async () => {
      await connectWith(C.page, TOKEN.alexHousehold, "ledger-restore");
      await waitHeading(C.page, "Create your ledger");
      await C.page.locator("summary", { hasText: "Have a backup file? Start from it instead" }).click();
      await C.page.setInputFiles('[data-testid="gh-create-backup-file"]', backupPath);
      await C.page.fill('[data-testid="gh-create-backup-passphrase"]', PASS.household);
      await C.page.click('[data-testid="gh-create-from-backup"]');
      await C.page.waitForSelector(".tabs", { timeout: 60_000 });
    });
    const fromBackup = await listed(C.page);
    check(
      "9. Start from a backup: a fresh context, on a second empty repo, uses Create's \"Have a backup file?\" and lists the same expenses",
      [...fromBackup].sort().join() === [...exportedList].sort().join() && ledgerFiles(RESTORE_REPO).some((f) => f.file.kind === "genesis"),
      { fromBackup, exportedList },
    );
    await C.context.close();

    {
      // A backup made under another passphrase (another household's).
      const salt = newSalt();
      const otherKey = await deriveKey(PASS.other, salt, DEFAULT_ITERATIONS);
      const otherDoc = createEmptyDocument({ modules: ["expenses"], timeZone: TIME_ZONE });
      const otherPath = path.join(scratch, "ledger-backup-other.enc");
      fs.writeFileSync(otherPath, await encryptDocument(otherDoc, otherKey, { salt: bytesToBase64(salt), iter: DEFAULT_ITERATIONS }));
      const mark = adapter.log.length;
      await A.page.waitForSelector(".tabs");
      await openSettings(A.page);
      await A.page.setInputFiles('[data-testid="gh-restore-file"]', otherPath);
      await A.page.fill('[data-testid="gh-restore-passphrase"]', PASS.household);
      await A.page.click('[data-testid="gh-restore-open"]');
      await A.page.locator(".error", { hasText: "Wrong passphrase" }).waitFor({ timeout: 30_000 });
      // A restore writes a genesis; A's own sync may write its log meanwhile.
      const restorePuts = putsOf("A", mark).filter((r) => r.put && /.genesis.enc$/.test(r.put.path));
      check(
        "9. A wrong passphrase for a backup made under another passphrase shows Wrong passphrase and writes no genesis (nothing restored)",
        restorePuts.length === 0 && (await A.page.locator('[data-testid="gh-restore"]').count()) === 0,
      );
      await closeSettings(A.page);
    }

    // ================= 10. Lost access =================
    await waitSaved(A.page);
    fake.revokeToken(TOKEN.alexHousehold);
    await provoking("A", [status(401)], async () => {
      await addExpense(A.page, "33", "E2E After Revoke");
      await waitHeading(A.page, "Replace your token", 45_000);
    });
    const replaceShown = (await A.page.getByText("GitHub no longer accepts this token").count()) === 1;
    await provoking("A", [status(401)], async () => {
      await A.page.fill('[data-testid="gh-replace-token"]', TOKEN.alexHousehold);
      await A.page.click('[data-testid="gh-replace"]');
      await A.page.locator(".error", { hasText: "GitHub didn't accept this token." }).waitFor();
    });
    const refusedWords = (await errorText(A.page)).includes("GitHub didn't accept this token. Check you copied all of it.");
    adapter.addToken(TOKEN.alexRenewed, { login: ALEX, repos: [HOUSEHOLD_REPO], permission: "write" });
    await A.page.fill('[data-testid="gh-replace-token"]', TOKEN.alexRenewed);
    await A.page.click('[data-testid="gh-replace"]');
    await A.page.waitForSelector(".tabs", { timeout: 30_000 });
    const keptLocally = (await listed(A.page)).includes("E2E After Revoke");
    const reachedGitHub = await waitUntil(() => remoteHas(HOUSEHOLD_REPO, PASS.household, "E2E After Revoke"), 60_000, 1000);
    check(
      "10. After the token is revoked, the next sync shows Replace token (not a blank screen), the revoked token gets TOKEN_REFUSED's words, and with a new token the expense entered meanwhile is still listed and syncs",
      replaceShown && refusedWords && keptLocally && reachedGitHub,
      { replaceShown, refusedWords, keptLocally, reachedGitHub },
    );

    // ================= 11. Ten-year dataset (AC7) =================
    const { planLedger, runOnDocument } = await import("../client/src/backend/sync/tenYearPlan.js");
    const tenYears = runOnDocument(planLedger());
    const tenSalt = newSalt();
    const tenKey = await deriveKey(PASS.tenYear, tenSalt, DEFAULT_ITERATIONS);
    const tenEpoch = nextEpochKey(null);
    const tenText = await encryptDocument(
      { fv: FORMAT_VERSION, kind: "genesis", epoch: tenEpoch, reason: "create", by: ALEX, at: Date.now(), basedOn: null, doc: tenYears },
      tenKey,
      { salt: bytesToBase64(tenSalt), iter: DEFAULT_ITERATIONS },
    );
    await fake.seedFile(TEN_YEAR_REPO, `${LEDGER_DIR}/${tenEpoch}.genesis.enc`, tenText);
    const tenExpenses = allExpenses(tenYears).length;
    const T = await device("T");
    await T.page.goto(base);
    await walkToConnect(T.page, "personal");
    await connectWith(T.page, TOKEN.alexPersonal, "ledger-ten");
    await waitHeading(T.page, "Enter your passphrase");
    const loadStart = Date.now();
    await unlockWith(T.page, PASS.tenYear);
    await T.page.waitForSelector(".dashboard-total strong", { timeout: 120_000 });
    await T.page.waitForSelector(".loading-overlay", { state: "detached", timeout: 120_000 });
    const loadMs = Date.now() - loadStart;
    check(`11. A ${tenExpenses}-expense, 10-year ledger seeded into the fake opens in a fresh context`, (await T.page.locator(".tabs").count()) === 1);
    {
      const year = 2020;
      await T.page.locator(".dashboard-header select").selectOption(String(year));
      await T.page.locator(".dashboard-total span", { hasText: `Total for ${year}` }).waitFor();
      await T.page.waitForSelector(".loading-overlay", { state: "detached" });
      const cents = Object.entries(tenYears.expenses)
        .filter(([month]) => month.startsWith(`${year}-`))
        .flatMap(([, list]) => list)
        .reduce((sum, e) => sum + Math.round(Number(e.amount) * 100), 0);
      const expected = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(cents / 100);
      const shown = (await T.page.locator(".dashboard-total strong").innerText()).trim();
      check(`11. The Dashboard total for ${year} matches the seeded sum`, shown === expected, { shown, expected });
    }
    {
      const reads = logOf("T");
      const viaTrees = reads.some((r) => r.method === "GET" && r.path.includes("/git/trees/"));
      const viaBlobs = reads.some((r) => r.method === "GET" && r.path.includes("/git/blobs/") && r.status === 200);
      console.log(`      ten-year genesis: ${tenText.length} bytes encrypted (${tenExpenses} expenses, ${Object.keys(tenYears.expenses).length} months); load time ${loadMs} ms`);
      check("11. The ten-year genesis is read through git/trees and git/blobs, and its size and load time are printed (AC7)", viaTrees && viaBlobs && tenText.length > 0 && loadMs > 0);
    }

    for (const context of [personal.context, A.context, B.context, T.context]) await context.close();
  } catch (err) {
    // A step that couldn't go on: what was checked so far still prints.
    console.error(err);
    check("The run went through every step", false, err instanceof Error ? err.message : String(err));
    // CI sets E2E_ARTIFACT_DIR and uploads it: what each device showed.
    const artifacts = process.env.E2E_ARTIFACT_DIR;
    if (artifacts) {
      fs.mkdirSync(artifacts, { recursive: true });
      for (const [name, page] of pages) {
        if (!page.isClosed()) await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true }).catch(() => {});
      }
    }
  } finally {
    await browser?.close();
    preview.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  // ================= 1. Build and isolation (whole run) =================
  const badAssets = previewResponses.filter((r) => !new URL(r.url).pathname.startsWith(PAGES_BASE) || r.status >= 400);
  check(
    "1. Every asset loads under /ledger/ with no 4xx",
    previewResponses.length > 0 && badAssets.length === 0,
    badAssets,
  );
  const backendRequests = allRequestUrls.filter((u) => /\.supabase\.co\b/.test(new URL(u).hostname) || new URL(u).pathname.includes("/api/"));
  check("1. No request to *.supabase.co or to any /api/ path", backendRequests.length === 0, backendRequests);
  check(
    "1. No request to a host outside the preview origin, api.github.com (the fake) and Google Fonts, and the fake's unhandled-endpoint list is empty (no repo-create call)",
    adapter.problems().length === 0,
    adapter.problems(),
  );
  check("1. navigator.serviceWorker.getRegistrations() is empty", serviceWorkers === 0, serviceWorkers);

  // ================= 12. Console =================
  check(
    "12. No console errors or page errors in any context (CSP violations included), except those a check provokes on purpose",
    consoleErrors.filter((e) => e.level === "error").length === 0,
    consoleErrors.filter((e) => e.level === "error"),
  );
  check(
    "12. No console warnings in any context (the sync engine's included), except those a check provokes on purpose",
    consoleErrors.filter((e) => e.level === "warning").length === 0,
    consoleErrors.filter((e) => e.level === "warning"),
  );

  const failed = results.filter((r) => !r.ok);
  const section = (label: string) => Number(label.split(".")[0]) || 99;
  const sorted = [...results].sort((a, b) => section(a.label) - section(b.label));
  console.log("\n=== e2e GitHub storage summary ===");
  for (const r of sorted) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.label}`);
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  console.log("Console errors provoked on purpose and dropped:", provoked.size ? Object.fromEntries(provoked) : "none");
  if (failed.length) {
    console.error("\ne2e GitHub storage FAILED");
    process.exit(1);
  }
  console.log("\ne2e GitHub storage PASSED");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
