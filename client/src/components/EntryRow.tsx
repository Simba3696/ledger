import type { DragEvent } from "react";
import type { LedgerEntry } from "../api";
import { CATEGORY_SWATCH } from "../categoryColors";
import { OverflowMenu } from "./OverflowMenu";

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
  onCopy: () => void;
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
  onCopy,
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
        <OverflowMenu
          disabled={busy}
          items={[
            { label: "Copy", icon: "📋", onClick: onCopy },
            { label: "Edit", icon: "✏️", onClick: onEdit },
            { label: "Delete", icon: "❌", onClick: onDelete, destructive: true },
          ]}
        />
      )}
    </li>
  );
}
