/** Where focus goes once an action has removed its item from the review
 * lists: the next item that is still there, in the order the lists showed
 * them when it ran, else the one before it, else none (the list itself
 * takes it). Without this, focus falls back to the page when the button
 * that had it disappears. */
export function nextFocus(order: readonly string[], gone: string, present: readonly string[]): string | null {
  const live = new Set(present);
  const at = order.indexOf(gone);
  if (at === -1) return present[0] ?? null;
  for (let i = at + 1; i < order.length; i++) if (live.has(order[i])) return order[i];
  for (let i = at - 1; i >= 0; i--) if (live.has(order[i])) return order[i];
  return null;
}
