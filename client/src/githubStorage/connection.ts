import { forgetThisDevice, takeRestoredEpoch } from "../backend/sync/ledgerRepo";
import { DeviceStoreUnavailableError, loadConnection, loadKey, saveConnection, saveKey, type Connection, type StoredKey } from "../backend/github/deviceStore";

// The GitHub connection and the passphrase key, as #8's gate keeps them: a
// thin wrapper over #6's deviceStore, the only place either is stored (the
// token is never in localStorage, the URL, logs or messages). When the
// browser won't keep anything (some private windows), both live in this
// tab's memory instead, and the gate says the passphrase will be asked for
// each time.

/** Set once the device store turned out to be unusable in this tab. */
let memory: { connection: Connection | null; key: StoredKey | null } | null = null;

export interface Saved {
  connection: Connection | null;
  key: StoredKey | null;
  /** False when nothing survives this tab: the "won't remember" notice. */
  remembered: boolean;
}

export async function loadSaved(): Promise<Saved> {
  if (memory) return { ...memory, remembered: false };
  try {
    const [connection, key] = await Promise.all([loadConnection(), loadKey()]);
    return { connection, key, remembered: true };
  } catch (err) {
    if (!(err instanceof DeviceStoreUnavailableError)) throw err;
    memory = { connection: null, key: null };
    return { ...memory, remembered: false };
  }
}

/** Keeps the connection and the key once a ledger is open. Resolves to
 * whether they will survive this tab. */
export async function remember(connection: Connection, key: StoredKey): Promise<boolean> {
  if (memory) {
    memory = { connection, key };
    return false;
  }
  try {
    await saveConnection(connection);
    await saveKey(key);
    return true;
  } catch (err) {
    if (!(err instanceof DeviceStoreUnavailableError)) throw err;
    memory = { connection, key };
    return false;
  }
}

/** Forget this device (#8): its sync state and its connection and key,
 * on the device and in this tab's memory. Nothing on GitHub changes.
 * Refused while this device has changes GitHub doesn't have (unsynced, or
 * its own left behind by a restore), unless `force`: #7's
 * forgetThisDevice syncs first and says how many. */
export async function forget(engine: Parameters<typeof forgetThisDevice>[0], options: { force?: boolean } = {}): ReturnType<typeof forgetThisDevice> {
  const done = await forgetThisDevice(engine, options);
  if (done.ok) {
    memory = null;
    // A restore's marker for the reload after it (sessionStorage).
    takeRestoredEpoch();
  }
  return done;
}

/** Tests only: back to a fresh tab. */
export function resetMemoryForTests(): void {
  memory = null;
}
