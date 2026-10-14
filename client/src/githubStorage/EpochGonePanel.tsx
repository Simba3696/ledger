import { useState } from "react";
import { damagedFileMessage } from "../backend/sync/ledgerRepo";
import type { RejoinResult, SyncEngine } from "../backend/sync/SyncEngine";
import { ErrorText } from "./Shell";
import { useSyncState } from "./sync/syncContext";

// The way on when this device's ledger version is gone from the GitHub
// repo (#8; ADR-0008 STAGE-8; owner decisions D34 and D35). SyncMessages
// already says what happened; this offers what to do:
// - another ledger is there: join it, carrying this device's changes as
//   its own group left behind, to Re-apply (D34);
// - none is: create one from this device, then join it;
// - the one there has another passphrase: download a backup of this
//   device, then forget it and join with the new passphrase (D35).
// Rendered in SyncHost's bar, so it reads the sync state.

const JOINED = "Joined the ledger in the repo. Your changes from this device are under Changes left behind: Re-apply them to keep them.";
const JOINED_ALL = "Joined the ledger in the repo. Everything on this device is in it.";
const OTHER_KEY =
  "The ledger in the repo now uses a different passphrase, so this device's changes can't be carried into it. Download a backup of this device first: it keeps everything here, under this device's passphrase. Then forget this device and join with the new passphrase.";

/** Saves `text` as a file, as the browser downloads one. */
function download(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function EpochGonePanel({
  engine,
  onCreate,
  onForget,
}: {
  engine: SyncEngine;
  /** Creates a ledger from this device (createFromDevice), then rejoins:
   * what rejoin answered, or an error to show. */
  onCreate: () => Promise<RejoinResult | string>;
  /** Forget this device's questions and work (confirmAndForget): an error
   * to show, or null. */
  onForget: () => Promise<string | null>;
}) {
  const sync = useSyncState();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  const [otherKey, setOtherKey] = useState(false);
  const [backedUp, setBackedUp] = useState(false);
  if (sync.epochGone === null && note === null) return null;

  /** rejoin's answer in words, or the D35 path. */
  function told(result: RejoinResult | string) {
    if (typeof result === "string") return setNote({ error: true, text: result });
    switch (result.kind) {
      case "joined":
        // Nothing left behind when the ledger joined already holds it all
        // (one created from this device).
        return setNote({ error: false, text: engine.getState().leftBehindOwnCount > 0 ? JOINED : JOINED_ALL });
      case "notGone":
        return setNote({ error: false, text: "This device's ledger is back in the repo: nothing to do." });
      case "empty":
        return setNote({ error: true, text: "There's no ledger in the repo now. Create one from this device." });
      case "unknown":
        return setNote({ error: true, text: "Couldn't read the whole repository from GitHub. Try again." });
      case "otherKey":
        setOtherKey(true);
        return setNote(null);
      case "needsUpdate":
        return setNote({ error: true, text: "The ledger in the repo was saved by a newer version of Ledger. Update the app to join it." });
      case "damaged":
        return setNote({ error: true, text: damagedFileMessage(result.damagedFile) });
    }
  }

  async function run(work: () => Promise<RejoinResult | string>) {
    setBusy(true);
    setNote(null);
    try {
      told(await work());
    } catch (err) {
      setNote({ error: true, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function backup() {
    setBusy(true);
    try {
      download(await engine.exportBackup(), `ledger-backup-${new Date().toISOString().slice(0, 10)}.enc`);
      setBackedUp(true);
    } catch (err) {
      setNote({ error: true, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function forget() {
    setBusy(true);
    try {
      const error = await onForget();
      if (error) setNote({ error: true, text: error });
    } finally {
      setBusy(false);
    }
  }

  const gone = sync.epochGone;
  return (
    <div className="sync-messages gh-epoch-gone" data-testid="gh-epoch-gone">
      {note && (note.error ? <ErrorText>{note.text}</ErrorText> : <p className="sync-message-line" role="status">{note.text}</p>)}
      {gone && !otherKey && (
        <div className="gh-actions">
          {gone.winner !== null ? (
            <button type="button" className="submit-btn" disabled={busy} onClick={() => void run(() => engine.rejoin())} data-testid="gh-rejoin">
              {busy ? "Joining..." : "Join the current ledger"}
            </button>
          ) : (
            <button type="button" className="submit-btn" disabled={busy} onClick={() => void run(onCreate)} data-testid="gh-create-from-device">
              {busy ? "Creating..." : "Create a new ledger from this device"}
            </button>
          )}
        </div>
      )}
      {gone && otherKey && (
        <>
          <p className="sync-message-line" role="alert">
            {OTHER_KEY}
          </p>
          <div className="gh-actions">
            <button type="button" className="submit-btn" disabled={busy} onClick={() => void backup()} data-testid="gh-backup">
              {backedUp ? "Downloaded" : "Download a backup"}
            </button>
            <button type="button" className="gh-secondary gh-danger" disabled={busy || !backedUp} onClick={() => void forget()} data-testid="gh-forget-and-join">
              Forget this device and join
            </button>
          </div>
        </>
      )}
    </div>
  );
}
