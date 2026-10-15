// Stub: the API the draft tests are written against (#13). Not implemented yet.

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

export interface DraftMutation {
  readonly target: unknown;
  readonly addedNodes: ArrayLike<unknown>;
  readonly removedNodes: ArrayLike<unknown>;
}

export interface DraftActions {
  setValue(el: DraftNode, value: string): void;
  click(el: DraftNode): void;
  focus(el: DraftNode, start: number | null, end: number | null): void;
  focusFree(): boolean;
}

export const DRAFT_WINDOW_MS = 5000;

export class FormDrafts {
  constructor(actions: DraftActions) {
    void actions;
  }
  event(type: string, target: DraftNode, trusted: boolean): void {
    void type;
    void target;
    void trusted;
  }
  mutations(records: ArrayLike<DraftMutation>): void {
    void records;
  }
  beforeRemount(root: DraftNode, active: DraftNode | null): void {
    void root;
    void active;
  }
  afterRemount(now: number): void {
    void now;
  }
  step(root: DraftNode, now: number): boolean {
    void root;
    void now;
    return false;
  }
}
