import { describe, expect, it } from "vitest";
import example from "../.dev.vars.example?raw";

// Keeps the helper's settings documented: every `env.X` the handler reads
// is in .dev.vars.example, and every example there is still read. Read
// through Vite's ?raw and import.meta.glob, so the test needs no Node types.

const sources = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

const reads = new Set(Object.values(sources).flatMap((text) => [...text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1])));
const examples = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

describe("helper settings documentation", () => {
  it(".dev.vars.example documents every setting the helper reads", () => {
    expect([...reads]).toEqual(expect.arrayContaining(["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "ALLOWED_ORIGINS"]));
    expect([...reads].filter((name) => !examples.has(name))).toEqual([]);
  });

  it("every setting in .dev.vars.example is still read", () => {
    expect(examples.size).toBeGreaterThan(0);
    expect([...examples].filter((name) => !reads.has(name))).toEqual([]);
  });
});
