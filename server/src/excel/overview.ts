import { listDebts } from "./debts.js";
import { listEmis, nextDueDateAfter } from "./emi.js";
import { listSubscriptions } from "./subscriptions.js";
import { getMonthBills, type CardBill } from "./creditCardBills.js";
import { financeSummary } from "./finances.js";
import { parseDate, formatDate, startOfDay } from "./dateMath.js";

/** Pure read-time aggregation across every other module — no workbook of its
 * own, no writes. Keeping this separate from the individual modules preserves
 * the write-path isolation each of them was deliberately built with (a bug
 * here can never touch another concern's sheet), while still giving the
 * Dashboard one place to ask "what does my overall picture look like?"
 * rather than stitching five separate fetches together on the client. */

const UPCOMING_WINDOW_DAYS = 14;

/** A card marked "Settled" is fully resolved — 0 outstanding, regardless of
 * its raw (due − paid) gap. Payment apps like CRED routinely round a bill by
 * a rupee or two, so a card the user has checked off shouldn't still read as
 * owed just because of that leftover gap. */
function cardOutstanding(card: CardBill): number {
  return card.settled ? 0 : card.due - card.paid;
}

export type UpcomingSource = "EMI" | "Subscription" | "Credit Card";

export interface UpcomingItem {
  source: UpcomingSource;
  name: string;
  /** What's still owed for this item — the full EMI/subscription amount, or
   * a credit card's outstanding (due − paid) portion. */
  amount: number;
  dueDate: string; // YYYY-MM-DD
}

export interface NetWorthBreakdown {
  /** Most recently entered Current Savings snapshot from Finances, carried
   * forward the same way that tab already does. */
  currentSavings: number;
  /** Sum of every Debts entry's signed amount — positive (you owe) reduces
   * net worth, negative (owed to you) adds to it, so this is subtracted as-is. */
  totalDebt: number;
  /** Sum of every active EMI's live remaining balance. */
  emiRemaining: number;
  /** This month's unpaid credit card total (due − paid, floored at 0). */
  creditCardOutstanding: number;
  netWorth: number;
}

export interface DashboardOverview {
  netWorth: NetWorthBreakdown;
  /** Sorted by due date, soonest first — EMI due dates and Subscription
   * renewals landing within the next two weeks, plus any credit card that
   * still has an outstanding balance and a due date in that window. */
  upcoming: UpcomingItem[];
}

function nextMonthOf(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

export async function dashboardOverview(today: Date = new Date()): Promise<DashboardOverview> {
  const day = startOfDay(today);
  const windowEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate() + UPCOMING_WINDOW_DAYS);
  const { year: nextYear, month: nextMonth } = nextMonthOf(day.getFullYear(), day.getMonth() + 1);

  const [debts, emis, subscriptions, financeRows, thisMonthBills, nextMonthBills] = await Promise.all([
    listDebts(),
    listEmis(today),
    listSubscriptions(today),
    financeSummary(day.getFullYear(), day.getMonth() + 1),
    getMonthBills(day.getFullYear(), day.getMonth() + 1),
    getMonthBills(nextYear, nextMonth),
  ]);

  // --- Net worth ---
  const currentSavings = financeRows[financeRows.length - 1]?.currentSavings ?? 0;
  const totalDebt = debts.reduce((sum, d) => sum + d.amount, 0);
  const emiRemaining = emis.reduce((sum, e) => sum + e.remaining, 0);
  const creditCardOutstanding = Math.max(
    0,
    thisMonthBills.cards.reduce((sum, c) => sum + cardOutstanding(c), 0),
  );
  const netWorth = currentSavings - totalDebt - emiRemaining - creditCardOutstanding;

  // --- Upcoming (next 14 days) ---
  const upcoming: UpcomingItem[] = [];

  // Some EMIs are actually installments on a credit card's own monthly bill
  // (converting a purchase to EMI bills it there, not separately) — their due
  // amount is already part of that card's own "Credit Card" upcoming entry,
  // so listing them again here would double it up. Determined dynamically
  // against whichever names actually appear in Credit Card Bills this month
  // or next, rather than a hardcoded card list, so a newly added card is
  // recognized automatically instead of silently falling through the cracks.
  const cardBilledNames = new Set(
    [...thisMonthBills.cards, ...nextMonthBills.cards].map((c) => c.name),
  );

  for (const emi of emis) {
    if (emi.isPaidOff || cardBilledNames.has(emi.cardOrBank)) continue;
    // Anchored to the EMI's own stored asOfDate, not "today" — a payment
    // just recorded via "Paid this month"/"Record payment" advances that
    // anchor to the due date it settled, so this correctly moves on to the
    // *next* cycle instead of recomputing the one just paid.
    const due = nextDueDateAfter(parseDate(emi.asOfDate), emi.dueDay);
    if (due <= windowEnd) {
      upcoming.push({ source: "EMI", name: emi.cardOrBank, amount: emi.emiAmount, dueDate: formatDate(due) });
    }
  }

  for (const sub of subscriptions) {
    const due = parseDate(sub.nextExpiry);
    if (due >= day && due <= windowEnd) {
      upcoming.push({ source: "Subscription", name: sub.service, amount: sub.amount, dueDate: sub.nextExpiry });
    }
  }

  for (const bills of [thisMonthBills, nextMonthBills]) {
    for (const card of bills.cards) {
      const outstanding = cardOutstanding(card);
      if (outstanding <= 0 || !card.dueDate) continue;
      const due = parseDate(card.dueDate);
      if (due >= day && due <= windowEnd) {
        upcoming.push({ source: "Credit Card", name: card.name, amount: outstanding, dueDate: card.dueDate });
      }
    }
  }

  upcoming.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return {
    netWorth: { currentSavings, totalDebt, emiRemaining, creditCardOutstanding, netWorth },
    upcoming,
  };
}
