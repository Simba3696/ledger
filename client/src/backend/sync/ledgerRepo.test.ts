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
import { genesisState, type SyncState } from "./state";
import { deviceId, docText, emptyDocument } from "./testkit";

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
    // Who made it, for "Sam's restore replaced yours" (section 9.2).
    expect(opened).toMatchObject({ ok: true, reason: "create", by: "alex", at: 1 });
    expect(await openGenesis(found, await testKey())).toEqual({ ok: false, problem: "wrongPassphrase" });
    // A second create finds the first.
    expect(await createLedger(remote(), key, { doc: emptyDocument(), by: "sam", at: 2 })).toEqual({ kind: "exists" });
    expect(puts()).toHaveLength(1);
  });

  it("a genesis this build can't read is found, but not joined", async () => {
    await fake.seedFile(FULL, "ledger/e000001-0000000a.genesis.enc", '{"v":2}\nxx');
    expect(await findLedger(remote())).toEqual({ kind: "needsUpdate", epoch: "e000001-0000000a" });
    expect(await createLedger(remote(), key, { doc: emptyDocument(), by: "alex", at: 1 })).toEqual({ kind: "exists" });
    await fake.seedFile(FULL, "ledger/e000001-0000000a.genesis.enc", "not a file");
    // A damaged one is named, so the person can delete it (D26).
    const damagedFile = { path: "ledger/e000001-0000000a.genesis.enc", epoch: "e000001-0000000a", reason: "malformed" };
    expect(await findLedger(remote())).toEqual({ kind: "malformed", epoch: "e000001-0000000a", damagedFile });
    expect(await createLedger(remote(), key, { doc: emptyDocument(), by: "alex", at: 1 })).toEqual({ kind: "exists", damagedFile });
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

  it("a winning genesis this key can't open is named by findLedger, openGenesis and a restore's createLedger, nothing is written past it, and once it is deleted the restore creates the ledger (D26)", async () => {
    const backup = emptyDocument();
    backup.debts.push({ id: "00000000-0000-4000-8000-000000000d01", updatedAt: 1, updatedBy: "alex", name: "Sam", amount: "5.00" });
    const content = (doc: unknown) => ({ fv: 1, kind: "genesis", epoch: "e000001-0000000b", reason: "create", by: "alex", at: 1, basedOn: null, doc });
    const sealed = await encryptDocument(content(emptyDocument()), key.key, { salt: key.salt, iter: key.iter });
    const at = sealed.indexOf("\n") + 40;
    const other = await testKey();
    const path = "ledger/e000001-0000000b.genesis.enc";
    // The file, the reason the person is told, whether findLedger can tell
    // (it has no key), whether openGenesis can (its key is derived from the
    // file's own salt, so a key that doesn't fit reads as a wrong
    // passphrase), and whether a create can (its key is new, so a genesis
    // under another salt is a ledger to join).
    const cases: [string, string, string, boolean, boolean, boolean][] = [
      ["garbage bytes", "not a ledger file", "malformed", true, false, true],
      ["a sealed genesis that isn't a ledger", await encryptDocument(content({}), key.key, { salt: key.salt, iter: key.iter }), "malformed", false, true, false],
      ["a genesis altered after it was sealed", sealed.slice(0, at) + (sealed[at] === "A" ? "B" : "A") + sealed.slice(at + 1), "undecryptable", false, false, false],
      ["a genesis under another key", await encryptDocument(content(emptyDocument()), other.key, { salt: other.salt, iter: other.iter }), "foreignKey", false, false, false],
    ];
    for (const [name, text, reason, byFind, byOpen, byCreate] of cases) {
      fake = createFakeGitHub({ repos: [{ owner: "alex", name: "ledger-data", private: true }], tokens: { github_pat_alex: { login: "alex", repos: [FULL], permission: "write" } } });
      client = createGitHubClient({ owner: "alex", repo: "ledger-data", token: "github_pat_alex", fetch: fake.fetch });
      await fake.seedFile(FULL, path, text);
      const damagedFile = { path, epoch: "e000001-0000000b", reason };
      const found = await findLedger(remote());
      if (byFind) expect(found, name).toEqual({ kind: "malformed", epoch: "e000001-0000000b", damagedFile });
      else expect(found, name).toMatchObject({ kind: "ledger", epoch: "e000001-0000000b" });
      if (found.kind === "ledger") {
        const opened = await openGenesis(found, key);
        if (byOpen) expect(opened, name).toEqual({ ok: false, problem: "malformed", damagedFile });
        else expect(opened, name).toMatchObject({ ok: false, problem: "wrongPassphrase" });
      }
      // Nothing is written past it, whatever the reason.
      expect(await createLedger(remote(), key, { doc: backup, by: "alex", at: 1, reason: "restore" }), name).toEqual({ kind: "exists", damagedFile });
      expect(await createLedger(remote(), await testKey(), { doc: emptyDocument(), by: "alex", at: 1 }), name).toEqual(byCreate ? { kind: "exists", damagedFile } : { kind: "exists" });
      expect(puts(), name).toHaveLength(0);
      // The person deletes it on GitHub: the restore goes ahead.
      fake.removeFile(FULL, path);
      const created = await createLedger(remote(), key, { doc: backup, by: "alex", at: 1, reason: "restore" });
      expect(created, name).toMatchObject({ kind: "created", epoch: expect.stringMatching(/^e000001-[0-9a-f]{8}$/) });
      const now = await findLedger(remote());
      if (now.kind !== "ledger") throw new Error(now.kind);
      const restored = await openGenesis(now, key);
      expect(restored.ok && restored.doc.debts.map((x) => x.name), name).toEqual(["Sam"]);
    }
  });

  it("a winning genesis some device already joined (a log or snap of its epoch is listed) is named as joined, never as one to delete, by findLedger, openGenesis and createLedger (D26)", async () => {
    const epoch = "e000001-0000000b";
    const path = `ledger/${epoch}.genesis.enc`;
    const joined = { path, epoch, reason: "joined" };
    const content = (doc: unknown) => ({ fv: 1, kind: "genesis", epoch, reason: "create", by: "alex", at: 1, basedOn: null, doc });
    const other = await testKey();
    // The file, the device file listed beside it, and which call first can
    // tell it is damaged (findLedger has no key; openGenesis can't tell
    // another key from a wrong passphrase; a restore's createLedger can).
    const cases: [string, string, string, "find" | "open" | "create"][] = [
      ["garbage bytes", "not a ledger file", "log", "find"],
      ["a sealed genesis that isn't a ledger", await encryptDocument(content({}), key.key, { salt: key.salt, iter: key.iter }), "snap", "open"],
      ["a genesis under another key", await encryptDocument(content(emptyDocument()), other.key, { salt: other.salt, iter: other.iter }), "log", "create"],
    ];
    for (const [name, text, kind, by] of cases) {
      fake = createFakeGitHub({ repos: [{ owner: "alex", name: "ledger-data", private: true }], tokens: { github_pat_alex: { login: "alex", repos: [FULL], permission: "write" } } });
      client = createGitHubClient({ owner: "alex", repo: "ledger-data", token: "github_pat_alex", fetch: fake.fetch });
      await fake.seedFiles(FULL, { [path]: text, [`ledger/${epoch}.${deviceId(7)}.${kind}.enc`]: "a device's file" });
      const found = await findLedger(remote());
      if (by === "find") expect(found, name).toEqual({ kind: "malformed", epoch, damagedFile: joined });
      else if (found.kind !== "ledger") throw new Error(`${name}: ${found.kind}`);
      else expect(await openGenesis(found, key), name).toEqual(by === "open" ? { ok: false, problem: "malformed", damagedFile: joined } : { ok: false, problem: "wrongPassphrase" });
      expect(await createLedger(remote(), key, { doc: emptyDocument(), by: "alex", at: 1, reason: "restore" }), name).toEqual({ kind: "exists", damagedFile: joined });
      expect(puts(), name).toHaveLength(0);
    }
  });

  it("a damaged winner on a cut listing is never named: a greater epoch may be left out, and deleting a genesis under it would leave it uncounted (D26)", async () => {
    const cut: Pick<GitHubClient, "getRef" | "listDir" | "readBlob" | "putFile"> = {
      getRef: (...args) => client.getRef(...args),
      readBlob: (...args) => client.readBlob(...args),
      putFile: (...args) => client.putFile(...args),
      listDir: async (...args) => ({ ...(await client.listDir(...args)), truncated: true }),
    };
    await fake.seedFile(FULL, "ledger/e000001-0000000b.genesis.enc", "not a ledger file");
    expect(await findLedger({ client: cut, branch: "main" })).toEqual({ kind: "unknown" });
    expect(await createLedger({ client: cut, branch: "main" }, key, { doc: emptyDocument(), by: "alex", at: 1, reason: "restore" })).toEqual({ kind: "unknown" });
    const other = await testKey();
    await fake.seedFile(FULL, "ledger/e000001-0000000b.genesis.enc", await encryptDocument({ fv: 1, kind: "genesis" }, other.key, { salt: other.salt, iter: other.iter }));
    expect(await createLedger({ client: cut, branch: "main" }, key, { doc: emptyDocument(), by: "alex", at: 1, reason: "restore" })).toEqual({ kind: "unknown" });
    expect(puts()).toHaveLength(0);
    // One that decrypts but isn't a genesis: join (#8) finds it on the cut
    // listing, and openGenesis says it is malformed but names no file to
    // delete (stage 6 final review).
    await fake.seedFile(FULL, "ledger/e000001-0000000b.genesis.enc", await encryptDocument({ fv: 1, kind: "genesis" }, key.key, { salt: key.salt, iter: key.iter }));
    const found = await findLedger({ client: cut, branch: "main" });
    if (found.kind !== "ledger") throw new Error(found.kind);
    expect(await openGenesis(found, key)).toEqual({ ok: false, problem: "malformed" });
    // On a full listing it is named.
    const full = await findLedger(remote());
    if (full.kind !== "ledger") throw new Error(full.kind);
    expect(await openGenesis(full, key)).toEqual({ ok: false, problem: "malformed", damagedFile: { path: "ledger/e000001-0000000b.genesis.enc", epoch: "e000001-0000000b", reason: "malformed" } });
  });

  it("a restore into a repo with no ledger whose genesis would fill the gap below a genesis no device can open writes nothing and names that file (D26)", async () => {
    const gapped = "e000002-0000000b";
    const path = `ledger/${gapped}.genesis.enc`;
    await fake.seedFile(FULL, path, "not a ledger file");
    // Uncounted: no ledger yet.
    expect(await findLedger(remote())).toEqual({ kind: "none" });
    const backup = emptyDocument();
    expect(await createLedger(remote(), key, { doc: backup, by: "alex", at: 1, reason: "restore" })).toMatchObject({ kind: "failed", damagedFile: { path, epoch: gapped, reason: "malformed" } });
    expect(puts()).toHaveLength(0);
    fake.removeFile(FULL, path);
    expect(await createLedger(remote(), key, { doc: backup, by: "alex", at: 1, reason: "restore" })).toMatchObject({ kind: "created" });
  });

  /** An epoch 1 genesis another device created, planted as it would land. */
  async function plantCreate(epoch: string, with_: DeviceKey): Promise<void> {
    const content = { fv: 1, kind: "genesis", epoch, reason: "create", by: "alex", at: 1, basedOn: null, doc: emptyDocument() };
    await fake.seedFile(FULL, `ledger/${epoch}.genesis.enc`, await encryptDocument(content, with_.key, { salt: with_.salt, iter: with_.iter }));
  }

  /** A client whose first ref read sees the repo as it was before the
   * last commit: a listing that lags behind another device's create. */
  function lagging(login: string): GitHubClient {
    let first = true;
    return createGitHubClient({
      owner: "alex",
      repo: "ledger-data",
      token: `github_pat_${login}`,
      fetch: async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!first || !/git\/ref/.test(url)) return fake.fetch(input, init);
        first = false;
        fake.staleReads(1);
        try {
          return await fake.fetch(input, init);
        } finally {
          fake.staleReads(0);
        }
      },
    });
  }

  it("two devices creating at once with their own salts: the one that lists a greater epoch 1 after its create joins it, having written nothing locally", async () => {
    const keyA = await testKey();
    const keyB = await testKey();
    await plantCreate("e000001-ffffffff", keyA);
    // The second create's listing lags behind the first.
    const second = await createLedger({ client: lagging("sam"), branch: "main" }, keyB, { doc: emptyDocument(), by: "sam", at: 2 });
    expect(second).toMatchObject({ kind: "replaced", epoch: expect.stringMatching(/^e000001-/), winner: "e000001-ffffffff" });
    // Its join finds the winner, whose header names the other salt.
    const found = await findLedger(remote());
    expect(found).toMatchObject({ kind: "ledger", epoch: "e000001-ffffffff", salt: keyA.salt });
  });

  it("a create whose genesis landed but can't be listed after says so, and the next try joins what is found", async () => {
    let failRef = false;
    const flaky = createGitHubClient({
      owner: "alex",
      repo: "ledger-data",
      token: "github_pat_alex",
      fetch: async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        const method = init?.method ?? "GET";
        if (failRef && method === "GET" && /git\/ref/.test(url)) throw new TypeError("Failed to fetch");
        const res = await fake.fetch(input, init);
        if (method === "PUT" && res.ok) failRef = true;
        return res;
      },
    });
    expect(await createLedger({ client: flaky, branch: "main" }, key, { doc: emptyDocument(), by: "alex", at: 1 })).toEqual({ kind: "unknown" });
    expect(await createLedger(remote(), key, { doc: emptyDocument(), by: "alex", at: 1 })).toEqual({ kind: "exists" });
    expect(puts()).toHaveLength(1);
  });

  it("a create that lands but can't list the repo in full after it says unknown: a cut listing never decides the epoch (ADR-0008)", async () => {
    let cut = false;
    const cutting: Pick<GitHubClient, "getRef" | "listDir" | "readBlob" | "putFile"> = {
      getRef: (...args) => client.getRef(...args),
      readBlob: (...args) => client.readBlob(...args),
      putFile: async (write) => {
        const res = await client.putFile(write);
        cut = true;
        return res;
      },
      listDir: async (...args) => ({ ...(await client.listDir(...args)), truncated: cut }),
    };
    expect(await createLedger({ client: cutting, branch: "main" }, key, { doc: emptyDocument(), by: "alex", at: 1 })).toEqual({ kind: "unknown" });
    expect(await createLedger(remote(), key, { doc: emptyDocument(), by: "alex", at: 1 })).toEqual({ kind: "exists" });
  });

  it("two devices creating at once with one salt: when the later create wins, the earlier device's writes are offered for re-apply (section 9.3, cut {})", async () => {
    // The first create landed and its device started, before the second's.
    await plantCreate("e000001-00000000", key);
    const first = { epoch: "e000001-00000000", state: genesisState(emptyDocument()) };
    const second = await createLedger({ client: lagging("sam"), branch: "main" }, key, { doc: emptyDocument(), by: "sam", at: 2 });
    if (second.kind !== "created") throw new Error(`the greater key wins: ${second.kind}`);
    const w = { fake, key, doc: emptyDocument(), clock: { wall: Date.UTC(2026, 4, 10, 9), mono: 1_000_000 } };
    let offline = true;
    const open = async (login: string, from: { epoch: string; state: SyncState }): Promise<Device> => {
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
    for (const d of [a, b]) expect(d.engine.epochKey).toBe(second.epoch);
    expectConverged(a, b);
    const [group] = a.engine.leftBehind();
    expect(group).toMatchObject({ own: true });
    await a.engine.reapply(group.id);
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

  it("no answer and nothing listed: sent once more; twice, whether it landed is unknown, since either may still land", async () => {
    fake.failNext({ method: "PUT", network: true });
    expect(await writeGenesis(remote(), content(), key)).toMatchObject({ kind: "written" });
    expect(puts()).toHaveLength(2);
    fake.failNext({ method: "PUT", network: true });
    fake.failNext({ method: "PUT", network: true });
    expect(await writeGenesis(remote(), content("e000002-0000000a"), key)).toMatchObject({ kind: "unknown" });
    expect(puts()).toHaveLength(4);
  });

  it("an answer that says a PUT wasn't applied is a failure only when no earlier PUT went unanswered", async () => {
    fake.failNext({ method: "PUT", status: 422, message: "Invalid request. \"sha\" wasn't supplied." });
    expect(await writeGenesis(remote(), content(), key)).toMatchObject({ kind: "failed" });
    expect(puts()).toHaveLength(1);
    // No answer, then a refusal: the first may still land.
    fake.failNext({ method: "PUT", network: true });
    fake.failNext({ method: "PUT", status: 409 });
    expect(await writeGenesis(remote(), content("e000002-0000000a"), key)).toMatchObject({ kind: "unknown" });
    // No answer, then a rate limit: not thrown, since the first may still land.
    fake.failNext({ method: "PUT", network: true });
    fake.failNext({ method: "PUT", status: 429 });
    expect(await writeGenesis(remote(), content("e000003-0000000a"), key)).toMatchObject({ kind: "unknown" });
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
