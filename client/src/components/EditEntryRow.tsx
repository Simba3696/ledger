import { useState } from "react";
import type { Category, CategoryOption, LedgerEntry } from "../api";
import { updateEntry } from "../api";
import { CategoryPicker } from "./CategoryPicker";
import { PaymentToggle } from "./PaymentToggle";

interface Props {
  entry: LedgerEntry;
  categories: CategoryOption[];
  year: number;
  month: number;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}

export function EditEntryRow({ entry, categories, year, month, onCancel, onSaved }: Props) {
  const [amount, setAmount] = useState(String(entry.amount));
  const [remarks, setRemarks] = useState(entry.remarks);
  const [category, setCategory] = useState<Category>(entry.category ?? "other");
  const [isCard, setIsCard] = useState(entry.isCard);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = Number(amount) > 0 && remarks.trim().length > 0 && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await updateEntry(year, month, entry.row, {
        amount: Number(amount),
        remarks: remarks.trim(),
        category,
        isCard,
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
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <input type="text" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        <CategoryPicker categories={categories} value={category} onChange={setCategory} />
        <PaymentToggle isCard={isCard} onChange={setIsCard} />
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
