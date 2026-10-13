import { describe, expect, it } from "vitest";

// The old-bug catalogue (design section 13, B1-B28) and the section 4
// conflict table, as an index over the client's tests. Each row is a named
// test somewhere ("B<n>: ..."), asserting the section 13 outcome; this file
// checks that every row has one, in the file listed, so a row can't lose
// its test unnoticed. Section 13 has 28 rows: the old branch's 28 bugs
// (B1-B28), and no others.

const sources = import.meta.glob(["../../**/*.test.ts", "!./catalogue.test.ts"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** Each row: what section 13 says of it, and the test file naming it. */
const CATALOGUE: [n: number, outcome: "impossible" | "handled" | "not needed" | "process", file: string][] = [
  [1, "impossible", "sync/epochs.test.ts"],
  [2, "impossible", "sync/cycleFailures.test.ts"],
  [3, "impossible", "sync/cycleFailures.test.ts"],
  [4, "impossible", "sync/cycleFailures.test.ts"],
  [5, "impossible", "sync/cycleFailures.test.ts"],
  [6, "handled", "sync/cycleFailures.test.ts"],
  [7, "impossible", "sync/persist.test.ts"],
  [8, "handled", "sync/SyncEngine.test.ts"],
  [9, "handled", "githubStorage/sync/syncUi.test.ts"],
  [10, "impossible", "sync/cycleFailures.test.ts"],
  [11, "process", "sync/catalogue.test.ts"],
  [12, "handled", "sync/cycleFailures.test.ts"],
  [13, "handled", "sync/cycleFailures.test.ts"],
  [14, "handled", "sync/cycleFailures.test.ts"],
  [15, "not needed", "sync/epochs.test.ts"],
  [16, "impossible", "sync/cycleFailures.test.ts"],
  [17, "impossible", "sync/cycle.test.ts"],
  [18, "handled", "sync/cycleFailures.test.ts"],
  [19, "impossible", "sync/cycle.test.ts"],
  [20, "impossible", "sync/epochs.test.ts"],
  [21, "impossible", "sync/cycle.test.ts"],
  [22, "handled", "sync/persist.test.ts"],
  [23, "impossible", "sync/cycleFailures.test.ts"],
  [24, "handled", "github/fakeGitHub.test.ts"],
  [25, "impossible", "sync/cycleFailures.test.ts"],
  [26, "impossible", "sync/cycleFailures.test.ts"],
  [27, "handled", "sync/cycleFailures.test.ts"],
  [28, "impossible", "sync/cycleFailures.test.ts"],
];

/** Section 4's conflict table: a named test per row (convergence.test.ts,
 * at the level of the pure core) and the stale-UI row (fence.test.ts). */
const CONFLICT_ROWS = [
  "add / add",
  "edit / edit, different fields",
  "edit / edit, same field, same value",
  "edit / edit, same field, different values",
  "edit / delete",
  "move / delete, re-key bystander / delete, stamp-only / delete",
  "move / move",
  "delete / delete",
  "delete / re-add",
  "lock / edit",
  "lock / unlock",
  "setMonthIncome / setMonthIncome and setMonthBills / setMonthBills",
  "payEmi / payEmi",
  "settings / anything",
  "restore / anything",
  "restore / restore",
];

function fileOf(path: string): string {
  return path.replace(/^(\.\.\/)+/, "").replace(/^backend\//, "").replace(/^\.\//, "sync/");
}

/** Test titles starting "B<n>: " in a source: in it(...) or a table of
 * cases a title is built from. */
function labelled(source: string): number[] {
  return [...source.matchAll(/["'`]B(\d+): /g)].map((m) => Number(m[1]));
}

describe("old-bug catalogue (design section 13)", () => {
  it("B11: every old bug and every section 4 conflict row has a named test, so the spec can't drift from the tests unnoticed", () => {
    expect(CATALOGUE.map(([n]) => n)).toEqual(Array.from({ length: 28 }, (_, i) => i + 1));
    const where = new Map<number, string[]>();
    for (const [path, source] of Object.entries(sources)) {
      for (const n of labelled(source)) where.set(n, [...(where.get(n) ?? []), fileOf(path)]);
    }
    for (const [n, , file] of CATALOGUE) {
      if (n === 11) continue;
      expect(where.get(n) ?? [], `B${n}`).toContain(file);
    }
    // No test claims a row section 13 doesn't have.
    expect([...where.keys()].filter((n) => n < 1 || n > 28)).toEqual([]);
    const convergence = Object.entries(sources).find(([path]) => path.endsWith("/convergence.test.ts"))![1];
    for (const row of CONFLICT_ROWS) expect(convergence, row).toContain(`it("${row}`);
    const fence = Object.entries(sources).find(([path]) => path.endsWith("/fence.test.ts"))![1];
    expect(fence).toMatch(/untouched/);
  });
});
