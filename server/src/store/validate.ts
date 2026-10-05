import { LedgerError } from "../errors.js";
import { daysInMonth } from "../domain/dateMath.js";

// Shared input checks for the Postgres store modules. Each rejects, as a
// clear 400, a value a column would otherwise refuse with a database error
// (surfacing as a 500). routes.ts also maps any Postgres error that slips
// past these (see mapDatabaseError), but catching them here keeps the
// messages specific to the field.

/** Postgres `text` can't hold a NUL character ("invalid byte sequence");
 * the Excel edition stored it silently. */
export function assertText(value: string, label: string): void {
  if (value.includes("\u0000")) throw new LedgerError(`${label} contains an invalid character`, 400);
}

const MONEY_LIMIT_CENTS = 1e14; // numeric(14,2): at most 12 integer digits

/** Money columns are numeric(14,2), which rounds to cents first — so both
 * bounds are checked on the rounded cents (e.g. 999999999999.995 is under
 * 1e12 but rounds up and overflows; 0.001 is positive but rounds to 0). */
export function assertMoney(amount: number, opts: { positive: boolean }): void {
  // Rounded on the absolute value: Postgres rounds halves away from zero,
  // but Math.round rounds them toward +∞ (Math.round(-0.5) is -0), so
  // rounding a negative directly would under-count its magnitude.
  const absCents = Math.round(Math.abs(amount) * 100);
  if (opts.positive) {
    if (!Number.isFinite(amount) || amount <= 0 || absCents <= 0) {
      throw new LedgerError("Amount must be a positive number", 400);
    }
  } else if (!Number.isFinite(amount)) {
    throw new LedgerError("Amount must be a number", 400);
  }
  if (absCents >= MONEY_LIMIT_CENTS) throw new LedgerError("Amount is too large", 400);
}

/** A real YYYY-MM-DD calendar date. The Excel edition's parseDate clamped
 * impossible days (02-30 → end of February); a `date` column rejects them. */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** A `:row` path parameter that isn't a positive integer (e.g.
 * Number("abc") = NaN) can't be a real id; callers 404 it before querying,
 * as the Excel edition did, rather than letting Postgres reject the bigint. */
export function isPossibleId(row: number): boolean {
  return Number.isSafeInteger(row) && row > 0;
}
