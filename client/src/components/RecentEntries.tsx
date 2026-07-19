import { useState } from "react";
import type { LedgerEntry, CategoryOption } from "../api";
import { deleteEntry, moveEntry } from "../api";
import { EditEntryRow } from "./EditEntryRow";
import { EntryRow } from "./EntryRow";
import "./RecentEntries.css";

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
        {[...entries].reverse().map((entry) =>
          editingRow === entry.row ? (
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
          ) : (
            <EntryRow
              key={entry.row}
              entry={entry}
              label={labelFor(entry.category)}
              amountText={rupee.format(entry.amount)}
              editable={editable}
              busy={busyRow === entry.row}
              isDragOver={dragOverRow === entry.row}
              canDrag={canDrag}
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
              onEdit={() => setEditingRow(entry.row)}
              onDelete={() => handleDelete(entry.row)}
            />
          )
        )}
      </ul>
    </div>
  );
}
