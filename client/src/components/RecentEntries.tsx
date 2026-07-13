import { useState } from "react";
import type { LedgerEntry, CategoryOption } from "../api";
import { deleteEntry, moveEntry } from "../api";
import { CATEGORY_SWATCH } from "../categoryColors";
import { EditEntryRow } from "./EditEntryRow";

interface Props {
  entries: LedgerEntry[];
  categories: CategoryOption[];
  loading: boolean;
  year: number;
  month: number;
  editable: boolean;
  onChanged: () => Promise<void>;
}

const rupee = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});

export function RecentEntries({ entries, categories, loading, year, month, editable, onChanged }: Props) {
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [busyRow, setBusyRow] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draggedRow, setDraggedRow] = useState<number | null>(null);
  const [dragOverRow, setDragOverRow] = useState<number | null>(null);

  const labelFor = (id: LedgerEntry["category"]) =>
    categories.find((c) => c.id === id)?.label ?? "Uncategorized";

  const total = entries.reduce((sum, e) => sum + e.amount, 0);
  const canDrag = editable && busyRow === null;

  async function handleDelete(row: number) {
    if (!window.confirm("Delete this entry? This edits the Excel file directly and can't be undone from here.")) {
      return;
    }
    setBusyRow(row);
    setError(null);
    try {
      await deleteEntry(year, month, row);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyRow(null);
    }
  }

  async function handleDrop(targetRow: number) {
    const fromRow = draggedRow;
    setDraggedRow(null);
    setDragOverRow(null);
    if (fromRow == null || fromRow === targetRow) return;

    setBusyRow(fromRow);
    setError(null);
    try {
      await moveEntry(year, month, fromRow, targetRow);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyRow(null);
    }
  }

  return (
    <div className="recent-entries">
      <div className="recent-header">
        <h2>Entries this month</h2>
        <span className="total">{rupee.format(total)}</span>
      </div>

      {loading && <p>Loading…</p>}
      {!loading && entries.length === 0 && <p className="empty">No entries yet.</p>}
      {error && <p className="error">{error}</p>}

      <ul>
        {[...entries].reverse().map((entry) => {
          if (editingRow === entry.row) {
            return (
              <EditEntryRow
                key={entry.row}
                entry={entry}
                categories={categories}
                year={year}
                month={month}
                onCancel={() => setEditingRow(null)}
                onSaved={async () => {
                  setEditingRow(null);
                  await onChanged();
                }}
              />
            );
          }

          const swatch = entry.category ? CATEGORY_SWATCH[entry.category] : null;
          const busy = busyRow === entry.row;
          return (
            <li
              key={entry.row}
              className={`entry-row${dragOverRow === entry.row ? " drag-over" : ""}`}
              draggable={canDrag}
              onDragStart={() => setDraggedRow(entry.row)}
              onDragOver={(e) => {
                if (!canDrag) return;
                e.preventDefault();
                if (dragOverRow !== entry.row) setDragOverRow(entry.row);
              }}
              onDragLeave={() => setDragOverRow((r) => (r === entry.row ? null : r))}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(entry.row);
              }}
              onDragEnd={() => {
                setDraggedRow(null);
                setDragOverRow(null);
              }}
            >
              {editable && (
                <span className="drag-handle" aria-hidden="true" title="Drag to reorder">
                  ⠿
                </span>
              )}
              <span
                className="entry-category"
                style={swatch ? { background: swatch.bg, color: swatch.fg } : undefined}
              >
                {labelFor(entry.category)}
              </span>
              <span className="entry-remarks">{entry.remarks}</span>
              {entry.isCard && <span className="entry-cc">CC</span>}
              <span className="entry-amount">{rupee.format(entry.amount)}</span>
              {editable && (
                <span className="entry-actions">
                  <button type="button" onClick={() => setEditingRow(entry.row)} disabled={busy}>
                    Edit
                  </button>
                  <button type="button" onClick={() => handleDelete(entry.row)} disabled={busy}>
                    {busy ? "…" : "Delete"}
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
