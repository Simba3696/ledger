import { describe, expect, it } from "vitest";
import { Fence } from "./fence";
import { applyOp, cloneState, genesisState, opState, type Op } from "./state";
import { deviceId, emptyDocument } from "./testkit";

// The stale-UI fence (design section 3.4) on its own: a register a join
// replaced while the view lagged is dropped from an op that sets it back to
// what the user saw, and applied when the user typed something else.

const X = deviceId(0xb);

describe("Fence (pure)", () => {
  it("drops a field group (an EMI's balance pair) whole, or keeps it whole", async () => {
    const id = "00000000-0000-4000-8000-000000000e01";
    const rk = `emi/${id}`;
    const state = genesisState(emptyDocument());
    const create: Op = {
      L: 2,
      at: 0,
      by: "alex",
      vv: {},
      del: [],
      set: [
        [`${rk}/_c`, { o: `1.${"2".padStart(16, "0")}.${deviceId(1)}` }],
        [`${rk}/cardOrBank`, "Car Loan"],
        [`${rk}/emiAmount`, "1000.00"],
        [`${rk}/dueDay`, 5],
        [`${rk}/totalAmount`, "12000.00"],
        [`${rk}/remarks`, ""],
        [`${rk}/remainingAsOf`, "9000.00"],
        [`${rk}/asOfDate`, "2026-05-01"],
        [`${rk}/untilTarget`, null],
        [`${rk}/interestRate`, null],
        [`${rk}/foreclosureCharge`, null],
        [`${rk}/_s`, { at: 0, by: "alex" }],
      ],
    };
    applyOp(state, deviceId(1), create);
    const fence = new Fence();
    fence.attach(0, {});
    const paid: Op = { L: 3, at: 0, by: "sam", vv: {}, del: [], set: [[`${rk}/remainingAsOf`, "8000.00"], [`${rk}/asOfDate`, "2026-06-05"], [`${rk}/_s`, { at: 1, by: "sam" }]] };
    fence.join(state, opState(X, paid));
    expect(fence.revision).toBe(1);

    const stale = (remainingAsOf: string) => ({
      set: [
        [`${rk}/remarks`, "Car"],
        [`${rk}/remainingAsOf`, remainingAsOf],
        [`${rk}/asOfDate`, "2026-05-01"],
        [`${rk}/_s`, { at: 2, by: "alex" }],
      ] as [string, unknown][],
      del: [],
    });
    const untouched = fence.apply(stale("9000.00"), cloneState(state));
    expect(untouched.body?.set.map(([k]) => k)).toEqual([`${rk}/remarks`, `${rk}/_s`]);
    expect(untouched.notices).toMatchObject([{ kind: "kept", theirs: [3, X] }]);
    expect(untouched.notices[0].registers.map((r) => r.key)).toEqual([`${rk}/remainingAsOf`, `${rk}/asOfDate`]);

    const typed = fence.apply(stale("7000.00"), cloneState(state));
    expect(typed.body?.set.map(([k]) => k)).toEqual([`${rk}/remarks`, `${rk}/remainingAsOf`, `${rk}/asOfDate`, `${rk}/_s`]);
    expect(typed.notices).toMatchObject([{ kind: "replaced" }]);

    fence.rendered(1);
    expect(fence.apply(stale("9000.00"), state).notices).toEqual([]);
  });

  it("keeps the oldest pre-image since the last render, and never fences a create", () => {
    const state = genesisState(emptyDocument());
    const fence = new Fence();
    fence.attach(0, {});
    const lock = (L: number, v: boolean): Op => ({ L, at: 0, by: "sam", vv: {}, del: [], set: [["lk/2026-05", v]] });
    fence.join(state, opState(X, lock(2, true)));
    fence.join(state, opState(X, lock(3, false)));
    fence.join(state, opState(X, lock(4, true)));
    // The user last saw the month unlocked: an untouched "unlock" is dropped.
    expect(fence.apply({ set: [["lk/2026-05", false]], del: [] }, state).body).toBeNull();

    const id = "00000000-0000-4000-8000-000000000e02";
    const add = { set: [[`e/${id}/_c`, { m: "2026-05" }], [`e/${id}/amount`, "1.00"]] as [string, unknown][], del: [] };
    expect(fence.apply(add, state).body).toEqual(add);
  });

  it("forgets everything on detach", () => {
    const state = genesisState(emptyDocument());
    const fence = new Fence();
    const detach = fence.attach(0, {});
    fence.join(state, opState(X, { L: 2, at: 0, by: "sam", vv: {}, del: [], set: [["lk/2026-05", true]] }));
    detach();
    expect(fence.renderedRevision).toBe(fence.revision);
    expect(fence.apply({ set: [["lk/2026-05", false]], del: [] }, state).notices).toEqual([]);
  });
});



