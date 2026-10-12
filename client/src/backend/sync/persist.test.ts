import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dumpDatabase, faultyIndexedDB, tamper } from "./localTestkit";
import { LocalStateNewer, StoreUnreadable, WriterTokenMismatch, clearSyncState, openSyncStore, type Mutation } from "./persist";

// The ledger:sync records (design section 10.1) at the store level: one
// transaction per mutation over every record it touches, checked against
// the writer token; a failure of any kind writes nothing; a load that fails
// is never "nothing stored"; and "Start as a new device" leaves the old
// records byte for byte as they were. The engine tests cover the same rules
// through the commit path.

const noWait = { sleep: async () => {} };
const META = { formatVersion: 1, writerToken: "t1" };

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.stubGlobal("indexedDB", factory);
  await clearSyncState();
  vi.unstubAllGlobals();
});

function first(extra: Partial<Mutation> = {}): Mutation {
  return { expect: null, meta: META, base: "base-1", ...extra };
}

/** indexedDB whose open() throws, the first `times` calls. */
function failingOpens(times: number): void {
  const real = globalThis.indexedDB;
  let left = times;
  vi.stubGlobal(
    "indexedDB",
    new Proxy(real, {
      get(target, prop) {
        if (prop === "open" && left > 0) {
          left--;
          return () => {
            throw new DOMException("Connection to Indexed Database server lost", "UnknownError");
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
}

describe("records and transactions", () => {
  it("round-trips every record kind, and nothing stored loads as null", async () => {
    const store = openSyncStore(noWait);
    expect(await store.load()).toBeNull();
    await store.mutate(first({ tail: ["t-a"], ownLog: { put: [[2, "o-2"]] }, chain: [[2, "c-2"]], notices: { put: [["n1", "x"]] }, old: "old-1", leftBehind: { put: [["g1", "y"]] } }));
    await store.mutate({ expect: "t1", meta: META, tail: ["t-b"], ownLog: { put: [[5, "o-5"], [3, "o-3"]] }, chain: [[3, "c-3"]] });
    const records = await openSyncStore(noWait).load();
    expect(records).toEqual({
      meta: META,
      base: "base-1",
      tail: ["t-a", "t-b"],
      ownLog: [
        [2, "o-2"],
        [3, "o-3"],
        [5, "o-5"],
      ],
      chainHead: [3, "c-3"],
      noticeCount: 1,
      leftBehind: [["g1", "y"]],
      old: "old-1",
    });
  });

  it("applies a compaction's writes: a new base with tail cleared, own ops trimmed through K, records removed", async () => {
    const store = openSyncStore(noWait);
    await store.mutate(first({ tail: ["t-a", "t-b"], ownLog: { put: [[2, "o-2"], [3, "o-3"], [4, "o-4"]] }, chain: [[4, "c-4"]], notices: { put: [["n1", "x"], ["n2", "y"]] }, old: "old-1" }));
    await store.mutate({ expect: "t1", meta: META, base: "base-2", clearTail: true, tail: ["t-c"], ownLog: { dropThrough: 3 }, notices: { delete: ["n1"] }, old: null });
    expect(await store.load()).toMatchObject({ base: "base-2", tail: ["t-c"], ownLog: [[4, "o-4"]], chainHead: [4, "c-4"], noticeCount: 1, old: undefined });
    await store.mutate({ expect: "t1", meta: META, clearChain: true, chain: [[1, "c-1"]] });
    expect((await store.load())?.chainHead).toEqual([1, "c-1"]);
  });

  it("checks the writer token in the same transaction: a mismatch writes nothing", async () => {
    const store = openSyncStore(noWait);
    await store.mutate(first());
    const before = await dumpDatabase();
    await expect(store.mutate({ expect: "someone-else", meta: { ...META, writerToken: "t2" }, tail: ["t-x"] })).rejects.toBeInstanceOf(WriterTokenMismatch);
    // A first start never writes over saved records.
    await expect(store.mutate(first({ base: "base-9" }))).rejects.toBeInstanceOf(WriterTokenMismatch);
    expect(await dumpDatabase()).toBe(before);
  });

  it("a quota error on any one record writes none of the mutation, and the next mutation still reaches IndexedDB", async () => {
    const store = openSyncStore(noWait);
    await store.mutate(first());
    const before = await dumpDatabase();
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "chain") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return put.apply(this, args);
    });
    await expect(store.mutate({ expect: "t1", meta: { ...META, n: 2 }, tail: ["t-a"], ownLog: { put: [[2, "o-2"]] }, chain: [[2, "c-2"]] })).rejects.toThrow(/quota/);
    expect(await dumpDatabase()).toBe(before);
    vi.restoreAllMocks();
    await store.mutate({ expect: "t1", meta: META, tail: ["t-b"] });
    expect((await openSyncStore(noWait).load())?.tail).toEqual(["t-b"]);
  });

  it("a transaction that aborts after its writes were issued keeps none of them", async () => {
    const store = openSyncStore(noWait);
    await store.mutate(first());
    const before = await dumpDatabase();
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      const request = put.apply(this, args);
      if (this.name === "ownLog") this.transaction.abort();
      return request;
    });
    await expect(store.mutate({ expect: "t1", meta: META, tail: ["t-a"], ownLog: { put: [[2, "o-2"]] }, chain: [[2, "c-2"]] })).rejects.toThrow();
    expect(await dumpDatabase()).toBe(before);
  });
});

describe("loads that fail are never a first start", () => {
  it("retries a read that fails once, and finds the saved records", async () => {
    await openSyncStore(noWait).mutate(first());
    vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementationOnce(() => {
      throw new DOMException("Connection to Indexed Database server lost", "UnknownError");
    });
    expect((await openSyncStore(noWait).load())?.base).toBe("base-1");
  });

  it("rejects with StoreUnreadable when the read keeps failing, and writes nothing", async () => {
    await openSyncStore(noWait).mutate(first());
    const before = await dumpDatabase();
    vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(() => {
      throw new DOMException("Connection to Indexed Database server lost", "UnknownError");
    });
    await expect(openSyncStore(noWait).load()).rejects.toBeInstanceOf(StoreUnreadable);
    vi.restoreAllMocks();
    expect(await dumpDatabase()).toBe(before);
  });

  it("retries an open that fails once (B22): the saved records load", async () => {
    await openSyncStore(noWait).mutate(first());
    failingOpens(1);
    const store = openSyncStore(noWait);
    expect((await store.load())?.base).toBe("base-1");
    expect(store.volatile()).toBe(false);
  });

  it("a database that never opens is unreadable unless the browser refuses storage: a lost connection or a full quota is not a first start", async () => {
    for (const name of ["UnknownError", "QuotaExceededError", "AbortError"]) {
      vi.stubGlobal("indexedDB", faultyIndexedDB(factory, () => new DOMException("did not open", name)));
      const store = openSyncStore(noWait);
      await expect(store.load(), name).rejects.toBeInstanceOf(StoreUnreadable);
      expect(store.volatile()).toBe(false);
      await expect(store.mutate(first())).rejects.toThrow();
    }
    vi.stubGlobal("indexedDB", factory);
    expect(await indexedDB.databases()).toEqual([]);
  });

  it("falls back to tab memory only when the browser refuses storage and the database never opens, and says so", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("indexedDB", faultyIndexedDB(factory, () => new DOMException("The operation is insecure.", "SecurityError"), { sync: true }));
    const store = openSyncStore(noWait);
    expect(await store.load()).toBeNull();
    expect(store.volatile()).toBe(true);
    await store.mutate(first());
    expect((await store.load())?.base).toBe("base-1");
    await expect(store.mutate(first())).rejects.toBeInstanceOf(WriterTokenMismatch);
  });

  it("once the database has opened, a later failing load is unreadable, never memory", async () => {
    const store = openSyncStore(noWait);
    await store.mutate(first());
    vi.spyOn(IDBObjectStore.prototype, "get").mockImplementation(() => {
      throw new DOMException("Connection to Indexed Database server lost", "UnknownError");
    });
    await expect(store.load()).rejects.toBeInstanceOf(StoreUnreadable);
    expect(store.volatile()).toBe(false);
  });

  it("records with no meta are unreadable, not a first start", async () => {
    await openSyncStore(noWait).mutate(first({ tail: ["t-a"] }));
    await tamper("ledger:sync", "meta", (s) => s.delete("meta"));
    await expect(openSyncStore(noWait).load()).rejects.toBeInstanceOf(StoreUnreadable);
  });

  it("a database a newer build upgraded is LocalStateNewer, and stays as it was", async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.open("ledger:sync", 2);
      req.onupgradeneeded = () => req.result.createObjectStore("everything");
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
    });
    const before = await dumpDatabase();
    const store = openSyncStore(noWait);
    await expect(store.load()).rejects.toBeInstanceOf(LocalStateNewer);
    expect(store.volatile()).toBe(false);
    expect(await dumpDatabase()).toBe(before);
  });
});

describe("generations", () => {
  it("Start as a new device leaves the old records untouched; later loads read the new generation; clearSyncState deletes both", async () => {
    const store = openSyncStore(noWait);
    await store.mutate(first());
    const before = await dumpDatabase();
    await store.startNewGeneration();
    expect(await store.load()).toBeNull();
    await store.mutate(first({ base: "base-new" }));
    expect(await dumpDatabase()).toBe(before);
    expect((await openSyncStore(noWait).load())?.base).toBe("base-new");

    await clearSyncState();
    expect(await indexedDB.databases()).toEqual([]);
    expect(await openSyncStore(noWait).load()).toBeNull();
  });

  it("finds the newest generation by probing when indexedDB.databases() is missing, and creates none while probing", async () => {
    vi.stubGlobal("indexedDB", faultyIndexedDB(factory, () => null, { databases: false }));
    const store = openSyncStore(noWait);
    await store.mutate(first());
    await store.startNewGeneration();
    await store.mutate(first({ base: "base-new" }));
    expect((await openSyncStore(noWait).load())?.base).toBe("base-new");
    expect((await factory.databases()).map((db) => db.name).sort()).toEqual(["ledger:sync", "ledger:sync:2"]);
  });

  it("a probe of the next generation that fails is not an absence: the store is unreadable, never memory or the older generation", async () => {
    await openSyncStore(noWait).mutate(first());
    const quota = (name: string) => (name === "ledger:sync:2" ? new DOMException("The quota has been exceeded.", "QuotaExceededError") : null);
    vi.stubGlobal("indexedDB", faultyIndexedDB(factory, quota, { databases: false }));
    const store = openSyncStore(noWait);
    await expect(store.load()).rejects.toBeInstanceOf(StoreUnreadable);
    expect(store.volatile()).toBe(false);

    // With databases() no probe is needed, and the saved records load.
    vi.stubGlobal("indexedDB", faultyIndexedDB(factory, quota));
    expect((await openSyncStore(noWait).load())?.base).toBe("base-1");
  });
});
