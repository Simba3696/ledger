import { useRef, useState } from "react";
import { useDismiss } from "../hooks/useDismiss";
import "./OverflowMenu.css";

export interface OverflowMenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

interface Props {
  items: OverflowMenuItem[];
  disabled?: boolean;
}

/** A "⋮" trigger that reveals a small dropdown of actions. Generic — takes a
 * list of items rather than being specific to any one feature, so it's
 * reusable anywhere a row of actions would otherwise crowd the UI. */
export function OverflowMenu({ items, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useDismiss(containerRef, () => setOpen(false), open);

  return (
    <div className="overflow-menu" ref={containerRef}>
      <button
        type="button"
        className="overflow-menu-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
      >
        ⋮
      </button>
      {open && (
        <ul className="overflow-menu-list" role="menu">
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                className={`overflow-menu-item${item.destructive ? " destructive" : ""}`}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.icon && (
                  <span className="overflow-menu-item-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                )}
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
