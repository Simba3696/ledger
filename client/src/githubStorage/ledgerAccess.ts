import { installBackend } from "../api";
import { bytesToBase64 } from "../backend/base64";
import { DEFAULT_ITERATIONS, deriveKey, newSalt } from "../backend/crypto";
import { createEmptyDocument } from "../backend/document/createDocument";
import { DocumentBackend } from "../backend/document/DocumentBackend";
import { createGitHubClient, getLogin, type GitHubClient } from "../backend/github/contents";
import type { Connection } from "../backend/github/deviceStore";
import { createLedger, findLedger, openGenesis, type CreateResult, type GenesisOpen, type LedgerFound } from "../backend/sync/ledgerRepo";
import type { DeviceKey } from "../backend/sync/records";
import { LEDGER_DIR } from "../backend/sync/repoFiles";
import type { SyncState } from "../backend/sync/state";
import type { SyncStore } from "../backend/sync/persist";
import { SyncEngine, type SyncRemote } from "../backend/sync/SyncEngine";
import { SyncedHost } from "../backend/sync/SyncedHost";
import type { ModuleName } from "../api";

// What #8's gate does with GitHub, one step per function, so each is
// tested against the fake GitHub without a browser: connect (who the token
// is, the repo, whether it holds a ledger), create a ledger, unlock one with
// the passphrase, and open it (the sync engine, and the DocumentBackend
// behind api.ts). The redesigned sync (#7, ADR-0008) decides what a ledger
// is: findLedger, createLedger and openGenesis, then initialize.

/** What tests swap in: the fake GitHub, and a device store and tab locks
 * of their own per simulated device. The app passes nothing. */
export interface Deps {
  fetch?: typeof fetch;
  store?: SyncStore;
  locks?: LockManager | null;
}

export interface Connected {
  connection: Connection;
  remote: SyncRemote;
  found: LedgerFound;
}

/** The token a running ledger's requests carry: Replace token (a 401)
 * swaps it here, and every later request, the sync engine's included,
 * sends the new one. */
export interface TokenHolder {
  token: string;
}

function clientFor(connection: Pick<Connection, "owner" | "repo">, token: TokenHolder | string, deps: Deps): GitHubClient {
  const source = typeof token === "string" ? token : () => Promise.resolve(token.token);
  return createGitHubClient({ owner: connection.owner, repo: connection.repo, token: source, fetch: deps.fetch });
}

/** The repo a saved connection names, for reads before a ledger is open
 * (Unlock on a later start). */
export async function remoteFor(connection: Connection, deps: Deps = {}): Promise<SyncRemote> {
  const client = clientFor(connection, connection.token, deps);
  return { client, branch: connection.branch ?? (await client.verifyRepo()).defaultBranch };
}

/** Connecting failed: `cause` is the contents client's typed error (what
 * connectError words), `owner` the repo owner it was aimed at, once known
 * (null when GitHub didn't say whose token it is). */
export class ConnectFailed extends Error {
  readonly owner: string | null;
  constructor(cause: unknown, owner: string | null) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ConnectFailed";
    this.owner = owner;
  }
}

/** Who the token belongs to, the repo (private, reachable), and what it
 * holds. `owner` null means the token's own login (the personal path).
 * Throws ConnectFailed. */
export async function connect(token: string, target: { owner: string | null; repo: string }, deps: Deps = {}): Promise<Connected> {
  let owner = target.owner;
  try {
    const { login, tokenExpiresAt } = await getLogin({ token, fetch: deps.fetch });
    owner ??= login;
    const client = clientFor({ owner, repo: target.repo }, token, deps);
    const { defaultBranch } = await client.verifyRepo();
    const remote: SyncRemote = { client, branch: defaultBranch };
    const found = await findLedger(remote);
    const connection: Connection = { kind: "pat", token, owner, repo: target.repo, path: LEDGER_DIR, login, branch: defaultBranch };
    if (tokenExpiresAt !== null) connection.expiresAt = tokenExpiresAt;
    return { connection, remote, found };
  } catch (err) {
    throw new ConnectFailed(err, owner);
  }
}

/** The passphrase's key for a salt (a header's) and iteration count, or a
 * fresh salt for a new ledger. */
export async function keyFor(passphrase: string, header?: { salt: string; iter: number }): Promise<DeviceKey> {
  const salt = header?.salt ?? bytesToBase64(newSalt());
  const iter = header?.iter ?? DEFAULT_ITERATIONS;
  return { key: await deriveKey(passphrase, salt, iter), salt, iter };
}

/** A new ledger in an empty repo: its genesis, with the sections and time
 * zone chosen, under a fresh salt. */
export async function createNew(
  connected: Pick<Connected, "connection" | "remote">,
  passphrase: string,
  choices: { modules: ModuleName[]; timeZone: string },
  now: () => number = Date.now,
): Promise<{ key: DeviceKey; result: CreateResult }> {
  const key = await keyFor(passphrase);
  const doc = createEmptyDocument({ modules: choices.modules, timeZone: choices.timeZone });
  const result = await createLedger(connected.remote, key, { doc, by: connected.connection.login, at: now() });
  return { key, result };
}

/** Where a first start begins: the genesis opened, and its blob sha, so
 * the first cycle doesn't read it again (stage 8c-2). */
export interface Start {
  epoch: string;
  sha: string;
  state: SyncState;
}

/** The ledger `found` opened with the passphrase, or why not: a wrong
 * passphrase stays on Unlock; a newer or damaged genesis is the gate's
 * blocked screen. */
export async function unlock(
  found: Extract<LedgerFound, { kind: "ledger" }>,
  passphrase: string,
): Promise<{ ok: true; key: DeviceKey; start: Start } | Extract<GenesisOpen, { ok: false }>> {
  const key = await keyFor(passphrase, found);
  const opened = await openGenesis(found, key);
  if (!opened.ok) return opened;
  return { ok: true, key, start: { epoch: opened.epoch, sha: opened.sha, state: opened.state } };
}

/** Where a first start begins when the gate has opened no genesis itself
 * (a later start after Forget or a restore cleared this device, or the tab
 * lock arriving late): the ledger in the repo now, opened with the saved
 * key, with no passphrase prompt. A restore writes its genesis under the
 * household key, so this is the normal way back after one. */
export async function startFromRepo(
  remote: SyncRemote,
  key: DeviceKey,
): Promise<{ kind: "start"; start: Start } | { kind: "found"; found: LedgerFound } | { kind: "keyChanged"; found: Extract<LedgerFound, { kind: "ledger" }> }> {
  const found = await findLedger(remote);
  if (found.kind !== "ledger") return { kind: "found", found };
  if (found.salt !== key.salt || found.iter !== key.iter) return { kind: "keyChanged", found };
  const opened = await openGenesis(found, key);
  if (!opened.ok) return opened.problem === "wrongPassphrase" ? { kind: "keyChanged", found } : { kind: "found", found };
  return { kind: "start", start: { epoch: opened.epoch, sha: opened.sha, state: opened.state } };
}

export type Opened =
  /** `backend`: the one behind api.ts, for what api.ts doesn't carry
   * (Settings' updateSettings). */
  | { kind: "open"; engine: SyncEngine; backend: DocumentBackend; token: TokenHolder; remote: SyncRemote }
  /** A first start with no ledger to start from yet, or one the saved key
   * doesn't open: the gate goes back to Create or Unlock. */
  | { kind: "found"; found: LedgerFound }
  | { kind: "keyChanged"; found: Extract<LedgerFound, { kind: "ledger" }> };

/** Starts the sync engine on this device's saved state and puts a
 * DocumentBackend over its document behind api.ts. A device with nothing
 * saved starts from `start` when the gate has just opened the genesis, or
 * else from the repo (startFromRepo). An engine that can't be opened is
 * stopped before this returns or throws, so it never keeps the tab's
 * lock. While another tab holds the lock, the engine opens without a first
 * start; the gate runs it once the lock arrives (needsInit). */
export async function openLedger(connection: Connection, key: DeviceKey, start: Start | null, deps: Deps = {}): Promise<Opened> {
  const token: TokenHolder = { token: connection.token };
  const client = clientFor(connection, token, deps);
  const remote: SyncRemote = { client, branch: connection.branch ?? (await client.verifyRepo()).defaultBranch };
  const engine = new SyncEngine({ key, actor: connection.login, remote, store: deps.store, locks: deps.locks });
  await engine.start();
  try {
    const state = engine.getState();
    if (state.needsInit && state.status !== "locked") {
      let from = start;
      if (from === null) {
        const found = await startFromRepo(remote, key);
        if (found.kind !== "start") {
          engine.stop();
          return found;
        }
        from = found.start;
      }
      await engine.initialize(from.epoch, from.state, { sha: from.sha, state: from.state });
    }
  } catch (err) {
    engine.stop();
    throw err;
  }
  const backend = new DocumentBackend({ host: new SyncedHost(engine), now: Date.now, actor: connection.login, newId: () => crypto.randomUUID() });
  installBackend(backend);
  return { kind: "open", engine, backend, token, remote };
}
