import { installBackend } from "../api";
import { bytesToBase64 } from "../backend/base64";
import { DEFAULT_ITERATIONS, deriveKey, isKeyParams, newSalt } from "../backend/crypto";
import { createEmptyDocument } from "../backend/document/createDocument";
import { DocumentBackend } from "../backend/document/DocumentBackend";
import { AppNotInstalledError, AppSession, appReaches, signInConfig, type AppTokens, type SignInConfig } from "../backend/github/appAuth";
import { GitHubAuthError, createGitHubClient, getLogin, type GitHubClient } from "../backend/github/contents";
import type { Connection } from "../backend/github/deviceStore";
import { createLedger, findLedger, openGenesis, type CreateResult, type GenesisOpen, type LedgerFound } from "../backend/sync/ledgerRepo";
import type { DeviceKey } from "../backend/sync/records";
import { LEDGER_DIR } from "../backend/sync/repoFiles";
import type { SyncState } from "../backend/sync/state";
import type { SyncStore } from "../backend/sync/persist";
import { SyncEngine, type RekeyResult, type SyncRemote } from "../backend/sync/SyncEngine";
import { SyncedHost } from "../backend/sync/SyncedHost";
import type { ModuleName } from "../api";
import { appTokenStore } from "./connection";
import { LISTING_CUT, NEEDS_UPDATE } from "./onboarding/flow";

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
  /** A clock that never jumps (the PUT spacing): tests move it on. */
  monotonic?: () => number;
  /** Sign in with GitHub's settings (#10): the dev page and tests pass
   * their own; the app uses this build's, signInConfig(). */
  signInConfig?: SignInConfig | null;
  /** Where startSignIn sends the browser: the dev page's fake GitHub
   * authorize page. The app goes to github.com. */
  navigate?: (url: string) => void;
}

/** The sign-in settings in force: the deps' own, or this build's. */
export function signInConfigOf(deps: Deps): SignInConfig | null {
  return deps.signInConfig !== undefined ? deps.signInConfig : signInConfig();
}

export interface Connected {
  connection: Connection;
  remote: SyncRemote;
  found: LedgerFound;
  /** What the connection's requests carry, for Replace token to swap in. */
  token: TokenHolder;
}

/** What a running ledger's requests carry: a pasted token, or a signed-in
 * GitHub App session (#10) whose token refreshes itself. Replace token (a
 * 401) swaps them here, and every later request, the sync engine's
 * included, uses the new ones. Both kinds go through the same client. */
export interface TokenHolder {
  token: string;
  app: AppSession | null;
}

const sessions = new WeakMap<Connection, AppSession>();

/** The App session over a kind "app" connection record: one per record,
 * so every client on it shares one refresh (a refresh token works once).
 * It updates the record in place, and the saved copy when there is one,
 * under a lock the browser's tabs share. */
export function appSessionFor(connection: Connection, deps: Deps = {}): AppSession {
  let session = sessions.get(connection);
  if (!session) {
    session = new AppSession(connection, {
      helperUrl: signInConfigOf(deps)?.helperUrl ?? null,
      fetch: deps.fetch,
      store: appTokenStore(connection),
      // The tabs' shared lock, unless the deps say otherwise (tests).
      ...(deps.locks !== undefined ? { locks: deps.locks } : {}),
    });
    sessions.set(connection, session);
  }
  return session;
}

function holderFor(connection: Connection, deps: Deps): TokenHolder {
  return { token: connection.token, app: connection.kind === "app" ? appSessionFor(connection, deps) : null };
}

const tokenOf = (holder: TokenHolder) => (holder.app ? holder.app.token() : Promise.resolve(holder.token));

function clientFor(connection: Pick<Connection, "owner" | "repo">, holder: TokenHolder, deps: Deps): GitHubClient {
  return createGitHubClient({
    owner: connection.owner,
    repo: connection.repo,
    token: () => tokenOf(holder),
    // #6's client retries a 401 once when this resolves true: an App
    // session refreshes its token first; a pasted token has no renewal.
    onUnauthorized: () => (holder.app ? holder.app.onUnauthorized() : Promise.resolve(false)),
    fetch: deps.fetch,
  });
}

/** The repo a saved connection names, for reads before a ledger is open
 * (Unlock on a later start). */
export async function remoteFor(connection: Connection, deps: Deps = {}): Promise<SyncRemote> {
  const client = clientFor(connection, holderFor(connection, deps), deps);
  return { client, branch: connection.branch ?? (await client.verifyRepo()).defaultBranch };
}

/** Connecting failed: `cause` is the contents client's typed error (what
 * connectError words), `owner` the repo owner it was aimed at, once known
 * (null when GitHub didn't say whose token it is). */
export class ConnectFailed extends Error {
  readonly owner: string | null;
  /** The connection as far as it got: an App sign-in's tokens as its
   * session left them (a refresh rotates them), for trying again. */
  readonly connection: Connection | null;
  constructor(cause: unknown, owner: string | null, connection: Connection | null = null) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ConnectFailed";
    this.owner = owner;
    this.connection = connection;
  }
}

/** Credentials for another GitHub account than the one this device joined
 * with (Replace token): found from the login alone, before the repo. */
export class OtherAccountError extends Error {
  readonly login: string;
  constructor(login: string) {
    super(`The token belongs to ${login}.`);
    this.name = "OtherAccountError";
    this.login = login;
  }
}

/** Who the token belongs to, the repo (private, reachable), and what it
 * holds. `credentials` is a pasted token, or the tokens a GitHub sign-in
 * returned (#10), which must also reach the repo through one of the App's
 * installations (else AppNotInstalledError, the install prompt). `owner`
 * null means the token's own login (the personal path). With `login`
 * (Replace token), credentials for another account are OtherAccountError
 * before anything about the repo is asked. Throws ConnectFailed. */
export async function connect(
  credentials: string | AppTokens,
  target: { owner: string | null; repo: string },
  deps: Deps = {},
  expect: { login?: string } = {},
): Promise<Connected> {
  let owner = target.owner;
  // Built first, so an App session refreshes into the record that is saved.
  const connection: Connection =
    typeof credentials === "string"
      ? { kind: "pat", token: credentials, owner: "", repo: target.repo, path: LEDGER_DIR, login: "" }
      : { kind: "app", ...credentials, owner: "", repo: target.repo, path: LEDGER_DIR, login: "" };
  const token = holderFor(connection, deps);
  try {
    const { login, tokenExpiresAt } = await getLogin({ token: () => tokenOf(token), fetch: deps.fetch });
    if (expect.login !== undefined && login.toLowerCase() !== expect.login.toLowerCase()) throw new OtherAccountError(login);
    owner ??= login;
    connection.owner = owner;
    connection.login = login;
    if (token.app && !(await appReaches(token.app.token, owner, target.repo, deps.fetch))) throw new AppNotInstalledError(owner, target.repo);
    const client = clientFor(connection, token, deps);
    const { defaultBranch } = await client.verifyRepo();
    const remote: SyncRemote = { client, branch: defaultBranch };
    const found = await findLedger(remote);
    connection.branch = defaultBranch;
    if (connection.kind === "pat" && tokenExpiresAt !== null) connection.expiresAt = tokenExpiresAt;
    return { connection, remote, found, token };
  } catch (err) {
    throw new ConnectFailed(err, owner, connection);
  }
}

/** The passphrase's key for a salt (a header's) and iteration count, or a
 * fresh salt for a new ledger. */
export async function keyFor(passphrase: string, header?: { salt: string; iter: number }): Promise<DeviceKey> {
  if (header && !isKeyParams(header.salt, header.iter)) throw new Error("The salt or iteration count is out of range");
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
  const token = holderFor(connection, deps);
  const client = clientFor(connection, token, deps);
  const remote: SyncRemote = { client, branch: connection.branch ?? (await client.verifyRepo()).defaultBranch };
  const engine = new SyncEngine({ key, actor: connection.login, remote, store: deps.store, locks: deps.locks, monotonic: deps.monotonic });
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

/** What the race-lost Unlock's join came to (ADR-0008, D32). */
export type JoinRace =
  /** Joined: `key` is the household's key for the ledger, which `keep`
   * saved (`kept`), or failed to: the device then names it on its next
   * start, and Unlock asks for the passphrase (keyChangeStep). */
  | { kind: "joined"; key: DeviceKey; kept: boolean }
  /** Nothing to join (any more), or a ledger started from a backup, whose
   * panel says the backup way: back to the ledger. */
  | { kind: "back" }
  | { kind: "wrongPassphrase" }
  /** Two different passphrases: D35's way on. */
  | { kind: "otherKey" }
  | { kind: "failed"; message: string }
  | { kind: "tokenRejected" };

/** The race-lost Unlock's join (D32): rekeyAndJoin with the passphrase,
 * then `keep` (the device store) keeps the key it returns. The engine's
 * transaction comes first, so a tab gone before `keep` leaves the device
 * naming its key (EngineState.keyNeeded) for the next start. */
export async function joinRace(engine: SyncEngine, passphrase: string, keep: (key: DeviceKey) => Promise<void>): Promise<JoinRace> {
  let result: RekeyResult;
  try {
    result = await engine.rekeyAndJoin(passphrase);
  } catch (err) {
    if (err instanceof GitHubAuthError) return { kind: "tokenRejected" };
    return { kind: "failed", message: err instanceof Error ? err.message : String(err) };
  }
  switch (result.kind) {
    case "joined": {
      let kept = true;
      try {
        await keep(result.key);
      } catch {
        kept = false;
      }
      return { kind: "joined", key: result.key, kept };
    }
    case "notRaceLost":
    case "fromBackup":
      return { kind: "back" };
    case "wrongPassphrase":
      return { kind: "wrongPassphrase" };
    case "otherKey":
      return { kind: "otherKey" };
    case "unknown":
      return { kind: "failed", message: LISTING_CUT };
    case "needsUpdate":
      return { kind: "failed", message: NEEDS_UPDATE };
    case "damaged":
      return { kind: "failed", message: "The ledger in the repo can't be read on this device. Everything here is kept." };
  }
}

/** A device sealed under another key than this tab's (unreadable
 * "keyChanged", D32): reopen with the saved key when it is that key
 * (another tab joined and kept it), else ask for the passphrase. */
export function keyChangeStep(needed: { salt: string; iter: number }, saved: DeviceKey | null): { kind: "reopen"; key: DeviceKey } | { kind: "unlock" } {
  return saved !== null && saved.salt === needed.salt && saved.iter === needed.iter ? { kind: "reopen", key: saved } : { kind: "unlock" };
}

/** Opens a device sealed under another key (keyChangeStep's "unlock")
 * with the passphrase: its key derived with the salt and iterations the
 * device names, so no request is needed. One that still doesn't decrypt
 * the device is a wrong passphrase: the engine is stopped, and nothing is
 * kept. */
export async function openSealed(
  connection: Connection,
  passphrase: string,
  needed: { salt: string; iter: number },
  deps: Deps = {},
): Promise<{ kind: "open"; key: DeviceKey; opened: Extract<Opened, { kind: "open" }> } | { kind: "wrongPassphrase" } | { kind: "unreadable" }> {
  // The engine names only a key within a header's bounds (checkMeta); one
  // outside them is never derived.
  if (!isKeyParams(needed.salt, needed.iter)) return { kind: "unreadable" };
  const key = await keyFor(passphrase, needed);
  const opened = await openLedger(connection, key, null, deps);
  if (opened.kind !== "open") return { kind: "wrongPassphrase" };
  const unreadable = opened.engine.getState().unreadable;
  if (unreadable === "undecryptable" || unreadable === "keyChanged") {
    opened.engine.stop();
    return { kind: "wrongPassphrase" };
  }
  return { kind: "open", key, opened };
}

/** "Create a new ledger from this device" (#8, the join from a gone epoch
 * with no ledger left in the repo): a genesis of what this device shows
 * now, as a restore of it, which rejoin then switches the device into,
 * carrying whatever the genesis doesn't already hold. */
export async function createFromDevice(engine: SyncEngine, remote: SyncRemote, key: DeviceKey, by: string, now: () => number = Date.now): Promise<CreateResult> {
  // Based on the gone epoch: should another device's create win a race,
  // the switch to it projects that epoch again and offers this device's
  // changes back, where a genesis alone would leave them nowhere.
  const gone = engine.getState().epochGone?.epoch;
  const basedOn = gone === undefined ? null : { epoch: gone, seen: {} };
  return createLedger(remote, key, { doc: structuredClone(engine.current()), by, at: now(), reason: "restore", basedOn });
}
