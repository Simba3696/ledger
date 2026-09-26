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
// Rough menu height estimate (a handful of ~30px items plus padding) — good
// enough for a "will this clip off the bottom of the screen" decision;
// doesn't need to be exact since it only flips list-in the *other* direction.
const ESTIMATED_MENU_HEIGHT = 200;

export function OverflowMenu({ items, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useDismiss(containerRef, () => setOpen(false), open);

  function handleTriggerClick() {
    if (!open && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      // A row near the bottom of the viewport (or with the on-screen
      // keyboard open shrinking it) would otherwise render this dropdown
      // partly or fully off-screen with no way to reach it.
      setOpenUpward(window.innerHeight - rect.bottom < ESTIMATED_MENU_HEIGHT);
    }
    setOpen((o) => !o);
  }

  return (
    <div className="overflow-menu" ref={containerRef}>
      <button
        type="button"
        className="overflow-menu-trigger"
        onClick={handleTriggerClick}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
      >
        ⋮
      </button>
      {open && (
        <ul className={`overflow-menu-list${openUpward ? " upward" : ""}`} role="menu">
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
