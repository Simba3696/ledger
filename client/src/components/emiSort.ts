import type { EmiEntryComputed } from "../api";

export type SortField = "name" | "dueDay" | "emiAmount" | "totalAmount" | "remaining" | "monthsLeft" | "percentPaid";
export type SortDir = "asc" | "desc";

// Foreclosure hint: % of the loan already paid off — sorting by this (rather
// than the raw remaining amount) surfaces the best "quick win" candidate,
// since a loan that started small can have a low remaining balance without
// being anywhere near paid off, and vice versa.
function percentPaid(emi: EmiEntryComputed): number {
  return emi.totalAmount > 0 ? (emi.totalAmount - emi.remaining) / emi.totalAmount : 0;
}

// Months Left sorts by the same payoff date the row's "Finishes ~" label
// shows, so the order always agrees with what's on screen. YYYY-MM-DD sorts
// lexicographically the same as chronologically; a paid-off loan (no payoff
// date) has nothing left, so it sorts as the soonest.
function payoffSortKey(emi: EmiEntryComputed): string {
  return emi.estimatedPayoffDate ?? "";
}

/** The EMI tab's list order. Stable, so EMIs that tie (e.g. one card's EMIs
 * under Name) keep the order they were added in. */
export function sortEmis(emis: EmiEntryComputed[], field: SortField, dir: SortDir): EmiEntryComputed[] {
  return [...emis].sort((a, b) => {
    let cmp = 0;
    if (field === "name") cmp = a.cardOrBank.localeCompare(b.cardOrBank);
    else if (field === "dueDay") cmp = a.dueDay - b.dueDay;
    else if (field === "emiAmount") cmp = a.emiAmount - b.emiAmount;
    else if (field === "totalAmount") cmp = a.totalAmount - b.totalAmount;
    else if (field === "remaining") cmp = a.remaining - b.remaining;
    else if (field === "monthsLeft") cmp = payoffSortKey(a).localeCompare(payoffSortKey(b));
    else cmp = percentPaid(a) - percentPaid(b);
    return dir === "asc" ? cmp : -cmp;
  });
}
