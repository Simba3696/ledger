import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";

// LEDGER_DB_DIR must be set before emi.ts's top-level DB_DIR evaluates, so
// the modules are imported dynamically after it (same as emi.test.ts).
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-emi-export-test-"));
process.env.LEDGER_DB_DIR = scratchDir;

const emi = await import("../src/excel/emi.js");
const ex = await import("../src/excel/emiExport.js");

// The export date: 12 Oct 2026. Card A's Oct 5 installment has fallen due;
// Bank B's Oct 20 one hasn't.
const TODAY = new Date(2026, 9, 12);

beforeAll(async () => {
  // Added on Oct 1, before either October due date.
  const added = new Date(2026, 9, 1);
  await emi.addEmi(
    {
      cardOrBank: "Card A",
      emiAmount: 1000,
      dueDay: 5,
      totalAmount: 6000,
      remarks: "Phone, XX1234 a.person@example.com",
      remainingAsOf: 4000,
      durationMonths: 3,
    },
    added,
  );
  await emi.addEmi(
    {
      cardOrBank: "Bank B",
      emiAmount: 2500,
      dueDay: 20,
      totalAmount: 30000,
      remarks: "Car Loan",
      remainingAsOf: 6000,
      durationMonths: 3,
      interestRate: 12,
      foreclosureCharge: 2,
    },
    added,
  );
});

afterAll(() => {
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

const OPTIONS = {
  from: "2026-10",
  to: "2027-03",
  monthlySalary: 4000,
  essentialExpenses: 1500,
  thresholds: [1500, 500],
  today: TODAY,
};

describe("buildEmiExport", () => {
  it("exports each plan with stored values, calculated values and nulls for what isn't stored", async () => {
    const data = await ex.buildEmiExport(OPTIONS);
    expect(data.plans.map((p) => p.emi_id)).toEqual(["EMI-01", "EMI-02"]);

    const [a, b] = data.plans;
    expect(a).toMatchObject({
      lender: "Card A",
      emi_type: null,
      emi_start_date: null,
      original_tenure_months: null,
      original_amount: 6000,
      monthly_emi: 1000,
      interest_rate_pa: null,
      // Oct 5 has passed: 4000 - 1000.
      total_remaining_scheduled_payments: 3000,
      remaining_installments: 3,
      next_payment_date: "2026-11-05",
      final_emi_date: "2027-01-05",
      final_installment_amount: 1000,
      // No rate on record: principal is the remaining payments, interest unknown.
      current_outstanding_principal: 3000,
      outstanding_principal_basis: "no interest rate on record: equals remaining scheduled payments",
      remaining_interest_payable: null,
      status: "Active",
    });
    // Oct 20 hasn't passed: 2500 + 2500 + a final 1000.
    expect(b).toMatchObject({
      total_remaining_scheduled_payments: 6000,
      remaining_installments: 3,
      next_payment_date: "2026-10-20",
      final_emi_date: "2026-12-20",
      final_installment_amount: 1000,
      interest_rate_pa: 12,
      foreclosure_charge_pct: 2,
    });
    expect(b.current_outstanding_principal).toBeLessThan(6000);
    expect(b.remaining_interest_payable).toBeCloseTo(6000 - b.current_outstanding_principal, 2);
    expect(b.foreclosure_amount).toBeCloseTo(b.current_outstanding_principal * 1.02, 1);
  });

  it("removes card numbers and emails but keeps the rest of the description", async () => {
    const data = await ex.buildEmiExport(OPTIONS);
    expect(data.plans[0].description).toBe("Phone, [card number removed] [email removed]");
    expect(data.plans[1].description).toBe("Car Loan");
  });

  it("builds the monthly schedule with each EMI's contribution, and the month it ends", async () => {
    const data = await ex.buildEmiExport(OPTIONS);
    expect(
      data.schedule.map((s) => [s.month, s.active_emis, s.total_emi_payment, s.paid_earlier_this_month, s.contributions, s.emis_ending]),
    ).toEqual([
      ["2026-10", 1, 2500, 1000, { "EMI-02": 2500 }, []],
      ["2026-11", 2, 3500, 0, { "EMI-01": 1000, "EMI-02": 2500 }, []],
      ["2026-12", 2, 2000, 0, { "EMI-01": 1000, "EMI-02": 1000 }, ["EMI-02"]],
      ["2027-01", 1, 1000, 0, { "EMI-01": 1000 }, ["EMI-01"]],
      ["2027-02", 0, 0, 0, {}, []],
      ["2027-03", 0, 0, 0, {}, []],
    ]);
    expect(data.schedule.map((s) => s.remaining_scheduled_payments_at_month_end)).toEqual([6500, 3000, 1000, 0, 0, 0]);
  });

  it("projects the cash flow from zero savings, counting this month's already-paid installments", async () => {
    const data = await ex.buildEmiExport(OPTIONS);
    expect(
      data.cash_flow.map((c) => [c.month, c.emi_obligations, c.surplus_or_deficit, c.cumulative_surplus_or_deficit, c.active_emis]),
    ).toEqual([
      ["2026-10", 3500, -1000, -1000, 2],
      ["2026-11", 3500, -1000, -2000, 2],
      ["2026-12", 2000, 500, -1500, 2],
      ["2027-01", 1000, 1500, 0, 1],
      ["2027-02", 0, 2500, 2500, 0],
      ["2027-03", 0, 2500, 5000, 0],
    ]);
    expect(data.cash_flow[0].emi_to_income_ratio).toBe(0.875);
  });

  it("summarises thresholds, the worst deficit and the debt-free date", async () => {
    const { summary } = await ex.buildEmiExport(OPTIONS);
    expect(summary).toMatchObject({
      active_emis: 2,
      total_remaining_scheduled_payments: 9000,
      // Below the 2500 left after essentials, then the extra thresholds.
      first_month_emis_below_2500: "2026-12",
      first_month_emis_below_1500: "2027-01",
      first_month_emis_below_500: "2027-02",
      max_cumulative_deficit: -2000,
      max_cumulative_deficit_month: "2026-11",
      funding_required_to_cover_worst_deficit: 2000,
      months_in_deficit: 2,
      projected_debt_free_date: "2027-01-05",
    });
  });

  it("validates the schedule against the chart and flags a payoff date the schedule doesn't reach", async () => {
    const { validation } = await ex.buildEmiExport(OPTIONS);
    const byCheck = Object.fromEntries(validation.map((v) => [v.check, v]));
    expect(byCheck["Each month's total equals the sum of its individual EMI contributions"].passed).toBe(true);
    expect(byCheck["Each plan's remaining installments and remaining payments match its generated schedule"].passed).toBe(true);
    expect(byCheck["The schedule matches the Dashboard's Upcoming EMIs chart month for month"].passed).toBe(true);
    // Bank B's bank-stated end resolves to 2027-01-20, but its balance runs
    // out on 2026-12-20: reported, not adjusted.
    const payoff = byCheck["Each plan's last scheduled installment falls on the EMI tab's payoff date"];
    expect(payoff.passed).toBe(false);
    expect(payoff.detail).toBe("EMI-02: schedule ends 2026-12-20, EMI tab says 2027-01-20");
    expect(byCheck["Personal identifiers removed from lender names and descriptions"].detail).toBe("Redacted in: EMI-01");
  });

  it("refuses a malformed window or negative assumptions", async () => {
    await expect(ex.buildEmiExport({ ...OPTIONS, from: "2026-13" })).rejects.toThrow("YYYY-MM");
    await expect(ex.buildEmiExport({ ...OPTIONS, to: "2026-09" })).rejects.toThrow("before");
    await expect(ex.buildEmiExport({ ...OPTIONS, monthlySalary: Number.NaN })).rejects.toThrow("Monthly salary");
    await expect(ex.buildEmiExport({ ...OPTIONS, essentialExpenses: -1 })).rejects.toThrow("Essential expenses");
  });
});

describe("sanitizeText", () => {
  it.each([
    ["Card ending 4321", "Card ending [number removed]"],
    ["**** 4321 Amazon", "[card number removed] Amazon"],
    ["A/c 50100012345678", "A/c [number removed]"],
    ["4111 1111 1111 1111", "[number removed]"],
    ["Call 9876543210", "Call [phone removed]"],
    ["mail me@example.co.in", "mail [email removed]"],
  ])("removes identifiers: %s", (input, expected) => {
    expect(ex.sanitizeText(input)).toBe(expected);
  });

  it("keeps years and amounts", () => {
    expect(ex.sanitizeText("Laptop 2026, 75000 over 12 months")).toBe("Laptop 2026, 75000 over 12 months");
  });
});

describe("export formats", () => {
  it("writes the plan CSV with quoting and defused formulas", async () => {
    const data = await ex.buildEmiExport(OPTIONS);
    data.plans[1].lender = "=HYPERLINK(1)";
    const lines = ex.plansCsv(data).trim().split("\r\n");
    expect(lines[0].split(",")[0]).toBe("emi_id");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"Phone, [card number removed] [email removed]"');
    expect(lines[2]).toContain("'=HYPERLINK(1)");
  });

  it("writes one monthly CSV row per month with the cash flow alongside", async () => {
    const data = await ex.buildEmiExport(OPTIONS);
    const lines = ex.monthlyCsv(data).trim().split("\r\n");
    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain("cumulative_surplus_or_deficit");
    expect(lines[3].startsWith("2026-12,2,2000,0,2000,EMI-02,")).toBe(true);
  });

  it("writes the four-sheet workbook", async () => {
    const data = await ex.buildEmiExport(OPTIONS);
    const wb = new ExcelJS.Workbook();
    const buf = await ex.exportXlsx(data);
    await wb.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      "EMI Overview",
      "Monthly Repayment Schedule",
      "Cash Flow Projection",
      "Summary & Key Metrics",
    ]);
    expect(wb.getWorksheet("EMI Overview")!.getRow(2).getCell(1).value).toBe("EMI-01");
    expect(wb.getWorksheet("Monthly Repayment Schedule")!.rowCount).toBe(7);
  });

  it("round-trips through JSON", async () => {
    const data = await ex.buildEmiExport(OPTIONS);
    expect(JSON.parse(ex.exportJson(data)).summary.projected_debt_free_date).toBe("2027-01-05");
  });
});
