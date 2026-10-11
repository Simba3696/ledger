// The sync engine's records on this device (design section 10.1): one
// IndexedDB database, `ledger:sync`, holding
//
//   meta        ids, counters and shas only (not encrypted)
//   base        the joined state at the last local compaction
//   tail        ops and remote deltas joined since `base`, by sequence
//   ownLog      this device's ops with L > K, by L: what its repo log holds
//   chain       this device's op hash chain for the epoch, by L
//   notices     notices to show (section 4.2), by key
//   old         the previous epoch's state after a restore (section 9.3)
//   leftBehind  restore leftovers to review (section 9.4), by group
//
// Every value but `meta` is ciphertext the caller made with the household
// key (records.ts): this module never sees plaintext. Every mutation is one
// transaction over every store it touches, and first checks the writer
// token in `meta` (section 10.2), so no pair of records can tear (B7) and a
// superseded tab writes nothing.
//
// The opener's hardening is the old engine's (persist.ts on the abandoned
// branch): a load retries the open at 50 and 250 ms (a transient "connection
// lost" must not pass for a browser that refuses storage, B22), the store
// falls back to tab memory only when the database never opened (some
// private windows), and a failed write fails only that write (B8).
//
// A load that still fails is never a first start (B13, B22): it rejects,
// and the engine shows `unreadable`. "Start as a new device" then opens the
// next generation of the database (`ledger:sync:2`, ...) and leaves the old
// one byte for byte as it was, as a raw backup. Loads use the newest
// generation that exists; clearSyncState() deletes them all.

const DB_NAME = "ledger:sync";
/** The IndexedDB schema version. A database a newer build upgraded opens
 * with a VersionError here, which reads as newer local state, not as a
 * browser without storage. */
const DB_VERSION = 1;
const STORES = ["meta", "base", "tail", "ownLog", "chain", "notices", "old", "leftBehind"] as const;
type StoreName = (typeof STORES)[number];
const META_KEY = "meta";
const BASE_KEY = "base";
const OLD_KEY = "old";

/** What a load reads: one consistent snapshot of every record. `meta` is
 * unvalidated: the engine checks it (records.ts). */
export interface StoredRecords {
  meta: unknown;
  base: string | undefined;
  /** In the order they were appended. */
  tail: string[];
  /** Ascending by L. */
  ownLog: [L: number, text: string][];
  /** The chain entry with the greatest L, or null when there is none. */
  chainHead: [L: number, text: string] | null;
  noticeCount: number;
  leftBehindCount: number;
  hasOld: boolean;
}

/** One transaction's writes. `meta` is always rewritten, so every mutation
 * re-asserts the writer token it checked. */
export interface Mutation {
  /** The writer token `meta` must hold now, or null when there must be no
   * `meta` yet (a first start). Anything else aborts the transaction with
   * WriterTokenMismatch and writes nothing. */
  expect: string | null;
  /** Plain JSON: ids, counters and shas only (records.ts SyncMeta). */
  meta: object;
  base?: string;
  /** Empties `tail` before appending (a local compaction or an epoch
   * switch, which also rewrites `base`). */
  clearTail?: boolean;
  tail?: string[];
  ownLog?: { put?: [L: number, text: string][]; dropThrough?: number };
  clearChain?: boolean;
  chain?: [L: number, text: string][];
  notices?: { put?: [key: string, text: string][]; delete?: string[] };
  /** A text replaces the `old` record; null removes it. */
  old?: string | null;
  leftBehind?: { put?: [key: string, text: string][]; delete?: string[] };
}

export interface SyncStore {
  /** The records, or null when nothing is stored (a first start). Rejects
   * when it can't tell: LocalStateNewer for a database a newer build
   * upgraded, StoreUnreadable for anything else that still fails after the
   * retries. A rejection is never "nothing stored". */
  load(): Promise<StoredRecords | null>;
  /** Applies one mutation in one transaction, or nothing. Rejects with
   * WriterTokenMismatch when `meta` doesn't hold `expect`, or with the
   * browser's error (a full quota, an aborted transaction). */
  mutate(mutation: Mutation): Promise<void>;
  /** Leaves the current database untouched and makes the next load read a
   * new, empty generation: "Start as a new device" (section 10.1). */
  startNewGeneration(): Promise<void>;
  /** Whether records go only to this tab's memory although the browser has
   * IndexedDB (it never opened): a reload loses what isn't in the repo. */
  volatile(): boolean;
}

/** The database holds records a newer build wrote. */
export class LocalStateNewer extends Error {
  override name = "LocalStateNewer";
}

/** The records couldn't be read. Not the same as none being stored. */
export class StoreUnreadable extends Error {
  override name = "StoreUnreadable";
}

/** Another tab (or a later start of this one) has taken over writing. */
export class WriterTokenMismatch extends Error {
  override name = "WriterTokenMismatch";
}

/** The database didn't open, as opposed to one read or write failing. */
class DatabaseUnavailable extends Error {
  override name = "DatabaseUnavailable";
}

/** Something that syncs in this tab and must stop when the state is cleared. */
interface Stoppable {
  stop(): void;
}

const running = new Set<Stoppable>();

function generationName(n: number): string {
  return n === 1 ? DB_NAME : `${DB_NAME}:${n}`;
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Whether database `name` exists, without creating it: an open with no
 * version that needs an upgrade is a new database, and aborting that
 * upgrade leaves none behind. */
function exists(idb: IDBFactory, name: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let created = false;
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(name);
    } catch (err) {
      reject(new DatabaseUnavailable(`${name} did not open`, { cause: err }));
      return;
    }
    request.onupgradeneeded = () => {
      created = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      request.result.close();
      resolve(true);
    };
    request.onerror = (event) => {
      if (created) {
        event.preventDefault();
        resolve(false);
      } else {
        reject(new DatabaseUnavailable(`${name} did not open`, { cause: request.error }));
      }
    };
  });
}

/** The newest generation that exists (1 when none does). */
async function newestGeneration(idb: IDBFactory): Promise<number> {
  let n = 1;
  while (await exists(idb, generationName(n + 1))) n++;
  return n;
}

function openDb(idb: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(name, DB_VERSION);
    } catch (err) {
      reject(new DatabaseUnavailable(`${name} did not open`, { cause: err }));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, store === "tail" ? { autoIncrement: true } : undefined);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let clearSyncState() in another tab delete the database.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = (event) => {
      event.preventDefault();
      const error = request.error;
      if (error?.name === "VersionError") reject(new LocalStateNewer(`${name} was upgraded by a newer build`, { cause: error }));
      else reject(new DatabaseUnavailable(`${name} did not open`, { cause: error }));
    };
  });
}

/** Resolves when `tx` commits; rejects with `reason()` (or the browser's
 * error) when it aborts. */
function finished(tx: IDBTransaction, reason: () => Error | null): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(reason() ?? tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function readAll(db: IDBDatabase): Promise<StoredRecords | null> {
  const tx = db.transaction([...STORES], "readonly");
  const store = (name: StoreName) => tx.objectStore(name);
  const done = finished(tx, () => null);
  const [meta, base, tail, ownKeys, ownValues, chainCursor, noticeCount, leftBehindCount, old, counts] = await Promise.all([
    settle(store("meta").get(META_KEY)),
    settle(store("base").get(BASE_KEY)),
    settle(store("tail").getAll()),
    settle(store("ownLog").getAllKeys()),
    settle(store("ownLog").getAll()),
    settle(store("chain").openCursor(null, "prev")),
    settle(store("notices").count()),
    settle(store("leftBehind").count()),
    settle(store("old").get(OLD_KEY)),
    Promise.all(STORES.map((name) => settle(store(name).count()))),
    done,
  ]);
  if (meta === undefined) {
    // Records with no meta are not a first start: every mutation writes
    // meta in the same transaction as anything else.
    if (counts.some((n) => n > 0)) throw new StoreUnreadable("ledger:sync holds records but no meta");
    return null;
  }
  return {
    meta,
    base: base as string | undefined,
    tail: tail as string[],
    ownLog: (ownKeys as number[]).map((L, i) => [L, ownValues[i] as string]),
    chainHead: chainCursor ? [chainCursor.key as number, chainCursor.value as string] : null,
    noticeCount,
    leftBehindCount,
    hasOld: old !== undefined,
  };
}

/** Runs `mutation` in one readwrite transaction over every store. Any
 * error, thrown or async, aborts the whole transaction. */
function writeAll(db: IDBDatabase, mutation: Mutation): Promise<void> {
  const tx = db.transaction([...STORES], "readwrite");
  let failure: Error | null = null;
  const abort = (err: unknown) => {
    failure ??= err instanceof Error ? err : new Error(String(err));
    try {
      tx.abort();
    } catch {
      // Already finished or aborting.
    }
  };
  const done = finished(tx, () => failure);
  const check = tx.objectStore("meta").get(META_KEY);
  check.onsuccess = () => {
    try {
      const meta = check.result as { writerToken?: unknown } | undefined;
      const holds = mutation.expect === null ? meta === undefined : meta?.writerToken === mutation.expect;
      if (!holds) {
        abort(new WriterTokenMismatch("Another tab has taken over this device's sync state"));
        return;
      }
      applyWrites((name) => tx.objectStore(name), mutation);
    } catch (err) {
      abort(err);
    }
  };
  return done;
}

function applyWrites(store: (name: StoreName) => IDBObjectStore, m: Mutation): void {
  store("meta").put(m.meta, META_KEY);
  if (m.base !== undefined) store("base").put(m.base, BASE_KEY);
  if (m.clearTail) store("tail").clear();
  for (const text of m.tail ?? []) store("tail").add(text);
  if (m.ownLog?.dropThrough !== undefined) store("ownLog").delete(IDBKeyRange.upperBound(m.ownLog.dropThrough));
  for (const [L, text] of m.ownLog?.put ?? []) store("ownLog").put(text, L);
  if (m.clearChain) store("chain").clear();
  for (const [L, text] of m.chain ?? []) store("chain").put(text, L);
  for (const key of m.notices?.delete ?? []) store("notices").delete(key);
  for (const [key, text] of m.notices?.put ?? []) store("notices").put(text, key);
  if (m.old === null) store("old").delete(OLD_KEY);
  else if (m.old !== undefined) store("old").put(m.old, OLD_KEY);
  for (const key of m.leftBehind?.delete ?? []) store("leftBehind").delete(key);
  for (const [key, text] of m.leftBehind?.put ?? []) store("leftBehind").put(text, key);
}

// --- Tab memory ------------------------------------------------------------

interface MemoryRecords {
  meta?: object;
  base?: string;
  tail: string[];
  ownLog: Map<number, string>;
  chain: Map<number, string>;
  notices: Map<string, string>;
  old?: string;
  leftBehind: Map<string, string>;
}

function emptyMemory(): MemoryRecords {
  return { tail: [], ownLog: new Map(), chain: new Map(), notices: new Map(), leftBehind: new Map() };
}

/** The tab's in-memory records, when IndexedDB never opened. */
let memory = emptyMemory();

function readMemory(): StoredRecords | null {
  if (memory.meta === undefined) return null;
  const ascending = <K extends number>(map: Map<K, string>) => [...map].sort(([a], [b]) => a - b);
  const chain = ascending(memory.chain);
  return {
    meta: structuredClone(memory.meta),
    base: memory.base,
    tail: [...memory.tail],
    ownLog: ascending(memory.ownLog),
    chainHead: chain.at(-1) ?? null,
    noticeCount: memory.notices.size,
    leftBehindCount: memory.leftBehind.size,
    hasOld: memory.old !== undefined,
  };
}

function writeMemory(m: Mutation): void {
  const meta = memory.meta as { writerToken?: unknown } | undefined;
  const holds = m.expect === null ? meta === undefined : meta?.writerToken === m.expect;
  if (!holds) throw new WriterTokenMismatch("Another tab has taken over this device's sync state");
  // Built on a copy and swapped in whole, so a throw leaves nothing half done.
  const next: MemoryRecords = {
    ...memory,
    tail: m.clearTail ? [] : [...memory.tail],
    ownLog: new Map(memory.ownLog),
    chain: m.clearChain ? new Map() : new Map(memory.chain),
    notices: new Map(memory.notices),
    leftBehind: new Map(memory.leftBehind),
  };
  next.meta = structuredClone(m.meta);
  if (m.base !== undefined) next.base = m.base;
  next.tail.push(...(m.tail ?? []));
  const dropThrough = m.ownLog?.dropThrough;
  if (dropThrough !== undefined) for (const L of [...next.ownLog.keys()]) if (L <= dropThrough) next.ownLog.delete(L);
  for (const [L, text] of m.ownLog?.put ?? []) next.ownLog.set(L, text);
  for (const [L, text] of m.chain ?? []) next.chain.set(L, text);
  for (const key of m.notices?.delete ?? []) next.notices.delete(key);
  for (const [key, text] of m.notices?.put ?? []) next.notices.set(key, text);
  if (m.old === null) delete next.old;
  else if (m.old !== undefined) next.old = m.old;
  for (const key of m.leftBehind?.delete ?? []) next.leftBehind.delete(key);
  for (const [key, text] of m.leftBehind?.put ?? []) next.leftBehind.set(key, text);
  memory = next;
}

// --- The store -------------------------------------------------------------

/** Waits before each new attempt at a load. */
const LOAD_RETRY_MS = [50, 250];

/** The store: IndexedDB when this browser has it and it opens, otherwise
 * memory for the life of the tab. It switches to memory only when the
 * database never opened in this store, on a load's every attempt. Any other
 * failure rejects, the caller's state unknown rather than empty. */
export function openSyncStore(options: { sleep?: (ms: number) => Promise<void> } = {}): SyncStore {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const hasIdb = typeof globalThis.indexedDB !== "undefined";
  let useMemory = !hasIdb;
  /** The database opened at least once: never fall back to memory after. */
  let opened = false;
  let generation: number | null = null;
  let connection: Promise<IDBDatabase> | null = null;

  const connect = async (): Promise<IDBDatabase> => {
    const idb = globalThis.indexedDB;
    generation ??= await newestGeneration(idb);
    const db = await openDb(idb, generationName(generation));
    opened = true;
    db.onclose = () => {
      connection = null;
    };
    const close = db.onversionchange;
    db.onversionchange = (event) => {
      connection = null;
      close?.call(db, event);
    };
    return db;
  };
  /** The open connection, reopened if it was closed or never opened. */
  const database = (): Promise<IDBDatabase> => {
    connection ??= connect().catch((err: unknown) => {
      connection = null;
      throw err;
    });
    return connection;
  };
  /** Runs `fn` on the connection, reopening once if it had been closed (a
   * transaction on a closed connection throws InvalidStateError and never
   * starts, so nothing was written). */
  const withDb = async <T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> => {
    try {
      return await fn(await database());
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "InvalidStateError")) throw err;
      connection = null;
      return fn(await database());
    }
  };

  return {
    async load() {
      let lastError: unknown;
      for (let attempt = 0; !useMemory; attempt++) {
        try {
          return await withDb(readAll);
        } catch (err) {
          if (err instanceof LocalStateNewer || err instanceof StoreUnreadable) throw err;
          lastError = err;
        }
        if (attempt < LOAD_RETRY_MS.length) {
          await sleep(LOAD_RETRY_MS[attempt]);
          continue;
        }
        if (opened || !(lastError instanceof DatabaseUnavailable)) {
          throw new StoreUnreadable("ledger:sync could not be read", { cause: lastError });
        }
        console.error("ledger:sync: IndexedDB never opened, keeping sync state in this tab's memory", lastError);
        useMemory = true;
      }
      return readMemory();
    },
    async mutate(mutation) {
      if (useMemory) {
        writeMemory(mutation);
        return;
      }
      await withDb((db) => writeAll(db, mutation));
    },
    async startNewGeneration() {
      if (useMemory) {
        memory = emptyMemory();
        return;
      }
      const idb = globalThis.indexedDB;
      const current = generation ?? (await newestGeneration(idb));
      // Close ours first, so nothing more is written to the old generation.
      const open = connection;
      connection = null;
      if (open) (await open.catch(() => null))?.close();
      generation = current + 1;
    },
    volatile: () => useMemory && hasIdb,
  };
}

/** Registers an engine so clearSyncState() can stop it. Returns the
 * unregister function. */
export function registerRunning(engine: Stoppable): () => void {
  running.add(engine);
  return () => {
    running.delete(engine);
  };
}

/** Forgets this device's sync state, for "Forget this device" (#8) and
 * after a restore (#9): stops every engine running in this tab first, so
 * none of them writes anything more, then deletes every generation of the
 * `ledger:sync` database and the in-memory copy. */
export async function clearSyncState(): Promise<void> {
  for (const engine of [...running]) engine.stop();
  running.clear();
  memory = emptyMemory();
  const idb = globalThis.indexedDB;
  if (typeof idb === "undefined") return;
  const newest = await newestGeneration(idb);
  for (let n = newest; n >= 1; n--) {
    await new Promise<void>((resolve, reject) => {
      const request = idb.deleteDatabase(generationName(n));
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}
