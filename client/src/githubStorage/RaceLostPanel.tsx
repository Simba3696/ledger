import { useState } from "react";
import { ErrorText } from "./Shell";
import { useSyncState } from "./sync/syncContext";

// The way on for the loser of a racing create (ADR-0008, owner decision
// D32, option A): two devices created the ledger at the same moment, each
// with its own passphrase's salt, and the other one's is the ledger now.
// SyncMessages says which file it is; this offers the join, which asks for
// the household passphrase on the race-lost Unlock and carries this
// device's writes into that ledger, to re-apply. When the two passphrases
// differ, the join can't carry them: download a backup of this device,
// then forget it and join with the other passphrase (D35). Rendered in
// SyncHost's bar, so it reads the sync state.

export const RACE_LOST =
  "Someone else in your household created the ledger at the same moment as this device, and theirs is the one in the repo. Join it with the household passphrase: everything you entered here is kept, and offered back to re-apply.";
const OTHER_PASSPHRASE = "If you two chose different passphrases, download a backup of this device first, then forget this device and join with the other passphrase.";

export function RaceLostPanel({
  onJoin,
  onBackup,
  onForget,
}: {
  /** To the race-lost Unlock. */
  onJoin: () => void;
  /** Downloads a backup of this device (exportBackup). */
  onBackup: () => Promise<void>;
  /** Forget this device (confirmAndForget): an error to show, or null. */
  onForget: () => Promise<string | null>;
}) {
  const sync = useSyncState();
  const [busy, setBusy] = useState(false);
  const [backedUp, setBackedUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (sync.raceLost === null) return null;

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sync-messages gh-race-lost" data-testid="gh-race-lost">
      <p className="sync-message-line" role="alert">
        {RACE_LOST}
      </p>
      {error && <ErrorText>{error}</ErrorText>}
      <div className="gh-actions">
        <button type="button" className="submit-btn" disabled={busy} onClick={onJoin} data-testid="gh-join-race">
          Join their ledger
        </button>
      </div>
      <p className="sync-message-line">{OTHER_PASSPHRASE}</p>
      <div className="gh-actions">
        <button
          type="button"
          className="gh-secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await onBackup();
              setBackedUp(true);
            })
          }
          data-testid="gh-race-backup"
        >
          {backedUp ? "Downloaded" : "Download a backup"}
        </button>
        <button
          type="button"
          className="gh-secondary gh-danger"
          disabled={busy || !backedUp}
          onClick={() =>
            void run(async () => {
              const failed = await onForget();
              if (failed) setError(failed);
            })
          }
          data-testid="gh-race-forget"
        >
          Forget this device and join
        </button>
      </div>
    </div>
  );
}
