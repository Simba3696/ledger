import { sameValue } from "./canonical";
import { vectorOf } from "./codec";
import type { OpBody } from "./diff";
import { CREATE, STAMP, TOGETHER, parseRegisterKey } from "./keys";
import { joinInto, type Changes, type Register, type SyncState } from "./state";
import type { Tag, VersionVector } from "./tags";

// The stale-UI fence (design section 3.4). A form submits every field, and
// applyChanges writes the ones that differ from current(). current() already
// holds every joined remote change, but the screen may not show it yet: an
// untouched field would then set a remote change back. So:
//
//   - The integration revision goes up on every join that changed the
//     document. SyncHost re-keys its children on it and, once the re-keyed
//     tree has committed, calls rendered(revision).
//   - For each register a join replaces, the fence keeps the value it
//     replaced (its pre-image), the oldest one since the last render.
//   - At diff time, a register in the op whose pre-image is unrendered and
//     equals the op's value was not touched by the user: it is dropped, and
//     the remote value stands. One whose op value differs is applied. Both
//     cases make a notice.
//   - The op's vv is the seen vector as of the rendered revision, so a
//     remote author whose change this user hadn't seen still gets their
//     edit/edit notice (section 4.2).
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

export class Fence {
  #revision = 0;
  /** The revision the view last rendered; null when no view is attached. */
  #rendered: number | null = null;
  /** Register key to the value an unrendered join replaced. */
  readonly #pre = new Map<string, PreImage>();
  /** The seen vector at each revision since the rendered one. */
  readonly #seenAt = new Map<number, VersionVector>();

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
    for (const [key, pre] of this.#pre) if (pre.rev <= upTo) this.#pre.delete(key);
    for (const r of this.#seenAt.keys()) if (r < upTo) this.#seenAt.delete(r);
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

  #keep(key: string, value: unknown): void {
    if (!this.#pre.has(key)) this.#pre.set(key, { value, rev: this.#revision });
  }

  /** The seen vector as of the rendered revision: the op's vv (section 3.1).
   * `seen` is the state's seen vector now. */
  renderedSeen(seen: ReadonlyMap<string, number>): VersionVector {
    if (this.#rendered === null) return vectorOf(seen);
    return this.#seenAt.get(this.#rendered) ?? vectorOf(seen);
  }

  /** The op `body` (diffed against the document `state` materialises to)
   * with every untouched unrendered register dropped, and the notices
   * section 3.4 gives. A body left with nothing, or with only stamps, is
   * null. */
  apply(body: OpBody, state: SyncState): { body: OpBody | null; notices: FenceNotice[] } {
    if (this.#pre.size === 0) return { body, notices: [] };
    const unseen = (key: string) => {
      const pre = this.#pre.get(key);
      return pre !== undefined && pre.rev > this.renderedRevision ? pre : undefined;
    };
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
        const theirs = registerOf(state, k);
        // Typing the very value the remote wrote replaced nothing.
        if (!theirs || (!untouched && sameValue(theirs.v, values.get(k)))) continue;
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

  /** This device committed an op setting `keys`: its own write supersedes
   * what the user hadn't seen there. */
  wrote(keys: readonly string[]): void {
    for (const key of keys) this.#pre.delete(key);
  }
}
