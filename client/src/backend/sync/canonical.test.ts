import { describe, expect, it } from "vitest";
import { canonicalJson, sameValue } from "./canonical";
import { Rng, forEachSeed } from "./testkit";

// sameValue is the equality every register comparison uses (the diff, the
// fence, notices): two values are the same when they are identical, or are
// both objects (arrays included) with equal canonical JSON texts. These
// tests pin that definition, so a faster sameValue can't drift from it.

/** sameValue's definition. */
function reference(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return canonicalJson(a) === canonicalJson(b);
}

/** A random value from small pools, so equal and nearly equal values come
 * up often: JSON values plus what JSON.stringify folds (undefined members
 * and items, -0, NaN, Infinity). */
function value(rng: Rng, depth = 0): unknown {
  const kind = rng.int(depth > 2 ? 7 : 10);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return undefined;
    case 2:
      return rng.pick([0, -0, 1, 1.5, NaN, Infinity, -Infinity]);
    case 3:
      return rng.pick(["", "a", "b", "a,b", "é", "null"]);
    case 4:
      return rng.chance(0.5);
    case 5:
    case 6:
      return rng.pick(["40.00", 7]);
    case 7:
      return Array.from({ length: rng.int(3) }, () => value(rng, depth + 1));
    default: {
      const out: Record<string, unknown> = {};
      for (const key of rng.shuffle(["a", "b", "c"]).slice(0, rng.int(4))) out[key] = value(rng, depth + 1);
      return out;
    }
  }
}

/** The same value with every object's keys in a fresh random order. */
function reordered(rng: Rng, v: unknown): unknown {
  if (Array.isArray(v)) return v.map((item) => reordered(rng, item));
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const key of rng.shuffle(Object.keys(v))) out[key] = reordered(rng, (v as Record<string, unknown>)[key]);
  return out;
}

describe("sameValue: identical, or objects with equal canonical JSON texts", () => {
  it("over random pairs of values, and each against a reordered copy of itself", async () => {
    await forEachSeed(300, (seed) => {
      const rng = new Rng(seed);
      for (let i = 0; i < 50; i++) {
        const a = value(rng);
        const b = rng.chance(0.5) ? reordered(rng, a) : value(rng);
        expect(sameValue(a, b)).toBe(reference(a, b));
        expect(sameValue(b, a)).toBe(sameValue(a, b));
        expect(sameValue(a, reordered(rng, a))).toBe(reference(a, reordered(rng, a)));
        const wrapped = { x: a, y: [a] };
        expect(sameValue(wrapped, reordered(rng, wrapped))).toBe(true);
      }
    });
  });

  it("folds what JSON text folds, and nothing else", () => {
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameValue([undefined], [null])).toBe(true);
    expect(sameValue({ a: -0 }, { a: 0 })).toBe(true);
    expect(sameValue({ a: NaN }, { a: null })).toBe(true);
    expect(sameValue([Infinity], [null])).toBe(true);
    expect(sameValue(new Date(1), new Date(2))).toBe(true);
    expect(sameValue({ a: 1 }, { a: "1" })).toBe(false);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue({ a: [] }, { a: {} })).toBe(false);
    expect(sameValue({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toBe(false);
    expect(sameValue(null, undefined)).toBe(false);
    expect(sameValue({}, null)).toBe(false);
    // At the top level a primitive is compared with ===.
    expect(sameValue(NaN, NaN)).toBe(false);
    expect(sameValue(-0, 0)).toBe(true);
  });

  it("reads only own enumerable keys, as canonicalJson does", () => {
    const hidden = Object.defineProperty({ a: 1 }, "b", { value: 2, enumerable: false });
    expect(sameValue(hidden, { a: 1 })).toBe(true);
    const other = Object.defineProperty({ c: 3 }, "a", { value: 1, enumerable: false });
    expect(sameValue(other, { a: 1 })).toBe(false);
    expect(sameValue(Object.create({ a: 1 }), {})).toBe(true);
  });
});
