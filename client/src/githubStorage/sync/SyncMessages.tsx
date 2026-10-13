import { damagedFileMessage } from "../../backend/sync/ledgerRepo";
import { RESTORED, RESTORE_UNKNOWN, epochGoneMessage, type EngineState } from "../../backend/sync/SyncEngine";

/** What stops sync and needs the person (design section 12, owner decision
 * D26): a newer genesis this device can't open (damagedFile: the file and
 * what to do with it), this device's ledger version gone from the repo
 * (epochGone), and a restore this tab started (restore: on its way, or
 * landed and waiting for the reload). The words are the engine's own
 * (damagedFileMessage, epochGoneMessage), so they say the same thing
 * wherever they are shown. Joining, restoring and reloading are #8's and
 * #9's: this only tells. */
export function SyncMessages({ state }: { state: Pick<EngineState, "damagedFile" | "epochGone" | "restore"> }) {
  const messages: [key: string, text: string][] = [];
  if (state.restore !== null) messages.push(["restore", state.restore.state === "landed" ? RESTORED : RESTORE_UNKNOWN]);
  if (state.epochGone !== null) messages.push(["epochGone", epochGoneMessage(state.epochGone)]);
  if (state.damagedFile !== null) messages.push(["damagedFile", damagedFileMessage(state.damagedFile)]);
  if (messages.length === 0) return null;
  return (
    <div className="sync-messages">
      {messages.map(([key, text]) => (
        <p key={key} className="sync-message-line" role="alert">
          {text}
        </p>
      ))}
    </div>
  );
}
