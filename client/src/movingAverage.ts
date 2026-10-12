import { EARLIEST_YEAR } from "./constants";

/** The trailing windows the Dashboard's average line can use, in months. */
export const AVERAGE_WINDOWS = [3, 6, 12] as const;
export type AverageWindow = (typeof AVERAGE_WINDOWS)[number];

/** A month's value, or null when the month has no data to average: it hasn't
 * happened yet, or it falls in a year before any data was recorded. */
type MonthValue = number | null;

/**
 * Which of a year's 12 monthly totals count as data. Months after the current
 * one haven't happened, so they're null rather than zero; otherwise a 3-month
 * average in the current year would sink towards zero for the months ahead.
 * A year with nothing recorded at all is all null too: the server reports a
 * missing year as twelve zeros, which would drag January's average down for
 * someone in their first year rather than saying there's no earlier data.
 */
export function knownMonths(year: number, totals: number[], today = new Date()): MonthValue[] {
  if (year < EARLIEST_YEAR || totals.every((t) => t === 0)) return totals.map(() => null);
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  return totals.map((t, i) => {
    if (year > currentYear || (year === currentYear && i + 1 > currentMonth)) return null;
    return t;
  });
}

/**
 * For each month of the selected year, the mean of that month and the
 * `window - 1` months before it, reaching back into the previous year when the
 * window starts before January. A month gets null unless every month in its
 * window has data, so the line starts once there's a full window and never
 * runs on into months that haven't happened. Rounded to paise.
 */
export function trailingAverages(previousYear: MonthValue[], year: MonthValue[], window: number): MonthValue[] {
  const series = [...previousYear, ...year];
  return year.map((_, i) => {
    const end = previousYear.length + i;
    const start = end - window + 1;
    if (start < 0) return null;
    const slice = series.slice(start, end + 1);
    if (slice.some((v) => v === null)) return null;
    const sum = (slice as number[]).reduce((s, v) => s + v, 0);
    return Math.round((sum / window) * 100) / 100;
  });
}
