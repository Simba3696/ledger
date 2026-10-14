import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../base64";
import { DEFAULT_ITERATIONS, deriveKey, newSalt } from "../crypto";
import { DocumentBackend } from "../document/DocumentBackend";
import { createGitHubClient, type GitHubClient } from "../github/contents";
import { createLedger, findLedger, openGenesis, readBackup } from "./ledgerRepo";
import { MemoryStore } from "./cycleTestkit";
import type { DeviceKey } from "./records";
import { SyncEngine } from "./SyncEngine";
import { SyncedHost } from "./SyncedHost";
import { docText, emptyDocument, testEnv } from "./testkit";

// The real-GitHub smoke test (design section 16.5, stage 8d): the sync
// engine as the app runs it, over api.github.com instead of the fake. It
// runs only when given a repo and a token:
//
//   LEDGER_SMOKE_REPO=<owner>/<repo> LEDGER_SMOKE_TOKEN="$(cat <token file>)" \
//     npx vitest run src/backend/sync/realGitHub.smoke.test.ts
//
// The repo must be private, and either empty (what a household starts
// from: the run creates the ledger) or hold a ledger an earlier run left
// (the run restores an empty ledger over it, as a new epoch). A ledger
// under another passphrase fails the run at the join. Nothing is ever
// deleted. The token needs Contents read and write on
// that repo only (a fine-grained token, as the app asks for). The token is
// never printed. Fictional data only.

const REPO = testEnv("LEDGER_SMOKE_REPO");
const TOKEN = testEnv("LEDGER_SMOKE_TOKEN");
const PASSPHRASE = "correct horse battery staple, smoke test";

interface Meter {
  requests: number;
  conflicts: number;
  byKind: Record<string, number>;
}

function counting(meter: Meter): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    meter.requests++;
    const url = String(input instanceof Request ? input.url : input);
    const kind = `${init?.method ?? "GET"} ${/\/git\/ref\//.test(url) ? "ref" : /\/git\/trees\//.test(url) ? "tree" : /\/git\/blobs\//.test(url) ? "blob" : /\/contents\//.test(url) ? "contents" : "repo"} ${res.status}`;
    meter.byKind[kind] = (meter.byKind[kind] ?? 0) + 1;
    if (res.status === 409) meter.conflicts++;
    return res;
  };
}

describe.runIf(REPO !== undefined && TOKEN !== undefined)("the sync engine on the real GitHub (stage 8d)", () => {
  const [owner, repo] = (REPO ?? "/").split("/");
  const token = (TOKEN ?? "").trim();
  const meter: Meter = { requests: 0, conflicts: 0, byKind: {} };
  // The engine's PUT spacing and debounce read this clock; each cycle moves
  // it on, as the fake-GitHub tests do, so the run doesn't wait them out.
  let mono = 1_000_000;

  const client = (): GitHubClient => createGitHubClient({ owner, repo, token, fetch: counting(meter) });

  async function deviceKey(salt?: string, iter = DEFAULT_ITERATIONS): Promise<DeviceKey> {
    const s = salt ?? bytesToBase64(newSalt());
    return { key: await deriveKey(PASSPHRASE, s, iter), salt: s, iter };
  }

  interface Device {
    name: string;
    key: DeviceKey;
    engine: SyncEngine;
    backend: DocumentBackend;
  }

  /** A device as #8's join makes one: find the ledger, open its genesis
   * with the passphrase, and start from it. */
  async function join(name: string, branch: string): Promise<Device> {
    const remote = { client: client(), branch };
    const found = await findLedger(remote);
    if (found.kind !== "ledger") throw new Error(`no ledger to join: ${found.kind}`);
    const key = await deviceKey(found.salt, found.iter);
    const opened = await openGenesis(found, key);
    if (!opened.ok) throw new Error(`genesis: ${opened.problem}`);
    const engine = new SyncEngine({
      key,
      actor: name,
      store: new MemoryStore(),
      locks: null,
      log: () => {},
      remote,
      events: {},
      monotonic: () => mono,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      // Small, so a snapshot is written and read within the run.
      compaction: { logOps: 6 },
    });
    await engine.start();
    await engine.initialize(opened.epoch, opened.state, { sha: opened.sha, state: opened.state });
    await sync(engine);
    const backend = new DocumentBackend({ host: new SyncedHost(engine), now: () => Date.now(), actor: name, newId: () => crypto.randomUUID() });
    return { name, key, engine, backend };
  }

  async function sync(...engines: SyncEngine[]): Promise<void> {
    mono += 10_000;
    await Promise.all(engines.map((e) => e.sync()));
  }

  /** Cycles until every device has pushed everything and shows the same
   * document. */
  async function settle(...devices: Device[]): Promise<void> {
    for (let round = 0; round < 12; round++) {
      for (const d of devices) await sync(d.engine);
      const pending = devices.reduce((n, d) => n + d.engine.getState().pendingCount, 0);
      const texts = new Set(devices.map((d) => docText(d.engine.current())));
      if (pending === 0 && texts.size === 1) return;
    }
    throw new Error("the devices did not settle");
  }

  const entry = (remarks: string, amount: number) => ({ year: 2026, month: 5, amount, remarks, category: "food", isCard: false });
  const may = (d: Device) => (d.engine.current().expenses["2026-05"] ?? []).map((e) => `${e.remarks} ${e.amount}`).sort();

  it("creates, syncs concurrent writes, notices a conflict, restores and cold-starts a new device", async () => {
    const started = Date.now();
    const probe = client();
    const repoInfo = await probe.verifyRepo();
    const branch = repoInfo.defaultBranch;
    const remote = { client: probe, branch };
    const before = await findLedger(remote);
    if (before.kind === "none") {
      // 1. Create (#8): a genesis on GitHub, written with a fresh salt.
      const createKey = await deviceKey();
      const created = await createLedger(remote, createKey, { doc: emptyDocument(), by: "alex", at: Date.now() });
      expect(created.kind).toBe("created");
    } else {
      // A rerun: the repo holds an earlier run's ledger (only one this
      // test's passphrase opens is used). A device joins it, from every
      // snapshot and log the earlier run left, and restores an empty ledger
      // over it as a new epoch: nothing is deleted, and the run goes on
      // from an empty ledger.
      const setup = await join("alex", branch);
      const reset = await setup.engine.restore(emptyDocument());
      expect(reset.kind).toBe("restored");
      setup.engine.stop();
    }

    // 2. Two devices join it and write at the same time: their PUTs race on
    // the branch ref, and every 409 must be reconciled.
    const a = await join("alex", branch);
    const b = await join("sam", branch);
    for (let i = 1; i <= 4; i++) {
      await a.backend.addEntry(entry(`Groceries ${i}`, 10 * i));
      await b.backend.addEntry(entry(`Bus ${i}`, i));
      await sync(a.engine, b.engine);
    }
    await settle(a, b);
    expect(may(a)).toHaveLength(8);
    expect(may(b)).toEqual(may(a));

    // 3. A conflict: both edit the same expense before either syncs. One
    // value wins on both devices, and the other device is told.
    const target = (await a.backend.getMonth(2026, 5)).find((e) => e.remarks === "Groceries 1")!;
    const targetOnB = (await b.backend.getMonth(2026, 5)).find((e) => e.remarks === "Groceries 1")!;
    await a.backend.updateEntry(2026, 5, target.row, { amount: 11, remarks: "Groceries 1", category: "food", isCard: false });
    await b.backend.updateEntry(2026, 5, targetOnB.row, { amount: 12, remarks: "Groceries 1", category: "food", isCard: false });
    await settle(a, b);
    expect(may(b)).toEqual(may(a));
    const told = a.engine.getState().noticeCount + b.engine.getState().noticeCount;
    expect(told, "the device whose edit lost hears of it").toBeGreaterThan(0);

    // 4. A restore while Sam has an unsynced change: Alex restores an
    // export, Sam's device switches to the new epoch and is offered its
    // change back, re-applies it, and both converge.
    const backup = await a.engine.exportBackup();
    const opened = await readBackup(backup, a.key.key);
    if (!opened.ok) throw new Error(`backup: ${opened.problem}`);
    await b.backend.addEntry(entry("Taxi", 25));
    const restored = await a.engine.restore(opened.doc);
    expect(restored.kind).toBe("restored");
    // Alex's device clears its sync state and reloads (#9): a new device in
    // the new epoch.
    a.engine.stop();
    const a2 = await join("alex", branch);
    await sync(b.engine);
    const offered = b.engine.leftBehind().filter((g) => g.own);
    expect(offered, "Sam's unsynced change is offered back").toHaveLength(1);
    const reapplied = await b.engine.reapply(offered[0].id);
    expect(reapplied.applied.length).toBeGreaterThan(0);
    await settle(a2, b);
    expect(may(a2)).toContain("Taxi 25.00");
    expect(may(b)).toEqual(may(a2));

    // 5. Enough writes for a snapshot, then a third device cold-starts from
    // the snapshots and logs on GitHub and converges.
    for (let i = 1; i <= 7; i++) await a2.backend.addEntry(entry(`Lunch ${i}`, 5 + i));
    await settle(a2, b);
    const coldFrom = meter.requests;
    const coldStarted = Date.now();
    const c = await join("alex", branch);
    const coldRequests = meter.requests - coldFrom;
    const coldMs = Date.now() - coldStarted;
    await settle(a2, b, c);
    expect(may(c)).toEqual(may(a2));
    // 8 from step 2 (one edited in step 3), Sam's taxi, and 7 lunches.
    expect(may(c)).toHaveLength(16);

    for (const d of [a2, b, c]) d.engine.stop();
    console.log(
      "8d smoke",
      JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), requests: meter.requests, conflicts409: meter.conflicts, coldStart: { requests: coldRequests, ms: coldMs }, byKind: meter.byKind }),
    );
  }, 600_000);
});
