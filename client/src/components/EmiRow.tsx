import type { EmiEntryComputed } from "../api";
import { OverflowMenu } from "./OverflowMenu";
import { rupee } from "../format";

interface Props {
  emi: EmiEntryComputed;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onPaidThisMonth: () => void;
  onRecordPayment: () => void;
  onForeclose: () => void;
}

function formatMonthYear(ym: string | null): string {
  if (!ym) return "—";
  const [year, month] = ym.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}

function ordinal(day: number): string {
  if (day >= 11 && day <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

export function EmiRow({ emi, busy, onEdit, onDelete, onPaidThisMonth, onRecordPayment, onForeclose }: Props) {
  return (
    <li className={`emi-row${emi.isPaidOff ? " paid-off" : ""}`}>
      <div className="emi-main">
        <span className="emi-card">{emi.cardOrBank}</span>
        {emi.remarks && <span className="emi-remarks">{emi.remarks}</span>}
      </div>
      <div className="emi-figures">
        <span className="emi-remaining">
          {rupee.format(emi.remaining)} <span className="emi-of-total">of {rupee.format(emi.totalAmount)}</span>
        </span>
        <span className="emi-schedule">
          {rupee.format(emi.emiAmount)}/mo, due {ordinal(emi.dueDay)}
        </span>
        <span className="emi-payoff">{emi.isPaidOff ? "Paid off" : `Finishes ~${formatMonthYear(emi.estimatedPayoffMonth)}`}</span>
      </div>
      <OverflowMenu
        disabled={busy}
        items={[
          { label: "Paid this month", icon: "✅", onClick: onPaidThisMonth, disabled: emi.isPaidOff },
          { label: "Record payment…", icon: "💰", onClick: onRecordPayment, disabled: emi.isPaidOff },
          { label: "Foreclose EMI", icon: "🏁", onClick: onForeclose },
          { label: "Edit", icon: "✏️", onClick: onEdit },
          { label: "Delete", icon: "❌", onClick: onDelete, destructive: true },
        ]}
      />
    </li>
  );
}
