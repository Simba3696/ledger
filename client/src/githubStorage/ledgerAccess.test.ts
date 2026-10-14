import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeGitHub, type FakeGitHub } from "../backend/github/fakeGitHub";
import { MemoryStore } from "../backend/sync/cycleTestkit";
import { FakeLocks } from "../backend/sync/localTestkit";
import { docText } from "../backend/sync/testkit";
import { forget, loadSaved, remember, resetMemoryForTests } from "./connection";
import { connect, createNew, keyFor, openLedger, unlock } from "./ledgerAccess";

// #8's connect, create, unlock and open, against the fake GitHub (which
// answers an empty repo as GitHub does). Fictional data only.

const FULL = "alex/ledger-data";
const PASSPHRASE = "correct horse battery staple";
const choices = { modules: ["expenses" as const], timeZone: "Asia/Kolkata" };
let fake: FakeGitHub;

beforeEach(() => {
  fake = createFakeGitHub({
    repos: [{ owner: "alex", name: "ledger-data", private: true }],
    tokens: {
      github_pat_alex: { login: "alex", repos: [FULL], permission: "write" },
      github_pat_sam: { login: "sam", repos: [FULL], permission: "write" },
    },
  });
});

const requests = () => fake.requests.map((r) => `${r.method} ${r.path.replace(/\?.*$/, "")}`);
const puts = () => fake.requests.filter((r) => r.method === "PUT");

describe("onboarding against the fake GitHub (#8)", () => {
  it("creates a ledger in an empty repo: who, the repo, an empty listing, one genesis PUT without a sha, a confirming listing", async () => {
    const connected = await connect("github_pat_alex", { owner: null, repo: "ledger-data" }, { fetch: fake.fetch });
    expect(connected.found).toEqual({ kind: "none" });
    expect(connected.connection).toMatchObject({ kind: "pat", owner: "alex", repo: "ledger-data", login: "alex", branch: "main" });
    const { result } = await createNew(connected, PASSPHRASE, choices);
    expect(result.kind).toBe("created");

    const log = requests();
    expect(log.slice(0, 3)).toEqual(["GET /user", "GET /repos/alex/ledger-data", "GET /repos/alex/ledger-data/git/ref/heads/main"]);
    const sent = puts();
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toMatch(/^\/repos\/alex\/ledger-data\/contents\/ledger\/e[0-9a-f-]+\.genesis\.enc$/);
    const body = JSON.parse(sent[0].body!) as { content: string; sha?: string };
    expect(body.sha).toBeUndefined();
    // The genesis is encrypted: its header line names the cipher, and the
    // rest isn't JSON.
    const text = new TextDecoder().decode(Uint8Array.from(atob(body.content.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
    const [header, ...rest] = text.split("\n");
    expect(JSON.parse(header)).toMatchObject({ alg: "AES-GCM-256" });
    expect(() => JSON.parse(rest.join("\n"))).toThrow();
    // After the PUT, createLedger lists the repo again to see whether another
    // device's create won.
    expect(log.slice(log.indexOf(`PUT ${sent[0].path}`) + 1)).toEqual(["GET /repos/alex/ledger-data/git/ref/heads/main", expect.stringMatching(/^GET \/repos\/alex\/ledger-data\/git\/trees\//)]);
    expect(fake.unhandled).toEqual([]);
  }, 30_000);

  it("a second device connects, finds the ledger, unlocks it and opens the same document", async () => {
    const alex = await connect("github_pat_alex", { owner: null, repo: "ledger-data" }, { fetch: fake.fetch });
    const created = await createNew(alex, PASSPHRASE, choices);
    if (created.result.kind !== "created") throw new Error(created.result.kind);
    const first = await openLedger(alex.connection, created.key, { epoch: created.result.epoch, sha: created.result.sha, state: created.result.state }, { fetch: fake.fetch, store: new MemoryStore() });
    if (first.kind !== "open") throw new Error(first.kind);

    const sam = await connect("github_pat_sam", { owner: "alex", repo: "ledger-data" }, { fetch: fake.fetch });
    if (sam.found.kind !== "ledger") throw new Error(sam.found.kind);
    const opened = await unlock(sam.found, PASSPHRASE);
    if (!opened.ok) throw new Error(opened.problem);
    const second = await openLedger(sam.connection, opened.key, opened.start, { fetch: fake.fetch, store: new MemoryStore() });
    if (second.kind !== "open") throw new Error(second.kind);
    expect(docText(second.engine.current())).toBe(docText(first.engine.current()));
    expect(second.engine.current().settings).toMatchObject({ modules: ["expenses"], timeZone: "Asia/Kolkata" });
    first.engine.stop();
    second.engine.stop();
  }, 30_000);

  it("a wrong passphrase opens nothing and writes nothing", async () => {
    const alex = await connect("github_pat_alex", { owner: null, repo: "ledger-data" }, { fetch: fake.fetch });
    await createNew(alex, PASSPHRASE, choices);
    const sam = await connect("github_pat_sam", { owner: "alex", repo: "ledger-data" }, { fetch: fake.fetch });
    if (sam.found.kind !== "ledger") throw new Error(sam.found.kind);
    const before = puts().length;
    expect(await unlock(sam.found, "not the passphrase")).toEqual({ ok: false, problem: "wrongPassphrase" });
    expect(puts()).toHaveLength(before);
  }, 30_000);

  it("a device whose sync state was cleared reopens with its saved key, no passphrase asked; a key for another salt can't", async () => {
    const alex = await connect("github_pat_alex", { owner: null, repo: "ledger-data" }, { fetch: fake.fetch });
    const created = await createNew(alex, PASSPHRASE, choices);
    // Nothing saved on this device yet, and no genesis handed over: the
    // engine finds the ledger and opens it with the saved key.
    const reopened = await openLedger(alex.connection, created.key, null, { fetch: fake.fetch, store: new MemoryStore() });
    expect(reopened.kind).toBe("open");
    if (reopened.kind === "open") reopened.engine.stop();

    // A key under another salt (the passphrase was changed, or another
    // device's create won with its own): Unlock is needed.
    const stranger = await openLedger(alex.connection, await keyFor(PASSPHRASE), null, { fetch: fake.fetch, store: new MemoryStore() });
    expect(stranger.kind).toBe("keyChanged");
  }, 60_000);

  it("a repo with no ledger reports it found nothing, so the gate offers Create", async () => {
    const alex = await connect("github_pat_alex", { owner: null, repo: "ledger-data" }, { fetch: fake.fetch });
    const key = await keyFor(PASSPHRASE);
    expect(await openLedger(alex.connection, key, null, { fetch: fake.fetch, store: new MemoryStore() })).toEqual({ kind: "found", found: { kind: "none" } });
    expect(puts()).toEqual([]);
  }, 30_000);
  it("an open that fails gives up the tab's lock, so the next one in the tab opens", async () => {
    const alex = await connect("github_pat_alex", { owner: null, repo: "ledger-data" }, { fetch: fake.fetch });
    const created = await createNew(alex, PASSPHRASE, choices);
    const deps = { fetch: fake.fetch, store: new MemoryStore(), locks: new FakeLocks().asLockManager() };
    // A token GitHub refuses: finding the ledger fails after the engine
    // has started and taken the lock.
    await expect(openLedger({ ...alex.connection, token: "github_pat_revoked" }, created.key, null, deps)).rejects.toThrow();
    const opened = await openLedger(alex.connection, created.key, null, deps);
    if (opened.kind !== "open") throw new Error(opened.kind);
    expect(opened.engine.getState()).toMatchObject({ needsInit: false, hasDocument: true });
    opened.engine.stop();
  }, 30_000);

  it("a settings change is one push of this device's log, and another device sees it (AC 10)", async () => {
    const alex = await connect("github_pat_alex", { owner: null, repo: "ledger-data" }, { fetch: fake.fetch });
    const created = await createNew(alex, PASSPHRASE, choices);
    if (created.result.kind !== "created") throw new Error(created.result.kind);
    const first = await openLedger(alex.connection, created.key, { epoch: created.result.epoch, sha: created.result.sha, state: created.result.state }, { fetch: fake.fetch, store: new MemoryStore() });
    if (first.kind !== "open") throw new Error(first.kind);
    const before = puts().length;
    await first.backend.updateSettings({ modules: ["expenses", "debts"], timeZone: "Europe/London" });
    await first.engine.syncNow();
    const sent = puts().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toMatch(/\/contents\/ledger\/e[0-9a-f-]+\.d[0-9a-f]+\.log\.enc$/);

    const sam = await connect("github_pat_sam", { owner: "alex", repo: "ledger-data" }, { fetch: fake.fetch });
    if (sam.found.kind !== "ledger") throw new Error(sam.found.kind);
    const opened = await unlock(sam.found, PASSPHRASE);
    if (!opened.ok) throw new Error(opened.problem);
    const second = await openLedger(sam.connection, opened.key, opened.start, { fetch: fake.fetch, store: new MemoryStore() });
    if (second.kind !== "open") throw new Error(second.kind);
    // It started from the genesis; its first cycle joins Alex's log.
    await second.engine.syncNow();
    expect(second.engine.current().settings).toEqual({ modules: ["expenses", "debts"], timeZone: "Europe/London" });
    first.engine.stop();
    second.engine.stop();
  }, 60_000);

  it("Forget this device leaves no ledger: database behind and sends nothing to GitHub (AC 11)", async () => {
    resetMemoryForTests();
    const alex = await connect("github_pat_alex", { owner: null, repo: "ledger-data" }, { fetch: fake.fetch });
    const created = await createNew(alex, PASSPHRASE, choices);
    if (created.result.kind !== "created") throw new Error(created.result.kind);
    await remember(alex.connection, created.key);
    // The device store as the app uses it: IndexedDB.
    const opened = await openLedger(alex.connection, created.key, { epoch: created.result.epoch, sha: created.result.sha, state: created.result.state }, { fetch: fake.fetch });
    if (opened.kind !== "open") throw new Error(opened.kind);
    await opened.engine.syncNow();
    const from = fake.requests.length;
    expect(await forget(opened.engine)).toEqual({ ok: true });
    const names = (await indexedDB.databases()).map((d) => d.name ?? "");
    expect(names.filter((n) => n.startsWith("ledger:"))).toEqual([]);
    expect(fake.requests.slice(from).filter((r) => r.method !== "GET")).toEqual([]);
    // A later start finds nothing saved (reading opens an empty store).
    expect(await loadSaved()).toEqual({ connection: null, key: null, remembered: true });
  }, 60_000);

  it("Forget refuses while a change isn't on GitHub, and says how many, unless forced", async () => {
    resetMemoryForTests();
    let offline = false;
    const flaky: typeof fetch = (input, init) => (offline ? Promise.reject(new TypeError("offline")) : fake.fetch(input, init));
    const alex = await connect("github_pat_alex", { owner: null, repo: "ledger-data" }, { fetch: flaky });
    const created = await createNew(alex, PASSPHRASE, choices);
    if (created.result.kind !== "created") throw new Error(created.result.kind);
    const opened = await openLedger(alex.connection, created.key, { epoch: created.result.epoch, sha: created.result.sha, state: created.result.state }, { fetch: flaky, store: new MemoryStore() });
    if (opened.kind !== "open") throw new Error(opened.kind);
    offline = true;
    await opened.backend.addEntry({ year: 2026, month: 5, amount: 40, remarks: "Groceries", category: "food", isCard: false });
    expect(await forget(opened.engine)).toEqual({ ok: false, pendingCount: 1, leftBehindOwnCount: 0 });
    expect(await forget(opened.engine, { force: true })).toEqual({ ok: true });
  }, 60_000);
});
