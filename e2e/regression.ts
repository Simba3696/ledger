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
  const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

    // The Dashboard chart's DOM shell now renders immediately (even before its
    // data has loaded, so the loading overlay has something to cover) — so
    // waiting for `.chart-wrap svg` to exist is no longer enough to know the
    // real data (and therefore real tick positions) are in place. Also wait
    // for the loading overlay to clear before computing any click coordinates
    // against the chart.
    async function waitForDashboardData() {
      await page.waitForSelector(".chart-wrap svg");
      await page.waitForSelector(".loading-overlay", { state: "detached" });
    }

    await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
    await waitForDashboardData();

    // --- Dashboard defaults + click-through navigation ---
    check("Default tab is Dashboard", (await page.locator(".tabs button.selected").innerText()) === "Dashboard");

    // Targets a bar's own <path name="Jul"> rather than an X-axis tick's
    // position: `.recharts-cartesian-axis-tick-value` matches Y-axis tick
    // labels too (the main chart renders its 5 Y-axis ticks *before* its 12
    // X-axis ticks in DOM order), so a plain index into that selector across
    // the whole page doesn't reliably land on the intended month — same
    // fragility already discovered for the narrower mini-charts below, just
    // less obviously so here since the main chart itself doesn't skip labels.
    async function monthBarBox(index: number) {
      const abbr = MONTH_ABBR[index];
      const locator = page.locator(`.chart-wrap path[name="${abbr}"]`).first();
      // Retries the whole attached-then-boundingBox sequence, not just a
      // single wait: right after a remount, React StrictMode's dev-mode
      // double-invoke can make Recharts mount its bar <path> elements, then
      // briefly replace them again — a locator can resolve "attached" and
      // then find the element already gone by the very next call. Polling a
      // few times rides out that flicker instead of assuming one resolution
      // is stable.
      const start = Date.now();
      while (Date.now() - start < 10000) {
        try {
          await locator.waitFor({ state: "attached", timeout: 2000 });
          const box = await locator.boundingBox();
          if (box) return box;
        } catch {
          // not attached yet within this attempt's window — retry
        }
        await page.waitForTimeout(150);
      }
      throw new Error(`Could not locate the "${abbr}" bar in the main chart`);
    }
    async function clickChartMonth(index: number) {
      // Scrolled into view every call — this runs again later after the
      // mini-chart detour below has scrolled the page down, and
      // page.mouse.move works in raw page coordinates with no auto-scroll,
      // so an off-screen target would silently miss the chart entirely.
      await page.locator(".chart-wrap").scrollIntoViewIfNeeded();
      const freshSvgBox = await page.locator('.chart-wrap svg[role="application"]').boundingBox();
      const barBox = await monthBarBox(index);
      if (!freshSvgBox) throw new Error("Could not locate chart elements");
      const x = barBox.x + barBox.width / 2;
      const y = freshSvgBox.y + freshSvgBox.height * 0.5;
      await page.mouse.move(x, y, { steps: 8 });
      await page.waitForTimeout(150);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(400);
    }
    // --- Cross-chart hover sync (syncId) ---
    const hoverBarBox = await monthBarBox(monthIndex);
    const hoverSvgBox = await page.locator('.chart-wrap svg[role="application"]').boundingBox();
    if (!hoverSvgBox) throw new Error("Could not locate chart elements for hover-sync check");
    await page.mouse.move(hoverBarBox.x + hoverBarBox.width / 2, hoverSvgBox.y + hoverSvgBox.height * 0.5, { steps: 8 });
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
      // Expenses has no nav button (only reachable via a chart click), so
      // there's no ".tabs button.selected" to check here — the add-expense
      // form's presence is the reliable marker that we landed on that tab.
      await page.locator(".add-expense-form").isVisible(),
    );
    await page.click('.tabs button:has-text("Dashboard")');
    // App.tsx conditionally renders the Dashboard tab, so switching back to
    // it unmounts/remounts the whole component — wait for its chart to
    // actually reappear with real data loaded (not just the DOM shell)
    // rather than a fixed delay that may finish before that's done.
    await waitForDashboardData();
    await page.waitForTimeout(300);

    await clickChartMonth(monthIndex);
    check("Click-through navigated to Expenses", await page.locator(".add-expense-form").isVisible());
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
    await page.waitForSelector(".row-editing");
    const editInputs = page.locator(".row-editing .edit-fields input");
    await editInputs.nth(0).fill("99");
    await editInputs.nth(1).fill("E2E Cash Entry Edited");
    await page.click('.row-editing button.category-chip:has-text("Transportation")');
    await page.click('.row-editing button:has-text("Save")');
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
    // .finance-stats can appear before the salary field is repopulated (the
    // two fetches run in parallel; the stats-visible signal only tracks one
    // of them), so wait for the overlay to actually clear rather than just
    // for the stats to exist.
    await page.waitForSelector(".finance-stats");
    await page.waitForSelector(".loading-overlay", { state: "detached" });
    check("Finance entry persisted across reload", (await incomeInputs.nth(0).inputValue()) === "50000");
    check("Finance: savings breakdown persisted across reload", (await page.locator(".savings-row").count()) === 2);

    // --- Debts tab ---
    await page.click('.tabs button:has-text("Debts")');
    check("Debts tab selected", (await page.locator(".tabs button.selected").innerText()) === "Debts");
    await page.waitForSelector(".debts p.empty");
    check("Debts starts empty", (await page.locator(".debts p.empty").count()) === 1);

    async function fillDebtForm(name: string, amount: string) {
      await page.fill(".add-debt-form input[type=\"text\"]", name);
      await page.fill(".add-debt-form input[type=\"number\"]", amount);
      await page.click('.add-debt-form button:has-text("Add Debt")');
      await page.waitForSelector(`text=${name}`);
    }

    await fillDebtForm("E2E Umma", "17700"); // positive = you owe
    check("Adding a debt shows it in the list", (await page.locator(".debt-row", { hasText: "E2E Umma" }).count()) === 1);
    check("Debt stats: You owe reflects the positive entry", (await page.locator(".debt-stat", { hasText: "You owe" }).innerText()).includes("17,700"));

    await fillDebtForm("E2E Anandu", "-29000"); // negative = owed to you
    check(
      "Debt stats: Owed to you reflects the negative entry",
      (await page.locator(".debt-stat", { hasText: "Owed to you" }).innerText()).includes("29,000"),
    );
    const netStatText = await page.locator(".debt-stat", { hasText: "Net" }).innerText();
    check(
      "Debt stats: Net is You owe minus Owed to you",
      netStatText.includes("-") && netStatText.includes("11,300"),
    );

    // --- Edit a debt entry ---
    await clickMenuItem(page.locator(".debt-row", { hasText: "E2E Umma" }), "Edit");
    await page.waitForSelector(".row-editing");
    const debtEditInputs = page.locator(".row-editing .edit-fields input");
    await debtEditInputs.nth(1).fill("20000");
    await page.click('.row-editing button:has-text("Save")');
    await page.waitForTimeout(400);
    check(
      "Editing a debt updates its amount",
      (await page.locator(".debt-row", { hasText: "E2E Umma" }).innerText()).includes("20,000"),
    );

    // --- Sorting (Umma=20000, Anandu=-29000 at this point) ---
    async function debtNames(): Promise<string[]> {
      return page.locator(".debt-name").allInnerTexts();
    }
    await page.click('.debts-sort button:has-text("Amount")'); // ascending: lowest first
    const amountAsc = await debtNames();
    check(
      "Sorting by Amount ascending puts the negative entry first",
      amountAsc.indexOf("E2E Anandu") < amountAsc.indexOf("E2E Umma"),
    );
    await page.click('.debts-sort button:has-text("Amount")'); // descending: highest first
    const amountDesc = await debtNames();
    check(
      "Sorting by Amount descending puts the positive entry first",
      amountDesc.indexOf("E2E Umma") < amountDesc.indexOf("E2E Anandu"),
    );
    await page.click('.debts-sort button:has-text("Name")'); // back to default for the rest of the flow
    await page.waitForTimeout(200);

    // --- Delete a debt entry ---
    const beforeDebtCount = await page.locator(".debt-row").count();
    await clickMenuItem(page.locator(".debt-row", { hasText: "E2E Anandu" }), "Delete");
    await page.waitForTimeout(400);
    check("Deleting a debt removes it from the list", (await page.locator(".debt-row").count()) === beforeDebtCount - 1);
    check(
      "Debt stats after delete: Net matches the one remaining entry",
      (await page.locator(".debt-stat", { hasText: "Net" }).innerText()).includes("20,000"),
    );

    // Clean up the remaining test debt so this suite is idempotent across runs.
    await clickMenuItem(page.locator(".debt-row", { hasText: "E2E Umma" }), "Delete");
    await page.waitForTimeout(400);
    check("Debts back to empty after cleanup", (await page.locator(".debt-row").count()) === 0);

    // --- EMI tab ---
    await page.click('.tabs button:has-text("EMI")');
    check("EMI tab selected", (await page.locator(".tabs button.selected").innerText()) === "EMI");
    await page.waitForSelector(".emi p.empty");
    check("EMI starts empty", (await page.locator(".emi p.empty").count()) === 1);

    await page.fill('.add-emi-form input[placeholder="Who\'s it with?"]', "E2E Coral");
    const emiNumberInputs = page.locator(".add-emi-form input[type=\"number\"]");
    await emiNumberInputs.nth(0).fill("1000"); // EMI Amount
    await emiNumberInputs.nth(1).fill("15"); // Due Day
    await emiNumberInputs.nth(2).fill("12000"); // Total Amount
    await emiNumberInputs.nth(3).fill("6000"); // Current Balance
    await page.fill('.add-emi-form input[placeholder="Optional"]', "E2E Loan");
    await page.click('.add-emi-form button:has-text("Add EMI")');
    await page.waitForSelector('.emi-row:has-text("E2E Coral")');

    check(
      "EMI: row shows remaining of total",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes("6,000") &&
        (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes("12,000"),
    );
    check(
      "EMI: not paid off shows an estimated payoff month, not \"Paid off\"",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes("Finishes"),
    );
    check(
      "EMI: Total Remaining stat reflects the new entry",
      (await page.locator(".emi-stat", { hasText: "Total Remaining" }).innerText()).includes("6,000"),
    );
    check(
      "EMI: Total Monthly EMI stat reflects the new entry",
      (await page.locator(".emi-stat", { hasText: "Total Monthly EMI" }).innerText()).includes("1,000"),
    );
    check(
      "EMI: Active Loans stat is 1",
      (await page.locator(".emi-stat", { hasText: "Active Loans" }).innerText()).includes("1"),
    );

    // --- Edit an EMI entry (correcting drift in the current balance) ---
    await clickMenuItem(page.locator(".emi-row", { hasText: "E2E Coral" }), "Edit");
    await page.waitForSelector(".row-editing");
    await page.locator(".emi-edit-fields input[type=\"number\"]").nth(3).fill("3000"); // Current Balance
    await page.click('.row-editing button:has-text("Save")');
    await page.waitForTimeout(400);
    check(
      "EMI: editing updates the current balance",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes("3,000"),
    );

    // --- Reload persistence ---
    await page.reload({ waitUntil: "networkidle" });
    await page.click('.tabs button:has-text("EMI")');
    await page.waitForSelector('.emi-row:has-text("E2E Coral")');
    check(
      "EMI: entry persisted across reload",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes("3,000"),
    );

    // Clean up so the suite is idempotent across runs — simulates foreclosing the loan.
    await clickMenuItem(page.locator(".emi-row", { hasText: "E2E Coral" }), "Delete");
    await page.waitForTimeout(400);
    check("EMI back to empty after cleanup (foreclosure)", (await page.locator(".emi-row").count()) === 0);

    // --- Subscriptions tab ---
    await page.click('.tabs button:has-text("Subscriptions")');
    check("Subscriptions tab selected", (await page.locator(".tabs button.selected").innerText()) === "Subscriptions");
    await page.waitForSelector(".subscriptions p.empty");
    check("Subscriptions starts empty", (await page.locator(".subscriptions p.empty").count()) === 1);

    await page.fill('.add-subscription-form input[placeholder="Netflix"]', "E2E Netflix");
    await page.fill('.add-subscription-form input[type="number"]', "649");
    // A deliberately stale, long-past anchor — proves the auto-advance logic
    // actually runs rather than just echoing back whatever was entered.
    await page.fill('.add-subscription-form input[type="date"]', "2020-01-15");
    await page.click('.add-subscription-form button:has-text("Add Subscription")');
    await page.waitForSelector('.subscription-row:has-text("E2E Netflix")');

    const subscriptionRowText = await page.locator(".subscription-row", { hasText: "E2E Netflix" }).innerText();
    check("Subscriptions: row shows the amount", subscriptionRowText.includes("649"));
    check(
      "Subscriptions: stale 2020 anchor auto-advances to a current renewal date",
      subscriptionRowText.includes("Renews") && !subscriptionRowText.includes("2020"),
    );
    check(
      "Subscriptions: Monthly Cost stat reflects the new entry",
      (await page.locator(".subscription-stat", { hasText: "Monthly Cost" }).innerText()).includes("649"),
    );

    // --- Edit a subscription ---
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 60);
    const futureDateStr = futureDate.toISOString().slice(0, 10);
    await clickMenuItem(page.locator(".subscription-row", { hasText: "E2E Netflix" }), "Edit");
    await page.waitForSelector(".row-editing");
    await page.locator('.subscription-edit-fields input[type="number"]').fill("699");
    await page.locator('.subscription-edit-fields input[type="date"]').fill(futureDateStr);
    await page.click('.row-editing button:has-text("Save")');
    await page.waitForTimeout(400);
    check(
      "Subscriptions: editing updates the amount",
      (await page.locator(".subscription-row", { hasText: "E2E Netflix" }).innerText()).includes("699"),
    );

    // --- Reload persistence ---
    await page.reload({ waitUntil: "networkidle" });
    await page.click('.tabs button:has-text("Subscriptions")');
    await page.waitForSelector('.subscription-row:has-text("E2E Netflix")');
    check(
      "Subscriptions: entry persisted across reload",
      (await page.locator(".subscription-row", { hasText: "E2E Netflix" }).innerText()).includes("699"),
    );

    // Clean up so the suite is idempotent across runs.
    await clickMenuItem(page.locator(".subscription-row", { hasText: "E2E Netflix" }), "Delete");
    await page.waitForTimeout(400);
    check("Subscriptions back to empty after cleanup", (await page.locator(".subscription-row").count()) === 0);

    // --- Credit Cards tab ---
    await page.click('.tabs button:has-text("Credit Cards")');
    check("Credit Cards tab selected", (await page.locator(".tabs button.selected").innerText()) === "Credit Cards");

    const ccMonthStr = String(monthIndex + 1).padStart(2, "0");
    const ccDueDateEarly = `${year}-${ccMonthStr}-07`;
    const ccDueDateLate = `${year}-${ccMonthStr}-22`;

    await page.click(".cards-add");
    await page.click(".cards-add");
    const cardRows = page.locator(".card-row-fields");
    await cardRows.nth(0).locator('input[type="text"]').fill("E2E Coral");
    await cardRows.nth(0).locator('input[type="number"]').nth(0).fill("5000");
    await cardRows.nth(0).locator('input[type="number"]').nth(1).fill("4990");
    await cardRows.nth(0).locator('input[type="date"]').fill(ccDueDateEarly);
    await cardRows.nth(1).locator('input[type="text"]').fill("E2E OneCard");
    await cardRows.nth(1).locator('input[type="number"]').nth(0).fill("3000");
    await cardRows.nth(1).locator('input[type="number"]').nth(1).fill("3050");
    await cardRows.nth(1).locator('input[type="date"]').fill(ccDueDateLate);

    await page.click('.cards-form button:has-text("Save")');
    await page.waitForSelector(".cards-stats");
    // Unlike a fresh page load, saving doesn't toggle the `loading` flag
    // (only `saving`), so `.loading-overlay` never actually appears here —
    // waiting for it to "detach" is a no-op, not a real wait for the
    // post-save stats refresh. A short fixed wait (same as the equivalent
    // Finances/Debts save-then-check flows) covers the local round-trip.
    await page.waitForTimeout(400);

    const monthStat = (text: string) => page.locator(".cards-month-stats .cards-stat", { hasText: text });
    const yearStat = (text: string) => page.locator(".cards-year-stats .cards-stat", { hasText: text });

    check(
      "Credit Cards: Total Due sums both cards",
      (await monthStat("Total Due").innerText()).includes("8,000"),
    );
    check(
      "Credit Cards: Total Paid sums both cards",
      (await monthStat("Total Paid").innerText()).includes("8,040"),
    );
    const earliestDueText = await monthStat("Earliest Due Date").innerText();
    check(
      "Credit Cards: Earliest Due Date picks the 7th over the 22nd",
      earliestDueText.includes("7") && !earliestDueText.includes("22"),
    );
    check(
      "Credit Cards: shows Overpaid when total paid exceeds total due",
      (await monthStat("Overpaid").count()) === 1,
    );

    // Only this seeded month has data, so the yearly totals should equal it.
    check(
      "Credit Cards: yearly total spent matches the one seeded month",
      (await yearStat("Total Spent This Year").innerText()).includes("8,000"),
    );
    check(
      "Credit Cards: yearly total paid matches the one seeded month",
      (await yearStat("Total Paid This Year").innerText()).includes("8,040"),
    );
    check(
      "Credit Cards: yearly net shows Overpaid when paid exceeds due for the year",
      (await yearStat("Net Overpaid This Year").count()) === 1,
    );

    // --- Reload persistence ---
    await page.reload({ waitUntil: "networkidle" });
    await page.click('.tabs button:has-text("Credit Cards")');
    await page.waitForSelector(".cards-stats");
    await page.waitForSelector(".loading-overlay", { state: "detached" });
    check("Credit Cards: entries persisted across reload", (await page.locator(".card-row-fields").count()) === 2);

    // Clean up so the suite is idempotent across runs.
    await page.click(".cards-remove >> nth=0");
    await page.click(".cards-remove >> nth=0");
    await page.click('.cards-form button:has-text("Save")');
    await page.waitForTimeout(400);
    check("Credit Cards back to empty after cleanup", (await page.locator(".card-row-fields").count()) === 0);

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
