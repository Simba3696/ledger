import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerDocument } from "../document/types";
import { EPOCH, FULL, cycle, device, entry, plant, puts, quiesce, remarks, world, type Device, type DeviceOptions, type World } from "./cycleTestkit";
import { createFromDevice } from "../../githubStorage/ledgerAccess";
import { testKey } from "./localTestkit";
import { genesisState } from "./state";
import { Rng, testEnv } from "./testkit";
import type { SyncEngine } from "./SyncEngine";

// #8's join from a gone epoch (ADR-0008 STAGE-8, owner decisions D34 and
// D35): SyncEngine.rejoin moves a device whose epoch was deleted on GitHub
// into the ledger that's there now, carrying everything it held in the
// gone epoch as groups left behind (the cut {}), its own first (D18), so
// Re-apply brings its changes into the joined ledger. A winner under
// another passphrase can't be joined this way (D35): rejoin says so and
// changes nothing. Fictional data only.

const running: SyncEngine[] = [];
let w: World;
const E2 = "e000002-0000000a";
const E2_PATH = `ledger/${E2}.genesis.enc`;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  w = await world();
});

afterEach(() => {
  for (const engine of running.splice(0)) engine.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function open(options: DeviceOptions = {}): Promise<Device> {
  const d = await device(w, options);
  running.push(d.engine);
  return d;
}

/** A restore genesis (epoch 2, based on epoch 1) another device wrote. */
async function plantRestore(doc: LedgerDocument): Promise<void> {
  await plant(w, { kind: "genesis", epoch: E2 }, { fv: 1, kind: "genesis", epoch: E2, reason: "restore", by: "sam", at: 7, basedOn: { epoch: EPOCH, seen: {} }, doc });
}

/** Alex and Sam on epoch 2; then its genesis is deleted on GitHub, so
 * epoch 1 wins again and both devices' epoch is gone. */
async function goneTo1(): Promise<{ a: Device; b: Device }> {
  const a = await open({ login: "alex" });
  const b = await open({ login: "sam" });
  await plantRestore(w.doc);
  await quiesce(w, a, b);
  await b.backend.addEntry(entry("Bus"));
  await quiesce(w, a, b);
  w.fake.removeFile(FULL, E2_PATH);
  // Two full listings in a row that don't count it: one may be stale.
  await cycle(w, a, a, b, b);
  expect(a.engine.getState().epochGone).toEqual({ epoch: E2, winner: EPOCH });
  expect(b.engine.getState().epochGone).toEqual({ epoch: E2, winner: EPOCH });
  return { a, b };
}

describe("rejoin: the join from a gone epoch (#8, D34)", () => {
  it("joins the ledger there now and carries this device's changes as its own group left behind; Re-apply brings them in", async () => {
    const { a, b } = await goneTo1();
    // Written after the epoch went: kept on the device, never pushed.
    await a.backend.addEntry(entry("Lunch"));
    expect(a.engine.getState().pendingCount).toBe(1);

    expect(await a.engine.rejoin()).toEqual({ kind: "joined", epoch: EPOCH });
    expect(a.engine.getState()).toMatchObject({ epochGone: null, pendingCount: 0 });
    // Epoch 1 doesn't hold Lunch, nor Sam's Bus: both are offered back,
    // Alex's own first (D18).
    expect(remarks(a)).not.toContain("Lunch");
    const groups = a.engine.leftBehind();
    expect(groups[0]).toMatchObject({ own: true, epoch: E2 });
    expect(groups.some((g) => !g.own)).toBe(true);
    const result = await a.engine.reapply(groups[0].id);
    expect(result.applied.length).toBeGreaterThan(0);
    expect(remarks(a)).toContain("Lunch");

    // Sam joins too, and both converge on epoch 1 with Lunch in it.
    expect(await b.engine.rejoin()).toEqual({ kind: "joined", epoch: EPOCH });
    await quiesce(w, a, b);
    expect(remarks(b)).toContain("Lunch");
    expect(remarks(b)).toEqual(remarks(a));
  });

  it("does nothing for a device whose epoch still counts", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    const before = puts(w).length;
    expect(await a.engine.rejoin()).toEqual({ kind: "notGone" });
    expect(puts(w).length).toBe(before);
    expect(a.engine.leftBehind()).toEqual([]);
  });

  it("refuses a winner under another passphrase and changes nothing (D35: back up, then forget and join)", async () => {
    // y created its own epoch 1 at the same time, with a greater key and
    // its own salt; its genesis was then deleted.
    const THEIRS = "e000001-0000000b";
    const other = await testKey();
    await plant(w, { kind: "genesis", epoch: THEIRS }, { fv: 1, kind: "genesis", epoch: THEIRS, reason: "create", by: "sam", at: 2, basedOn: null, doc: w.doc }, other);
    const y = await device({ ...w, key: other }, { login: "sam", init: { epoch: THEIRS, state: genesisState(w.doc) } });
    running.push(y.engine);
    await y.backend.addEntry(entry("Bus"));
    w.fake.removeFile(FULL, `ledger/${THEIRS}.genesis.enc`);
    await cycle(w, y, y);
    expect(y.engine.getState().epochGone).toEqual({ epoch: THEIRS, winner: EPOCH });
    const before = puts(w).length;
    expect(await y.engine.rejoin()).toEqual({ kind: "otherKey", epoch: EPOCH });
    expect(puts(w).length).toBe(before);
    expect(y.engine.getState().epochGone).toEqual({ epoch: THEIRS, winner: EPOCH });
    expect(remarks(y)).toEqual(["Bus"]);
  });

  it("with no ledger in the repo, says so and changes nothing", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    // The only genesis is deleted: no ledger counts.
    w.fake.removeFile(FULL, `ledger/${EPOCH}.genesis.enc`);
    await cycle(w, a, a);
    expect(a.engine.getState().epochGone).toEqual({ epoch: EPOCH, winner: null });
    expect(await a.engine.rejoin()).toEqual({ kind: "empty" });
    expect(remarks(a)).toEqual(["Groceries"]);
  });
});

describe("rejoin keeps every own change (seeded)", () => {
  it("after random adds, edits and deletes in a gone epoch, rejoin and Re-apply of every group leave the device's expenses as they were", async () => {
    // LEDGER_REJOIN_SEEDS runs more (default 12).
    const seeds = Number(testEnv("LEDGER_REJOIN_SEEDS") ?? 12);
    for (let seed = 1; seed <= seeds; seed++) {
      for (const engine of running.splice(0)) engine.stop();
      w = await world();
      const rng = new Rng(seed);
      const { a } = await goneTo1();
      // What Alex does on the gone epoch, offline: adds, edits and deletes,
      // some of them on what Sam wrote before the epoch went.
      for (let step = 0; step < 8; step++) {
        const month = await a.backend.getMonth(2026, 5);
        const pick = month[rng.int(month.length)];
        const roll = rng.int(3);
        if (roll === 0 || !pick) await a.backend.addEntry(entry(`Item ${seed}.${step}`, 1 + rng.int(90)));
        else if (roll === 1) await a.backend.updateEntry(2026, 5, pick.row, { amount: 1 + rng.int(90), remarks: `${pick.remarks}*`, category: "food", isCard: false });
        else await a.backend.deleteEntry(2026, 5, pick.row);
      }
      const expected = expenses(a);
      expect(await a.engine.rejoin()).toEqual({ kind: "joined", epoch: EPOCH });
      // Alex's own group can edit or delete only records the joined ledger
      // has: an edit of a record Sam created on the gone epoch is skipped
      // ("not in the ledger", section 9.4) until Sam's group, also offered
      // (D18), brings the record back. Re-applying every group, others'
      // first, gives back exactly what this device showed.
      const groups = a.engine.leftBehind();
      for (const group of [...groups.filter((g) => !g.own), ...groups.filter((g) => g.own)]) await a.engine.reapply(group.id);
      expect(expenses(a), `seed ${seed}`).toEqual(expected);
    }
  }, 600_000);
});

/** May's expenses as remarks and amounts, sorted. */
function expenses(d: Device): string[] {
  return (d.engine.current().expenses["2026-05"] ?? []).map((e) => `${e.remarks} ${e.amount}`).sort();
}

describe("Create a new ledger from this device, then rejoin (#8, no ledger left)", () => {
  it("writes a genesis of what the device shows, and the device rejoins it with its changes in place", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    w.fake.removeFile(FULL, `ledger/${EPOCH}.genesis.enc`);
    await cycle(w, a, a);
    await a.backend.addEntry(entry("Lunch"));
    const shown = remarks(a).slice().sort();
    const created = await createFromDevice(a.engine, { client: a.client, branch: "main" }, w.key, "alex");
    expect(created.kind).toBe("created");
    expect(await a.engine.rejoin()).toMatchObject({ kind: "joined" });
    expect(remarks(a).slice().sort()).toEqual(shown);
    expect(a.engine.getState()).toMatchObject({ epochGone: null });
    await quiesce(w, a);
    expect(a.engine.getState().status).toBe("idle");
  });
});
