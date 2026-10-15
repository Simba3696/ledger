/** The current calendar day in `timeZone` (an IANA zone such as
 * "Asia/Kolkata"), as a local-midnight Date — the same "a Date standing for a
 * calendar day" convention dateMath.ts uses.
 *
 * Serverless functions run in UTC and AWS Lambda reserves `TZ`, so a bare
 * `new Date()` would report the previous day between 00:00 and 05:30 IST and
 * shift every due-date calculation by one (ADR-0005). Both arguments are
 * required so shared code never falls back to a zone it can't know: the
 * server passes its APP_TIMEZONE through `appToday()` (server/src/today.ts). */
export function todayInAppZone(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(get("year"), get("month") - 1, get("day"));
}
