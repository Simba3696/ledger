import { clearSignInState, type AppTokens, type TokenStore } from "../backend/github/appAuth";
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

/** Bumped when Forget this device is about to delete the device store: a
 * token store made before it never reads or writes again (#10). */
let generation = 0;
/** Token saves under way, which Forget waits for before deleting. */
const saving = new Set<Promise<boolean>>();

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

const TOKEN_FIELDS = ["expiresAt", "refreshToken", "refreshTokenExpiresAt"] as const;

const tokensOf = (saved: Connection): AppTokens => {
  const tokens: AppTokens = { token: saved.token };
  for (const key of TOKEN_FIELDS) if (saved[key] !== undefined) tokens[key] = saved[key];
  return tokens;
};

/** Where a signed-in App session (#10) keeps its tokens: the saved
 * connection, when it is this one (same account and repo, kind "app").
 * `connection` is read at each call, so it may still be filling in.
 * Saves are compare-and-set on the refresh token, so a tab holding old
 * tokens never overwrites newer ones another tab saved; the session calls
 * both under its cross-tab lock. A connection not yet remembered
 * (onboarding keeps it in memory until a ledger opens) saves nothing. */
export function appTokenStore(connection: Pick<Connection, "owner" | "repo" | "login">): TokenStore {
  const born = generation;
  const same = (saved: Connection | null): saved is Connection =>
    saved !== null && saved.kind === "app" && saved.owner === connection.owner && saved.repo === connection.repo && saved.login === connection.login;
  const read = async (): Promise<Connection | null> => {
    if (memory) return memory.connection;
    try {
      return await loadConnection();
    } catch (err) {
      if (err instanceof DeviceStoreUnavailableError) return null;
      throw err;
    }
  };
  return {
    async load() {
      if (generation !== born) return null;
      const saved = await read();
      return same(saved) ? tokensOf(saved) : null;
    },
    save(next, expected) {
      const run = (async () => {
        if (generation !== born) return false;
        const saved = await read();
        if (generation !== born || !same(saved) || saved.refreshToken !== expected) return false;
        const updated: Connection = { ...saved, token: next.token };
        for (const key of TOKEN_FIELDS) {
          if (next[key] === undefined) delete updated[key];
          else updated[key] = next[key];
        }
        if (memory) memory = { ...memory, connection: updated };
        else await saveConnection(updated);
        return true;
      })();
      saving.add(run);
      void run.finally(() => saving.delete(run)).catch(() => {});
      return run;
    },
  };
}

/** What a device holds that GitHub doesn't: changes not yet pushed, and
 * groups of its own changes a restore left behind (which no sync sends;
 * only Re-apply does). */
export interface Unsaved {
  pendingCount: number;
  leftBehindOwnCount: number;
}

type ForgetEngine = Parameters<typeof forgetThisDevice>[0];

/** Forget this device (#8): its sync state and its connection and key,
 * on the device and in this tab's memory. Nothing on GitHub changes.
 * Refused while this device has changes GitHub doesn't have, unless
 * `force`: #7's forgetThisDevice syncs first and says how many. Forced, it
 * drops only what the person was told about (`confirmed`): more since then
 * is refused, and they're asked again. A browser that keeps nothing on the
 * device (the in-memory fallback) has nothing to delete there. */
export async function forget(engine: ForgetEngine, options: { force?: boolean; confirmed?: Unsaved } = {}): ReturnType<typeof forgetThisDevice> {
  if (options.force && options.confirmed && engine) {
    const { pendingCount, leftBehindOwnCount } = engine.getState();
    if (pendingCount > options.confirmed.pendingCount || leftBehindOwnCount > options.confirmed.leftBehindOwnCount) return { ok: false, pendingCount, leftBehindOwnCount };
  }
  let done: Awaited<ReturnType<typeof forgetThisDevice>>;
  try {
    done = await forgetThisDevice(engine, {
      force: options.force,
      beforeDelete: async () => {
        generation++;
        await Promise.allSettled([...saving]);
      },
    });
  } catch (err) {
    // No IndexedDB: the sync state was in memory (cleared already) and so
    // were the connection and key (cleared below).
    if (!(err instanceof DeviceStoreUnavailableError)) throw err;
    done = { ok: true };
  }
  if (done.ok) {
    memory = null;
    // A restore's marker for the reload after it (sessionStorage).
    takeRestoredEpoch();
    // A sign-in started and not finished (#10): its state and verifier.
    clearSignInState();
  }
  return done;
}

/** Tests only: back to a fresh tab. */
export function resetMemoryForTests(): void {
  memory = null;
}
