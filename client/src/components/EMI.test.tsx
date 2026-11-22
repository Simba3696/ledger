import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EMI } from "./EMI";
import { makeEmi } from "../testUtils";
import { addEmi, getEmis } from "../api";

vi.mock("../api", () => ({
  getEmis: vi.fn(),
  addEmi: vi.fn(),
  updateEmi: vi.fn(),
  deleteEmi: vi.fn(),
  payEmi: vi.fn(),
  moveEmi: vi.fn(),
}));
const getEmisMock = vi.mocked(getEmis);
const addEmiMock = vi.mocked(addEmi);

const amazon = makeEmi({ row: 3, cardOrBank: "Amazon Pay", emiAmount: 4770, remaining: 71000, totalAmount: 95000, estimatedPayoffMonth: "2028-03", estimatedPayoffDate: "2028-03-07" });
const oneCard = makeEmi({ row: 4, cardOrBank: "OneCard", emiAmount: 4922, remaining: 4922, totalAmount: 41320, estimatedPayoffMonth: "2027-01", estimatedPayoffDate: "2027-01-08" });
const kuri = makeEmi({ row: 5, cardOrBank: "Kuri", emiAmount: 5000, remaining: 25000, totalAmount: 50000, estimatedPayoffMonth: "2027-05", estimatedPayoffDate: "2027-05-10" });

function rowNames(): string[] {
  return Array.from(document.querySelectorAll(".emi-card")).map((el) => el.textContent ?? "");
}

beforeEach(() => {
  getEmisMock.mockReset();
  addEmiMock.mockReset();
});

describe("EMI tab", () => {
  it("lists EMIs by name and shows the totals, loan count and EMI-free date", async () => {
    getEmisMock.mockResolvedValue([kuri, oneCard, amazon]);
    render(<EMI />);
    await screen.findByText("OneCard");
    expect(rowNames()).toEqual(["Amazon Pay", "Kuri", "OneCard"]);
    const stat = (label: string) => screen.getByText(label).parentElement!;
    expect(within(stat("Active Loans")).getByText("3")).toBeTruthy();
    expect(within(stat("EMI-Free On")).getByText("7 Mar 2028")).toBeTruthy(); // the last loan to finish
  });

  it("sorts by Months Left, soonest first, then latest first on a second click", async () => {
    getEmisMock.mockResolvedValue([kuri, oneCard, amazon]);
    render(<EMI />);
    await screen.findByText("OneCard");
    const monthsLeft = screen.getByRole("button", { name: "Months Left" });
    await userEvent.click(monthsLeft);
    expect(rowNames()).toEqual(["OneCard", "Kuri", "Amazon Pay"]);
    await userEvent.click(monthsLeft);
    expect(rowNames()).toEqual(["Amazon Pay", "Kuri", "OneCard"]);
  });

  it("adds an EMI with Payments left, defaulting Current Balance to the total", async () => {
    getEmisMock.mockResolvedValue([]);
    addEmiMock.mockResolvedValue(makeEmi());
    render(<EMI />);
    await screen.findByText("No EMIs tracked yet.");

    await userEvent.type(screen.getByLabelText("Card / Bank"), "Kreditbee");
    await userEvent.type(screen.getByLabelText("EMI Amount (₹/mo)"), "9660");
    await userEvent.type(screen.getByLabelText("Due Day"), "8");
    await userEvent.type(screen.getByLabelText("Total Amount (₹)"), "125577");
    expect((screen.getByLabelText("Current Balance (₹)") as HTMLInputElement).value).toBe("125577");
    await userEvent.type(screen.getByLabelText("Payments left — optional"), "13");
    await userEvent.click(screen.getByRole("button", { name: "Add EMI" }));

    expect(addEmiMock).toHaveBeenCalledWith({
      cardOrBank: "Kreditbee",
      emiAmount: 9660,
      dueDay: 8,
      totalAmount: 125577,
      remarks: "",
      remainingAsOf: 125577,
      durationMonths: 13,
      interestRate: null,
      foreclosureCharge: null,
    });
    expect(getEmisMock).toHaveBeenCalledTimes(2); // reloaded after adding
  });

  it("keeps a Current Balance you typed yourself when Total Amount changes afterwards", async () => {
    getEmisMock.mockResolvedValue([]);
    render(<EMI />);
    await screen.findByText("No EMIs tracked yet.");
    const total = screen.getByLabelText("Total Amount (₹)");
    const balance = screen.getByLabelText("Current Balance (₹)") as HTMLInputElement;
    await userEvent.type(total, "12000");
    await userEvent.clear(balance);
    await userEvent.type(balance, "4000"); // backfilling a loan already partway through
    await userEvent.type(total, "5");
    expect(balance.value).toBe("4000");
  });

  it("shows the error when the EMIs can't be loaded", async () => {
    getEmisMock.mockRejectedValue(new Error("EMI.xlsx is missing its \"EMI\" sheet"));
    render(<EMI />);
    expect(await screen.findByText("EMI.xlsx is missing its \"EMI\" sheet")).toBeTruthy();
  });
});
