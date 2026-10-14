import { useState, type FormEvent } from "react";
import { GitHubAuthError } from "../backend/github/contents";
import { damagedFileMessage } from "../backend/sync/ledgerRepo";
import { RESTORE_UNKNOWN, epochGoneMessage, type SyncEngine } from "../backend/sync/SyncEngine";
import { confirmDialog } from "../components/dialogs";
import { backupFileName, DAMAGED, downloadFile, readBackupFile, type BackupRead, type BackupSummary } from "./backup";
import { lossText } from "./forgetFlow";
import type { DeviceKey } from "../backend/sync/records";
import { ErrorText } from "./Shell";

// Backup and restore in Settings (#9, amended): export what this device
// shows, sealed with the household key; restore a backup file over the
// open ledger as a new epoch (SyncEngine.restore), which every device
// switches to, its unsynced changes offered back. Needs a DialogHost on
// screen (Settings mounts one).

const NOT_RESTORED = "Couldn't reach GitHub. Nothing was restored.";

function describe(s: BackupSummary): string {
  const span = s.from === null ? "no expenses" : `${s.expenses} expense${s.expenses === 1 ? "" : "s"} from ${s.from} to ${s.to}`;
  return `${span}, ${s.debts} debt${s.debts === 1 ? "" : "s"}, ${s.emis} EMI${s.emis === 1 ? "" : "s"}, ${s.subscriptions} subscription${s.subscriptions === 1 ? "" : "s"}`;
}

export function BackupPanel({
  engine,
  deviceKey,
  repo,
  onRestored,
  onTokenRejected,
}: {
  engine: SyncEngine;
  /** This device's key: a backup sealed under it opens without asking. */
  deviceKey: DeviceKey | null;
  /** "owner/repo", for the confirmation. */
  repo: string;
  /** After the restore landed: clear this device's sync state and reload. */
  onRestored: () => Promise<void>;
  onTokenRejected: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [needsPassphrase, setNeedsPassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [read, setRead] = useState<Extract<BackupRead, { ok: true }> | null>(null);

  async function exportNow() {
    setBusy(true);
    setNote(null);
    try {
      const name = backupFileName();
      downloadFile(await engine.exportBackup(), name);
      setNote({ error: false, text: `Saved ${name}.` });
    } catch (err) {
      setNote({ error: true, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function open(picked: File, withPassphrase?: string) {
    setBusy(true);
    setNote(null);
    setRead(null);
    try {
      const result = await readBackupFile(picked, deviceKey, withPassphrase);
      if (result.ok) {
        setRead(result);
        setNeedsPassphrase(false);
      } else if (result.needsPassphrase) {
        setNeedsPassphrase(true);
      } else {
        setNote({ error: true, text: result.message });
      }
    } catch {
      setNote({ error: true, text: DAMAGED });
    } finally {
      setBusy(false);
    }
  }

  function pick(picked: File | null) {
    setFile(picked);
    setPassphrase("");
    setNeedsPassphrase(false);
    setRead(null);
    setNote(null);
    if (picked) void open(picked);
  }

  async function restore() {
    if (!read) return;
    const confirmed = await confirmDialog({
      message: `Replace all data in ${repo} with this backup (${describe(read.summary)})? The current version stays in the repo's history on GitHub, and every device switches to the backup.`,
      confirmLabel: "Replace with backup",
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    setNote(null);
    try {
      let result = await engine.restore(read.doc);
      if (result.kind === "unsynced" && result.pendingCount > 0) {
        const sync = await confirmDialog({ message: `${lossText({ pendingCount: result.pendingCount, leftBehindOwnCount: 0 })}. Sync now first?`, confirmLabel: "Sync now", cancelLabel: "Cancel" });
        if (!sync) return;
        await engine.syncNow();
        result = await engine.restore(read.doc);
      }
      if (result.kind === "unsynced") {
        const anyway = await confirmDialog({ message: `${lossText(result)}, and will be left out of the restore. Restore anyway?`, confirmLabel: "Restore anyway", destructive: true });
        if (!anyway) return;
        result = await engine.restore(read.doc, { discardUnsynced: true });
      }
      switch (result.kind) {
        case "restored":
        case "replaced":
          return await onRestored();
        case "unknown":
          return setNote({ error: true, text: RESTORE_UNKNOWN });
        case "tooLarge":
          return setNote({ error: true, text: `This backup is too large to restore: ${result.detail}` });
        case "invalid":
          return setNote({ error: true, text: DAMAGED });
        case "failed":
          return setNote({
            error: true,
            text: result.damagedFile ? damagedFileMessage(result.damagedFile) : result.epochGone ? epochGoneMessage(result.epochGone) : result.detail,
          });
        case "unsynced":
          return setNote({ error: true, text: `${lossText(result)}. Nothing was restored.` });
      }
    } catch (err) {
      // Thrown before any genesis PUT may have landed (#7 stage 8a).
      if (err instanceof GitHubAuthError) return onTokenRejected();
      setNote({ error: true, text: NOT_RESTORED });
    } finally {
      setBusy(false);
    }
  }

  function submitPassphrase(e: FormEvent) {
    e.preventDefault();
    if (file) void open(file, passphrase);
  }

  return (
    <section className="gh-settings-section" aria-labelledby="gh-settings-backup">
      <h3 id="gh-settings-backup">Backup</h3>
      <p className="gh-note">Saves what this device shows now, encrypted. It opens with the passphrase you use today.</p>
      <button type="button" className="gh-secondary" disabled={busy} onClick={() => void exportNow()} data-testid="gh-export">
        Export encrypted backup
      </button>
      <label>
        Restore from a backup file
        <input type="file" accept=".enc,application/octet-stream" disabled={busy} data-testid="gh-restore-file" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
      </label>
      {needsPassphrase && (
        <form onSubmit={submitPassphrase} className="gh-choices">
          <label>
            This backup's passphrase
            <input type="password" autoComplete="current-password" value={passphrase} disabled={busy} data-testid="gh-restore-passphrase" onChange={(e) => setPassphrase(e.target.value)} />
          </label>
          <button type="submit" className="gh-secondary" disabled={busy || passphrase === ""} data-testid="gh-restore-open">
            Open backup
          </button>
        </form>
      )}
      {read && (
        <>
          <p data-testid="gh-restore-summary">This backup holds {describe(read.summary)}.</p>
          <button type="button" className="gh-secondary gh-danger" disabled={busy} onClick={() => void restore()} data-testid="gh-restore">
            Replace with this backup
          </button>
        </>
      )}
      {note && (note.error ? <ErrorText>{note.text}</ErrorText> : <p className="gh-note" role="status">{note.text}</p>)}
    </section>
  );
}
