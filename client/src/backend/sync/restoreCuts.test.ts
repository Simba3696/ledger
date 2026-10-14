import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerDocument } from "../document/types";
import { EPOCH, cycle, device, entry, plant, quiesce, repoOps, world, type Device, type DeviceOptions, type World } from "./cycleTestkit";
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

async function plantRestore(epoch: string, doc: LedgerDocument, seen: Record<string, number>): Promise<void> {
  await plant(w, { kind: "genesis", epoch }, { fv: 1, kind: "genesis", epoch, reason: "restore", by: "sam", at: 7, basedOn: { epoch: EPOCH, seen }, doc });
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
