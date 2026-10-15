import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerDocument } from "../document/types";
import { testKey } from "./localTestkit";
import { repoPath } from "./repoFiles";
import { EPOCH, FULL, cycle, device, entry, plant, quiesce, remarks, repoOps, row, world, type Device, type DeviceOptions, type World } from "./cycleTestkit";
import type { SyncEngine } from "./SyncEngine";

// A device's own group left behind by a losing restore, when the winning
// restore's cut covers it (#7 follow-up, harness seed 140010): the winner's
// line holds those changes, so nothing is offered again. Fictional data.

const running: SyncEngine[] = [];
let w: World;

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

async function plantRestore(epoch: string, doc: LedgerDocument, seen: Record<string, number>, basedOn = EPOCH): Promise<void> {
  await plant(w, { kind: "genesis", epoch }, { fv: 1, kind: "genesis", epoch, reason: "restore", by: "sam", at: 7, basedOn: { epoch: basedOn, seen }, doc });
}

describe("an own group the winning restore's cut covers (#7 follow-up)", () => {
  it("is offered no more once the winner, which took the change in, wins", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    // What a racing restore's author had: Alex's Groceries, seen and then
    // edited further (a later value the backup holds).
    const later = structuredClone(a.engine.current());
    later.expenses["2026-05"][0].remarks = "Groceries and milk";

    // A restore that never saw Alex's Groceries: it's left behind, as Alex's.
    await plantRestore("e000002-0000000a", structuredClone(w.doc), {});
    await cycle(w, a);
    expect(a.engine.leftBehind().filter((g) => g.own)).toHaveLength(1);

    // A racing restore with a greater key wins. It saw Alex's Groceries (its
    // cut covers it) and holds a later value: offering Alex's again would
    // set that later value back.
    await plantRestore("e000002-0000000b", later, { [deviceInE1]: pushed });
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000002-0000000b");
    expect(a.engine.leftBehind()).toEqual([]);
    expect((a.engine.current().expenses["2026-05"] ?? []).map((e) => e.remarks)).toEqual(["Groceries and milk"]);
  });
});

// A device that skips the epoch two racing restores are based on (harness
// seed 150178): from E1 it goes straight to E3a, based on E2, which it never
// joined, and then to E3b, based on E2 too. Its E1 change above E2's cut
// was held only by E3a's genesis, so the first switch offered nothing; the
// second must offer it, as nothing in the winner's line holds it.
describe("a skipped epoch's racing restores (#7 follow-up, harness seed 150178)", () => {
  it("offers again an own change above the skipped epoch's cut that only the losing restore's genesis held", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    await a.backend.addEntry(entry("Bus ticket"));
    await quiesce(w, a);
    // A backup holding both: the losing restore's.
    const both = structuredClone(a.engine.current());

    // E2 (never joined here) saw Groceries but not Bus ticket. E3a, based
    // on E2, restores a backup that holds Bus ticket.
    await plantRestore("e000002-0000000a", structuredClone(w.doc), { [deviceInE1]: pushed });
    await plantRestore("e000003-0000000a", both, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000a");
    expect(remarks(a)).toContain("Bus ticket");
    // E3a holds it, so nothing is offered there.
    expect(a.engine.leftBehind()).toEqual([]);

    // E3b, also based on E2, wins with a backup that holds neither.
    await plantRestore("e000003-0000000b", structuredClone(w.doc), {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000b");
    const own = a.engine.leftBehind().filter((g) => g.own && g.epoch === EPOCH);
    expect(own).toHaveLength(1);
    expect(own[0].items).toEqual([expect.objectContaining({ kind: "add", record: expect.objectContaining({ remarks: "Bus ticket" }) })]);
  });
});

// A group carried from an epoch below the anchor (#14, item 2): Alex's E1
// change is offered on the switch to E2 and carried, unresolved, into E3a,
// whose genesis holds it, so the switch drops it there (withoutHeld). E3b,
// based on E2 too and lacking it, wins. E2 is projected again with E3b's
// cut, but E2 never held the change: it was E1's, below the anchor (E2).
describe("a group carried from an epoch below the anchor (#14)", () => {
  it("offers again an own change that only the losing restore's genesis held, when it came from below the anchor", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    await a.backend.addEntry(entry("Bus ticket"));
    await quiesce(w, a);
    // Alex's backup, taken now, holds both.
    const both = structuredClone(a.engine.current());

    // E2 saw Groceries but not Bus ticket: Bus ticket is Alex's own group.
    await plantRestore("e000002-0000000a", structuredClone(w.doc), { [deviceInE1]: pushed });
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000002-0000000a");
    expect(a.engine.leftBehind().filter((g) => g.own && g.epoch === EPOCH)).toHaveLength(1);

    // E3a restores Alex's backup, which holds Bus ticket: nothing to offer.
    await plantRestore("e000003-0000000a", both, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000a");
    expect(remarks(a)).toContain("Bus ticket");
    expect(a.engine.leftBehind()).toEqual([]);

    // What the device keeps for that survives a reload.
    a.engine.stop();
    const again = await open({ login: "alex", store: a.store });

    // E3b, based on E2 as well, wins and holds neither: Bus ticket is in no
    // ledger now, so it must be offered (D18).
    await plantRestore("e000003-0000000b", structuredClone(w.doc), {}, "e000002-0000000a");
    await cycle(w, again);
    expect(again.engine.epochKey).toBe("e000003-0000000b");
    expect(remarks(again)).not.toContain("Bus ticket");
    const offered = again.engine.leftBehind().filter((g) => g.own).flatMap((g) => g.items);
    expect(offered).toEqual([expect.objectContaining({ kind: "add", record: expect.objectContaining({ remarks: "Bus ticket" }) })]);
  });
});

// Deeper (#14): the genesis that trimmed the group is the anchor's own, and
// the winner's line never reaches the anchor. Alex goes E2 -> E3a (holds
// Bus ticket) -> E4a (based on E3a, holds Tea); E4b, based on E3b, based on
// E2, wins. The switch projects E3a again with the cut {} (the fallback),
// but neither Bus ticket nor Tea is E3a's: both are E1's, and only the
// losing geneses held them.
describe("a group carried from below an anchor the winner's line never reaches (#14)", () => {
  it("offers again every own change a losing genesis on the way trimmed", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    await a.backend.addEntry(entry("Bus ticket"));
    await a.backend.addEntry(entry("Tea"));
    await quiesce(w, a);
    const all = a.engine.current();
    const only = (keep: string) => {
      const doc = structuredClone(all);
      doc.expenses["2026-05"] = doc.expenses["2026-05"].filter((e) => e.remarks === "Groceries" || e.remarks === keep);
      return doc;
    };

    await plantRestore("e000002-0000000a", structuredClone(w.doc), { [deviceInE1]: pushed });
    await cycle(w, a);
    expect(a.engine.leftBehind().filter((g) => g.own).flatMap((g) => g.items)).toHaveLength(2);
    await plantRestore("e000003-0000000a", only("Bus ticket"), {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000a");
    await plantRestore("e000004-0000000a", only("Tea"), {}, "e000003-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000004-0000000a");
    expect(a.engine.leftBehind()).toEqual([]);

    await plantRestore("e000003-0000000b", structuredClone(w.doc), {}, "e000002-0000000a");
    await plantRestore("e000004-0000000b", structuredClone(w.doc), {}, "e000003-0000000b");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000004-0000000b");
    const offered = a.engine.leftBehind().filter((g) => g.own).flatMap((g) => g.items.map((item) => (item.kind === "add" ? item.record.remarks : item.kind)));
    expect(offered.sort()).toEqual(["Bus ticket", "Tea"]);
  });
});

// The same trim, undone by a rejoin (#14, D36): Alex's E1 group is trimmed
// away by E3b's genesis, which holds it; E3b's genesis is then deleted on
// GitHub and Alex joins E3a, which lacks it. A rejoin offers everything
// this device held, and what E3b's genesis trimmed is part of that.
describe("a group a gone epoch's genesis trimmed (#14, D36)", () => {
  it("is offered again by the rejoin", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    await a.backend.addEntry(entry("Bus ticket"));
    await quiesce(w, a);
    const both = structuredClone(a.engine.current());

    await plantRestore("e000002-0000000a", structuredClone(w.doc), { [deviceInE1]: pushed });
    await cycle(w, a);
    expect(a.engine.leftBehind().filter((g) => g.own)).toHaveLength(1);
    await plantRestore("e000003-0000000a", structuredClone(w.doc), {}, "e000002-0000000a");
    await plantRestore("e000003-0000000b", both, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000b");
    expect(a.engine.leftBehind()).toEqual([]);

    w.fake.removeFile(FULL, "ledger/e000003-0000000b.genesis.enc");
    await cycle(w, a, a);
    expect(a.engine.getState().epochGone).toEqual({ epoch: "e000003-0000000b", winner: "e000003-0000000a" });
    expect(await a.engine.rejoin()).toEqual({ kind: "joined", epoch: "e000003-0000000a" });
    expect(remarks(a)).not.toContain("Bus ticket");
    const offered = a.engine.leftBehind().filter((g) => g.own).flatMap((g) => g.items.map((item) => (item.kind === "add" ? item.record.remarks : item.kind)));
    expect(offered).toContain("Bus ticket");
  });
});

// A losing genesis can also hold back an epoch's own changes when the
// switch projects that epoch against it (the projection leaves out what
// the new genesis holds), and nothing projects that epoch again later
// unless it is the anchor. Three restores of one number, all based on E1
// (#14): Alex writes Bus ticket in E2a; E2b holds it, so the switch to E2b
// offers nothing of E2a; E2c, holding neither, wins, and only E1 (the
// anchor) and E2b are projected again.
describe("an own change only a losing genesis held, in the epoch switched from (#14)", () => {
  it("is offered when a third restore of the same number wins", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    const groceries = structuredClone(a.engine.current());

    await plantRestore("e000002-0000000a", groceries, { [deviceInE1]: pushed });
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000002-0000000a");
    await a.backend.addEntry(entry("Bus ticket"));
    await quiesce(w, a);
    const both = structuredClone(a.engine.current());

    await plantRestore("e000002-0000000b", both, { [deviceInE1]: pushed });
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000002-0000000b");
    expect(a.engine.leftBehind()).toEqual([]);

    await plantRestore("e000002-0000000c", groceries, { [deviceInE1]: pushed });
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000002-0000000c");
    expect(remarks(a)).toEqual(["Groceries"]);
    const offered = a.engine.leftBehind().filter((g) => g.own).flatMap((g) => g.items.map((item) => (item.kind === "add" ? item.record.remarks : item.kind)));
    expect(offered).toEqual(["Bus ticket"]);
  });
});

// Issue #14 item 3: a genesis in the winner's line this device can't read.
// The walk stops there, so the switch can't tell whether the line passes
// through the epoch switched from (E2) or only through its anchor (E1). It
// projects both with the cut {}, and records the old anchor (E1). Alex's
// E2 change is held by E4a's genesis, so nothing of E2 is offered; then
// E4b, in the same line, wins, and only E1 is projected again.
describe("a genesis in the line that can't be read (#14)", () => {
  /** E3's genesis as this device finds it at the switch to E4a. */
  type Damage = "malformed" | "undecryptable" | "unreachable once";
  async function run(damage: Damage): Promise<void> {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries"));
    await quiesce(w, a);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    const groceries = structuredClone(a.engine.current());
    await plantRestore("e000002-0000000a", groceries, { [deviceInE1]: pushed });
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000002-0000000a");
    await a.backend.addEntry(entry("Bus ticket"));
    await quiesce(w, a);
    const both = structuredClone(a.engine.current());

    // E3 is in the line: damaged outside the app, sealed under another key,
    // or readable but its GETs fail during the first switch.
    const E3 = "e000003-0000000a";
    if (damage === "malformed") await plant(w, { kind: "genesis", epoch: E3 }, "not a genesis");
    else if (damage === "undecryptable") await plant(w, { kind: "genesis", epoch: E3 }, { fv: 1, kind: "genesis", epoch: E3, reason: "restore", by: "sam", at: 7, basedOn: { epoch: "e000002-0000000a", seen: {} }, doc: groceries }, await testKey());
    else {
      await plantRestore(E3, groceries, {}, "e000002-0000000a");
      const sha = w.fake.file(FULL, repoPath({ kind: "genesis", epoch: E3 }))!.sha;
      for (let i = 0; i < 4; i++) w.fake.failNext({ method: "GET", status: 500, path: `/git/blobs/${sha}` });
    }
    await plantRestore("e000004-0000000a", both, {}, E3);
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000004-0000000a");
    expect(a.engine.leftBehind()).toEqual([]);

    await plantRestore("e000004-0000000b", groceries, {}, E3);
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000004-0000000b");
    expect(remarks(a)).toEqual(["Groceries"]);
    const offered = a.engine.leftBehind().filter((g) => g.own).flatMap((g) => g.items.map((item) => (item.kind === "add" ? item.record.remarks : item.kind)));
    expect(offered).toContain("Bus ticket");
  }

  it("leaves the epoch switched from protected on a later racing switch", async () => {
    await run("malformed");
  });

  it("the same for a genesis sealed under another key", async () => {
    await run("undecryptable");
  });

  it("the same when it can't be fetched at the first switch, only at the second", async () => {
    await run("unreachable once");
  });
});

// Review of #14: what a genesis held back must never come back once
// superseded. A part trimmed by a genesis is owed again only while that
// genesis may still lose, and never with a value a later write replaced.
const amounts = (d: Device) => (d.engine.current().expenses["2026-05"] ?? []).map((e) => `${e.remarks}=${e.amount}`);
const offeredOf = (d: Device) => d.engine.leftBehind().map((g) => ({ epoch: g.epoch, own: g.own, items: g.items.map((i) => (i.kind === "edit" ? `edit ${JSON.stringify(i.fields)}` : i.kind === "add" ? `add ${i.record.remarks}=${i.record.amount}` : i.kind)) }));
const offersValue = (d: Device, value: string) => JSON.stringify(offeredOf(d)).includes(value);

describe("a held-back part is never offered once superseded (#14 review)", () => {
  /** Alex's E1 edit to 45 is left behind by E2, then held by E3's genesis
   * (a sequential restore of a backup with 45), then superseded by 70. */
  async function heldThenEdited(): Promise<Device> {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries", 10));
    await quiesce(w, a);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    const before = structuredClone(a.engine.current());
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), entry("Groceries", 45));
    await quiesce(w, a);
    const with45 = structuredClone(a.engine.current());
    await plantRestore("e000002-0000000a", before, { [deviceInE1]: pushed });
    await cycle(w, a);
    expect(offersValue(a, "45.00")).toBe(true);
    await plantRestore("e000003-0000000a", with45, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000a");
    expect(a.engine.leftBehind()).toEqual([]);
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), entry("Groceries", 70));
    await quiesce(w, a);
    return a;
  }

  it("after a later own edit, through two racing restores based on the epoch that held it", async () => {
    const a = await heldThenEdited();
    const with70 = structuredClone(a.engine.current());
    const cut = { [a.engine.deviceId!]: a.engine.pushableOps().at(-1)!.L };
    await plantRestore("e000004-0000000a", with70, cut, "e000003-0000000a");
    await cycle(w, a);
    await plantRestore("e000004-0000000b", with70, cut, "e000003-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000004-0000000b");
    expect({ offered: offeredOf(a), amounts: amounts(a) }).toEqual({ offered: [], amounts: ["Groceries=70.00"] });
  });

  it("after a later own edit, through sequential restores and then a race", async () => {
    const a = await heldThenEdited();
    const with70 = structuredClone(a.engine.current());
    let prev = "e000003-0000000a";
    for (const n of [4, 5, 6, 7]) {
      const epoch = `e00000${n}-0000000a`;
      const last = a.engine.pushableOps().at(-1)?.L;
      await plantRestore(epoch, with70, last === undefined ? {} : { [a.engine.deviceId!]: last }, prev);
      await cycle(w, a);
      expect(a.engine.epochKey).toBe(epoch);
      expect(a.engine.leftBehind()).toEqual([]);
      prev = epoch;
    }
    await plantRestore("e000008-0000000a", with70, {}, prev);
    await cycle(w, a);
    await plantRestore("e000008-0000000b", with70, {}, prev);
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000008-0000000b");
    expect({ offered: offeredOf(a), amounts: amounts(a) }).toEqual({ offered: [], amounts: ["Groceries=70.00"] });
  });

  it("an own group re-applied in an epoch that then lost, and edited again there, is offered once, with the newer value", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries", 10));
    await quiesce(w, a);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    const before = structuredClone(a.engine.current());
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), entry("Groceries", 45));
    await quiesce(w, a);
    await plantRestore("e000002-0000000a", before, { [deviceInE1]: pushed });
    await cycle(w, a);
    await plantRestore("e000003-0000000a", before, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000a");
    const [group] = a.engine.leftBehind();
    await a.engine.reapply(group.id);
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), entry("Groceries", 70));
    await quiesce(w, a);
    expect({ offered: offeredOf(a), amounts: amounts(a) }).toEqual({ offered: [], amounts: ["Groceries=70.00"] });

    // E3b, based on E2 too, wins: the re-apply and the 70 are in no ledger.
    await plantRestore("e000003-0000000b", before, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000b");
    expect(offersValue(a, "45.00")).toBe(false);
    expect(offeredOf(a).filter((g) => g.own).flatMap((g) => g.items)).toEqual([expect.stringContaining("70.00")]);
  });
});

// Second review of #14: a rejoin settles no line, so what decides is the
// rejoined epoch itself. Alex's E1 45 is offered on the switch to E2a; E3a
// and E3b, both based on E2a, both hold 45; the switch E3a -> E3b trims it
// again; E3b's genesis is deleted on GitHub; Sam rejoins E3a and edits the
// amount to 70 there; Alex rejoins E3a too. E3a's genesis held 45, and a
// later write there replaced it: offering "E1: edit amount 45.00" would set
// Sam's 70 back.
describe("a rejoin never offers a part the rejoined epoch held or superseded (#14 second review)", () => {
  it("is not offered E1's 45 once Sam set 70 in the rejoined epoch, whose genesis held 45", async () => {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries", 10));
    await quiesce(w, a, b);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    const before = structuredClone(a.engine.current());
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), entry("Groceries", 45));
    await quiesce(w, a, b);
    const with45 = structuredClone(a.engine.current());

    await plantRestore("e000002-0000000a", before, { [deviceInE1]: pushed });
    await cycle(w, a, b);
    expect(offersValue(a, "45.00")).toBe(true);
    await plantRestore("e000003-0000000a", with45, {}, "e000002-0000000a");
    await cycle(w, a, b);
    expect([a.engine.epochKey, b.engine.epochKey]).toEqual(["e000003-0000000a", "e000003-0000000a"]);
    expect(a.engine.leftBehind()).toEqual([]);
    await plantRestore("e000003-0000000b", with45, {}, "e000002-0000000a");
    await cycle(w, a, b);
    expect([a.engine.epochKey, b.engine.epochKey]).toEqual(["e000003-0000000b", "e000003-0000000b"]);
    expect(offeredOf(a)).toEqual([]);

    // E3b's genesis is deleted; Sam rejoins E3a first and edits the amount there.
    w.fake.removeFile(FULL, "ledger/e000003-0000000b.genesis.enc");
    await cycle(w, b, b);
    expect(await b.engine.rejoin()).toEqual({ kind: "joined", epoch: "e000003-0000000a" });
    await b.backend.updateEntry(2026, 5, await row(b, "Groceries"), entry("Groceries", 70));
    await quiesce(w, b);
    await cycle(w, a, a);
    expect(await a.engine.rejoin()).toEqual({ kind: "joined", epoch: "e000003-0000000a" });
    await quiesce(w, a, b);
    // A superseded value is never offered.
    expect(offersValue(a, "45.00")).toBe(false);
    expect({ offered: offeredOf(a), amounts: amounts(a) }).toEqual({ offered: [], amounts: ["Groceries=70.00"] });
  });
});

// More of the same guard: a part a genesis held, then superseded in that
// epoch or a later one, is never offered when that genesis loses. Each
// passes on main (which never offers such a part again); they hold the
// line for the code that offers what a losing genesis held.
describe("a part a losing genesis held is never offered once superseded (#14)", () => {
  /** Alex's E1 edit to 45 offered on the switch to E2, then held by E3a's
   * genesis (based on E2), with Sam on E3a too. */
  async function heldByE3a(): Promise<{ a: Device; b: Device; before: LedgerDocument; with45: LedgerDocument }> {
    const a = await open({ login: "alex" });
    const b = await open({ login: "sam" });
    await a.backend.addEntry(entry("Groceries", 10));
    await a.backend.addEntry(entry("Bus ticket", 5));
    await quiesce(w, a, b);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    const before = structuredClone(a.engine.current());
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), entry("Groceries", 45));
    await quiesce(w, a, b);
    const with45 = structuredClone(a.engine.current());
    await plantRestore("e000002-0000000a", before, { [deviceInE1]: pushed });
    await cycle(w, a, b);
    expect(offersValue(a, "45.00")).toBe(true);
    await plantRestore("e000003-0000000a", with45, {}, "e000002-0000000a");
    await cycle(w, a, b);
    expect([a.engine.epochKey, b.engine.epochKey]).toEqual(["e000003-0000000a", "e000003-0000000a"]);
    expect(a.engine.leftBehind()).toEqual([]);
    return { a, b, before, with45 };
  }

  it("by another device's edit there, joined before the switch", async () => {
    const { a, b, before } = await heldByE3a();
    await b.backend.updateEntry(2026, 5, await row(b, "Groceries"), entry("Groceries", 70));
    await quiesce(w, b, a);
    expect(amounts(a)).toContain("Groceries=70.00");
    await plantRestore("e000003-0000000b", before, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000b");
    expect(offersValue(a, "45.00")).toBe(false);
    expect(offeredOf(a)).toEqual([{ epoch: "e000003-0000000a", own: false, items: [`edit ${JSON.stringify({ amount: "70.00" })}`] }]);
  });

  it("by a delete of its record there", async () => {
    const { a, before } = await heldByE3a();
    await a.backend.deleteEntry(2026, 5, await row(a, "Groceries"));
    await quiesce(w, a);
    await plantRestore("e000003-0000000b", before, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000b");
    expect(offersValue(a, "45.00")).toBe(false);
    // The delete itself is offered: the winner still has Groceries.
    expect(offeredOf(a)).toEqual([{ epoch: "e000003-0000000a", own: true, items: ["delete"] }]);
  });

  it("by an own edit in a later epoch whose genesis held it too, when a race two levels up leaves both out", async () => {
    const { a, with45, before } = await heldByE3a();
    await plantRestore("e000004-0000000a", with45, {}, "e000003-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000004-0000000a");
    expect(a.engine.leftBehind()).toEqual([]);
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), entry("Groceries", 70));
    await quiesce(w, a);
    await plantRestore("e000003-0000000b", before, {}, "e000002-0000000a");
    await plantRestore("e000004-0000000b", before, {}, "e000003-0000000b");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000004-0000000b");
    expect(offersValue(a, "45.00")).toBe(false);
    expect(offeredOf(a)).toEqual([{ epoch: "e000004-0000000a", own: true, items: [`edit ${JSON.stringify({ amount: "70.00" })}`] }]);
  });
});

// Two geneses in one line both held the part: it is owed only once the
// winner's line leaves both out, and then offered once (#14).
describe("a part two geneses of one line held (#14)", () => {
  it("is offered once when a race two levels up leaves both out", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries", 10));
    await quiesce(w, a);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    const before = structuredClone(a.engine.current());
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), entry("Groceries", 45));
    await quiesce(w, a);
    const with45 = structuredClone(a.engine.current());
    await plantRestore("e000002-0000000a", before, { [deviceInE1]: pushed });
    await cycle(w, a);
    await plantRestore("e000003-0000000a", with45, {}, "e000002-0000000a");
    await cycle(w, a);
    await plantRestore("e000004-0000000a", with45, {}, "e000003-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000004-0000000a");
    expect(a.engine.leftBehind()).toEqual([]);

    await plantRestore("e000003-0000000b", before, {}, "e000002-0000000a");
    await plantRestore("e000004-0000000b", before, {}, "e000003-0000000b");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000004-0000000b");
    expect(offeredOf(a)).toEqual([{ epoch: EPOCH, own: true, items: [`edit ${JSON.stringify({ amount: "45.00" })}`] }]);
  });
});

// A rejoin's winner based on the epoch a held part came from, under a cut
// that covers it: the winner's restorer saw the change and left it out, so
// it is not owed (#14; the cut is judged from that epoch's kept state).
describe("a held part under the rejoined winner's cut (#14)", () => {
  it("is not offered", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries", 10));
    await quiesce(w, a);
    const before = structuredClone(a.engine.current());
    await a.backend.addEntry(entry("Bus ticket", 5));
    await quiesce(w, a);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    const both = structuredClone(a.engine.current());

    // E2a (cut {}) holds Bus ticket: nothing offered, Bus ticket held.
    await plantRestore("e000002-0000000a", both, {});
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000002-0000000a");
    expect(a.engine.leftBehind()).toEqual([]);
    // E2a's genesis is deleted. The epoch left is E2-0 (a lesser key, based
    // on E1, which saw Bus ticket and restored a backup without it).
    await plantRestore("e000002-00000001", before, { [deviceInE1]: pushed });
    w.fake.removeFile(FULL, "ledger/e000002-0000000a.genesis.enc");
    await cycle(w, a, a);
    expect(a.engine.getState().epochGone).toEqual({ epoch: "e000002-0000000a", winner: "e000002-00000001" });
    expect(await a.engine.rejoin()).toEqual({ kind: "joined", epoch: "e000002-00000001" });
    expect(remarks(a)).toEqual(["Groceries"]);
    expect(offersValue(a, "Bus ticket")).toBe(false);
    expect(offeredOf(a)).toEqual([]);
  });
});

// Review of the third attempt: a part held at a switch must be checked
// against the epoch being left at that very switch. Alex's E1 45 is shown
// in E2, where Alex then sets 70, leaving the group unresolved; E3a holds
// 45 (a backup), so the switch into it trims the carried group; E3b wins
// with 10. Only E2's 70 is owed: offering E1's 45 too would let a re-apply
// in list order end at 45.
describe("a part a genesis held, superseded in the epoch left at that switch (#14 third review)", () => {
  it("is never offered", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries", 10));
    await quiesce(w, a);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    const before = structuredClone(a.engine.current());
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), entry("Groceries", 45));
    await quiesce(w, a);
    const with45 = structuredClone(a.engine.current());
    await plantRestore("e000002-0000000a", before, { [deviceInE1]: pushed });
    await cycle(w, a);
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), entry("Groceries", 70));
    await quiesce(w, a);
    expect(offersValue(a, "45.00")).toBe(true);
    await plantRestore("e000003-0000000a", with45, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000a");
    await plantRestore("e000003-0000000b", before, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000b");
    expect(offersValue(a, "45.00")).toBe(false);
    expect(offeredOf(a)).toEqual([{ epoch: "e000002-0000000a", own: true, items: [`edit ${JSON.stringify({ amount: "70.00" })}`] }]);
  });
});

// Harness seeds 165, 983 and 1058 at 120 steps with a racing restore after
// a sequential one (#17). Alex's E1 edit to 45 is offered on the switch to
// E2 and carried, unresolved, into E3a (based on E2). Alex resolves it in
// E3a. E3b, based on E2 too, wins: E2 is projected again, but the group is
// E1's, and E1 is projected again by nothing. A settlement in an epoch that
// lost is no answer (D18): a discard there is offered again under E1's
// marker; a re-apply there wrote the change into E3a, whose own writes are
// offered under E3a's marker, so it is offered there, once.
describe("an own group carried into an epoch that lost, and resolved there (#17)", () => {
  /** Alex's E1 45, carried into E3a, and Alex's device on E3a. */
  async function carriedIntoE3a(): Promise<{ a: Device; before: LedgerDocument }> {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries", 10));
    await quiesce(w, a);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    const before = structuredClone(a.engine.current());
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), entry("Groceries", 45));
    await quiesce(w, a);
    await plantRestore("e000002-0000000a", before, { [deviceInE1]: pushed });
    await cycle(w, a);
    await plantRestore("e000003-0000000a", before, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000a");
    expect(offeredOf(a)).toEqual([{ epoch: EPOCH, own: true, items: [`edit ${JSON.stringify({ amount: "45.00" })}`] }]);
    return { a, before };
  }

  it("a discard there is offered again under the old epoch's marker when that epoch loses", async () => {
    const { a, before } = await carriedIntoE3a();
    await a.engine.discard(a.engine.leftBehind()[0].id);
    await quiesce(w, a);
    expect(offeredOf(a)).toEqual([]);
    // What the device keeps for that survives a reload.
    a.engine.stop();
    const again = await open({ login: "alex", store: a.store });

    await plantRestore("e000003-0000000b", before, {}, "e000002-0000000a");
    await cycle(w, again);
    expect(again.engine.epochKey).toBe("e000003-0000000b");
    expect({ offered: offeredOf(again), amounts: amounts(again) }).toEqual({
      offered: [{ epoch: EPOCH, own: true, items: [`edit ${JSON.stringify({ amount: "45.00" })}`] }],
      amounts: ["Groceries=10.00"],
    });
  });

  it("a discard there stays settled when the winner's line passes through that epoch", async () => {
    const { a, before } = await carriedIntoE3a();
    await a.engine.discard(a.engine.leftBehind()[0].id);
    await quiesce(w, a);
    await plantRestore("e000004-0000000a", before, {}, "e000003-0000000a");
    await cycle(w, a);
    await plantRestore("e000004-0000000b", before, {}, "e000003-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000004-0000000b");
    expect(offersValue(a, "45.00")).toBe(false);
  });

  it("a discard there, then an own edit there, offers only the edit when that epoch loses", async () => {
    const { a, before } = await carriedIntoE3a();
    await a.engine.discard(a.engine.leftBehind()[0].id);
    await a.backend.updateEntry(2026, 5, await row(a, "Groceries"), entry("Groceries", 70));
    await quiesce(w, a);
    await plantRestore("e000003-0000000b", before, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000b");
    expect(offersValue(a, "45.00")).toBe(false);
    expect(offeredOf(a)).toEqual([{ epoch: "e000003-0000000a", own: true, items: [`edit ${JSON.stringify({ amount: "70.00" })}`] }]);
  });

  it("a re-apply there is offered once, under that epoch's marker, when that epoch loses", async () => {
    const { a, before } = await carriedIntoE3a();
    await a.engine.reapply(a.engine.leftBehind()[0].id);
    await quiesce(w, a);
    expect({ offered: offeredOf(a), amounts: amounts(a) }).toEqual({ offered: [], amounts: ["Groceries=45.00"] });
    await plantRestore("e000003-0000000b", before, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000b");
    expect(offeredOf(a)).toEqual([{ epoch: "e000003-0000000a", own: true, items: [`edit ${JSON.stringify({ amount: "45.00" })}`] }]);
  });

  // Review of #17: a delete leaves the record's registers under the
  // genesis tag, so only the deletion itself shows the epoch wrote over it.
  it("a re-applied delete there is offered once, under that epoch's marker, when that epoch loses", async () => {
    const a = await open({ login: "alex" });
    await a.backend.addEntry(entry("Groceries", 10));
    await a.backend.addEntry(entry("Tea", 5));
    await quiesce(w, a);
    const deviceInE1 = a.engine.deviceId!;
    const pushed = Math.max(...(await repoOps(w, a)));
    const before = structuredClone(a.engine.current());
    await a.backend.deleteEntry(2026, 5, await row(a, "Tea"));
    await quiesce(w, a);
    await plantRestore("e000002-0000000a", before, { [deviceInE1]: pushed });
    await cycle(w, a);
    await plantRestore("e000003-0000000a", before, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000a");
    expect(offeredOf(a)).toEqual([{ epoch: EPOCH, own: true, items: ["delete"] }]);
    await a.engine.reapply(a.engine.leftBehind()[0].id);
    await quiesce(w, a);
    expect({ offered: offeredOf(a), amounts: amounts(a) }).toEqual({ offered: [], amounts: ["Groceries=10.00"] });
    await plantRestore("e000003-0000000b", before, {}, "e000002-0000000a");
    await cycle(w, a);
    expect(a.engine.epochKey).toBe("e000003-0000000b");
    expect(offeredOf(a)).toEqual([{ epoch: "e000003-0000000a", own: true, items: ["delete"] }]);
  });
});
