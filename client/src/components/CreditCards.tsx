import { useCallback, useEffect, useState } from "react";
import {
  getCreditCardBillsSummary,
  getMonthBills,
  setMonthBills,
  type CardBill,
  type MonthBillsSummary,
} from "../api";
import { LoadingOverlay } from "./LoadingOverlay";
import { rupee } from "../format";
import { generateId } from "../id";
import "./CreditCards.css";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface Props {
  year: number;
  month: number;
}

interface CardRow {
  id: string;
  name: string;
  due: string;
  paid: string;
  /** Native <input type="date"> value format (YYYY-MM-DD) or "". */
  dueDate: string;
}

function toRows(cards: CardBill[]): CardRow[] {
  return cards.map((c) => ({
    id: generateId(),
    name: c.name,
    due: String(c.due),
    paid: String(c.paid),
    dueDate: c.dueDate ?? "",
  }));
}

function formatDate(date: string | null): string {
  if (!date) return "—";
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

interface CardsEditorProps {
  rows: CardRow[];
  onChange: (rows: CardRow[]) => void;
  disabled: boolean;
}

function CardsEditor({ rows, onChange, disabled }: CardsEditorProps) {
  function updateRow(id: string, patch: Partial<CardRow>) {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeRow(id: string) {
    onChange(rows.filter((r) => r.id !== id));
  }
  function addRow() {
    onChange([...rows, { id: generateId(), name: "", due: "", paid: "", dueDate: "" }]);
  }

  return (
    <div className="cards-editor">
      {rows.map((row) => (
        <div className="card-row-fields" key={row.id}>
          <input
            type="text"
            placeholder="Card / loan name"
            value={row.name}
            onChange={(e) => updateRow(row.id, { name: e.target.value })}
            disabled={disabled}
          />
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            placeholder="Due"
            value={row.due}
            onChange={(e) => updateRow(row.id, { due: e.target.value })}
            disabled={disabled}
          />
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            placeholder="Paid"
            value={row.paid}
            onChange={(e) => updateRow(row.id, { paid: e.target.value })}
            disabled={disabled}
          />
          <input
            type="date"
            value={row.dueDate}
            onChange={(e) => updateRow(row.id, { dueDate: e.target.value })}
            disabled={disabled}
          />
          <button
            type="button"
            className="cards-remove"
            onClick={() => removeRow(row.id)}
            disabled={disabled}
            aria-label={`Remove ${row.name || "this card"}`}
          >
            ×
          </button>
        </div>
      ))}

      <button type="button" className="cards-add" onClick={addRow} disabled={disabled}>
        + Add card
      </button>
    </div>
  );
}

export function CreditCards({ year, month }: Props) {
  const [cardRows, setCardRows] = useState<CardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thisMonth, setThisMonth] = useState<MonthBillsSummary | null>(null);
  const [yearMonths, setYearMonths] = useState<MonthBillsSummary[]>([]);

  // Refreshes the computed stats panels only — never the card fields. Same
  // reasoning as Finances: re-deriving the form from a fresh GET here could
  // resolve after the user already started typing (or right after a save)
  // and silently wipe their in-progress input.
  const loadStats = useCallback(async (): Promise<void> => {
    try {
      const yearSummary = await getCreditCardBillsSummary(year);
      setYearMonths(yearSummary);
      setThisMonth(yearSummary.find((m) => m.month === month) ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [year, month]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      const [bills] = await Promise.all([getMonthBills(year, month), loadStats()]);
      if (cancelled) return;
      setCardRows(toRows(bills.cards));
      setLoading(false);
    })().catch((err) => {
      if (!cancelled) {
        setError((err as Error).message);
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [year, month, loadStats]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const cards: CardBill[] = cardRows
        .filter((r) => r.name.trim() !== "" || r.due.trim() !== "" || r.paid.trim() !== "")
        .map((r) => ({
          name: r.name.trim(),
          due: Number(r.due || 0),
          paid: Number(r.paid || 0),
          dueDate: r.dueDate || null,
        }));
      await setMonthBills(year, month, cards);
      await loadStats();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const stats = thisMonth
    ? [
        { label: "Total Due", value: rupee.format(thisMonth.totalDue) },
        { label: "Total Paid", value: rupee.format(thisMonth.totalPaid) },
        { label: "Earliest Due Date", value: formatDate(thisMonth.earliestDueDate) },
        {
          label: thisMonth.overpaidOrSaved < 0 ? "Overpaid" : "Saved",
          value: rupee.format(Math.abs(thisMonth.overpaidOrSaved)),
          negative: thisMonth.overpaidOrSaved < 0,
        },
      ]
    : [];

  const yearTotalDue = yearMonths.reduce((sum, m) => sum + m.totalDue, 0);
  const yearTotalPaid = yearMonths.reduce((sum, m) => sum + m.totalPaid, 0);
  const yearOverpaidOrSaved = yearTotalDue - yearTotalPaid;
  const yearStats = yearMonths.length
    ? [
        { label: "Total Spent This Year", value: rupee.format(yearTotalDue) },
        { label: "Total Paid This Year", value: rupee.format(yearTotalPaid) },
        {
          label: yearOverpaidOrSaved < 0 ? "Net Overpaid This Year" : "Net Saved This Year",
          value: rupee.format(Math.abs(yearOverpaidOrSaved)),
          negative: yearOverpaidOrSaved < 0,
        },
      ]
    : [];

  return (
    <div className="credit-cards">
      <h2>
        {MONTH_NAMES[month - 1]} {year}
      </h2>

      <form className="cards-form" onSubmit={handleSave}>
        <CardsEditor rows={cardRows} onChange={setCardRows} disabled={loading} />

        {error && <p className="error">{error}</p>}

        <button type="submit" className="submit-btn" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </form>

      <div className="cards-stats-wrap">
        <LoadingOverlay active={loading} />

        {thisMonth && (
          <div className="cards-stats cards-month-stats">
            {stats.map((s) => (
              <div className="cards-stat" key={s.label}>
                <span>{s.label}</span>
                <strong className={"negative" in s && s.negative ? "negative" : undefined}>{s.value}</strong>
              </div>
            ))}
          </div>
        )}

        {yearStats.length > 0 && (
          <div className="cards-stats cards-year-stats">
            {yearStats.map((s) => (
              <div className="cards-stat" key={s.label}>
                <span>{s.label}</span>
                <strong className={"negative" in s && s.negative ? "negative" : undefined}>{s.value}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
