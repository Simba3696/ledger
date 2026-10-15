import { sameValue } from "./canonical";
import { CREATE, FIELDS, STAMP, TOGETHER, type Coll } from "./keys";
import type { Op, Register, SyncState } from "./state";
import { compareTags } from "./tags";

// Rehome's re-issue (design section 10.3 step 4, as ADR-0008 amends it).
// After a fork, the device rebuilds its state from the epoch's files, which
// hold the other instance's ops under the old id D, and re-issues under its
// new id D' every register and deletion of its pre-rehome state that is
// tagged (L, D) and not in the rebuilt state with the same tag and value,
// keeping each original L: one op per L. Rehome is never refused, so each
// op must be one the validator accepts, which per-register re-issue is not:
//
//   - An op that re-issues a record's `_c` sets every field and `_s` of it
//     too (a create is whole). A field whose own tag is later or foreign
//     gets its current value, which its own tag still decides on join.
//   - A TOGETHER group (an EMI's balance pair) is re-issued whole when
//     either of its registers is.
//
// Re-apply markers (ra, section 9.4) and add-back markers (ab, section 4.1)
// carry no tag, so the walk above never sees them. Every marker of the
// pre-rehome state that the rebuilt state lacks is re-issued too, on the
// last re-issued op, or alone on an op at the device's greatest own L when
// nothing else is. A marker is a grow-only set member, so re-issuing one
// held elsewhere changes nothing.

/** One re-issued op's content at its original L, before the engine adds
 * `at`, `by` and `vv`. */
export type Reissue = Pick<Op, "L" | "set" | "del" | "ra" | "ab">;

function kept(reg: Register, rebuilt: Register | undefined): boolean {
  return rebuilt !== undefined && compareTags(reg.t, rebuilt.t) === 0 && sameValue(reg.v, rebuilt.v);
}

/** The ops device `device`'s rehome re-issues: what `pre`, its state before
 * the rehome, holds under `device` that `rebuilt` lacks, as one op per
 * original L in ascending L, and the re-apply markers `rebuilt` lacks. */
export function rehomeReissue(pre: SyncState, rebuilt: SyncState, device: string): Reissue[] {
  const byL = new Map<number, { set: Map<string, unknown>; del: string[] }>();
  const at = (L: number) => {
    let op = byL.get(L);
    if (!op) byL.set(L, (op = { set: new Map(), del: [] }));
    return op;
  };
  const own = (reg: Register) => reg.t[1] === device;

  for (const [key, regs] of pre.rec) {
    const coll = key.slice(0, key.indexOf("/")) as Coll;
    const theirs = rebuilt.rec.get(key);
    const fields = new Set([...regs].filter(([field, reg]) => own(reg) && !kept(reg, theirs?.get(field))).map(([field]) => field));
    for (const group of TOGETHER[coll]) {
      if (group.some((field) => fields.has(field))) for (const field of group) if (regs.get(field) && own(regs.get(field)!)) fields.add(field);
    }
    for (const field of fields) {
      const reg = regs.get(field)!;
      at(reg.t[0]).set.set(`${key}/${field}`, reg.v);
    }
    // A re-issued create sets the whole record at its L.
    const create = fields.has(CREATE) ? regs.get(CREATE)! : undefined;
    if (create) {
      const op = at(create.t[0]);
      for (const field of [...FIELDS[coll], STAMP]) {
        const reg = regs.get(field);
        if (reg && !op.set.has(`${key}/${field}`)) op.set.set(`${key}/${field}`, reg.v);
      }
    }
  }
  for (const [key, reg] of pre.unit) {
    if (own(reg) && !kept(reg, rebuilt.unit.get(key))) at(reg.t[0]).set.set(key, reg.v);
  }
  for (const [key, deletion] of pre.del) {
    if (deletion.by !== device) continue;
    const theirs = rebuilt.del.get(key);
    if (!theirs || theirs.by !== deletion.by || theirs.L !== deletion.L) at(deletion.L).del.push(key);
  }

  const markers = [...pre.ra].filter((marker) => !rebuilt.ra.has(marker)).sort();
  const addedBack = [...pre.ab].filter((marker) => !rebuilt.ab.has(marker)).sort();
  if ((markers.length > 0 || addedBack.length > 0) && byL.size === 0) at(Math.max(1, pre.seen.get(device) ?? pre.maxL));
  // A loop, not Math.max(...keys): a spread of one argument per re-issued L
  // overflows the stack past about 120k of them, and rehome is never refused.
  let last = 0;
  for (const L of byL.keys()) if (L > last) last = L;

  return [...byL]
    .sort(([a], [b]) => a - b)
    .map(([L, op]) => ({
      L,
      set: [...op.set].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      del: op.del.sort(),
      ...(L === last && markers.length > 0 ? { ra: markers } : {}),
      ...(L === last && addedBack.length > 0 ? { ab: addedBack } : {}),
    }));
}
