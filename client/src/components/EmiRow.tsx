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

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
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
  // Foreclosure hint: how much of this loan is already behind you vs. what a
  // lump-sum payoff would still cost today (== `remaining`, shown separately
  // in the figures column). Comparing this percentage across loans — not
  // just the raw remaining amount — is what actually surfaces the best
  // "quick win" candidate: a loan that started small can have a low
  // remaining balance without being anywhere near paid off, and vice versa.
  const paidAmount = Math.max(0, emi.totalAmount - emi.remaining);
  const paidPercent = emi.totalAmount > 0 ? Math.min(100, (paidAmount / emi.totalAmount) * 100) : 0;

  return (
    <li className={`emi-row${emi.isPaidOff ? " paid-off" : ""}`}>
      <div className="emi-main">
        <span className="emi-card">{emi.cardOrBank}</span>
        {emi.remarks && <span className="emi-remarks">{emi.remarks}</span>}
        <div className="emi-progress" title={`${rupee.format(paidAmount)} paid of ${rupee.format(emi.totalAmount)}`}>
          <div className="emi-progress-track">
            <div className="emi-progress-fill" style={{ width: `${paidPercent}%` }} />
          </div>
          <span className="emi-progress-label">{paidPercent.toFixed(0)}% paid</span>
        </div>
      </div>
      <div className="emi-figures">
        <span className="emi-remaining">
          {rupee.format(emi.remaining)} <span className="emi-of-total">of {rupee.format(emi.totalAmount)}</span>
        </span>
        <span className="emi-schedule">
          {rupee.format(emi.emiAmount)}/mo, due {ordinal(emi.dueDay)}
          {emi.interestRate !== null && ` · ${emi.interestRate}% p.a.`}
          {emi.foreclosureCharge !== null && ` · ${emi.foreclosureCharge}% foreclosure fee`}
        </span>
        {/* The balance/decay anchor — everything since this date is an
            auto-projected assumption, not a confirmed payment. Shown so
            "Paid this month" isn't clicked for a cycle that's already
            covered by that assumption. */}
        <span className="emi-as-of">Balance as of {formatDate(emi.asOfDate)}</span>
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
