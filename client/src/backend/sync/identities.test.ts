import { describe, expect, it } from "vitest";
import { compareEpochKeys, epochMove, isEpochKey, nextEpochKey, parseRepoFileName, repoFileName, winningEpoch } from "./epoch";
import { createOrderKey, genesisOrderKey, parseRecordKey, parseRegisterKey } from "./keys";
import { LamportExhausted, MAX_L, compareTags, isDeviceId, isTag, nextLamport, newDeviceId } from "./tags";

// Identities, tags, register keys and epochs (design sections 2.1, 2.2, 2.4,
// 6 and 9.1): all data, no clock.

const D1 = "d0000000000000001";
const D2 = "d00000000000000ff";
const ID = "6f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b";

describe("tags", () => {
  it("order by L, then by device id as a string", () => {
    expect(compareTags([2, D2], [3, D1])).toBeLessThan(0);
    expect(compareTags([3, D1], [3, D2])).toBeLessThan(0);
    expect(compareTags([3, D2], [3, D2])).toBe(0);
    expect(compareTags([1, "g"], [2, D1])).toBeLessThan(0);
  });

  it("allocate L as 1 + the greatest L joined, committed or allocated, and never reach 2^50", () => {
    expect(nextLamport(7, 3)).toBe(8);
    expect(nextLamport(7, 9)).toBe(10);
    expect(nextLamport(MAX_L - 2, 0)).toBe(MAX_L - 1);
    expect(() => nextLamport(MAX_L - 1, 0)).toThrow(LamportExhausted);
    expect(() => nextLamport(0, MAX_L - 1)).toThrow(LamportExhausted);
  });

  it("accept device ids of 'd' + 16 hex digits, the genesis pseudo-device only in a tag", () => {
    expect(isDeviceId(D1)).toBe(true);
    expect(isDeviceId("g")).toBe(false);
    expect(isDeviceId("d000000000000000")).toBe(false);
    expect(isDeviceId("D0000000000000001")).toBe(false);
    expect(isTag([1, "g"])).toBe(true);
    expect(isTag([0, D1])).toBe(false);
    expect(isTag([MAX_L, D1])).toBe(false);
    expect(isTag([1.5, D1])).toBe(false);
  });

  it("mint fresh device ids", () => {
    expect(newDeviceId(() => "0123456789abcdef")).toBe("d0123456789abcdef");
    const a = newDeviceId();
    expect(isDeviceId(a)).toBe(true);
    expect(newDeviceId()).not.toBe(a);
  });
});

describe("register keys", () => {
  it("parse every register kind and refuse anything else", () => {
    expect(parseRegisterKey(`e/${ID}/amount`)).toEqual({ kind: "field", coll: "e", id: ID, field: "amount" });
    expect(parseRegisterKey(`emi/${ID}/_c`)).toEqual({ kind: "field", coll: "emi", id: ID, field: "_c" });
    expect(parseRegisterKey(`sub/${ID}/_s`)).toEqual({ kind: "field", coll: "sub", id: ID, field: "_s" });
    expect(parseRegisterKey("fm/2026-05")).toEqual({ kind: "month", family: "fm", month: "2026-05" });
    expect(parseRegisterKey("lk/2026-12")).toEqual({ kind: "month", family: "lk", month: "2026-12" });
    expect(parseRegisterKey("st/timeZone")).toEqual({ kind: "setting", name: "timeZone" });
    expect(parseRegisterKey("cat")).toEqual({ kind: "categories" });
    for (const bad of [`e/${ID}/name`, `debt/${ID}/sortKey`, `x/${ID}/amount`, "e/not-a-uuid/amount", "fm/2026-5", "fm/2026-13", "st/theme", `e/${ID}`, "cb/0226-01"]) {
      expect(parseRegisterKey(bad), bad).toBeNull();
    }
    expect(parseRecordKey(`debt/${ID}`)).toEqual({ coll: "debt", id: ID });
    expect(parseRecordKey(`debt/${ID}/name`)).toBeNull();
  });

  it("order genesis records by index, before every new create, and new creates by L at any magnitude", () => {
    const keys = [genesisOrderKey(0), genesisOrderKey(35), genesisOrderKey(36), createOrderKey(2, D2), createOrderKey(9, D1), createOrderKey(10, D1), createOrderKey(999_999_999_999_999, D1), createOrderKey(1_000_000_000_000_000, D1), createOrderKey(MAX_L - 1, D1)];
    expect([...keys].sort()).toEqual(keys);
    expect(createOrderKey(5, D1) < createOrderKey(5, D2)).toBe(true);
  });
});

describe("epochs", () => {
  const E1 = "e000001-9c1f22aa";
  const E2a = "e000002-41d0be77";
  const E2b = "e000002-41d0be78";
  const E10 = "e000010-00000000";

  it("compare by number, then by the random hex", () => {
    expect(isEpochKey(E1)).toBe(true);
    expect(isEpochKey("e1-9c1f22aa")).toBe(false);
    expect(compareEpochKeys(E1, E2a)).toBeLessThan(0);
    expect(compareEpochKeys(E2a, E2b)).toBeLessThan(0);
    expect(compareEpochKeys(E10, "e000009-ffffffff")).toBeGreaterThan(0);
    expect(compareEpochKeys(E2a, E2a)).toBe(0);
  });

  it("make the next key after the winning epoch, or the first when none is listed", () => {
    expect(nextEpochKey(E1, () => "41d0be77")).toBe(E2a);
    expect(nextEpochKey(null, () => "00000000")).toBe("e000001-00000000");
    expect(isEpochKey(nextEpochKey("e000041-00000000"))).toBe(true);
  });

  it("name repo files, and ignore every other name", () => {
    expect(parseRepoFileName(`${E1}.genesis.enc`)).toEqual({ kind: "genesis", epoch: E1 });
    expect(parseRepoFileName(`${E1}.${D1}.log.enc`)).toEqual({ kind: "log", epoch: E1, device: D1 });
    expect(parseRepoFileName(`${E1}.${D1}.snap.enc`)).toEqual({ kind: "snap", epoch: E1, device: D1 });
    for (const name of ["ledger.json.enc", `${E1}.genesis`, `${E1}.g.log.enc`, `${E1}.${D1}.state.enc`, `${E1}.${D1}.log.enc.bak`, "README.md"]) {
      expect(parseRepoFileName(name), name).toBeNull();
    }
    for (const name of [`${E1}.genesis.enc`, `${E1}.${D1}.log.enc`, `${E2a}.${D2}.snap.enc`]) expect(repoFileName(parseRepoFileName(name)!)).toBe(name);
  });

  it("let the greatest epoch with a listed genesis win; logs alone don't make an epoch count", () => {
    expect(winningEpoch([])).toBeNull();
    expect(winningEpoch([`${E1}.genesis.enc`, `${E1}.${D1}.log.enc`, `${E10}.${D1}.log.enc`])).toBe(E1);
    // Two racing restores: the greater key wins on every device.
    expect(winningEpoch([`${E2b}.genesis.enc`, `${E1}.genesis.enc`, `${E2a}.genesis.enc`])).toBe(E2b);
  });

  // A restore writes the epoch after the winning one (section 9.2), and must
  // never be refused. So no listed genesis, however it is numbered, may
  // leave the restore without a greater key: numbers go on past 6 digits,
  // and only an unbroken run of epochs from 1 counts, so a genesis can't
  // jump ahead to a number whose names would outgrow a file name either.
  it("always leave a restore a next epoch that wins, whatever genesis is listed", () => {
    const crafted = "e999999-ffffffff";
    for (const listing of [[`${E1}.genesis.enc`, `${crafted}.genesis.enc`], [`${crafted}.genesis.enc`], [`${E1}.genesis.enc`]]) {
      const winner = winningEpoch(listing);
      const next = nextEpochKey(winner, () => "00000000");
      expect(isEpochKey(next), next).toBe(true);
      expect(winningEpoch([...listing, `${next}.genesis.enc`])).toBe(next);
    }
    // A run that really reaches 999999 goes on to 7 digits, in order.
    expect(nextEpochKey(crafted, () => "00000000")).toBe("e1000000-00000000");
    expect(isEpochKey("e1000000-00000000")).toBe(true);
    expect(compareEpochKeys(crafted, "e1000000-00000000")).toBeLessThan(0);
    expect(compareEpochKeys("e1000000-00000000", "e1000001-00000000")).toBeLessThan(0);
    // One way to write each number: 6 digits zero-padded, or more with no
    // leading zero.
    for (const key of ["e0000001-00000000", "e01000000-00000000"]) expect(isEpochKey(key), key).toBe(false);
  });

  it("count an epoch only in an unbroken run from 1: a gap leaves the epochs past it out", () => {
    const E3 = "e000003-00000000";
    expect(winningEpoch([`${E1}.genesis.enc`, `${E2a}.genesis.enc`, `${E3}.genesis.enc`])).toBe(E3);
    expect(winningEpoch([`${E1}.genesis.enc`, `${E3}.genesis.enc`, `${E10}.genesis.enc`])).toBe(E1);
    expect(winningEpoch([`${E2a}.genesis.enc`])).toBeNull();
    expect(winningEpoch(["e000000-00000000.genesis.enc"])).toBeNull();
  });

  it("say whether a listing is stale, the same epoch, or a restore to switch to", () => {
    expect(epochMove(E1, E2a)).toBe("stale");
    expect(epochMove(E2a, E2a)).toBe("same");
    expect(epochMove(E2b, E2a)).toBe("switch");
  });
});
