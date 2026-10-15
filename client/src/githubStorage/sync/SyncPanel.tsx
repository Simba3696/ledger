import { useEffect, useId, useRef, useState } from "react";
import type { ActionPreview } from "../../backend/sync/noticeActions";
import { LeftBehindList } from "./LeftBehindList";
import { NoticeList, type PendingWork } from "./NoticeList";
import { nextFocus } from "./reviewFocus";
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
 * person, this device's own changes a restore left out (always shown,
 * D18), the status line with "N to review", and, when opened, the notices
 * and other devices' changes a restore left out. Non-modal: the ledger
 * stays usable, and nothing waits for an answer (owner decision D17).
 * The review list is always in the page while there is something to
 * review, `hidden` when closed, so the toggle's aria-controls names an
 * element; once an action removes its item, focus moves to the next item
 * (or the list) instead of falling back to the page. */
export function SyncPanel({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const sync = useSyncState();
  const [open, setOpen] = useState(initiallyOpen);
  const [work, setWork] = useState<PendingWork>({ busy: null, errors: {} });
  const [done, setDone] = useState<string | null>(null);
  const reviewId = useId();
  const root = useRef<HTMLDivElement>(null);
  /** An item an action removed, and the items in order when it ran. */
  const refocus = useRef<{ gone: string; order: string[] } | null>(null);

  /** The review items on the page, in order, with their keys. */
  const items = (): HTMLElement[] => [...(root.current?.querySelectorAll<HTMLElement>("[data-review-item]") ?? [])];

  // After each render: once the item an action removed is gone, focus the
  // next one still there, else the list it was in, else the panel.
  useEffect(() => {
    const pending = refocus.current;
    const panel = root.current;
    if (pending === null || panel === null) return;
    const present = items();
    const keys = present.map((el) => el.dataset.reviewItem ?? "");
    if (keys.includes(pending.gone)) return;
    refocus.current = null;
    const next = nextFocus(pending.order, pending.gone, keys);
    const target = next !== null ? present[keys.indexOf(next)] : (panel.querySelector<HTMLElement>("[data-review-list]:not([hidden])") ?? panel);
    target.focus();
  });

  /** Runs one action for `key`, one at a time, keeping its error by key. */
  const run = (key: string, task: () => Promise<string | null>) => {
    if (work.busy !== null) return;
    const order = items().map((el) => el.dataset.reviewItem ?? "");
    refocus.current = null;
    setWork({ busy: key, errors: { ...work.errors, [key]: "" } });
    task().then(
      (message) => {
        refocus.current = { gone: key, order };
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

  // This device's own changes a restore left out are its only copy (D18):
  // shown at once, above the status line, never behind the toggle
  // (section 9.3 step 5). Other devices' groups and the notices are.
  const own = sync.leftBehind.filter((g) => g.own);
  const others = sync.leftBehind.filter((g) => !g.own);
  const hasReview = sync.notices.length > 0 || others.length > 0;
  return (
    <div className="sync-panel" ref={root} tabIndex={-1}>
      <SyncMessages state={sync} />
      {own.length > 0 && (
        <div className="sync-review sync-review-own-groups" data-review-list tabIndex={-1}>
          <LeftBehindList groups={own} work={work} idPrefix={`${reviewId}-own`} onReapply={onReapply} onDiscard={onDiscard} />
        </div>
      )}
      <SyncStatus state={sync} reviewOpen={open && hasReview} reviewId={reviewId} onRetry={() => void sync.syncNow()} onToggleReview={() => setOpen(!open)} />
      {done && (
        <p className="sync-review-done" role="status">
          {done}
        </p>
      )}
      {hasReview && (
        <section id={reviewId} className="sync-review" aria-label="To review" hidden={!open} data-review-list tabIndex={-1}>
          <LeftBehindList groups={others} work={work} idPrefix={`${reviewId}-other`} onReapply={onReapply} onDiscard={onDiscard} />
          <NoticeList notices={sync.notices} work={work} idPrefix={`${reviewId}-notice`} onAction={onAction} onDismiss={onDismiss} />
        </section>
      )}
    </div>
  );
}
