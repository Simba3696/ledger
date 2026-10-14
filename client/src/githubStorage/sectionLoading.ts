// Sections offline (GitHub mode). App.tsx lazy-loads every section after the
// Dashboard into its own chunk, and the Pages build has no service worker:
// a section whose chunk wasn't loaded before the connection dropped can't
// be opened offline, and React.lazy then throws. So once a ledger is open,
// and while online, every section module is imported here too, by the same
// specifier: the build resolves it to the chunk React.lazy loads (and Vite's
// preload helper loads its stylesheet), and the browser's module map then
// holds it for React.lazy to find offline. SectionLoadBoundary covers what
// still fails to load.

/** App.tsx's lazily loaded sections, by the same specifiers
 * (sectionLoading.test.ts checks they match). */
export const SECTION_LOADERS: readonly (() => Promise<unknown>)[] = [
  () => import("../components/AddExpenseForm"),
  () => import("../components/RecentEntries"),
  () => import("../components/Finances"),
  () => import("../components/Debts"),
  () => import("../components/CreditCards"),
  () => import("../components/EMI"),
  () => import("../components/Subscriptions"),
];

/** What warmSections needs from the browser. */
export interface WarmEnv {
  onLine(): boolean;
  addEventListener(type: "online", listener: () => void): void;
  removeEventListener(type: "online", listener: () => void): void;
  /** Fetches each stylesheet that failed to load again. Vite's preload
   * helper never asks for a stylesheet twice, so one that failed when the
   * connection dropped would otherwise stay missing. */
  reloadFailedStyles(): void;
}

/** Stylesheet links whose load failed, seen by a capture listener (a
 * link's error event doesn't bubble). */
const failedStyles = new Set<HTMLLinkElement>();
let watchingStyles = false;

function browserEnv(): WarmEnv {
  if (!watchingStyles) {
    watchingStyles = true;
    document.addEventListener(
      "error",
      (event) => {
        const target = event.target;
        if (target instanceof HTMLLinkElement && target.rel === "stylesheet") failedStyles.add(target);
      },
      true,
    );
  }
  return {
    onLine: () => navigator.onLine,
    addEventListener: (type, listener) => window.addEventListener(type, listener),
    removeEventListener: (type, listener) => window.removeEventListener(type, listener),
    reloadFailedStyles: () => {
      for (const link of failedStyles) if (link.isConnected) link.replaceWith(link.cloneNode());
      failedStyles.clear();
    },
  };
}

/** Loads every section now if online, else once back online. At each
 * "online" until stopped, stylesheets that failed are fetched afresh (one
 * fetched afresh may fail again) and the sections not yet loaded are tried
 * again; an "online" while a batch is loading runs another after it.
 * Returns stop. */
export function warmSections(env: WarmEnv = browserEnv(), loaders: readonly (() => Promise<unknown>)[] = SECTION_LOADERS): () => void {
  const pending = new Set(loaders);
  let running = false;
  let again = false;
  let stopped = false;
  const load = async () => {
    if (stopped || !env.onLine() || pending.size === 0) return;
    if (running) return void (again = true);
    running = true;
    const batch = [...pending];
    const results = await Promise.allSettled(batch.map((loadOne) => loadOne()));
    running = false;
    results.forEach((result, i) => {
      if (result.status === "fulfilled") pending.delete(batch[i]);
    });
    if (again) {
      again = false;
      online();
    }
  };
  const online = () => {
    if (stopped || !env.onLine()) return;
    if (running) return void (again = true);
    env.reloadFailedStyles();
    void load();
  };
  env.addEventListener("online", online);
  void load();
  return () => {
    stopped = true;
    env.removeEventListener("online", online);
  };
}

/** A chunk (or its stylesheet) that failed to load, in each browser's words
 * (Chromium, Firefox, Safari) and Vite's preload helper's. */
const CHUNK_LOAD_FAILED = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** Whether `err` is a section that failed to load. */
export function isChunkLoadError(err: unknown): boolean {
  return err instanceof Error && CHUNK_LOAD_FAILED.test(err.message);
}
