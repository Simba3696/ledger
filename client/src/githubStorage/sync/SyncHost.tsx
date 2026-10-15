import { Fragment, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { LedgerDocument } from "../../backend/document/types";
import { OTHER_TAB, type EngineState, type SyncEngine } from "../../backend/sync/SyncEngine";
import { DraftKeeper } from "./DraftKeeper";
import { SyncContext, type SyncStateValue } from "./syncContext";

/** The words for each `unreadable` reason (design section 12). */
const UNREADABLE: Record<NonNullable<EngineState["unreadable"]>, string> = {
  loadFailed: "The changes saved on this device couldn't be read just now.",
  newer: "The changes saved on this device were saved by a newer version of Ledger. Reload to get it.",
  undecryptable: "The changes saved on this device can't be decrypted with this passphrase.",
  malformed: "The changes saved on this device can't be read.",
  keyChanged: "The changes saved on this device are sealed with the household passphrase this device joined with. Enter it to open them.",
};

/** The document the engine holds now, or null while it has none. */
function documentOf(engine: SyncEngine): LedgerDocument | null {
  try {
    return engine.current();
  } catch {
    return null;
  }
}

/** The sync layer of the GitHub tree (#7), between the gate (#8) and the
 * shared Ledger. It re-keys its children on the engine's integration
 * revision, so the open section reads again after someone else's changes
 * are joined (this device's own writes don't bump it), and tells the
 * engine, from a layout effect once the re-keyed tree has committed, which
 * revision is on screen: the stale-UI fence (section 3.4). A sync-bar
 * action (Re-apply, Discard, a notice's action) is an own write too, but
 * made through the engine, not by the open section, which would otherwise
 * go on showing the ledger as it was: once one has changed the document,
 * SyncHost re-keys its children again at the same revision (`refresh`,
 * #16), so the section reads current() again, as after its own save. The
 * engine is still told only the revision: the fence tracks joins, and a
 * re-read at the same revision shows nothing a join brought that isn't
 * already counted as on screen, only this device's own writes, as a
 * section's re-read after its own save does. It also gives
 * the sync state (syncContext.ts: the status, the notices and the changes
 * a restore left behind, with their actions) to `bar` and its children.
 * `bar` is where the sync UI (SyncPanel) goes: it is rendered outside the
 * re-keyed part, so a remote join doesn't remount it and it keeps what it
 * holds (the review list open, an action under way, its messages). */
export function SyncHost({ engine, bar, children }: { engine: SyncEngine; bar?: ReactNode; children?: ReactNode }) {
  const state = useSyncExternalStore(engine.subscribe, engine.getState, engine.getState);
  const { hasDocument, revision } = state;
  const shown = useRef(revision);
  shown.current = revision;
  const [refresh, setRefresh] = useState(0);
  // Rebuilt whenever the engine's state changes: notices() is the same
  // array until its revision moves, and leftBehind() follows the counts.
  const value = useMemo<SyncStateValue>(() => {
    /** Runs a sync-bar write and, once it has changed the document, re-keys
     * the ledger at the same revision (#16). The engine's document is a new
     * object only then: a Discard, or a Re-apply with every item skipped,
     * writes only the group's marker; a notice action the fence dropped
     * whole, or a refused one, writes nothing to the document. */
    const rereading = <T,>(write: () => Promise<T>): Promise<T> => {
      const before = documentOf(engine);
      return write().then((result) => {
        if (documentOf(engine) !== before) setRefresh((n) => n + 1);
        return result;
      });
    };
    return {
      ...state,
      notices: engine.notices(),
      leftBehind: engine.leftBehind(),
      syncNow: () => engine.syncNow(),
      noticeAction: (key, kind, shown) => rereading(() => engine.noticeAction(key, kind, shown)),
      dismissNotice: (key) => engine.dismissNotice(key),
      reapply: (id) => rereading(() => engine.reapply(id)),
      discard: (id) => rereading(() => engine.discard(id)),
    };
  }, [engine, state]);

  // Attached while the ledger is on screen; until then (and in tests with
  // no view) the engine treats every revision as rendered.
  useLayoutEffect(() => (hasDocument ? engine.attachView(shown.current) : undefined), [engine, hasDocument]);
  useLayoutEffect(() => {
    if (hasDocument) engine.rendered(revision);
  }, [engine, hasDocument, revision]);

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
        {/* A device sealed under the key it joined with (D32) needs only the
            passphrase, which the gate asks for: a new start would park
            everything on it. */}
        {state.unreadable !== "keyChanged" && (
          <button type="button" onClick={() => void engine.startAsNewDevice()}>
            Start as a new device
          </button>
        )}
      </div>
    );
  }
  if (!hasDocument) return <p className="sync-message">Loading your ledger...</p>;
  return (
    <SyncLayers value={value} revision={revision} refresh={refresh} bar={bar}>
      {children}
    </SyncLayers>
  );
}

/** What SyncHost renders once there is a document: the context above
 * everything, `bar` first and outside the re-keyed part, and `children`
 * keyed on `revision` and `refresh` (a sync-bar write's re-read, #16).
 * React keeps an element's state while the type and key at each level
 * above it stay the same, so a new key remounts the children and leaves
 * `bar` mounted. The DraftKeeper around the keyed part stays mounted too,
 * and puts back what the person was typing once the children have
 * remounted (#13, drafts.ts). */
export function SyncLayers({ value, revision, refresh = 0, bar, children }: { value: SyncStateValue; revision: number; refresh?: number; bar?: ReactNode; children?: ReactNode }) {
  const tree = `${revision}.${refresh}`;
  return (
    <SyncContext.Provider value={value}>
      {bar}
      <DraftKeeper tree={tree}>
        <Fragment key={tree}>{children}</Fragment>
      </DraftKeeper>
    </SyncContext.Provider>
  );
}
