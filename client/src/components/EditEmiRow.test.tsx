// @vitest-environment jsdom
// Component test: jsdom for this file only; the rest of the client suite
// runs in Node.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditEmiRow } from "./EditEmiRow";
import { makeEmi } from "../testUtils";
import { updateEmi } from "../api";

vi.mock("../api", () => ({ updateEmi: vi.fn() }));
const updateEmiMock = vi.mocked(updateEmi);

beforeEach(() => {
  updateEmiMock.mockReset();
});

function renderEdit(onSaved = vi.fn().mockResolvedValue(undefined)) {
  const emi = makeEmi({ row: 39, cardOrBank: "Moneyview", emiAmount: 4387, dueDay: 5, totalAmount: 105411, remaining: 100900, remarks: "", interestRate: 27.9, foreclosureCharge: 0 });
  render(
    <ul>
      <EditEmiRow emi={emi} onCancel={vi.fn()} onSaved={onSaved} />
    </ul>,
  );
  return { onSaved };
}

afterEach(() => {
  cleanup();
});

describe("EditEmiRow", () => {
  it("saves the pre-filled values unchanged, leaving Payments left blank so the stored end date is kept", async () => {
    updateEmiMock.mockResolvedValue(makeEmi());
    const { onSaved } = renderEdit();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateEmiMock).toHaveBeenCalledWith(39, {
      cardOrBank: "Moneyview",
      emiAmount: 4387,
      dueDay: 5,
      totalAmount: 105411,
      remarks: "",
      remainingAsOf: 100900,
      durationMonths: null,
      interestRate: 27.9,
      foreclosureCharge: 0,
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("sends the number typed into Payments left, and a changed due day", async () => {
    updateEmiMock.mockResolvedValue(makeEmi());
    renderEdit();
    const dueDay = screen.getByPlaceholderText("Due Day");
    await userEvent.clear(dueDay);
    await userEvent.type(dueDay, "6");
    await userEvent.type(screen.getByPlaceholderText("Payments left"), "24");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateEmiMock).toHaveBeenCalledWith(39, expect.objectContaining({ dueDay: 6, durationMonths: 24 }));
  });

  it("clears the interest rate when its field is emptied", async () => {
    updateEmiMock.mockResolvedValue(makeEmi());
    renderEdit();
    await userEvent.clear(screen.getByPlaceholderText("Interest %"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateEmiMock).toHaveBeenCalledWith(39, expect.objectContaining({ interestRate: null, foreclosureCharge: 0 }));
  });

  it("won't save a due day outside 1-31", async () => {
    renderEdit();
    const dueDay = screen.getByPlaceholderText("Due Day");
    await userEvent.clear(dueDay);
    await userEvent.type(dueDay, "32");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the server's error and lets you try again", async () => {
    updateEmiMock.mockRejectedValue(new Error("Payments left must be a whole number (1-600)"));
    const { onSaved } = renderEdit();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Payments left must be a whole number (1-600)")).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
