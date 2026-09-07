import { useState } from "react";
import type { Category, CategoryOption } from "../api";
import { CategoryPicker } from "./CategoryPicker";
import { PaymentToggle } from "./PaymentToggle";
import { useExpenseFields } from "../hooks/useExpenseFields";
import "./AddExpenseForm.css";

interface Props {
  categories: CategoryOption[];
  /** True once the viewed month is locked — disables every field and the
   * submit button at once (a plain <fieldset disabled>) rather than gating
   * each input individually. */
  disabled?: boolean;
  onSubmit: (input: {
    amount: number;
    remarks: string;
    category: Category;
    isCard: boolean;
  }) => Promise<void>;
}

export function AddExpenseForm({ categories, disabled = false, onSubmit }: Props) {
  const fields = useExpenseFields();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = fields.isValid && !submitting && !disabled;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || fields.category === null) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        amount: Number(fields.amount),
        remarks: fields.remarks.trim(),
        category: fields.category,
        isCard: fields.isCard,
      });
      fields.reset();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="add-expense-form" onSubmit={handleSubmit}>
      <fieldset disabled={disabled}>
        <div className="field-row">
          <label>
            Amount (₹)
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={fields.amount}
              onChange={(e) => fields.setAmount(e.target.value)}
              placeholder="0.00"
              required
            />
          </label>
          <label>
            Remarks
            <input
              type="text"
              value={fields.remarks}
              onChange={(e) => fields.setRemarks(e.target.value)}
              placeholder="What was this for?"
              required
            />
          </label>
        </div>

        <div className="field-row">
          <CategoryPicker categories={categories} value={fields.category} onChange={fields.setCategory} />
          <PaymentToggle isCard={fields.isCard} onChange={fields.setIsCard} />
        </div>

        {error && <p className="error">{error}</p>}

        <button type="submit" className="submit-btn" disabled={!canSubmit}>
          {submitting ? "Saving…" : "Add Expense"}
        </button>
      </fieldset>
    </form>
  );
}
