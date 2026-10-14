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

/** What a device shows in May plus what its groups offer, by remarks. */
function shownOrOffered(d: Device): string[] {
  const offered = d.engine.leftBehind().flatMap((g) => g.items.map((i) => ("record" in i ? String((i.record as { remarks?: unknown }).remarks ?? "") : "")));
  return [...remarks(d), ...offered];
}

describe("rejoin, part 4 review: nothing judged held against an old genesis (D36)", () => {
  async function onE2From(doc: () => LedgerDocument, a: Device, others: Device[] = []): Promise<void> {
    await plant(w, { kind: "genesis", epoch: E2 }, { fv: 1, kind: "genesis", epoch: E2, reason: "restore", by: "sam", at: 7, basedOn: { epoch: EPOCH, seen: {} }, doc: doc() });
    await quiesce(w, a, ...others);
  }

  it("S1: an own delete, in the gone epoch, of a record epoch 1 got from a log is offered and Re-apply deletes it", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await b.backend.addEntry(entry("Bus"));
    await quiesce(w, a, b);
    await onE2From(() => structuredClone(a.engine.current()), a, [b]);
    await a.backend.deleteEntry(2026, 5, (await a.backend.getMonth(2026, 5)).find((e) => e.remarks === "Bus")!.row);
    await quiesce(w, a, b);
    w.fake.removeFile(FULL, E2_PATH);
    await cycle(w, a, a);
    expect(await a.engine.rejoin()).toMatchObject({ kind: "joined" });
    const own = a.engine.leftBehind().filter((g) => g.own);
    expect(own).toHaveLength(1);
    await a.engine.reapply(own[0].id);
    expect(remarks(a)).toEqual([]);
  });

  it("S4: an own unlock that matches epoch 1's genesis but not what epoch 1 holds now is offered", async () => {
    const a = await open({ login: "alex" });
    const c = await open({ login: "sam" });
    await c.backend.setMonthLock(2026, 4, true);
    await quiesce(w, a, c);
    await onE2From(() => structuredClone(a.engine.current()), a);
    await a.backend.setMonthLock(2026, 4, false);
    await quiesce(w, a);
    w.fake.removeFile(FULL, E2_PATH);
    await cycle(w, a, a);
    expect(await a.engine.rejoin()).toMatchObject({ kind: "joined" });
    await quiesce(w, a, c);
    expect(a.engine.current().monthLocks["2026-04"]).toBe(true);
    for (const g of a.engine.leftBehind().filter((x) => x.own)) await a.engine.reapply(g.id);
    expect(a.engine.current().monthLocks["2026-04"]).not.toBe(true);
  });

  it("S3: going back into an epoch this device used before offers nothing of its old history there as its changes", async () => {
    const a = await open({ login: "alex" });
    const c = await open({ login: "sam" });
    await a.backend.addEntry(entry("Rent", 5));
    await quiesce(w, a, c);
    await onE2From(() => structuredClone(a.engine.current()), a);
    w.fake.removeFile(FULL, E2_PATH);
    await c.backend.updateEntry(2026, 5, (await c.backend.getMonth(2026, 5)).find((e) => e.remarks === "Rent")!.row, { amount: 9, remarks: "Rent", category: "food", isCard: false });
    await quiesce(w, c);
    await cycle(w, a, a);
    expect(await a.engine.rejoin()).toMatchObject({ kind: "joined" });
    await quiesce(w, a, c);
    // Alex did nothing on epoch 2: nothing of its is offered, and Sam's 9 stands.
    expect(a.engine.getState().leftBehindOwnCount).toBe(0);
    expect(expenses(a)).toEqual(["Rent 9.00"]);
  });

  it("S5: an unpushed change carried through a rejoin into a former epoch survives the next switch out of it", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Pushed", 3));
    await quiesce(w, a);
    await a.backend.addEntry(entry("Unpushed", 4));
    await onE2From(() => structuredClone(w.doc), a);
    w.fake.removeFile(FULL, E2_PATH);
    await cycle(w, a, a);
    expect(await a.engine.rejoin()).toMatchObject({ kind: "joined" });
    await quiesce(w, a);
    const E3 = "e000002-0000000b";
    await plant(w, { kind: "genesis", epoch: E3 }, { fv: 1, kind: "genesis", epoch: E3, reason: "restore", by: "sam", at: 9, basedOn: { epoch: EPOCH, seen: {} }, doc: structuredClone(w.doc) });
    await cycle(w, a);
    expect(shownOrOffered(a)).toContain("Unpushed");
    expect(a.engine.leftBehind().some((g) => g.own)).toBe(true);
  });

  it("S7: a create from this device that then loses a race still offers this device's changes", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    w.fake.removeFile(FULL, `ledger/${EPOCH}.genesis.enc`);
    await cycle(w, a, a);
    await a.backend.addEntry(entry("Lunch"));
    expect((await createFromDevice(a.engine, { client: a.client, branch: "main" }, w.key, "alex")).kind).toBe("created");
    expect(await a.engine.rejoin()).toMatchObject({ kind: "joined" });
    // Another device's create from its own data landed just after, with a
    // greater key.
    const EB = "e000001-ffffffff";
    await plant(w, { kind: "genesis", epoch: EB }, { fv: 1, kind: "genesis", epoch: EB, reason: "restore", by: "sam", at: 9, basedOn: null, doc: structuredClone(w.doc) });
    await quiesce(w, a);
    expect(shownOrOffered(a)).toEqual(expect.arrayContaining(["Groceries", "Lunch"]));
  });

  it("S6: rejoin refuses until the cycle has said the epoch is gone (one listing may be stale)", async () => {
    const a = await open({ login: "alex" });
    await onE2From(() => structuredClone(w.doc), a);
    await a.backend.addEntry(entry("Lunch"));
    await quiesce(w, a);
    w.fake.removeFile(FULL, E2_PATH);
    // The cycle hasn't listed since: nothing says the epoch is gone yet.
    const before = puts(w).length;
    expect(await a.engine.rejoin()).toEqual({ kind: "notGone" });
    expect(puts(w).length).toBe(before);
    expect(a.engine.leftBehind()).toEqual([]);
  });
});
