const DEFAULT_TIMEZONE = "Asia/Kolkata";

/** The current calendar day in APP_TIMEZONE, as a local-midnight Date — the
 * same "a Date standing for a calendar day" convention dateMath.ts uses.
 *
 * Serverless functions run in UTC and AWS Lambda reserves `TZ`, so a bare
 * `new Date()` would report the previous day between 00:00 and 05:30 IST and
 * shift every due-date calculation by one (ADR-0005). */
export function todayInAppZone(now: Date = new Date(), timeZone: string = process.env.APP_TIMEZONE || DEFAULT_TIMEZONE): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(get("year"), get("month") - 1, get("day"));
}
