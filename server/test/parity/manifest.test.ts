import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MANIFEST, STORE_FILES, type SqlOnlyReason } from "./manifest";

// The guard on the parity manifest: every store test case is classified,
// nothing else is, and every case marked ported really runs in its
// *.parity.test.ts under the same describe and title.

const here = path.dirname(fileURLToPath(import.meta.url));
const REASONS: SqlOnlyReason[] = ["postgres-concurrency", "database-internals", "store-only-arguments"];

/** "describe > title" for every case in a test file: top-level describe()
 * blocks, and the cases (`it(` or `parity(`) inside them, whose title may
 * start on the line after the call. */
function caseTitles(file: string, caseFn: "it" | "parity"): string[] {
  const titles: string[] = [];
  let block: string | null = null;
  const pattern = new RegExp(String.raw`^describe\(\s*(["'])(.*?)\1|^[ \t]+${caseFn}\(\s*(["'])(.*?)\3`, "gm");
  for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
    if (match[2] !== undefined) block = match[2];
    else titles.push(`${block} > ${match[4]}`);
  }
  return titles;
}

describe("parity manifest", () => {
  it("classifies every store test case exactly once, ports at least 150, and runs every ported one", () => {
    let ported = 0;
    for (const file of STORE_FILES) {
      const storeTitles = caseTitles(path.join(here, "..", `${file}.test.ts`), "it");
      const entries = MANIFEST[file];
      expect(new Set(storeTitles).size, `${file}.test.ts has a duplicate case title`).toBe(storeTitles.length);
      expect(Object.keys(entries).sort(), `manifest.ts entries for ${file}.test.ts`).toEqual([...storeTitles].sort());

      const parityTitles = new Set(caseTitles(path.join(here, `${file}.parity.test.ts`), "parity"));
      for (const [title, classification] of Object.entries(entries)) {
        if (classification === "ported") {
          ported++;
          expect(parityTitles.has(title), `${file}.parity.test.ts runs "${title}"`).toBe(true);
        } else {
          expect(REASONS, `reason for "${title}"`).toContain(classification.sqlOnly);
          expect(classification.why.length, `why "${title}" is sql-only`).toBeGreaterThan(0);
          expect(parityTitles.has(title), `${file}.parity.test.ts must not run sql-only "${title}"`).toBe(false);
        }
      }
    }
    expect(ported).toBeGreaterThanOrEqual(150);
  });
});
