import { useId, useState } from "react";
import type { ActionPreview } from "../../backend/sync/noticeActions";
import { LeftBehindList } from "./LeftBehindList";
import { NoticeList, type PendingWork } from "./NoticeList";
import { SyncMessages } from "./SyncMessages";
import { SyncStatus } from "./SyncStatus";
import { useSyncState } from "./syncContext";
import { reapplyText } from "./labels";
import "./sync.css";

/** GitHub mode's sync bar (design sections 4.2, 9.3 and 11), for #8 to
 * mount as SyncHost's `bar` (<SyncHost engine={e} bar={<SyncPanel />}>),
 * which keeps it mounted across remote joins, so the list stays open and
 * an action's result stays shown: as a child of SyncHost it would be
 * remounted on every remote change. It shows the messages that need the
 * person, the status line with "N to review", and, when opened, the
 * notices and the changes a restore left behind. Non-modal: the ledger
 * stays usable, and nothing waits for an answer (owner decision D17). */
export function SyncPanel({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const sync = useSyncState();
  const [open, setOpen] = useState(initiallyOpen);
  const [work, setWork] = useState<PendingWork>({ busy: null, errors: {} });
  const [done, setDone] = useState<string | null>(null);
  const reviewId = useId();

  /** Runs one action for `key`, one at a time, keeping its error by key. */
  const run = (key: string, task: () => Promise<string | null>) => {
    if (work.busy !== null) return;
    setWork({ busy: key, errors: { ...work.errors, [key]: "" } });
    task().then(
      (message) => {
        setWork((w) => ({ busy: null, errors: { ...w.errors, [key]: "" } }));
        setDone(message);
      },
      (err: unknown) => setWork((w) => ({ busy: null, errors: { ...w.errors, [key]: err instanceof Error ? err.message : String(err) } })),
    );
  };
  // The button's preview goes along: the action refuses if it would now write anything else.
  const onAction = (key: string, action: ActionPreview) => run(key, () => sync.noticeAction(key, action.kind, { writes: action.writes, ...(action.paid !== undefined ? { paid: action.paid } : {}) }).then(() => null));
  const onDismiss = (key: string) => run(key, () => sync.dismissNotice(key).then(() => null));
  const onReapply = (id: string) => run(id, () => sync.reapply(id).then(reapplyText));
  const onDiscard = (id: string) => run(id, () => sync.discard(id).then(() => null));

  const hasReview = sync.notices.length > 0 || sync.leftBehind.length > 0;
  return (
    <div className="sync-panel">
      <SyncMessages state={sync} />
      <SyncStatus state={sync} reviewOpen={open && hasReview} reviewId={reviewId} onRetry={() => void sync.syncNow()} onToggleReview={() => setOpen(!open)} />
      {done && (
        <p className="sync-review-done" role="status">
          {done}
        </p>
      )}
      {open && hasReview && (
        <section id={reviewId} className="sync-review" aria-label="To review">
          <LeftBehindList groups={sync.leftBehind} work={work} onReapply={onReapply} onDiscard={onDiscard} />
          <NoticeList notices={sync.notices} work={work} onAction={onAction} onDismiss={onDismiss} />
        </section>
      )}
    </div>
  );
}
