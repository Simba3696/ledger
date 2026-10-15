import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetDevice, type Connection } from "../backend/github/deviceStore";
import { AppSession } from "../backend/github/appAuth";
import { appTokenStore, forget, loadSaved, remember, resetMemoryForTests } from "./connection";

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

describe("Sign in with GitHub's tokens in the wrapper (#10)", () => {
  const app: Connection = { ...connection, kind: "app", token: "ghu_alexold", expiresAt: "2026-10-14T20:00:00.000Z", refreshToken: "ghr_alexold", refreshTokenExpiresAt: "2027-04-12T12:00:00.000Z" };
  const fresh = { token: "ghu_alexnew", expiresAt: "2026-10-15T04:00:00.000Z", refreshToken: "ghr_alexnew", refreshTokenExpiresAt: "2027-04-13T12:00:00.000Z" };

  it("the token store reads and compare-and-sets the saved App tokens, and only when the saved record is this connection's", async () => {
    const store = appTokenStore({ ...app });
    expect(await store.load()).toBeNull();
    expect(await store.save(fresh, "ghr_alexold")).toBe(false);
    expect((await loadSaved()).connection).toBeNull();

    await remember(app, await testKey());
    expect(await store.load()).toEqual({ token: "ghu_alexold", expiresAt: app.expiresAt, refreshToken: "ghr_alexold", refreshTokenExpiresAt: app.refreshTokenExpiresAt });
    // Another tab saved since: the expected refresh token no longer matches.
    expect(await store.save({ token: "" }, "ghr_spent")).toBe(false);
    expect(await store.save(fresh, "ghr_alexold")).toBe(true);
    expect((await loadSaved()).connection).toEqual({ ...app, ...fresh });
    expect(await store.save({ token: "" }, "ghr_alexnew")).toBe(true);
    const { expiresAt: _e, refreshToken: _r, refreshTokenExpiresAt: _x, ...rest } = app;
    expect((await loadSaved()).connection).toEqual({ ...rest, token: "" });

    // Another repo's, or a pasted token's, record is never touched.
    expect(await appTokenStore({ ...app, repo: "other-repo" }).load()).toBeNull();
    await remember({ ...connection }, await testKey());
    expect(await store.load()).toBeNull();
    expect(await store.save(fresh, undefined)).toBe(false);
    expect((await loadSaved()).connection).toEqual(connection);
  });

  it("a refresh that lands during Forget this device saves nothing and leaves no database behind", async () => {
    await remember(app, await testKey());
    let answer!: (res: Response) => void;
    const helperFetch = (() => new Promise<Response>((resolve) => (answer = resolve))) as typeof fetch;
    const record = { ...app };
    const session = new AppSession(record, { helperUrl: "https://signin.example.workers.dev", fetch: helperFetch, store: appTokenStore(record), locks: null });
    const refreshing = session.onUnauthorized();
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    expect(await forget(null)).toEqual({ ok: true });
    answer(Response.json({ access_token: "ghu_alexnew", expires_in: 28_800, refresh_token: "ghr_alexnew", refresh_token_expires_in: 15_897_600 }));
    expect(await refreshing).toBe(true);
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).not.toContain("ledger:github");
    expect(await loadSaved()).toEqual({ connection: null, key: null, remembered: true });
  });

  it("a save already under way when Forget starts is waited for (it gives up) before the database is deleted", async () => {
    await remember(app, await testKey());
    const store = appTokenStore({ ...app });
    let settled = false;
    const saving = store.save(fresh, "ghr_alexold").finally(() => (settled = true));
    const forgetting = forget(null).then((done) => {
      expect(settled).toBe(true);
      return done;
    });
    expect(await saving).toBe(false);
    expect(await forgetting).toEqual({ ok: true });
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain("ledger:github");
  });

  it("Forget this device also removes a sign-in in progress (ledger:github-signin)", async () => {
    const entries = new Map<string, string>([["ledger:github-signin", "{}"]]);
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => entries.get(k) ?? null, removeItem: (k: string) => void entries.delete(k), setItem: () => {} });
    try {
      await remember(app, await testKey());
      expect(await forget(null)).toEqual({ ok: true });
      expect(entries.has("ledger:github-signin")).toBe(false);
      expect(await loadSaved()).toEqual({ connection: null, key: null, remembered: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
