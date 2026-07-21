import { useEffect, type RefObject } from "react";

/** Calls `onDismiss` when the user clicks/taps outside `ref`'s element or
 * presses Escape — the standard way to close a popover/menu. No-ops while
 * `enabled` is false, so callers can pass e.g. `open` directly. */
export function useDismiss(ref: RefObject<HTMLElement | null>, onDismiss: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    function handlePointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onDismiss();
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [ref, onDismiss, enabled]);
}
