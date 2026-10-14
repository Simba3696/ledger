import { useEffect, type RefObject } from "react";

/** After a failed attempt the form is enabled again with an error, but the
 * button that had focus was disabled meanwhile, so focus fell to the page.
 * It goes back to `field`, the one to correct; the error, an alert, is
 * still announced. */
export function useFocusOnError(error: string | null, busy: boolean, field: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (error && !busy) field.current?.focus();
  }, [error, busy, field]);
}
