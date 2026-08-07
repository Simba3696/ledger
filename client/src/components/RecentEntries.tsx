import { useState, type PointerEvent as ReactPointerEvent } from "react";
import type { LedgerEntry, CategoryOption } from "../api";
import { addEntry, deleteEntry, moveEntry } from "../api";
import { EditEntryRow } from "./EditEntryRow";
import { EntryRow } from "./EntryRow";
import { LoadingOverlay } from "./LoadingOverlay";
import { rupee } from "../format";
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

  async function handleCopy(entry: LedgerEntry) {
    if (!entry.category) {
      setError("Can't copy this entry — its category color isn't recognized.");
      return;
    }
    setBusyRow(entry.row);
    setError(null);
    try {
      // A "copy" is just a fresh append with the same values — it lands at
      // the end of the list as its own independent entry, never linked back
      // to the original, ready to tweak (e.g. a slightly different price).
      await addEntry({
        year,
        month,
        amount: entry.amount,
        remarks: entry.remarks,
        category: entry.category,
        isCard: entry.isCard,
      });
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyRow(null);
    }
  }

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

  async function handleDrop(fromRow: number, targetRow: number) {
    if (fromRow === targetRow) return;

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

  // Keyboard/menu fallback for reordering, since the drag handle is
  // aria-hidden and pointer-only — this is the only way to reorder without a
  // mouse or a working touch drag. `entries` is oldest-first (matching sheet
  // row order) but displayed reversed (newest first), so "up" in the visual
  // list means swapping with the *next-higher* row number, and "down" means
  // the *next-lower* one — same adjacent-swap moveEntry already does for drag.
  const byRowAsc = [...entries].sort((a, b) => a.row - b.row);
  function neighborRow(row: number, direction: "up" | "down"): number | null {
    const idx = byRowAsc.findIndex((e) => e.row === row);
    if (idx === -1) return null;
    const targetIdx = direction === "up" ? idx + 1 : idx - 1;
    return targetIdx >= 0 && targetIdx < byRowAsc.length ? byRowAsc[targetIdx].row : null;
  }
  function handleMove(row: number, direction: "up" | "down") {
    const target = neighborRow(row, direction);
    if (target != null) handleDrop(row, target);
  }

  // Pointer Events (not the HTML5 drag-and-drop API) so reordering works with
  // touch input — native `draggable`/`ondragstart` never fires on mobile
  // Safari/Chrome, which is why the handle was unresponsive on phones.
  function handleHandlePointerDown(e: ReactPointerEvent<HTMLSpanElement>, row: number) {
    if (!canDrag) return;
    e.preventDefault();
    setDraggedRow(row);

    const rowAt = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-row]");
      return el ? Number(el.dataset.row) : null;
    };

    const onMove = (ev: globalThis.PointerEvent) => {
      setDragOverRow(rowAt(ev.clientX, ev.clientY));
    };

    const finish = (ev: globalThis.PointerEvent | null) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      setDraggedRow(null);
      setDragOverRow(null);
      const targetRow = ev ? rowAt(ev.clientX, ev.clientY) : null;
      if (targetRow != null) handleDrop(row, targetRow);
    };
    const onUp = (ev: globalThis.PointerEvent) => finish(ev);
    const onCancel = () => finish(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  return (
    <div className="recent-entries">
      <LoadingOverlay active={loading} />

      <div className="recent-header">
        <h2>Entries this month</h2>
        <span className="total">{rupee.format(total)}</span>
      </div>

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
              isDragging={draggedRow === entry.row}
              canDrag={canDrag}
              onHandlePointerDown={(e) => handleHandlePointerDown(e, entry.row)}
              canMoveUp={canDrag && neighborRow(entry.row, "up") != null}
              canMoveDown={canDrag && neighborRow(entry.row, "down") != null}
              onMoveUp={() => handleMove(entry.row, "up")}
              onMoveDown={() => handleMove(entry.row, "down")}
              onCopy={() => handleCopy(entry)}
              onEdit={() => setEditingRow(entry.row)}
              onDelete={() => handleDelete(entry.row)}
            />
          )
        )}
      </ul>
    </div>
  );
}
