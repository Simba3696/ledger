import { todayInAppZone } from "@ledger/shared/today";

/** The zone "today" is reckoned in when APP_TIMEZONE is unset (LLD §9). */
export const DEFAULT_TIMEZONE = "Asia/Kolkata";

/** The current calendar day in APP_TIMEZONE (falling back to
 * DEFAULT_TIMEZONE), as a local-midnight Date. The shared
 * `todayInAppZone` takes the zone explicitly so it stays browser-safe; this
 * is the server's one place that knows which zone to pass (ADR-0005). */
export function appToday(now: Date = new Date()): Date {
  return todayInAppZone(now, process.env.APP_TIMEZONE || DEFAULT_TIMEZONE);
}
