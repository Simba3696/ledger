import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeGitHub, type FakeGitHub } from "../backend/github/fakeGitHub";
import { MemoryStore } from "../backend/sync/cycleTestkit";
import { createLedger, findLedger } from "../backend/sync/ledgerRepo";
import { seal } from "../backend/sync/records";
import { planLedger, runOnDocument } from "../backend/sync/tenYearLedger";
import { readBackupFile } from "./backup";
import { connect, createNew, keyFor, openLedger, type Connected } from "./ledgerAccess";
import type { SyncEngine } from "../backend/sync/SyncEngine";

// #9 end to end against the fake GitHub, amended for the redesigned sync:
// a backup restores into an empty repo on a fresh device (through #8's
// create), and over the open ledger as a new epoch every device switches
// to. Fictional data only.

const PASSPHRASE = "correct horse battery staple";
const choices = { modules: ["expenses" as const], timeZone: "Asia/Kolkata" };
let fake: FakeGitHub;

beforeEach(() => {
  fake = createFakeGitHub({
    repos: [
      { owner: "alex", name: "ledger-data", private: true },
      { owner: "bo", name: "ledger-data", private: true },
    ],
    tokens: {
      github_pat_alex: { login: "alex", repos: ["alex/ledger-data"], permission: "write" },
      github_pat_sam: { login: "sam", repos: ["alex/ledger-data"], permission: "write" },
      github_pat_bo: { login: "bo", repos: ["bo/ledger-data"], permission: "write" },
    },
  });
});

const expense = (remarks: string) => ({ year: 2026, month: 5, amount: 40, remarks, category: "food", isCard: false });
const remarks = (engine: SyncEngine) => (engine.current().expenses["2026-05"] ?? []).map((e) => e.remarks).sort();
const file = (text: string) => new Blob([text]);
// Each device's PUT spacing (5 s) passes between any two reads.
let mono = 0;
const clock = () => (mono += 10_000);

/** Alex's ledger, open, with `items` added and synced. */
async function alexWith(...items: string[]) {
  const alex = await connect("github_pat_alex", { owner: null, repo: "ledger-data" }, { fetch: fake.fetch });
  const created = await createNew(alex, PASSPHRASE, choices);
  if (created.result.kind !== "created") throw new Error(created.result.kind);
  const opened = await openLedger(alex.connection, created.key, { epoch: created.result.epoch, sha: created.result.sha, state: created.result.state }, { fetch: fake.fetch, store: new MemoryStore(), monotonic: clock });
  if (opened.kind !== "open") throw new Error(opened.kind);
  for (const item of items) await opened.backend.addEntry(expense(item));
  await opened.engine.syncNow();
  return { connected: alex, key: created.key, ...opened };
}

/** Another device joining the ledger in `connected`'s repo with the household key. */
async function join(token: string, connected: Connected["connection"], key: Awaited<ReturnType<typeof keyFor>>) {
  const c = await connect(token, { owner: connected.owner, repo: connected.repo }, { fetch: fake.fetch });
  const opened = await openLedger(c.connection, key, null, { fetch: fake.fetch, store: new MemoryStore(), monotonic: clock });
  if (opened.kind !== "open") throw new Error(opened.kind);
  await opened.engine.syncNow();
  return opened;
}

describe("backup and restore (#9)", () => {
  it("AC 4: a backup restores on a fresh device into an empty repo, under the backup's passphrase", async () => {
    const a = await alexWith("Groceries", "Bus");
    const backup = await a.engine.exportBackup();
    // AC 2: an encrypted file, its header naming the cipher.
    expect(() => JSON.parse(backup)).toThrow();
    expect(JSON.parse(backup.split("\n")[0])).toMatchObject({ alg: "AES-GCM-256" });
    // AC 5: a wrong passphrase reads nothing further and sends nothing.
    const before = fake.requests.length;
    expect(await readBackupFile(file(backup), null, "not the passphrase")).toEqual({ ok: false, message: "Wrong passphrase" });
    expect(fake.requests.length).toBe(before);
    // Device B: nothing saved, its own empty repo.
    const bo = await connect("github_pat_bo", { owner: null, repo: "ledger-data" }, { fetch: fake.fetch });
    expect(bo.found).toEqual({ kind: "none" });
    const read = await readBackupFile(file(backup), null, PASSPHRASE);
    if (!read.ok) throw new Error(JSON.stringify(read));
    const created = await createLedger(bo.remote, read.key, { doc: read.doc, by: "bo", at: Date.now(), reason: "restore" });
    if (created.kind !== "created") throw new Error(created.kind);
    const put = fake.requests.find((r) => r.method === "PUT" && r.path.startsWith("/repos/bo/"))!;
    expect(JSON.parse(put.body!).message).toBe("Restore from backup");
    const opened = await openLedger(bo.connection, read.key, { epoch: created.epoch, sha: created.sha, state: created.state }, { fetch: fake.fetch, store: new MemoryStore(), monotonic: clock });
    if (opened.kind !== "open") throw new Error(opened.kind);
    expect(remarks(opened.engine)).toEqual(["Bus", "Groceries"]);
    // The ledger's passphrase is the backup's: its genesis is under its salt.
    const found = await findLedger(bo.remote);
    expect(found.kind === "ledger" && found.salt).toBe(read.key.salt);
    a.engine.stop();
    opened.engine.stop();
  }, 60_000);

  it("AC 8 and 14: a restore over the open ledger is the ledger every device switches to; a record deleted after the backup is back", async () => {
    const a = await alexWith("Groceries", "X");
    const backup = await a.engine.exportBackup();
    const sam = await join("github_pat_sam", a.connected.connection, a.key);
    // After the backup, Sam deletes X and syncs: Sam's state holds its deletion.
    const x = (await sam.backend.getMonth(2026, 5)).find((e) => e.remarks === "X")!;
    await sam.backend.deleteEntry(2026, 5, x.row);
    await sam.engine.syncNow();
    await a.engine.syncNow();
    expect(remarks(a.engine)).toEqual(["Groceries"]);

    const read = await readBackupFile(file(backup), a.key);
    if (!read.ok) throw new Error(JSON.stringify(read));
    expect(await a.engine.restore(read.doc)).toMatchObject({ kind: "restored" });
    // AC 12: the restore's genesis commit message.
    const genesisPut = fake.requests.filter((r) => r.method === "PUT" && r.path.endsWith(".genesis.enc")).at(-1)!;
    expect(JSON.parse(genesisPut.body!).message).toBe("Restore from backup");
    // Sam switches on its next cycle: X is back, and stays.
    await sam.engine.syncNow();
    await sam.engine.syncNow();
    expect(remarks(sam.engine)).toEqual(["Groceries", "X"]);
    a.engine.stop();
    sam.engine.stop();
  }, 60_000);

  it("AC 19: a backup made under another passphrase opens with it and restores under the household key", async () => {
    const a = await alexWith("Groceries");
    const other = await keyFor("an old household passphrase");
    const oldBackup = await seal(structuredClone(a.engine.current()), other);
    expect(await readBackupFile(file(oldBackup), a.key)).toEqual({ ok: false, needsPassphrase: true });
    const read = await readBackupFile(file(oldBackup), a.key, "an old household passphrase");
    if (!read.ok) throw new Error(JSON.stringify(read));
    await a.backend.addEntry(expense("Lunch"));
    await a.engine.syncNow();
    expect(await a.engine.restore(read.doc)).toMatchObject({ kind: "restored" });
    // A device with the household key joins the restored epoch.
    const sam = await join("github_pat_sam", a.connected.connection, a.key);
    expect(remarks(sam.engine)).toEqual(["Groceries"]);
    a.engine.stop();
    sam.engine.stop();
  }, 60_000);

  it("AC 20: offline, restore throws before anything lands, and nothing changes", async () => {
    let offline = false;
    const flaky: typeof fetch = (input, init) => (offline ? Promise.reject(new TypeError("offline")) : fake.fetch(input, init));
    const alex = await connect("github_pat_alex", { owner: null, repo: "ledger-data" }, { fetch: flaky });
    const created = await createNew(alex, PASSPHRASE, choices);
    if (created.result.kind !== "created") throw new Error(created.result.kind);
    const opened = await openLedger(alex.connection, created.key, { epoch: created.result.epoch, sha: created.result.sha, state: created.result.state }, { fetch: flaky, store: new MemoryStore(), monotonic: clock });
    if (opened.kind !== "open") throw new Error(opened.kind);
    const backup = await opened.engine.exportBackup();
    const read = await readBackupFile(file(backup), created.key);
    if (!read.ok) throw new Error(JSON.stringify(read));
    const puts = fake.requests.filter((r) => r.method === "PUT").length;
    offline = true;
    await expect(opened.engine.restore(read.doc)).rejects.toThrow();
    expect(fake.requests.filter((r) => r.method === "PUT").length).toBe(puts);
    opened.engine.stop();
  }, 60_000);

  it("AC 16: a 10-year ledger round-trips through export and restore", async () => {
    const big = runOnDocument(planLedger());
    const alex = await connect("github_pat_alex", { owner: null, repo: "ledger-data" }, { fetch: fake.fetch });
    const key = await keyFor(PASSPHRASE);
    const created = await createLedger(alex.remote, key, { doc: big, by: "alex", at: Date.now(), reason: "restore" });
    if (created.kind !== "created") throw new Error(created.kind);
    const opened = await openLedger(alex.connection, key, { epoch: created.epoch, sha: created.sha, state: created.state }, { fetch: fake.fetch, store: new MemoryStore(), monotonic: clock });
    if (opened.kind !== "open") throw new Error(opened.kind);
    let at = performance.now();
    const backup = await opened.engine.exportBackup();
    const exportMs = performance.now() - at;
    at = performance.now();
    const read = await readBackupFile(file(backup), key);
    const readMs = performance.now() - at;
    if (!read.ok) throw new Error(JSON.stringify(read));
    at = performance.now();
    expect(await opened.engine.restore(read.doc)).toMatchObject({ kind: "restored" });
    const restoreMs = performance.now() - at;
    expect(read.summary.expenses).toBe(Object.values(big.expenses).reduce((n, m) => n + m.length, 0));
    expect(JSON.stringify(read.doc)).toBe(JSON.stringify(opened.engine.current()));
    // The figures #9 asks to record (printed with --silent=false).
    console.info(`AC16: ${read.summary.expenses} expenses, backup ${backup.length} bytes, export ${Math.round(exportMs)} ms, read ${Math.round(readMs)} ms, restore ${Math.round(restoreMs)} ms (Node, fake GitHub)`);
    opened.engine.stop();
  }, 180_000);
});
