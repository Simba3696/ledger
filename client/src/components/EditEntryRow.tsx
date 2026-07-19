import { useState } from "react";
import type { CategoryOption, LedgerEntry } from "../api";
import { updateEntry } from "../api";
import { CategoryPicker } from "./CategoryPicker";
import { PaymentToggle } from "./PaymentToggle";
import { useExpenseFields } from "../hooks/useExpenseFields";

interface Props {
  entry: LedgerEntry;
  categories: CategoryOption[];
  year: number;
  month: number;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}

export function EditEntryRow({ entry, categories, year, month, onCancel, onSaved }: Props) {
  const fields = useExpenseFields({
    amount: entry.amount,
    remarks: entry.remarks,
    category: entry.category ?? "other",
    isCard: entry.isCard,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = fields.isValid && !saving;

  async function handleSave() {
    if (!canSave || fields.category === null) return;
    setSaving(true);
    setError(null);
    try {
      await updateEntry(year, month, entry.row, {
        amount: Number(fields.amount),
        remarks: fields.remarks.trim(),
        category: fields.category,
        isCard: fields.isCard,
      });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <li className="entry-row entry-row-editing">
      <div className="edit-fields">
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          value={fields.amount}
          onChange={(e) => fields.setAmount(e.target.value)}
        />
        <input type="text" value={fields.remarks} onChange={(e) => fields.setRemarks(e.target.value)} />
        <CategoryPicker categories={categories} value={fields.category} onChange={fields.setCategory} />
        <PaymentToggle isCard={fields.isCard} onChange={fields.setIsCard} />
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
