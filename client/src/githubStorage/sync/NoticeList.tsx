import type { ActionPreview, NoticeView } from "../../backend/sync/noticeActions";
import { actionLabel, noticeText, refusalText } from "./labels";

/** Per notice key: an action under way, or why the last one failed. */
export interface PendingWork {
  busy: string | null;
  errors: Record<string, string>;
}

/** The notices to review (design section 4.2), the old ConflictDialog
 * reworked as a non-modal list: each says whose write won and what was
 * replaced, and offers its actions (section 4.1), each button naming the
 * exact values it writes, and Dismiss. A button that can't run now is
 * disabled with the reason beside it. Edit/delete keeps its own words
 * (the old B9 split labels): "Add it back as a new entry", never "Keep".
 * Each button is described by its notice's sentence (and its reason, when
 * refused), so a screen reader says what it acts on; `idPrefix` keeps the
 * ids unique on the page (SyncPanel's useId). Each item carries its key
 * (data-review-item) and takes focus when the one before it goes. */
export function NoticeList({ notices, work, idPrefix = "sync-notice", onAction, onDismiss }: { notices: NoticeView[]; work: PendingWork; idPrefix?: string; onAction: (key: string, action: ActionPreview) => void; onDismiss: (key: string) => void }) {
  if (notices.length === 0) return null;
  return (
    <ul className="sync-review-list" aria-label="Changes that clashed">
      {notices.map((view, i) => {
        // One action at a time: every button waits while any runs (F8).
        const busy = work.busy !== null;
        const error = work.errors[view.key];
        const textId = `${idPrefix}-${i}-text`;
        return (
          <li key={view.key} className="sync-review-item" data-review-item={view.key} tabIndex={-1}>
            <p id={textId} className="sync-review-text">
              {noticeText(view)}
            </p>
            <div className="sync-review-actions">
              {view.actions.map((action) => {
                const reason = refusalText(action, view);
                const reasonId = `${idPrefix}-${i}-${action.kind}-why`;
                return (
                  <span key={action.kind} className="sync-review-action">
                    <button type="button" className="sync-review-primary" disabled={busy || reason !== null} aria-describedby={reason !== null ? `${textId} ${reasonId}` : textId} onClick={() => onAction(view.key, action)}>
                      {actionLabel(view, action)}
                    </button>
                    {reason !== null && (
                      <span id={reasonId} className="sync-review-reason">
                        {reason}
                      </span>
                    )}
                  </span>
                );
              })}
              <button type="button" disabled={busy} aria-describedby={textId} onClick={() => onDismiss(view.key)}>
                Dismiss
              </button>
            </div>
            {error && (
              <p className="sync-review-error" role="alert">
                {error}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
