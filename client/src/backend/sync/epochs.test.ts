import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerDocument } from "../document/types";
import { EPOCH, FULL, cycle, device, entry, expectConverged, logFile, nextTask, plant, puts, quiesce, remarks, row, world, type Device, type DeviceOptions, type World } from "./cycleTestkit";
import { findLedger, openGenesis, readBackup } from "./ledgerRepo";
import { testKey } from "./localTestkit";
import { seal, unseal, type DeviceKey } from "./records";
import { repoPath } from "./repoFiles";
import type { Op } from "./state";
import { ALREADY_RESOLVED, NEEDS_NEW_EPOCH, SYNC_TIMING, type SyncEngine } from "./SyncEngine";
import { MAX_L } from "./tags";
import { Replica, Rng, deviceId, docText, forEachSeed, testEnv } from "./testkit";

// Restore epochs against the fake GitHub (design sections 9 and 15 AC13,
// 16.2 "Restore"): a restore by one device; every other device switching,
// with what the restore left out offered and re-applied only on Re-apply
// (owner decision D18: own changes prominently, other devices' in a
// collapsed list); a log PUT that lands in the old epoch after the genesis;
// racing restores; re-apply and discard markers propagating; a double
// re-apply; AC14; and the new epoch Lamport exhaustion starts. Fictional
// data only.
//
// Old-bug catalogue (section 13): B1 and B20 are named on their tests. B15
// (a restore needed a `restoredAt` marker) has no test of its own: epochs
// replace the marker, and every restore here runs without one.

const running: SyncEngine[] = [];
let w: World;
const X = deviceId(0xc);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  w = await world();
});

afterEach(() => {
  for (const engine of running.splice(0)) engine.stop();
  vi.useRealTimers();
});

async function open(options: DeviceOptions = {}): Promise<Device> {
  const d = await device(w, options);
  running.push(d.engine);
  return d;
}

/** After a restore (section 9.2 step 7): the device's sync state is
 * cleared and the page reloads, so it joins the winning epoch afresh, as
 * #8 join does (findLedger, then openGenesis with the household key). */
async function reload(d: Device): Promise<Device> {
  d.engine.stop();
  const found = await findLedger({ client: d.client, branch: "main" });
  if (found.kind !== "ledger") throw new Error(`no ledger: ${found.kind}`);
  const opened = await openGenesis(found, w.key);
  if (!opened.ok) throw new Error(opened.problem);
  return open({ login: d.login, init: { epoch: opened.epoch, state: opened.state } });
}

/** A restore genesis another device wrote, planted as it would land. */
async function plantRestore(epoch: string, doc: LedgerDocument, seen: Record<string, number> = {}): Promise<void> {
  await plant(w, { kind: "genesis", epoch }, { fv: 1, kind: "genesis", epoch, reason: "restore", by: "sam", at: 7, basedOn: { epoch: EPOCH, seen }, doc });
}

/** The ops in a device's log file, as the repo holds it. */
async function logOps(epoch: string, device: string): Promise<Op[]> {
  const file = w.fake.file(FULL, repoPath({ kind: "log", epoch, device }));
  return file ? ((await unseal(file.text, w.key)) as { ops: Op[] }).ops : [];
}

const opRemarks = (ops: Op[]) => ops.flatMap((op) => op.set.filter(([key]) => key.endsWith("/remarks")).map(([, value]) => value));
const status = (d: Device) => d.engine.getState().status;

describe("restore (section 9.2) and switching (section 9.3)", () => {
  it("every device ends on the backup, in the new epoch under a new id, and never writes to the old epoch again (AC13)", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await b.backend.addEntry(entry("Bus"));
    await quiesce(w, a, b);
    // Export, then restore what it opens to (section 9.5: they round-trip).
    const opened = await readBackup(await a.engine.exportBackup(), w.key.key);
    if (!opened.ok) throw new Error(opened.problem);
    // A change the restorer sees before restoring is replaced on purpose.
    await b.backend.addEntry(entry("Taxi"));
    await cycle(w, b);
    const oldB = b.engine.deviceId!;
    const result = await a.engine.restore(opened.doc);
    expect(result).toMatchObject({ kind: "restored", epoch: expect.stringMatching(/^e000002-[0-9a-f]{8}$/) });
    const epoch = (result as { epoch: string }).epoch;
    const genesisPut = puts(w).length;
    expect(w.fake.commits.at(-1)).toMatchObject({ path: `ledger/${epoch}.genesis.enc`, message: "Restore from backup" });

    const a2 = await reload(a);
    await quiesce(w, a2, b);
    expect(b.engine.epochKey).toBe(epoch);
    expect(b.engine.deviceId).not.toBe(oldB);
    expect(remarks(b).sort()).toEqual(["Bus", "Groceries"]);
    expect(docText(b.engine.current())).toBe(docText(opened.doc));
    expectConverged(a2, b);
    for (const d of [a2, b]) expect(d.engine.getState()).toMatchObject({ status: "idle", leftBehindCount: 0, pendingCount: 0 });
    // Writes go on in the new epoch, and only there.
    await b.backend.addEntry(entry("Rent"));
    await quiesce(w, a2, b);
    expect(remarks(a2)).toContain("Rent");
    for (const put of puts(w).slice(genesisPut)) expect(put.path).toContain(`/contents/ledger/${epoch}.`);
    // b's first log in the new epoch names the id it had before.
    const log = (await unseal(w.fake.file(FULL, repoPath({ kind: "log", epoch, device: b.engine.deviceId! }))!.text, w.key)) as { prev?: unknown };
    expect(log.prev).toEqual({ epoch: EPOCH, device: oldB });
    expect(w.fake.violations).toEqual([]);
  });

  it("a device's unpushed changes are its own left-behind group, shown prominently, and re-applied only on Re-apply (AC13, D18)", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a, b);
    const backup = structuredClone(a.engine.current());
    await b.backend.addEntry(entry("Taxi"));
    const oldB = b.engine.deviceId!;
    const result = await a.engine.restore(backup);
    expect(result.kind).toBe("restored");
    await cycle(w, b);
    expect(remarks(b)).toEqual(["Groceries"]);
    expect(b.engine.getState()).toMatchObject({ leftBehindCount: 1, leftBehindOwnCount: 1, pendingCount: 0 });
    const [group] = b.engine.leftBehind();
    expect(group).toMatchObject({ own: true, who: "sam", resolvedElsewhere: false, into: { by: "alex" }, items: [{ kind: "add", coll: "e", record: { remarks: "Taxi" } }] });
    // Unpushed ops are never pushed into the old epoch.
    expect(opRemarks(await logOps(EPOCH, oldB))).toEqual([]);

    // Kept over a reload, and nothing is re-applied until asked.
    b.engine.stop();
    const b2 = await open({ login: "sam", store: b.store });
    const a2 = await reload(a);
    await quiesce(w, a2, b2);
    expect(remarks(a2)).toEqual(["Groceries"]);
    expect(b2.engine.leftBehind().map((g) => g.id)).toEqual([group.id]);

    expect(b2.engine.previewReapply(group.id)).toMatchObject({ skipped: [] });
    const done = await b2.engine.reapply(group.id);
    expect(done).toMatchObject({ applied: [{ kind: "add" }], skipped: [] });
    expect(b2.engine.leftBehind()).toEqual([]);
    expect(b2.engine.getState()).toMatchObject({ leftBehindCount: 0, leftBehindOwnCount: 0 });
    await quiesce(w, a2, b2);
    expect(remarks(a2).sort()).toEqual(["Groceries", "Taxi"]);
    expectConverged(a2, b2);
    // The epoch switched from stays in `old` with no group left, until the
    // device switches again: a restore that raced this one may be based on it.
    expect((await b2.store.load())?.old).toBeDefined();
    await expect(b2.engine.reapply(group.id)).rejects.toMatchObject({ status: 404, message: ALREADY_RESOLVED });
    await expect(b2.engine.discard(group.id)).rejects.toMatchObject({ status: 404 });
  });

  it("a log PUT that lands in the old epoch after the genesis is left behind on its device, never lost (AC13)", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    const c = await open({ login: "alex" });
    await quiesce(w, a, b, c);
    const backup = structuredClone(a.engine.current());
    await b.backend.addEntry(entry("Taxi"));
    const oldB = b.engine.deviceId!;
    w.fake.landLater(1000, { method: "PUT" });
    await cycle(w, b);
    expect(b.engine.getState().pendingCount).toBe(1);
    expect((await a.engine.restore(backup)).kind).toBe("restored");
    // b's log lands now, in the old epoch, after the restore's genesis.
    w.fake.landPending();
    expect(opRemarks(await logOps(EPOCH, oldB))).toEqual(["Taxi"]);
    await cycle(w, c, b);
    expect(c.engine.leftBehind()).toEqual([]);
    expect(b.engine.leftBehind()).toMatchObject([{ own: true, items: [{ kind: "add", record: { remarks: "Taxi" } }] }]);
    expect(remarks(b)).toEqual([]);
  });

  it("refuses while own changes aren't in the repo, says how many, and discards them only on Restore anyway", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    const backup = structuredClone(a.engine.current());
    await a.backend.addEntry(entry("Bus"));
    w.fake.failNext({ method: "PUT", network: true });
    w.fake.failNext({ method: "PUT", network: true });
    const before = puts(w).length;
    expect(await a.engine.restore(backup)).toEqual({ kind: "unsynced", pendingCount: 2, leftBehindOwnCount: 0 });
    expect(await findLedger({ client: a.client, branch: "main" })).toMatchObject({ kind: "ledger", epoch: EPOCH });
    expect(puts(w).length).toBe(before + 1);
    const result = await a.engine.restore(backup, { discardUnsynced: true });
    expect(result.kind).toBe("restored");
    const a2 = await reload(a);
    expect(remarks(a2)).toEqual(["Groceries"]);
  });

  it("refuses a backup that isn't a writable document, writing nothing", async () => {
    const a = await open();
    const before = puts(w).length;
    const bad = { ...structuredClone(a.engine.current()), version: 2 } as unknown as LedgerDocument;
    expect(await a.engine.restore(bad)).toEqual({ kind: "invalid" });
    expect(puts(w).length).toBe(before);
  });

  it("refuses while this device's own changes a restore left behind are unresolved, and drops them only on Restore anyway (D18)", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a, b);
    const backup = structuredClone(a.engine.current());
    await b.backend.addEntry(entry("Taxi"));
    expect((await a.engine.restore(backup)).kind).toBe("restored");
    await cycle(w, b);
    expect(b.engine.getState()).toMatchObject({ pendingCount: 0, leftBehindOwnCount: 1 });
    // Taxi is only in b's own group: the reload after b's restore would lose it.
    const before = puts(w).length;
    expect(await b.engine.restore(structuredClone(b.engine.current()))).toEqual({ kind: "unsynced", pendingCount: 0, leftBehindOwnCount: 1 });
    expect(puts(w).length).toBe(before);
    expect(b.engine.leftBehind()).toMatchObject([{ own: true, items: [{ kind: "add", record: { remarks: "Taxi" } }] }]);
    expect((await b.engine.restore(structuredClone(b.engine.current()), { discardUnsynced: true })).kind).toBe("restored");
  });

  it("a restore whose genesis landed is reported as restored when the re-list after it fails, never thrown", async () => {
    let genesisPut = false;
    let failed = false;
    const a = await open({
      login: "alex",
      wrapFetch: (inner) => async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        const method = init?.method ?? "GET";
        if (genesisPut && !failed && method === "GET" && /git\/ref/.test(url)) {
          failed = true;
          throw new TypeError("Failed to fetch");
        }
        const res = await inner(input, init);
        if (method === "PUT" && url.includes(".genesis.enc") && res.ok) genesisPut = true;
        return res;
      },
    });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    const result = await a.engine.restore(structuredClone(a.engine.current())).catch((err: unknown) => err);
    expect(failed).toBe(true);
    expect(result).toEqual({ kind: "restored", epoch: expect.stringMatching(/^e000002-/), winnerUnknown: true });
    expect(await findLedger({ client: a.client, branch: "main" })).toMatchObject({ kind: "ledger", epoch: (result as { epoch: string }).epoch });
  });

  it("a restore whose genesis PUTs get no answer says unknown, refuses writes until a listing settles it, and the genesis that lands later wins", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a, b);
    const backup = structuredClone(a.engine.current());
    backup.expenses = {};
    w.fake.landLater(50, { method: "PUT", path: /genesis/ });
    w.fake.landLater(50, { method: "PUT", path: /genesis/ });
    const result = await a.engine.restore(backup);
    expect(result).toEqual({ kind: "unknown", epoch: expect.stringMatching(/^e000002-[0-9a-f]{8}$/) });
    const epoch = (result as { epoch: string }).epoch;
    await expect(a.backend.addEntry(entry("Bus"))).rejects.toMatchObject({ status: 503 });
    w.fake.landPending();
    await quiesce(w, a, b);
    for (const d of [a, b]) expect(d.engine.epochKey).toBe(epoch);
    expect(remarks(b)).toEqual([]);
    // It landed: the device reloads, as after "restored".
    await expect(a.backend.addEntry(entry("Bus"))).rejects.toMatchObject({ status: 503 });
  });

  it("a restore whose genesis PUTs get no answer and never land: the next sync's listing settles it, and writes go on", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    w.fake.failNext({ method: "PUT", path: /genesis/, network: true });
    w.fake.failNext({ method: "PUT", path: /genesis/, network: true });
    expect(await a.engine.restore(structuredClone(a.engine.current()))).toMatchObject({ kind: "unknown" });
    await expect(a.backend.addEntry(entry("Bus"))).rejects.toMatchObject({ status: 503 });
    await cycle(w, a);
    await a.backend.addEntry(entry("Bus"));
    await quiesce(w, a);
    expect(a.engine.epochKey).toBe(EPOCH);
    expect(remarks(a)).toEqual(["Groceries", "Bus"]);
    expect(a.engine.getState().pendingCount).toBe(0);
  });

  it("a write queued behind a restore is refused, never saved into the state the reload clears (section 9.2 step 7)", async () => {
    let a!: Device;
    let late: Promise<unknown> | null = null;
    const wrap = (inner: typeof fetch): typeof fetch => (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (init?.method === "PUT" && url.includes(".genesis.enc") && late === null) late = a.backend.addEntry(entry("Late")).then(() => "saved", (err: unknown) => err);
      return inner(input, init);
    };
    a = await open({ login: "alex", wrapFetch: wrap });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    expect((await a.engine.restore(structuredClone(a.engine.current()))).kind).toBe("restored");
    expect(await late).toMatchObject({ status: 503 });
    expect(remarks(a)).toEqual(["Groceries"]);
    await expect(a.backend.addEntry(entry("Later"))).rejects.toMatchObject({ status: 503 });
    const a2 = await reload(a);
    await quiesce(w, a2);
    expect(remarks(a2)).toEqual(["Groceries"]);
    expect(a2.engine.getState().pendingCount).toBe(0);
  });

  it("a restore never writes an epoch based on one older than the listed winner, so nothing the winner holds is lost (AC6)", async () => {
    for (const resolveFirst of [false, true]) {
      for (const engine of running.splice(0)) engine.stop();
      w = await world();
      const a = await open({ login: "alex" });
      const c = await open({ login: "sam" });
      let sOffline = true;
      const s = await open({ login: "sam", wrapFetch: (inner) => (input, init) => (sOffline ? Promise.reject(new TypeError("Failed to fetch")) : inner(input, init)) });
      await c.backend.addEntry(entry("Bus"));
      await quiesce(w, a, c);
      await c.backend.addEntry(entry("Pens"));
      expect((await a.engine.restore(structuredClone(a.engine.current()))).kind).toBe("restored");
      await cycle(w, c);
      expect(remarks(c)).toEqual(["Bus"]);
      const [own] = c.engine.leftBehind();
      if (resolveFirst) await c.engine.reapply(own.id);
      await cycle(w, c);
      // s comes back, but its sync before the restore can't switch (a full
      // device): the listing it numbers from names a winner newer than its epoch.
      sOffline = false;
      s.store.failNext = 1;
      expect(await s.engine.restore(structuredClone(s.engine.current()))).toMatchObject({ kind: "failed" });
      await cycle(w, c);
      expect(remarks(c), `resolveFirst ${resolveFirst}`).toContain("Bus");
      // s switches on its next sync, and a restore from there is based on the winner.
      await cycle(w, s);
      expect(remarks(s)).toContain("Bus");
      const again = await s.engine.restore(structuredClone(s.engine.current()));
      expect(again.kind).toBe("restored");
      await cycle(w, c);
      expect(c.engine.epochKey).toBe((again as { epoch: string }).epoch);
      expect(remarks(c), `resolveFirst ${resolveFirst}`).toContain("Bus");
    }
  });

  it("AC14: a device holding an old tombstone keeps the restored record", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a, b);
    const backup = structuredClone(a.engine.current());
    await b.backend.deleteEntry(2026, 5, await row(b, "Groceries"));
    await quiesce(w, a, b);
    expect(remarks(a)).toEqual([]);
    expect((await a.engine.restore(backup)).kind).toBe("restored");
    const a2 = await reload(a);
    await quiesce(w, a2, b);
    // The restorer had seen the delete: the record is back, and nothing is offered.
    expect(remarks(b)).toEqual(["Groceries"]);
    expect(b.engine.leftBehind()).toEqual([]);
    expectConverged(a2, b);
  });

  it("B1: a delete the restorer hadn't seen is offered to its device, and the record stays until it is re-applied", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a, b);
    const backup = structuredClone(a.engine.current());
    await b.backend.deleteEntry(2026, 5, await row(b, "Groceries"));
    expect((await a.engine.restore(backup)).kind).toBe("restored");
    await cycle(w, b);
    expect(remarks(b)).toEqual(["Groceries"]);
    const [group] = b.engine.leftBehind();
    expect(group.items).toMatchObject([{ kind: "delete", record: { remarks: "Groceries" } }]);
    await b.engine.reapply(group.id);
    expect(remarks(b)).toEqual([]);
  });
});

describe("re-apply and discard (section 9.4)", () => {
  /** b writes Taxi and pushes it; c joins it; a restores without having
   * seen it (its sync fails), so Taxi is b's own group and c's "other". */
  async function leftOnTwo() {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    const c = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a, b, c);
    const backup = structuredClone(a.engine.current());
    await b.backend.addEntry(entry("Taxi"));
    await cycle(w, b, c);
    expect(remarks(c).sort()).toEqual(["Groceries", "Taxi"]);
    w.fake.failNext({ method: "GET", path: /git\/ref/, network: true });
    expect((await a.engine.restore(backup)).kind).toBe("restored");
    const a2 = await reload(a);
    await cycle(w, b, c);
    return { a2, b, c };
  }

  it("another device's leftovers are collapsed (not own); a discard there hides them everywhere but on the device they came from (D18)", async () => {
    const { a2, b, c } = await leftOnTwo();
    expect(b.engine.getState()).toMatchObject({ leftBehindCount: 1, leftBehindOwnCount: 1 });
    expect(c.engine.getState()).toMatchObject({ leftBehindCount: 1, leftBehindOwnCount: 0 });
    const [theirs] = c.engine.leftBehind();
    expect(theirs).toMatchObject({ own: false, who: "sam", items: [{ kind: "add", record: { remarks: "Taxi" } }] });
    await c.engine.discard(theirs.id);
    expect(c.engine.leftBehind()).toEqual([]);
    await quiesce(w, a2, b, c);
    expect(remarks(c)).toEqual(["Groceries"]);
    // b still sees its own changes: they are not in effect anywhere.
    expect(b.engine.leftBehind()).toMatchObject([{ id: theirs.id, own: true, resolvedElsewhere: true }]);
    await b.engine.reapply(theirs.id);
    await quiesce(w, a2, b, c);
    expect(remarks(c).sort()).toEqual(["Groceries", "Taxi"]);
    expect(b.engine.leftBehind()).toEqual([]);
    expectConverged(a2, b, c);
  });

  it("a re-apply on another device puts the changes in effect, which hides them on their own device too", async () => {
    const { a2, b, c } = await leftOnTwo();
    const [theirs] = c.engine.leftBehind();
    await c.engine.reapply(theirs.id);
    await quiesce(w, a2, b, c);
    expect(remarks(b).sort()).toEqual(["Groceries", "Taxi"]);
    expect(b.engine.leftBehind()).toEqual([]);
    expect(b.engine.getState()).toMatchObject({ leftBehindCount: 0 });
    expectConverged(a2, b, c);
  });

  it("two devices re-applying the same group at once is harmless: one record, everywhere", async () => {
    const { a2, b, c } = await leftOnTwo();
    const [mine] = b.engine.leftBehind();
    await Promise.all([b.engine.reapply(mine.id), c.engine.reapply(mine.id)]);
    await quiesce(w, a2, b, c);
    expect(remarks(a2).sort()).toEqual(["Groceries", "Taxi"]);
    expectConverged(a2, b, c);
    for (const d of [b, c]) expect(d.engine.leftBehind()).toEqual([]);
  });
});

describe("racing restores (sections 9.2 step 6 and 9.4)", () => {
  it("B20: the losing restorer is told: its restore landed, but a greater epoch was listed", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    const backup = structuredClone(a.engine.current());
    // Sam's restore landed just before; a's reads lag one commit behind.
    await plantRestore("e000002-ffffffff", backup);
    w.fake.staleReads(1);
    const result = await a.engine.restore(backup);
    w.fake.staleReads(0);
    expect(result).toMatchObject({ kind: "replaced", winner: "e000002-ffffffff" });
    const a2 = await reload(a);
    expect(a2.engine.epochKey).toBe("e000002-ffffffff");
  });

  it("B20: a device that switched to the losing epoch switches again: its writes there, and the old epoch's under the winner's cut, are offered", async () => {
    const a = await open({ login: "alex" });
    const c = await open({ login: "alex" });
    await c.backend.addEntry(entry("Bus"));
    await quiesce(w, a, c);
    const backup = structuredClone(a.engine.current());
    backup.expenses = {};
    expect((await a.engine.restore(structuredClone(a.engine.current()))).kind).toBe("restored");
    await cycle(w, c);
    // On the losing epoch: Bus came through the restore, and nothing is left behind.
    expect(remarks(c)).toEqual(["Bus"]);
    expect(c.engine.leftBehind()).toEqual([]);
    await c.backend.addEntry(entry("Pens"));
    await cycle(w, c);
    // Sam's restore, based on the first epoch with nothing seen, wins.
    await plantRestore("e000002-ffffffff", backup);
    await cycle(w, c);
    expect(c.engine.epochKey).toBe("e000002-ffffffff");
    expect(remarks(c)).toEqual([]);
    const groups = c.engine.leftBehind();
    expect(groups.map((g) => [g.epoch, g.own, g.items.map((item) => item.kind === "add" && item.record.remarks)])).toEqual([
      [EPOCH, true, ["Bus"]],
      [expect.stringMatching(/^e000002-/), true, ["Pens"]],
    ]);
    for (const group of groups) await c.engine.reapply(group.id);
    expect(remarks(c).sort()).toEqual(["Bus", "Pens"]);
    const a2 = await reload(a);
    await quiesce(w, a2, c);
    expectConverged(a2, c);
  });
});

describe("racing restores and what a device keeps for them (stage 6 review)", () => {
  const offered = (d: Device, own?: boolean) =>
    d.engine
      .leftBehind()
      .filter((g) => own === undefined || g.own === own)
      .flatMap((g) => g.items.map((i) => (i.kind === "add" ? `add:${String(i.record.remarks)}` : i.kind)));

  it("re-projecting the old epoch for a racing restore keeps this device's own group that another device resolved there (D18)", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    const c = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a, b, c);
    const backup = structuredClone(a.engine.current());
    await b.backend.addEntry(entry("Bus"));
    await cycle(w, b, c);
    await b.backend.addEntry(entry("Taxi")); // unpushed: only b holds it
    w.fake.failNext({ method: "GET", path: /git\/ref/, network: true });
    expect((await a.engine.restore(backup)).kind).toBe("restored");
    await cycle(w, c, b);
    expect(offered(b, true).sort()).toEqual(["add:Bus", "add:Taxi"]);
    await c.engine.discard(c.engine.leftBehind()[0].id);
    await cycle(w, c, b);
    expect(b.engine.leftBehind()).toMatchObject([{ own: true, resolvedElsewhere: true }]);
    // Sam's restore, based on the first epoch with nothing seen, wins.
    await plantRestore("e000002-ffffffff", backup);
    await cycle(w, b);
    expect(b.engine.epochKey).toBe("e000002-ffffffff");
    expect(offered(b, true)).toContain("add:Taxi");
  });

  it("the epoch switched from stays in `old` once every group is resolved, so a racing restore listed later still offers what it lacks", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a, b);
    const samBackup = structuredClone(a.engine.current());
    await b.backend.addEntry(entry("Bus"));
    await cycle(w, b, a);
    await b.backend.addEntry(entry("Taxi")); // unpushed
    expect((await a.engine.restore(structuredClone(a.engine.current()))).kind).toBe("restored");
    await cycle(w, b);
    expect(offered(b)).toEqual(["add:Taxi"]);
    await b.engine.reapply(b.engine.leftBehind()[0].id);
    expect(b.engine.leftBehind()).toEqual([]);
    expect((await b.store.load())?.old).toBeDefined();
    // Sam's restore, based on the first epoch with nothing seen, wins. Bus
    // was in the losing epoch's genesis and re-applied Taxi in effect there,
    // but neither is in the winner.
    await plantRestore("e000002-ffffffff", samBackup);
    await cycle(w, b);
    expect(b.engine.epochKey).toBe("e000002-ffffffff");
    expect(remarks(b)).not.toContain("Bus");
    expect(offered(b, true)).toContain("add:Bus");
    expect(offered(b, true)).toContain("add:Taxi");
  });
});

describe("a cut listing never decides a restore's epoch or outcome (ADR-0008)", () => {
  it("one that leaves out a greater epoch after the genesis lands: the restore says the winner is unknown", async () => {
    // Three tree entries: the folder, a's log and the first genesis. Sam's
    // restore, and a's own, sort after them and are cut.
    w = await world({ fake: { treeEntryLimit: 3 } });
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await cycle(w, a);
    await plantRestore("e000002-ffffffff", structuredClone(a.engine.current()));
    const result = await a.engine.restore(structuredClone(a.engine.current()));
    expect(result).toEqual({ kind: "restored", epoch: expect.stringMatching(/^e000002-/), winnerUnknown: true });
  });

  it("one that doesn't show this device's epoch winning: nothing is written, and the restore can be tried again", async () => {
    // One tree entry: the folder. Every genesis is cut.
    w = await world({ fake: { treeEntryLimit: 1 } });
    const a = await open({ login: "alex" });
    const before = puts(w).length;
    expect(await a.engine.restore(structuredClone(a.engine.current()))).toMatchObject({ kind: "failed" });
    expect(puts(w).length).toBe(before);
    expect(w.fake.commits.filter((c) => c.path.endsWith(".genesis.enc"))).toEqual([]);
  });
});

describe("a newer epoch that can't be read (section 9.1)", () => {
  const cases: [string, () => Promise<void>, string][] = [
    [
      "another key",
      async () => {
        const other = await testKey();
        await plant(w, { kind: "genesis", epoch: "e000002-0000000b" }, { fv: 1, kind: "genesis", epoch: "e000002-0000000b", reason: "restore", by: "sam", at: 2, basedOn: null, doc: w.doc }, other);
      },
      "needsPassphrase",
    ],
    ["a newer format", () => plant(w, { kind: "genesis", epoch: "e000002-0000000b" }, { fv: 2, kind: "genesis", epoch: "e000002-0000000b" }).then(() => undefined), "needsUpdate"],
    [
      "a malformed genesis",
      () => plant(w, { kind: "genesis", epoch: "e000002-0000000b" }, { fv: 1, kind: "genesis", epoch: "e000002-0000000b", reason: "restore", by: "sam", at: 2, basedOn: null, doc: {} }).then(() => undefined),
      "needsAttention",
    ],
  ];
  for (const [name, make, expected] of cases) {
    it(`${name}: ${expected}, the device stays on its epoch, sends nothing more, and keeps its writes`, async () => {
      const a = await open();
      await make();
      await a.backend.addEntry(entry("Groceries"));
      const before = puts(w).length;
      await cycle(w, a);
      expect(status(a)).toBe(expected);
      expect(a.engine.epochKey).toBe(EPOCH);
      expect(puts(w).length).toBe(before);
      expect(a.engine.getState().pendingCount).toBe(1);
      await a.backend.addEntry(entry("Bus"));
      expect(remarks(a)).toEqual(["Groceries", "Bus"]);
    });
  }
});

describe("a newer genesis no device can read never stops sync for good (ADR-0008)", () => {
  const BAD = "e000002-0000000b";
  /** Genesis files for BAD that no device here can read, and what each
   * stops a device on. */
  const unreadable: [string, () => Promise<{ text?: string; content?: unknown; key?: DeviceKey }>, string][] = [
    ["garbage bytes (no passphrase needed)", async () => ({ text: "not a ledger file" }), "needsAttention"],
    [
      "a valid genesis cut in two (no passphrase needed)",
      async () => {
        const text = await seal({ fv: 1, kind: "genesis", epoch: BAD, reason: "restore", by: "sam", at: 2, basedOn: null, doc: w.doc }, w.key);
        return { text: text.slice(0, Math.floor(text.length / 2)) };
      },
      "needsAttention",
    ],
    ["a genesis under another key", async () => ({ content: { fv: 1, kind: "genesis", epoch: BAD, reason: "restore", by: "sam", at: 2, basedOn: null, doc: w.doc }, key: await testKey() }), "needsPassphrase"],
  ];

  for (const [name, make, stuck] of unreadable) {
    it(`${name}: a restore is numbered after it, every device switches to the restore, and a fresh device joins it`, async () => {
      const a = await open({ login: "alex" });
      const b = await open({ login: "sam" });
      await a.backend.addEntry(entry("Groceries"));
      await quiesce(w, a, b);
      const bad = await make();
      await plant(w, { kind: "genesis", epoch: BAD }, bad.text ?? bad.content, bad.key);
      await a.backend.addEntry(entry("Bus"));
      await b.backend.addEntry(entry("Rent"));
      await cycle(w, a, b);
      for (const d of [a, b]) {
        expect(status(d)).toBe(stuck);
        expect(d.engine.epochKey).toBe(EPOCH);
      }
      // a restores what it has (Bus included); its unpushed Bus is in the backup.
      const result = await a.engine.restore(structuredClone(a.engine.current()), { discardUnsynced: true });
      expect(result).toEqual({ kind: "restored", epoch: expect.stringMatching(/^e000003-[0-9a-f]{8}$/) });
      const epoch = (result as { epoch: string }).epoch;
      // b, stuck behind the same genesis, switches to the restore; its own
      // unpushed Rent is offered (D18).
      await cycle(w, b);
      expect(b.engine.epochKey).toBe(epoch);
      expect(status(b)).not.toBe(stuck);
      expect(b.engine.leftBehind()).toMatchObject([{ own: true, items: [{ kind: "add", record: { remarks: "Rent" } }] }]);
      await b.engine.reapply(b.engine.leftBehind()[0].id);
      // A fresh device finds and joins it (#8).
      const a2 = await reload(a);
      const fresh = await reload(await open({ login: "sam" }));
      await quiesce(w, a2, b, fresh);
      for (const d of [a2, b, fresh]) {
        expect(d.engine.epochKey).toBe(epoch);
        expect(remarks(d).sort()).toEqual(["Bus", "Groceries", "Rent"]);
      }
      expectConverged(a2, b, fresh);
      expect(w.fake.violations).toEqual([]);
    });
  }

  it("a newer genesis this build is too old to read still refuses a restore: updating the app is the fix", async () => {
    const a = await open({ login: "alex" });
    await plant(w, { kind: "genesis", epoch: BAD }, { fv: 2, kind: "genesis", epoch: BAD });
    await cycle(w, a);
    expect(status(a)).toBe("needsUpdate");
    const before = puts(w).length;
    expect(await a.engine.restore(structuredClone(a.engine.current()))).toMatchObject({ kind: "failed" });
    expect(puts(w).length).toBe(before);
  });
});

describe("Lamport exhaustion (ADR-0008)", () => {
  /** A valid log from X whose one op is at the last L there is. */
  async function plantTopOfRange(): Promise<void> {
    const r = new Replica(X, w.doc, { actor: "sam" });
    await r.backend.addEntry(entry("Planted"));
    await plant(w, { kind: "log", epoch: EPOCH, device: X }, logFile(X, [{ ...r.ops[0], L: MAX_L - 1 }]));
  }

  it("the next write restores the current ledger as the next epoch and commits there; every device follows, with nothing left behind", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await plantTopOfRange();
    await cycle(w, a, b);
    expect(remarks(a)).toEqual(["Planted"]);
    await a.backend.addEntry(entry("After"));
    expect(a.engine.epochKey).toMatch(/^e000002-/);
    expect(remarks(a)).toEqual(["Planted", "After"]);
    expect(w.fake.commits.find((c) => c.path.endsWith(".genesis.enc") && c.path.includes("e000002-"))).toMatchObject({ message: "Restore from backup" });
    await quiesce(w, a, b);
    expect(b.engine.epochKey).toBe(a.engine.epochKey);
    expectConverged(a, b);
    for (const d of [a, b]) expect(d.engine.leftBehind()).toEqual([]);
  });

  it("a sync cycle in flight across the switch joins nothing of the old epoch into the new one: devices converge", async () => {
    let hold: Promise<void> | null = null;
    let release!: () => void;
    let bLogSha: string | null = null;
    let held = false;
    const wrap = (inner: typeof fetch): typeof fetch => async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (hold && bLogSha && url.includes(`/git/blobs/${bLogSha}`)) {
        held = true;
        await hold;
      }
      return inner(input, init);
    };
    const a = await open({ login: "alex", wrapFetch: wrap });
    const b = await open({ login: "sam" });
    await plantTopOfRange();
    await cycle(w, a);
    await b.backend.addEntry(entry("Bus"));
    await cycle(w, b);
    bLogSha = w.fake.file(FULL, repoPath({ kind: "log", epoch: EPOCH, device: b.engine.deviceId! }))!.sha;
    hold = new Promise((resolve) => (release = resolve));
    w.clock.mono += 10_000;
    const inFlight = a.engine.sync(); // stalls reading b's log
    for (let i = 0; i < 200 && !held; i++) await nextTask();
    expect(held).toBe(true);
    await a.backend.addEntry(entry("After")); // the next epoch, and the write there
    expect(a.engine.epochKey).not.toBe(EPOCH);
    release();
    await inFlight;
    await quiesce(w, a, b);
    expect(b.engine.epochKey).toBe(a.engine.epochKey);
    expectConverged(a, b);
    const fresh = await reload(b);
    await quiesce(w, a, fresh);
    expectConverged(a, fresh);
  });

  it("a newer genesis no device can read doesn't refuse every write: the next epoch is numbered after it", async () => {
    const a = await open({ login: "alex" });
    await plantTopOfRange();
    await cycle(w, a);
    await plant(w, { kind: "genesis", epoch: "e000002-0000000b" }, "not a ledger file");
    await cycle(w, a);
    expect(status(a)).toBe("needsAttention");
    await a.backend.addEntry(entry("After"));
    expect(a.engine.epochKey).toMatch(/^e000003-/);
    expect(remarks(a)).toEqual(["Planted", "After"]);
    await quiesce(w, a);
    expect(status(a)).toBe("idle");
    const fresh = await reload(await open({ login: "sam" }));
    await quiesce(w, a, fresh);
    expectConverged(a, fresh);
  });

  it("every genesis PUT it sends counts against the hourly cap, a second one after no answer included (ADR-0008 stage 4)", async () => {
    // GitHub's own secondary limit (80 writes a minute) is kept out of the
    // way by moving its clock a second per write.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const a = await open();
    for (let i = 0; i < SYNC_TIMING.putsPerHour - 2; i++) {
      await a.backend.addEntry(entry(`E${i}`));
      w.clock.mono += SYNC_TIMING.putGapMs;
      vi.setSystemTime(Date.now() + 1000);
      await a.engine.sync();
    }
    expect(puts(w)).toHaveLength(SYNC_TIMING.putsPerHour - 2);
    await plantTopOfRange();
    await cycle(w, a);
    // The genesis PUT gets no answer and is sent again: two PUTs, the cap.
    w.fake.failNext({ method: "PUT", path: /genesis/, network: true });
    await a.backend.addEntry(entry("After"));
    expect(a.engine.epochKey).not.toBe(EPOCH);
    expect(puts(w)).toHaveLength(SYNC_TIMING.putsPerHour);
    w.clock.mono += SYNC_TIMING.putGapMs;
    await a.engine.sync();
    expect(puts(w)).toHaveLength(SYNC_TIMING.putsPerHour);
    w.clock.mono += 60 * 60 * 1000;
    await a.engine.sync();
    expect(puts(w)).toHaveLength(SYNC_TIMING.putsPerHour + 1);
  }, 60_000);

  it("without the repo the write is refused, the document unchanged, and the next one tries again", async () => {
    const a = await open();
    await plantTopOfRange();
    await cycle(w, a);
    w.fake.failNext({ method: "GET", path: /git\/ref/, network: true });
    await expect(a.backend.addEntry(entry("After"))).rejects.toMatchObject({ status: 503, message: NEEDS_NEW_EPOCH });
    expect(a.engine.epochKey).toBe(EPOCH);
    expect(remarks(a)).toEqual(["Planted"]);
    await a.backend.addEntry(entry("After"));
    expect(remarks(a)).toEqual(["Planted", "After"]);
    expect(a.engine.epochKey).not.toBe(EPOCH);
  });
});

describe("export (section 9.5)", () => {
  it("is the current document in the repo files' format, which opens with the household key only", async () => {
    const a = await open();
    await a.backend.addEntry(entry("Groceries"));
    const text = await a.engine.exportBackup();
    expect(() => JSON.parse(text)).toThrow();
    expect(JSON.parse(text.slice(0, text.indexOf("\n")))).toMatchObject({ alg: "AES-GCM-256", salt: w.key.salt, iter: w.key.iter });
    expect(text).not.toContain("Groceries");
    const opened = await readBackup(text, w.key.key);
    expect(opened.ok && docText(opened.doc)).toBe(docText(a.engine.current()));
    expect(await readBackup(text, (await testKey()).key)).toEqual({ ok: false, problem: "wrongPassphrase" });
    expect(await readBackup("not a backup", w.key.key)).toEqual({ ok: false, problem: "damaged" });
  });
});


describe("no resolved write is lost to a restore (AC6, randomised)", () => {
  const SEEDS = Number(testEnv("LEDGER_SIM_SEEDS") ?? 20);

  // Three devices add expenses (each remark unique), sync at random, and go
  // offline at random; device a restores a backup of its own document from
  // an earlier step. Every add then is either what the restore holds, or
  // one the restorer had seen (replaced on purpose), or listed in its own
  // device's left-behind group; once every device re-applies its own, every
  // add the restorer hadn't seen is back, on every device.
  it("every add is in the restore, seen by the restorer, or offered to its own device", async () => {
    await forEachSeed(SEEDS, async (seed) => {
      for (const engine of running.splice(0)) engine.stop();
      w = await world();
      const rng = new Rng(seed);
      // One device at a time may be offline for one cycle.
      let offline: number | null = null;
      const wrap = (i: number) => (inner: typeof fetch): typeof fetch => (input, request) => (offline === i ? Promise.reject(new TypeError("Failed to fetch")) : inner(input, request));
      const devices = [await open({ login: "alex", wrapFetch: wrap(0) }), await open({ login: "sam", wrapFetch: wrap(1) }), await open({ login: "alex", wrapFetch: wrap(2) })];
      const added = new Map<Device, string[]>(devices.map((d) => [d, []]));
      let backup: LedgerDocument = structuredClone(devices[0].engine.current());
      let n = 0;
      const step = async (pool: Device[] = devices) => {
        const d = rng.pick(pool);
        const roll = rng.int(10);
        if (roll < 5) {
          const remark = `R${seed}-${n++}`;
          await d.backend.addEntry(entry(remark));
          added.get(d)!.push(remark);
        } else if (roll < 9) {
          offline = rng.chance(0.2) ? devices.indexOf(d) : null;
          await cycle(w, d);
          offline = null;
        } else {
          backup = structuredClone(devices[0].engine.current());
        }
      };
      for (let i = 0; i < 12; i++) await step();
      const [a, ...others] = devices;
      const restored = backup;
      const result = await a.engine.restore(restored, { discardUnsynced: true });
      expect(["restored", "replaced"]).toContain(result.kind);
      const seenByRestorer = new Set(remarks(a));
      // The restorer refuses writes until its reload (section 9.2 step 7).
      for (let i = 0; i < 6; i++) await step(others);
      const a2 = await reload(a);
      const live = [a2, ...others];
      await quiesce(w, ...live);
      expectConverged(...live);
      const inBackup = new Set((restored.expenses["2026-05"] ?? []).map((e) => e.remarks));
      for (const d of others) {
        const offered = new Set(
          d.engine
            .leftBehind()
            .filter((g) => g.own)
            .flatMap((g) => g.items.map((item) => (item.kind === "add" ? String(item.record.remarks) : ""))),
        );
        const shown = new Set(remarks(d));
        for (const remark of added.get(d)!) {
          if (inBackup.has(remark) || seenByRestorer.has(remark) || shown.has(remark)) continue;
          expect(offered, `seed ${seed}: ${remark}`).toContain(remark);
        }
      }
      for (const d of others) for (const g of d.engine.leftBehind().filter((g) => g.own)) await d.engine.reapply(g.id);
      await quiesce(w, ...live);
      expectConverged(...live);
      const final = new Set(remarks(a2));
      for (const d of others) for (const remark of added.get(d)!) if (!seenByRestorer.has(remark) || inBackup.has(remark)) expect(final, `seed ${seed}: ${remark}`).toContain(remark);
      expect(w.fake.violations).toEqual([]);
    });
  }, 120_000);
});
