// Identities and tags (design section 2.1). Nothing here reads a clock:
// writes are ordered by Lamport tags alone.

/** A write's position: [Lamport L, device id]. Ordered by L, then device id
 * (compareTags). Two registers with an equal tag (only possible after a
 * fork) are ordered by value instead (state.ts). */
export type Tag = readonly [L: number, device: string];

/** Every L is a safe integer below this, so it stays exact in JSON. */
export const MAX_L = 2 ** 50;

/** The pseudo-device a genesis's registers are tagged with: [1, "g"]. */
const GENESIS_DEVICE = "g";
export const GENESIS_TAG: Tag = [1, GENESIS_DEVICE];

/** Per device, the greatest L joined from it. */
export type VersionVector = Record<string, number>;

/** "d" and 16 lowercase hex digits. Never reused: a new sync state always
 * mints a new one. */
export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && /^d[0-9a-f]{16}$/.test(value);
}

/** A usable Lamport value: a safe integer in [1, 2^50). */
export function isLamport(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) < MAX_L;
}

/** A device's tag [L, deviceId], or the genesis tag [1, "g"] exactly: the
 * pseudo-device never writes at any other L, and a "g" tag above 1 would
 * beat every real device's write. */
export function isTag(value: unknown): value is Tag {
  if (!Array.isArray(value) || value.length !== 2 || !isLamport(value[0])) return false;
  return value[1] === GENESIS_DEVICE ? value[0] === GENESIS_TAG[0] : isDeviceId(value[1]);
}

/** Device ids compare as plain strings (code-unit order). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Negative, zero or positive as tag `a` orders before, with or after `b`. */
export function compareTags(a: Tag, b: Tag): number {
  return a[0] - b[0] || compareStrings(a[1], b[1]);
}

/** A version vector: device ids mapped to Lamport values. */
export function isVersionVector(value: unknown): value is VersionVector {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([device, L]) => isDeviceId(device) && isLamport(L));
}

/** The next L to allocate: 1 + the greatest L this device has joined,
 * committed or allocated. Throws rather than leave the exact range. */
export function nextLamport(maxL: number, lastAllocated: number): number {
  const L = Math.max(maxL, lastAllocated) + 1;
  if (!isLamport(L)) throw new RangeError(`Lamport value out of range: ${L}`);
  return L;
}

/** `count` random bytes as lowercase hex. */
export function randomHex(count: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(count));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new device id: "d" and 8 random bytes. */
export function newDeviceId(hex: (count: number) => string = randomHex): string {
  return `d${hex(8)}`;
}
