import { bytesToBase64 } from "../base64";
import { DEFAULT_ITERATIONS, newSalt } from "../crypto";
import type { Mutation, SyncStore } from "./persist";
import type { DeviceKey } from "./records";

// Test support for the engine's local half: a device key, a Web Locks fake,
// a store whose writes can be held at either side of the transaction, an
// indexedDB whose opens fail, and a raw dump of the ledger:sync databases. Imported only by tests, which load
// fake-indexeddb first.

/** A device key without the second of PBKDF2 a real one costs. */
export async function testKey(): Promise<DeviceKey> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { key, salt: bytesToBase64(newSalt()), iter: DEFAULT_ITERATIONS };
}

/** A promise and its resolve function. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** `inner` with hooks around each mutation: `before` runs before the
 * transaction starts, `after` once it has committed, and either can hold
 * the write there (a reload at that moment). Counts the mutations. */
export function hookedStore(inner: SyncStore, hooks: { before?: (m: Mutation) => Promise<void>; after?: (m: Mutation) => Promise<void> } = {}) {
  const calls = { started: 0, committed: 0 };
  const store: SyncStore = {
    load: () => inner.load(),
    chainEntry: (L) => inner.chainEntry(L),
    startNewGeneration: () => inner.startNewGeneration(),
    volatile: () => inner.volatile(),
    async mutate(m) {
      calls.started++;
      await hooks.before?.(m);
      await inner.mutate(m);
      calls.committed++;
      await hooks.after?.(m);
    },
  };
  return { store, calls };
}

/** One exclusive lock per name, granted in request order, as navigator.locks
 * does for the tabs of one browser. */
export class FakeLocks {
  readonly #held = new Set<string>();
  readonly #waiting = new Map<string, (() => void)[]>();

  request(name: string, optionsOrCallback: LockOptions | LockGrantedCallback<unknown>, maybeCallback?: LockGrantedCallback<unknown>): Promise<unknown> {
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback)!;
    const run = () => {
      this.#held.add(name);
      const result = Promise.resolve(callback({ name, mode: "exclusive" } as Lock));
      void result.finally(() => {
        this.#held.delete(name);
        this.#waiting.get(name)?.shift()?.();
      });
      return result;
    };
    if (!this.#held.has(name)) return run();
    if (options.ifAvailable) return Promise.resolve(callback(null));
    return new Promise((resolve, reject) => {
      const grant = () => run().then(resolve, reject);
      const queue = this.#waiting.get(name) ?? [];
      queue.push(grant);
      this.#waiting.set(name, queue);
      options.signal?.addEventListener("abort", () => {
        const at = queue.indexOf(grant);
        if (at >= 0) queue.splice(at, 1);
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }

  asLockManager(): LockManager {
    return this as unknown as LockManager;
  }
}

/** `real`, except that open(name) fails while `fail(name)` returns an
 * error: as an error event, the way a browser reports a full quota or a
 * corrupt backing store, or thrown at the call with `sync`. `databases:
 * false` hides indexedDB.databases(), as Firefox before 126 does. */
export function faultyIndexedDB(real: IDBFactory, fail: (name: string) => DOMException | null, options: { sync?: boolean; databases?: boolean } = {}): IDBFactory {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "databases" && options.databases === false) return undefined;
      if (prop === "open") {
        return (name: string, version?: number) => {
          const error = fail(name);
          if (!error) return target.open(name, version);
          if (options.sync) throw error;
          const failed = { error, result: undefined, onerror: null, onsuccess: null, onupgradeneeded: null } as unknown as IDBOpenDBRequest;
          setTimeout(() => failed.onerror?.call(failed, { preventDefault() {} } as unknown as Event));
          return failed;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Opens database `name` as it is, or null if it doesn't exist. */
function openExisting(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let created = false;
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => {
      created = true;
      req.transaction?.abort();
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = (event) => {
      event.preventDefault();
      if (created) resolve(null);
      else reject(req.error);
    };
  });
}

/** Every store, key and value of database `name`, and its version, as
 * text: equal text means byte-identical records. Null if it doesn't exist. */
export async function dumpDatabase(name = "ledger:sync"): Promise<string | null> {
  const db = await openExisting(name);
  if (!db) return null;
  try {
    const out: Record<string, unknown> = { version: db.version };
    for (const store of [...db.objectStoreNames].sort()) {
      const tx = db.transaction(store, "readonly");
      const keys = await request(tx.objectStore(store).getAllKeys());
      const values = await request(tx.objectStore(store).getAll());
      out[store] = keys.map((key, i) => [key, values[i]]);
    }
    return JSON.stringify(out);
  } finally {
    db.close();
  }
}

/** Runs `fn` on one store of database `name` in a readwrite transaction:
 * a test's way to plant records a build like this one would never write. */
export async function tamper(name: string, store: string, fn: (s: IDBObjectStore) => void): Promise<void> {
  const db = await openExisting(name);
  if (!db) throw new Error(`${name} doesn't exist`);
  try {
    const tx = db.transaction(store, "readwrite");
    fn(tx.objectStore(store));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
