import type { NoticeActionKind, NoticeView } from "../../backend/sync/noticeActions";
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
 * (the old B9 split labels): "Add it back as a new entry", never "Keep". */
export function NoticeList({ notices, work, onAction, onDismiss }: { notices: NoticeView[]; work: PendingWork; onAction: (key: string, kind: NoticeActionKind) => void; onDismiss: (key: string) => void }) {
  if (notices.length === 0) return null;
  return (
    <ul className="sync-review-list" aria-label="Changes that clashed">
      {notices.map((view) => {
        const busy = work.busy === view.key;
        const error = work.errors[view.key];
        return (
          <li key={view.key} className="sync-review-item">
            <p className="sync-review-text">{noticeText(view)}</p>
            <div className="sync-review-actions">
              {view.actions.map((action) => {
                const reason = refusalText(action, view);
                const reasonId = `${view.key}-${action.kind}-why`;
                return (
                  <span key={action.kind} className="sync-review-action">
                    <button type="button" className="sync-review-primary" disabled={busy || reason !== null} aria-describedby={reason !== null ? reasonId : undefined} onClick={() => onAction(view.key, action.kind)}>
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
              <button type="button" disabled={busy} onClick={() => onDismiss(view.key)}>
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
