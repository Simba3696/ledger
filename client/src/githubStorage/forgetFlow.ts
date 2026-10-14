import type { SyncEngine } from "../backend/sync/SyncEngine";
import { confirmDialog } from "../components/dialogs";
import { forget, type Unsaved } from "./connection";

// Forget this device's questions (#8), from Settings, Replace token or a
// screen that can't open the ledger: Sync now first when changes haven't
// reached GitHub, then what will be lost, named by kind, then forget.
// Needs a DialogHost on screen.

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What would be lost, in words: changes not yet on GitHub, and groups of
 * this device's changes a restore left behind, which no sync sends (only
 * Re-apply keeps them). Null when nothing would be. */
export function lossText({ pendingCount, leftBehindOwnCount }: Unsaved): string | null {
  const parts: string[] = [];
  if (pendingCount > 0) parts.push(`${count(pendingCount, "change")} on this device ${pendingCount === 1 ? "hasn't" : "haven't"} reached GitHub yet`);
  if (leftBehindOwnCount > 0) parts.push(`${count(leftBehindOwnCount, "group")} of your changes a restore left behind ${leftBehindOwnCount === 1 ? "hasn't" : "haven't"} been re-applied (Re-apply keeps ${leftBehindOwnCount === 1 ? "it" : "them"})`);
  return parts.length > 0 ? parts.join(", and ") : null;
}

export type ForgetOutcome = { kind: "forgotten" } | { kind: "cancelled" } | { kind: "failed"; message: string };

/** Asks, then forgets this device. `engine` is the open ledger's, when one
 * is (it tells what's unsaved, and can sync first); without one, nothing
 * on the device can be counted, and the question says so. */
export async function confirmAndForget(engine: SyncEngine | null): Promise<ForgetOutcome> {
  let unsaved: Unsaved | null = engine ? pick(engine.getState()) : null;
  const canSync = engine !== null && engine.getState().status !== "needsToken";
  if (engine && unsaved && unsaved.pendingCount > 0 && canSync) {
    const sync = await confirmDialog({ message: `${lossText({ pendingCount: unsaved.pendingCount, leftBehindOwnCount: 0 })}. Sync now first?`, confirmLabel: "Sync now", cancelLabel: "Cancel" });
    if (!sync) return { kind: "cancelled" };
    await engine.syncNow();
    unsaved = pick(engine.getState());
  }
  const loss = unsaved ? lossText(unsaved) : "Changes on this device that haven't reached GitHub can't be checked now";
  const confirmed = await confirmDialog(
    loss
      ? { message: `${loss}, and will be lost. Forget this device anyway?`, confirmLabel: "Forget anyway", destructive: true }
      : {
          message: "Forget this device? Ledger's copy of your data, the passphrase key and the token are removed from this browser. Nothing on GitHub changes, and you can connect again at any time.",
          confirmLabel: "Forget this device",
          destructive: true,
        },
  );
  if (!confirmed) return { kind: "cancelled" };
  try {
    const done = await forget(engine, { force: loss !== null, confirmed: unsaved ?? undefined });
    if (done.ok) return { kind: "forgotten" };
    return { kind: "failed", message: `Something changed while you were deciding: ${lossText(done) ?? "a change isn't on GitHub"}. Nothing was forgotten.` };
  } catch (err) {
    return { kind: "failed", message: `This device couldn't be forgotten: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function pick({ pendingCount, leftBehindOwnCount }: Unsaved): Unsaved {
  return { pendingCount, leftBehindOwnCount };
}
