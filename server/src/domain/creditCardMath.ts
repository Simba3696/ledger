// Pure per-month credit card bill summary (no I/O), moved verbatim from the
// Excel edition's excel/creditCardBills.ts (LLD §3). No "today" is involved.

export interface CardBill {
  name: string;
  /** Amount due for this card's bill this month. */
  due: number;
  /** Amount actually paid. */
  paid: number;
  /** This card's own due date this month, YYYY-MM-DD, or null if not entered. */
  dueDate: string | null;
  /** Marked true once this bill is paid off, even if a payment app's rounding
   * left a rupee or two of (due − paid) gap that isn't real debt. A settled
   * card contributes 0 to Net Worth's credit card outstanding and is excluded
   * from the Dashboard's Upcoming list, regardless of its raw due/paid gap. */
  settled: boolean;
}

export interface MonthBills {
  year: number;
  month: number;
  cards: CardBill[];
}

export interface MonthBillsSummary extends MonthBills {
  totalDue: number;
  totalPaid: number;
  /** Earliest of each card's own due date this month, or null if none entered. */
  earliestDueDate: string | null;
  /** Sum of (due - paid) across only *settled* cards, matching the sign
   * convention already used by hand: negative = overpaid (paid more than
   * due), positive = saved a little (paid less, e.g. a bill-payment app
   * rounding down). An unsettled card's raw gap is just an in-progress bill,
   * not a real result yet — same reasoning as `cardOutstanding` in
   * overview.ts, which likewise ignores a settled card's gap (there, in the
   * opposite direction: a settled card contributes 0 outstanding regardless
   * of its gap; here, an *unsettled* card contributes 0 to this stat
   * regardless of its gap). Total Due/Total Paid below are unaffected by
   * this — they still sum every card, settled or not. */
  overpaidOrSaved: number;
}

export function summarize(month: MonthBills): MonthBillsSummary {
  const totalDue = month.cards.reduce((sum, c) => sum + c.due, 0);
  const totalPaid = month.cards.reduce((sum, c) => sum + c.paid, 0);
  const dueDates = month.cards.map((c) => c.dueDate).filter((d): d is string => d !== null);
  const earliestDueDate = dueDates.length > 0 ? dueDates.reduce((a, b) => (a < b ? a : b)) : null;
  const overpaidOrSaved = month.cards.reduce((sum, c) => sum + (c.settled ? c.due - c.paid : 0), 0);
  return { ...month, totalDue, totalPaid, earliestDueDate, overpaidOrSaved };
}
