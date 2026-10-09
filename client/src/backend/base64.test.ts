import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "./base64";

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  // getRandomValues fills at most 65,536 bytes per call.
  for (let i = 0; i < length; i += 65_536) crypto.getRandomValues(bytes.subarray(i, i + 65_536));
  return bytes;
}

describe("base64", () => {
  it("round-trips 5 MB without a RangeError", () => {
    const bytes = randomBytes(5 * 1024 * 1024);
    const encoded = bytesToBase64(bytes);
    expect(encoded).toHaveLength(Math.ceil(bytes.length / 3) * 4);
    // toEqual on 5 MB is slow; compare the bytes directly.
    const decoded = base64ToBytes(encoded);
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.every((b, i) => b === bytes[i])).toBe(true);
  });

  it("matches btoa on known values", () => {
    expect(bytesToBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
    expect(bytesToBase64(new Uint8Array([0, 255, 128, 1]))).toBe(btoa("\x00\xff\x80\x01"));
    expect(new TextDecoder().decode(base64ToBytes("aGVsbG8="))).toBe("hello");
  });

  it("handles empty input", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
    expect(base64ToBytes("")).toEqual(new Uint8Array());
  });

  it("ignores the line breaks GitHub puts every 60 characters", () => {
    const bytes = randomBytes(1000);
    const encoded = bytesToBase64(bytes);
    const wrapped = `${encoded.match(/.{1,60}/g)!.join("\n")}\n`;
    expect(wrapped.split("\n")[0]).toHaveLength(60);
    expect(base64ToBytes(wrapped)).toEqual(bytes);
    expect(base64ToBytes(wrapped.replace(/\n/g, "\r\n"))).toEqual(bytes);
  });
});
