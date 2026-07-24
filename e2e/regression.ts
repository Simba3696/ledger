/**
 * Full-stack regression check: builds a synthetic data directory, starts the
 * real dev server against it, and drives the actual browser UI through every
 * feature (dashboard, add/edit/delete/reorder, theme, click-through
 * navigation). Run with `npm run test:e2e` after any client or server change.
 *
 * Deliberately not run automatically alongside `npm test` (the vitest suite)
 * since it spins up real dev-server processes and a browser — it's meant to
 * be run on demand, not on every save.
 */
import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildFixtureWorkbook } from "../server/test/fixtures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const results: { label: string; ok: boolean }[] = [];
function check(label: string, ok: boolean) {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
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

async function main() {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-e2e-"));
  console.log("Scratch data dir:", scratchDir);

  const now = new Date();
  const year = now.getFullYear();
  const monthIndex = now.getMonth(); // 0-11, matches the dashboard chart's tick order
  const monthName = now.toLocaleString("en-US", { month: "long" });
  const ALL_MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  // Seed every month sheet (a couple of unrelated dummy entries each) so
  // switching the month selector during the test never legitimately 404s.
  // The *actual current* month/year gets the real seeded data used by the
  // rest of the checks, since edit/delete/reorder are only enabled in the UI
  // for the real current month — hardcoding a fixed month/year here would
  // silently stop testing those features once time moves past it.
  await buildFixtureWorkbook(
    path.join(scratchDir, `Expenses (${year}).xlsx`),
    ALL_MONTHS.map((name) => ({
      name,
      entries:
        name === monthName
          ? [
              { amount: 100, remarks: "Seeded Food Entry", category: "food" as const },
              { amount: 50, remarks: "Seeded Card Entry", category: "transportation" as const, isCard: true },
            ]
          : [{ amount: 10, remarks: "Filler", category: "other" as const }],
    })),
  );

  console.log("Starting dev server against scratch data...");
  const devProcess: ChildProcessWithoutNullStreams = spawn("npm", ["run", "dev"], {
    cwd: ROOT,
    env: { ...process.env, LEDGER_DB_DIR: scratchDir },
    shell: true,
  });
  devProcess.stdout.on("data", () => {});
  devProcess.stderr.on("data", () => {});

  const consoleErrors: string[] = [];

  try {
    await waitForServer("http://localhost:4000/api/categories", 30000);
    await waitForServer("http://localhost:5173", 30000);

    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push("pageerror: " + err.message));
    page.on("dialog", (d) => d.accept());

    await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
    await page.waitForSelector(".chart-wrap svg");

    // --- Dashboard defaults + click-through navigation ---
    check("Default tab is Dashboard", (await page.locator(".tabs button.selected").innerText()) === "Dashboard");

    const ticks = page.locator(".recharts-cartesian-axis-tick-value");
    const svgBox = await page.locator('.chart-wrap svg[role="application"]').boundingBox();
    async function clickChartMonth(index: number) {
      // Recomputed fresh (not the outer svgBox) and scrolled into view every
      // call — this runs again later after the mini-chart detour below has
      // scrolled the page down, and page.mouse.move works in raw page
      // coordinates with no auto-scroll, so a stale/off-screen box would
      // silently miss the chart entirely.
      await page.locator(".chart-wrap").scrollIntoViewIfNeeded();
      const freshSvgBox = await page.locator('.chart-wrap svg[role="application"]').boundingBox();
      const tickBox = await ticks.nth(index).boundingBox();
      if (!tickBox || !freshSvgBox) throw new Error("Could not locate chart elements");
      const x = tickBox.x + tickBox.width / 2;
      const y = freshSvgBox.y + freshSvgBox.height * 0.5;
      await page.mouse.move(x, y, { steps: 8 });
      await page.waitForTimeout(150);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(400);
    }
    // --- Cross-chart hover sync (syncId) ---
    const hoverTickBox = await ticks.nth(monthIndex).boundingBox();
    if (!hoverTickBox || !svgBox) throw new Error("Could not locate chart elements for hover-sync check");
    await page.mouse.move(hoverTickBox.x + hoverTickBox.width / 2, svgBox.y + svgBox.height * 0.5, { steps: 8 });
    await page.waitForTimeout(300);
    check(
      "Hovering the main chart highlights the same month in the category mini-charts",
      (await page.locator(".category-chart", { hasText: "Food :" }).count()) > 0,
    );

    // The hover-sync check above leaves a tooltip popup floating right over
    // the bar we're about to click next (same month, same first mini-chart)
    // — move away first so that overlay doesn't intercept the click.
    await page.mouse.move(10, 10);
    await page.waitForTimeout(200);

    // --- Category mini-charts are clickable too (same handleBarClick as the main chart) ---
    // Targets the bar's own <path name="Jul"> rather than an X-axis tick by
    // index: the mini charts are narrower than the main chart, so Recharts
    // auto-skips some month labels to avoid overlap (e.g. only 8 of 12
    // render) — meaning the Nth rendered tick doesn't reliably correspond to
    // the Nth calendar month there, unlike the full-width main chart above.
    // Also uses move-then-wait-then-down/up, not page.mouse.click() — that
    // shortcut doesn't reliably populate Recharts' hover-tracked index first.
    const firstMiniChart = page.locator(".category-chart").first();
    // The mini-charts sit below the main chart and render below the fold at
    // the default viewport size — page.mouse.move (unlike .click()) moves to
    // raw page coordinates without auto-scrolling, so without this the
    // computed bounding box points at an off-screen position.
    await firstMiniChart.scrollIntoViewIfNeeded();
    const monthAbbr = monthName.slice(0, 3);
    const barBox = await firstMiniChart.locator(`path[name="${monthAbbr}"]`).boundingBox();
    if (!barBox) throw new Error(`Could not locate the "${monthAbbr}" bar in the first category mini-chart`);
    await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2, { steps: 8 });
    await page.waitForTimeout(150);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(400);
    check(
      "Clicking a category mini-chart also navigates to Expenses",
      (await page.locator(".tabs button.selected").innerText()) === "Expenses",
    );
    await page.click('.tabs button:has-text("Dashboard")');
    // App.tsx conditionally renders the Dashboard tab, so switching back to
    // it unmounts/remounts the whole component — wait for its chart to
    // actually reappear (a fresh API fetch + render) rather than a fixed
    // delay that may finish before that's done.
    await page.waitForSelector(".chart-wrap svg");
    await page.waitForTimeout(300);

    await clickChartMonth(monthIndex);
    check("Click-through navigated to Expenses", (await page.locator(".tabs button.selected").innerText()) === "Expenses");
    check(
      "Click-through selected the clicked month",
      (await page.locator(".month-picker select").first().inputValue()) === String(monthIndex + 1),
    );
    check(
      "Click-through selected the clicked year",
      (await page.locator(".month-picker select").nth(1).inputValue()) === String(year),
    );
    check("Seeded entries loaded", (await page.locator(".entry-row").count()) === 2);

    // --- Month/year selects (shared YearSelect component) ---
    const otherMonthValue = String(((monthIndex + 1) % 12) + 1);
    await page.selectOption(".month-picker select >> nth=0", otherMonthValue);
    check(
      "Month select works",
      (await page.locator(".month-picker select").first().inputValue()) === otherMonthValue,
    );
    await page.selectOption(".month-picker select >> nth=0", String(monthIndex + 1));
    await page.waitForTimeout(300);

    // --- Add a cash entry ---
    const beforeCount = await page.locator(".entry-row").count();
    await page.fill('input[type="number"]', "42");
    await page.fill('input[type="text"]', "E2E Cash Entry");
    await page.click('button.category-chip:has-text("Food")');
    await page.click('button.submit-btn:has-text("Add Expense")');
    await page.waitForSelector("text=E2E Cash Entry");
    check("Add cash entry increased row count", (await page.locator(".entry-row").count()) === beforeCount + 1);
    check(
      "Form reset after add",
      (await page.locator(".add-expense-form input[type=\"number\"]").inputValue()) === "",
    );

    // --- Add a card entry ---
    await page.fill('input[type="number"]', "77");
    await page.fill('input[type="text"]', "E2E Card Entry");
    await page.click('button.category-chip:has-text("Rent")');
    await page.click('.payment-toggle button:has-text("Credit Card")');
    await page.click('button.submit-btn:has-text("Add Expense")');
    await page.waitForSelector("text=E2E Card Entry");
    check(
      "Card entry shows CC badge",
      (await page.locator('.entry-row:has-text("E2E Card Entry") .entry-cc').count()) === 1,
    );

    // --- Overflow menu (three-dot) helper — takes an already-resolved
    // single-row locator, since callers need different ways of pinning down
    // exactly one row (by exact remarks text, or positionally via .first()).
    async function clickMenuItem(row: ReturnType<typeof page.locator>, itemLabel: string) {
      await row.locator(".overflow-menu-trigger").click();
      await row.locator(".overflow-menu-list").getByRole("menuitem", { name: itemLabel }).click();
    }
    // Playwright's `hasText` is a substring match, so once the copy gets
    // renamed to "...Edited" below, plain `hasText: "E2E Cash Entry"` would
    // ambiguously match both rows — filter it back out to stay exact.
    const cashEntryRow = () =>
      page.locator(".entry-row", { hasText: "E2E Cash Entry" }).filter({ hasNotText: "Edited" });

    // --- Copy the cash entry ---
    const beforeCopyCount = await page.locator(".entry-row").count();
    await clickMenuItem(cashEntryRow(), "Copy");
    await page.waitForTimeout(400);
    check("Copy added a new row", (await page.locator(".entry-row").count()) === beforeCopyCount + 1);
    check(
      "Copy produced two independent rows with the same remarks",
      (await page.locator(".entry-row", { hasText: "E2E Cash Entry" }).count()) === 2,
    );
    check(
      "Copy lands at the end of the list (shown first, newest-first)",
      (await page.locator(".entry-row").first().locator(".entry-remarks").innerText()) === "E2E Cash Entry",
    );

    // --- Edit the copy (the newest row) — proves it's independently editable,
    // not a linked clone, and that the original is left untouched ---
    await clickMenuItem(page.locator(".entry-row").first(), "Edit");
    await page.waitForSelector(".entry-row-editing");
    const editInputs = page.locator(".entry-row-editing .edit-fields input");
    await editInputs.nth(0).fill("99");
    await editInputs.nth(1).fill("E2E Cash Entry Edited");
    await page.click('.entry-row-editing button.category-chip:has-text("Transportation")');
    await page.click('.entry-row-editing button:has-text("Save")');
    await page.waitForSelector("text=E2E Cash Entry Edited");
    const editedRowText = await page.locator('.entry-row:has-text("E2E Cash Entry Edited")').innerText();
    check("Edit updated the amount", editedRowText.includes("99.00"));
    check("Editing the copy left the original untouched", (await cashEntryRow().count()) === 1);

    // --- Drag reorder ---
    const src = page.locator(".entry-row", { hasText: "E2E Cash Entry Edited" });
    const dst = page.locator(".entry-row", { hasText: "E2E Card Entry" });
    await src.dragTo(dst);
    await page.waitForTimeout(500);
    const namesAfterDrag = await page.locator(".entry-remarks").allInnerTexts();
    check(
      "Drag reorder changed row order",
      namesAfterDrag.indexOf("E2E Cash Entry Edited") !== -1 && namesAfterDrag.indexOf("E2E Card Entry") !== -1,
    );

    // --- Delete all three test entries (cleanup + verifies delete) ---
    await clickMenuItem(page.locator(".entry-row", { hasText: "E2E Cash Entry Edited" }), "Delete");
    await page.waitForTimeout(400);
    await clickMenuItem(page.locator(".entry-row", { hasText: "E2E Card Entry" }), "Delete");
    await page.waitForTimeout(400);
    await clickMenuItem(cashEntryRow(), "Delete");
    await page.waitForTimeout(400);
    check("All test entries deleted, back to seeded count", (await page.locator(".entry-row").count()) === beforeCount);

    // --- Auto-create next year's workbook on first entry ---
    // The scratch dir only seeded the current year, so next year genuinely
    // has no file yet — this exercises appendEntry's auto-create path (and
    // confirms YearSelect actually offers a year beyond the current one).
    const nextYear = String(year + 1);
    await page.selectOption(".month-picker select >> nth=1", nextYear);
    await page.waitForTimeout(300);
    check("Selecting next year shows no entries yet (no file, no crash)", (await page.locator(".entry-row").count()) === 0);
    // That 404 is expected (confirming the file doesn't exist yet before we
    // auto-create it below) — the browser logs it as a console error
    // regardless of the app handling it gracefully, so filter this one
    // known-expected occurrence out rather than let it fail the "no console
    // errors" check at the end.
    const expected404 = consoleErrors.findIndex((e) => e.includes("404"));
    if (expected404 !== -1) consoleErrors.splice(expected404, 1);

    await page.fill('input[type="number"]', "999");
    await page.fill('input[type="text"]', "First entry of a new year");
    await page.click('button.category-chip:has-text("Food")');
    await page.click('button.submit-btn:has-text("Add Expense")');
    await page.waitForSelector("text=First entry of a new year");
    check(
      "Adding an entry to an unset year auto-creates its workbook",
      (await page.locator(".entry-row").count()) === 1,
    );

    // Switch back — the Finances checks below assume the original seeded year.
    await page.selectOption(".month-picker select >> nth=1", String(year));
    await page.waitForTimeout(300);

    // --- Finances tab (salary/balance/savings) ---
    await page.click('.tabs button:has-text("Finances")');
    check("Finances tab selected", (await page.locator(".tabs button.selected").innerText()) === "Finances");

    const incomeInputs = page.locator('.income-form input[type="number"]');
    await incomeInputs.nth(0).fill("50000"); // Salary
    await incomeInputs.nth(1).fill("5000"); // Other Income

    // Current Savings: a dynamic list of named scheme balances, summed
    // automatically rather than one manual total.
    await page.click(".savings-add");
    await page.click(".savings-add");
    const savingsRows = page.locator(".savings-row");
    await savingsRows.nth(0).locator('input[type="text"]').fill("PPF");
    await savingsRows.nth(0).locator('input[type="number"]').fill("120000");
    await savingsRows.nth(1).locator('input[type="text"]').fill("NPS");
    await savingsRows.nth(1).locator('input[type="number"]').fill("80000");
    check(
      "Finance: savings editor shows a live total as rows are filled",
      (await page.locator(".savings-editor-total").innerText()).includes("2,00,000"),
    );

    await page.click(".income-form button.submit-btn");
    await page.waitForSelector(".finance-stats");
    await page.waitForTimeout(300);

    async function financeStat(label: string): Promise<string> {
      return page.locator(`.finance-stat:has-text("${label}") strong`).innerText();
    }
    check("Finance: Money Earned reflects salary + other income", (await financeStat("Money Earned")).includes("55,000"));
    check("Finance: Minimum Savings is ceil(15% of income)", (await financeStat("Minimum Savings")).includes("8,250"));
    check("Finance: Current Savings sums both scheme entries", (await financeStat("Current Savings")).includes("2,00,000"));

    // No prior month has a salary on record, so it's treated as zero income —
    // this month's balance is a plain deficit equal to its own expenses (the
    // 150 in seeded entries; Salary/Other Income entered *this* month only
    // affects *next* month's balance, not this one).
    const balanceText = await financeStat("Balance");
    check("Finance: Balance treats unset prior salary as zero income (a deficit)", balanceText.startsWith("-") && balanceText.includes("150"));

    // Cumulative sums every month back to EARLIEST_YEAR: each filler-seeded
    // month before this one (10 in expenses, no salary) contributes -10, plus
    // this month's own -150.
    const expectedCumulativeMagnitude = 10 * monthIndex + 150;
    const cumulativeText = await financeStat("Cumulative");
    check(
      "Finance: Cumulative accumulates deficits from every prior unset month",
      cumulativeText.startsWith("-") && cumulativeText.includes(String(expectedCumulativeMagnitude)),
    );

    await page.reload({ waitUntil: "networkidle" });
    await page.click('.tabs button:has-text("Finances")');
    await page.waitForSelector(".finance-stats");
    check("Finance entry persisted across reload", (await incomeInputs.nth(0).inputValue()) === "50000");
    check("Finance: savings breakdown persisted across reload", (await page.locator(".savings-row").count()) === 2);

    // --- Theme toggle ---
    await page.click(".theme-toggle");
    await page.waitForTimeout(300);
    check("Theme toggled to dark", (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(300);
    check(
      "Theme persisted across reload",
      (await page.evaluate(() => document.documentElement.dataset.theme)) === "dark",
    );

    await browser.close();
  } finally {
    console.log("Stopping dev server...");
    devProcess.kill();
    try {
      execSync("node scripts/kill-ports.js", { cwd: ROOT, stdio: "ignore" });
    } catch {
      // best-effort cleanup
    }
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n=== e2e regression summary ===");
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log("Failures:", failed.map((f) => f.label));
  console.log("Console/page errors:", consoleErrors.length ? consoleErrors : "none");

  if (failed.length || consoleErrors.length) {
    console.error("\ne2e regression FAILED");
    process.exit(1);
  }
  console.log("\ne2e regression PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
