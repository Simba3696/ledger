/** Shared month/day arithmetic for EMI's payment-schedule decay and
 * Subscriptions' renewal-cycle advance — both need to walk forward in
 * fixed-size steps (a monthly due day, or a Monthly/Yearly renewal) from an
 * anchor date to "today" without drifting across month-length differences
 * (e.g. a due day of 31 in February). */

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Clamps a day-of-month to the last real day of that month (e.g. 31 in
 * February becomes 28 or 29). */
export function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, daysInMonth(year, month));
}

/** Constructs a local (not UTC) midnight Date, so comparisons never shift by
 * a day across timezones the way parsing an ISO string as UTC can. */
export function makeDate(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, clampDay(year, month, day));
}

export function addMonths(date: Date, months: number): Date {
  const totalMonths = date.getMonth() + months;
  const year = date.getFullYear() + Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12;
  return makeDate(year, month + 1, date.getDate());
}

export function addYears(date: Date, years: number): Date {
  return makeDate(date.getFullYear() + years, date.getMonth() + 1, date.getDate());
}

export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return makeDate(y, m, d);
}

export function startOfDay(date: Date): Date {
  return makeDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}
