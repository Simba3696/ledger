import { Fragment, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineState, SyncEngine } from "../../backend/sync/SyncEngine";
import type { LedgerDocument } from "../../backend/document/types";
import { DraftKeeper } from "./DraftKeeper";
import { SyncHost, SyncLayers } from "./SyncHost";
import type { SyncStateValue } from "./syncContext";

// The stale-UI fence (design section 3.4) needs the screen to show exactly
// one revision, and the engine told that one: SyncHost keys the ledger on
// the engine's revision and reports the same revision to rendered() and
// attachView(). The client tests have no DOM to run layout effects in, so
// React's hooks are replaced here: SyncHost is called as a plain function
// (render() below), its state kept by call order as React keeps it, and its
// layout effects run by hand after it returns, as React would after
// committing what it returned: again only when their dependencies change.

/** Each hook's slot, by call order: a state, or an effect's dependencies. */
const slots: unknown[] = [];
let slot = 0;
const effects: (() => unknown)[] = [];

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
    useMemo: (make: () => unknown) => make(),
    useRef: (current: unknown) => ({ current }),
    useState: (initial: unknown) => {
      const i = slot++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      const set = (next: unknown) => void (slots[i] = typeof next === "function" ? (next as (was: unknown) => unknown)(slots[i]) : next);
      return [slots[i], set];
    },
    useLayoutEffect: (effect: () => unknown, deps?: unknown[]) => {
      const i = slot++;
      const was = slots[i] as unknown[] | undefined;
      if (deps && was && deps.length === was.length && deps.every((dep, k) => Object.is(dep, was[k]))) return;
      slots[i] = deps;
      effects.push(effect);
    },
    useEffect: () => {},
  };
});

beforeEach(() => {
  slots.length = 0;
  effects.length = 0;
});

type LayersProps = Parameters<typeof SyncLayers>[0];

/** SyncHost rendered (again, keeping its state) and committed: the layout
 * effects whose dependencies changed run. */
function render(engine: SyncEngine, page: ReactElement): ReactElement<LayersProps> {
  slot = 0;
  effects.length = 0;
  const out = SyncHost({ engine, children: page }) as ReactElement<LayersProps>;
  for (const effect of effects) effect();
  return out;
}

/** The document a fake engine holds: only its identity matters here. */
const doc = (name: string) => ({ name }) as unknown as LedgerDocument;

/** An engine at `revision` with a document, recording what SyncHost tells
 * it. Its sync-bar actions do what `act` says: replace the document (a
 * write that changed it), leave it (a write of only a marker, or one the
 * fence dropped), or refuse. */
function fakeEngine(revision: number, act: "change" | "keep" | "refuse" = "change") {
  const calls = { attachView: [] as number[], rendered: [] as number[] };
  const state = { status: "idle", hasDocument: true, unreadable: null, revision } as unknown as EngineState;
  let current = doc("before");
  const action = async <T,>(result: T): Promise<T> => {
    await Promise.resolve();
    if (act === "refuse") throw new Error("refused");
    if (act === "change") current = doc("after");
    return result;
  };
  const engine = {
    subscribe: () => () => {},
    getState: () => state,
    current: () => current,
    notices: () => [],
    leftBehind: () => [],
    attachView: (rev: number) => {
      calls.attachView.push(rev);
      return () => {};
    },
    rendered: (rev: number) => void calls.rendered.push(rev),
    reapply: () => action({ applied: act === "change" ? [{}] : [], skipped: [] }),
    discard: () => action(undefined),
    noticeAction: () => action(undefined),
    dismissNotice: () => action(undefined),
  } as unknown as SyncEngine;
  return { engine, calls };
}

/** The key of the fragment the ledger is keyed in, under `node`. */
function ledgerKey(node: ReactNode, page: ReactElement): string | null {
  if (!isValidElement(node)) return null;
  const children = (node.props as { children?: ReactNode }).children;
  const list = Array.isArray(children) ? children : [children];
  if (node.type === Fragment && list.includes(page)) return node.key;
  for (const child of list) {
    const key = ledgerKey(child as ReactNode, page);
    if (key !== null) return key;
  }
  return null;
}

/** The DraftKeeper SyncLayers renders around the keyed part. */
function keeperOf(out: ReactElement<LayersProps>) {
  const layers = SyncLayers(out.props) as ReactElement<{ children?: ReactNode }>;
  return ([] as ReactNode[]).concat(layers.props.children).find((child) => isValidElement(child) && child.type === DraftKeeper) as
    | ReactElement<{ tree: string; children?: ReactNode }>
    | undefined;
}

/** The sync-bar actions as SyncPanel calls them, through the context value. */
const ACTIONS: [name: string, run: (value: SyncStateValue) => Promise<unknown>][] = [
  ["Re-apply", (value) => value.reapply("group")],
  ["Discard", (value) => value.discard("group")],
  ["a notice action (Use mine)", (value) => value.noticeAction("notice", "useMine")],
];

describe("SyncHost's fence wiring", () => {
  it.each([0, 7])("keys the ledger on revision %i and tells the engine that one is rendered", (revision) => {
    const page = createElement("main", null, "The ledger");
    const { engine, calls } = fakeEngine(revision);
    const out = render(engine, page);
    expect(out.type).toBe(SyncLayers);

    expect(ledgerKey(SyncLayers(out.props), page)).toBe(`${revision}.0`);
    expect(calls.attachView).toEqual([revision]);
    expect(calls.rendered).toEqual([revision]);
  });

  // #13: what the person has typed is kept across that remount by a
  // DraftKeeper around the keyed part. It must sit outside the key (one
  // keeper for the life of the ledger, which sees each remount), and it is
  // told the same key, so it knows when the tree under it is replaced.
  it("keeps drafts from outside the keyed part: a DraftKeeper on the same key wraps it", () => {
    const page = createElement("main", null, "The ledger");
    const { engine } = fakeEngine(7);
    const keeper = keeperOf(render(engine, page));

    expect(keeper?.props.tree).toBe("7.0");
    expect(ledgerKey(keeper, page)).toBe("7.0");
    expect(keeper?.key).toBeNull();
  });
});

// #16: a sync-bar action is this device's own write, made through the
// engine rather than a section's form, and own writes don't move the
// revision. So once one has changed the document, SyncHost remounts the
// ledger at the same revision, and the open section reads current() again,
// as it does after its own save. The engine is still told only the
// revision on screen.
describe("SyncHost after a sync-bar action (#16)", () => {
  it.each(ACTIONS)("%s that changed the document re-keys the ledger at the same revision, and the engine is told only that revision", async (_name, run) => {
    const page = createElement("main", null, "The ledger");
    const { engine, calls } = fakeEngine(7, "change");
    const first = render(engine, page);
    await run(first.props.value);
    const again = render(engine, page);

    expect(ledgerKey(SyncLayers(again.props), page)).toBe("7.1");
    expect(keeperOf(again)?.props.tree).toBe("7.1");
    expect(calls.attachView).toEqual([7]);
    expect(calls.rendered).toEqual([7]);
  });

  it.each(ACTIONS)("%s that left the document as it was doesn't re-key the ledger", async (_name, run) => {
    const page = createElement("main", null, "The ledger");
    const { engine } = fakeEngine(7, "keep");
    await run(render(engine, page).props.value);
    expect(ledgerKey(SyncLayers(render(engine, page).props), page)).toBe("7.0");
  });

  it.each(ACTIONS)("%s that was refused doesn't re-key the ledger, and its error still reaches the panel", async (_name, run) => {
    const page = createElement("main", null, "The ledger");
    const { engine } = fakeEngine(7, "refuse");
    await expect(run(render(engine, page).props.value)).rejects.toThrow("refused");
    expect(ledgerKey(SyncLayers(render(engine, page).props), page)).toBe("7.0");
  });

  it("Dismiss writes no ledger change and doesn't re-key it", async () => {
    const page = createElement("main", null, "The ledger");
    const { engine } = fakeEngine(7, "change");
    await render(engine, page).props.value.dismissNotice("notice");
    expect(ledgerKey(SyncLayers(render(engine, page).props), page)).toBe("7.0");
  });

  it("returns the action's own result, for the panel's message", async () => {
    const page = createElement("main", null, "The ledger");
    const { engine } = fakeEngine(7, "change");
    await expect(render(engine, page).props.value.reapply("group")).resolves.toEqual({ applied: [{}], skipped: [] });
  });
});
