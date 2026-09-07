import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
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
  settled: boolean;
}

function toRows(cards: CardBill[]): CardRow[] {
  return cards.map((c) => ({
    id: generateId(),
    name: c.name,
    due: String(c.due),
    paid: String(c.paid),
    dueDate: c.dueDate ?? "",
    settled: c.settled,
  }));
}

/** Compares rows by their actual field values, ignoring the client-only `id`
 * key — used to tell whether the form has unsaved changes. */
function rowsEqual(a: CardRow[], b: CardRow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => {
    const other = b[i];
    return (
      row.name === other.name &&
      row.due === other.due &&
      row.paid === other.paid &&
      row.dueDate === other.dueDate &&
      row.settled === other.settled
    );
  });
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

/** Moves the row with id `fromId` to sit where `toId` currently is — the
 * order here is exactly what gets persisted (Save sends `rows` as-is, and
 * setMonthBills stores it as JSON in that order), so a pure client-side
 * reorder is all that's needed; there's nothing server-side to update until
 * the user hits Save. */
function moveRow(rows: CardRow[], fromId: string, toId: string): CardRow[] {
  if (fromId === toId) return rows;
  const fromIdx = rows.findIndex((r) => r.id === fromId);
  const toIdx = rows.findIndex((r) => r.id === toId);
  if (fromIdx === -1 || toIdx === -1) return rows;
  const next = [...rows];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

function CardsEditor({ rows, onChange, disabled }: CardsEditorProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  function updateRow(id: string, patch: Partial<CardRow>) {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function removeRow(id: string) {
    onChange(rows.filter((r) => r.id !== id));
  }
  function addRow() {
    onChange([...rows, { id: generateId(), name: "", due: "", paid: "", dueDate: "", settled: false }]);
  }

  // Pointer Events (not the HTML5 drag-and-drop API) so reordering works
  // with touch input too — native `draggable`/`ondragstart` never fires on
  // mobile Safari/Chrome. Same approach as RecentEntries' drag handle.
  function handleHandlePointerDown(e: ReactPointerEvent<HTMLSpanElement>, id: string) {
    if (disabled) return;
    e.preventDefault();
    setDraggedId(id);

    const idAt = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-row-id]");
      return el?.dataset.rowId ?? null;
    };

    const onMove = (ev: globalThis.PointerEvent) => {
      setDragOverId(idAt(ev.clientX, ev.clientY));
    };

    const finish = (ev: globalThis.PointerEvent | null) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setDraggedId(null);
      setDragOverId(null);
      const targetId = ev ? idAt(ev.clientX, ev.clientY) : null;
      if (targetId) onChange(moveRow(rows, id, targetId));
    };
    const onUp = (ev: globalThis.PointerEvent) => finish(ev);
    const onCancel = () => finish(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  return (
    <div className="cards-editor">
      {rows.map((row) => (
        <div
          className={`card-row-fields${dragOverId === row.id ? " drag-over" : ""}${draggedId === row.id ? " dragging" : ""}`}
          key={row.id}
          data-row-id={row.id}
        >
          <span
            className="cards-drag-handle"
            aria-hidden="true"
            title="Drag to reorder"
            onPointerDown={disabled ? undefined : (e) => handleHandlePointerDown(e, row.id)}
          >
            ⠿
          </span>
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
          <label className="cards-settled">
            <input
              type="checkbox"
              checked={row.settled}
              onChange={(e) => updateRow(row.id, { settled: e.target.checked })}
              disabled={disabled}
            />
            Settled
          </label>
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
  // The last loaded-or-saved state, to tell whether Save has anything to do.
  const [savedRows, setSavedRows] = useState<CardRow[]>([]);
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
      const rows = toRows(bills.cards);
      setCardRows(rows);
      setSavedRows(rows);
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
          settled: r.settled,
        }));
      await setMonthBills(year, month, cards);
      await loadStats();
      setSavedRows(cardRows);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const isDirty = !rowsEqual(cardRows, savedRows);

  const stats = thisMonth
    ? [
        { label: "Total Due", value: rupee.format(thisMonth.totalDue) },
        { label: "Total Paid", value: rupee.format(thisMonth.totalPaid) },
        { label: "Earliest Due Date", value: formatDate(thisMonth.earliestDueDate) },
        {
          label: thisMonth.overpaidOrSaved < 0 ? "Overpaid" : "Saved",
          value: rupee.format(Math.abs(thisMonth.overpaidOrSaved)),
          negative: thisMonth.overpaidOrSaved < 0,
          positive: thisMonth.overpaidOrSaved > 0,
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
          positive: yearOverpaidOrSaved > 0,
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

        <button type="submit" className="submit-btn" disabled={saving || !isDirty}>
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
                <strong className={"negative" in s && s.negative ? "negative" : "positive" in s && s.positive ? "positive" : undefined}>
                  {s.value}
                </strong>
              </div>
            ))}
          </div>
        )}

        {yearStats.length > 0 && (
          <div className="cards-stats cards-year-stats">
            {yearStats.map((s) => (
              <div className="cards-stat" key={s.label}>
                <span>{s.label}</span>
                <strong className={"negative" in s && s.negative ? "negative" : "positive" in s && s.positive ? "positive" : undefined}>
                  {s.value}
                </strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
