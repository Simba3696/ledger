import { useEffect, type RefObject } from "react";

/** Calls `onDismiss` when the user clicks/taps outside `ref`'s element or
 * presses Escape — the standard way to close a popover/menu. No-ops while
 * `enabled` is false, so callers can pass e.g. `open` directly. */
export function useDismiss(ref: RefObject<HTMLElement | null>, onDismiss: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    function handlePointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onDismiss();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onDismiss();
    }

    // `pointerdown`, not `mousedown` — mobile Safari's synthetic mouse-event
    // chain after a tap is unreliable on elements that aren't themselves
    // "clickable" (no onclick/cursor:pointer), which is exactly what most of
    // this app's row content is. Same category of bug as native
    // drag-and-drop never firing on mobile Safari, fixed the same way
    // elsewhere in this app: use Pointer Events instead.
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [ref, onDismiss, enabled]);
}
