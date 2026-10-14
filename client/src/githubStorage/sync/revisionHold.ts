// Which integration revision the shared Ledger shows (#7). SyncHost re-keys
// the Ledger on the revision, so a section reads again after another
// device's changes are joined; the remount also drops anything half typed.
// So while the person is editing inside the Ledger, the revision on screen
// is held, and the newest is shown once they stop.
//
// Holding is safe because of the stale-UI fence (backend/sync/fence.ts,
// design section 3.4): the engine is told only the revision actually on
// screen (SyncHost calls rendered() with the held one), and a write
// submitted from it is fenced by that revision. A field the person left as
// it was doesn't set back a change they hadn't seen, and one they typed over
// it is told in a notice.

/** How long focus must stay out of editable fields before the newest
 * revision is shown, so moving between the fields of one form doesn't. */
export const SETTLE_MS = 400;

/** While a revision is held, how often to look again: a field removed while
 * focused (a form that closed on save) sends no focusout. */
export const RECHECK_MS = 1500;

/** Input types that are buttons, not something being filled in. */
const NOT_EDITED = new Set(["button", "submit", "reset", "image", "hidden"]);

/** Whether `el` is a field the person types or picks a value in. */
export function isEditable(el: Element | null): boolean {
  if (!el) return false;
  switch (el.tagName) {
    case "TEXTAREA":
    case "SELECT":
      return true;
    case "INPUT":
      return !NOT_EDITED.has(((el as HTMLInputElement).type ?? "").toLowerCase());
    default:
      return (el as HTMLElement).isContentEditable === true;
  }
}

/** Whether the Ledger in `container` is being edited: focus is in an
 * editable field inside it, or a modal dialog (the app's confirm and prompt)
 * is open in it. A remount would drop either. */
export function holdsView(container: Element | null, active: Element | null): boolean {
  if (!container) return false;
  if (active && isEditable(active) && container.contains(active)) return true;
  return container.querySelector('[aria-modal="true"]') !== null;
}

/** Holds the revision on screen while `editing()` says so. `show` is called
 * with each revision to put on screen. */
export class RevisionHold {
  #shown: number;
  #latest: number;
  #settle: ReturnType<typeof setTimeout> | null = null;
  #recheck: ReturnType<typeof setInterval> | null = null;
  readonly #editing: () => boolean;
  readonly #show: (rev: number) => void;

  constructor(shown: number, editing: () => boolean, show: (rev: number) => void) {
    this.#shown = shown;
    this.#latest = shown;
    this.#editing = editing;
    this.#show = show;
  }

  /** The revision on screen. */
  get shown(): number {
    return this.#shown;
  }

  /** The engine is at `rev`. A lower one is another engine's, not a newer
   * join, and is shown at once. */
  offer(rev: number): void {
    this.#latest = rev;
    if (rev === this.#shown) return this.#stop();
    if (rev < this.#shown || !this.#editing()) return this.#apply();
    this.#recheck ??= setInterval(() => this.#check(), RECHECK_MS);
  }

  /** Focus left something inside the Ledger: once it has settled, show the
   * newest revision unless the person is still editing. */
  focusLeft(): void {
    if (this.#latest === this.#shown) return;
    if (this.#settle !== null) clearTimeout(this.#settle);
    this.#settle = setTimeout(() => {
      this.#settle = null;
      this.#check();
    }, SETTLE_MS);
  }

  /** Stops the timers (on unmount). */
  dispose(): void {
    this.#stop();
  }

  #check(): void {
    if (this.#latest !== this.#shown && !this.#editing()) this.#apply();
  }

  #apply(): void {
    this.#stop();
    this.#shown = this.#latest;
    this.#show(this.#latest);
  }

  #stop(): void {
    if (this.#settle !== null) clearTimeout(this.#settle);
    if (this.#recheck !== null) clearInterval(this.#recheck);
    this.#settle = null;
    this.#recheck = null;
  }
}
