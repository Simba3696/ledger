import { useState } from "react";
import { updateDebt, type DebtEntry } from "../api";
import { SignedAmountInput } from "./SignedAmountInput";

interface Props {
  debt: DebtEntry;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}

export function EditDebtRow({ debt, onCancel, onSaved }: Props) {
  const [name, setName] = useState(debt.name);
  const [amount, setAmount] = useState(String(debt.amount));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim().length > 0 && amount.trim() !== "" && Number.isFinite(Number(amount)) && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await updateDebt(debt.row, { name: name.trim(), amount: Number(amount) });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <li className="debt-row row-editing">
      <div className="edit-fields">
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
        <SignedAmountInput
          value={amount}
          onChange={setAmount}
          positiveLabel="You owe"
          negativeLabel="Owed to you"
          placeholder="Amount"
        />
      </div>

      {error && <p className="error">{error}</p>}

      <div className="edit-actions">
        <button type="button" className="submit-btn" onClick={handleSave} disabled={!canSave}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </li>
  );
}
