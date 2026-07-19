import { useState } from "react";
import type { Category } from "../api";

interface ExpenseFieldsInit {
  amount?: number;
  remarks?: string;
  category?: Category | null;
  isCard?: boolean;
}

/** Shared amount/remarks/category/isCard field state + validity, used by both
 * AddExpenseForm (starts empty, resets after a successful submit) and
 * EditEntryRow (starts pre-filled from the entry being edited, never resets). */
export function useExpenseFields(init: ExpenseFieldsInit = {}) {
  const [amount, setAmount] = useState(init.amount !== undefined ? String(init.amount) : "");
  const [remarks, setRemarks] = useState(init.remarks ?? "");
  const [category, setCategory] = useState<Category | null>(init.category ?? null);
  const [isCard, setIsCard] = useState(init.isCard ?? false);

  const isValid = Number(amount) > 0 && remarks.trim().length > 0 && category !== null;

  function reset() {
    setAmount("");
    setRemarks("");
    setCategory(null);
    setIsCard(false);
  }

  return { amount, setAmount, remarks, setRemarks, category, setCategory, isCard, setIsCard, isValid, reset };
}
