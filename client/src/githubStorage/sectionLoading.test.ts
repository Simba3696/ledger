import { afterEach, describe, expect, it, vi } from "vitest";
import appSource from "../App.tsx?raw";
import loadingSource from "./sectionLoading.ts?raw";
import { SECTION_LOADERS, isChunkLoadError, warmSections, type WarmEnv } from "./sectionLoading";

// The Pages build has no service worker, so a section whose chunk wasn't
// loaded before the connection dropped can't open offline. GitHub mode
// loads every section once the ledger is open and online, by the same
// specifiers App.tsx's React.lazy uses. Fictional data only.

afterEach(() => vi.restoreAllMocks());

/** An environment that is online or not, and fires "online" on request. */
function env(online: boolean) {
  const listeners = new Set<() => void>();
  const stale: { replaced: number }[] = [];
  const e: WarmEnv & { goOnline(): void; listeners: Set<() => void>; stale: typeof stale } = {
    onLine: () => online,
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    reloadFailedStyles: () => stale.forEach((s) => s.replaced++),
    goOnline() {
      online = true;
      for (const fn of [...listeners]) fn();
    },
    listeners,
    stale,
  };
  return e;
}

/** A loader that fails `failures` times, then loads. */
function loader(failures = 0) {
  const fn = vi.fn(() => (failures-- > 0 ? Promise.reject(new TypeError("Failed to fetch dynamically imported module: Debts.js")) : Promise.resolve({})));
  return fn;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("warmSections", () => {
  it("imports the very modules App.tsx lazy-loads, every one of them", () => {
    const specifiers = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].map((m) => m[1]).sort();
    const lazy = specifiers(appSource, /lazy\(\(\) => import\("\.\/components\/(\w+)"\)/g);
    const warmed = specifiers(loadingSource, /\(\) => import\("\.\.\/components\/(\w+)"\)/g);
    expect(lazy.length).toBe(7);
    expect(warmed).toEqual(lazy);
    expect(SECTION_LOADERS).toHaveLength(lazy.length);
  });

  it("loads every section once, at once when online", async () => {
    const loaders = [loader(), loader()];
    const e = env(true);
    const stop = warmSections(e, loaders);
    await settle();
    for (const load of loaders) expect(load).toHaveBeenCalledTimes(1);
    e.goOnline();
    await settle();
    for (const load of loaders) expect(load).toHaveBeenCalledTimes(1);
    stop();
  });

  it("waits for the connection when offline", async () => {
    const load = loader();
    const e = env(false);
    const stop = warmSections(e, [load]);
    await settle();
    expect(load).not.toHaveBeenCalled();
    e.goOnline();
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    stop();
  });

  it("tries a section that failed again at the next 'online', with its stylesheet fetched afresh", async () => {
    const [ok, flaky] = [loader(), loader(1)];
    const e = env(true);
    e.stale.push({ replaced: 0 });
    const stop = warmSections(e, [ok, flaky]);
    await settle();
    expect(flaky).toHaveBeenCalledTimes(1);
    e.goOnline();
    await settle();
    expect(ok).toHaveBeenCalledTimes(1);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(e.stale[0].replaced).toBe(1);
    // All loaded: nothing listens any more.
    expect(e.listeners.size).toBe(0);
    stop();
  });

  it("stops listening when stopped", () => {
    const e = env(false);
    const stop = warmSections(e, [loader()]);
    expect(e.listeners.size).toBe(1);
    stop();
    expect(e.listeners.size).toBe(0);
  });
});

describe("isChunkLoadError", () => {
  it("knows a section that failed to load, in each browser's words and Vite's", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://example.test/ledger/assets/Debts-abc.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module: https://example.test/ledger/assets/Debts-abc.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Unable to preload CSS for /ledger/assets/Debts-abc.css"))).toBe(true);
  });

  it("does not take other errors for one", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'amount')"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
