import { createElement, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleName } from "../api";
import appSource from "../App.tsx?raw";
import { Ledger, type LedgerView, type LedgerViewSlot } from "../App";
import { LedgerViewMemory, TAB_MODULE } from "./ledgerView";

// A remote change remounts the shared Ledger (SyncHost re-keys it), and
// Settings unmounts it. GitHub mode keeps the open tab and month across
// that: the Ledger opens on its view slot's `initial` and reports what is
// on screen through `report`. The client tests run without a DOM, so the
// Ledger is server-rendered and the report element is read, not mounted.

afterEach(() => vi.unstubAllGlobals());

const ALL: ModuleName[] = ["expenses", "credit-cards", "debts", "emi", "subscriptions", "finances"];

/** A slot that opens on `initial` and records each view reported. */
function slot(initial: LedgerView | null) {
  const reported: LedgerView[] = [];
  const view: LedgerViewSlot = {
    initial,
    report: (v) => {
      reported.push(v);
      return null;
    },
  };
  return { view, reported };
}

const render = (view: LedgerViewSlot) => renderToString(createElement(Ledger, { session: null, view } as Parameters<typeof Ledger>[0]));

describe("Ledger's view slot", () => {
  // The theme toggle in the header reads the stored theme.
  beforeEach(() => vi.stubGlobal("localStorage", { getItem: () => "light", setItem: () => {} }));

  it("in GitHub mode, opens on the slot's tab and month and reports them", () => {
    vi.stubGlobal("__LEDGER_STORAGE__", "github");
    const { view, reported } = slot({ tab: "finances", year: 2025, month: 3 });
    const html = render(view);
    // The month picker shows for Finances, on March 2025.
    expect(html).toMatch(/<option value="3" selected="">March<\/option>/);
    expect(html).toMatch(/<option value="2025" selected="">2025<\/option>/);
    expect(html).not.toContain('class="selected"');
    expect(reported.at(-1)).toEqual({ tab: "finances", year: 2025, month: 3 });
  });

  it("in GitHub mode with nothing kept, opens on the Dashboard and this month", () => {
    vi.stubGlobal("__LEDGER_STORAGE__", "github");
    const { view, reported } = slot(null);
    const html = render(view);
    expect(html).toContain('class="selected"');
    const now = new Date();
    expect(reported.at(-1)).toEqual({ tab: "dashboard", year: now.getFullYear(), month: now.getMonth() + 1 });
  });

  it("in the default build, takes no notice of the slot", () => {
    vi.stubGlobal("__LEDGER_STORAGE__", "supabase");
    const { view, reported } = slot({ tab: "finances", year: 2025, month: 3 });
    const html = render(view);
    expect(html).toContain('class="selected"');
    expect(html).not.toContain("month-picker");
    expect(reported).toEqual([]);
  });
});

describe("LedgerViewMemory", () => {
  const modules = (list: ModuleName[] | null) => () => list;
  const debts: LedgerView = { tab: "debts", year: 2026, month: 5 };

  /** What a slot's report element commits, as its effect would. */
  function commit(element: unknown) {
    const { props } = element as ReactElement<{ commit: () => void }>;
    props.commit();
  }

  it("opens on nothing until a view is reported, then on that view", () => {
    const memory = new LedgerViewMemory();
    const first = memory.slot("sam/ledger-data", modules(ALL));
    expect(first.initial).toBeNull();
    commit(first.report(debts));
    expect(memory.slot("sam/ledger-data", modules(ALL)).initial).toEqual(debts);
  });

  it("only remembers a view once its report is committed", () => {
    const memory = new LedgerViewMemory();
    memory.slot("sam/ledger-data", modules(ALL)).report(debts);
    expect(memory.slot("sam/ledger-data", modules(ALL)).initial).toBeNull();
  });

  it("opens on the Dashboard, same month, when the tab's section was turned off meanwhile", () => {
    const memory = new LedgerViewMemory();
    commit(memory.slot("sam/ledger-data", modules(ALL)).report(debts));
    expect(memory.slot("sam/ledger-data", modules(["expenses"])).initial).toEqual({ ...debts, tab: "dashboard" });
    expect(memory.slot("sam/ledger-data", modules(null)).initial).toEqual({ ...debts, tab: "dashboard" });
  });

  it("forgets the view when another ledger opens", () => {
    const memory = new LedgerViewMemory();
    commit(memory.slot("sam/ledger-data", modules(ALL)).report(debts));
    expect(memory.slot("kai/ledger-data", modules(ALL)).initial).toBeNull();
    expect(memory.slot("sam/ledger-data", modules(ALL)).initial).toBeNull();
  });

  it("goes back to the Dashboard on request, keeping the month", () => {
    const memory = new LedgerViewMemory();
    commit(memory.slot("sam/ledger-data", modules(ALL)).report(debts));
    memory.goHome();
    expect(memory.slot("sam/ledger-data", modules(ALL)).initial).toEqual({ ...debts, tab: "dashboard" });
  });

  it("knows the section of every tab App.tsx has", () => {
    // App.tsx's NAV_TABS is not exported (the default build is kept
    // byte-identical), so its tab-to-module pairs are read from the source.
    const pairs = Object.fromEntries([...appSource.matchAll(/\{ tab: "(\w+)", module: "([\w-]+)"/g)].map((m) => [m[1], m[2]]));
    expect(Object.keys(pairs).length).toBeGreaterThan(0);
    expect(TAB_MODULE).toEqual(pairs);
  });
});
