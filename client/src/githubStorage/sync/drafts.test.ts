import { describe, expect, it } from "vitest";
import { DRAFT_WINDOW_MS, FormDrafts, type DraftActions, type DraftMutation, type DraftNode } from "./drafts";

// #13: another device's change, once joined, remounts the shared Ledger
// (SyncHost re-keys it on the new revision), which cleared a half-typed
// form. FormDrafts keeps what the person typed across that remount: it
// notes the fields they changed, captures those (and the focus) just before
// the remount, and puts them back into the same fields of the new tree once
// they are there, only where the new revision still shows what the person
// started from. The client tests have no DOM, so the ledger here is a tree
// of fake elements with just what FormDrafts reads, and the "components"
// are click handlers on them. Fictional data only.

interface Props {
  class?: string;
  type?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  placeholder?: string;
  role?: string;
  "aria-haspopup"?: string;
  "aria-expanded"?: string;
  "aria-label"?: string;
  "data-row"?: string;
}

class El implements DraftNode {
  parentElement: El | null = null;
  children: El[] = [];
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  type?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  onClick?: () => void;
  readonly attrs = new Map<string, string>();
  readonly tagName: string;
  readonly ownText: string;
  constructor(tagName: string, ownText = "") {
    this.tagName = tagName;
    this.ownText = ownText;
  }
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  append(...kids: El[]): void {
    for (const kid of kids) {
      kid.parentElement = this;
      this.children.push(kid);
    }
  }
  replace(old: El, next: El): void {
    const at = this.children.indexOf(old);
    this.children[at] = next;
    next.parentElement = this;
    old.parentElement = null;
  }
  set(...kids: El[]): void {
    for (const kid of this.children) kid.parentElement = null;
    this.children = [];
    this.append(...kids);
  }
}

function h(tag: string, props: Props = {}, ...kids: (El | string)[]): El {
  const el = new El(tag.toUpperCase(), kids.filter((k): k is string => typeof k === "string").join(""));
  for (const [name, value] of Object.entries(props)) {
    if (name === "value") el.value = value as string;
    else if (name === "checked") el.checked = value as boolean;
    else if (name === "disabled") {
      el.disabled = value as boolean;
      if (value) el.attrs.set("disabled", "");
    } else {
      if (name === "type") el.type = value as string;
      el.attrs.set(name, String(value));
    }
  }
  if (el.tagName === "INPUT" && el.value === undefined) el.value = "";
  el.append(...kids.filter((k): k is El => typeof k !== "string"));
  return el;
}

/** Moves the "selected" class to `chosen`, as CategoryPicker and
 * PaymentToggle re-render after their onChange. */
function pick(chosen: El): void {
  for (const b of chosen.parentElement!.children) {
    const base = (b.getAttribute("class") ?? "").replace(/\bselected\b/, "").trim();
    b.attrs.set("class", b === chosen ? `${base} selected`.trim() : base);
  }
}

function choiceGroup(cls: string, labels: string[], selected: string | null, buttonClass = ""): El {
  const group = h("div", { class: cls }, ...labels.map((l) => h("button", { type: "button", class: `${buttonClass}${l === selected ? " selected" : ""}`.trim() }, l)));
  for (const b of group.children) b.onClick = () => pick(b);
  return group;
}

/** AddExpenseForm's shape: amount, remarks, category chips, Cash/Credit Card. */
function addExpenseForm(categories: string[] = ["Food", "Travel"]) {
  const amount = h("input", { type: "number", placeholder: "0.00" });
  const remarks = h("input", { type: "text", placeholder: "What was this for?" });
  const chips = choiceGroup("category-picker", categories, null, "category-chip");
  const payment = choiceGroup("payment-toggle", ["Cash", "Credit Card"], "Cash");
  const form = h(
    "form",
    { class: "add-expense-form" },
    h(
      "fieldset",
      {},
      h("div", { class: "field-row" }, h("label", {}, "Amount (₹)", amount), h("label", {}, "Remarks", remarks)),
      h("div", { class: "field-row" }, chips, payment),
      h("button", { type: "submit", class: "submit-btn" }, "Add Expense"),
    ),
  );
  const button = (group: El, label: string) => group.children.find((b) => b.textContent === label)!;
  return { form, amount, remarks, chips, payment, chip: (l: string) => button(chips, l), pay: (l: string) => button(payment, l) };
}

const selectedIn = (group: El) => group.children.find((b) => /\bselected\b/.test(b.getAttribute("class") ?? ""))?.textContent ?? null;

/** The ledger container SyncHost's keeper renders, holding `kids`. */
const ledger = (...kids: El[]) => h("div", { class: "sync-ledger" }, h("div", { class: "app" }, h("main", {}, ...kids)));
/** The remount: the old tree replaced by a new one. */
function remount(root: El, ...kids: El[]): void {
  root.set(h("div", { class: "app" }, h("main", {}, ...kids)));
}

/** Actions that record what FormDrafts did, and run the fake components. */
function fakeActions({ focusFree = () => true }: { focusFree?: () => boolean } = {}) {
  const done: string[] = [];
  const actions: DraftActions & { done: string[]; focused: { el: DraftNode; start: number | null; end: number | null } | null } = {
    done,
    focused: null,
    setValue(el, value) {
      (el as El).value = value;
      done.push(`set ${value}`);
    },
    click(el) {
      const e = el as El;
      done.push(`click ${e.textContent || e.getAttribute("aria-label") || e.tagName}`);
      if (e.type === "checkbox") e.checked = !e.checked;
      e.onClick?.();
    },
    focus(el, start, end) {
      actions.focused = { el, start, end };
    },
    focusFree,
  };
  return actions;
}

/** The person types `value` into `el`, as the browser reports it. */
function typeInto(drafts: FormDrafts, el: El, value: string): void {
  drafts.event("focusin", el, true);
  drafts.event("keydown", el, true);
  el.value = value;
  drafts.event("input", el, true);
}
/** The person taps `button`, which its component handles. */
function tap(drafts: FormDrafts, button: El): void {
  drafts.event("pointerdown", button, true);
  drafts.event("click", button, true);
  button.onClick?.();
}

describe("FormDrafts: Add Expense", () => {
  it("keeps the typed amount and remarks, the chosen category and card, and the focus and caret", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = addExpenseForm();
    const root = ledger(before.form);

    typeInto(drafts, before.amount, "250");
    tap(drafts, before.chip("Travel"));
    tap(drafts, before.pay("Credit Card"));
    typeInto(drafts, before.remarks, "Taxi to the airport");
    before.remarks.selectionStart = 4;
    before.remarks.selectionEnd = 6;

    drafts.beforeRemount(root, before.remarks);
    const after = addExpenseForm();
    remount(root, after.form);
    drafts.afterRemount(0);
    // A component re-renders after each click, so each step clicks at most
    // once per form; the steps run until nothing is left.
    for (let t = 0; t < 10 && drafts.step(root, t); t++);

    expect(after.amount.value).toBe("250");
    expect(after.remarks.value).toBe("Taxi to the airport");
    expect(selectedIn(after.chips)).toBe("Travel");
    expect(selectedIn(after.payment)).toBe("Credit Card");
    expect(actions.focused).toEqual({ el: after.remarks, start: 4, end: 6 });
    expect(drafts.step(root, 20)).toBe(false);
  });

  it("clicks at most once per form in a step, so the component re-renders between clicks", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = addExpenseForm();
    const root = ledger(before.form);
    tap(drafts, before.chip("Food"));
    tap(drafts, before.pay("Credit Card"));

    drafts.beforeRemount(root, null);
    const after = addExpenseForm();
    remount(root, after.form);
    drafts.afterRemount(0);

    expect(drafts.step(root, 0)).toBe(true);
    expect(actions.done).toEqual(["click Food"]);
    expect(drafts.step(root, 1)).toBe(false);
    expect(actions.done).toEqual(["click Food", "click Credit Card"]);
  });

  it("restores only fields the person changed: a field merely focused, or never touched, keeps what the new tree shows", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = addExpenseForm();
    const root = ledger(before.form);
    drafts.event("focusin", before.amount, true);
    // Changed without the person (a component's own state), not restored.
    before.remarks.value = "Set by the app";

    drafts.beforeRemount(root, null);
    const after = addExpenseForm();
    after.remarks.value = "Shown by the new revision";
    remount(root, after.form);
    drafts.afterRemount(0);

    expect(drafts.step(root, 0)).toBe(false);
    expect(actions.done).toEqual([]);
    expect(after.amount.value).toBe("");
    expect(after.remarks.value).toBe("Shown by the new revision");
  });

  it("does not bring back a form that was saved and cleared", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = addExpenseForm();
    const root = ledger(before.form);
    typeInto(drafts, before.amount, "40");
    typeInto(drafts, before.remarks, "Lunch");
    tap(drafts, before.chip("Food"));
    // Add Expense saved: the form resets itself (no input events).
    before.amount.value = "";
    before.remarks.value = "";
    pick(before.chip("Food"));
    before.chip("Food").attrs.set("class", "category-chip");

    drafts.beforeRemount(root, null);
    const after = addExpenseForm();
    remount(root, after.form);
    drafts.afterRemount(0);

    expect(drafts.step(root, 0)).toBe(false);
    expect(actions.done).toEqual([]);
  });

  it("waits for a section still loading: no chips yet, and a disabled fieldset", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = addExpenseForm();
    const root = ledger(before.form);
    typeInto(drafts, before.amount, "75");
    tap(drafts, before.chip("Food"));

    drafts.beforeRemount(root, null);
    const after = addExpenseForm([]);
    after.form.children[0].disabled = true;
    after.form.children[0].attrs.set("disabled", "");
    remount(root, after.form);
    drafts.afterRemount(0);

    expect(drafts.step(root, 0)).toBe(true);
    expect(actions.done).toEqual([]);

    // The month's lock was read (not locked) and the categories arrived.
    after.form.children[0].disabled = false;
    after.form.children[0].attrs.delete("disabled");
    const chips = choiceGroup("category-picker", ["Food", "Travel"], null, "category-chip");
    after.form.children[0].children[1].replace(after.chips, chips);
    for (let t = 1; t < 10 && drafts.step(root, t); t++);

    expect(after.amount.value).toBe("75");
    expect(selectedIn(chips)).toBe("Food");
  });

  it("a save cancels what still waits: a chip that arrives after the save isn't selected in the cleared form", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = addExpenseForm();
    const root = ledger(before.form);
    typeInto(drafts, before.amount, "75");
    tap(drafts, before.chip("Food"));

    drafts.beforeRemount(root, null);
    const after = addExpenseForm([]);
    remount(root, after.form);
    drafts.afterRemount(0);
    drafts.step(root, 0);
    expect(after.amount.value).toBe("75");

    // The person saves before the categories arrive (Enter in the restored
    // amount); then they arrive.
    drafts.event("submit", after.form, true);
    const chips = choiceGroup("category-picker", ["Food", "Travel"], null, "category-chip");
    after.form.children[0].children[1].replace(after.chips, chips);
    for (let t = 1; t < 10 && drafts.step(root, t); t++);

    expect(selectedIn(chips)).toBe(null);
  });

  it("gives up on what never appears once the window has passed", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = addExpenseForm();
    const root = ledger(before.form);
    tap(drafts, before.chip("Food"));

    drafts.beforeRemount(root, null);
    const after = addExpenseForm([]);
    remount(root, after.form);
    drafts.afterRemount(1000);

    expect(drafts.step(root, 1000 + DRAFT_WINDOW_MS - 1)).toBe(true);
    expect(drafts.step(root, 1000 + DRAFT_WINDOW_MS)).toBe(false);
    // Categories arriving later change nothing.
    after.form.children[0].children[1].replace(after.chips, choiceGroup("category-picker", ["Food"], null, "category-chip"));
    expect(drafts.step(root, 1000 + DRAFT_WINDOW_MS + 1)).toBe(false);
    expect(actions.done).toEqual([]);
  });

  it("leaves a field the person touches after the remount to them", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = addExpenseForm();
    const root = ledger(before.form);
    tap(drafts, before.chip("Food"));
    tap(drafts, before.pay("Credit Card"));

    drafts.beforeRemount(root, null);
    const after = addExpenseForm();
    remount(root, after.form);
    drafts.afterRemount(0);
    // Food is clicked in the first step; before the next, the person taps Cash.
    expect(drafts.step(root, 0)).toBe(true);
    tap(drafts, after.pay("Cash"));
    expect(drafts.step(root, 1)).toBe(false);

    expect(actions.done).toEqual(["click Food"]);
    expect(selectedIn(after.payment)).toBe("Cash");
  });

  it("does not move the focus when something else already has it", () => {
    const actions = fakeActions({ focusFree: () => false });
    const drafts = new FormDrafts(actions);
    const before = addExpenseForm();
    const root = ledger(before.form);
    typeInto(drafts, before.remarks, "Bus");

    drafts.beforeRemount(root, before.remarks);
    const after = addExpenseForm();
    remount(root, after.form);
    drafts.afterRemount(0);
    drafts.step(root, 0);

    expect(after.remarks.value).toBe("Bus");
    expect(actions.focused).toBeNull();
  });

  it("forgets a focus not put back yet once the person has focused something else, at the next remount", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = addExpenseForm();
    const root = ledger(before.form);
    drafts.event("focusin", before.remarks, true);

    drafts.beforeRemount(root, before.remarks);
    remount(root);
    drafts.afterRemount(0);
    expect(drafts.step(root, 0)).toBe(true);

    // Before the form is back, the person moves to the month picker, and
    // another join remounts again.
    const picker = h("select", { class: "select", value: "10" });
    root.append(picker);
    drafts.beforeRemount(root, picker);
    const after = addExpenseForm();
    remount(root, after.form);
    drafts.afterRemount(10);
    for (let t = 10; t < 20 && drafts.step(root, t); t++);

    expect(actions.focused).toBeNull();
  });

  it("keeps a checkbox and a select the person changed (Credit Cards, Subscriptions)", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const build = () => {
      const settled = h("input", { type: "checkbox", checked: false });
      const duration = h("select", { class: "select", value: "Monthly" }, h("option", { value: "Monthly" }, "Monthly"), h("option", { value: "Yearly" }, "Yearly"));
      (duration.children[0] as El).value = "Monthly";
      (duration.children[1] as El).value = "Yearly";
      const form = h("form", { class: "cards-form" }, h("div", { class: "card-row-fields" }, h("label", { class: "cards-settled" }, settled, "Settled")), duration);
      return { form, settled, duration };
    };
    const before = build();
    const root = ledger(before.form);
    drafts.event("pointerdown", before.settled, true);
    before.settled.checked = true;
    drafts.event("click", before.settled, true);
    drafts.event("change", before.settled, true);
    drafts.event("focusin", before.duration, true);
    before.duration.value = "Yearly";
    drafts.event("change", before.duration, true);

    drafts.beforeRemount(root, null);
    const after = build();
    remount(root, after.form);
    drafts.afterRemount(0);
    for (let t = 0; t < 10 && drafts.step(root, t); t++);

    expect(after.settled.checked).toBe(true);
    expect(after.duration.value).toBe("Yearly");
  });
});

// ---------------------------------------------------------------- edit rows

/** React swapping `old` for `next` in `list` (a row for its edit row):
 * the removal, then the insertion between the same neighbours, as two
 * MutationRecords. */
function swap(list: El, old: El, next: El): DraftMutation[] {
  const at = list.children.indexOf(old);
  const previousSibling = list.children[at - 1] ?? null;
  const nextSibling = list.children[at + 1] ?? null;
  list.replace(old, next);
  return [
    { target: list, addedNodes: [], removedNodes: [old], previousSibling, nextSibling },
    { target: list, addedNodes: [next], removedNodes: [], previousSibling, nextSibling },
  ];
}

/** RecentEntries' list: rows with data-row, each with an overflow menu whose
 * Edit swaps the row for an edit row (reported to `drafts` as the
 * MutationObserver would). */
function entriesList(drafts: FormDrafts, entries: { row: number; remarks: string; amount: string; category: string }[]) {
  const ul = h("ul");
  const edits = new Map<number, ReturnType<typeof editRow>>();
  function editRow(entry: (typeof entries)[number]) {
    const amount = h("input", { type: "number", value: entry.amount });
    const remarks = h("input", { type: "text", value: entry.remarks });
    const chips = choiceGroup("category-picker", ["Food", "Travel"], entry.category, "category-chip");
    const save = h("button", { type: "button", class: "submit-btn" }, "Save");
    const li = h("li", { class: "entry-row row-editing" }, h("div", { class: "edit-fields" }, amount, remarks, chips), h("div", { class: "edit-actions" }, save, h("button", { type: "button" }, "Cancel")));
    return { li, amount, remarks, chips, save };
  }
  function row(entry: (typeof entries)[number]): El {
    const trigger = h("button", { type: "button", class: "overflow-menu-trigger", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": "More actions" }, "⋮");
    const menu = h("div", { class: "overflow-menu" }, trigger);
    const li = h("li", { class: "entry-row", "data-row": String(entry.row) }, h("span", { class: "entry-remarks" }, entry.remarks), h("span", { class: "entry-amount" }, entry.amount), menu);
    trigger.onClick = () => {
      trigger.attrs.set("aria-expanded", "true");
      const item = (label: string, onClick: () => void) => {
        const b = h("button", { type: "button", role: "menuitem", class: "overflow-menu-item" }, h("span", { class: "overflow-menu-item-icon" }, "✏️"), h("span", {}, label));
        b.onClick = onClick;
        return h("li", { role: "none" }, b);
      };
      menu.append(
        h(
          "ul",
          { class: "overflow-menu-list", role: "menu" },
          item("Edit", () => {
            const edit = editRow(entry);
            edits.set(entry.row, edit);
            drafts.mutations(swap(ul, li, edit.li));
          }),
          item("Delete", () => {
            throw new Error("Delete must never be clicked");
          }),
        ),
      );
    };
    return li;
  }
  ul.append(...entries.map(row));
  const section = h("div", { class: "recent-entries" }, h("div", { class: "recent-header" }, h("h2", {}, "Entries this month")), ul);
  const rowOf = (n: number) => ul.children.find((li) => li.getAttribute("data-row") === String(n))!;
  return { section, ul, edits, rowOf };
}

/** The person opens row `n`'s edit row from its menu. */
function openEdit(drafts: FormDrafts, list: ReturnType<typeof entriesList>, n: number) {
  const li = list.rowOf(n);
  tap(drafts, li.children[2].children[0]);
  const edit = li.children[2].children[1].children[0].children[0];
  tap(drafts, edit);
  return list.edits.get(n)!;
}

const LUNCH = { row: 3, remarks: "Lunch", amount: "120", category: "Food" };
const TRAIN = { row: 4, remarks: "Train", amount: "60", category: "Travel" };

describe("FormDrafts: an open edit row", () => {
  it("reopens the same record's edit row from its menu, then restores what was typed and the focus", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const oldList = entriesList(drafts, [LUNCH, TRAIN]);
    const root = ledger(oldList.section);
    const editing = openEdit(drafts, oldList, 4);
    typeInto(drafts, editing.amount, "65");
    typeInto(drafts, editing.remarks, "Train home");
    editing.remarks.selectionStart = 10;
    editing.remarks.selectionEnd = 10;

    drafts.beforeRemount(root, editing.remarks);
    // The other device added an entry: the list gained a row above.
    const newList = entriesList(drafts, [LUNCH, TRAIN, { row: 9, remarks: "Coffee", amount: "5", category: "Food" }]);
    newList.ul.children.reverse();
    remount(root, newList.section);
    drafts.afterRemount(0);
    for (let t = 0; t < 10 && drafts.step(root, t); t++);

    const reopened = newList.edits.get(4)!;
    expect(reopened).toBeDefined();
    expect(newList.edits.size).toBe(1);
    expect(actions.done.slice(0, 2)).toEqual(["click ⋮", "click ✏️Edit"]);
    expect(reopened.amount.value).toBe("65");
    expect(reopened.remarks.value).toBe("Train home");
    expect(actions.focused).toEqual({ el: reopened.remarks, start: 10, end: 10 });
  });

  it("reopens an edit row nothing was typed into yet, with the focus on its field", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const oldList = entriesList(drafts, [LUNCH, TRAIN]);
    const root = ledger(oldList.section);
    const editing = openEdit(drafts, oldList, 3);
    drafts.event("focusin", editing.amount, true);

    drafts.beforeRemount(root, editing.amount);
    const newList = entriesList(drafts, [LUNCH, TRAIN]);
    remount(root, newList.section);
    drafts.afterRemount(0);
    for (let t = 0; t < 10 && drafts.step(root, t); t++);

    expect(newList.edits.get(3)).toBeDefined();
    expect(actions.focused?.el).toBe(newList.edits.get(3)!.amount);
    expect(actions.done.filter((d) => d.startsWith("set"))).toEqual([]);
  });

  it("keeps the other device's value in a field it changed, and the person's in the rest", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const oldList = entriesList(drafts, [LUNCH]);
    const root = ledger(oldList.section);
    const editing = openEdit(drafts, oldList, 3);
    typeInto(drafts, editing.amount, "150");
    typeInto(drafts, editing.remarks, "Lunch with Sam");
    tap(drafts, editing.chips.children[1]);

    drafts.beforeRemount(root, null);
    // The other device changed this entry's amount and category.
    const newList = entriesList(drafts, [{ ...LUNCH, amount: "130", category: "Travel" }]);
    remount(root, newList.section);
    drafts.afterRemount(0);
    for (let t = 0; t < 10 && drafts.step(root, t); t++);

    const reopened = newList.edits.get(3)!;
    expect(reopened.amount.value).toBe("130");
    expect(reopened.remarks.value).toBe("Lunch with Sam");
    expect(selectedIn(reopened.chips)).toBe("Travel");
    expect(actions.done.filter((d) => d.startsWith("click Travel"))).toEqual([]);
  });

  it("drops the draft quietly when another device deleted the record", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const oldList = entriesList(drafts, [LUNCH, TRAIN]);
    const root = ledger(oldList.section);
    const editing = openEdit(drafts, oldList, 4);
    typeInto(drafts, editing.amount, "65");

    drafts.beforeRemount(root, editing.amount);
    const newList = entriesList(drafts, [LUNCH]);
    remount(root, newList.section);
    drafts.afterRemount(0);

    expect(drafts.step(root, 0)).toBe(true);
    expect(drafts.step(root, DRAFT_WINDOW_MS)).toBe(false);
    expect(actions.done).toEqual([]);
    expect(actions.focused).toBeNull();
    expect(newList.edits.size).toBe(0);
  });

  it("does not reopen a row when the person opened another edit row first", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const oldList = entriesList(drafts, [LUNCH, TRAIN]);
    const root = ledger(oldList.section);
    const editing = openEdit(drafts, oldList, 4);
    typeInto(drafts, editing.amount, "65");

    drafts.beforeRemount(root, null);
    const newList = entriesList(drafts, [LUNCH, TRAIN]);
    remount(root, newList.section);
    drafts.afterRemount(0);
    openEdit(drafts, newList, 3);
    const clicks = actions.done.length;
    for (let t = 0; t < 10 && drafts.step(root, t); t++);

    expect(actions.done.length).toBe(clicks);
    expect(newList.edits.has(4)).toBe(false);
  });

  it("an edit row stays reopenable across a second remount while the first restore is under way", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const oldList = entriesList(drafts, [LUNCH, TRAIN]);
    const root = ledger(oldList.section);
    const editing = openEdit(drafts, oldList, 4);
    typeInto(drafts, editing.remarks, "Train back");

    drafts.beforeRemount(root, null);
    const loading = ledger();
    remount(root, ...loading.children[0].children[0].children);
    drafts.afterRemount(0);
    expect(drafts.step(root, 0)).toBe(true);

    // Another join before the list loaded.
    drafts.beforeRemount(root, null);
    const newList = entriesList(drafts, [LUNCH, TRAIN]);
    remount(root, newList.section);
    drafts.afterRemount(10);
    for (let t = 10; t < 20 && drafts.step(root, t); t++);

    expect(newList.edits.get(4)?.remarks.value).toBe("Train back");
  });
});

// ------------------------------------------------- review of #13: no guessing
//
// When which row or record a typed value belongs to is in any doubt, the
// draft is dropped: a value restored into the wrong card or debt is worse
// than one that has to be typed again.

/** CardsEditor's shape: a row per card (name, due, paid, settled, remove). */
function cardRow(name: string, paid = "0", settled = false) {
  const row = h(
    "div",
    { class: "card-row-fields" },
    h("input", { type: "text", placeholder: "Card / loan name", value: name }),
    h("input", { type: "number", placeholder: "Due", value: "0" }),
    h("input", { type: "number", placeholder: "Paid", value: paid }),
    h("label", { class: "cards-settled" }, h("input", { type: "checkbox", checked: settled }), "Settled"),
    h("button", { type: "button", class: "cards-remove", "aria-label": `Remove ${name}` }, "×"),
  );
  return { row, name: row.children[0], paid: row.children[2], label: row.children[3], settled: row.children[3].children[0] };
}
function cardsForm(rows: ReturnType<typeof cardRow>[]) {
  const editor = h("div", { class: "cards-editor" }, ...rows.map((r) => r.row), h("button", { type: "button", class: "cards-add" }, "+ Add card"));
  return { form: h("form", { class: "cards-form" }, editor, h("button", { type: "submit", class: "submit-btn" }, "Save")), editor };
}
const paidOf = (rows: ReturnType<typeof cardRow>[]) => rows.map((r) => `${r.name.value}=${r.paid.value}${r.settled.checked ? " settled" : ""}`).join(", ");

describe("FormDrafts: repeated rows (Credit Cards, Finances savings)", () => {
  it("restores into the same cards when the rows are the same, in the same order", () => {
    const drafts = new FormDrafts(fakeActions());
    const before = [cardRow("Card A"), cardRow("Card B"), cardRow("Card C")];
    const root = ledger(cardsForm(before).form);
    typeInto(drafts, before[1].paid, "4500");

    drafts.beforeRemount(root, null);
    const after = [cardRow("Card A"), cardRow("Card B"), cardRow("Card C")];
    remount(root, cardsForm(after).form);
    drafts.afterRemount(0);
    for (let t = 0; t < 10 && drafts.step(root, t); t++);

    expect(paidOf(after)).toBe("Card A=0, Card B=4500, Card C=0");
  });

  it("drops the form's drafts when a card was removed here before the join (the reviewer's probe)", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = [cardRow("Card B"), cardRow("Card C")];
    const root = ledger(cardsForm(before).form);
    typeInto(drafts, before[0].paid, "4500");
    typeInto(drafts, before[1].paid, "1200");

    drafts.beforeRemount(root, null);
    const after = [cardRow("Card A"), cardRow("Card B"), cardRow("Card C")];
    remount(root, cardsForm(after).form);
    drafts.afterRemount(0);
    for (let t = 0; t < 10; t++) drafts.step(root, t);

    expect(paidOf(after)).toBe("Card A=0, Card B=0, Card C=0");
    expect(actions.done).toEqual([]);
  });

  it("drops the form's drafts after a reorder here, even when the reloaded rows look the same", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const a = cardRow("Card A");
    const b = cardRow("Card B");
    const { form, editor } = cardsForm([a, b]);
    const root = ledger(form);
    typeInto(drafts, b.paid, "300");
    // The person drags B above A (React moves the row's element)...
    drafts.event("pointerdown", b.row, true);
    editor.children.splice(1, 1);
    editor.children.unshift(b.row);
    drafts.mutations([
      { target: editor, addedNodes: [], removedNodes: [b.row] },
      { target: editor, addedNodes: [b.row], removedNodes: [] },
    ]);
    // ...and back, so the rows on screen are A, B again.
    editor.children.splice(0, 1);
    editor.children.splice(1, 0, b.row);
    drafts.mutations([
      { target: editor, addedNodes: [], removedNodes: [b.row] },
      { target: editor, addedNodes: [b.row], removedNodes: [] },
    ]);

    drafts.beforeRemount(root, null);
    const after = [cardRow("Card A"), cardRow("Card B")];
    remount(root, cardsForm(after).form);
    drafts.afterRemount(0);
    for (let t = 0; t < 10; t++) drafts.step(root, t);

    expect(paidOf(after)).toBe("Card A=0, Card B=0");
    expect(actions.done).toEqual([]);
  });

  it("drops the drafts when another device inserted a card, a lone card included", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = [cardRow("Card B")];
    const root = ledger(cardsForm(before).form);
    typeInto(drafts, before[0].paid, "700");
    tap(drafts, before[0].settled);
    before[0].settled.checked = true;

    drafts.beforeRemount(root, null);
    const after = [cardRow("Card A"), cardRow("Card B")];
    remount(root, cardsForm(after).form);
    drafts.afterRemount(0);
    for (let t = 0; t < 10; t++) drafts.step(root, t);

    expect(paidOf(after)).toBe("Card A=0, Card B=0");
    expect(actions.done).toEqual([]);
  });

  it("drops the drafts when two rows have the same name: which is which can't be told", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = [cardRow("Card A"), cardRow("Card A")];
    const root = ledger(cardsForm(before).form);
    typeInto(drafts, before[1].paid, "900");

    drafts.beforeRemount(root, null);
    const after = [cardRow("Card A"), cardRow("Card A")];
    remount(root, cardsForm(after).form);
    drafts.afterRemount(0);
    for (let t = 0; t < 10; t++) drafts.step(root, t);

    expect(actions.done).toEqual([]);
  });

  it("takes a checkbox's base when its label is tapped (iOS taps the label, not the box)", () => {
    const drafts = new FormDrafts(fakeActions());
    const before = [cardRow("Card A")];
    const root = ledger(cardsForm(before).form);
    drafts.event("pointerdown", before[0].label, true);
    before[0].settled.checked = true;
    drafts.event("click", before[0].settled, true);
    drafts.event("change", before[0].settled, true);

    drafts.beforeRemount(root, null);
    const after = [cardRow("Card A")];
    remount(root, cardsForm(after).form);
    drafts.afterRemount(0);
    for (let t = 0; t < 10 && drafts.step(root, t); t++);

    expect(after[0].settled.checked).toBe(true);
  });
});

/** Debts' list: rows without data-row, matched by their text. */
function debtsList(drafts: FormDrafts, debts: { id: string; name: string; amount: string }[]) {
  const ul = h("ul", { class: "debts-list" });
  const opened: { id: string; li: El; amount: El }[] = [];
  const row = (debt: (typeof debts)[number]) => {
    const trigger = h("button", { type: "button", class: "overflow-menu-trigger", "aria-haspopup": "menu", "aria-expanded": "false" }, "⋮");
    const menu = h("div", { class: "overflow-menu" }, trigger);
    const li = h("li", { class: "debt-row" }, h("span", { class: "debt-name" }, debt.name), h("span", { class: "debt-amount" }, debt.amount), menu);
    trigger.onClick = () => {
      trigger.attrs.set("aria-expanded", "true");
      const item = h("button", { type: "button", role: "menuitem", class: "overflow-menu-item" }, h("span", {}, "✏️"), h("span", {}, "Edit"));
      item.onClick = () => {
        const amount = h("input", { type: "number", placeholder: "Amount", value: debt.amount });
        const edit = h("li", { class: "debt-row row-editing" }, h("div", { class: "edit-fields" }, h("input", { type: "text", placeholder: "Name", value: debt.name }), amount));
        opened.push({ id: debt.id, li: edit, amount });
        drafts.mutations(swap(ul, li, edit));
      };
      menu.append(h("ul", { class: "overflow-menu-list", role: "menu" }, h("li", { role: "none" }, item)));
    };
    return li;
  };
  ul.append(...debts.map(row));
  return { section: h("div", { class: "debts-body" }, ul), ul, opened };
}

function editDebt(drafts: FormDrafts, list: ReturnType<typeof debtsList>, at: number) {
  const li = list.ul.children[at];
  tap(drafts, li.children[2].children[0]);
  tap(drafts, li.children[2].children[1].children[0].children[0]);
  return list.opened[list.opened.length - 1];
}

const ALEX_1 = { id: "debt-1", name: "Alex", amount: "500" };
const ALEX_2 = { id: "debt-2", name: "Alex", amount: "500" };

describe("FormDrafts: edit rows matched by text", () => {
  it("does not reopen a twin when the edited record is gone (the reviewer's probe)", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = debtsList(drafts, [ALEX_1, ALEX_2]);
    const root = ledger(before.section);
    const editing = editDebt(drafts, before, 1);
    typeInto(drafts, editing.amount, "800");

    drafts.beforeRemount(root, null);
    const after = debtsList(drafts, [ALEX_1]);
    remount(root, after.section);
    drafts.afterRemount(0);
    for (let t = 0; t < 10; t++) drafts.step(root, t);

    expect(after.opened).toEqual([]);
    expect(actions.done).toEqual([]);
  });

  it("does not reopen either of two rows that read the same, even when both are still there", () => {
    const drafts = new FormDrafts(fakeActions());
    const before = debtsList(drafts, [ALEX_1, ALEX_2]);
    const root = ledger(before.section);
    const editing = editDebt(drafts, before, 0);
    typeInto(drafts, editing.amount, "800");

    drafts.beforeRemount(root, null);
    const after = debtsList(drafts, [ALEX_1, ALEX_2]);
    remount(root, after.section);
    drafts.afterRemount(0);
    for (let t = 0; t < 10; t++) drafts.step(root, t);

    expect(after.opened).toEqual([]);
  });

  it("reopens a row whose text is unique before and after", () => {
    const drafts = new FormDrafts(fakeActions());
    const sam = { id: "debt-3", name: "Sam", amount: "200" };
    const before = debtsList(drafts, [ALEX_1, sam]);
    const root = ledger(before.section);
    const editing = editDebt(drafts, before, 1);
    typeInto(drafts, editing.amount, "250");

    drafts.beforeRemount(root, null);
    const after = debtsList(drafts, [sam, ALEX_1]);
    remount(root, after.section);
    drafts.afterRemount(0);
    for (let t = 0; t < 10 && drafts.step(root, t); t++);

    expect(after.opened.map((o) => `${o.id}=${o.amount.value}`)).toEqual(["debt-3=250"]);
  });

  it("ties an edit row to a record only when it took the removed row's place", () => {
    const drafts = new FormDrafts(fakeActions());
    const sam = { id: "debt-3", name: "Sam", amount: "200" };
    const before = debtsList(drafts, [ALEX_1, sam]);
    const root = ledger(before.section);
    // Edit pressed on Alex's row, but the edit row lands after Sam's.
    const li = before.ul.children[0];
    tap(drafts, li.children[2].children[0]);
    drafts.event("click", li.children[2].children[1].children[0].children[0], true);
    const misplaced = h("li", { class: "debt-row row-editing" }, h("input", { type: "text", placeholder: "Name", value: "Alex" }));
    const samRow = before.ul.children[1];
    before.ul.children.splice(0, 1);
    before.ul.append(misplaced);
    drafts.mutations([
      { target: before.ul, addedNodes: [], removedNodes: [li], previousSibling: null, nextSibling: samRow },
      { target: before.ul, addedNodes: [misplaced], removedNodes: [], previousSibling: samRow, nextSibling: null },
    ]);
    typeInto(drafts, misplaced.children[0], "Alex B");

    drafts.beforeRemount(root, null);
    const after = debtsList(drafts, [ALEX_1, sam]);
    remount(root, after.section);
    drafts.afterRemount(0);
    for (let t = 0; t < 10; t++) drafts.step(root, t);

    expect(after.opened).toEqual([]);
  });
});

describe("FormDrafts: a save, and moving on", () => {
  it("does not refill a form whose save is in flight when the join lands (the reviewer's probe)", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = addExpenseForm();
    const root = ledger(before.form);
    typeInto(drafts, before.amount, "250");
    typeInto(drafts, before.remarks, "Taxi");
    tap(drafts, before.chip("Food"));
    // Add Expense pressed: onSubmit awaits addEntry; the form isn't reset yet.
    drafts.event("submit", before.form, true);

    drafts.beforeRemount(root, null);
    const after = addExpenseForm();
    remount(root, after.form);
    drafts.afterRemount(0);
    for (let t = 0; t < 10; t++) drafts.step(root, t);

    expect(actions.done).toEqual([]);
    expect(after.amount.value).toBe("");
  });

  it("treats a save button pressed with no form to tell as every form's save", () => {
    const drafts = new FormDrafts(fakeActions());
    const before = addExpenseForm();
    const root = ledger(before.form);
    typeInto(drafts, before.amount, "250");
    drafts.event("click", h("button", { type: "submit" }), true);

    drafts.beforeRemount(root, null);
    const after = addExpenseForm();
    remount(root, after.form);
    drafts.afterRemount(0);
    for (let t = 0; t < 10; t++) drafts.step(root, t);

    expect(after.amount.value).toBe("");
  });

  it("never brings back a value that was saved: Finances saved 50000, another device then set 0", () => {
    const drafts = new FormDrafts(fakeActions());
    const finances = () => {
      const salary = h("input", { type: "number", placeholder: "0.00", value: "0" });
      const other = h("input", { type: "number", placeholder: "Freelance, etc.", value: "" });
      const save = h("button", { type: "submit", class: "submit-btn" }, "Save");
      const form = h("form", { class: "income-form" }, h("label", {}, "Salary (₹)", salary), h("label", {}, "Other Income (₹)", other), save);
      return { form, salary, other, save };
    };
    const before = finances();
    const root = ledger(before.form);
    typeInto(drafts, before.salary, "50000");
    drafts.event("click", before.save, true);
    drafts.event("submit", before.form, true);
    // Saved; then the person starts on other income.
    typeInto(drafts, before.other, "1200");

    drafts.beforeRemount(root, null);
    const after = finances();
    remount(root, after.form);
    drafts.afterRemount(0);
    for (let t = 0; t < 10 && drafts.step(root, t); t++);

    expect(after.salary.value).toBe("0");
    expect(after.other.value).toBe("1200");
  });

  it("does not reopen an edit row whose Save is in flight", () => {
    const drafts = new FormDrafts(fakeActions());
    const oldList = entriesList(drafts, [LUNCH, TRAIN]);
    const root = ledger(oldList.section);
    const editing = openEdit(drafts, oldList, 4);
    typeInto(drafts, editing.amount, "65");
    drafts.event("pointerdown", editing.save, true);
    drafts.event("click", editing.save, true);

    drafts.beforeRemount(root, null);
    const newList = entriesList(drafts, [LUNCH, TRAIN]);
    remount(root, newList.section);
    drafts.afterRemount(0);
    for (let t = 0; t < 10; t++) drafts.step(root, t);

    expect(newList.edits.size).toBe(0);
  });

  it("drops what waits when the person moves on, such as to another month", () => {
    const actions = fakeActions();
    const drafts = new FormDrafts(actions);
    const before = addExpenseForm();
    const month = h("select", { class: "select", value: "10" });
    const root = ledger(h("header", {}, month), before.form);
    typeInto(drafts, before.amount, "75");

    drafts.beforeRemount(root, null);
    const after = addExpenseForm();
    after.form.children[0].attrs.set("disabled", "");
    const month2 = h("select", { class: "select", value: "10" });
    remount(root, h("header", {}, month2), after.form);
    drafts.afterRemount(0);
    expect(drafts.step(root, 0)).toBe(true);

    // The month's lock is still being read; the person picks November.
    drafts.event("pointerdown", month2, true);
    after.form.children[0].attrs.delete("disabled");
    for (let t = 1; t < 10; t++) drafts.step(root, t);

    expect(after.amount.value).toBe("");
    expect(actions.done).toEqual([]);
  });

  it("keeps a draft to the month it was typed in", () => {
    const drafts = new FormDrafts(fakeActions());
    const before = addExpenseForm();
    const root = ledger(h("header", {}, h("select", { class: "select", value: "10" })), before.form);
    typeInto(drafts, before.amount, "75");

    drafts.beforeRemount(root, null);
    const after = addExpenseForm();
    remount(root, h("header", {}, h("select", { class: "select", value: "11" })), after.form);
    drafts.afterRemount(0);
    for (let t = 0; t < 10; t++) drafts.step(root, t);

    expect(after.amount.value).toBe("");
  });
});
