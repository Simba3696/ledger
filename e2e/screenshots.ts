/**
 * Regenerates docs/screenshots/dashboard.png and dashboard-dark.png against
 * a fixed, fictional demo dataset (Alex/Sam, Visa Rewards/Amex Gold, Car
 * Loan/Home Loan, Netflix/Spotify/Amazon Prime, Emergency Fund/PPF/NPS/APY —
 * the same cast every other screenshot in docs/screenshots already uses).
 *
 * Isolation follows the exact same recipe as e2e/regression.ts, for the same
 * reason: `LEDGER_DB_DIR` is passed as an env var straight to the spawned
 * `npm run dev` process, and the dev server runs on this checkout's normal
 * ports — never a separate custom port. A previous attempt at this used a
 * separate git worktree with its own overridden PORT/VITE_DEV_PORT so it
 * could run *alongside* the real server, which seemed safer but was the
 * opposite: `client/vite.config.ts`'s dev proxy defaults to
 * `http://localhost:4000` unless `VITE_API_PROXY_TARGET` is also set, so the
 * client silently proxied straight through to the real production server —
 * every "demo" entry got written into real data instead. Reusing this
 * checkout's own ports means `predev`'s `kill-ports.js` frees them first
 * (stopping the real server, exactly like running `npm run test:e2e` does),
 * so there is only ever one server for the client to reach, and it's
 * guaranteed to be this scratch-backed one. Restart the real server
 * (`npm run build` + `Start-ScheduledTask "Ledger"`, per the README's
 * Deployment step) once this script exits.
 *
 * Before writing anything, every tab is asserted empty first — the second
 * incident, layered on top of the proxy bug above, was filling a form by
 * row position (`.nth(0)`, `.nth(1)`) assuming those positions were blank,
 * when real pre-existing rows were sitting there instead. Against a fresh
 * scratch dir this assertion always passes; if it ever doesn't, that's this
 * script telling you loudly to stop, not silently overwriting whatever it
 * finds.
 */
import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SCREENSHOTS_DIR = path.join(ROOT, "docs", "screenshots");

// Same minimal .env reader as e2e/regression.ts / scripts/kill-ports.js.
function readEnvFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return vars;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (match) vars[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return vars;
}
const serverEnv = readEnvFile(path.join(ROOT, "server", ".env"));
const clientEnv = readEnvFile(path.join(ROOT, "client", ".env"));
const SERVER_PORT = Number(serverEnv.PORT) || 4000;
const CLIENT_PORT = Number(clientEnv.VITE_DEV_PORT) || 5173;

// Every "Upcoming (next 2 weeks)" item needs to land inside that window
// relative to whenever this script actually runs, not a fixed calendar date
// — a hardcoded date silently drops out of "Upcoming" (and the screenshot
// quietly gets worse) the moment real time passes it, exactly as happened
// the first time this ran a week after being written. `toLocalDateStr`
// mirrors e2e/regression.ts's own helper: plain getFullYear/getMonth/getDate,
// never toISOString(), which is UTC and can land on the wrong calendar day
// near midnight IST.
function daysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet, keep polling
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Fails loudly instead of silently writing into whatever's already there. */
async function assertEmpty(page: import("playwright").Page, selector: string, label: string) {
  const count = await page.locator(selector).count();
  if (count !== 0) {
    throw new Error(
      `Refusing to seed ${label}: expected 0 existing rows but found ${count}. ` +
        `This should be impossible against a fresh scratch dir — stopping before writing anything.`,
    );
  }
}

async function main() {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-screenshots-"));
  console.log("Scratch data dir:", scratchDir);

  console.log("Starting dev server against scratch data...");
  const devProcess: ChildProcessWithoutNullStreams = spawn("npm", ["run", "dev"], {
    cwd: ROOT,
    env: { ...process.env, LEDGER_DB_DIR: scratchDir },
    shell: true,
  });
  devProcess.stdout.on("data", () => {});
  devProcess.stderr.on("data", () => {});

  try {
    await waitForServer(`http://localhost:${SERVER_PORT}/api/categories`, 30000);
    await waitForServer(`http://localhost:${CLIENT_PORT}`, 30000);

    // Belt-and-braces: the server log line itself names the directory it's
    // actually reading/writing, independent of anything this script assumes.
    const health = await fetch(`http://localhost:${SERVER_PORT}/api/debts`).then((r) => r.json());
    if (Array.isArray(health) && health.length !== 0) {
      throw new Error(`Refusing to seed: /api/debts already has ${health.length} row(s) on a supposedly fresh scratch server.`);
    }

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    await page.goto(`http://localhost:${CLIENT_PORT}`, { waitUntil: "networkidle" });

    // --- Debts ---
    await page.click('.tabs button:has-text("Debts")');
    await page.waitForSelector(".add-debt-form");
    await assertEmpty(page, ".debt-row", "Debts");
    await page.fill('.add-debt-form input[type="text"]', "Alex");
    await page.fill('.add-debt-form input[type="number"]', "5000");
    await page.click('.add-debt-form button:has-text("Add Debt")');
    await page.waitForSelector('.debt-row:has-text("Alex")');

    await page.fill('.add-debt-form input[type="text"]', "Sam");
    await page.click('.add-debt-form .signed-amount-sign button:has-text("Owed to you")');
    await page.fill('.add-debt-form input[type="number"]', "3000");
    await page.click('.add-debt-form button:has-text("Add Debt")');
    await page.waitForSelector('.debt-row:has-text("Sam")');

    // --- Credit Cards ---
    await page.click('.tabs button:has-text("Credit Cards")');
    await page.waitForSelector(".cards-add");
    await assertEmpty(page, ".card-row-fields", "Credit Cards");
    await page.click(".cards-add");
    await page.click(".cards-add");
    const cardRows = page.locator(".card-row-fields");
    await cardRows.nth(0).locator('input[type="text"]').fill("Visa Rewards");
    await cardRows.nth(0).locator('input[type="number"]').nth(0).fill("4500");
    await cardRows.nth(0).locator('input[type="number"]').nth(1).fill("4500");
    await cardRows.nth(0).locator('input[type="date"]').fill(daysFromNow(6));
    await cardRows.nth(0).locator('.cards-settled input[type="checkbox"]').check();

    await cardRows.nth(1).locator('input[type="text"]').fill("Amex Gold");
    await cardRows.nth(1).locator('input[type="number"]').nth(0).fill("8200");
    await cardRows.nth(1).locator('input[type="number"]').nth(1).fill("2000");
    await cardRows.nth(1).locator('input[type="date"]').fill(daysFromNow(6));

    await page.click('.cards-form button:has-text("Save")');
    await page.waitForTimeout(500);

    // --- EMI ---
    await page.click('.tabs button:has-text("EMI")');
    await page.waitForSelector(".add-emi-form");
    await assertEmpty(page, ".emi-row", "EMI");
    const addEmi = async (
      name: string,
      emiAmount: string,
      dueDay: string,
      totalAmount: string,
      currentBalance: string,
      interestRate: string,
      foreclosureCharge: string,
    ) => {
      await page.fill('.add-emi-form input[placeholder="Who\'s it with?"]', name);
      const nums = page.locator('.add-emi-form input[type="number"]');
      await nums.nth(0).fill(emiAmount);
      await nums.nth(1).fill(dueDay);
      await nums.nth(2).fill(totalAmount);
      await nums.nth(3).fill(currentBalance);
      await nums.nth(5).fill(interestRate);
      await nums.nth(6).fill(foreclosureCharge);
      await page.click('.add-emi-form button:has-text("Add EMI")');
      await page.waitForSelector(`.emi-row:has-text("${name}")`);
    };
    await addEmi("Car Loan", "8000", "15", "200000", "61000", "10", "0");
    await addEmi("Home Loan", "12000", "5", "500000", "382000", "8.5", "2");

    // --- Subscriptions ---
    await page.click('.tabs button:has-text("Subscriptions")');
    await page.waitForSelector(".add-subscription-form");
    await assertEmpty(page, ".subscription-row", "Subscriptions");
    const addSub = async (service: string, amount: string, duration: string, renewal: string, card?: string) => {
      await page.fill('.add-subscription-form input[placeholder="Netflix"]', service);
      await page.fill('.add-subscription-form input[type="number"]', amount);
      await page.selectOption(".add-subscription-form select", duration);
      await page.fill('.add-subscription-form input[type="date"]', renewal);
      if (card) await page.fill('.add-subscription-form input[placeholder="Or leave blank for N/A"]', card);
      await page.click('.add-subscription-form button:has-text("Add Subscription")');
      await page.waitForSelector(`.subscription-row:has-text("${service}")`);
    };
    // Spotify's anchor is deliberately stale (well in the past) — Monthly's
    // auto-advance-to-current-cycle logic (see Subscriptions.tsx) computes
    // its real next renewal from this regardless, same as it would from any
    // old real-world anchor. Netflix's is already in the future so it lands
    // in "Upcoming" untouched; Amazon Prime's is far enough out that it
    // reliably doesn't.
    await addSub("Spotify", "119", "Monthly", daysFromNow(-40), "Amex Gold");
    await addSub("Netflix", "649", "Monthly", daysFromNow(1), "Visa Rewards");
    await addSub("Amazon Prime", "1499", "Yearly", daysFromNow(90), "Visa Rewards");

    // --- Finances (income + savings) ---
    await page.click('.tabs button:has-text("Finances")');
    await page.waitForSelector(".savings-add");
    await assertEmpty(page, ".savings-row", "Finances savings");
    const topNums = page.locator('.income-form input[type="number"]');
    await topNums.nth(0).fill("65000");
    await topNums.nth(1).fill("5000");

    const addSaving = async (idx: number, name: string, amount: string) => {
      await page.click(".savings-add");
      const row = page.locator(".savings-row").nth(idx);
      await row.locator('input[type="text"]').fill(name);
      await row.locator('input[type="number"]').fill(amount);
    };
    await addSaving(0, "Emergency Fund", "7000");
    await addSaving(1, "PPF", "150000");
    await addSaving(2, "NPS", "80000");
    await addSaving(3, "APY", "25000");

    await page.click('.income-form button:has-text("Save")');
    await page.waitForTimeout(500);

    // --- Dashboard screenshots (light, then dark) ---
    await page.click('.tabs button:has-text("Dashboard")');
    await page.waitForSelector(".emi-projection-chart-wrap .recharts-rectangle");
    await page.waitForTimeout(500);

    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "dashboard.png") });

    await page.click(".theme-toggle");
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "dashboard-dark.png") });

    await browser.close();
    console.log(`\nWrote dashboard.png and dashboard-dark.png to ${SCREENSHOTS_DIR}`);
  } finally {
    console.log("Stopping dev server...");
    if (devProcess.pid) {
      try {
        execSync(`taskkill /PID ${devProcess.pid} /T /F`, { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
    try {
      execSync("node scripts/kill-ports.js", { cwd: ROOT, stdio: "ignore" });
    } catch {
      // best-effort cleanup
    }
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  console.log(
    "\nReal server is now stopped (kill-ports cleared its port same as it would for `npm run dev`) — " +
      'rebuild and restart it: `npm run build`, then `Start-ScheduledTask "Ledger"`.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
