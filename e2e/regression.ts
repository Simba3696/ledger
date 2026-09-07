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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Same minimal .env reader as scripts/kill-ports.js, for the same reason:
// this checkout's server/.env / client/.env may override the default dev
// ports (e.g. to run alongside another checkout without colliding) — the
// dev server this script spawns picks that up automatically via its own
// dotenv/vite loading, so this script must read the same values itself or
// it'll wait on the wrong port forever (or worse, silently fall back to
// whatever's actually on 4000, which could be a *different* checkout's
// live server entirely).
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

const results: { label: string; ok: boolean }[] = [];
function check(label: string, ok: boolean) {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
}

// `Date.toISOString()` is UTC — near midnight IST (UTC+5:30), it can report
// the *previous* calendar day relative to the server's real local "today"
// (e.g. 1am IST is still 7:30pm the day before in UTC), silently landing a
// "due today" test fixture one day in the past. Every date string used to
// fill a real `<input type="date">` in this file must go through local
// getFullYear/getMonth/getDate instead, never toISOString().
function toLocalDateStr(d: Date): string {
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

async function main() {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-e2e-"));
  console.log("Scratch data dir:", scratchDir);

  // fixtures.js transitively reads DB_DIR (via categoryColors.ts's
  // categories.json read-or-create) — set this script's own LEDGER_DB_DIR
  // and import fixtures.js dynamically *after*, so buildFixtureWorkbook's
  // categories.json write lands in the scratch dir the spawned server below
  // also uses, not the real repo db/ folder (a static top-level import would
  // have resolved DB_DIR before scratchDir even existed).
  process.env.LEDGER_DB_DIR = scratchDir;
  const { buildFixtureWorkbook } = await import("../server/test/fixtures.js");
  const { DEFAULT_CATEGORIES } = await import("../server/src/excel/categoryColors.js");
  // Reused (not reimplemented) for the EMI Duration test below — computing
  // "10 months from today" independently here risks silently drifting from
  // addMonths' actual clamp-at-month-end behavior on an edge-case day.
  const { addMonths, startOfDay, formatDate } = await import("../server/src/excel/dateMath.js");
  const { dueDateOnOrAfter } = await import("../server/src/excel/emi.js");

  // Seed a custom 5th category alongside the defaults — proves
  // categories.json actually drives the running app end to end, not just
  // that the shipped defaults still work (every other check in this file
  // only ever exercises those). fg is deliberately omitted so this also
  // exercises the server's auto-derivation path for a category that doesn't
  // specify one, not just the explicit-fg default entries.
  fs.writeFileSync(
    path.join(scratchDir, "categories.json"),
    JSON.stringify([...DEFAULT_CATEGORIES, { id: "health", label: "Health", bg: "#8B5CF6" }]),
  );

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
    await waitForServer(`http://localhost:${SERVER_PORT}/api/categories`, 30000);
    await waitForServer(`http://localhost:${CLIENT_PORT}`, 30000);

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

    await page.goto(`http://localhost:${CLIENT_PORT}`, { waitUntil: "networkidle" });
    await waitForDashboardData();

    // --- Dashboard defaults + click-through navigation ---
    check("Default tab is Dashboard", (await page.locator(".tabs button.selected").innerText()) === "Dashboard");
    check(
      "Upcoming EMIs chart shows the empty state when there are no active EMIs",
      (await page.locator(".emi-projection .empty").count()) === 1,
    );

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
    // The Dashboard Overview widget (net worth + upcoming) sits above the
    // chart now, pushing it below the fold at the default viewport height —
    // page.mouse.move has no auto-scroll (unlike .click()), so without this
    // the hover lands off-screen and never actually reaches the chart.
    await page.locator(".chart-wrap").scrollIntoViewIfNeeded();
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

    // --- Custom category (configurable categories) ---
    // Proves categories.json actually drives the UI end to end, not just
    // that the default 4 still work (every other check in this file only
    // ever exercises the shipped defaults, which would keep passing even if
    // the whole config-loading mechanism were silently broken).
    // #8B5CF6 == rgb(139, 92, 246) — checked via computed style rather than
    // the raw style attribute string, since Chromium normalizes an inline
    // hex color to rgb(...) when it reflects the attribute back, so a
    // substring match against "#8b5cf6" never matches even when correct.
    const HEALTH_BG = "rgb(139, 92, 246)";
    check(
      "Custom category chip renders with its configured color",
      (await page.locator('button.category-chip:has-text("Health")').evaluate((el) => getComputedStyle(el).backgroundColor)) ===
        HEALTH_BG,
    );
    const beforeCustomCount = await page.locator(".entry-row").count();
    await page.fill('input[type="number"]', "15");
    await page.fill('input[type="text"]', "E2E Custom Category Entry");
    await page.click('button.category-chip:has-text("Health")');
    await page.click('button.submit-btn:has-text("Add Expense")');
    await page.waitForSelector("text=E2E Custom Category Entry");
    check(
      "Custom category entry saved and rendered with its configured color",
      (await page
        .locator('.entry-row:has-text("E2E Custom Category Entry")')
        .evaluate((el) => getComputedStyle(el).backgroundColor)) === HEALTH_BG &&
        (await page.locator(".entry-row").count()) === beforeCustomCount + 1,
    );

    await page.click('.tabs button:has-text("Dashboard")');
    await waitForDashboardData();
    check(
      "Dashboard renders a mini-chart for the custom category",
      (await page.locator('.category-chart:has-text("Health")').count()) === 1,
    );

    // Clean up (via the same chart click-through Expenses always requires)
    // so row-count assumptions in the rest of this file, which predate this
    // section, still hold.
    await clickChartMonth(monthIndex);
    await page.waitForSelector(".add-expense-form");
    await clickMenuItem(page.locator(".entry-row", { hasText: "E2E Custom Category Entry" }), "Delete");
    await page.waitForTimeout(400);
    check("Custom category entry cleaned up", (await page.locator(".entry-row").count()) === beforeCustomCount);

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
    // Grabs the handle specifically (not the row) — reordering is now driven
    // by pointer events off the handle so it also works via touch on mobile.
    const src = page.locator(".entry-row", { hasText: "E2E Cash Entry Edited" }).locator(".drag-handle");
    const dst = page.locator(".entry-row", { hasText: "E2E Card Entry" });
    await src.dragTo(dst);
    await page.waitForTimeout(500);
    const namesAfterDrag = await page.locator(".entry-remarks").allInnerTexts();
    check(
      "Drag reorder changed row order",
      namesAfterDrag.indexOf("E2E Cash Entry Edited") !== -1 && namesAfterDrag.indexOf("E2E Card Entry") !== -1,
    );

    // --- Move up / Move down via the overflow menu — the keyboard/no-touch
    // fallback for reordering, since the drag handle is aria-hidden and
    // pointer-only. "E2E Card Entry" is the newest/topmost entry at this
    // point (the drag above moved it there), so Move up is correctly
    // disabled for it — start with Move down instead, then reverse with
    // Move up, and check the display order actually changed each time. ---
    const namesBeforeMenuMove = await page.locator(".entry-remarks").allInnerTexts();
    await clickMenuItem(page.locator(".entry-row", { hasText: "E2E Card Entry" }), "Move down");
    await page.waitForTimeout(400);
    const namesAfterMoveDown = await page.locator(".entry-remarks").allInnerTexts();
    check("Move down (menu) changed row order", namesAfterMoveDown.join(",") !== namesBeforeMenuMove.join(","));

    await clickMenuItem(page.locator(".entry-row", { hasText: "E2E Card Entry" }), "Move up");
    await page.waitForTimeout(400);
    const namesAfterMoveUp = await page.locator(".entry-remarks").allInnerTexts();
    check("Move up (menu) reverses Move down", namesAfterMoveUp.join(",") === namesBeforeMenuMove.join(","));

    // --- Month locking (replaces the old "only the current calendar month
    // is editable" auto-lock rule — nothing auto-locks on the 1st anymore,
    // locking is an explicit per-month choice backed by real Excel sheet
    // protection on the server, not just a UI convenience). ---
    check(
      "A never-locked month shows the unlocked banner by default",
      (await page.locator(".month-lock-status").innerText()).includes("is unlocked"),
    );
    check(
      // Checked on an actual input, not the submit button (also disabled
      // whenever the form is simply empty/invalid, which it is here, so
      // that alone wouldn't distinguish "disabled because locked" from
      // "disabled because empty") or the <fieldset> itself (confirmed via
      // real DOM inspection to correctly carry disabled="" when locked, but
      // Playwright's isDisabled() only recognizes actual form controls like
      // <input>, not a bare <fieldset>, so checking it directly always
      // reports false regardless of the real attribute).
      "Add Expense form is enabled while unlocked",
      !(await page.locator('.add-expense-form input[type="text"]').isDisabled()),
    );

    await page.click(".month-lock-toggle"); // Lock this month
    // Locking is 3 sequential round-trips under the hood (PUT lock, then
    // GET lock + GET month entries to refresh) — waiting for the button's
    // own label to actually flip is a real completion signal, unlike a
    // fixed delay that assumes all three finish inside some guessed window.
    await page.locator(".month-lock-toggle", { hasText: "Unlock" }).waitFor({ timeout: 5000 });
    check(
      "Locking the month updates the banner and button label",
      (await page.locator(".month-lock-status").innerText()).includes("is locked") &&
        (await page.locator(".month-lock-toggle").innerText()) === "Unlock",
    );
    check(
      "Add Expense form is disabled once the month is locked",
      await page.locator('.add-expense-form input[type="text"]').isDisabled(),
    );
    check(
      "Existing entries lose their drag handle and overflow menu once the month is locked",
      (await page.locator(".entry-row .drag-handle").count()) === 0 &&
        (await page.locator(".entry-row .overflow-menu").count()) === 0,
    );

    // Real server-side enforcement, not just a hidden UI control — a direct
    // API call against the locked month must also be rejected.
    const lockedWriteStatus = await page.evaluate(
      async ({ y, m }) => {
        const res = await fetch("/api/entries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ year: y, month: m, amount: 1, remarks: "should be blocked", category: "food", isCard: false }),
        });
        return res.status;
      },
      { y: year, m: monthIndex + 1 },
    );
    check("Locked month rejects a direct API write with 403, not just the UI", lockedWriteStatus === 403);
    // That 403 is expected (it's the whole point of the check above) — the
    // browser logs the failed fetch as a console error regardless, so filter
    // this one known-expected occurrence out rather than let it fail the "no
    // console errors" check at the end (same reasoning as the next-year 404
    // filtered below).
    const expected403 = consoleErrors.findIndex((e) => e.includes("403"));
    if (expected403 !== -1) consoleErrors.splice(expected403, 1);

    await page.click(".month-lock-toggle"); // Unlock again
    await page.locator(".month-lock-toggle", { hasText: "Lock this month" }).waitFor({ timeout: 5000 });
    check(
      "Unlocking restores the unlocked banner, re-enables the form, and restores entry controls",
      (await page.locator(".month-lock-status").innerText()).includes("is unlocked") &&
        !(await page.locator('.add-expense-form input[type="text"]').isDisabled()) &&
        (await page.locator(".entry-row .overflow-menu").count()) > 0,
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

    check(
      "Finance: Save button disables once there's nothing new to save",
      await page.locator(".income-form button.submit-btn").isDisabled(),
    );
    await incomeInputs.nth(0).fill("50001");
    check(
      "Finance: Save button re-enables after an edit",
      !(await page.locator(".income-form button.submit-btn").isDisabled()),
    );
    await incomeInputs.nth(0).fill("50000"); // revert to the saved value for the checks below

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

    // --- Duplicate-name consolidate-or-new prompt (self-contained: adds and
    // fully cleans up its own throwaway entries before the rest of this
    // suite's Debts flow, which assumes starting from an empty list) ---
    await fillDebtForm("E2E Duplicate", "1000");
    // Different case on the second entry to also exercise case-insensitive
    // matching. The global dialog handler above accepts by default, so this
    // exercises the *consolidate* path — the row keeps the original entry's
    // name/casing, so wait on the merged amount rather than the typed name.
    await page.fill('.add-debt-form input[type="text"]', "e2e duplicate");
    await page.fill('.add-debt-form input[type="number"]', "500");
    await page.click('.add-debt-form button:has-text("Add Debt")');
    await page.waitForTimeout(400);
    check(
      "Duplicate debt name (dialog accepted) consolidates into one row",
      (await page.locator(".debt-row", { hasText: "E2E Duplicate" }).count()) === 1 &&
        (await page.locator(".debt-row", { hasText: "E2E Duplicate" }).innerText()).includes("1,500"),
    );

    // Swap to a one-shot dismiss handler to exercise the "separate entry" path.
    page.removeAllListeners("dialog");
    page.once("dialog", (d) => d.dismiss());
    await page.fill('.add-debt-form input[type="text"]', "E2E Duplicate");
    await page.fill('.add-debt-form input[type="number"]', "200");
    await page.click('.add-debt-form button:has-text("Add Debt")');
    await page.waitForTimeout(400);
    page.on("dialog", (d) => d.accept()); // restore the default accept-everything handler
    check(
      "Duplicate debt name (dialog dismissed) adds a separate entry instead",
      (await page.locator(".debt-row", { hasText: "E2E Duplicate" }).count()) === 2,
    );

    const dupeRows = page.locator(".debt-row", { hasText: "E2E Duplicate" });
    while ((await dupeRows.count()) > 0) {
      await clickMenuItem(dupeRows.first(), "Delete");
      await page.waitForTimeout(400);
    }
    check("Debts back to empty after duplicate-name cleanup", (await page.locator(".debt-row").count()) === 0);

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
    check(
      "EMI: Current Balance auto-defaults to Total Amount for a fresh loan",
      (await emiNumberInputs.nth(3).inputValue()) === "12000",
    );

    // Duration is a real bank-stated fact now (not a Current-Balance
    // calculator) — entering it must not touch Current Balance at all.
    await emiNumberInputs.nth(4).fill("10");
    check(
      "EMI: Duration does not overwrite Current Balance",
      (await emiNumberInputs.nth(3).inputValue()) === "12000",
    );
    await emiNumberInputs.nth(5).fill("10.5"); // Interest Rate (% p.a.), optional
    await emiNumberInputs.nth(6).fill("0"); // Foreclosure Charge (%), optional

    // ceil(12000/1000) = 12 future due dates would be the *derived* estimate
    // — but Duration says this one actually finishes in 10 months, so the
    // saved entry should show that instead, not the derived 12-months-out one.
    // Computed via the real addMonths + dueDateOnOrAfter (not a hand-rolled
    // equivalent) so this can't silently drift from the server's own
    // clamp-at-month-end / roll-to-next-month-due-date behavior — the target
    // date's day-of-month (today's) has nothing to do with dueDay (15), so
    // depending on what day today is, the real finish date may or may not
    // land in the same month as a naive addMonths-only calculation would.
    const untilTargetDate = addMonths(startOfDay(new Date()), 10);
    const expectedFinishDateObj = dueDateOnOrAfter(untilTargetDate, 15); // dueDay set below
    const expectedFinishDate = formatDate(expectedFinishDateObj);
    const expectedFinishDateText = new Date(`${expectedFinishDate}T00:00:00`).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const expectedFinishes = expectedFinishDateObj.toLocaleDateString("en-IN", { month: "short", year: "numeric" });

    await page.fill('.add-emi-form input[placeholder="Optional"]', "E2E Loan");
    await page.click('.add-emi-form button:has-text("Add EMI")');
    await page.waitForSelector('.emi-row:has-text("E2E Coral")');

    check(
      "EMI: row shows remaining equal to total for a fresh loan",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes("12,000"),
    );
    check(
      "EMI: row shows the entered interest rate",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes("10.5% p.a."),
    );
    check(
      // 0% is a meaningful, distinct value here (e.g. a real CRED/IDFC FIRST
      // loan with no foreclosure fee) — must render, not be treated as blank.
      "EMI: row shows the entered foreclosure charge, including a real 0%",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes("0% foreclosure fee"),
    );
    const todayDateText = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    check(
      "EMI: shows Balance as of today's date for a freshly added loan",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes(`Balance as of ${todayDateText}`),
    );
    check(
      "EMI: Duration overrides the derived payoff estimate",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes(expectedFinishes),
    );
    check(
      "EMI: Total Remaining stat reflects the new entry",
      (await page.locator(".emi-stat", { hasText: "Total Remaining" }).innerText()).includes("12,000"),
    );
    check(
      "EMI: Total Monthly EMI stat reflects the new entry",
      (await page.locator(".emi-stat", { hasText: "Total Monthly EMI" }).innerText()).includes("1,000"),
    );
    check(
      "EMI: Active Loans stat is 1",
      (await page.locator(".emi-stat", { hasText: "Active Loans" }).innerText()).includes("1"),
    );
    check(
      "EMI: EMI-Free On stat shows this loan's exact finish date",
      (await page.locator(".emi-stat", { hasText: "EMI-Free On" }).innerText()).includes(expectedFinishDateText),
    );

    // --- Edit an EMI entry (correcting drift in the current balance) ---
    await clickMenuItem(page.locator(".emi-row", { hasText: "E2E Coral" }), "Edit");
    await page.waitForSelector(".row-editing");
    const editNumberInputs = page.locator(".emi-edit-fields input[type=\"number\"]");
    check(
      "EMI: edit form pre-fills the existing interest rate",
      (await editNumberInputs.nth(5).inputValue()) === "10.5",
    );
    check(
      "EMI: edit form pre-fills the existing foreclosure charge, including a real 0%",
      (await editNumberInputs.nth(6).inputValue()) === "0",
    );
    await editNumberInputs.nth(3).fill("3000"); // Current Balance
    await page.click('.row-editing button:has-text("Save")');
    await page.waitForTimeout(400);
    check(
      "EMI: editing updates the current balance",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes("3,000"),
    );
    check(
      "EMI: editing without a fresh Duration preserves the existing until-target",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes(expectedFinishes),
    );
    check(
      // Interest Rate is a plain overwritable field, not a "sticky unless
      // resupplied" one like Duration — but the edit form pre-fills it from
      // the current value, so leaving that pre-filled value untouched (as
      // this edit does) still correctly keeps it, not clears it.
      "EMI: editing without touching Interest Rate keeps it",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes("10.5% p.a."),
    );
    check(
      "EMI: editing without touching Foreclosure Charge keeps it",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes("0% foreclosure fee"),
    );

    // Foreclosure payoff: with a real 10.5% interest rate on record, the true
    // early-payoff cost (outstanding principal) must show up as its own line,
    // distinct from — and less than — `remaining` (₹3,000), which still
    // includes interest that hasn't accrued yet.
    const coralForeclosurePayoffText = await page
      .locator(".emi-row", { hasText: "E2E Coral" })
      .locator(".emi-foreclosure-payoff")
      .innerText();
    const coralForeclosurePayoffAmount = Number(coralForeclosurePayoffText.replace(/[^0-9.]/g, ""));
    check(
      "EMI: row shows a foreclosure payoff distinct from (and less than) remaining, when an interest rate is on record",
      coralForeclosurePayoffAmount > 0 && coralForeclosurePayoffAmount < 3000,
    );

    // Interest Rate genuinely is clearable, though — an explicit blank on a
    // later edit removes it rather than leaving the old value stuck forever.
    await clickMenuItem(page.locator(".emi-row", { hasText: "E2E Coral" }), "Edit");
    await page.waitForSelector(".row-editing");
    await page.locator(".emi-edit-fields input[type=\"number\"]").nth(5).fill("");
    await page.locator(".emi-edit-fields input[type=\"number\"]").nth(6).fill("");
    await page.click('.row-editing button:has-text("Save")');
    await page.waitForTimeout(400);
    check(
      "EMI: clearing Interest Rate on an edit removes it from the row",
      !(await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes("p.a."),
    );
    check(
      "EMI: clearing Foreclosure Charge on an edit removes it from the row",
      !(await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes("foreclosure fee"),
    );
    check(
      "EMI: clearing Interest Rate also removes the foreclosure payoff line (it's equal to remaining again)",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).locator(".emi-foreclosure-payoff").count()) === 0,
    );

    // --- Reload persistence ---
    await page.reload({ waitUntil: "networkidle" });
    await page.click('.tabs button:has-text("EMI")');
    await page.waitForSelector('.emi-row:has-text("E2E Coral")');
    check(
      "EMI: entry persisted across reload",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).innerText()).includes("3,000"),
    );

    // --- Payment quick-actions (both anchor to the due date, not "now", so
    // back-to-back payments within the same cycle correctly accumulate
    // rather than double-counting — see recordEmiPayment in emi.ts). Scoped
    // to .emi-remaining specifically (not the whole row) and matched with the
    // ₹ prefix — the row's Total Amount (₹12,000.00) contains "2,000" as a
    // bare substring, and the EMI-amount-per-month text always reads
    // "₹1,000.00" regardless of the actual balance, so a looser match here
    // would pass even if the payment logic were broken. ---
    const coralRemaining = () => page.locator(".emi-row", { hasText: "E2E Coral" }).locator(".emi-remaining");
    const coralAsOf = () => page.locator(".emi-row", { hasText: "E2E Coral" }).locator(".emi-as-of");

    const asOfBeforePayment = await coralAsOf().innerText();
    await clickMenuItem(page.locator(".emi-row", { hasText: "E2E Coral" }), "Paid this month");
    await page.waitForTimeout(400);
    check(
      "EMI: \"Paid this month\" subtracts one EMI amount",
      (await coralRemaining().innerText()).includes("₹2,000"),
    );
    check(
      // Exact resulting date depends on recordEmiPayment's own settle-date
      // logic (already covered by server unit tests) — this just confirms
      // the displayed anchor actually reacts to a payment, not a fixed date.
      "EMI: \"Paid this month\" advances the Balance-as-of anchor",
      (await coralAsOf().innerText()) !== asOfBeforePayment,
    );
    check(
      // 10,000 paid of 12,000 total = 83.33% -> "83% paid".
      "EMI: shows the foreclosure-hint percent-paid progress for the loan",
      (await page.locator(".emi-row", { hasText: "E2E Coral" }).locator(".emi-progress-label").innerText()) === "83% paid",
    );

    // The global dialog handler accepts every prompt with an *empty* string
    // (Playwright's dialog.accept() with no argument does not resubmit the
    // prompt's own default value) — this exercises a real bug found via this
    // exact test: Number("") is 0, so without an explicit blank-input guard,
    // this would have silently recorded a "paid ₹0" instead of a no-op.
    await clickMenuItem(page.locator(".emi-row", { hasText: "E2E Coral" }), "Record payment…");
    await page.waitForTimeout(400);
    check(
      "EMI: \"Record payment\" treats a blank prompt as cancelled, not as a ₹0 payment",
      (await coralRemaining().innerText()).includes("₹2,000"),
    );

    // --- Sorting (E2E Coral: ₹2,000 remaining/₹1,000 EMI; E2E Amber: fresh ₹500 EMI, ₹2,000 remaining) ---
    await page.fill('.add-emi-form input[placeholder="Who\'s it with?"]', "E2E Amber");
    await emiNumberInputs.nth(0).fill("500"); // EMI Amount
    await emiNumberInputs.nth(1).fill("5"); // Due Day
    await emiNumberInputs.nth(2).fill("2000"); // Total Amount
    await page.click('.add-emi-form button:has-text("Add EMI")');
    await page.waitForSelector('.emi-row:has-text("E2E Amber")');

    // Amber (fresh ₹2,000/₹500 loan, due the 5th) finishes in only ~4 months —
    // well before Coral's 10-month target — so EMI-Free On, the *latest*
    // across all active loans, must stay on Coral's date, not jump to
    // Amber's sooner one just because it was added more recently.
    check(
      "EMI: EMI-Free On stays on the later loan's date after adding an earlier-finishing one",
      (await page.locator(".emi-stat", { hasText: "EMI-Free On" }).innerText()).includes(expectedFinishDateText),
    );

    async function emiNames(): Promise<string[]> {
      return page.locator(".emi-card").allInnerTexts();
    }
    await page.click('.emi-sort button:has-text("EMI Amount")'); // ascending: lowest first
    const emiAmountAsc = await emiNames();
    check(
      "Sorting by EMI Amount ascending puts the ₹500/mo entry first",
      emiAmountAsc.indexOf("E2E Amber") < emiAmountAsc.indexOf("E2E Coral"),
    );
    await page.click('.emi-sort button:has-text("EMI Amount")'); // descending: highest first
    const emiAmountDesc = await emiNames();
    check(
      "Sorting by EMI Amount descending puts the ₹1,000/mo entry first",
      emiAmountDesc.indexOf("E2E Coral") < emiAmountDesc.indexOf("E2E Amber"),
    );

    // % Paid (foreclosure hint): Coral is 83% paid, Amber is a fresh 0% —
    // sorting by this (not the raw remaining amount, which happens to be
    // equal for both right now) is what actually distinguishes them.
    await page.click('.emi-sort button:has-text("% Paid")'); // ascending: least paid first
    const percentPaidAsc = await emiNames();
    check(
      "Sorting by % Paid ascending puts the fresh 0%-paid entry first",
      percentPaidAsc.indexOf("E2E Amber") < percentPaidAsc.indexOf("E2E Coral"),
    );
    await page.click('.emi-sort button:has-text("% Paid")'); // descending: most paid first
    const percentPaidDesc = await emiNames();
    check(
      "Sorting by % Paid descending puts the 83%-paid entry first",
      percentPaidDesc.indexOf("E2E Coral") < percentPaidDesc.indexOf("E2E Amber"),
    );

    await page.click('.emi-sort button:has-text("Name")'); // back to default for the rest of the flow
    await page.waitForTimeout(200);

    // Clean up so the suite is idempotent across runs — via the real
    // "Foreclose EMI" action (matches the user's actual workflow: once a
    // loan is fully paid off, it comes off the list entirely).
    await clickMenuItem(page.locator(".emi-row", { hasText: "E2E Amber" }), "Foreclose EMI");
    await page.waitForTimeout(400);
    await clickMenuItem(page.locator(".emi-row", { hasText: "E2E Coral" }), "Foreclose EMI");
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
    const futureDateStr = toLocalDateStr(futureDate);
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

    // --- Sorting (E2E Netflix: ₹699, renews in 60 days; E2E Spotify: ₹199, renews in 10 days) ---
    const soonDate = new Date();
    soonDate.setDate(soonDate.getDate() + 10);
    await page.fill('.add-subscription-form input[placeholder="Netflix"]', "E2E Spotify");
    await page.fill('.add-subscription-form input[type="number"]', "199");
    await page.fill('.add-subscription-form input[type="date"]', toLocalDateStr(soonDate));
    await page.click('.add-subscription-form button:has-text("Add Subscription")');
    await page.waitForSelector('.subscription-row:has-text("E2E Spotify")');

    async function subscriptionNames(): Promise<string[]> {
      return page.locator(".subscription-service").allInnerTexts();
    }
    check(
      "Sorting by Next Renewal (the default) puts the sooner-renewing entry first",
      (await subscriptionNames()).indexOf("E2E Spotify") < (await subscriptionNames()).indexOf("E2E Netflix"),
    );

    await page.click('.subscriptions-sort button:has-text("Amount")'); // ascending: lowest first
    const subAmountAsc = await subscriptionNames();
    check(
      "Sorting by Amount ascending puts the ₹199 entry first",
      subAmountAsc.indexOf("E2E Spotify") < subAmountAsc.indexOf("E2E Netflix"),
    );
    await page.click('.subscriptions-sort button:has-text("Amount")'); // descending: highest first
    const subAmountDesc = await subscriptionNames();
    check(
      "Sorting by Amount descending puts the ₹699 entry first",
      subAmountDesc.indexOf("E2E Netflix") < subAmountDesc.indexOf("E2E Spotify"),
    );
    await page.click('.subscriptions-sort button:has-text("Next Renewal")'); // back to default for cleanup
    await page.waitForTimeout(200);

    // Clean up so the suite is idempotent across runs.
    await clickMenuItem(page.locator(".subscription-row", { hasText: "E2E Spotify" }), "Delete");
    await page.waitForTimeout(400);
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

    check(
      "Credit Cards: Save button disables once there's nothing new to save",
      await page.locator('.cards-form button:has-text("Save")').isDisabled(),
    );
    await cardRows.nth(0).locator('input[type="number"]').nth(1).fill("4991");
    check(
      "Credit Cards: Save button re-enables after an edit",
      !(await page.locator('.cards-form button:has-text("Save")').isDisabled()),
    );
    await cardRows.nth(0).locator('input[type="number"]').nth(1).fill("4990"); // revert to the saved value

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

    // --- Saved/Overpaid only counts a card once it's marked Settled ---
    // Neither card is settled yet, even though OneCard (paid 3050 against a
    // 3000 due) has a real -50 gap — a naive totalDue-totalPaid over every
    // card would already show Overpaid ₹40 here, but an in-progress bill
    // shouldn't move this figure until it's actually checked off.
    check(
      "Credit Cards: Saved/Overpaid stays ₹0 while no card is marked Settled",
      (await monthStat("Overpaid").count()) === 0 && (await monthStat("Saved").innerText()).includes("0.00"),
    );
    // The yearly figure must agree with the month figure right above it —
    // summing every month's own (settled-only) overpaidOrSaved, not a naive
    // yearTotalDue - yearTotalPaid across every card regardless of Settled,
    // which would already show "Overpaid ₹40" here from OneCard's raw gap
    // even though nothing is settled yet.
    check(
      "Credit Cards: yearly Overpaid/Saved also stays ₹0 while no card is marked Settled",
      (await yearStat("Net Overpaid This Year").count()) === 0 &&
        (await yearStat("Net Saved This Year").innerText()).includes("0.00"),
    );

    await cardRows.nth(0).locator('input[type="checkbox"]').check(); // settle E2E Coral
    await cardRows.nth(1).locator('input[type="checkbox"]').check(); // settle E2E OneCard
    await page.click('.cards-form button:has-text("Save")');
    await page.waitForTimeout(400);

    check(
      "Credit Cards: shows Overpaid once total paid exceeds total due among settled cards",
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

    // --- Drag reorder (lets you add a card first, sort it out later) ---
    // Grabs the handle specifically (not the row) — same pointer-events-based
    // approach as RecentEntries' drag handle, so it also works via touch.
    async function cardNames(): Promise<string[]> {
      return page
        .locator('.card-row-fields input[type="text"]')
        .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
    }
    check("Credit Cards: initial order is Coral then OneCard", (await cardNames()).join(",") === "E2E Coral,E2E OneCard");

    // `.card-row-fields` holds only <input> fields, not text nodes — a card's
    // name lives in an input's `value`, which Playwright's `hasText` (it
    // matches rendered text content, not form-control values) can never see.
    // Filter by the attribute instead of the row's (nonexistent) visible text.
    const ccRowByName = (name: string) =>
      page.locator(".card-row-fields").filter({ has: page.locator(`input[type="text"][value="${name}"]`) });
    const ccSrc = ccRowByName("E2E Coral").locator(".cards-drag-handle");
    const ccDst = ccRowByName("E2E OneCard");
    await ccSrc.dragTo(ccDst);
    await page.waitForTimeout(400);
    check("Credit Cards: drag reorder changed row order", (await cardNames()).join(",") === "E2E OneCard,E2E Coral");
    check(
      "Credit Cards: Save button re-enables after a drag reorder",
      !(await page.locator('.cards-form button:has-text("Save")').isDisabled()),
    );
    await page.click('.cards-form button:has-text("Save")');
    await page.waitForTimeout(400);

    // --- Reload persistence of the new order ---
    await page.reload({ waitUntil: "networkidle" });
    await page.click('.tabs button:has-text("Credit Cards")');
    await page.waitForSelector(".loading-overlay", { state: "detached" });
    check(
      "Credit Cards: reordered row order persisted across reload",
      (await cardNames()).join(",") === "E2E OneCard,E2E Coral",
    );

    // Clean up so the suite is idempotent across runs.
    await page.click(".cards-remove >> nth=0");
    await page.click(".cards-remove >> nth=0");
    await page.click('.cards-form button:has-text("Save")');
    await page.waitForTimeout(400);
    check("Credit Cards back to empty after cleanup", (await page.locator(".card-row-fields").count()) === 0);

    // --- Dashboard Overview widget (net worth + upcoming) ---
    // Current Savings (₹2,00,000, from the Finances section above) is
    // already on record and untouched by any section since — add a fresh
    // debt, EMI, and credit card bill (all due soon, so they land in the
    // 14-day upcoming window) to prove the widget actually combines figures
    // from every module, not just echoes one of them.
    await page.click('.tabs button:has-text("Debts")');
    await page.waitForSelector(".add-debt-form");
    await fillDebtForm("E2E Overview Debt", "5000");

    // Due day deliberately 2 days out, not today's exact day-of-month: a due
    // date equal to the snapshot day is genuinely ambiguous for a *freshly
    // added* entry (has this cycle been paid or not? unlike after an actual
    // "Paid this month" click, where the answer is unambiguously yes) —
    // computed via real Date arithmetic (not a plain +2 on the day number)
    // so it stays correct across a month boundary.
    const overviewDueDate = new Date();
    overviewDueDate.setDate(overviewDueDate.getDate() + 2);

    await page.click('.tabs button:has-text("EMI")');
    await page.waitForSelector(".add-emi-form");
    await page.fill('.add-emi-form input[placeholder="Who\'s it with?"]', "E2E Overview EMI");
    const overviewEmiInputs = page.locator('.add-emi-form input[type="number"]');
    await overviewEmiInputs.nth(0).fill("1000"); // EMI Amount
    await overviewEmiInputs.nth(1).fill(String(overviewDueDate.getDate())); // Due Day = 2 days out
    await overviewEmiInputs.nth(2).fill("5000"); // Total Amount
    await page.click('.add-emi-form button:has-text("Add EMI")');
    await page.waitForSelector('.emi-row:has-text("E2E Overview EMI")');

    await page.click('.tabs button:has-text("Credit Cards")');
    await page.waitForSelector(".cards-form");
    await page.click(".cards-add");
    const overviewCardRow = page.locator(".card-row-fields").last();
    await overviewCardRow.locator('input[type="text"]').fill("E2E Overview Card");
    await overviewCardRow.locator('input[type="number"]').nth(0).fill("3000"); // due
    await overviewCardRow.locator('input[type="number"]').nth(1).fill("1000"); // paid
    await overviewCardRow.locator('input[type="date"]').fill(toLocalDateStr(new Date()));
    await page.click('.cards-form button:has-text("Save")');
    await page.waitForTimeout(400);

    await page.click('.tabs button:has-text("Dashboard")');
    await waitForDashboardData();
    await page.waitForTimeout(400); // the overview fetch is separate from the yearly chart's own loading state

    check(
      "Dashboard Overview: Net Worth combines savings, debt, EMI, and credit card",
      (await page.locator(".overview-stat-headline strong").innerText()).includes("1,88,000"),
    );
    check(
      "Dashboard Overview: upcoming list shows the EMI due soon",
      (await page.locator(".upcoming-item", { hasText: "E2E Overview EMI" }).count()) === 1,
    );
    check(
      "Dashboard Overview: upcoming list shows the credit card due today",
      (await page.locator(".upcoming-item", { hasText: "E2E Overview Card" }).count()) === 1,
    );
    check(
      // EMI 1000 + card outstanding (3000 due - 1000 paid = 2000) = 3000
      "Dashboard Overview: Upcoming header shows the total across all items",
      (await page.locator(".upcoming-total").innerText()).includes("3,000"),
    );
    check(
      "Upcoming EMIs chart renders bars once an active EMI exists",
      (await page.locator(".emi-projection-chart-wrap .recharts-rectangle").count()) > 0,
    );
    check(
      "Upcoming EMIs chart legend shows both series",
      (await page.locator(".emi-projection").innerText()).includes("EMI Amount") &&
        (await page.locator(".emi-projection").innerText()).includes("Number of EMIs"),
    );

    // Below 600px, the header swaps to a shorter "Upcoming" label so it
    // doesn't crowd/wrap against the total sharing the same row.
    await page.setViewportSize({ width: 420, height: 800 });
    check(
      "Dashboard Overview: Upcoming header shortens on a narrow viewport",
      (await page.locator(".upcoming-toggle h3").innerText()) === "Upcoming",
    );

    // Same breakpoint: "Credit Cards"/"Subscriptions" shorten to "CC
    // Bills"/"Subs" and the nav's gap tightens, together fitting all six
    // tabs on one row instead of the last one wrapping to a second line.
    const navTabTops = await page.locator(".tabs button").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
    check(
      "Nav bar: all six tabs fit on one row on a narrow viewport",
      new Set(navTabTops).size === 1,
    );
    // Both label spans are always in the DOM (CSS just hides one), so a
    // `:has-text()` match alone can't tell visible text from hidden text —
    // .innerText() does respect display:none, unlike raw textContent.
    // Nav order is Dashboard/Credit Cards/Debts/EMI/Subscriptions/Finances.
    const navButtons = page.locator(".tabs button");
    check(
      "Nav bar: Credit Cards/Subscriptions shorten on a narrow viewport",
      (await navButtons.nth(1).innerText()) === "CC Bills" && (await navButtons.nth(4).innerText()) === "Subs",
    );

    await page.setViewportSize({ width: 1280, height: 720 }); // restore Playwright's default

    // Clicking an Upcoming item is a shortcut to go pay/settle it — EMI
    // items go to the EMI tab, Credit Card items go to Credit Cards on the
    // month the bill is actually due.
    await page.locator(".upcoming-item", { hasText: "E2E Overview EMI" }).click();
    await page.waitForSelector(".add-emi-form");
    check(
      "Dashboard Overview: clicking an EMI upcoming item navigates to the EMI tab",
      (await page.locator(".tabs button.selected").innerText()) === "EMI",
    );

    await page.click('.tabs button:has-text("Dashboard")');
    await waitForDashboardData();
    await page.waitForTimeout(400);
    await page.locator(".upcoming-item", { hasText: "E2E Overview Card" }).click();
    await page.waitForSelector(".cards-form");
    check(
      "Dashboard Overview: clicking a Credit Card upcoming item navigates to Credit Cards",
      (await page.locator(".tabs button.selected").innerText()) === "Credit Cards",
    );

    await page.click('.tabs button:has-text("Dashboard")');
    await waitForDashboardData();
    await page.waitForTimeout(400);

    // Checking "Settled" on that card should drop its (due - paid) gap from
    // Net Worth and remove it from Upcoming entirely, regardless of the gap.
    await page.click('.tabs button:has-text("Credit Cards")');
    await page.waitForSelector(".cards-form");
    await page.waitForSelector(".loading-overlay", { state: "detached" });
    // "E2E Overview Card" is the only row present at this point (the earlier
    // two-card scenario above already cleaned itself up) — `hasText` can't
    // target a specific row here anyway, since the card name lives inside an
    // <input value>, not rendered text content.
    await page.locator(".card-row-fields").last().locator(".cards-settled input").check();
    await page.click('.cards-form button:has-text("Save")');
    await page.waitForTimeout(400);

    await page.click('.tabs button:has-text("Dashboard")');
    await waitForDashboardData();
    await page.waitForTimeout(400);

    check(
      "Dashboard Overview: settling the card adds its gap back to Net Worth",
      (await page.locator(".overview-stat-headline strong").innerText()).includes("1,90,000"),
    );
    check(
      "Dashboard Overview: settled card no longer appears in Upcoming",
      (await page.locator(".upcoming-item", { hasText: "E2E Overview Card" }).count()) === 0,
    );

    // Upcoming defaults open (it's the actionable part of the dashboard),
    // collapses on click, and remembers that choice across a reload.
    check(
      "Dashboard Overview: Upcoming starts expanded",
      (await page.locator(".upcoming-toggle").getAttribute("aria-expanded")) === "true",
    );
    await page.click(".upcoming-toggle");
    await page.waitForTimeout(300); // let the grid-rows fold transition finish
    // The list stays in the DOM (an animated fold, not mount/unmount), so
    // check the collapsed wrapper's actual rendered height instead of item
    // count — that's what "folded" really means here.
    const collapsedHeight = (await page.locator(".upcoming-collapse").boundingBox())?.height ?? -1;
    check(
      "Dashboard Overview: clicking the toggle collapses Upcoming",
      collapsedHeight === 0 && (await page.locator(".upcoming-toggle").getAttribute("aria-expanded")) === "false",
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".upcoming-toggle");
    check(
      "Dashboard Overview: collapsed state persists across reload",
      (await page.locator(".upcoming-toggle").getAttribute("aria-expanded")) === "false",
    );

    // Clean up so the suite is idempotent across runs.
    await page.click('.tabs button:has-text("Debts")');
    await page.waitForSelector(".add-debt-form");
    await clickMenuItem(page.locator(".debt-row", { hasText: "E2E Overview Debt" }), "Delete");
    await page.waitForTimeout(400);

    await page.click('.tabs button:has-text("EMI")');
    await page.waitForSelector(".add-emi-form");
    await clickMenuItem(page.locator(".emi-row", { hasText: "E2E Overview EMI" }), "Delete");
    await page.waitForTimeout(400);

    await page.click('.tabs button:has-text("Credit Cards")');
    await page.waitForSelector(".cards-form");
    await page.click(".cards-remove >> nth=0");
    await page.click('.cards-form button:has-text("Save")');
    await page.waitForTimeout(400);
    check(
      "Dashboard Overview: cleanup removed all three test entries",
      (await page.locator(".debt-row").count()) === 0 &&
        (await page.locator(".emi-row").count()) === 0 &&
        (await page.locator(".card-row-fields").count()) === 0,
    );

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
    // `npm run dev` was spawned with `shell: true` (needed to resolve `npm`
    // via PATH on Windows), which makes `devProcess` a wrapper around cmd.exe
    // — plain `.kill()` only kills that wrapper, not the concurrently/vite/
    // tsx descendants it spawned, leaving them as orphaned background
    // node.exe processes. `taskkill /T` kills the whole tree rooted at the
    // wrapper's PID instead.
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
