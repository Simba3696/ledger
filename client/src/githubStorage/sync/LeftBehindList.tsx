import type { LeftBehindView } from "../../backend/sync/SyncEngine";
import { leftBehindHeading, leftBehindItemText } from "./labels";
import type { PendingWork } from "./NoticeList";

function Group({ group, work, onReapply, onDiscard }: { group: LeftBehindView; work: PendingWork; onReapply: (id: string) => void; onDiscard: (id: string) => void }) {
  const busy = work.busy === group.id;
  const error = work.errors[group.id];
  return (
    <li className={`sync-review-item${group.own ? " sync-review-own" : ""}`}>
      <p className="sync-review-text">{leftBehindHeading(group)}</p>
      {group.resolvedElsewhere && <p className="sync-review-note">Another device already re-applied or discarded these, but not all of this device's changes are in the ledger. Re-apply or discard them here too.</p>}
      <ul className="sync-review-changes">
        {group.items.map((item, i) => (
          <li key={i}>{leftBehindItemText(item)}</li>
        ))}
      </ul>
      <div className="sync-review-actions">
        <button type="button" className="sync-review-primary" disabled={busy} onClick={() => onReapply(group.id)}>
          Re-apply
        </button>
        <button type="button" disabled={busy} onClick={() => onDiscard(group.id)}>
          Discard
        </button>
      </div>
      {error && (
        <p className="sync-review-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

/** The changes a restore left behind (design section 9.3, owner decision
 * D18): this device's own groups shown prominently, other devices' in a
 * collapsed list, each with Re-apply and Discard. A group another device
 * already resolved, with some of this device's changes still not in
 * effect, says so (resolvedElsewhere). */
export function LeftBehindList({ groups, work, onReapply, onDiscard }: { groups: LeftBehindView[]; work: PendingWork; onReapply: (id: string) => void; onDiscard: (id: string) => void }) {
  const own = groups.filter((g) => g.own);
  const others = groups.filter((g) => !g.own);
  if (groups.length === 0) return null;
  return (
    <div className="sync-review-left">
      {own.length > 0 && (
        <ul className="sync-review-list" aria-label="This device's changes a restore left out">
          {own.map((group) => (
            <Group key={group.id} group={group} work={work} onReapply={onReapply} onDiscard={onDiscard} />
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <details className="sync-review-others">
          <summary>{`Changes from other devices not in the restore (${others.length})`}</summary>
          <ul className="sync-review-list">
            {others.map((group) => (
              <Group key={group.id} group={group} work={work} onReapply={onReapply} onDiscard={onDiscard} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
