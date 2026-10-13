import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RowHandles } from "../document/handles";
import * as ops from "../document/operations";
import type { LedgerDocument } from "../document/types";
import { createGitHubClient } from "../github/contents";
import { EPOCH, FULL, device, expectConverged } from "./cycleTestkit";
import { FORMAT_VERSION, vectorOf } from "./codec";
import { diffDocuments } from "./diff";
import { Fence } from "./fence";
import { findLedger, openGenesis } from "./ledgerRepo";
import { materialize, readerOf, rematerialize } from "./materialize";
import { detectNotices } from "./notices";
import { seal, unseal } from "./records";
import { openRepoFile, plainSize, repoPath } from "./repoFiles";
import { applyOp, cloneState, emptyState, genesisState, joinInto, opState, type Op, type SyncState } from "./state";
import { PHONE_S, PLAN_DEVICES, engineWriter, planBurst, planLedger, replicaWriter, runOnDocument, runOnEngines, time, timeAsync, writePlanned, type Made, type Timing } from "./tenYearLedger";
import { Replica, deviceId, docText, testEnv } from "./testkit";

// AC7 (design section 15 item 14, section 16.5): a 10-year ledger of 12,000
// expenses and 300 deletes, with finances, card bills, month locks, EMIs,
// debts and subscriptions (tenYearLedger.ts plans it). Targets in Node:
//
//   - the commit diff under 30 ms;
//   - joining 100 remote ops and materialising the result under 100 ms;
//   - materialising the whole state under 150 ms.
//
// Two runs, so that a loaded machine can't fail the normal suite:
//
//   - The regression guard, in every run: the 10-year plan applied to one
//     document and restored as a genesis (what a restore from a 10-year
//     backup gives every device), 100 ops from a second replica, and each
//     timed figure's median held to GUARD_FACTOR times its target. It
//     catches a change that makes one of them several times slower (a
//     whole-state copy per join, a sort per record) in a few seconds.
//   - The performance run, only with LEDGER_PERF=1 (several minutes): the
//     plan carried out by three real engines on the fake GitHub, so the
//     logs, snapshots, compaction and repo history are the engine's own.
//     It holds each median to the target itself, and prints every figure
//     ADR-0008 records (the "Stage 8c" block): the timings' medians and
//     p95s, snapshot and log sizes, the bytes each push and each year add
//     to the repo, a cold start's requests, and the device store's size.
//
//     LEDGER_PERF=1 npx vitest run src/backend/sync/performance.test.ts
//
// Fictional data only.

const TARGET_MS = { diff: 30, join: 100, materialize: 150 };
const GUARD_FACTOR = 4;
/** The plan's last month, where the timed writes land. */
const LAST_MONTH = "2027-12";

function report(label: string, value: unknown): void {
  (globalThis as { process?: { stderr: { write(text: string): void } } }).process?.stderr.write(`AC7 ${label} ${JSON.stringify(value)}\n`);
}

interface CoreTimings {
  diffAdd: Timing;
  diffEdit: Timing;
  diffDelete: Timing;
  join: Timing;
  joinAndNotices: Timing;
  materialize: Timing;
}

/** Times the three AC7 figures on `state` (and `doc`, its document):
 *   - the diff of an add, an edit and a delete in the last month, each
 *     against a full clone of the document as DocumentBackend makes it;
 *   - joining `remote` (another device's ops) through the fence, as
 *     SyncEngine.join does, and rematerialising the units it changed, on a
 *     fresh copy of the state each time; also with notice detection;
 *   - materialising the whole state. */
function measureCore(state: SyncState, doc: LedgerDocument, remote: { device: string; ops: readonly Op[] }, runs: number): CoreTimings {
  const handles = new RowHandles();
  const ctx = (draft: LedgerDocument): ops.WriteContext => ({ doc: draft, handles, today: new Date(Date.UTC(2027, 11, 31)), now: Date.UTC(2027, 11, 31, 12), actor: "alex", newId: () => "6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a99" });
  const [year, month] = LAST_MONTH.split("-").map(Number);
  const target = doc.expenses[LAST_MONTH][3];
  const draft = (change: (c: ops.WriteContext) => void) => {
    const next = structuredClone(doc);
    change(ctx(next));
    return next;
  };
  const added = draft((c) => ops.appendEntry(c, year, month, { amount: 12.5, remarks: "Tea", category: "food", isCard: false }));
  const edited = draft((c) => ops.updateEntry(c, year, month, handles.rowFor(target.id), { amount: 99, remarks: target.remarks, category: target.category, isCard: target.cardNote !== null }));
  const deleted = draft((c) => ops.deleteEntry(c, year, month, handles.rowFor(target.id)));
  const writer = { L: state.maxL + 1, device: deviceId(0xab) };
  for (const next of [added, edited, deleted]) expect(diffDocuments(state, doc, next, writer)).not.toBeNull();

  const me = deviceId(0xab);
  const join = (live: SyncState, notices: boolean) => {
    const fence = new Fence();
    fence.attach(0, vectorOf(live.seen));
    const source = emptyState();
    for (const op of remote.ops) joinInto(source, opState(remote.device, op));
    if (notices) detectNotices(live, source, { ops: remote.ops.map((op) => [remote.device, op]), states: [] }, me);
    const changes = fence.join(live, source);
    return rematerialize(doc, readerOf(live), changes);
  };
  // The joined document is the one a full materialisation gives (AC3).
  const check = cloneState(state);
  expect(docText(join(check, true))).toBe(docText(materialize(check)));

  return {
    diffAdd: time(() => diffDocuments(state, doc, added, writer), { runs }),
    diffEdit: time(() => diffDocuments(state, doc, edited, writer), { runs }),
    diffDelete: time(() => diffDocuments(state, doc, deleted, writer), { runs }),
    join: time((live: SyncState) => join(live, false), { runs, prepare: () => cloneState(state) }),
    joinAndNotices: time((live: SyncState) => join(live, true), { runs, prepare: () => cloneState(state) }),
    materialize: time(() => materialize(state), { runs }),
  };
}

function expectWithin(core: CoreTimings, factor: number): void {
  for (const name of ["diffAdd", "diffEdit", "diffDelete"] as const) expect(core[name].median, name).toBeLessThan(TARGET_MS.diff * factor);
  expect(core.join.median, "join").toBeLessThan(TARGET_MS.join * factor);
  expect(core.materialize.median, "materialize").toBeLessThan(TARGET_MS.materialize * factor);
}

describe("AC7 regression guard: a ledger restored from a 10-year backup", () => {
  it(`times the diff, a 100-op join and a full materialisation within ${GUARD_FACTOR}x their targets`, async () => {
    const plan = planLedger();
    const doc = runOnDocument(plan);
    expect(Object.values(doc.expenses).flat()).toHaveLength(plan.counts.addExpense - plan.counts.deleteExpense);
    const state = genesisState(doc);
    const shown = materialize(state);

    // Another device's month offline: 100 writes through the diff.
    const replica = new Replica(deviceId(0xc), state, { actor: "sam" });
    replica.checks = false;
    const writer = replicaWriter(replica);
    const made = new Map<string, Made>();
    let id = 0;
    for (const event of planBurst({ month: LAST_MONTH, at: Date.UTC(2028, 0, 2) })) {
      expect(await writePlanned(writer, event, made, PHONE_S, event.at, () => `6f1e2d3c-4b5a-4987-8a6b-${(++id).toString(16).padStart(12, "0")}`)).toBe(true);
    }
    expect(replica.ops).toHaveLength(100);

    const core = measureCore(state, shown, { device: replica.device, ops: replica.ops }, 15);
    report("guard", core);
    expectWithin(core, GUARD_FACTOR);
  }, 120_000);
});

describe.runIf(testEnv("LEDGER_PERF") !== undefined)("AC7 performance run (LEDGER_PERF=1): the 10-year plan on three engines", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it("meets AC7's targets and records sizes, repo growth and a cold start", async () => {
    const plan = planLedger();
    report("plan", { events: plan.events.length, counts: plan.counts, days: plan.days });
    let lastReport = performance.now();
    const run = await runOnEngines(plan, {
      onProgress: (done, total) => {
        if (performance.now() - lastReport < 30_000) return;
        lastReport = performance.now();
        report("progress", { done, total });
      },
    });
    try {
      const { w, devices, meter } = run;
      report("generation", { elapsedMs: Math.round(run.elapsedMs), writeMs: Math.round(run.writeMs), syncMs: Math.round(run.syncMs), cycles: run.cycles, writes: run.writes, refused: run.refused, rerouted: run.rerouted });
      expect(run.refused).toBe(0);
      expect(w.fake.violations).toEqual([]);

      // The state every device holds: the join of the epoch's files.
      const files = (kind: "log" | "snap") => devices.map((d) => w.fake.file(FULL, repoPath({ kind, epoch: EPOCH, device: d.engine.deviceId! })));
      const genesisText = w.fake.file(FULL, repoPath({ kind: "genesis", epoch: EPOCH }))!.text;
      const genesisRead = await openRepoFile({ kind: "genesis", epoch: EPOCH }, genesisText, w.key);
      if (!genesisRead.ok || genesisRead.read.file.kind !== "genesis") throw new Error("the genesis can't be read");
      const genesis = genesisState(genesisRead.read.file.doc);
      const state = cloneState(genesis);
      const snaps: { device: string; sealed: number; plain: number; through: number }[] = [];
      for (const [i, file] of files("snap").entries()) {
        if (!file) continue;
        const read = await openRepoFile({ kind: "snap", epoch: EPOCH, device: devices[i].engine.deviceId! }, file.text, w.key, genesis);
        if (!read.ok || !read.read.state || read.read.file.kind !== "snap") throw new Error("a snapshot can't be read");
        joinInto(state, read.read.state);
        snaps.push({ device: PLAN_DEVICES[i].name, sealed: file.text.length, plain: plainSize(await unseal(file.text, w.key)), through: read.read.file.through });
      }
      const logs: { device: string; sealed: number; ops: number }[] = [];
      for (const [i, file] of files("log").entries()) {
        if (!file) continue;
        const read = await openRepoFile({ kind: "log", epoch: EPOCH, device: devices[i].engine.deviceId! }, file.text, w.key);
        if (!read.ok || read.read.file.kind !== "log") throw new Error("a log can't be read");
        for (const op of read.read.file.ops) applyOp(state, devices[i].engine.deviceId!, op);
        logs.push({ device: PLAN_DEVICES[i].name, sealed: file.text.length, ops: read.read.file.ops.length });
      }
      const doc = materialize(state);
      expect(docText(doc)).toBe(docText(devices[0].engine.current()));
      const counted = {
        expenses: Object.values(doc.expenses).flat().length,
        deleted: state.del.size,
        records: state.rec.size,
        financeMonths: Object.keys(doc.financeMonths).length,
        cardBillMonths: Object.keys(doc.cardBills).length,
        monthLocks: Object.keys(doc.monthLocks).length,
        emis: doc.emis.length,
        debts: doc.debts.length,
        subscriptions: doc.subscriptions.length,
      };
      report("ledger", counted);
      expect(counted.expenses).toBe(plan.counts.addExpense - plan.counts.deleteExpense);

      // A genesis of this document (a restore of a 10-year backup), for
      // scale against the snapshots.
      const restoreGenesis = { fv: FORMAT_VERSION, kind: "genesis", epoch: EPOCH, reason: "restore", by: "alex", at: 0, basedOn: null, doc };
      report("sizes", { snaps, logs, restoreGenesis: { sealed: (await seal(restoreGenesis, w.key)).length, plain: plainSize(restoreGenesis) } });

      // What each push and each year added to the repo: every PUT that
      // landed (a blob each), by kind, device and year.
      const landed = meter.records.filter((r) => r.method === "PUT" && r.status >= 200 && r.status < 300);
      const byYear: Record<string, { logPuts: number; logBytes: number; snapPuts: number; snapBytes: number }> = {};
      for (const r of landed) {
        const year = String(new Date(r.at).getUTCFullYear());
        const y = (byYear[year] ??= { logPuts: 0, logBytes: 0, snapPuts: 0, snapBytes: 0 });
        if (r.kind === "put:log") {
          y.logPuts++;
          y.logBytes += r.bytes;
        } else if (r.kind === "put:snap") {
          y.snapPuts++;
          y.snapBytes += r.bytes;
        }
      }
      const logPuts = landed.filter((r) => r.kind === "put:log").map((r) => r.bytes).sort((a, b) => a - b);
      const at = (q: number) => logPuts[Math.min(logPuts.length - 1, Math.floor(q * logPuts.length))];
      const blobBytes = landed.reduce((sum, r) => sum + r.bytes, 0);
      // git stores each blob zlib-deflated; the text is base64 of
      // ciphertext, so it deflates by about a quarter. Measured on the
      // final versions of every file.
      const deflated = async (text: string) => {
        const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate"));
        return (await new Response(stream).arrayBuffer()).byteLength;
      };
      let sample = 0;
      let sampleDeflated = 0;
      for (const file of [...files("log"), ...files("snap")]) {
        if (!file) continue;
        sample += file.text.length;
        sampleDeflated += await deflated(file.text);
      }
      report("growth", {
        landedPuts: landed.length,
        logPuts: logPuts.length,
        snapPuts: landed.filter((r) => r.kind === "put:snap").length,
        blobBytes,
        perLogPush: { mean: Math.round(logPuts.reduce((a, b) => a + b, 0) / logPuts.length), median: at(0.5), p95: at(0.95), max: logPuts.at(-1) },
        byYear,
        deflateRatio: Math.round((sampleDeflated / sample) * 1000) / 1000,
        byDevice: devices.map((d, i) => ({ device: PLAN_DEVICES[i].name, puts: landed.filter((r) => r.device === d.engine.deviceId).length, bytes: landed.filter((r) => r.device === d.engine.deviceId).reduce((s, r) => s + r.bytes, 0) })),
      });

      // The device store: what persist.ts would keep in IndexedDB.
      const stored = [];
      for (const [i, d] of devices.entries()) {
        const records = (await d.store.load())!;
        const meta = d.store.meta() as { ownMaxL: number };
        let chain = 0;
        let chainBytes = 0;
        for (let L = 1; L <= meta.ownMaxL; L++) {
          const text = await d.store.chainEntry(L);
          if (text === undefined) continue;
          chain++;
          chainBytes += text.length;
        }
        const tailBytes = records.tail.reduce((s, t) => s + t.length, 0);
        const ownLogBytes = records.ownLog.reduce((s, [, t]) => s + t.length, 0);
        const noticeBytes = records.notices.reduce((s, [, t]) => s + t.length, 0);
        const metaBytes = JSON.stringify(records.meta).length;
        stored.push({
          device: PLAN_DEVICES[i].name,
          base: records.base?.length ?? 0,
          tail: [records.tail.length, tailBytes],
          ownLog: [records.ownLog.length, ownLogBytes],
          chain: [chain, chainBytes],
          notices: [records.notices.length, noticeBytes],
          meta: metaBytes,
          total: (records.base?.length ?? 0) + tailBytes + ownLogBytes + chainBytes + noticeBytes + metaBytes,
        });
      }
      report("deviceStore", stored);

      // A cold start: a fourth device (Sam's laptop) joins as #8 does
      // (check the repo, find the ledger, open its genesis), then its
      // first cycle joins every file of the epoch.
      meter.peak = 0;
      const from = meter.records.length;
      const t0 = performance.now();
      const tagged = meter.wrap(() => "cold")(w.fake.fetchAs("dnone"));
      const client = createGitHubClient({ owner: "alex", repo: "ledger-data", token: "github_pat_sam", fetch: tagged });
      await client.verifyRepo();
      const found = await findLedger({ client, branch: "main" });
      if (found.kind !== "ledger") throw new Error(`no ledger found: ${found.kind}`);
      const opened = await openGenesis(found, w.key);
      if (!opened.ok) throw new Error(`the genesis can't be opened: ${opened.problem}`);
      const join8 = meter.countsSince(from);
      const coldFrom = meter.records.length;
      const cold = await device(w, { login: "sam", init: { epoch: opened.epoch, state: opened.state, sha: opened.sha }, wrapFetch: meter.wrap(() => "cold") });
      const coldMs = performance.now() - t0;
      expectConverged(cold, ...devices);
      const engineCounts = meter.countsSince(coldFrom);
      const coldRequests = meter.records.slice(from);
      report("coldStart", {
        wallMs: Math.round(coldMs),
        joinFlow: join8,
        firstCycle: engineCounts,
        requests: coldRequests.length,
        gets: coldRequests.filter((r) => r.method === "GET").length,
        peakConcurrency: meter.peak,
      });
      cold.engine.stop();

      // 100 remote ops: Sam's phone spends December offline, then syncs.
      const phone = devices[PHONE_S];
      await run.write(PHONE_S, planBurst({ month: LAST_MONTH, at: Date.UTC(2028, 0, 2) }));
      const burst = phone.engine.pushableOps().slice(-100);
      expect(burst).toHaveLength(100);
      const core = measureCore(state, doc, { device: phone.engine.deviceId!, ops: burst }, 60);
      report("core", core);

      // The engine's own cycle on Alex's phone bringing them in (one
      // sample: it changes the device), after Sam's phone pushes.
      w.clock.mono += 60_000;
      await phone.engine.sync();
      const alex = devices[0];
      w.clock.mono += 60_000;
      const cycleFrom = meter.records.length;
      const tc = performance.now();
      await alex.engine.sync();
      const cycleMs = performance.now() - tc;
      expect(docText(alex.engine.current())).toBe(docText(phone.engine.current()));
      report("engineCycle100", { ms: Math.round(cycleMs * 100) / 100, requests: meter.countsSince(cycleFrom) });

      // A whole write on the 10-year ledger: through DocumentBackend over
      // SyncedHost (its full structuredClone included), and through the
      // engine alone (diff, fence, seal, device store, rematerialise).
      const writeBackend = await timeAsync(() => alex.backend.addEntry({ year: 2027, month: 12, amount: 25, remarks: "Coffee", category: "food", isCard: false }), { runs: 20 });
      const engineWrites = engineWriter(alex.engine, "alex");
      let n = 0;
      const writeEngine = await timeAsync(
        () =>
          writePlanned(engineWrites, { at: 0, device: 0, kind: "addExpense", key: `timed${n++}`, month: LAST_MONTH, data: { amount: 30, remarks: "Bus", category: "transportation", isCard: false } }, new Map(), 0, w.clock.wall, () => `6f1e2d3c-4b5a-4987-8a6b-${(++n).toString(16).padStart(12, "0")}`),
        { runs: 20 },
      );
      report("writes", { documentBackend: writeBackend, engineOnly: writeEngine });

      // AC7's targets, on medians.
      expectWithin(core, 1);
    } finally {
      run.restore();
    }
  }, 60 * 60 * 1000);
});
