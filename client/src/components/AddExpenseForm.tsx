import { useState } from "react";
import type { Category, CategoryOption } from "../api";
import { CategoryPicker } from "./CategoryPicker";
import { PaymentToggle } from "./PaymentToggle";

interface Props {
  categories: CategoryOption[];
  year: number;
  month: number;
  onSubmit: (input: {
    amount: number;
    remarks: string;
    category: Category;
    isCard: boolean;
  }) => Promise<void>;
}

export function AddExpenseForm({ categories, onSubmit }: Props) {
  const [amount, setAmount] = useState("");
  const [remarks, setRemarks] = useState("");
  const [category, setCategory] = useState<Category | null>(null);
  const [isCard, setIsCard] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    Number(amount) > 0 && remarks.trim().length > 0 && category !== null && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || category === null) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ amount: Number(amount), remarks: remarks.trim(), category, isCard });
      setAmount("");
      setRemarks("");
      setCategory(null);
      setIsCard(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="add-expense-form" onSubmit={handleSubmit}>
      <div className="field-row">
        <label>
          Amount (₹)
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            required
          />
        </label>
        <label>
          Remarks
          <input
            type="text"
            value={remarks}
            onChange={(e) => setRemarks(e.target.value)}
            placeholder="What was this for?"
            required
          />
        </label>
      </div>

      <div className="field-row">
        <CategoryPicker categories={categories} value={category} onChange={setCategory} />
        <PaymentToggle isCard={isCard} onChange={setIsCard} />
      </div>

      {error && <p className="error">{error}</p>}

      <button type="submit" className="submit-btn" disabled={!canSubmit}>
        {submitting ? "Saving…" : "Add Expense"}
      </button>
    </form>
  );
}
