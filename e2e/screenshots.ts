/**
 * Regenerates every image in docs/screenshots/ against a fixed, fictional
 * demo dataset (Alex/Sam, Visa Rewards/Amex Gold, Car Loan/Home Loan,
 * Netflix/Spotify/Amazon Prime, Emergency Fund/PPF/NPS/APY, a month of
 * everyday expenses):
 *
 * - dashboard.png / dashboard-dark.png at 1280x960;
 * - one full-page shot per tab at 720px wide, light and dark: add-expense
 *   (the form filled in), recent-entries (that entry saved), finances,
 *   debts, credit-cards, emi, subscriptions.
 *
 * Isolation follows the exact same recipe as e2e/regression.ts: the server
 * reads only server/.env's DATABASE_URL, which e2e/localDb.ts's
 * resetLocalDatabase empties first and refuses unless it points at a local
 * host (127.0.0.1/localhost); sign-in goes to the local Supabase stack only
 * (assertLocalAuth); and the dev server runs on this checkout's configured
 * ports, freed first by `predev`'s kill-ports.js, so there is only ever one
 * server for the client's dev proxy to reach. (On the Excel edition, an ad
 * hoc screenshot run in a worktree with overridden ports but no
 * `VITE_API_PROXY_TARGET` proxied straight through to the owner's real
 * server and wrote demo rows into real data. Never hand-roll a screenshot
 * script; extend this one.)
 *
 * Every tab is asserted empty before anything is written into it — the
 * second part of that incident was filling a form by row position
 * (`.nth(0)`, `.nth(1)`) assuming those positions were blank, when real
 * pre-existing rows were sitting there instead. The data seeded through the
 * API (this month's expenses, last month's salary) is checked before the
 * first write of any kind and written only after every tab has been checked
 * through its form. Against a freshly reset local database these assertions
 * always pass; if one ever doesn't, that's this script telling you loudly to
 * stop, not silently overwriting whatever it finds.
 */
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { ROOT, SERVER_PORT, serverEnv, startDevServer, stopDevServer } from "./devServer.js";
import { assertLocalAuth, ownerAccessToken, signInAsOwner } from "./auth.js";
import { resetLocalDatabase } from "./localDb.js";

const SCREENSHOTS_DIR = path.join(ROOT, "docs", "screenshots");

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

/** Fails loudly instead of silently writing into whatever's already there. */
async function assertEmpty(page: import("playwright").Page, selector: string, label: string) {
  const count = await page.locator(selector).count();
  if (count !== 0) {
    throw new Error(
      `Refusing to seed ${label}: expected 0 existing rows but found ${count}. ` +
        `This should be impossible against a freshly reset local database — stopping before writing anything.`,
    );
  }
}

type Page = import("playwright").Page;

/** Switches the app's theme with the header toggle, only if it isn't already
 * `theme` (the choice persists in localStorage across tabs). */
async function setTheme(page: Page, theme: "light" | "dark") {
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme) {
    await page.click(".theme-toggle");
    await page.waitForTimeout(300);
  }
}

/** Opens a nav tab and waits for its data to finish loading. */
async function openTab(page: Page, label: string, readySelector: string) {
  await page.click(`.tabs button:has-text("${label}")`);
  await page.waitForSelector(readySelector);
  await page.waitForSelector(".loading-overlay", { state: "detached" });
  await page.waitForTimeout(300);
}

// This month's demo expenses, added through the API (appendEntry only ever
// appends, so it can't overwrite anything) after the month is checked empty.
// Last month's income is seeded too: without it the Dashboard's Upcoming
// opens with an "Overdue · Not logged yet" salary reminder, and Finances'
// balance (last month's income minus this month's spending) goes negative.
const DEMO_LAST_MONTH_INCOME = { salary: 65000, otherIncome: 5000, savings: [] };
const DEMO_EXPENSES: { amount: number; remarks: string; category: string; isCard: boolean }[] = [
  { amount: 450, remarks: "Zomato lunch", category: "food", isCard: false },
  { amount: 680, remarks: "Swiggy dinner", category: "food", isCard: true },
  { amount: 220, remarks: "Uber to office", category: "transportation", isCard: false },
  { amount: 500, remarks: "Metro card recharge", category: "transportation", isCard: false },
  { amount: 18000, remarks: "Monthly Rent", category: "rent", isCard: true },
  { amount: 600, remarks: "Movie tickets", category: "other", isCard: false },
  { amount: 1200, remarks: "Birthday gift", category: "other", isCard: true },
];
// The entry the add-expense / recent-entries shots add through the form.
const NEW_EXPENSE = { amount: "250", remarks: "Coffee with a friend", category: "Food" };

async function main() {
  // Same check as e2e/regression.ts: sign-in goes to the LOCAL stack only,
  // as the seeded owner (LLD §6, §10).
  assertLocalAuth();

  // Every store module reads the LOCAL Supabase stack (server/.env's
  // DATABASE_URL) — empty it first. resetLocalDatabase refuses any non-local
  // host, which is what keeps this run away from real data.
  await resetLocalDatabase(ROOT, serverEnv.DATABASE_URL);

  console.log("Starting dev server against the local database...");
  let devProcess: ChildProcessWithoutNullStreams | undefined;

  try {
    // ENABLED_MODULES is pinned empty (every module), as in regression.ts:
    // this script seeds every tab, so a value in the calling shell must not
    // hide any of them.
    devProcess = await startDevServer({ ENABLED_MODULES: "" });

    // "Now" as the server sees it (APP_TIMEZONE, default Asia/Kolkata), as in
    // regression.ts, so the seeded month is the one the app treats as this
    // month even on a machine in another timezone near a month boundary.
    const { todayInAppZone } = await import("../server/src/domain/today.js");
    const appTimezone = serverEnv.APP_TIMEZONE || "Asia/Kolkata";
    const now = todayInAppZone(new Date(), appTimezone);
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;

    const token = await ownerAccessToken();
    const api = (method: string, apiPath: string, body?: unknown) =>
      fetch(`http://localhost:${SERVER_PORT}/api${apiPath}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    // Belt-and-braces: ask the running server itself, independent of
    // anything this script assumes about which database it's reading.
    const health = await api("GET", "/debts").then((r) => r.json());
    if (Array.isArray(health) && health.length !== 0) {
      throw new Error(`Refusing to seed: /api/debts already has ${health.length} row(s) on a supposedly freshly reset local database.`);
    }

    // --- API-seeded data: checked empty now, written after every tab's check ---
    // A year nobody has written to answers 404 ("No workbook found"), which
    // is the expected state here; any entries at all, or any other error,
    // mean stop.
    const monthRes = await api("GET", `/months/${year}/${month}`);
    if (!monthRes.ok && monthRes.status !== 404) {
      throw new Error(`Checking ${year}-${month}'s expenses failed with ${monthRes.status}: ${await monthRes.text()}`);
    }
    const existing = monthRes.ok ? ((await monthRes.json()) as unknown[]) : [];
    if (existing.length !== 0) {
      throw new Error(`Refusing to seed Expenses: ${year}-${month} already has ${existing.length} entr(ies).`);
    }
    const prevRes = await api("GET", `/finance/${prevYear}/${prevMonth}`);
    if (!prevRes.ok) throw new Error(`Checking ${prevYear}-${prevMonth}'s income failed with ${prevRes.status}: ${await prevRes.text()}`);
    const prevIncome = (await prevRes.json()) as { salary: number | null; otherIncome: number | null; savings: unknown[] };
    if (prevIncome.salary !== null || prevIncome.otherIncome !== null || prevIncome.savings.length !== 0) {
      throw new Error(`Refusing to seed Finances: ${prevYear}-${prevMonth} already has income or savings.`);
    }

    // The browser's clock is pinned to APP_TIMEZONE too: the client picks the
    // month the Expenses and Finances tabs open on from its own `new Date()`.
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, timezoneId: appTimezone });
    await signInAsOwner(page);

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

    // --- API seeding (every tab has been checked empty by now) ---
    for (const e of DEMO_EXPENSES) {
      const res = await api("POST", "/entries", { year, month, ...e });
      if (res.status !== 201) throw new Error(`Seeding "${e.remarks}" failed with ${res.status}: ${await res.text()}`);
    }
    const incomeRes = await api("PUT", `/finance/${prevYear}/${prevMonth}`, DEMO_LAST_MONTH_INCOME);
    if (!incomeRes.ok) throw new Error(`Seeding ${prevYear}-${prevMonth}'s income failed with ${incomeRes.status}: ${await incomeRes.text()}`);

    // --- Dashboard screenshots (light, then dark) ---
    await page.click('.tabs button:has-text("Dashboard")');
    await page.waitForSelector(".emi-projection-chart-wrap .recharts-rectangle");
    await page.waitForTimeout(500);

    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "dashboard.png") });

    await setTheme(page, "dark");
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "dashboard-dark.png") });

    // --- Per-tab screenshots: 720px wide (full labels, above the 600px
    // phone breakpoint), full page, light then dark ---
    await page.setViewportSize({ width: 720, height: 900 });
    const shot = (name: string, theme: "light" | "dark") =>
      page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${name}${theme === "dark" ? "-dark" : ""}.png`), fullPage: true });

    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);

      // Add Expense: the form filled in, then the saved entry in the list.
      // The Dashboard hop remounts Expenses, so the dark pass reloads the
      // month after the light pass's entry was removed below.
      await openTab(page, "Dashboard", ".chart-wrap svg");
      await openTab(page, "Expenses", ".add-expense-form");
      await page.fill('.add-expense-form input[type="number"]', NEW_EXPENSE.amount);
      await page.fill('.add-expense-form input[type="text"]', NEW_EXPENSE.remarks);
      await page.click(`button.category-chip:has-text("${NEW_EXPENSE.category}")`);
      await shot("add-expense", theme);
      await page.click('button.submit-btn:has-text("Add Expense")');
      await page.waitForSelector(`.entry-row:has-text("${NEW_EXPENSE.remarks}")`);
      await page.waitForTimeout(300);
      await shot("recent-entries", theme);

      // Remove it again, so the next pass starts from the same month.
      const entries = (await api("GET", `/months/${year}/${month}`).then((r) => r.json())) as { row: number; remarks: string }[];
      const added = entries.find((e) => e.remarks === NEW_EXPENSE.remarks);
      if (!added) throw new Error(`"${NEW_EXPENSE.remarks}" not found after adding it`);
      const del = await api("DELETE", `/entries/${year}/${month}/${added.row}`);
      if (!del.ok) throw new Error(`Removing "${NEW_EXPENSE.remarks}" failed with ${del.status}`);

      await openTab(page, "Credit Cards", ".cards-add");
      await shot("credit-cards", theme);
      await openTab(page, "Debts", ".debt-row");
      await shot("debts", theme);
      await openTab(page, "EMI", ".emi-row");
      await shot("emi", theme);
      await openTab(page, "Subscriptions", ".subscription-row");
      await shot("subscriptions", theme);
      await openTab(page, "Finances", ".savings-row");
      await shot("finances", theme);
    }

    await browser.close();
    console.log(`\nWrote every screenshot to ${SCREENSHOTS_DIR}`);
  } finally {
    stopDevServer(devProcess);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
