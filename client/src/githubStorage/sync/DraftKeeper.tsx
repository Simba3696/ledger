import { Component, createRef, type ReactNode } from "react";
import { FormDrafts, type DraftActions, type DraftMutation, type DraftNode } from "./drafts";

// The DOM side of drafts.ts (#13): a container around the part of the
// GitHub tree SyncHost re-keys, mounted once for the life of the ledger, so
// it sees each remount: a remote join's, and a sync-bar write's at the same
// revision (#16). It passes the person's events and the DOM's changes to
// FormDrafts, captures just before the tree under it is replaced
// (getSnapshotBeforeUpdate, when SyncLayers' key for it moves), and
// restores once the new tree has committed, retrying while sections load.
// It never holds or delays the remount: the fence's revision on screen is
// SyncHost's as before.

/** The events FormDrafts reads, caught on the way down. */
const EVENTS = ["focusin", "pointerdown", "keydown", "input", "change", "click", "submit"] as const;
/** How often a restore under way looks again, besides each DOM change. */
const RETRY_MS = 100;

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** The real page. A value goes through the element's own setter, so
 * React's value tracking sees a change, then the event React reads it from. */
const domActions: DraftActions = {
  setValue(node, value) {
    const el = node as unknown as Control;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  },
  click(node) {
    (node as unknown as HTMLElement).click();
  },
  focus(node, start, end) {
    const el = node as unknown as HTMLInputElement;
    el.focus({ preventScroll: true });
    if (start === null || end === null) return;
    try {
      el.setSelectionRange(start, end);
    } catch {
      // A number or date input has no selection to set.
    }
  },
  focusFree() {
    const active = document.activeElement;
    return active === null || active === document.body || !active.isConnected;
  },
};

export class DraftKeeper extends Component<{ /** SyncLayers' key for the tree under it. */ tree: string; children?: ReactNode }> {
  readonly root = createRef<HTMLDivElement>();
  readonly drafts = new FormDrafts(domActions);
  #observer: MutationObserver | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #soon: ReturnType<typeof setTimeout> | null = null;

  #onEvent = (e: Event) => {
    if (e.target instanceof Element) this.drafts.event(e.type, e.target as unknown as DraftNode, e.isTrusted);
  };

  componentDidMount() {
    const root = this.root.current;
    if (!root) return;
    for (const type of EVENTS) root.addEventListener(type, this.#onEvent, true);
    this.#observer = new MutationObserver((records) => {
      this.drafts.mutations(records as unknown as DraftMutation[]);
      this.#stepSoon();
    });
    this.#observer.observe(root, { childList: true, subtree: true });
  }

  componentWillUnmount() {
    const root = this.root.current;
    if (root) for (const type of EVENTS) root.removeEventListener(type, this.#onEvent, true);
    this.#observer?.disconnect();
    this.#observer = null;
    this.#stopTimer();
  }

  getSnapshotBeforeUpdate(prev: Readonly<{ tree: string }>): null {
    const root = this.root.current;
    if (root && prev.tree !== this.props.tree) {
      this.drafts.beforeRemount(root as unknown as DraftNode, document.activeElement as unknown as DraftNode | null);
    }
    return null;
  }

  componentDidUpdate(prev: Readonly<{ tree: string }>) {
    if (prev.tree === this.props.tree) return;
    this.drafts.afterRemount(Date.now());
    // Not from here: this runs inside React's commit, where an input event
    // is handled but its state isn't applied, so React puts the field's old
    // value back (the change lands later, after the focus and caret were
    // set). Just after the commit, React applies each change at once, and
    // the first step comes before any key the person presses next.
    queueMicrotask(() => this.#step());
  }

  /** The next step, in a task of its own. A click's update is rendered in
   * a microtask, so a step run straight after another (from a microtask
   * queued earlier) would act before the component re-rendered: a sign
   * toggle restored, then the amount typed against the old sign. */
  #stepSoon() {
    if (this.#soon !== null) return;
    this.#soon = setTimeout(() => {
      this.#soon = null;
      this.#step();
    }, 0);
  }

  #step() {
    const root = this.root.current;
    const waiting = root !== null && this.drafts.step(root as unknown as DraftNode, Date.now());
    if (waiting && this.#timer === null) this.#timer = setInterval(() => this.#step(), RETRY_MS);
    else if (!waiting) this.#stopTimer();
  }

  #stopTimer() {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#soon !== null) clearTimeout(this.#soon);
    this.#soon = null;
  }

  render() {
    // display: contents: the container adds no box, so the Ledger lays
    // out as it did.
    return (
      <div className="sync-ledger" style={{ display: "contents" }} ref={this.root}>
        {this.props.children}
      </div>
    );
  }
}
