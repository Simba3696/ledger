import { describe, expect, it } from "vitest";
import { generateId } from "./id";

describe("generateId", () => {
  it("returns a different id on every call, even within the same millisecond", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateId()));
    expect(ids.size).toBe(1000);
  });

  it("works without crypto.randomUUID (plain-HTTP phone access over Tailscale)", () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try {
      expect(generateId()).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    }
  });
});
