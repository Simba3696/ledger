import type { PointerEvent } from "react";
import type { LedgerEntry } from "../api";
import { OverflowMenu } from "./OverflowMenu";

interface Props {
  entry: LedgerEntry;
  label: string;
  swatch: { bg: string; fg: string } | null;
  amountText: string;
  editable: boolean;
  busy: boolean;
  isDragOver: boolean;
  isDragging: boolean;
  canDrag: boolean;
  onHandlePointerDown: (e: PointerEvent<HTMLSpanElement>) => void;
  /** Move up/down duplicate the drag handle's reorder via the overflow menu
   * — the handle is aria-hidden and pointer-only, so this is the only way to
   * reorder from a keyboard or if touch drag ever misbehaves on a phone. */
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function EntryRow({
  entry,
  label,
  swatch,
  amountText,
  editable,
  busy,
  isDragOver,
  isDragging,
  canDrag,
  onHandlePointerDown,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onCopy,
  onEdit,
  onDelete,
}: Props) {
  return (
    <li
      className={`entry-row${isDragOver ? " drag-over" : ""}${isDragging ? " dragging" : ""}`}
      style={swatch ? { background: swatch.bg, color: swatch.fg } : undefined}
      title={label}
      data-row={entry.row}
    >
      {editable && (
        <span
          className="drag-handle"
          aria-hidden="true"
          title="Drag to reorder"
          onPointerDown={canDrag ? onHandlePointerDown : undefined}
        >
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
            { label: "Move up", icon: "⬆️", onClick: onMoveUp, disabled: !canMoveUp },
            { label: "Move down", icon: "⬇️", onClick: onMoveDown, disabled: !canMoveDown },
            { label: "Copy", icon: "📋", onClick: onCopy },
            { label: "Edit", icon: "✏️", onClick: onEdit },
            { label: "Delete", icon: "❌", onClick: onDelete, destructive: true },
          ]}
        />
      )}
    </li>
  );
}
