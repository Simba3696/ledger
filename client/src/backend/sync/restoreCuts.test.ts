import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerDocument } from "../document/types";
import { testKey } from "./localTestkit";
import { repoPath } from "./repoFiles";
import { EPOCH, FULL, cycle, device, entry, plant, quiesce, remarks, repoOps, world, type Device, type DeviceOptions, type World } from "./cycleTestkit";
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
