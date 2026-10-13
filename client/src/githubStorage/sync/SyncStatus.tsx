import type { EngineState } from "../../backend/sync/SyncEngine";
import { reviewText, statusText } from "./labels";

/** Statuses only something outside the cycle can fix. */
const ATTENTION = new Set<EngineState["status"]>(["needsToken", "needsPassphrase", "missing", "unreadable", "needsUpdate", "needsAttention", "locked"]);

/** GitHub mode's small sync indicator (design section 11): what the sync is
 * doing, "Try again" while it can't reach GitHub or a save on this device
 * failed, and "N to review" (notices, and other devices' changes a restore
 * left behind: this device's own are shown outside it, D18),
 * which opens the review list below it. Non-modal: nothing here blocks the
 * ledger. */
export function SyncStatus({ state, reviewOpen, reviewId, onRetry, onToggleReview }: { state: EngineState; reviewOpen: boolean; reviewId: string; onRetry: () => void; onToggleReview: () => void }) {
  const tone = state.deviceSaveFailed || ATTENTION.has(state.status) ? "attention" : state.status === "pending" ? "pending" : "ok";
  const review = reviewText(state);
  return (
    <div className={`sync-status sync-status-${tone}`}>
      <span role="status" aria-live="polite">
        {statusText(state)}
      </span>
      {(state.status === "pending" || state.deviceSaveFailed) && (
        <button type="button" className="sync-status-button" onClick={onRetry}>
          Try again
        </button>
      )}
      {review !== null && (
        <button type="button" className="sync-status-button sync-status-review" aria-expanded={reviewOpen} aria-controls={reviewId} onClick={onToggleReview}>
          {review}
        </button>
      )}
    </div>
  );
}
