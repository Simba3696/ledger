import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SectionLoadBoundary } from "./SectionLoadBoundary";

// A section that can't be loaded (offline before its chunk was) made
// React.lazy throw with nothing to catch it: a blank screen. The boundary
// around the Ledger shows a message instead. No DOM in the client tests:
// the boundary is driven through its static and render methods, its
// fallback server-rendered.

afterEach(() => vi.restoreAllMocks());

/** Every element in `node`, down through children (a component such as
 * Shell is not called: its children are what this file renders). */
function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  return [node, ...elements((node.props as { children?: ReactNode }).children)];
}

function button(node: ReactNode, label: string): () => void {
  const found = elements(node).find((el) => el.type === "button" && renderToString(el).includes(label));
  if (!found) throw new Error(`no button ${label}`);
  return (found.props as { onClick: () => void }).onClick;
}

describe("SectionLoadBoundary", () => {
  // Shell's theme toggle reads the stored theme.
  beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => "light", setItem: () => {} }));
  afterEach(() => vi.unstubAllGlobals());

  const page = createElement("main", null, "The ledger");
  const chunkError = new TypeError("Failed to fetch dynamically imported module: https://example.test/ledger/assets/Debts-abc.js");

  /** A boundary that has caught `error`, its setState applied in place. */
  function caught(error: unknown, online: boolean) {
    const onHome = vi.fn();
    const reload = vi.fn();
    const boundary = new SectionLoadBoundary({ children: page, onHome, online: () => online, reload });
    boundary.state = { ...boundary.state, ...SectionLoadBoundary.getDerivedStateFromError(error) };
    boundary.setState = ((patch: object) => Object.assign(boundary.state, patch)) as typeof boundary.setState;
    return { boundary, onHome, reload };
  }

  it("shows its children until something fails", () => {
    const boundary = new SectionLoadBoundary({ children: page, onHome: () => {} });
    expect(boundary.render()).toBe(page);
  });

  it("offline, says the section hasn't loaded and will open once back online", () => {
    const { boundary } = caught(chunkError, false);
    const html = renderToString(boundary.render() as ReactElement);
    expect(html).toContain("This part of Ledger hasn&#x27;t loaded yet, and you seem to be offline.");
    expect(html).toContain("It will open once you&#x27;re back online");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("The ledger");
  });

  it("online, says it couldn't be loaded", () => {
    const { boundary } = caught(chunkError, true);
    expect(renderToString(boundary.render() as ReactElement)).toContain("This part of Ledger couldn&#x27;t be loaded.");
  });

  it("Try again reloads the page when online, and only says so when still offline", () => {
    const offline = caught(chunkError, false);
    button(offline.boundary.render(), "Try again")();
    expect(offline.reload).not.toHaveBeenCalled();
    expect(renderToString(offline.boundary.render() as ReactElement)).toContain("You still seem to be offline.");

    const online = caught(chunkError, true);
    button(online.boundary.render(), "Try again")();
    expect(online.reload).toHaveBeenCalledTimes(1);
  });

  it("Back to Dashboard opens the Ledger again on the Dashboard, which needs nothing more loaded", () => {
    const { boundary, onHome } = caught(chunkError, false);
    button(boundary.render(), "Back to Dashboard")();
    expect(onHome).toHaveBeenCalledTimes(1);
    expect(boundary.render()).toBe(page);
  });

  it("leaves any other error to fail as before", () => {
    const other = new Error("Cannot read properties of undefined (reading 'amount')");
    const { boundary } = caught(other, false);
    expect(() => boundary.render()).toThrow(other);
  });
});
