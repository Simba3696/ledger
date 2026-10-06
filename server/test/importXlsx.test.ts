import { describe, it, expect, beforeAll, afterAll } from "vitest";
// dbHelpers must load before any store module (it sets DATABASE_URL).
import { sql, resetTables, closeSql } from "./dbHelpers.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fixtures from "../../scripts/legacy-excel/fixtures.js";
import { importXlsx, readSource, ImportError, IMPORT_TABLES, type ImportReport } from "../../scripts/legacy-excel/importer.js";
import { setDbDir } from "../../scripts/legacy-excel/workbookIO.js";
import * as legacyCategories from "../../scripts/legacy-excel/categoryColors.js";
import * as legacyLedger from "../../scripts/legacy-excel/ledger.js";
import * as legacyFinances from "../../scripts/legacy-excel/finances.js";
import * as legacyDebts from "../../scripts/legacy-excel/debts.js";
import * as legacyEmi from "../../scripts/legacy-excel/emi.js";
import * as legacySubscriptions from "../../scripts/legacy-excel/subscriptions.js";
import * as legacyBills from "../../scripts/legacy-excel/creditCardBills.js";
import * as categories from "../src/store/categories.js";
import * as ledger from "../src/store/ledger.js";
import * as finances from "../src/store/finances.js";
import * as debts from "../src/store/debts.js";
import * as emi from "../src/store/emi.js";
import * as subscriptions from "../src/store/subscriptions.js";
import * as bills from "../src/store/creditCardBills.js";

// The importer (LLD §8) against fixture folders built in a temp directory
// with fictional data. The "clean" folder holds nothing the importer has to
// skip, so every store read must match the legacy reader on the same folder
// (what the Excel edition showed), apart from `row`, which is now a database
// id. The "messy" folder holds every kind of row the import must skip,
// report or leave out.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATABASE_URL = process.env.DATABASE_URL!;
const TODAY = new Date(2024, 6, 1); // fixed "today" for the computed EMI/subscription fields

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-import-"));
const CLEAN = path.join(tmp, "clean");
const MESSY = path.join(tmp, "messy");
const EMPTY = path.join(tmp, "empty");

const CUSTOM_CATEGORIES = [
  { id: "food", label: "Food", bg: "#FFFF00", fg: "#3d3d00" },
  { id: "transportation", label: "Transportation", bg: "#00B0F0", fg: "#00303d" },
  { id: "rent", label: "Rent", bg: "#FFC000", fg: "#4d3300" },
  { id: "other", label: "Other", bg: "#FF0000", fg: "#ffffff" },
  { id: "health", label: "Health", bg: "#00B050" }, // no fg: derived on read
];

async function buildClean() {
  fs.mkdirSync(CLEAN);
  fixtures.writeCategoriesJson(CLEAN, CUSTOM_CATEGORIES);
  const cats = CUSTOM_CATEGORIES.map((c) => ({ ...c, fg: c.fg ?? legacyCategories.deriveForegroundColor(c.bg) }));
  await fixtures.buildFixtureWorkbook(
    path.join(CLEAN, "Expenses (2024).xlsx"),
    [
      {
        name: "January",
        entries: [
          { amount: 120, remarks: "Lunch", category: "food" },
          { amount: 800, remarks: "Bus pass", category: "transportation", isCard: true },
          { amount: 15000, remarks: "Rent", category: "rent", isCard: true, cardNote: "CC (200)" },
          { amount: 250.5, remarks: "Medicine", category: "health" },
          { amount: 999, remarks: "Gift", category: "other", fillArgb: "FF123456" }, // no category has this colour
        ],
      },
      { name: "February", entries: [{ amount: 60, remarks: "Coffee", category: "food" }], protect: true },
      { name: "March", entries: [] },
      {
        name: "April",
        entries: [
          { amount: 400, remarks: "Groceries", category: "food" },
          // A formula Amount: the Excel edition never listed it, so neither does the import.
          { amount: 0, remarks: "Split bill", category: "food", rawAmount: { formula: "-10-5", result: -15 } },
          { amount: 75.25, remarks: "Taxi", category: "transportation" },
        ],
      },
    ],
    cats,
  );
  // A year with every sheet empty: it still exists (its months list as []).
  await fixtures.buildFixtureWorkbook(
    path.join(CLEAN, "Expenses (2025).xlsx"),
    legacyLedger.MONTH_NAMES.map((name) => ({ name, entries: [] })),
    cats,
  );
  await fixtures.buildFinancesWorkbook(CLEAN, [
    [2024, 1, 50000, 2000, JSON.stringify([{ name: "PPF", amount: 10000 }, { name: "NPS", amount: 5000 }])],
    [2024, 2, 50000, null, null],
    [2024, 4, 52000, 1500.25, JSON.stringify([{ name: "PPF", amount: 11000 }])],
  ]);
  await fixtures.buildDebtsWorkbook(CLEAN, [
    ["Alex", 5000],
    ["Sam", -1200.5],
  ]);
  await fixtures.buildEmiWorkbook(CLEAN, [
    ["Card A", 2500, 5, 30000, "Phone", 20000, "2024-03-10", "2024-12-10", 14, 2],
    ["Car Loan", 12000, 31, 600000, "", 400000, "2024-01-31", null, null, null],
  ]);
  await fixtures.buildSubscriptionsWorkbook(CLEAN, [
    ["Streaming", 499, "Monthly", "2024-03-15", "Card A"],
    ["Cloud Storage", 1300, "Yearly", "2023-11-02", "N/A"],
  ]);
  await fixtures.buildCardBillsWorkbook(CLEAN, [
    [2024, 1, JSON.stringify([
      { name: "Card A", due: 12000, paid: 12000, dueDate: "2024-01-20", settled: true },
      { name: "Card B", due: 3000.5, paid: 0, dueDate: null },
    ])],
    [2024, 2, JSON.stringify([{ name: "Card A", due: 8000, paid: 8001, dueDate: "2024-02-20", settled: true }])],
  ]);
}

async function buildMessy() {
  fs.mkdirSync(MESSY); // no categories.json: the defaults apply
  await fixtures.buildFixtureWorkbook(path.join(MESSY, "Expenses (2023).xlsx"), [
    {
      name: "May",
      entries: [
        { amount: 100, remarks: "Fine", category: "food" },
        { amount: 0, remarks: "Free sample", category: "food" },
        { amount: 30, remarks: "   ", category: "other" },
        { amount: 1e12, remarks: "Typo", category: "other" },
        { amount: 12.345, remarks: "Odd cents", category: "food" },
        { amount: 0, remarks: "Formula", category: "food", rawAmount: { formula: "-1-2", result: -3 } },
        { amount: 50, remarks: "Fine too", category: "food" },
      ],
    },
    { name: "Notes", entries: [] },
  ]);
  await fixtures.buildFixtureWorkbook(path.join(MESSY, "Expenses (2017).xlsx"), [
    { name: "December", entries: [{ amount: 10, remarks: "Too early", category: "food" }] },
  ]);
  await fixtures.buildFinancesWorkbook(MESSY, [
    [2023, 5, 40000, null, JSON.stringify([{ name: "PPF", amount: 100 }, { name: " ", amount: 5 }, { bogus: true }])],
    [2023, 5, 1, 1, null], // duplicate month
    [2017, 1, 100, null, null], // before 2018
    ["Total", null, 999, null, null], // not a month row
    [2023, 6, "lots", null, "not json"],
    [2023, 7, 1e13, null, null], // too large: skipped, and it is still the row the Excel edition showed
    [2023, 7, 5, null, null], // so this later row for July must not stand in for it
  ]);
  await fixtures.buildDebtsWorkbook(MESSY, [
    ["Alex", 100],
    ["", 300], // no name: the Excel edition skipped it
    ["Jordan", "abc"], // no numeric amount: skipped too
    ["Casey", 1.005], // Postgres rounds the decimal "1.005" to 1.01 (the float 1.005 * 100 is 100.4999...)
  ]);
  await fixtures.buildEmiWorkbook(MESSY, [
    ["Card A", 1000, 15.5, 10000, "", 5000, "2024-02-01", null, null, null],
    ["Card B", 1000, 10, 10000, "", 5000, "2024-02-30", null, null, null],
    ["Card C", 1000, 10, 10000, "", 5000, "2024-02-01", null, 150, null],
    ["Card D", 1000, 10, 10000, "", 5000, "2024-02-01", null, 12.3456, null],
  ]);
  await fixtures.buildSubscriptionsWorkbook(MESSY, [
    ["Gym", 0, "Monthly", "2024-01-01", "N/A"],
    ["Music", 99, "Weekly", "2024-01-01", "N/A"], // not Monthly/Yearly: the Excel edition skipped it
  ]);
  await fixtures.buildCardBillsWorkbook(MESSY, [
    [2023, 5, JSON.stringify([
      { name: "  ", due: 1, paid: 0, dueDate: null },
      { name: "Card A", due: 100, paid: 100, dueDate: "2023-05-31", settled: true },
      { name: "Card B", due: 1, paid: 0, dueDate: "2023-02-29" },
    ])],
    [2023, 5, JSON.stringify([])],
  ]);
  fs.writeFileSync(path.join(MESSY, "Expense Summary.xlsm"), "not a workbook this edition reads");
}

async function tableCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of IMPORT_TABLES) {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
    counts[table] = n;
  }
  return counts;
}

async function emptyDatabase() {
  await resetTables(...IMPORT_TABLES);
}

/** Drops `row` (a sheet row number on one side, a database id on the other). */
function withoutRow<T extends { row: number }>(items: T[]): Omit<T, "row">[] {
  return items.map(({ row: _row, ...rest }) => rest);
}

beforeAll(async () => {
  await buildClean();
  await buildMessy();
  fs.mkdirSync(EMPTY);
  fs.writeFileSync(path.join(EMPTY, "readme.txt"), "nothing here");
});

afterAll(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
  await closeSql();
});

describe("import of a clean folder matches what the Excel edition showed", () => {
  let report: ImportReport;
  let filesBefore: string[];

  beforeAll(async () => {
    await emptyDatabase();
    filesBefore = fs.readdirSync(CLEAN).sort();
    report = await importXlsx({ from: CLEAN, databaseUrl: DATABASE_URL });
    setDbDir(CLEAN); // the legacy readers below read the same folder
  });

  it("reports per-table counts and skips nothing", async () => {
    expect(report.counts).toEqual({
      categories: 5,
      ledger_years: 2,
      expenses: 8,
      month_locks: 1,
      finance_months: 3,
      savings_balances: 3,
      debts: 2,
      emis: 2,
      subscriptions: 2,
      card_bills: 3,
    });
    expect(await tableCounts()).toEqual(report.counts);
    expect(report.skipped).toEqual([]);
    expect(report.dryRun).toBe(false);
  });

  it("reports the unrecognised fill colour and the formula row", () => {
    expect(report.changed).toEqual([
      { where: 'Expenses (2024).xlsx, sheet "January", row 6', reason: "fill colour FF123456 matches no category; imported without one" },
    ]);
    expect(report.ignored).toEqual([
      { where: 'Expenses (2024).xlsx, sheet "April", row 3', reason: "the Amount is a formula" },
    ]);
  });

  it("leaves the source folder untouched", () => {
    expect(fs.readdirSync(CLEAN).sort()).toEqual(filesBefore);
  });

  it("categories", async () => {
    expect(await categories.loadCategoryConfig()).toEqual(await legacyCategories.loadCategoryConfig());
    // A missing fg stays missing (derived on read), as categories.json had it.
    const [health] = await sql<{ fg: string | null }[]>`select fg from categories where id = 'health'`;
    expect(health.fg).toBeNull();
  });

  it("listMonth, in sheet order, with card notes and a null category", async () => {
    for (const month of [1, 2, 3, 4]) {
      expect(withoutRow(await ledger.listMonth(2024, month))).toEqual(withoutRow(await legacyLedger.listMonth(2024, month)));
    }
    const january = await ledger.listMonth(2024, 1);
    expect(january.map((e) => e.remarks)).toEqual(["Lunch", "Bus pass", "Rent", "Medicine", "Gift"]);
    expect(january[2].cardNote).toBe("CC (200)");
    expect(january[4].category).toBeNull();
  });

  it("yearSummary", async () => {
    expect(await ledger.yearSummary(2024)).toEqual(await legacyLedger.yearSummary(2024));
  });

  it("isMonthLocked follows the protected sheets", async () => {
    for (let month = 1; month <= 12; month++) {
      const legacy = month <= 4 ? await legacyLedger.isMonthLocked(2024, month) : false;
      expect(await ledger.isMonthLocked(2024, month)).toBe(legacy);
    }
    expect(await ledger.isMonthLocked(2024, 2)).toBe(true);
  });

  it("a workbook whose sheets are all empty still creates its year", async () => {
    const years = await sql<{ year: number }[]>`select year from ledger_years order by year`;
    expect(years.map((y) => y.year)).toEqual([2024, 2025]);
    for (let month = 1; month <= 12; month++) {
      expect(await ledger.listMonth(2025, month)).toEqual(await legacyLedger.listMonth(2025, month));
    }
    expect(await ledger.yearSummary(2025)).toEqual(await legacyLedger.yearSummary(2025));
  });

  it("getMonthIncome and financeSummary", async () => {
    for (let month = 1; month <= 12; month++) {
      expect(await finances.getMonthIncome(2024, month)).toEqual(await legacyFinances.getMonthIncome(2024, month));
    }
    expect(await finances.financeSummary(2024, 12)).toEqual(await legacyFinances.financeSummary(2024, 12));
    expect(await finances.financeSummary(2025, 6)).toEqual(await legacyFinances.financeSummary(2025, 6));
  });

  it("listDebts", async () => {
    expect(withoutRow(await debts.listDebts())).toEqual(withoutRow(await legacyDebts.listDebts()));
  });

  it("listEmis, including the computed remaining and payoff", async () => {
    const stored = await emi.listEmis(TODAY);
    expect(withoutRow(stored)).toEqual(withoutRow(await legacyEmi.listEmis(TODAY)));
    // Card A: 20000 as of 2024-03-10, three due dates (Apr 5, May 5, Jun 5) passed by July 1.
    expect(stored[0]).toMatchObject({ remaining: 12500, untilTarget: "2024-12-10", interestRate: 14, foreclosureCharge: 2 });
    const [raw] = await sql`select * from emis order by id limit 1`;
    expect(Object.keys(raw)).not.toContain("remaining");
  });

  it("listSubscriptions, including the computed next expiry", async () => {
    const stored = await subscriptions.listSubscriptions(TODAY);
    expect(withoutRow(stored)).toEqual(withoutRow(await legacySubscriptions.listSubscriptions(TODAY)));
    expect(stored.map((s) => s.nextExpiry)).toEqual(["2024-07-15", "2024-11-02"]);
  });

  it("getMonthBills and yearBillsSummary", async () => {
    for (let month = 1; month <= 12; month++) {
      expect(await bills.getMonthBills(2024, month)).toEqual(await legacyBills.getMonthBills(2024, month));
    }
    expect(await bills.yearBillsSummary(2024)).toEqual(await legacyBills.yearBillsSummary(2024));
  });

  it("refuses to import again into a database that has data, and changes nothing", async () => {
    const before = await tableCounts();
    await expect(importXlsx({ from: CLEAN, databaseUrl: DATABASE_URL })).rejects.toThrow(ImportError);
    await expect(importXlsx({ from: CLEAN, databaseUrl: DATABASE_URL })).rejects.toThrow(/already has data.*expenses: 8 rows.*--force/);
    await expect(importXlsx({ from: CLEAN, databaseUrl: DATABASE_URL, dryRun: true })).rejects.toThrow(/already has data/);
    expect(await tableCounts()).toEqual(before);
  });

  it("--force replaces every row rather than adding to them", async () => {
    const before = await tableCounts();
    const again = await importXlsx({ from: CLEAN, databaseUrl: DATABASE_URL, force: true });
    expect(again.replaced).toMatchObject({ expenses: 8, debts: 2, categories: 5 });
    expect(await tableCounts()).toEqual(before);
    // Identities restart, so the ids are the same as after the first import.
    expect((await debts.listDebts()).map((d) => d.row)).toEqual([1, 2]);
  });
});

describe("import of a messy folder", () => {
  let report: ImportReport;
  let filesBefore: string[];

  beforeAll(async () => {
    await emptyDatabase();
    filesBefore = fs.readdirSync(MESSY).sort();
    report = await importXlsx({ from: MESSY, databaseUrl: DATABASE_URL });
  });

  const reasonsFor = (issues: ImportReport["skipped"], where: string) => issues.filter((i) => i.where === where).map((i) => i.reason);

  it("skips and reports every row a column can't hold", () => {
    const may = (row: number) => `Expenses (2023).xlsx, sheet "May", row ${row}`;
    expect(reasonsFor(report.skipped, may(3))).toEqual(["Amount must be a positive number"]);
    expect(reasonsFor(report.skipped, may(4))).toEqual(["Remarks are blank"]);
    expect(reasonsFor(report.skipped, may(5))).toEqual(["Amount is too large"]);
    expect(reasonsFor(report.skipped, "Expenses (2017).xlsx")).toEqual([
      "the whole workbook (1 entry): years before 2018 can't be stored",
    ]);

    const income = (row: number) => `Finances.xlsx, sheet "Income", row ${row}`;
    expect(reasonsFor(report.skipped, income(2))).toEqual(["a savings entry's name is blank or has an invalid character"]);
    expect(reasonsFor(report.skipped, income(3))[0]).toMatch(/another row \(2\) for 2023-5/);
    expect(reasonsFor(report.skipped, income(4))[0]).toMatch(/2017-1 isn't a month from 2018 on/);
    expect(reasonsFor(report.skipped, income(7))).toEqual(["Salary is too large"]);
    expect(reasonsFor(report.skipped, income(8))).toEqual(["another row (7) for 2023-7 is the one the Excel edition's month view showed"]);

    const emiRow = (row: number) => `EMI.xlsx, sheet "EMI", row ${row}`;
    expect(reasonsFor(report.skipped, emiRow(2))[0]).toMatch(/Due Day 15.5/);
    expect(reasonsFor(report.skipped, emiRow(3))[0]).toMatch(/As Of Date "2024-02-30"/);
    expect(reasonsFor(report.skipped, emiRow(4))[0]).toMatch(/Interest Rate must be between 0 and 100/);

    expect(reasonsFor(report.skipped, 'Subscriptions.xlsx, sheet "Subscriptions", row 2')).toEqual(["Amount must be a positive number"]);

    const billRow = (row: number) => `CreditCardBills.xlsx, sheet "Bills", row ${row}`;
    expect(reasonsFor(report.skipped, billRow(2))).toEqual([
      "a card's name is blank or has an invalid character",
      'Due date "2023-02-29" for "Card B" isn\'t a real YYYY-MM-DD date',
    ]);
    expect(reasonsFor(report.skipped, billRow(3))[0]).toMatch(/another row \(2\)/);
  });

  it("writes only the rows that passed", async () => {
    expect(report.counts).toMatchObject({
      categories: 4,
      ledger_years: 1,
      expenses: 3,
      finance_months: 2,
      savings_balances: 1,
      debts: 2,
      emis: 1,
      subscriptions: 0,
      card_bills: 1,
    });
    expect(await tableCounts()).toEqual(report.counts);
    expect((await ledger.listMonth(2023, 5)).map((e) => [e.remarks, e.amount])).toEqual([
      ["Fine", 100],
      ["Odd cents", 12.35],
      ["Fine too", 50],
    ]);
    // Positions stay contiguous over the imported rows.
    const positions = await sql<{ position: number }[]>`select position from expenses where year = 2023 and month = 5 order by position`;
    expect(positions.map((p) => p.position)).toEqual([0, 1, 2]);
    expect(await categories.loadCategoryConfig()).toEqual(categories.DEFAULT_CATEGORIES);
    expect(await finances.getMonthIncome(2023, 7)).toMatchObject({ salary: null, otherIncome: null, savings: [] });
    expect((await debts.listDebts()).map((d) => [d.name, d.amount])).toEqual([
      ["Alex", 100],
      ["Casey", 1.01],
    ]);
  });

  it("reports what it imported with a difference", () => {
    const changed = report.changed.map((c) => `${c.where}: ${c.reason}`);
    expect(changed).toContain('Expenses (2023).xlsx, sheet "May", row 6: Amount 12.345 has more than 2 decimal places; stored as 12.35');
    expect(changed).toContain('EMI.xlsx, sheet "EMI", row 5: Interest Rate 12.3456 has more than 3 decimal places; stored as 12.346');
    expect(changed).toContain('Debts.xlsx, sheet "Debts", row 5: Amount 1.005 has more than 2 decimal places; stored as 1.01');
    expect(changed).toContain('Finances.xlsx, sheet "Income", row 2: 1 savings entry without a name and amount not imported, as the Excel edition ignored them');
    expect(changed).toContain('Finances.xlsx, sheet "Income", row 6: Salary isn\'t a number; imported empty, as the Excel edition read it');
    expect(changed).toContain('Finances.xlsx, sheet "Income", row 6: the savings cell isn\'t valid JSON; imported no savings, as the Excel edition read it');
  });

  it("lists the rows and sheets the Excel edition never read either", () => {
    const ignored = report.ignored.map((c) => `${c.where}: ${c.reason}`);
    expect(ignored).toEqual(
      expect.arrayContaining([
        'Expenses (2023).xlsx, sheet "Notes": not a month sheet',
        'Expenses (2023).xlsx, sheet "May", row 7: the Amount is a formula',
        'Finances.xlsx, sheet "Income", row 5: the Year or Month isn\'t a number',
        'Debts.xlsx, sheet "Debts", row 3: incomplete or of the wrong type',
        'Debts.xlsx, sheet "Debts", row 4: incomplete or of the wrong type',
        'Subscriptions.xlsx, sheet "Subscriptions", row 3: incomplete or of the wrong type',
      ]),
    );
    expect(report.otherFiles).toEqual(["Expense Summary.xlsm"]);
  });

  it("doesn't create categories.json in the source folder", () => {
    expect(fs.readdirSync(MESSY).sort()).toEqual(filesBefore);
  });
});

describe("guards", () => {
  it("a dry run reports the counts but writes nothing", async () => {
    await emptyDatabase();
    const report = await importXlsx({ from: CLEAN, databaseUrl: DATABASE_URL, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.counts.expenses).toBe(8);
    expect(Object.values(await tableCounts()).every((n) => n === 0)).toBe(true);
  });

  it("replaces the four default categories a new deployment starts with, without --force", async () => {
    await emptyDatabase();
    await categories.loadCategoryConfig(); // the app's first load creates the defaults
    const report = await importXlsx({ from: CLEAN, databaseUrl: DATABASE_URL });
    expect(report.replaced).toEqual({});
    expect((await categories.loadCategoryConfig()).map((c) => c.id)).toEqual(["food", "transportation", "rent", "other", "health"]);
  });

  it("but not customised categories", async () => {
    await emptyDatabase();
    await sql`insert into categories (id, label, bg, position) values ('pets', 'Pets', '#AA00AA', 0)`;
    await expect(importXlsx({ from: CLEAN, databaseUrl: DATABASE_URL })).rejects.toThrow(/already has data \(categories: 1 rows\)/);
    expect(await tableCounts()).toMatchObject({ categories: 1, expenses: 0 });
  });

  it("refuses a missing folder and one with no Excel-edition files", async () => {
    await expect(importXlsx({ from: path.join(tmp, "nope"), databaseUrl: DATABASE_URL })).rejects.toThrow(/Not a folder/);
    await expect(importXlsx({ from: EMPTY, databaseUrl: DATABASE_URL })).rejects.toThrow(/No Excel-edition files/);
  });

  it("matches file names ignoring case, as the Excel edition did on Windows", async () => {
    const dir = path.join(tmp, "cased");
    fs.mkdirSync(dir);
    await fixtures.buildDebtsWorkbook(dir, [["Alex", 100]]);
    fs.renameSync(path.join(dir, "Debts.xlsx"), path.join(dir, "debts.xlsx"));
    await fixtures.buildFixtureWorkbook(path.join(dir, "expenses (2024).xlsx"), [
      { name: "January", entries: [{ amount: 10, remarks: "Tea", category: "food" }] },
    ]);
    if (fs.existsSync(path.join(dir, "Debts.xlsx"))) {
      // Case-insensitive file system: the readers' fixed names find both files.
      const { plan, report } = await readSource(dir);
      expect(plan.debts).toHaveLength(1);
      expect(plan.ledger_years).toEqual([{ year: 2024 }]);
      expect(plan.expenses).toHaveLength(1);
      expect(report.otherFiles).toEqual([]);
    } else {
      await expect(readSource(dir)).rejects.toThrow(/Rename (debts|expenses \(2024\))\.xlsx to/);
    }
  });

  it("refuses while Excel has one of the workbooks open", async () => {
    const dir = path.join(tmp, "open-in-excel");
    fs.mkdirSync(dir);
    await fixtures.buildDebtsWorkbook(dir, [["Alex", 100]]);
    fs.writeFileSync(path.join(dir, "~$Debts.xlsx"), "Excel's owner file");
    await expect(importXlsx({ from: dir, databaseUrl: DATABASE_URL })).rejects.toThrow(/Excel has Debts\.xlsx open .*Close Excel first/);
  });
});

describe("CLI", () => {
  function run(...args: string[]) {
    return runIn(undefined, ...args);
  }

  /** As `npm run` does: the script runs in the repository root, with
   * INIT_CWD set to where the command was typed. */
  function runIn(initCwd: string | undefined, ...args: string[]) {
    const env = { ...process.env };
    if (initCwd !== undefined) env.INIT_CWD = initCwd;
    const result = spawnSync(process.execPath, ["--import", "tsx", path.join("scripts", "import-xlsx.ts"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env,
    });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
  }

  it("refuses to write to a remote host without --yes, and never prints the password", () => {
    const { code, out } = run("--from", CLEAN, "--database-url", "postgresql://someone:s3cret-pw@db.example.invalid:6543/postgres");
    expect(code).toBe(1);
    expect(out).toContain("Target: db.example.invalid:6543/postgres as someone (REMOTE)");
    expect(out).toContain("without --yes");
    expect(out).not.toContain("s3cret-pw");
  });

  it("rejects unknown options and a missing --from with a usage error", () => {
    expect(run("--frm", CLEAN).code).toBe(2);
    expect(run().code).toBe(2);
    const help = run("--help");
    expect(help.code).toBe(0);
    expect(help.out).toContain("--force");
  });

  it("dry-runs against a local database, printing the report", async () => {
    await emptyDatabase();
    const { code, out } = run("--from", CLEAN, "--dry-run", "--database-url", DATABASE_URL);
    expect(code).toBe(0);
    expect(out).toContain("(this computer)");
    expect(out).toMatch(/expenses\s+8/);
    expect(out).toContain("Nothing was saved.");
    expect((await tableCounts()).expenses).toBe(0);
  });

  it("resolves a relative --from against the directory the command was typed in", async () => {
    await emptyDatabase();
    const { code, out } = runIn(tmp, "--from", "clean", "--dry-run", "--database-url", DATABASE_URL);
    expect(code).toBe(0);
    expect(out).toContain(`Source: ${CLEAN}`);
    expect(out).toMatch(/expenses\s+8/);
  });
});
