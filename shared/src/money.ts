// Decimal money arithmetic for storage that keeps amounts as strings rather
// than in a numeric(14,2) column (GitHub storage mode, ADR-0007). The rules
// copy what Postgres does with the value the server sends it, so both kinds
// of storage hold and return the same figures:
//
// - postgres.js sends a number as `String(value)` (server/src/db/client.ts),
//   and numeric(p,s) rounds that exact decimal to `s` places, halves away
//   from zero. toDecimalString rounds the same digits the same way, so 1.005
//   (whose binary double is just below 1.005) still stores as "1.01".
// - Reads parse the stored string with Number(), as the numeric parser in
//   db/client.ts does.
// - sum(numeric) adds exactly and returns one numeric per group; sumToNumber
//   adds integer cents with BigInt and converts once, so 0.1 + 0.2 is 0.3.
//
// Browser-safe like the rest of shared/: no Node or DOM APIs.

/** Decimal places: 2 for money columns, 3 for the two rate columns
 * (interest_rate and foreclosure_charge are numeric(6,3)). */
export type Scale = 2 | 3;

/** `value` rounded half away from zero to `scale` decimals, as Postgres
 * stores `String(value)` in a numeric column of that scale: "1.01" for
 * 1.005, "-1.01" for -1.005, "0.00" (never "-0.00") for -0.001. Exponent
 * forms (1e-7, 1e+21) are expanded first. Throws a RangeError for NaN or an
 * infinity, which callers have already rejected. */
export function toDecimalString(value: number, scale: Scale): string {
  if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`);
  let text = String(value);
  const negative = text.startsWith("-");
  if (negative) text = text.slice(1);

  let exponent = 0;
  const e = text.indexOf("e");
  if (e >= 0) {
    exponent = Number(text.slice(e + 1));
    text = text.slice(0, e);
  }
  const dot = text.indexOf(".");
  let digits = dot >= 0 ? text.slice(0, dot) + text.slice(dot + 1) : text;
  // Where the decimal point falls within `digits`.
  let point = (dot >= 0 ? dot : text.length) + exponent;
  if (point < 1) {
    digits = "0".repeat(1 - point) + digits;
    point = 1;
  }
  digits = digits.padEnd(point + scale + 1, "0");

  let units = BigInt(digits.slice(0, point + scale));
  if (digits.charCodeAt(point + scale) - 48 >= 5) units += 1n;
  const formatted = formatUnits(units, scale);
  return negative && units !== 0n ? `-${formatted}` : formatted;
}

/** A non-negative count of 10^-scale units as a plain decimal string. */
function formatUnits(units: bigint, scale: Scale): string {
  const text = units.toString().padStart(scale + 1, "0");
  return `${text.slice(0, -scale)}.${text.slice(-scale)}`;
}

/** The sum of 2-decimal strings (as toDecimalString(…, 2) writes them) as a
 * number: exact in BigInt cents, converted once through the decimal string,
 * the way `sum(amount)` on numeric(14,2) comes back from postgres.js. */
export function sumToNumber(amounts: Iterable<string>): number {
  let cents = 0n;
  for (const amount of amounts) cents += BigInt(amount.replace(".", ""));
  const negative = cents < 0n;
  const formatted = formatUnits(negative ? -cents : cents, 2);
  return Number(negative ? `-${formatted}` : formatted);
}
