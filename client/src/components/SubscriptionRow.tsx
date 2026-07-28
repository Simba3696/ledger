import type { SubscriptionEntryComputed } from "../api";
import { OverflowMenu } from "./OverflowMenu";
import { rupee } from "../format";

interface Props {
  subscription: SubscriptionEntryComputed;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function SubscriptionRow({ subscription, busy, onEdit, onDelete }: Props) {
  return (
    <li className="subscription-row">
      <div className="subscription-main">
        <span className="subscription-service">{subscription.service}</span>
        <span className="subscription-card">{subscription.cardOrBank || "N/A"}</span>
      </div>
      <div className="subscription-figures">
        <span className="subscription-amount">
          {rupee.format(subscription.amount)} <span className="subscription-duration">/ {subscription.duration.toLowerCase()}</span>
        </span>
        <span className="subscription-expiry">Renews {formatDate(subscription.nextExpiry)}</span>
      </div>
      <OverflowMenu
        disabled={busy}
        items={[
          { label: "Edit", icon: "✏️", onClick: onEdit },
          { label: "Delete", icon: "❌", onClick: onDelete, destructive: true },
        ]}
      />
    </li>
  );
}
