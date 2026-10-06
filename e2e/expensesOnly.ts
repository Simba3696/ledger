/**
 * Second e2e pass (run by `npm run test:e2e` after regression.ts): the same
 * app started with ENABLED_MODULES=expenses, the shape of a first,
 * expenses-only deployment (ADR-0006), on a database with no expenses at
 * all, as a brand-new deployment has. Checks the nav shows only Dashboard
 * and Expenses, the Expenses tab opens on an empty month with no error
 * before the first expense, expenses can be added, edited and deleted, the Dashboard
 * renders its expense charts with no card for a disabled module and no
 * console error (so the client never calls a disabled route), and a
 * disabled module's API answers 404. Signs in through the UI as the
 * seeded owner first, like regression.ts, and checks the 401 without a
 * token, a wrong password's error and signing out.
 *
 * Same isolation as regression.ts: resets the LOCAL database first
 * (e2e/localDb.ts refuses any other host) and runs on this checkout's ports.
 * ENABLED_MODULES reaches the server through its environment; server/.env
 * is never edited.
 */
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { chromium } from "playwright";
import { resetLocalDatabase } from "./localDb.js";
import { ROOT, SERVER_PORT, serverEnv, startDevServer, stopDevServer } from "./devServer.js";
import { assertLocalAuth, checkSignInFlow, ownerAccessToken } from "./auth.js";

const results: { label: string; ok: boolean }[] = [];
function check(label: string, ok: boolean) {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
}

async function main() {
  const ownerEmail = assertLocalAuth();
  await resetLocalDatabase(ROOT, serverEnv.DATABASE_URL);

  // "Now" as the server sees it (APP_TIMEZONE), the year the API checks ask
  // about. Nothing is seeded: the first expense goes in through the UI, as
  // on a brand-new deployment.
  const { todayInAppZone } = await import("../server/src/domain/today.js");
  const year = todayInAppZone(new Date(), serverEnv.APP_TIMEZONE || undefined).getFullYear();

  console.log("Starting dev server with ENABLED_MODULES=expenses...");
  const consoleErrors: string[] = [];
  let devProcess: ChildProcessWithoutNullStreams | undefined;

  try {
    devProcess = await startDevServer({ ENABLED_MODULES: "expenses" });

    // --- API ---
    check(
      "API: a request without a token is a 401",
      (await fetch(`http://localhost:${SERVER_PORT}/api/config`)).status === 401,
    );
    const token = await ownerAccessToken();
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`http://localhost:${SERVER_PORT}/api${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      });
    check(
      "API: /api/config lists only expenses",
      JSON.stringify(await api("/config").then((r) => r.json())) === JSON.stringify({ modules: ["expenses"] }),
    );
    const debtsRes = await api("/debts");
    check(
      "API: a disabled module's route is a 404 naming the module",
      debtsRes.status === 404 &&
        JSON.stringify(await debtsRes.json()) === JSON.stringify({ error: "Debts is not enabled on this deployment" }),
    );
    const debtWrite = await api("/debts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alex", amount: 100 }),
    });
    check("API: a write to a disabled module is a 404 too", debtWrite.status === 404);
    check("API: the expenses year summary is still served", (await api(`/summary/${year}`)).status === 200);
    const overview = await api("/overview").then((r) => r.json());
    check(
      "API: the overview answers with every non-expenses figure null and nothing upcoming",
      overview.netWorth.netWorth === null && overview.netWorth.totalDebt === null && overview.upcoming.length === 0,
    );

    // --- Nav + Dashboard ---
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push("pageerror: " + err.message));

    // --- Sign-in ---
    await checkSignInFlow(page, ownerEmail, consoleErrors, check);

    check(
      "Nav bar: exactly Dashboard and Expenses",
      (await page.locator(".tabs button").allInnerTexts()).join(",") === "Dashboard,Expenses",
    );
    check("Default tab is Dashboard", (await page.locator(".tabs button.selected").innerText()) === "Dashboard");
    check(
      "Dashboard: no overview, Upcoming or EMI card",
      (await page.locator(".overview-panel").count()) === 0 &&
        (await page.locator(".upcoming").count()) === 0 &&
        (await page.locator(".emi-projection").count()) === 0,
    );
    check("Dashboard: no Net Worth figure anywhere", (await page.getByText("Net Worth").count()) === 0);
    check("Dashboard: no error on a deployment with no expenses yet", (await page.locator(".error").count()) === 0);

    // --- Expenses: a fresh deployment, before the first expense ---
    await page.click('.tabs button:has-text("Expenses")');
    await page.waitForSelector(".add-expense-form");
    await page.waitForSelector(".loading-overlay", { state: "detached" });
    check("Expenses tab selected", (await page.locator(".tabs button.selected").innerText()) === "Expenses");
    check(
      "Expenses: a fresh deployment shows an empty month and no error text",
      (await page.locator(".entry-row").count()) === 0 && (await page.locator(".error").count()) === 0,
    );

    await page.fill('.add-expense-form input[type="number"]', "120");
    await page.fill('.add-expense-form input[type="text"]', "First Groceries");
    await page.click('.add-expense-form button.category-chip:has-text("Food")');
    await page.click('button.submit-btn:has-text("Add Expense")');
    await page.waitForSelector('.entry-row:has-text("First Groceries")');
    check(
      "Expenses: the first expense is listed, still with no error",
      (await page.locator(".entry-row").count()) === 1 && (await page.locator(".error").count()) === 0,
    );

    await page.click(".brand");
    await page.waitForSelector(".chart-wrap svg");
    await page.waitForSelector(".loading-overlay", { state: "detached" });
    check(
      "Dashboard: the yearly expense charts render, including the first expense",
      (await page.locator(".dashboard-total strong").innerText()).includes("120") &&
        (await page.locator(".category-chart").count()) > 0,
    );

    // --- Expenses: add, edit, delete ---
    await page.click('.tabs button:has-text("Expenses")');
    await page.waitForSelector(".add-expense-form");
    await page.waitForSelector(".loading-overlay", { state: "detached" });
    await page.waitForSelector('.entry-row:has-text("First Groceries")');

    await page.fill('.add-expense-form input[type="number"]', "250");
    await page.fill('.add-expense-form input[type="text"]', "E2E Lunch");
    await page.click('.add-expense-form button.category-chip:has-text("Food")');
    await page.click('button.submit-btn:has-text("Add Expense")');
    await page.waitForSelector('.entry-row:has-text("E2E Lunch")');
    check("Expenses: adding an entry lists it", (await page.locator(".entry-row").count()) === 2);

    const row = () => page.locator(".entry-row", { hasText: "E2E Lunch" });
    await row().locator(".overflow-menu-trigger").click();
    await row().locator(".overflow-menu-list").getByRole("menuitem", { name: "Edit" }).click();
    await page.waitForSelector(".row-editing");
    const editInputs = page.locator(".row-editing .edit-fields input");
    await editInputs.nth(0).fill("275");
    await editInputs.nth(1).fill("E2E Lunch Edited");
    await page.click('.row-editing button:has-text("Save")');
    await page.waitForSelector('.entry-row:has-text("E2E Lunch Edited")');
    check(
      "Expenses: editing an entry updates it",
      (await page.locator(".entry-row", { hasText: "E2E Lunch Edited" }).innerText()).includes("275.00"),
    );

    await row().locator(".overflow-menu-trigger").click();
    await row().locator(".overflow-menu-list").getByRole("menuitem", { name: "Delete" }).click();
    await page.waitForSelector(".dialog-card");
    await page.click(".dialog-confirm");
    await page.waitForSelector('.entry-row:has-text("E2E Lunch")', { state: "detached" });
    check("Expenses: deleting an entry removes it", (await page.locator(".entry-row").count()) === 1);

    // Back on the Dashboard, the logo works and nothing new appeared.
    await page.click(".brand");
    await page.waitForSelector(".chart-wrap svg");
    await page.waitForSelector(".loading-overlay", { state: "detached" });
    check(
      "Dashboard: still only the expense charts after a round trip",
      (await page.locator(".overview-panel").count()) === 0 && (await page.locator(".chart-wrap").count()) === 1,
    );

    // --- Sign out ---
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForSelector("form.auth-card");
    check("Sign out returns to the sign-in screen", (await page.locator(".tabs").count()) === 0);

    await browser.close();
  } finally {
    stopDevServer(devProcess);
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n=== e2e expenses-only summary ===");
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log("Failures:", failed.map((f) => f.label));
  console.log("Console/page errors:", consoleErrors.length ? consoleErrors : "none");

  if (failed.length || consoleErrors.length) {
    console.error("\ne2e expenses-only FAILED");
    process.exit(1);
  }
  console.log("\ne2e expenses-only PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
