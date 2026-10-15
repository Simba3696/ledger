import { sameValue } from "./canonical";
import { vectorOf } from "./codec";
import type { OpBody } from "./diff";
import { CREATE, STAMP, TOGETHER, parseRegisterKey } from "./keys";
import { joinInto, type Changes, type Op, type Register, type SyncState } from "./state";
import { GENESIS_TAG, type Tag, type VersionVector } from "./tags";

// The stale-UI fence (design section 3.4). A form submits every field, and
// applyChanges writes the ones that differ from current(). current() already
// holds every joined remote change, but the screen may not show it yet: an
// untouched field would then set a remote change back. So:
//
//   - The integration revision goes up on every join that changed the
//     document. SyncHost re-keys its children on it and, once the re-keyed
//     tree has committed, calls rendered(revision).
//   - For each register a join replaces, the fence keeps the value it
//     replaced (its pre-image), one per revision that changed it.
//   - A write is fenced by the revision the view had rendered when it was
//     submitted (pin()), not when its diff runs: DocumentBackend queues a
//     write behind the ones before it, and the view may render a join in
//     between, after the form's values were taken. So the pre-images and
//     seen vectors a pinned write needs are kept until it is released.
//   - At diff time, take each register in the op with a pre-image newer
//     than the write's revision. If the earliest such pre-image (what the
//     user saw) equals the op's value, the user didn't touch it: it is
//     dropped, and the remote value stands. One whose op value differs is
//     applied. Both cases make a notice, a register an epoch switch removed
//     included: its value is then the restore's, told under the genesis tag.
//   - The op's vv is the seen vector as of the write's revision, so a
//     remote author whose change this user hadn't seen still gets their
//     edit/edit notice (section 4.2).
//   - Once an own op commits, a register it now holds shows the user's own
//     value, so its pre-images go (wrote()). A register where a remote
//     write it hadn't seen beat it keeps them: that write is still unseen.
//
// Without an attached view (engine and unit tests) everything is rendered
// at once: no pre-images are kept, and the op passes unchanged. A delete or
// update aimed at a record whose deletion was joined but not rendered needs
// no pre-image: DocumentBackend runs against current(), which no longer has
// the record, so it answers 404 and no op is made.

/** A remote write the user hadn't seen when they saved. "kept": their save
 * left it as it was and the remote value stands; "replaced": they typed a
 * new value over it. */
export interface FenceNotice {
  kind: "kept" | "replaced";
  /** The tag of the remote write. */
  theirs: Tag;
  registers: { key: string; theirs: unknown; mine: unknown }[];
}

interface PreImage {
  value: unknown;
  rev: number;
}

/** A register's value as the document reads it: an absent month lock is
 * unlocked, an absent month's finances or bills are none. */
function readValue(key: string, reg: Register | undefined): unknown {
  if (reg) return reg.v;
  if (key.startsWith("lk/")) return false;
  if (key.startsWith("fm/") || key.startsWith("cb/")) return null;
  return undefined;
}

/** The register `key` names in `state`. */
function registerOf(state: SyncState, key: string): Register | undefined {
  const parsed = parseRegisterKey(key);
  if (parsed?.kind !== "field") return state.unit.get(key);
  return state.rec.get(`${parsed.coll}/${parsed.id}`)?.get(parsed.field);
}

/** The keys that are set together with `key` in one op (its TOGETHER group,
 * or just itself). */
function groupOf(key: string): string[] {
  const parsed = parseRegisterKey(key);
  if (parsed?.kind !== "field") return [key];
  const group = TOGETHER[parsed.coll].find((fields) => fields.includes(parsed.field));
  return group ? group.map((field) => `${parsed.coll}/${parsed.id}/${field}`) : [key];
}

function recordOf(key: string): string | null {
  const parsed = parseRegisterKey(key);
  return parsed?.kind === "field" ? `${parsed.coll}/${parsed.id}` : null;
}

/** A write's view of the document: the revision rendered when it was
 * submitted. Released once the write has settled. */
export interface FencePin {
  readonly asOf: number;
  release(): void;
}

export class Fence {
  #revision = 0;
  /** The revision the view last rendered; null when no view is attached. */
  #rendered: number | null = null;
  /** Register key to the values joins replaced, ascending by revision: one
   * per revision, each the value just before that revision's join. Kept
   * from the oldest revision a write may still be fenced by. */
  readonly #pre = new Map<string, PreImage[]>();
  /** The seen vector at each revision from that oldest one. */
  readonly #seenAt = new Map<number, VersionVector>();
  /** The writes submitted and not yet settled. */
  readonly #pins = new Set<{ asOf: number }>();

  /** The integration revision: SyncHost's key for its children. */
  get revision(): number {
    return this.#revision;
  }

  /** The revision the attached view has rendered, or the current one when
   * none is attached. */
  get renderedRevision(): number {
    return this.#rendered ?? this.#revision;
  }

  /** Attaches the view, which has rendered `rev`, with `seen` the state's
   * seen vector now. Returns the detach function. */
  attach(rev: number, seen: VersionVector): () => void {
    this.#rendered = Math.min(rev, this.#revision);
    this.#seenAt.clear();
    this.#seenAt.set(this.#revision, seen);
    this.#pre.clear();
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.#rendered = null;
      this.#pre.clear();
      this.#seenAt.clear();
    };
  }

  /** The view has committed a tree keyed on `rev`. */
  rendered(rev: number): void {
    if (this.#rendered === null) return;
    const upTo = Math.min(rev, this.#revision);
    if (upTo <= this.#rendered) return;
    this.#rendered = upTo;
    this.#prune();
  }

  /** A write is being submitted: it is fenced by what is rendered now
   * (section 3.4), however long it waits to be diffed. */
  pin(): FencePin {
    const pin = { asOf: this.renderedRevision };
    this.#pins.add(pin);
    return {
      asOf: pin.asOf,
      release: () => {
        if (this.#pins.delete(pin)) this.#prune();
      },
    };
  }

  /** Drops what no write can be fenced by any more: everything up to the
   * rendered revision, or up to the oldest pinned write's if that is older. */
  #prune(): void {
    if (this.#rendered === null) return;
    let floor = this.#rendered;
    for (const pin of this.#pins) floor = Math.min(floor, pin.asOf);
    for (const [key, list] of this.#pre) {
      const kept = list.filter((pre) => pre.rev > floor);
      if (kept.length === 0) this.#pre.delete(key);
      else if (kept.length < list.length) this.#pre.set(key, kept);
    }
    for (const r of this.#seenAt.keys()) if (r < floor) this.#seenAt.delete(r);
  }

  /** Joins `source` into `live` in place, bumping the revision if the
   * document changed and keeping the pre-image of every visible register
   * the join replaced with another value. */
  join(live: SyncState, source: SyncState): Changes {
    const watching = this.#rendered !== null;
    const records = new Map<string, Map<string, Register>>();
    const units = new Map<string, Register | undefined>();
    if (watching) {
      for (const key of source.rec.keys()) {
        const regs = live.rec.get(key);
        // Only a visible record's fields can be on screen.
        if (regs?.has(CREATE) && !live.del.has(key)) records.set(key, new Map(regs));
      }
      for (const key of source.unit.keys()) units.set(key, live.unit.get(key));
    }
    const changes = joinInto(live, source);
    if (changes.units.size > 0) this.#revision++;
    if (!watching) return changes;
    this.#seenAt.set(this.#revision, vectorOf(live.seen));
    if (changes.units.size === 0) return changes;
    for (const [key, before] of records) {
      const after = live.rec.get(key)!;
      for (const [field, reg] of before) {
        const now = after.get(field)!;
        if (now !== reg && !sameValue(now.v, reg.v)) this.#keep(`${key}/${field}`, reg.v);
      }
    }
    for (const [key, before] of units) {
      const now = live.unit.get(key);
      if (now !== before && !sameValue(readValue(key, now), readValue(key, before))) this.#keep(key, readValue(key, before));
    }
    return changes;
  }

  /** The state was replaced by `after` whole, not joined (a rehome, section
   * 10.3: registers this device wrote may now carry another tag, and the
   * other instance's values may win). `changed` says whether the document
   * changed. Like a join that changed it, this bumps the revision and keeps
   * the pre-image of every visible register whose value it changed, so a
   * form that was on screen before is fenced against what the rehome did. */
  replace(before: SyncState, after: SyncState, changed: boolean): void {
    if (!changed) return;
    this.#revision++;
    if (this.#rendered === null) return;
    this.#seenAt.set(this.#revision, vectorOf(after.seen));
    for (const [key, regs] of before.rec) {
      if (!regs.has(CREATE) || before.del.has(key)) continue;
      const now = after.rec.get(key);
      for (const [field, reg] of regs) {
        const next = now?.get(field);
        if (!next || !sameValue(next.v, reg.v)) this.#keep(`${key}/${field}`, reg.v);
      }
    }
    for (const key of new Set([...before.unit.keys(), ...after.unit.keys()])) {
      const was = readValue(key, before.unit.get(key));
      if (!sameValue(readValue(key, after.unit.get(key)), was)) this.#keep(key, was);
    }
  }

  /** The state was replaced by a new epoch's (a restore, section 9.3), as
   * replace() does for a rehome. A write submitted before the switch had
   * seen nothing of the new epoch, so its vv is empty: never the old
   * epoch's device ids, which name no one in this one. */
  switchEpoch(before: SyncState, after: SyncState, changed: boolean): void {
    this.replace(before, after, changed);
    for (const r of [...this.#seenAt.keys()]) this.#seenAt.set(r, {});
  }

  #keep(key: string, value: unknown): void {
    const list = this.#pre.get(key);
    if (!list) this.#pre.set(key, [{ value, rev: this.#revision }]);
    else if (list.at(-1)!.rev !== this.#revision) list.push({ value, rev: this.#revision });
  }

  /** The seen vector as of revision `asOf` (by default the rendered one):
   * the op's vv (section 3.1). `seen` is the state's seen vector now. */
  renderedSeen(seen: ReadonlyMap<string, number>, asOf = this.renderedRevision): VersionVector {
    if (this.#rendered === null) return vectorOf(seen);
    return this.#seenAt.get(asOf) ?? vectorOf(seen);
  }

  /** The op `body` (diffed against the document `state` materialises to)
   * with every register untouched since revision `asOf` (by default the
   * rendered one) dropped, and the notices section 3.4 gives. A body left
   * with nothing, or with only stamps, is null. */
  apply(body: OpBody, state: SyncState, asOf = this.renderedRevision): { body: OpBody | null; notices: FenceNotice[] } {
    if (this.#pre.size === 0) return { body, notices: [] };
    /** What the first join after `asOf` replaced, if one did. */
    const unseen = (key: string) => this.#pre.get(key)?.find((pre) => pre.rev > asOf);
    const values = new Map(body.set);
    const creating = new Set(body.set.filter(([key]) => key.endsWith(`/${CREATE}`)).map(([key]) => recordOf(key)));
    const drop = new Set<string>();
    const notices = new Map<string, FenceNotice>();
    const handled = new Set<string>();

    for (const [key] of body.set) {
      if (handled.has(key)) continue;
      const group = groupOf(key);
      for (const k of group) handled.add(k);
      const record = recordOf(key);
      // A create sets a record the user is making now, and a stamp is not
      // content (it goes with whatever else the record keeps, below).
      if ((record !== null && creating.has(record)) || key.endsWith(`/${STAMP}`)) continue;
      const fenced = group.filter((k) => unseen(k) !== undefined);
      if (fenced.length === 0) continue;
      // What the user saw: the pre-image where a join replaced it unseen,
      // otherwise the value in the document now.
      const saw = (k: string) => {
        const pre = unseen(k);
        return pre ? pre.value : readValue(k, registerOf(state, k));
      };
      const untouched = group.every((k) => sameValue(values.get(k), saw(k)));
      for (const k of fenced) {
        // A register an epoch switch removed (a month lock, finances or card
        // bills the restored genesis lacks) reads as the document reads it,
        // and is the genesis's: what stands is the restore's (stage 8a, E2).
        const theirs = registerOf(state, k) ?? { v: readValue(k, undefined), t: GENESIS_TAG };
        // Typing the very value the remote wrote replaced nothing.
        if (!untouched && sameValue(theirs.v, values.get(k))) continue;
        const kind = untouched ? "kept" : "replaced";
        const id = `${kind} ${theirs.t[0]} ${theirs.t[1]}`;
        let notice = notices.get(id);
        if (!notice) notices.set(id, (notice = { kind, theirs: theirs.t, registers: [] }));
        notice.registers.push({ key: k, theirs: theirs.v, mine: values.get(k) });
      }
      if (untouched) for (const k of group) drop.add(k);
    }

    let set = body.set.filter(([key]) => !drop.has(key));
    // A record left with only its stamp has nothing to say.
    const content = new Set(set.filter(([key]) => !key.endsWith(`/${STAMP}`)).map(([key]) => recordOf(key)));
    set = set.filter(([key]) => !key.endsWith(`/${STAMP}`) || content.has(recordOf(key)));
    const kept = set.length === 0 && body.del.length === 0 ? null : { set, del: body.del };
    return { body: kept, notices: [...notices.values()] };
  }

  /** This device committed `op` (as device `me`), already joined into
   * `state`. Where the op's register now stands, the user's own write
   * superseded what they hadn't seen there, so its pre-images go. Where a
   * remote write it never saw beat it (a later tag), that write is still
   * unseen, and a stale form must still be fenced against it. */
  wrote(state: SyncState, me: string, op: Pick<Op, "L" | "set">): void {
    for (const [key, value] of op.set) {
      const reg = registerOf(state, key);
      if (reg && reg.t[0] === op.L && reg.t[1] === me && sameValue(reg.v, value)) this.#pre.delete(key);
    }
  }
}
