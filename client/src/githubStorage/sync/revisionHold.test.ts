import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECHECK_MS, RevisionHold, SETTLE_MS, holdsView, isEditable } from "./revisionHold";

// SyncHost re-keys the shared Ledger on the integration revision, which
// remounts it. RevisionHold keeps the revision on screen while the person
// is editing inside it, and shows the newest once they stop. The client
// tests run without a DOM, so the DOM it reads is faked with plain objects.

/** A stand-in element: the parts isEditable and holdsView read. */
function el(tagName: string, extra: { type?: string; isContentEditable?: boolean } = {}): Element {
  return { tagName, isContentEditable: false, ...extra } as unknown as Element;
}

/** A stand-in container holding `inside`, with an open modal dialog or not. */
function container(inside: Element[], dialogOpen = false): Element {
  return {
    contains: (node: Element) => inside.includes(node),
    querySelector: (selector: string) => (dialogOpen && selector.includes("aria-modal") ? el("DIV") : null),
  } as unknown as Element;
}

describe("isEditable", () => {
  it("counts text fields, selects, text areas and contenteditable", () => {
    expect(isEditable(el("INPUT"))).toBe(true);
    expect(isEditable(el("INPUT", { type: "number" }))).toBe(true);
    expect(isEditable(el("INPUT", { type: "date" }))).toBe(true);
    expect(isEditable(el("INPUT", { type: "checkbox" }))).toBe(true);
    expect(isEditable(el("SELECT"))).toBe(true);
    expect(isEditable(el("TEXTAREA"))).toBe(true);
    expect(isEditable(el("DIV", { isContentEditable: true }))).toBe(true);
  });

  it("does not count buttons, links or the page", () => {
    for (const type of ["button", "submit", "reset", "image", "hidden"]) expect(isEditable(el("INPUT", { type })), type).toBe(false);
    expect(isEditable(el("BUTTON"))).toBe(false);
    expect(isEditable(el("A"))).toBe(false);
    expect(isEditable(el("BODY"))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});

describe("holdsView", () => {
  const field = el("INPUT");
  const button = el("BUTTON");
  const outside = el("INPUT");

  it("holds while focus is in an editable field inside the ledger", () => {
    expect(holdsView(container([field, button]), field)).toBe(true);
  });

  it("does not hold for a button inside, a field outside (the sync bar) or no focus", () => {
    expect(holdsView(container([field, button]), button)).toBe(false);
    expect(holdsView(container([field, button]), outside)).toBe(false);
    expect(holdsView(container([field, button]), null)).toBe(false);
    expect(holdsView(null, field)).toBe(false);
  });

  it("holds while a modal dialog (a confirm or prompt) is open inside the ledger", () => {
    expect(holdsView(container([button], true), button)).toBe(true);
    expect(holdsView(container([button], true), null)).toBe(true);
  });
});

describe("RevisionHold", () => {
  let editing: boolean;
  let shown: number[];
  let hold: RevisionHold;

  beforeEach(() => {
    vi.useFakeTimers();
    editing = false;
    shown = [];
    hold = new RevisionHold(0, () => editing, (rev) => shown.push(rev));
  });

  afterEach(() => {
    hold.dispose();
    vi.useRealTimers();
  });

  it("shows a new revision at once when nothing is being edited", () => {
    hold.offer(1);
    expect(shown).toEqual([1]);
    expect(hold.shown).toBe(1);
  });

  it("keeps the revision on screen while the person edits, and shows the newest once they stop", () => {
    editing = true;
    hold.offer(1);
    hold.offer(2);
    expect(shown).toEqual([]);
    expect(hold.shown).toBe(0);

    editing = false;
    hold.focusLeft();
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual([2]);
    expect(hold.shown).toBe(2);
  });

  it("does not show it while focus moves from one field of a form to the next", () => {
    editing = true;
    hold.offer(1);
    // Tabbing: focus leaves one field and is in the next when the hold looks.
    hold.focusLeft();
    vi.advanceTimersByTime(SETTLE_MS * 3);
    expect(shown).toEqual([]);

    hold.focusLeft();
    editing = false;
    vi.advanceTimersByTime(SETTLE_MS);
    expect(shown).toEqual([1]);
  });

  it("waits the full settle time after the last focus change", () => {
    editing = true;
    hold.offer(1);
    editing = false;
    hold.focusLeft();
    vi.advanceTimersByTime(SETTLE_MS - 100);
    hold.focusLeft();
    vi.advanceTimersByTime(SETTLE_MS - 100);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(shown).toEqual([1]);
  });

  it("looks again while holding, so a field removed without a focusout doesn't keep the old revision", () => {
    editing = true;
    hold.offer(1);
    vi.advanceTimersByTime(RECHECK_MS * 2);
    expect(shown).toEqual([]);
    editing = false;
    vi.advanceTimersByTime(RECHECK_MS);
    expect(shown).toEqual([1]);
    // Nothing held any more: no timer left running.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does nothing on a focus change when no revision is held", () => {
    hold.focusLeft();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(shown).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows a lower revision at once: a different engine, not a newer join", () => {
    hold.offer(3);
    editing = true;
    hold.offer(0);
    expect(shown).toEqual([3, 0]);
  });

  it("stops looking once disposed", () => {
    editing = true;
    hold.offer(1);
    hold.focusLeft();
    hold.dispose();
    editing = false;
    vi.advanceTimersByTime(RECHECK_MS * 2);
    expect(shown).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
