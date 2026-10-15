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
        const b = h("button", { type: "button", role: "menuitem", class: "overflow-menu-item" }, h("span", { class: "overflow-menu-item-icon" }, "✏️"), label);
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
            ul.replace(li, edit.li);
            const records: DraftMutation[] = [
              { target: ul, addedNodes: [], removedNodes: [li] },
              { target: ul, addedNodes: [edit.li], removedNodes: [] },
            ];
            drafts.mutations(records);
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
