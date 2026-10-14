import { ApiError } from "../backend/ApiError";
import type { LedgerDocument } from "../backend/document/types";
import { GitHubAuthError, GitHubError, GitHubNetworkError } from "../backend/github/contents";
import { damagedFileMessage } from "../backend/sync/ledgerRepo";
import { RESTORE_UNKNOWN, epochGoneMessage, type SyncEngine } from "../backend/sync/SyncEngine";
import { DAMAGED } from "./backup";
import { lossText } from "./forgetFlow";
import { connectError, type ConnectTarget } from "./token";

// Restoring a backup over the open ledger (#9): the questions asked before
// anything is written, and what each answer of SyncEngine.restore (or an
// error it throws) means for the person. No React, so every branch is
// tested; BackupPanel asks through confirmDialog.

export const NOT_RESTORED = "Couldn't reach GitHub. Nothing was restored.";
export const RESTORED_RELOAD = "The backup was restored. Reload to continue.";

export interface Question {
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export type RestoreOutcome =
  /** It landed (or another restore won): clear this device's sync state
   * and reload. */
  | { kind: "landed" }
  /** Another restore won, with a genesis this device can't open (D26): say
   * so, and reload only once the engine no longer reports it. */
  | { kind: "waitDamaged"; message: string }
  | { kind: "cancelled" }
  /** GitHub refused the token: Replace token. Nothing was restored. */
  | { kind: "tokenRefused" }
  | { kind: "failed"; message: string };

export async function restoreWithQuestions(
  engine: Pick<SyncEngine, "restore" | "syncNow">,
  doc: LedgerDocument,
  context: { repo: ConnectTarget; summary: string },
  ask: (question: Question) => Promise<boolean>,
): Promise<RestoreOutcome> {
  const confirmed = await ask({
    message: `Replace all data in ${context.repo.owner}/${context.repo.repo} with this backup (${context.summary})? The current version stays in the repo's history on GitHub, and every device switches to the backup.`,
    confirmLabel: "Replace with backup",
    destructive: true,
  });
  if (!confirmed) return { kind: "cancelled" };
  try {
    let result = await engine.restore(doc);
    if (result.kind === "unsynced" && result.pendingCount > 0) {
      const sync = await ask({ message: `${lossText({ pendingCount: result.pendingCount, leftBehindOwnCount: 0 })}. Sync now first?`, confirmLabel: "Sync now", cancelLabel: "Cancel" });
      if (!sync) return { kind: "cancelled" };
      await engine.syncNow();
      result = await engine.restore(doc);
    }
    if (result.kind === "unsynced") {
      // This device's only copy: the restore leaves them out and the reload
      // after it clears this device.
      const anyway = await ask({
        message: `${lossText(result)}, and will be lost: the restore doesn't include them, and this device's copy is cleared. Restore anyway?`,
        confirmLabel: "Restore anyway",
        destructive: true,
      });
      if (!anyway) return { kind: "cancelled" };
      result = await engine.restore(doc, { discardUnsynced: true });
    }
    switch (result.kind) {
      case "restored":
        return { kind: "landed" };
      case "replaced":
        return result.damagedFile ? { kind: "waitDamaged", message: damagedFileMessage(result.damagedFile) } : { kind: "landed" };
      case "unknown":
        return { kind: "failed", message: RESTORE_UNKNOWN };
      case "tooLarge":
        return { kind: "failed", message: `This backup is too large to restore: ${result.detail}` };
      case "invalid":
        return { kind: "failed", message: DAMAGED };
      case "failed":
        return { kind: "failed", message: result.damagedFile ? damagedFileMessage(result.damagedFile) : result.epochGone ? epochGoneMessage(result.epochGone) : result.detail };
      case "unsynced":
        return { kind: "failed", message: `${lossText(result)}. Nothing was restored.` };
    }
  } catch (err) {
    // restore() throws only before any genesis PUT may have landed (#7
    // stage 8a), or refuses a restore already under way in its own words.
    if (err instanceof GitHubAuthError) return { kind: "tokenRefused" };
    if (err instanceof GitHubNetworkError || err instanceof TypeError) return { kind: "failed", message: NOT_RESTORED };
    if (err instanceof ApiError) return { kind: "failed", message: err.message };
    if (err instanceof GitHubError) return { kind: "failed", message: connectError(err, context.repo, { write: true }).message };
    return { kind: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}
