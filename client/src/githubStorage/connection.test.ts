import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { forgetDevice, type Connection } from "../backend/github/deviceStore";
import { forget, loadSaved, remember, resetMemoryForTests } from "./connection";

// #8's connection wrapper over #6's deviceStore. Fictional data only.

const connection: Connection = { kind: "pat", token: "github_pat_test", owner: "alex", repo: "ledger-data", path: "ledger", login: "alex", branch: "main" };

async function testKey() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { key, salt: "c2FsdA==", iter: 600_000 };
}

afterEach(async () => {
  resetMemoryForTests();
  await forgetDevice();
});

describe("the saved connection and key (#8)", () => {
  it("a fresh device has nothing saved; once remembered, both come back", async () => {
    expect(await loadSaved()).toEqual({ connection: null, key: null, remembered: true });
    const key = await testKey();
    expect(await remember(connection, key)).toBe(true);
    const saved = await loadSaved();
    expect(saved.connection).toEqual(connection);
    expect(saved.key).toMatchObject({ salt: key.salt, iter: key.iter });
    expect(saved.remembered).toBe(true);
  });

  it("when the browser keeps nothing, both live in this tab's memory and the gate is told", async () => {
    const real = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true });
    try {
      expect(await loadSaved()).toEqual({ connection: null, key: null, remembered: false });
      const key = await testKey();
      expect(await remember(connection, key)).toBe(false);
      expect(await loadSaved()).toEqual({ connection, key, remembered: false });
    } finally {
      Object.defineProperty(globalThis, "indexedDB", { value: real, configurable: true });
    }
  });
});

describe("Forget this device in the wrapper (#8)", () => {
  it("in a browser that keeps nothing, forgets what the tab holds and succeeds", async () => {
    const real = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", { value: undefined, configurable: true });
    try {
      await remember(connection, await testKey());
      expect(await forget(null)).toEqual({ ok: true });
      expect(await loadSaved()).toEqual({ connection: null, key: null, remembered: false });
    } finally {
      Object.defineProperty(globalThis, "indexedDB", { value: real, configurable: true });
    }
  });

  it("forced, it drops only what the person was told about: more since then is refused", async () => {
    const engine = { getState: () => ({ pendingCount: 3, leftBehindOwnCount: 0 }), syncNow: async () => {} } as never;
    expect(await forget(engine, { force: true, confirmed: { pendingCount: 2, leftBehindOwnCount: 0 } })).toEqual({ ok: false, pendingCount: 3, leftBehindOwnCount: 0 });
  });
});
