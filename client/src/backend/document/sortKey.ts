// Fractional-index keys for expense order, vendored (no new dependency) from
// the algorithm in David Greenspan's "Implementing Fractional Indexing" and
// its reference implementation, rocicorp/fractional-indexing (CC0). A key is
// an "integer part" (a head letter giving its length, then base-62 digits)
// plus an optional fraction with no trailing "0". Keys compare as plain
// strings, and there is always room for another key between two distinct
// ones, so a move or an append rewrites only the one record it moves.
//
// Appends take keyBetween(last, null): the integer part counts up (a0, a1,
// ... az, b00, ...), so keys stay short however many entries a month gets.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0];
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.slice(-1) === ZERO || (b !== null && b.slice(-1) === ZERO)) throw new Error("trailing zero");
  if (b !== null) {
    // The common prefix, then the midpoint of what follows it.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))];
  // The first digits are consecutive.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
  if (head >= "A" && head <= "Z") return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error(`invalid sort key head: ${head}`);
}

function integerPart(key: string): string {
  const length = integerLength(key[0]);
  if (length > key.length) throw new Error(`invalid sort key: ${key}`);
  return key.slice(0, length);
}

function validate(key: string): void {
  if (key === SMALLEST_INTEGER) throw new Error(`invalid sort key: ${key}`);
  const fraction = key.slice(integerPart(key).length);
  if (fraction.slice(-1) === ZERO) throw new Error(`invalid sort key: ${key}`);
}

/** Whether `value` is a key keyBetween accepts: base-62 digits only, a
 * valid head with its whole integer part, not the smallest integer, and no
 * trailing "0" in the fraction. A key read from elsewhere (a sync op, a
 * backup) must pass this, or the next append or move in its month throws. */
export function isSortKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || [...value].some((c) => !DIGITS.includes(c))) return false;
  try {
    validate(value);
    return true;
  } catch {
    return false;
  }
}

function incrementInteger(x: string): string | null {
  const [head, ...digits] = x.split("");
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) + 1;
    if (d === DIGITS.length) {
      digits[i] = ZERO;
    } else {
      digits[i] = DIGITS[d];
      carry = false;
    }
  }
  if (!carry) return head + digits.join("");
  if (head === "Z") return `a${ZERO}`;
  if (head === "z") return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > "a") digits.push(ZERO);
  else digits.pop();
  return next + digits.join("");
}

function decrementInteger(x: string): string | null {
  const [head, ...digits] = x.split("");
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) - 1;
    if (d === -1) {
      digits[i] = DIGITS.slice(-1);
    } else {
      digits[i] = DIGITS[d];
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join("");
  if (head === "a") return `Z${DIGITS.slice(-1)}`;
  if (head === "A") return null;
  const next = String.fromCharCode(head.charCodeAt(0) - 1);
  if (next < "Z") digits.push(DIGITS.slice(-1));
  else digits.pop();
  return next + digits.join("");
}

/** A key strictly between `a` and `b` (null = open end). Throws unless
 * a < b. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validate(a);
  if (b !== null) validate(b);
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a === null) {
    if (b === null) return `a${ZERO}`;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint("", fb);
    if (ib < b) return ib;
    const decremented = decrementInteger(ib);
    if (decremented === null) throw new Error("cannot decrement any more");
    return decremented;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  if (b === null) {
    const incremented = incrementInteger(ia);
    return incremented === null ? ia + midpoint(fa, null) : incremented;
  }
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const incremented = incrementInteger(ia);
  if (incremented === null) throw new Error("cannot increment any more");
  return incremented < b ? incremented : ia + midpoint(fa, null);
}

/** `count` ascending keys, evenly after one another from the start: what a
 * month is re-keyed with when two records share a key (possible only after
 * a sync merges two devices' appends) and a move needs room between them. */
export function sequentialKeys(count: number): string[] {
  const keys: string[] = [];
  let previous: string | null = null;
  for (let i = 0; i < count; i++) {
    previous = keyBetween(previous, null);
    keys.push(previous);
  }
  return keys;
}
