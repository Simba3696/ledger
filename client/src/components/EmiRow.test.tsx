import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmiRow } from "./EmiRow";
import { makeEmi } from "../testUtils";
import { rupee } from "../format";
import type { EmiEntryComputed } from "../api";

function renderRow(emi: EmiEntryComputed) {
  const noop = vi.fn();
  return render(
    <ul>
      <EmiRow
        emi={emi}
        busy={false}
        onEdit={noop}
        onDelete={noop}
        onPaidThisMonth={noop}
        onRecordPayment={noop}
        onForeclose={noop}
      />
    </ul>,
  );
}

describe("EmiRow", () => {
  it("shows the loan's figures, balance date and finish month", () => {
    renderRow(makeEmi());
    expect(screen.getByText("Coral")).toBeTruthy();
    expect(screen.getByText("Phone")).toBeTruthy();
    expect(screen.getByText("50% paid")).toBeTruthy();
    expect(screen.getByText(`of ${rupee.format(12000)}`)).toBeTruthy();
    expect(screen.getByText(`${rupee.format(1000)}/mo, due 8th`)).toBeTruthy();
    expect(screen.getByText("Balance as of 2 Nov 2026")).toBeTruthy();
    expect(screen.getByText("Finishes ~May 2027")).toBeTruthy();
  });

  it.each([
    [1, "1st"],
    [2, "2nd"],
    [3, "3rd"],
    [11, "11th"],
    [12, "12th"],
    [13, "13th"],
    [21, "21st"],
    [22, "22nd"],
    [31, "31st"],
  ])("writes due day %i as %s", (dueDay, text) => {
    renderRow(makeEmi({ dueDay }));
    expect(screen.getByText(`${rupee.format(1000)}/mo, due ${text}`)).toBeTruthy();
  });

  it("shows the foreclosure payoff only when it differs from the remaining balance", () => {
    const { unmount } = renderRow(makeEmi());
    expect(screen.queryByText(/Foreclosure payoff/)).toBeNull();
    unmount();

    renderRow(makeEmi({ interestRate: 18, foreclosurePayoff: 5600 }));
    expect(screen.getByText(`Foreclosure payoff: ${rupee.format(5600)}`)).toBeTruthy();
  });

  it("shows a real 0% foreclosure fee rather than treating it as blank", () => {
    renderRow(makeEmi({ interestRate: 27.9, foreclosureCharge: 0 }));
    expect(screen.getByText("· 27.9% p.a.")).toBeTruthy();
    expect(screen.getByText("· 0% foreclosure fee")).toBeTruthy();
  });

  it("says Paid off instead of a finish month once the balance is gone", () => {
    renderRow(makeEmi({ remaining: 0, isPaidOff: true, estimatedPayoffMonth: null, estimatedPayoffDate: null }));
    expect(screen.getByText("Paid off")).toBeTruthy();
    expect(screen.queryByText(/Finishes/)).toBeNull();
    expect(screen.getByText("100% paid")).toBeTruthy();
  });
});
