import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftKeeper } from "./DraftKeeper";

// DraftKeeper (#13) is the DOM side of FormDrafts: it captures just before
// the tree under it is replaced and restores after. The client tests have
// no DOM, so its lifecycle methods are called by hand, as React would, on a
// fake container. What is pinned here is when it steps: never inside
// React's commit (React then puts a controlled field's old value back), and
// a step after a DOM change only in a task of its own (so a click's
// re-render, which React runs in a microtask, lands before the next value
// is set).

let observed: ((records: unknown[]) => void) | null = null;

beforeEach(() => {
  observed = null;
  vi.stubGlobal("document", { activeElement: null, body: {} });
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: (records: unknown[]) => void) {
        observed = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A mounted keeper at `revision`, on a fake container, its FormDrafts spied. */
function mounted(revision: number) {
  const listeners = new Map<string, unknown>();
  const root = {
    tagName: "DIV",
    parentElement: null,
    children: [],
    textContent: "",
    getAttribute: () => null,
    addEventListener: (type: string, fn: unknown) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const keeper = new DraftKeeper({ revision });
  (keeper.root as { current: unknown }).current = root;
  keeper.componentDidMount();
  const spies = {
    before: vi.spyOn(keeper.drafts, "beforeRemount"),
    after: vi.spyOn(keeper.drafts, "afterRemount"),
    step: vi.spyOn(keeper.drafts, "step").mockReturnValue(false),
    mutations: vi.spyOn(keeper.drafts, "mutations"),
  };
  /** React re-rendering the keeper at `next`. */
  const update = (next: number) => {
    const prev = keeper.props;
    (keeper as { props: unknown }).props = { revision: next };
    keeper.getSnapshotBeforeUpdate(prev);
    keeper.componentDidUpdate(prev);
  };
  return { keeper, root, listeners, spies, update };
}

describe("DraftKeeper", () => {
  it("listens for the person's events on its container, and stops on unmount", () => {
    const { keeper, listeners } = mounted(1);
    expect([...listeners.keys()].sort()).toEqual(["change", "click", "focusin", "input", "keydown", "pointerdown", "submit"]);
    keeper.componentWillUnmount();
    expect(listeners.size).toBe(0);
  });

  it("captures and restores only when the revision moves", async () => {
    const { spies, update } = mounted(1);
    update(1);
    await nextTask();
    expect(spies.before).not.toHaveBeenCalled();
    expect(spies.after).not.toHaveBeenCalled();
    expect(spies.step).not.toHaveBeenCalled();

    update(2);
    expect(spies.before).toHaveBeenCalledTimes(1);
    expect(spies.after).toHaveBeenCalledTimes(1);
  });

  it("takes its first step just after the commit, not inside it", async () => {
    const { spies, update } = mounted(1);
    update(2);
    expect(spies.step).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(spies.step).toHaveBeenCalledTimes(1);
  });

  it("steps after a DOM change only in a task of its own", async () => {
    const { spies } = mounted(1);
    observed!([]);
    expect(spies.mutations).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(spies.step).not.toHaveBeenCalled();
    await nextTask();
    expect(spies.step).toHaveBeenCalledTimes(1);
  });
});
