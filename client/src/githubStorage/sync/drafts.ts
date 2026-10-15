// What the person has typed, kept across the remount a remote join causes
// (#13). SyncHost re-keys the shared Ledger on the engine's revision, so
// another device's change remounts it, and a half-typed form (Add Expense,
// an open edit row, Finances, Credit Cards, ...) came back empty. Holding
// the remount was tried and dropped (ADR-0008: the fence needs the screen to
// show exactly the revision it is told), so the remount still happens, and
// this puts the person's typing back into the new tree afterwards.
//
// The shared components are not changed (the default bundle stays
// byte-identical): this reads the DOM the Ledger renders, inside the
// container DraftKeeper.tsx puts around it. It:
//   - notes each field the person touches (focus, a tap or a key) and the
//     value it had then, its base;
//   - just before a remount, captures each touched field whose value now
//     differs from its base (so a form that saved and cleared itself, or a
//     field only focused, is left alone), any open edit row, and the focus;
//   - after the remount, puts each value back into the field with the same
//     key in the new tree, through the events React listens to, but only
//     while that field still shows the base: a value the new revision shows
//     (another device's edit) is never overwritten. An edit row is reopened
//     from its own menu first; a record that is gone is dropped quietly.
// A save after that is a write from the revision on screen, fenced as any.
//
// A field's key is its scope (a form by its class and position, or an edit
// row by its record) and its own description (tag, type and name, label or
// placeholder) with its position among the same in that scope.

/** The part of a DOM element read here; the tests use fakes. */
export interface DraftNode {
  readonly tagName: string;
  readonly parentElement: DraftNode | null;
  readonly children: ArrayLike<DraftNode>;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  type?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
}

/** A MutationRecord, as far as it is read. */
export interface DraftMutation {
  readonly target: unknown;
  readonly addedNodes: ArrayLike<unknown>;
  readonly removedNodes: ArrayLike<unknown>;
}

/** What restoring does to the page (DraftKeeper.tsx: the real DOM). */
export interface DraftActions {
  /** Sets a text field or select the way typing does, so React sees it. */
  setValue(el: DraftNode, value: string): void;
  click(el: DraftNode): void;
  focus(el: DraftNode, start: number | null, end: number | null): void;
  /** Nothing has the focus now (the person hasn't moved it anywhere). */
  focusFree(): boolean;
}

/** How long after a remount the restore keeps waiting for fields that
 * aren't there yet (a section still reading, a list still loading). */
export const DRAFT_WINDOW_MS = 5000;
/** The most menu clicks spent reopening one edit row. */
const REOPEN_TRIES = 4;

type Kind = "text" | "check" | "choice";

/** An open edit row's record: its list, the row it replaced (data-row, or
 * its text), where it was, and the menu item that opened it. */
interface RowRef {
  list: string;
  sig: string;
  index: number;
  item: string;
}

interface Draft {
  key: string;
  scope: string;
  kind: Kind;
  value: string;
  /** What the field showed when the person first touched it; null when
   * that wasn't seen (only an empty field is then restored into). */
  base: string | null;
}

interface FocusRef {
  key: string;
  /** The button within a choice group, by its text. */
  button: string | null;
  start: number | null;
  end: number | null;
}

interface Pending {
  drafts: Draft[];
  rows: { key: string; ref: RowRef; tries: number }[];
  focus: FocusRef | null;
  deadline: number;
}

interface Field {
  key: string;
  scope: string;
  el: DraftNode;
  kind: Kind;
}

interface Scan {
  fields: Field[];
  byKey: Map<string, Field>;
  byEl: Map<DraftNode, Field>;
  /** Open edit rows with a known record, by scope key. */
  editing: Map<string, RowRef>;
  lists: Map<string, DraftNode>;
}

const NOT_FIELDS = new Set(["hidden", "submit", "button", "reset", "image", "file"]);

const isNode = (n: unknown): n is DraftNode => typeof n === "object" && n !== null && typeof (n as DraftNode).tagName === "string";
const tagOf = (el: DraftNode) => el.tagName.toUpperCase();
const kids = (el: DraftNode): DraftNode[] => Array.from(el.children);
const classes = (el: DraftNode) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const hasClass = (el: DraftNode, name: string) => classes(el).includes(name);
const textOf = (el: DraftNode) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
const sigOf = (el: DraftNode | null) => (el ? `${tagOf(el).toLowerCase()}${classes(el)[0] ? `.${classes(el)[0]}` : ""}` : "");
const listKey = (list: DraftNode) => `${sigOf(list.parentElement)}>${sigOf(list)}`;
const indexIn = (parent: DraftNode, child: DraftNode) => kids(parent).indexOf(child);
const isEditRow = (el: DraftNode) => tagOf(el) === "LI" && hasClass(el, "row-editing");

function typeOf(el: DraftNode): string {
  return (el.type ?? el.getAttribute("type") ?? (tagOf(el) === "BUTTON" ? "submit" : "text")).toLowerCase();
}

/** The type="button" buttons directly in `el`: a choice group (category
 * chips, Cash / Credit Card, a sign toggle) when there is one. */
const choiceButtons = (el: DraftNode) => kids(el).filter((c) => tagOf(c) === "BUTTON" && typeOf(c) === "button");
const isChosen = (b: DraftNode) => hasClass(b, "selected") || b.getAttribute("aria-pressed") === "true";

function kindOf(el: DraftNode): Kind | null {
  const tag = tagOf(el);
  if (tag === "SELECT" || tag === "TEXTAREA") return "text";
  if (tag === "INPUT") {
    const type = typeOf(el);
    if (NOT_FIELDS.has(type)) return null;
    return type === "checkbox" || type === "radio" ? "check" : "text";
  }
  return choiceButtons(el).length > 0 ? "choice" : null;
}

function valueOf(el: DraftNode, kind: Kind): string {
  if (kind === "text") return el.value ?? "";
  if (kind === "check") return el.checked ? "on" : "off";
  const chosen = choiceButtons(el).find(isChosen);
  return chosen ? textOf(chosen) : "";
}

function describe(el: DraftNode, kind: Kind): string {
  if (kind === "choice") return `choice:${classes(el)[0] ?? ""}`;
  const name = el.getAttribute("name") ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "";
  return `${tagOf(el)}:${typeOf(el)}:${name}`;
}

/** Disabled itself, or inside a disabled fieldset (a locked month). */
function isDisabled(el: DraftNode): boolean {
  if (el.disabled) return true;
  for (let up = el.parentElement; up; up = up.parentElement) {
    if (tagOf(up) === "FIELDSET" && up.getAttribute("disabled") !== null) return true;
  }
  return false;
}

/** A select can hold `value` only once it has that option. */
function canHold(el: DraftNode, value: string): boolean {
  if (tagOf(el) !== "SELECT") return true;
  const options: DraftNode[] = [];
  const walk = (n: DraftNode) => {
    for (const c of kids(n)) {
      if (tagOf(c) === "OPTION") options.push(c);
      else walk(c);
    }
  };
  walk(el);
  return options.some((o) => (o.value ?? o.getAttribute("value") ?? textOf(o)) === value);
}

const hasMenu = (el: DraftNode): boolean => el.getAttribute("aria-haspopup") !== null || kids(el).some(hasMenu);

/** A list row's identity: its data-row (a record handle), else its text
 * without its menu. */
function rowSig(li: DraftNode): string {
  const row = li.getAttribute("data-row");
  if (row !== null) return `row:${row}`;
  return `text:${kids(li)
    .filter((c) => !hasMenu(c))
    .map(textOf)
    .join("|")}`;
}

function find(el: DraftNode, test: (n: DraftNode) => boolean): DraftNode | null {
  for (const c of kids(el)) {
    if (test(c)) return c;
    const deeper = find(c, test);
    if (deeper) return deeper;
  }
  return null;
}

function closest(el: DraftNode, test: (n: DraftNode) => boolean): DraftNode | null {
  for (let at: DraftNode | null = el; at; at = at.parentElement) if (test(at)) return at;
  return null;
}

/** The field a person's event is about: a form control, or the choice
 * group of a button they pressed. */
function trackedOf(target: DraftNode): { el: DraftNode; kind: Kind } | null {
  const tag = tagOf(target);
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    const kind = kindOf(target);
    return kind ? { el: target, kind } : null;
  }
  const button = closest(target, (n) => tagOf(n) === "BUTTON");
  const group = button?.parentElement;
  if (!button || !group || typeOf(button) !== "button" || kindOf(group) !== "choice") return null;
  return { el: group, kind: "choice" };
}

export class FormDrafts {
  readonly #actions: DraftActions;
  /** Touched fields and their base. */
  readonly #bases = new WeakMap<DraftNode, string | null>();
  /** Fields the person touched after a remount: theirs, not restored into. */
  readonly #claimed = new WeakSet<DraftNode>();
  /** A list row and the last menu item clicked in it. */
  readonly #items = new WeakMap<DraftNode, string>();
  /** An open edit row and the record it edits. */
  readonly #rows = new WeakMap<DraftNode, RowRef>();
  #captured: Omit<Pending, "deadline"> | null = null;
  #pending: Pending | null = null;

  constructor(actions: DraftActions) {
    this.#actions = actions;
  }

  /** A DOM event inside the ledger. Each field's base is the value it had
   * at the first focus, tap or key on it (before the change); a change seen
   * first (no focus seen) has no base. */
  event(type: string, target: DraftNode, trusted: boolean): void {
    if (type === "click") {
      const item = closest(target, (n) => n.getAttribute("role") === "menuitem");
      const row = item && closest(item, (n) => tagOf(n) === "LI" && n.getAttribute("role") === null);
      if (item && row) this.#items.set(row, textOf(item));
    }
    const tracked = trackedOf(target);
    if (!tracked) return;
    if (!this.#bases.has(tracked.el)) this.#bases.set(tracked.el, type === "input" || type === "change" ? null : valueOf(tracked.el, tracked.kind));
    if (trusted && (type === "pointerdown" || type === "keydown" || type === "input" || type === "change")) this.#claimed.add(tracked.el);
  }

  /** What the ledger's DOM did: an edit row that replaced a list row (one
   * the person opened from its menu) is tied to that row's record. */
  mutations(records: ArrayLike<DraftMutation>): void {
    const removed = new Map<unknown, DraftNode[]>();
    for (const r of Array.from(records)) {
      const gone = Array.from(r.removedNodes).filter(isNode);
      removed.set(r.target, [...(removed.get(r.target) ?? []), ...gone]);
    }
    for (const r of Array.from(records)) {
      if (!isNode(r.target)) continue;
      const list = r.target;
      for (const added of Array.from(r.addedNodes)) {
        if (!isNode(added) || !isEditRow(added)) continue;
        const was = (removed.get(list) ?? []).find((n) => tagOf(n) === "LI" && this.#items.has(n));
        if (!was) continue;
        this.#rows.set(added, { list: listKey(list), sig: rowSig(was), index: indexIn(list, added), item: this.#items.get(was)! });
      }
    }
  }

  /** Just before the tree under `root` is replaced: what the person typed,
   * the edit rows open and the focus. A restore still under way carries
   * what it hasn't put back yet. */
  beforeRemount(root: DraftNode, active: DraftNode | null): void {
    const scan = this.#scan(root);
    const drafts: Draft[] = [];
    for (const f of scan.fields) {
      const base = this.#bases.get(f.el);
      if (base === undefined) continue;
      const value = valueOf(f.el, f.kind);
      if (value !== base) drafts.push({ key: f.key, scope: f.scope, kind: f.kind, value, base });
    }
    const rows = [...scan.editing].map(([key, ref]) => ({ key, ref, tries: 0 }));
    const was = this.#pending;
    if (was) {
      for (const d of was.drafts) if (!drafts.some((x) => x.key === d.key)) drafts.push(d);
      for (const r of was.rows) if (!rows.some((x) => x.key === r.key)) rows.push({ ...r, tries: 0 });
    }
    // A focus not yet put back is kept only while nothing else has it.
    const idle = active === null || tagOf(active) === "BODY";
    const focus = this.#focusOf(active, scan) ?? (idle ? (was?.focus ?? null) : null);
    this.#captured = drafts.length > 0 || rows.length > 0 || focus ? { drafts, rows, focus } : null;
    this.#pending = null;
  }

  /** The new tree has committed: the restore starts. */
  afterRemount(now: number): void {
    this.#pending = this.#captured ? { ...this.#captured, deadline: now + DRAFT_WINDOW_MS } : null;
    this.#captured = null;
  }

  /** Puts back what can be put back now. True while something waits. */
  step(root: DraftNode, now: number): boolean {
    const p = this.#pending;
    if (!p) return false;
    if (now >= p.deadline) {
      this.#pending = null;
      return false;
    }
    let scan = this.#scan(root);
    const acted = new Set<string>();

    for (const row of [...p.rows]) {
      if (scan.editing.has(row.key)) {
        p.rows.splice(p.rows.indexOf(row), 1);
        continue;
      }
      const result = this.#reopen(row, scan);
      if (result === "drop") {
        p.rows.splice(p.rows.indexOf(row), 1);
        p.drafts = p.drafts.filter((d) => d.scope !== row.key);
        if (p.focus?.key.startsWith(`${row.key}|`)) p.focus = null;
      } else if (result === "clicked") {
        acted.add(row.key);
        scan = this.#scan(root);
      }
    }

    for (const d of [...p.drafts]) {
      if (acted.has(d.scope)) continue;
      const f = scan.byKey.get(d.key);
      if (!f || f.kind !== d.kind) continue;
      const drop = () => {
        p.drafts = p.drafts.filter((x) => x !== d);
      };
      if (this.#claimed.has(f.el)) {
        drop();
        continue;
      }
      if (isDisabled(f.el)) continue;
      const shown = valueOf(f.el, f.kind);
      if (shown === d.value) {
        this.#own(f.el, d.base);
        drop();
        continue;
      }
      if (d.base === null ? shown !== "" : shown !== d.base) {
        // The new revision shows something else here: it stays.
        drop();
        continue;
      }
      if (f.kind === "text") {
        if (!canHold(f.el, d.value)) continue;
        this.#own(f.el, shown);
        this.#actions.setValue(f.el, d.value);
      } else if (f.kind === "check") {
        this.#own(f.el, shown);
        this.#actions.click(f.el);
        acted.add(d.scope);
      } else {
        const button = choiceButtons(f.el).find((b) => textOf(b) === d.value && !isDisabled(b));
        if (!button) continue;
        this.#own(f.el, shown);
        this.#actions.click(button);
        acted.add(d.scope);
      }
      drop();
    }

    const focus = p.focus;
    const f = focus && !p.drafts.some((d) => d.key === focus.key) ? scan.byKey.get(focus.key) : undefined;
    if (focus && f) {
      const target = focus.button === null ? f.el : choiceButtons(f.el).find((b) => textOf(b) === focus.button);
      if (target && !isDisabled(target)) {
        if (!this.#claimed.has(f.el) && this.#actions.focusFree()) this.#actions.focus(target, focus.start, focus.end);
        p.focus = null;
      }
    }

    if (p.drafts.length === 0 && p.rows.length === 0 && p.focus === null) this.#pending = null;
    return this.#pending !== null;
  }

  /** A restored field counts as touched, from what the new tree showed. */
  #own(el: DraftNode, base: string | null): void {
    if (!this.#bases.has(el)) this.#bases.set(el, base);
  }

  /** One step towards reopening an edit row: its row's menu item if the
   * menu is open, else the menu. */
  #reopen(row: Pending["rows"][number], scan: Scan): "clicked" | "wait" | "drop" {
    const list = scan.lists.get(row.ref.list);
    if (!list) return "wait";
    const rows = kids(list).filter((li) => tagOf(li) === "LI");
    // The person opened another row: only one is edited at a time.
    if (rows.some(isEditRow)) return "drop";
    const same = rows.filter((li) => rowSig(li) === row.ref.sig);
    const li = same.find((x) => indexIn(list, x) === row.ref.index) ?? (same.length === 1 ? same[0] : null);
    if (!li) return "wait";
    if (row.tries >= REOPEN_TRIES) return "drop";
    const item = find(li, (n) => n.getAttribute("role") === "menuitem" && textOf(n) === row.ref.item);
    const trigger = item ? null : find(li, (n) => n.getAttribute("aria-haspopup") !== null);
    const target = item ?? (trigger && trigger.getAttribute("aria-expanded") !== "true" ? trigger : null);
    if (!target || isDisabled(target)) return "wait";
    row.tries++;
    // The click is the person's Edit again: the edit row it opens is tied
    // to this record (mutations()), as theirs was.
    if (item) this.#items.set(li, row.ref.item);
    this.#actions.click(target);
    return "clicked";
  }

  #focusOf(active: DraftNode | null, scan: Scan): FocusRef | null {
    if (!active) return null;
    const own = scan.byEl.get(active);
    if (own) {
      let start: number | null = null;
      let end: number | null = null;
      try {
        start = active.selectionStart ?? null;
        end = active.selectionEnd ?? null;
      } catch {
        // Some input types have no selection.
      }
      return { key: own.key, button: null, start, end };
    }
    const group = tagOf(active) === "BUTTON" && active.parentElement ? scan.byEl.get(active.parentElement) : undefined;
    return group?.kind === "choice" ? { key: group.key, button: textOf(active), start: null, end: null } : null;
  }

  /** Every field in a form or an open edit row under `root`, keyed. */
  #scan(root: DraftNode): Scan {
    const scan: Scan = { fields: [], byKey: new Map(), byEl: new Map(), editing: new Map(), lists: new Map() };
    const forms = new Map<string, number>();
    const counts = new Map<string, number>();
    const walk = (el: DraftNode, scope: string | null) => {
      for (const child of kids(el)) {
        let inner = scope;
        const tag = tagOf(child);
        if (tag === "UL" || tag === "OL") scan.lists.set(listKey(child), child);
        if (scope === null && tag === "FORM") {
          const name = classes(child)[0] ?? "";
          const n = forms.get(name) ?? 0;
          forms.set(name, n + 1);
          inner = `form:${name}#${n}`;
        } else if (scope === null && isEditRow(child)) {
          const ref = this.#rows.get(child);
          if (ref) {
            inner = `edit:${ref.list}:${ref.sig}`;
            scan.editing.set(inner, ref);
          }
        }
        if (inner !== null) {
          const kind = kindOf(child);
          if (kind) {
            const desc = `${inner}|${describe(child, kind)}`;
            const n = counts.get(desc) ?? 0;
            counts.set(desc, n + 1);
            const field: Field = { key: `${desc}#${n}`, scope: inner, el: child, kind };
            scan.fields.push(field);
            scan.byKey.set(field.key, field);
            scan.byEl.set(child, field);
          }
        }
        walk(child, inner);
      }
    };
    walk(root, null);
    return scan;
  }
}
