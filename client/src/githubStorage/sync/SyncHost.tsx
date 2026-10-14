import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { OTHER_TAB, type EngineState, type SyncEngine } from "../../backend/sync/SyncEngine";
import { RevisionHold, holdsView } from "./revisionHold";
import { SyncContext, type SyncStateValue } from "./syncContext";
import "./sync.css";

/** The words for each `unreadable` reason (design section 12). */
const UNREADABLE: Record<NonNullable<EngineState["unreadable"]>, string> = {
  loadFailed: "The changes saved on this device couldn't be read just now.",
  newer: "The changes saved on this device were saved by a newer version of Ledger. Reload to get it.",
  undecryptable: "The changes saved on this device can't be decrypted with this passphrase.",
  malformed: "The changes saved on this device can't be read.",
};

/** The sync layer of the GitHub tree (#7), between the gate (#8) and the
 * shared Ledger. It re-keys its children on the engine's integration
 * revision, so the open section reads again after someone else's changes
 * are joined (this device's own writes don't bump it), and tells the
 * engine, from a layout effect once the re-keyed tree has committed, which
 * revision is on screen: the stale-UI fence (section 3.4). While the person
 * is editing in the children, the revision on screen is held, so the
 * remount doesn't drop what they are typing (revisionHold.ts); the engine
 * is told only the held one, so what they save is fenced by it. It also gives
 * the sync state (syncContext.ts: the status, the notices and the changes
 * a restore left behind, with their actions) to `bar` and its children.
 * `bar` is where the sync UI (SyncPanel) goes: it is rendered outside the
 * re-keyed part, so a remote join doesn't remount it and it keeps what it
 * holds (the review list open, an action under way, its messages). */
export function SyncHost({ engine, bar, children }: { engine: SyncEngine; bar?: ReactNode; children?: ReactNode }) {
  const state = useSyncExternalStore(engine.subscribe, engine.getState, engine.getState);
  const { hasDocument, revision } = state;
  const container = useRef<HTMLDivElement>(null);
  const [held, onLeave] = useHeldRevision(revision, container);
  const shown = useRef(held);
  shown.current = held;
  // Rebuilt whenever the engine's state changes: notices() is the same
  // array until its revision moves, and leftBehind() follows the counts.
  const value = useMemo<SyncStateValue>(
    () => ({
      ...state,
      notices: engine.notices(),
      leftBehind: engine.leftBehind(),
      syncNow: () => engine.syncNow(),
      noticeAction: (key, kind, shown) => engine.noticeAction(key, kind, shown),
      dismissNotice: (key) => engine.dismissNotice(key),
      reapply: (id) => engine.reapply(id),
      discard: (id) => engine.discard(id),
    }),
    [engine, state],
  );

  // Attached while the ledger is on screen; until then (and in tests with
  // no view) the engine treats every revision as rendered.
  useLayoutEffect(() => (hasDocument ? engine.attachView(shown.current) : undefined), [engine, hasDocument]);
  useLayoutEffect(() => {
    if (hasDocument) engine.rendered(held);
  }, [engine, hasDocument, held]);

  if (state.status === "locked") {
    return (
      <p className="sync-message" role="alert">
        {OTHER_TAB}
      </p>
    );
  }
  if (state.unreadable !== null) {
    return (
      <div className="sync-message" role="alert">
        <p>{UNREADABLE[state.unreadable]} They are kept on this device as they are.</p>
        <button type="button" onClick={() => void engine.retry()}>
          Try again
        </button>
        <button type="button" onClick={() => void engine.startAsNewDevice()}>
          Start as a new device
        </button>
      </div>
    );
  }
  if (!hasDocument) return <p className="sync-message">Loading your ledger...</p>;
  return (
    <SyncLayers value={value} revision={held} bar={bar} container={container} onLeave={onLeave}>
      {children}
    </SyncLayers>
  );
}

/** The revision to show: `revision`, held while the person edits inside
 * `container` (revisionHold.ts). Also returns what the container calls when
 * focus leaves something inside it. The newest revision is offered from a
 * layout effect, so one shown at once is on screen before the next paint. */
function useHeldRevision(revision: number, container: RefObject<HTMLElement | null>): [number, () => void] {
  const [held, setHeld] = useState(revision);
  const [hold] = useState(() => new RevisionHold(revision, () => holdsView(container.current, document.activeElement), setHeld));
  useLayoutEffect(() => hold.offer(revision), [hold, revision]);
  useEffect(() => () => hold.dispose(), [hold]);
  return [held, () => hold.focusLeft()];
}

/** What SyncHost renders once there is a document: the context above
 * everything, `bar` first and outside the re-keyed part, and `children`
 * keyed on `revision` (the one on screen) inside `container`, which is not
 * keyed, so the hold can watch focus across a remount. React keeps an
 * element's state while the type and key at each level above it stay the
 * same, so a new revision remounts the children and leaves `bar` mounted. */
export function SyncLayers({
  value,
  revision,
  bar,
  container,
  onLeave,
  children,
}: {
  value: SyncStateValue;
  revision: number;
  bar?: ReactNode;
  container?: RefObject<HTMLDivElement | null>;
  onLeave?: () => void;
  children?: ReactNode;
}) {
  return (
    <SyncContext.Provider value={value}>
      {bar}
      <div className="sync-ledger" ref={container} onBlur={onLeave}>
        <Fragment key={revision}>{children}</Fragment>
      </div>
    </SyncContext.Provider>
  );
}
