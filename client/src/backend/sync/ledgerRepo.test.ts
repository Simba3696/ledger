import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptDocument } from "../crypto";
import { loadKey, saveKey } from "../github/deviceStore";
import { GitHubAuthError, createGitHubClient, type GitHubClient } from "../github/contents";
import { createFakeGitHub, type FakeGitHub } from "../github/fakeGitHub";
import { FULL, device, entry, expectConverged, quiesce, remarks, type Device } from "./cycleTestkit";
import { createLedger, findLedger, forgetThisDevice, openGenesis, readBackup, rememberRestore, takeRestoredEpoch, writeGenesis } from "./ledgerRepo";
import { testKey } from "./localTestkit";
import { openSyncStore } from "./persist";
import type { DeviceKey } from "./records";
import type { SyncEngine } from "./SyncEngine";
import { docText, emptyDocument } from "./testkit";

// The epoch hooks onboarding (#8) and backup (#9) call (design section
// 9.5): is there a ledger, create, join, a genesis written once under a
// fresh name, a backup opened, the restore remembered over the reload, and
// forget this device. Against the fake GitHub, with an empty repo to start.
// Fictional data only.

let fake: FakeGitHub;
let client: GitHubClient;
let key: DeviceKey;
const running: SyncEngine[] = [];
const remote = () => ({ client, branch: "main" });
const puts = () => fake.requests.filter((r) => r.method === "PUT");

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  fake = createFakeGitHub({
    repos: [{ owner: "alex", name: "ledger-data", private: true }],
    tokens: {
      github_pat_alex: { login: "alex", repos: [FULL], permission: "write" },
      github_pat_sam: { login: "sam", repos: [FULL], permission: "write" },
    },
  });
  client = createGitHubClient({ owner: "alex", repo: "ledger-data", token: "github_pat_alex", fetch: fake.fetch });
  key = await testKey();
});

afterEach(() => {
  for (const engine of running.splice(0)) engine.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("is there a ledger, create and join (section 9.5)", () => {
  it("an empty repo has none; create writes one genesis for epoch 1; join opens it with the key its header names", async () => {
    expect(await findLedger(remote())).toEqual({ kind: "none" });
    const created = await createLedger(remote(), key, { doc: emptyDocument(), by: "alex", at: 1 });
    expect(created).toMatchObject({ kind: "created", epoch: expect.stringMatching(/^e000001-[0-9a-f]{8}$/) });
    const epoch = (created as { epoch: string }).epoch;
    expect(fake.commits).toMatchObject([{ path: `ledger/${epoch}.genesis.enc`, message: "Create ledger" }]);

    const found = await findLedger(remote());
    expect(found).toMatchObject({ kind: "ledger", epoch, salt: key.salt, iter: key.iter });
    if (found.kind !== "ledger") throw new Error(found.kind);
    const opened = await openGenesis(found, key);
    expect(opened.ok && docText(opened.doc)).toBe(docText(emptyDocument()));
    expect(await openGenesis(found, await testKey())).toEqual({ ok: false, problem: "wrongPassphrase" });
    // A second create finds the first.
    expect(await createLedger(remote(), key, { doc: emptyDocument(), by: "sam", at: 2 })).toEqual({ kind: "exists" });
    expect(puts()).toHaveLength(1);
  });

  it("a genesis this build can't read is found, but not joined", async () => {
    await fake.seedFile(FULL, "ledger/e000001-0000000a.genesis.enc", '{"v":2}\nxx');
    expect(await findLedger(remote())).toEqual({ kind: "needsUpdate", epoch: "e000001-0000000a" });
    await fake.seedFile(FULL, "ledger/e000001-0000000a.genesis.enc", "not a file");
    expect(await findLedger(remote())).toEqual({ kind: "malformed", epoch: "e000001-0000000a" });
    expect(await createLedger(remote(), key, { doc: emptyDocument(), by: "alex", at: 1 })).toEqual({ kind: "exists" });
  });

  it("restoring a backup into a repo with no ledger is a create with the backup's own key; a device joins it", async () => {
    const backup = emptyDocument();
    backup.debts.push({ id: "00000000-0000-4000-8000-000000000d01", updatedAt: 1, updatedBy: "alex", name: "Sam", amount: "5.00" });
    const created = await createLedger(remote(), key, { doc: backup, by: "alex", at: 1, reason: "restore" });
    if (created.kind !== "created") throw new Error(created.kind);
    expect(fake.commits.at(-1)).toMatchObject({ message: "Restore from backup" });
    const w = { fake, key, doc: backup, clock: { wall: Date.UTC(2026, 4, 10, 9), mono: 1_000_000 } };
    const d = await device(w, { init: { epoch: created.epoch, state: created.state } });
    running.push(d.engine);
    expect(d.engine.current().debts.map((x) => x.name)).toEqual(["Sam"]);
    expect(d.engine.getState().status).toBe("idle");
  });

  it("two devices creating at once: the greater epoch key wins, and the other device's writes are offered for re-apply (section 9.3, cut {})", async () => {
    const first = await createLedger(remote(), key, { doc: emptyDocument(), by: "alex", at: 1 });
    // The second device's listing lags behind the first create.
    fake.staleReads(1);
    const second = await createLedger(remote(), key, { doc: emptyDocument(), by: "sam", at: 2 });
    fake.staleReads(0);
    if (first.kind !== "created" || second.kind !== "created") throw new Error("both should create");
    const w = { fake, key, doc: emptyDocument(), clock: { wall: Date.UTC(2026, 4, 10, 9), mono: 1_000_000 } };
    let offline = true;
    const open = async (login: string, from: typeof first): Promise<Device> => {
      // Offline at first: each writes in the epoch it created.
      const wrapFetch = (inner: typeof fetch): typeof fetch => (input, request) => (offline ? Promise.reject(new TypeError("Failed to fetch")) : inner(input, request));
      const d = await device(w, { login, init: { epoch: from.epoch, state: from.state }, wrapFetch });
      running.push(d.engine);
      return d;
    };
    const a = await open("alex", first);
    const b = await open("sam", second);
    await a.backend.addEntry(entry("Groceries"));
    await b.backend.addEntry(entry("Bus"));
    offline = false;
    await quiesce(w, a, b);
    const winner = first.epoch > second.epoch ? first.epoch : second.epoch;
    for (const d of [a, b]) expect(d.engine.epochKey).toBe(winner);
    expectConverged(a, b);
    const loser = first.epoch === winner ? b : a;
    const [group] = loser.engine.leftBehind();
    expect(group).toMatchObject({ own: true });
    await loser.engine.reapply(group.id);
    await quiesce(w, a, b);
    expect(remarks(a).sort()).toEqual(["Bus", "Groceries"]);
    expectConverged(a, b);
  });
});

describe("writing a genesis (section 9.2 step 5)", () => {
  const content = (epoch = "e000001-0000000a") => ({ epoch, reason: "create" as const, by: "alex", at: 1, basedOn: null, doc: emptyDocument() });

  it("a lost answer is settled by listing the path: it landed, and is not sent again", async () => {
    fake.landThenDropResponse({ method: "PUT" });
    expect(await writeGenesis(remote(), content(), key)).toMatchObject({ kind: "written" });
    expect(puts()).toHaveLength(1);
  });

  it("no answer and nothing listed: sent once more; twice, it failed", async () => {
    fake.failNext({ method: "PUT", network: true });
    expect(await writeGenesis(remote(), content(), key)).toMatchObject({ kind: "written" });
    expect(puts()).toHaveLength(2);
    fake.failNext({ method: "PUT", network: true });
    fake.failNext({ method: "PUT", network: true });
    expect(await writeGenesis(remote(), content("e000002-0000000a"), key)).toMatchObject({ kind: "failed" });
    expect(puts()).toHaveLength(4);
  });

  it("a name already taken is a failure at once, and a token the repo refuses throws", async () => {
    await fake.seedFile(FULL, "ledger/e000001-0000000a.genesis.enc", "someone else's");
    expect(await writeGenesis(remote(), content(), key)).toMatchObject({ kind: "failed" });
    expect(puts()).toHaveLength(1);
    fake.failNext({ method: "PUT", status: 401 });
    await expect(writeGenesis(remote(), content("e000002-0000000a"), key)).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("past the bounds every reader allows, nothing is sent", async () => {
    expect(await writeGenesis(remote(), content(), key, { bytes: 100, plainBytes: 1_000_000 })).toMatchObject({ kind: "tooLarge" });
    expect(await writeGenesis(remote(), content(), key, { bytes: 1_000_000, plainBytes: 100 })).toMatchObject({ kind: "tooLarge" });
    expect(puts()).toHaveLength(0);
  });

  it("refuses to write a genesis every reader would refuse", async () => {
    await expect(writeGenesis(remote(), { ...content(), doc: { ...emptyDocument(), version: 2 } as never }, key)).rejects.toThrow(/would be refused/);
    expect(puts()).toHaveLength(0);
  });
});

describe("a backup (section 9.5)", () => {
  it("opens to a writable document with the key it was sealed with; a newer one, a damaged one or another key is said so", async () => {
    const doc = emptyDocument();
    const seal = (value: unknown) => encryptDocument(value, key.key, { salt: key.salt, iter: key.iter });
    expect(await readBackup(await seal(doc), key.key)).toEqual({ ok: true, doc });
    expect(await readBackup(await seal({ ...doc, version: 2 }), key.key)).toEqual({ ok: false, problem: "newer" });
    expect(await readBackup(await seal({ ...doc, debts: "x" }), key.key)).toEqual({ ok: false, problem: "damaged" });
    expect(await readBackup('{"v":2}\nxx', key.key)).toEqual({ ok: false, problem: "newer" });
    expect(await readBackup(await seal(doc), (await testKey()).key)).toEqual({ ok: false, problem: "wrongPassphrase" });
  });

  it("the epoch a restore wrote is remembered for the reload, once", () => {
    expect(takeRestoredEpoch()).toBeNull();
    const items = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    });
    rememberRestore("e000002-0000000a");
    expect(takeRestoredEpoch()).toBe("e000002-0000000a");
    expect(takeRestoredEpoch()).toBeNull();
  });
});

describe("forget this device (section 9.5)", () => {
  async function databases(): Promise<string[]> {
    return (await indexedDB.databases()).map((db) => db.name ?? "");
  }

  it("with unsynced changes, syncs first and forgets nothing while any stay; then (or on force) clears the sync state, key and connection, and writes nothing to GitHub", async () => {
    await saveKey({ key: key.key, salt: key.salt, iter: key.iter });
    await openSyncStore().mutate({ expect: null, meta: { formatVersion: 1, writerToken: "t" }, base: "b" });
    expect(await databases()).toEqual(expect.arrayContaining(["ledger:sync", "ledger:github"]));
    let pendingCount = 2;
    const engine = { syncNow: vi.fn(async () => void (pendingCount = 1)), getState: () => ({ pendingCount, leftBehindOwnCount: 0 }) };
    expect(await forgetThisDevice(engine)).toEqual({ ok: false, pendingCount: 1, leftBehindOwnCount: 0 });
    expect(engine.syncNow).toHaveBeenCalledTimes(1);
    expect(await loadKey()).not.toBeNull();
    expect(await forgetThisDevice(engine, { force: true })).toEqual({ ok: true });
    expect(await databases()).not.toEqual(expect.arrayContaining(["ledger:sync"]));
    expect(await databases()).not.toEqual(expect.arrayContaining(["ledger:github"]));
    expect(fake.requests).toHaveLength(0);
    // Nothing unsynced: nothing to sync first.
    pendingCount = 0;
    expect(await forgetThisDevice(engine)).toEqual({ ok: true });
    expect(engine.syncNow).toHaveBeenCalledTimes(1);
  });
  it("forgets nothing while this device's own changes a restore left behind are unresolved, unless forced (D18)", async () => {
    const created = await createLedger(remote(), key, { doc: emptyDocument(), by: "alex", at: 1 });
    if (created.kind !== "created") throw new Error(created.kind);
    const w = { fake, key, doc: emptyDocument(), clock: { wall: Date.UTC(2026, 4, 10, 9), mono: 1_000_000 } };
    const a = await device(w, { login: "alex", init: { epoch: created.epoch, state: created.state } });
    const b = await device(w, { login: "sam", init: { epoch: created.epoch, state: created.state } });
    running.push(a.engine, b.engine);
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a, b);
    const backup = structuredClone(a.engine.current());
    await b.backend.addEntry(entry("Taxi")); // never pushed
    expect((await a.engine.restore(backup)).kind).toBe("restored");
    w.clock.mono += 10_000;
    await b.engine.sync();
    expect(b.engine.getState()).toMatchObject({ leftBehindOwnCount: 1, pendingCount: 0 });
    await saveKey({ key: key.key, salt: key.salt, iter: key.iter });
    expect(await forgetThisDevice(b.engine)).toEqual({ ok: false, pendingCount: 0, leftBehindOwnCount: 1 });
    expect(await loadKey()).not.toBeNull();
    expect(await forgetThisDevice(b.engine, { force: true })).toEqual({ ok: true });
    expect(await loadKey()).toBeNull();
  });
});
