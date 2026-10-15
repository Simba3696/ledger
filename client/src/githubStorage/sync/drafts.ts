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
//     value it had then, its base; a save re-bases its form or edit row;
//   - just before a remount, captures each touched field whose value now
//     differs from its base (so a form that saved and cleared itself, or a
//     field only focused, is left alone), any open edit row, and the focus;
//   - after the remount, puts each value back into the field with the same
//     key in the new tree, through the events React listens to, but only
//     while that field still shows the base: a value the new revision shows
//     (another device's edit) is never overwritten. An edit row is reopened
//     from its own Edit menu item first.
// A save after that is a write from the revision on screen, fenced as any.
//
// The rule throughout: when which row or record a value belongs to is in
// any doubt, the draft is dropped. A value put into the wrong card or debt
// is worse than one typed again. So:
//   - a scope (form or edit row) is restored only while its shape, the
//     list of its text-like fields with each text input's value, is the
//     one captured (text inputs as they were before the person typed):
//     a card or savings row removed, added or reordered, here or on
//     another device, changes it; two rows whose names match make it
//     ambiguous, and it is dropped at capture;
//   - a form whose rows the person removed, added or moved, a form or edit
//     row whose save is in flight, is not captured at all;
//   - an edit row is reopened only by its record's data-row, or by text
//     that exactly one row had before and exactly one has after, and only
//     if it took the place of the row whose Edit was pressed;
//   - keys carry the view (tab, and the month and year in the header), and
//     anything the person does after the remount, other than carrying on
//     in a field already put back, drops what still waits.
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
  readonly previousSibling?: unknown;
  readonly nextSibling?: unknown;
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
/** OverflowMenu's Edit item as it renders (its icon, then its label): the
 * only item an edit row is reopened by. */
const EDIT_ITEM = "✏️Edit";

type Kind = "text" | "check" | "choice";

/** An open edit row's record: its list, and the row it replaced (data-row,
 * or its text). */
interface RowRef {
  list: string;
  sig: string;
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
  scope: string;
  /** The button within a choice group, by its text. */
  button: string | null;
  start: number | null;
  end: number | null;
}

interface PendingRow {
  key: string;
  ref: RowRef;
  /** How many rows of the list read as this one at capture (text only). */
  count: number;
  tries: number;
}

interface Pending {
  drafts: Draft[];
  rows: PendingRow[];
  focus: FocusRef | null;
  /** Each scope's shape at capture (see #shape). */
  shapes: Map<string, string>;
  deadline: number;
}

interface Field {
  key: string;
  scope: string;
  desc: string;
  el: DraftNode;
  kind: Kind;
}

interface Scope {
  el: DraftNode;
  fields: Field[];
}

interface Scan {
  fields: Field[];
  byKey: Map<string, Field>;
  byEl: Map<DraftNode, Field>;
  scopes: Map<string, Scope>;
  /** Open edit rows with a known record, by scope key. */
  editing: Map<string, { ref: RowRef; el: DraftNode }>;
  lists: Map<string, DraftNode>;
}

const NOT_FIELDS = new Set(["hidden", "submit", "button", "reset", "image", "file"]);
const CONTROLS = new Set(["INPUT", "SELECT", "TEXTAREA"]);
const INTERACTIONS = new Set(["pointerdown", "keydown", "input", "change"]);

const isNode = (n: unknown): n is DraftNode => typeof n === "object" && n !== null && typeof (n as DraftNode).tagName === "string";
const tagOf = (el: DraftNode) => el.tagName.toUpperCase();
const kids = (el: DraftNode): DraftNode[] => Array.from(el.children);
const classes = (el: DraftNode) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const hasClass = (el: DraftNode, name: string) => classes(el).includes(name);
const textOf = (el: DraftNode) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
const sigOf = (el: DraftNode | null) => (el ? `${tagOf(el).toLowerCase()}${classes(el)[0] ? `.${classes(el)[0]}` : ""}` : "");
const listKey = (list: DraftNode) => `${sigOf(list.parentElement)}>${sigOf(list)}`;
const isEditRow = (el: DraftNode) => tagOf(el) === "LI" && hasClass(el, "row-editing");
const isScope = (el: DraftNode) => tagOf(el) === "FORM" || isEditRow(el);

function typeOf(el: DraftNode): string {
  return (el.type ?? el.getAttribute("type") ?? (tagOf(el) === "BUTTON" ? "submit" : "text")).toLowerCase();
}

const isTextInput = (el: DraftNode) => tagOf(el) === "INPUT" && typeOf(el) === "text";

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

/** The field a person's event is about: a form control, the choice group
 * of a button they pressed, or the control of a label they tapped. */
function trackedOf(target: DraftNode): { el: DraftNode; kind: Kind } | null {
  if (CONTROLS.has(tagOf(target))) {
    const kind = kindOf(target);
    return kind ? { el: target, kind } : null;
  }
  const button = closest(target, (n) => tagOf(n) === "BUTTON");
  if (button) {
    const group = button.parentElement;
    if (!group || typeOf(button) !== "button" || kindOf(group) !== "choice") return null;
    return { el: group, kind: "choice" };
  }
  // iOS taps a checkbox's label, and the box changes before any event on
  // it: the base is taken from the label's control at the tap.
  const label = closest(target, (n) => tagOf(n) === "LABEL");
  const control = label && find(label, (n) => CONTROLS.has(tagOf(n)));
  const kind = control && kindOf(control);
  return control && kind ? { el: control, kind } : null;
}

const isSaveButton = (button: DraftNode) => typeOf(button) === "submit" || hasClass(button, "submit-btn");

export class FormDrafts {
  readonly #actions: DraftActions;
  /** Touched fields and their base. */
  readonly #bases = new WeakMap<DraftNode, string | null>();
  /** Fields put back (or focused) after a remount: the person carrying on
   * in one doesn't stop the rest. */
  readonly #restored = new WeakSet<DraftNode>();
  /** A list row and the last menu item clicked in it. */
  readonly #items = new WeakMap<DraftNode, string>();
  /** An open edit row and the record it edits. */
  readonly #rows = new WeakMap<DraftNode, RowRef>();
  /** Forms the person has done something in. */
  readonly #touchedScopes = new WeakSet<DraftNode>();
  /** Forms whose rows the person removed, added or moved since their save. */
  readonly #restructured = new WeakSet<DraftNode>();
  /** Forms and edit rows whose save is in flight. */
  readonly #saving = new WeakSet<DraftNode>();
  /** A save whose form couldn't be told: every scope's. */
  #savingAll = false;
  #root: DraftNode | null = null;
  #captured: Omit<Pending, "deadline"> | null = null;
  #pending: Pending | null = null;

  constructor(actions: DraftActions) {
    this.#actions = actions;
  }

  /** A DOM event inside the ledger. Each field's base is the value it had
   * at the first focus, tap or key on it (before the change); a change seen
   * first (no focus seen) has no base. */
  event(type: string, target: DraftNode, trusted: boolean): void {
    if (trusted) {
      const form = closest(target, (n) => tagOf(n) === "FORM");
      if (form) this.#touchedScopes.add(form);
    }
    if (type === "submit") this.#startSave(tagOf(target) === "FORM" ? target : closest(target, (n) => tagOf(n) === "FORM"));
    if (type === "click") {
      const item = closest(target, (n) => n.getAttribute("role") === "menuitem");
      const row = item && closest(item, (n) => tagOf(n) === "LI" && n.getAttribute("role") === null);
      if (item && row) this.#items.set(row, textOf(item));
      const button = closest(target, (n) => tagOf(n) === "BUTTON");
      if (trusted && button && isSaveButton(button)) this.#startSave(closest(button, isScope));
    }
    const tracked = trackedOf(target);
    if (tracked) {
      if (!this.#bases.has(tracked.el)) this.#bases.set(tracked.el, type === "input" || type === "change" ? null : valueOf(tracked.el, tracked.kind));
      if (trusted && (type === "input" || type === "change" || type === "keydown")) {
        // Editing again after a save: the save has landed or failed.
        const scope = closest(tracked.el, isScope);
        if (scope) this.#saving.delete(scope);
        this.#savingAll = false;
      }
    }
    const p = this.#pending;
    if (!p || !trusted || !INTERACTIONS.has(type) || (tracked && this.#restored.has(tracked.el))) return;
    const field = tracked && this.#root ? this.#scan(this.#root).byEl.get(tracked.el) : undefined;
    if (field && p.drafts.some((d) => d.key === field.key)) {
      // The person took that field over: theirs.
      p.drafts = p.drafts.filter((d) => d.key !== field.key);
      if (p.focus?.key === field.key) p.focus = null;
    } else {
      // Anything else (another field, a tab, the month): they moved on.
      this.#pending = null;
    }
  }

  /** What the ledger's DOM did. An edit row that took the place of the list
   * row whose Edit was pressed is tied to that row's record; rows added,
   * removed or moved in a form the person is working in mark it. */
  mutations(records: ArrayLike<DraftMutation>): void {
    const all = Array.from(records);
    for (const r of all) {
      if (!isNode(r.target)) continue;
      const form = closest(r.target, (n) => tagOf(n) === "FORM");
      if (!form || !this.#touchedScopes.has(form)) continue;
      const moved = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)].filter(isNode);
      if (moved.some((n) => isTextInput(n) || find(n, isTextInput) !== null)) this.#restructured.add(form);
    }
    const edited = (nodes: ArrayLike<unknown>) => Array.from(nodes).filter(isNode).find((n) => tagOf(n) === "LI" && this.#items.get(n) === EDIT_ITEM);
    for (const r of all) {
      if (!isNode(r.target)) continue;
      for (const added of Array.from(r.addedNodes)) {
        if (!isNode(added) || !isEditRow(added)) continue;
        // In the same record (a replace), or removed between the same
        // neighbours the edit row was inserted between.
        let was = edited(r.removedNodes);
        if (!was && r.previousSibling !== undefined && r.nextSibling !== undefined) {
          for (const o of all) {
            if (o === r || o.target !== r.target || o.previousSibling !== r.previousSibling || o.nextSibling !== r.nextSibling) continue;
            was = edited(o.removedNodes);
            if (was) break;
          }
        }
        if (was) this.#rows.set(added, { list: listKey(r.target), sig: rowSig(was) });
      }
    }
  }

  /** Just before the tree under `root` is replaced: what the person typed,
   * the edit rows open and the focus. A restore still under way carries
   * what it hasn't put back yet. */
  beforeRemount(root: DraftNode, active: DraftNode | null): void {
    this.#root = root;
    const scan = this.#scan(root);
    const skipped = (el: DraftNode) => this.#savingAll || this.#saving.has(el) || this.#restructured.has(el);
    const scopeEl = (key: string) => scan.scopes.get(key)?.el;

    let drafts: Draft[] = [];
    for (const f of scan.fields) {
      const base = this.#bases.get(f.el);
      if (base === undefined || skipped(scan.scopes.get(f.scope)!.el)) continue;
      const value = valueOf(f.el, f.kind);
      if (value !== base) drafts.push({ key: f.key, scope: f.scope, kind: f.kind, value, base });
    }
    const rows: PendingRow[] = [];
    for (const [key, { ref, el }] of scan.editing) {
      if (skipped(el)) continue;
      const list = el.parentElement;
      const twins = list ? kids(list).filter((li) => tagOf(li) === "LI" && !isEditRow(li) && rowSig(li) === ref.sig).length : 0;
      rows.push({ key, ref, count: ref.sig.startsWith("text:") ? 1 + twins : 1, tries: 0 });
    }
    let focus = this.#focusOf(active, scan);
    if (focus && skipped(scopeEl(focus.scope)!)) focus = null;

    const shapes = new Map<string, string>();
    for (const key of new Set([...drafts.map((d) => d.scope), ...(focus ? [focus.scope] : [])])) {
      const shape = this.#shape(scan.scopes.get(key)!, (f) => this.#bases.get(f.el) ?? valueOf(f.el, f.kind));
      if (shape === null) {
        drafts = drafts.filter((d) => d.scope !== key);
        if (focus?.scope === key) focus = null;
      } else shapes.set(key, shape);
    }

    const was = this.#pending;
    if (was) {
      for (const d of was.drafts) {
        if (drafts.some((x) => x.key === d.key) || !was.shapes.has(d.scope)) continue;
        drafts.push(d);
        if (!shapes.has(d.scope)) shapes.set(d.scope, was.shapes.get(d.scope)!);
      }
      for (const r of was.rows) if (!rows.some((x) => x.key === r.key)) rows.push({ ...r, tries: 0 });
      // A focus not yet put back is kept only while nothing else has it.
      const idle = active === null || tagOf(active) === "BODY";
      if (!focus && idle && was.focus && was.shapes.has(was.focus.scope)) {
        focus = was.focus;
        if (!shapes.has(focus.scope)) shapes.set(focus.scope, was.shapes.get(focus.scope)!);
      }
    }
    this.#captured = drafts.length > 0 || rows.length > 0 || focus ? { drafts, rows, focus, shapes } : null;
    this.#pending = null;
  }

  /** The new tree has committed: the restore starts. */
  afterRemount(now: number): void {
    this.#pending = this.#captured ? { ...this.#captured, deadline: now + DRAFT_WINDOW_MS } : null;
    this.#captured = null;
  }

  /** Puts back what can be put back now. True while something waits. */
  step(root: DraftNode, now: number): boolean {
    this.#root = root;
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
        p.rows = p.rows.filter((r) => r !== row);
        continue;
      }
      const result = this.#reopen(row, scan);
      if (result === "drop") {
        p.rows = p.rows.filter((r) => r !== row);
        p.drafts = p.drafts.filter((d) => d.scope !== row.key);
        if (p.focus?.scope === row.key) p.focus = null;
      } else if (result === "clicked") {
        acted.add(row.key);
        scan = this.#scan(root);
      }
    }

    // A scope is restored into only while it has the shape it was captured
    // with: the same rows, in the same order (fields put back count as they
    // were before).
    const same = new Map<string, boolean>();
    const matches = (key: string) => {
      if (!same.has(key)) {
        const scope = scan.scopes.get(key);
        const shape = scope && this.#shape(scope, (f) => (this.#restored.has(f.el) ? (this.#bases.get(f.el) ?? "") : valueOf(f.el, f.kind)));
        same.set(key, shape !== undefined && shape !== null && shape === p.shapes.get(key));
      }
      return same.get(key)!;
    };

    for (const d of [...p.drafts]) {
      if (acted.has(d.scope) || !matches(d.scope)) continue;
      const f = scan.byKey.get(d.key);
      if (!f || f.kind !== d.kind || isDisabled(f.el)) continue;
      const drop = () => {
        p.drafts = p.drafts.filter((x) => x !== d);
      };
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
    const f = focus && !p.drafts.some((d) => d.key === focus.key) && matches(focus.scope) ? scan.byKey.get(focus.key) : undefined;
    if (focus && f) {
      const target = focus.button === null ? f.el : choiceButtons(f.el).find((b) => textOf(b) === focus.button);
      if (target && !isDisabled(target)) {
        if (this.#actions.focusFree()) {
          this.#restored.add(f.el);
          this.#actions.focus(target, focus.start, focus.end);
        }
        p.focus = null;
      }
    }

    if (p.drafts.length === 0 && p.rows.length === 0 && p.focus === null) this.#pending = null;
    return this.#pending !== null;
  }

  /** A restored field counts as touched, from what the new tree showed. */
  #own(el: DraftNode, base: string | null): void {
    this.#restored.add(el);
    if (!this.#bases.has(el)) this.#bases.set(el, base);
  }

  /** A save started in `scope` (null: a form that couldn't be told). Its
   * fields are re-based to what is being saved, so a saved value is never a
   * draft, and the scope isn't captured until the person edits it again. */
  #startSave(scope: DraftNode | null): void {
    if (!scope) {
      this.#savingAll = true;
      return;
    }
    this.#saving.add(scope);
    this.#restructured.delete(scope);
    const rebase = (el: DraftNode) => {
      const kind = kindOf(el);
      if (kind) this.#bases.set(el, valueOf(el, kind));
      for (const c of kids(el)) rebase(c);
    };
    rebase(scope);
  }

  /** One step towards reopening an edit row: its row's Edit item if the
   * menu is open, else the menu. Only a row that is the record beyond doubt
   * is reopened. */
  #reopen(row: PendingRow, scan: Scan): "clicked" | "wait" | "drop" {
    if (row.count !== 1) return "drop";
    const list = scan.lists.get(row.ref.list);
    if (!list) return "wait";
    const rows = kids(list).filter((li) => tagOf(li) === "LI");
    // The person opened another row: only one is edited at a time.
    if (rows.some(isEditRow)) return "drop";
    const same = rows.filter((li) => rowSig(li) === row.ref.sig);
    if (same.length > 1) return "drop";
    if (same.length === 0) return "wait";
    if (row.tries >= REOPEN_TRIES) return "drop";
    const li = same[0];
    const item = find(li, (n) => n.getAttribute("role") === "menuitem" && textOf(n) === EDIT_ITEM);
    const trigger = item ? null : find(li, (n) => n.getAttribute("aria-haspopup") !== null);
    const target = item ?? (trigger && trigger.getAttribute("aria-expanded") !== "true" ? trigger : null);
    if (!target || isDisabled(target)) return "wait";
    row.tries++;
    // The click is the person's Edit again: the edit row it opens is tied
    // to this record (mutations()), as theirs was.
    if (item) this.#items.set(li, EDIT_ITEM);
    this.#actions.click(target);
    return "clicked";
  }

  /** The scope's text-like fields in order, each text input with a value
   * (`identity`): what tells its rows apart. Null when two text inputs of
   * one description share a value, so its rows can't be told apart. */
  #shape(scope: Scope, identity: (f: Field) => string): string | null {
    const parts: string[] = [];
    const seen = new Map<string, Set<string>>();
    for (const f of scope.fields) {
      if (f.kind !== "text") continue;
      if (!isTextInput(f.el)) {
        parts.push(f.desc);
        continue;
      }
      const id = identity(f);
      const ids = seen.get(f.desc) ?? new Set<string>();
      if (ids.has(id)) return null;
      ids.add(id);
      seen.set(f.desc, ids);
      parts.push(`${f.desc}=${id}`);
    }
    return parts.join("\n");
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
      return { key: own.key, scope: own.scope, button: null, start, end };
    }
    const group = tagOf(active) === "BUTTON" && active.parentElement ? scan.byEl.get(active.parentElement) : undefined;
    return group?.kind === "choice" ? { key: group.key, scope: group.scope, button: textOf(active), start: null, end: null } : null;
  }

  /** Every field in a form or an open edit row under `root`, keyed, with
   * the view (the selected tab, and the header's month and year) in front. */
  #scan(root: DraftNode): Scan {
    const raw: { scope: string; scopeEl: DraftNode; el: DraftNode; kind: Kind; desc: string }[] = [];
    const editing: { scope: string; ref: RowRef; el: DraftNode }[] = [];
    const lists = new Map<string, DraftNode>();
    const forms = new Map<string, number>();
    let tab = "";
    const header: string[] = [];
    const walk = (el: DraftNode, scope: { key: string; el: DraftNode } | null, inHeader: boolean) => {
      for (const child of kids(el)) {
        let inner = scope;
        const tag = tagOf(child);
        if (tag === "UL" || tag === "OL") lists.set(listKey(child), child);
        if (tag === "NAV" && hasClass(child, "tabs")) {
          const chosen = choiceButtons(child).find(isChosen);
          tab = chosen ? textOf(chosen) : "";
        }
        if (inHeader && tag === "SELECT") header.push(child.value ?? "");
        if (scope === null && tag === "FORM") {
          const name = classes(child)[0] ?? "";
          const n = forms.get(name) ?? 0;
          forms.set(name, n + 1);
          inner = { key: `form:${name}#${n}`, el: child };
        } else if (scope === null && isEditRow(child)) {
          const ref = this.#rows.get(child);
          if (ref) {
            inner = { key: `edit:${ref.list}:${ref.sig}`, el: child };
            editing.push({ scope: inner.key, ref, el: child });
          }
        }
        if (inner !== null) {
          const kind = kindOf(child);
          if (kind) raw.push({ scope: inner.key, scopeEl: inner.el, el: child, kind, desc: describe(child, kind) });
        }
        walk(child, inner, inHeader || tag === "HEADER");
      }
    };
    walk(root, null, false);

    const view = `${tab}/${header.join("/")}`;
    const scan: Scan = { fields: [], byKey: new Map(), byEl: new Map(), scopes: new Map(), editing: new Map(), lists };
    const counts = new Map<string, number>();
    for (const r of raw) {
      const scope = `${view}§${r.scope}`;
      const n = counts.get(`${scope}|${r.desc}`) ?? 0;
      counts.set(`${scope}|${r.desc}`, n + 1);
      const field: Field = { key: `${scope}|${r.desc}#${n}`, scope, desc: r.desc, el: r.el, kind: r.kind };
      scan.fields.push(field);
      scan.byKey.set(field.key, field);
      scan.byEl.set(r.el, field);
      const entry = scan.scopes.get(scope) ?? { el: r.scopeEl, fields: [] };
      entry.fields.push(field);
      scan.scopes.set(scope, entry);
    }
    for (const e of editing) {
      const scope = `${view}§${e.scope}`;
      scan.editing.set(scope, { ref: e.ref, el: e.el });
      if (!scan.scopes.has(scope)) scan.scopes.set(scope, { el: e.el, fields: [] });
    }
    return scan;
  }
}
