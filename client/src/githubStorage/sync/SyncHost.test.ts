import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeLocks, testKey, tamper } from "../../backend/sync/localTestkit";
import { clearSyncState, openSyncStore } from "../../backend/sync/persist";
import { genesisState } from "../../backend/sync/state";
import { SyncEngine } from "../../backend/sync/SyncEngine";
import { emptyDocument } from "../../backend/sync/testkit";
import { SyncHost } from "./SyncHost";

// What SyncHost shows for each engine state (server-rendered: the client
// tests run without a DOM). Its layout effects, which attach the view and
// report each rendered revision, are covered through the engine's
// attachView() and rendered() in fence.test.ts.

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
});

afterEach(async () => {
  vi.stubGlobal("indexedDB", factory);
  await clearSyncState();
  vi.unstubAllGlobals();
});

async function engine(locks: LockManager | null = null) {
  const e = new SyncEngine({ key: await testKey(), actor: "alex", locks, log: () => {}, store: openSyncStore({ sleep: async () => {} }) });
  await e.start();
  return e;
}

const render = (e: SyncEngine) => renderToString(createElement(SyncHost, { engine: e }, createElement("main", null, "The ledger")));

describe("SyncHost", () => {
  it("shows the ledger once the engine has a document", async () => {
    const e = await engine();
    expect(render(e)).toContain("Loading your ledger");
    await e.initialize("e000001-0000000a", genesisState(emptyDocument()));
    expect(render(e)).toContain("The ledger");
  });

  it("tells a second tab that Ledger is open in another tab", async () => {
    const locks = new FakeLocks().asLockManager();
    await engine(locks);
    const second = await engine(locks);
    expect(render(second)).toContain("Ledger is open in another tab");
    expect(render(second)).not.toContain("The ledger");
  });

  it("offers Try again and Start as a new device when the saved state can't be read", async () => {
    const first = await engine();
    await first.initialize("e000001-0000000a", genesisState(emptyDocument()));
    first.stop();
    await tamper("ledger:sync", "meta", (s) => {
      const req = s.get("meta");
      req.onsuccess = () => s.put({ ...req.result, formatVersion: 2 }, "meta");
    });
    const html = render(await engine());
    expect(html).toContain("newer version of Ledger");
    expect(html).toContain("Try again");
    expect(html).toContain("Start as a new device");
    expect(html).not.toContain("The ledger");
  });
});
