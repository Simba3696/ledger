// A seeded PRNG for test support and the 10-year plan (tenYearPlan.ts).
// Pure: no test runner, so Node scripts can use it too.

/** mulberry32: a small seeded PRNG, so a failing seed can be replayed. */
export class Rng {
  #t: number;
  constructor(seed: number) {
    this.#t = seed >>> 0;
  }
  next(): number {
    this.#t = (this.#t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(this.#t ^ (this.#t >>> 15), 1 | this.#t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  }
  /** An integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  /** A uuid-shaped id, from this generator. */
  uuid(): string {
    const hex = Array.from({ length: 32 }, () => this.int(16).toString(16)).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
  }
}
