import type { DebtEntry } from "../api";
import { OverflowMenu } from "./OverflowMenu";
import { rupee } from "../format";

interface Props {
  debt: DebtEntry;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export function DebtRow({ debt, busy, onEdit, onDelete }: Props) {
  const direction = debt.amount > 0 ? "you owe" : debt.amount < 0 ? "owed to you" : "settled";

  return (
    <li className="debt-row">
      <span className="debt-name">{debt.name}</span>
      <span className={`debt-amount${debt.amount > 0 ? " owe" : debt.amount < 0 ? " owed" : ""}`}>
        {rupee.format(Math.abs(debt.amount))}
        <span className="debt-direction">{direction}</span>
      </span>
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
