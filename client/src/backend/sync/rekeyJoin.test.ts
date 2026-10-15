import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ITERATIONS, deriveKey, newSalt } from "../crypto";
import { bytesToBase64 } from "../base64";
import { FULL, MemoryStore, cycle, device, entry, nextTask, plant, puts, quiesce, remarks, world, type Device, type DeviceOptions, type World } from "./cycleTestkit";
import { FakeLocks } from "./localTestkit";
import type { DeviceKey } from "./records";
import { genesisState } from "./state";
import type { SyncEngine } from "./SyncEngine";
import { Rng, testEnv } from "./testkit";

// The racing-create window closed (ADR-0008, owner decision D32, option A):
// two devices create a ledger at the same moment, each under its own salt,
// and both are told "created". The one whose genesis lost stops sync, its
// writes on the device only. With the household passphrase, rekeyAndJoin
// derives the winner's key from the winner's header, checks it opens the
// winner's genesis before writing anything, seals everything on this
// device under it in one transaction, and joins the winner as a rejoin
// does (D34, D36): every write of this device is offered back as its own
// left-behind group (the cut {}). Fictional data only.

const MINE = "e000001-0000000a";
const THEIRS = "e000001-0000000b";
const HOUSEHOLD = "correct horse battery staple";
const OWN = "a passphrase only this device used";

const running: SyncEngine[] = [];
let w: World;
let ownKey: DeviceKey;
let theirKey: DeviceKey;

async function keyOf(passphrase: string): Promise<DeviceKey> {
  const salt = bytesToBase64(newSalt());
  return { key: await deriveKey(passphrase, salt, DEFAULT_ITERATIONS), salt, iter: DEFAULT_ITERATIONS };
}

beforeAll(async () => {
  [ownKey, theirKey] = await Promise.all([keyOf(OWN), keyOf(HOUSEHOLD)]);
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  w = await world();
  // Two creates of epoch 1 at once, each under its own salt.
  w.fake.removeFile(FULL, `ledger/${MINE}.genesis.enc`);
  await plant(w, { kind: "genesis", epoch: MINE }, { fv: 1, kind: "genesis", epoch: MINE, reason: "create", by: "alex", at: 1, basedOn: null, doc: w.doc }, ownKey);
  await plant(w, { kind: "genesis", epoch: THEIRS }, { fv: 1, kind: "genesis", epoch: THEIRS, reason: "create", by: "sam", at: 2, basedOn: null, doc: w.doc }, theirKey);
});

afterEach(() => {
  for (const engine of running.splice(0)) engine.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function open(key: DeviceKey, epoch: string, options: DeviceOptions = {}): Promise<Device> {
  const d = await device({ ...w, key }, { init: { epoch, state: genesisState(w.doc) }, ...options });
  running.push(d.engine);
  return d;
}

/** Alex lost the race (its genesis has the lesser key) and wrote Lunch on
 * its device; Sam won and wrote Groceries, synced. */
async function lostRace(options: DeviceOptions = {}): Promise<{ a: Device; y: Device }> {
  const y = await open(theirKey, THEIRS, { login: "sam" });
  await y.backend.addEntry(entry("Groceries"));
  await quiesce(w, y);
  const a = await open(ownKey, MINE, { login: "alex", ...options });
  await a.backend.addEntry(entry("Lunch"));
  await cycle(w, a);
  expect(a.engine.getState()).toMatchObject({ status: "needsPassphrase", raceLost: { winner: THEIRS } });
  return { a, y };
}

describe("rekeyAndJoin: the loser of two racing creates joins the winner (D32)", () => {
  it("joins with the household passphrase, offers this device's writes back, and both devices converge once they are re-applied", async () => {
    const { a, y } = await lostRace();
    const result = await a.engine.rekeyAndJoin(HOUSEHOLD);
    expect(result).toMatchObject({ kind: "joined", epoch: THEIRS, key: { salt: theirKey.salt, iter: theirKey.iter } });
    expect(a.engine.epochKey).toBe(THEIRS);
    expect(a.engine.getState()).toMatchObject({ raceLost: null, damagedFile: null });
    // Everything this device wrote is its own group left behind.
    const own = a.engine.leftBehind().filter((g) => g.own);
    expect(own).toHaveLength(1);
    expect(own[0].items).toEqual([expect.objectContaining({ kind: "add", record: expect.objectContaining({ remarks: "Lunch" }) })]);
    await a.engine.reapply(own[0].id);
    await quiesce(w, a, y);
    expect(remarks(a).sort()).toEqual(["Groceries", "Lunch"]);
    expect(remarks(y).sort()).toEqual(["Groceries", "Lunch"]);
    expect(w.fake.violations).toEqual([]);
  }, 60_000);

  it("seals everything on the device under the winner's key: a reload with it reads it all, and the old key reads nothing", async () => {
    const { a } = await lostRace();
    const result = await a.engine.rekeyAndJoin(HOUSEHOLD);
    if (result.kind !== "joined") throw new Error(result.kind);
    a.engine.stop();
    const again = await device({ ...w, key: result.key }, { login: "alex", store: a.store });
    running.push(again.engine);
    expect(again.engine.getState()).toMatchObject({ unreadable: null });
    expect(again.engine.epochKey).toBe(THEIRS);
    expect(again.engine.leftBehind().filter((g) => g.own)).toHaveLength(1);
    again.engine.stop();
    const old = await device({ ...w, key: ownKey }, { login: "alex", store: a.store, noSettle: true });
    running.push(old.engine);
    expect(old.engine.getState().unreadable).toBe("undecryptable");
  }, 60_000);

  it("a wrong passphrase writes nothing, here or on GitHub", async () => {
    const { a } = await lostRace();
    const before = { puts: puts(w).length, mutations: a.store.mutations.length, epoch: a.engine.epochKey, doc: JSON.stringify(a.engine.current()) };
    expect(await a.engine.rekeyAndJoin("correct horse battery stapel")).toEqual({ kind: "wrongPassphrase", epoch: THEIRS });
    expect({ puts: puts(w).length, mutations: a.store.mutations.length, epoch: a.engine.epochKey, doc: JSON.stringify(a.engine.current()) }).toEqual(before);
    expect(a.engine.getState()).toMatchObject({ status: "needsPassphrase", raceLost: { winner: THEIRS } });
  }, 60_000);

  it("this device's own passphrase, where the winner uses another, is otherKey: nothing changes, and the backup-and-join way (D35) stays", async () => {
    const { a } = await lostRace();
    const before = { puts: puts(w).length, mutations: a.store.mutations.length };
    expect(await a.engine.rekeyAndJoin(OWN)).toEqual({ kind: "otherKey", epoch: THEIRS });
    expect({ puts: puts(w).length, mutations: a.store.mutations.length }).toEqual(before);
    expect(a.engine.epochKey).toBe(MINE);
    expect(remarks(a)).toEqual(["Lunch"]);
  }, 60_000);

  it("a re-seal that fails partway changes nothing: the old key still reads the device after a reload", async () => {
    const store = new MemoryStore();
    const mutate = store.mutate.bind(store);
    let failSwitch = false;
    store.mutate = async (m) => {
      // The switch's transaction is the one that clears the tail.
      if (failSwitch && m.clearTail) throw new DOMException("The transaction was aborted.", "AbortError");
      return mutate(m);
    };
    const { a } = await lostRace({ store });
    failSwitch = true;
    await expect(a.engine.rekeyAndJoin(HOUSEHOLD)).rejects.toThrow();
    expect(a.engine.epochKey).toBe(MINE);
    expect(remarks(a)).toEqual(["Lunch"]);
    failSwitch = false;
    a.engine.stop();
    const again = await device({ ...w, key: ownKey }, { login: "alex", store });
    running.push(again.engine);
    expect(again.engine.getState()).toMatchObject({ unreadable: null, raceLost: { winner: THEIRS } });
    expect(remarks(again)).toEqual(["Lunch"]);
    expect(await again.engine.rekeyAndJoin(HOUSEHOLD)).toMatchObject({ kind: "joined", epoch: THEIRS });
  }, 60_000);

  it("a second tab waiting for the lock never writes under the old key: once it has the lock it can't read the device with it, and opens with the new key", async () => {
    const locks = new FakeLocks() as unknown as LockManager;
    const store = new MemoryStore();
    const { a } = await lostRace({ store, locks });
    const b = await device({ ...w, key: ownKey }, { login: "alex", store, locks, noSettle: true });
    running.push(b.engine);
    expect(b.engine.getState().status).toBe("locked");
    await expect(b.backend.addEntry(entry("Tea"))).rejects.toMatchObject({ status: 503 });
    const result = await a.engine.rekeyAndJoin(HOUSEHOLD);
    if (result.kind !== "joined") throw new Error(result.kind);
    a.engine.stop();
    for (let i = 0; i < 50 && b.engine.getState().status === "locked"; i++) await nextTask();
    expect(b.engine.getState().unreadable).toBe("undecryptable");
    await expect(b.backend.addEntry(entry("Tea"))).rejects.toBeDefined();
    b.engine.stop();
    const c = await device({ ...w, key: result.key }, { login: "alex", store, locks });
    running.push(c.engine);
    expect(c.engine.epochKey).toBe(THEIRS);
    await c.backend.addEntry(entry("Tea"));
    expect(remarks(c)).toContain("Tea");
  }, 60_000);

  it("is refused for a device that isn't a racing create's loser: nothing is written", async () => {
    const y = await open(theirKey, THEIRS, { login: "sam" });
    const before = { puts: puts(w).length, mutations: y.store.mutations.length };
    expect(await y.engine.rekeyAndJoin(HOUSEHOLD)).toEqual({ kind: "notRaceLost" });
    expect({ puts: puts(w).length, mutations: y.store.mutations.length }).toEqual(before);
  }, 60_000);

  it("a seeded run: random writes on the loser come back exactly after the join and Re-apply", async () => {
    const seeds = Number(testEnv("LEDGER_REKEY_SEEDS") ?? 3);
    for (let seed = 1; seed <= seeds; seed++) {
      for (const engine of running.splice(0)) engine.stop();
      w = await world();
      w.fake.removeFile(FULL, `ledger/${MINE}.genesis.enc`);
      await plant(w, { kind: "genesis", epoch: MINE }, { fv: 1, kind: "genesis", epoch: MINE, reason: "create", by: "alex", at: 1, basedOn: null, doc: w.doc }, ownKey);
      await plant(w, { kind: "genesis", epoch: THEIRS }, { fv: 1, kind: "genesis", epoch: THEIRS, reason: "create", by: "sam", at: 2, basedOn: null, doc: w.doc }, theirKey);
      const rng = new Rng(seed);
      const y = await open(theirKey, THEIRS, { login: "sam" });
      const a = await open(ownKey, MINE, { login: "alex" });
      for (let i = 0; i < 4 + rng.int(6); i++) {
        const d = rng.chance(0.5) ? a : y;
        const rows = await d.backend.getMonth(2026, 5);
        const last = rows.at(-1);
        // An edit renames the row, so what it holds is told apart from the add.
        if (last && rng.chance(0.3)) await d.backend.updateEntry(2026, 5, last.row, { amount: 1 + rng.int(90), remarks: `${last.remarks}+`, category: "food", isCard: false });
        else await d.backend.addEntry(entry(`${d === a ? "A" : "S"}${seed}-${i}`, 1 + rng.int(90)));
        if (rng.chance(0.4)) await cycle(w, d);
      }
      await quiesce(w, y);
      await cycle(w, a);
      const mine = remarks(a);
      expect(await a.engine.rekeyAndJoin(HOUSEHOLD)).toMatchObject({ kind: "joined" });
      for (const group of a.engine.leftBehind()) await a.engine.reapply(group.id);
      await quiesce(w, a, y);
      for (const text of mine) expect(remarks(a), `seed ${seed}`).toContain(text);
      expect(remarks(y).sort(), `seed ${seed}`).toEqual(remarks(a).sort());
    }
  }, 300_000);
});
