import { Fragment, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineState, SyncEngine } from "../../backend/sync/SyncEngine";
import { DraftKeeper } from "./DraftKeeper";
import { SyncHost, SyncLayers } from "./SyncHost";

// The stale-UI fence (design section 3.4) needs the screen to show exactly
// one revision, and the engine told that one: SyncHost keys the ledger on
// the engine's revision and reports the same revision to rendered() and
// attachView(). The client tests have no DOM to run layout effects in, so
// React's hooks are replaced here: SyncHost is called as a plain function,
// and its layout effects are run by hand after it returns, as React would
// after committing what it returned.

const effects: (() => unknown)[] = [];

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
    useMemo: (make: () => unknown) => make(),
    useRef: (current: unknown) => ({ current }),
    useLayoutEffect: (effect: () => unknown) => void effects.push(effect),
    useEffect: () => {},
  };
});

beforeEach(() => {
  effects.length = 0;
});

/** An engine at `revision` with a document, recording what SyncHost tells it. */
function fakeEngine(revision: number) {
  const calls = { attachView: [] as number[], rendered: [] as number[] };
  const state = { status: "idle", hasDocument: true, unreadable: null, revision } as unknown as EngineState;
  const engine = {
    subscribe: () => () => {},
    getState: () => state,
    notices: () => [],
    leftBehind: () => [],
    attachView: (rev: number) => {
      calls.attachView.push(rev);
      return () => {};
    },
    rendered: (rev: number) => void calls.rendered.push(rev),
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

describe("SyncHost's fence wiring", () => {
  it.each([0, 7])("keys the ledger on revision %i and tells the engine that one is rendered", (revision) => {
    const page = createElement("main", null, "The ledger");
    const { engine, calls } = fakeEngine(revision);
    const out = SyncHost({ engine, children: page }) as ReactElement<Parameters<typeof SyncLayers>[0]>;
    expect(out.type).toBe(SyncLayers);
    for (const effect of effects) effect();

    expect(ledgerKey(SyncLayers(out.props), page)).toBe(String(revision));
    expect(calls.attachView).toEqual([revision]);
    expect(calls.rendered).toEqual([revision]);
  });

  // #13: what the person has typed is kept across that remount by a
  // DraftKeeper around the keyed part. It must sit outside the key (one
  // keeper for the life of the ledger, which sees each remount), and it is
  // told the same revision, so it knows when the tree under it is replaced.
  it("keeps drafts from outside the keyed part: a DraftKeeper on the same revision wraps it", () => {
    const page = createElement("main", null, "The ledger");
    const { engine } = fakeEngine(7);
    const out = SyncHost({ engine, children: page }) as ReactElement<Parameters<typeof SyncLayers>[0]>;
    const layers = SyncLayers(out.props) as ReactElement<{ children?: ReactNode }>;
    const keeper = ([] as ReactNode[]).concat(layers.props.children).find((child) => isValidElement(child) && child.type === DraftKeeper) as
      | ReactElement<{ revision: number; children?: ReactNode }>
      | undefined;

    expect(keeper?.props.revision).toBe(7);
    expect(ledgerKey(keeper, page)).toBe("7");
    expect(keeper?.key).toBeNull();
  });
});
