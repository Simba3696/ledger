import type { DragEvent } from "react";
import type { LedgerEntry } from "../api";
import { CATEGORY_SWATCH } from "../categoryColors";

interface Props {
  entry: LedgerEntry;
  label: string;
  amountText: string;
  editable: boolean;
  busy: boolean;
  isDragOver: boolean;
  canDrag: boolean;
  onDragStart: () => void;
  onDragOver: (e: DragEvent<HTMLLIElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: DragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function EntryRow({
  entry,
  label,
  amountText,
  editable,
  busy,
  isDragOver,
  canDrag,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onEdit,
  onDelete,
}: Props) {
  const swatch = entry.category ? CATEGORY_SWATCH[entry.category] : null;

  return (
    <li
      className={`entry-row${isDragOver ? " drag-over" : ""}`}
      style={swatch ? { background: swatch.bg, color: swatch.fg } : undefined}
      title={label}
      draggable={canDrag}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      {editable && (
        <span className="drag-handle" aria-hidden="true" title="Drag to reorder">
          ⠿
        </span>
      )}
      <span className="entry-remarks">{entry.remarks}</span>
      {entry.isCard && <span className="entry-cc">CC</span>}
      <span className="entry-amount">{amountText}</span>
      {editable && (
        <span className="entry-actions">
          <button type="button" onClick={onEdit} disabled={busy}>
            Edit
          </button>
          <button type="button" onClick={onDelete} disabled={busy}>
            {busy ? "…" : "Delete"}
          </button>
        </span>
      )}
    </li>
  );
}
