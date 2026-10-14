import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ModuleName } from "../api";
import { Ledger } from "../App";
import { installBackend } from "../api";
import { clearSyncState } from "../backend/sync/persist";
import { httpBackend } from "../backend/HttpBackend";
import { checkEnvironment } from "../backend/crypto";
import { DialogHost } from "../components/Dialog";
import { GitHubAuthError, RepoNotFoundError } from "../backend/github/contents";
import type { DocumentBackend } from "../backend/document/DocumentBackend";
import type { Connection } from "../backend/github/deviceStore";
import { compareEpochKeys } from "../backend/sync/epoch";
import { createLedger, damagedFileMessage, findLedger, takeRestoredEpoch, type LedgerFound } from "../backend/sync/ledgerRepo";
import type { DeviceKey } from "../backend/sync/records";
import type { RejoinResult, SyncEngine, SyncRemote } from "../backend/sync/SyncEngine";
import { loadSaved, remember } from "./connection";
import { defaultSections, SECTIONS } from "./defaults";
import { confirmAndForget } from "./forgetFlow";
import { EpochGonePanel } from "./EpochGonePanel";
import { ConnectFailed, connect, createFromDevice, createNew, openLedger, remoteFor, startFromRepo, unlock, type Deps, type Start, type TokenHolder } from "./ledgerAccess";
import { readInvite } from "./links";
import { ConnectStep } from "./onboarding/ConnectStep";
import { CreateLedger } from "./onboarding/CreateLedger";
import { CREATE_UNKNOWN, flow, initialScreen, type FlowEvent, type Path, type Target } from "./onboarding/flow";
import { Blocked, Misconfigured, Unsupported } from "./onboarding/Messages";
import { ReplaceToken } from "./onboarding/ReplaceToken";
import { StepCard } from "./onboarding/Steps";
import { Unlock } from "./onboarding/Unlock";
import { Welcome } from "./onboarding/Welcome";
import { readBackupFile } from "./backup";
import { HeaderActions } from "./HeaderActions";
import { LedgerViewMemory } from "./ledgerView";
import { SectionLoadBoundary } from "./SectionLoadBoundary";
import { warmSections } from "./sectionLoading";
import { Settings } from "./Settings";
import { Shell } from "./Shell";
import { SyncHost } from "./sync/SyncHost";
import { SyncPanel } from "./sync/SyncPanel";
import { connectError, OTHER_REPO, TOKEN_REFUSED } from "./token";

// GitHub mode's gate (#8): from a fresh browser to an open ledger. flow.ts
// decides which screen shows; this does the work each step needs (the
// device store, GitHub, the sync engine) and reports each outcome to it.
// Once a ledger is open, the shared Ledger renders inside #7's SyncHost,
// with a DocumentBackend over the synced document behind api.ts.

type FoundEvent = Extract<FlowEvent, { type: "found" }>["found"];

/** findLedger's answer as the flow takes it. */
function foundOf(found: LedgerFound): FoundEvent {
  switch (found.kind) {
    case "none":
      return { kind: "none" };
    case "ledger":
      return { kind: "ledger" };
    case "needsUpdate":
      return { kind: "needsUpdate" };
    case "malformed":
      return { kind: "damaged", message: damagedFileMessage(found.damagedFile) };
    case "unknown":
      return { kind: "unknown" };
  }
}

/** The repo a connection reaches. Owned by another account than the
 * token's own: an organization (a household). */
function targetOf(connection: Connection): Target {
  return { owner: connection.owner, repo: connection.repo, ownerIsOrg: connection.owner.toLowerCase() !== connection.login.toLowerCase() };
}

interface OpenLedger {
  engine: SyncEngine;
  backend: DocumentBackend;
  token: TokenHolder;
  remote: SyncRemote;
  connection: Connection;
}

/** The token was refused (a 401), however it reached the gate. */
function tokenRefused(err: unknown): boolean {
  return (err instanceof ConnectFailed ? err.cause : err) instanceof GitHubAuthError;
}

/** Replace token refuses another account's token: the engine and every
 * record stamp carry the login this device joined with. */
function otherAccount(login: string): string {
  return `This token belongs to another GitHub account. Use a token from ${login}'s account.`;
}

export function GitHubGate({ deps = {} }: { deps?: Deps }) {
  const [screen, dispatch] = useReducer(flow, undefined, initialScreen);
  const [started, setStarted] = useState(false);
  const [remembered, setRemembered] = useState(true);
  const [sections, setSections] = useState<readonly ModuleName[]>(SECTIONS);
  const [open, setOpen] = useState<OpenLedger | null>(null);
  /** Settings shows in the ledger's place (#8); saving there bumps the
   * revision the ledger is keyed on, so it remounts and reads the sections
   * again. */
  const [view, setView] = useState<"ledger" | "settings">("ledger");
  const [settingsRevision, setSettingsRevision] = useState(0);
  // The Ledger's open tab and month, kept across the remount a change from
  // another device causes, and across Settings (ledgerView.ts).
  const [ledgerViews] = useState(() => new LedgerViewMemory());
  /** After a reload that followed a restore: whether it landed (#9). */
  const [restoreNote, setRestoreNote] = useState<string | null>(null);
  /** Settings' backup was interrupted by a refused token (#9). */
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  /** What the steps found so far: the connection, its repo, the ledger
   * findLedger found, and the key once derived or loaded. */
  const work = useRef<{ connection: Connection | null; remote: SyncRemote | null; found: LedgerFound | null; key: DeviceKey | null }>({ connection: null, remote: null, found: null, key: null });
  const startedOnce = useRef(false);
  /** forgotten(), for the engine watcher (an effect that outlives renders). */
  const forgottenRef = useRef<() => void>(() => {});

  /** A step failed on GitHub: a refused token goes to Replace token (which
   * keeps everything on the device); anything else is told and can be
   * tried again. */
  const failed = useCallback((err: unknown, connection: Connection) => {
    if (tokenRefused(err)) return dispatch({ type: "tokenRejected" });
    const cause = err instanceof ConnectFailed ? err.cause : err;
    dispatch({ type: "found", target: targetOf(connection), found: { kind: "damaged", message: connectError(cause, targetOf(connection)).message } });
  }, []);

  /** Opens the ledger on this device. False when it couldn't, and the flow
   * was told why. */
  const openWith = useCallback(
    async (connection: Connection, key: DeviceKey, start: Start | null): Promise<boolean> => {
      try {
        const opened = await openLedger(connection, key, start, deps);
        if (opened.kind === "open") {
          // The reload after a restore (#9): did this tab's restore land, or
          // did another win? (takeRestoredEpoch)
          const mine = takeRestoredEpoch();
          const now = opened.engine.epochKey;
          if (mine !== null && now !== null) {
            if (now === mine) setRestoreNote("Restored from the backup.");
            else if (compareEpochKeys(now, mine) > 0) setRestoreNote("Someone else restored a backup at the same time, and theirs is the ledger now. Restore yours again from Settings if you still need it.");
            else setRestoreNote("Your restore may still be on its way to GitHub. Ledger switches to it once it lands.");
          }
          work.current.remote = opened.remote;
          work.current.connection = connection;
          setOpen({ engine: opened.engine, backend: opened.backend, token: opened.token, remote: opened.remote, connection });
          return true;
        }
        work.current.found = opened.found;
        if (opened.kind === "keyChanged") dispatch({ type: "keyChanged" });
        else dispatch({ type: "found", target: targetOf(connection), found: foundOf(opened.found) });
      } catch (err) {
        failed(err, connection);
      }
      return false;
    },
    [deps, failed],
  );

  // Start: the browser, this build's settings, what this device saved, and
  // an invite link. Once only (StrictMode runs effects twice in dev); the
  // engine lives as long as the page.
  useEffect(() => {
    if (startedOnce.current) return;
    startedOnce.current = true;
    void (async () => {
      const environment = checkEnvironment();
      const defaults = defaultSections();
      if (defaults.ok) setSections(defaults.sections);
      // An unsupported browser makes no request and reads nothing.
      const saved = environment.ok ? await loadSaved() : { connection: null, key: null, remembered: true };
      setRemembered(saved.remembered);
      work.current.connection = saved.connection;
      work.current.key = saved.key;
      dispatch({
        type: "start",
        environment: environment.ok ? { ok: true } : { ok: false, message: environment.message },
        defaults: defaults.ok ? { ok: true } : { ok: false, message: defaults.message },
        saved: saved.connection ? { target: targetOf(saved.connection), hasKey: saved.key !== null } : null,
        invite: readInvite(globalThis.location?.search ?? ""),
      });
      setStarted(true);
      if (environment.ok && defaults.ok && saved.connection && saved.key) await openWith(saved.connection, saved.key, null);
    })();
  }, [openWith]);

  // While a ledger is open: GitHub refusing the token goes to Replace token
  // when it starts (not on every later change, so a replacement isn't
  // undone by the cycle still finishing with the old one), and a first
  // start that had to wait (another tab held the lock, or "Start as a new
  // device") runs once the engine can take it.
  // It depends on the engine alone: Replace token swaps the connection
  // while the engine still reports the refusal, and re-running here then
  // would forget it was already told.
  // Once a ledger is open, every section is loaded while online, so each
  // one opens offline later (sectionLoading.ts).
  const ledgerOpen = open !== null;
  useEffect(() => (ledgerOpen ? warmSections() : undefined), [ledgerOpen]);

  const engine = open?.engine ?? null;
  const remote = open?.remote ?? null;
  useEffect(() => {
    if (!engine || !remote) return;
    let last: string | null = null;
    let joining = false;
    const check = () => {
      const state = engine.getState();
      if (state.status === "needsToken" && last !== "needsToken") dispatch({ type: "tokenRejected" });
      last = state.status;
      const key = work.current.key;
      if (state.needsInit && state.status !== "locked" && !joining && key) {
        joining = true;
        void (async () => {
          try {
            // Forgotten in another tab meanwhile (it freed the lock this tab
            // was waiting for): rejoining would write the ledger back to a
            // device the person just cleared.
            const saved = await loadSaved();
            if (saved.remembered && !saved.connection) {
              engine.stop();
              forgottenRef.current();
              return;
            }
            const from = await startFromRepo(remote, key);
            if (from.kind === "start") return void (await engine.initialize(from.start.epoch, from.start.state, { sha: from.start.sha, state: from.start.state }));
            engine.stop();
            setOpen(null);
            work.current.found = from.found;
            if (from.kind === "keyChanged") dispatch({ type: "keyChanged" });
            else if (work.current.connection) dispatch({ type: "found", target: targetOf(work.current.connection), found: foundOf(from.found) });
          } catch (err) {
            if (work.current.connection) failed(err, work.current.connection);
          } finally {
            joining = false;
          }
        })();
      }
    };
    check();
    return engine.subscribe(check);
  }, [engine, remote, failed]);

  async function onConnect(path: Path, token: string, owner: string | null, repo: string) {
    try {
      const connected = await connect(token, { owner, repo }, deps);
      work.current = { connection: connected.connection, remote: connected.remote, found: connected.found, key: null };
      dispatch({ type: "found", target: targetOf(connected.connection), found: foundOf(connected.found) });
    } catch (err) {
      const cause = err instanceof ConnectFailed ? err.cause : err;
      const tried = err instanceof ConnectFailed ? err.owner : owner;
      const { message, awaitingApproval } = connectError(cause, { owner: tried ?? "your account", repo, ownerIsOrg: path !== "personal" && tried !== null });
      dispatch({ type: "connectFailed", message, awaitingApproval });
    }
  }

  /** The repo of the connection the steps hold, built from the saved one on
   * a later start. */
  async function currentRemote(connection: Connection): Promise<SyncRemote> {
    work.current.remote ??= await remoteFor(connection, deps);
    return work.current.remote;
  }

  async function onCreate(passphrase: string, choices: { modules: ModuleName[]; timeZone: string }) {
    const { connection } = work.current;
    if (!connection) return;
    try {
      const remote = await currentRemote(connection);
      const { key, result } = await createNew({ connection, remote }, passphrase, choices);
      switch (result.kind) {
        case "created": {
          work.current.key = key;
          setRemembered(await remember(connection, key));
          if (await openWith(connection, key, { epoch: result.epoch, sha: result.sha, state: result.state })) dispatch({ type: "created", created: { kind: "created" } });
          return;
        }
        case "exists":
          if (result.damagedFile) return dispatch({ type: "created", created: { kind: "failed", message: damagedFileMessage(result.damagedFile) } });
          work.current.found = await findLedger(remote);
          return dispatch({ type: "created", created: { kind: "exists" } });
        case "replaced":
          work.current.found = await findLedger(remote);
          return dispatch({ type: "created", created: { kind: "replaced" } });
        case "unknown":
          return dispatch({ type: "created", created: { kind: "unknown" } });
        case "failed":
          return dispatch({ type: "created", created: { kind: "failed", message: result.detail } });
      }
    } catch (err) {
      if (tokenRefused(err)) return dispatch({ type: "tokenRejected" });
      dispatch({ type: "createFailed", message: connectError(err, targetOf(connection), { write: true }).message });
    }
  }

  /** Create's "start from a backup" (#9): a new ledger holding the backup,
   * under the backup's own passphrase (its header's salt and iterations),
   * then opened as Create opens one. An error to show, or null. */
  async function onRestoreBackup(file: File, passphrase: string): Promise<string | null> {
    const { connection } = work.current;
    if (!connection) return null;
    try {
      const read = await readBackupFile(file, null, passphrase);
      if (!read.ok) return read.needsPassphrase ? "Enter the backup's passphrase." : read.message;
      const remote = await currentRemote(connection);
      const result = await createLedger(remote, read.key, { doc: read.doc, by: connection.login, at: Date.now(), reason: "restore" });
      switch (result.kind) {
        case "created":
          work.current.key = read.key;
          setRemembered(await remember(connection, read.key));
          if (await openWith(connection, read.key, { epoch: result.epoch, sha: result.sha, state: result.state })) dispatch({ type: "created", created: { kind: "created" } });
          return null;
        case "exists":
          if (result.damagedFile) return damagedFileMessage(result.damagedFile);
          work.current.found = await findLedger(remote);
          dispatch({ type: "created", created: { kind: "exists" } });
          return null;
        case "replaced":
          work.current.found = await findLedger(remote);
          dispatch({ type: "created", created: { kind: "replaced" } });
          return null;
        case "unknown":
          dispatch({ type: "created", created: { kind: "unknown" } });
          return null;
        case "failed":
          return result.detail;
        case "tooLarge":
          return `This backup is too large to restore: ${result.detail}`;
      }
    } catch (err) {
      if (tokenRefused(err)) {
        dispatch({ type: "tokenRejected" });
        return null;
      }
      return connectError(err, targetOf(connection), { write: true }).message;
    }
  }

  async function onUnlock(passphrase: string) {
    const { connection } = work.current;
    if (!connection) return;
    try {
      const found = work.current.found?.kind === "ledger" ? work.current.found : await findLedger(await currentRemote(connection));
      if (found.kind !== "ledger") return dispatch({ type: "found", target: targetOf(connection), found: foundOf(found) });
      const opened = await unlock(found, passphrase);
      if (!opened.ok) {
        if (opened.problem === "wrongPassphrase") return dispatch({ type: "wrongPassphrase" });
        if (opened.problem === "needsUpdate") return dispatch({ type: "found", target: targetOf(connection), found: { kind: "needsUpdate" } });
        const message = "damagedFile" in opened && opened.damagedFile ? damagedFileMessage(opened.damagedFile) : "The ledger's first file can't be read. Try again later.";
        return dispatch({ type: "found", target: targetOf(connection), found: { kind: "damaged", message } });
      }
      work.current.key = opened.key;
      setRemembered(await remember(connection, opened.key));
      if (await openWith(connection, opened.key, opened.start)) dispatch({ type: "unlocked" });
    } catch (err) {
      failed(err, connection);
    }
  }

  /** A new token for the same repo and account. With a ledger open, the
   * running engine's requests carry it from now on; before one is (a 401
   * while unlocking or on a later start), the gate goes on from where it
   * stopped. */
  async function onReplace(token: string) {
    const error = await replaceToken(token);
    if (error) dispatch({ type: "connectFailed", message: error, awaitingApproval: false });
  }

  /** onReplace's work, shared with Settings: what to tell the person, or
   * null once the new token is in use. */
  async function replaceToken(token: string): Promise<string | null> {
    const connection = open?.connection ?? work.current.connection;
    if (!connection) return null;
    const target = targetOf(connection);
    try {
      const connected = await connect(token, { owner: target.owner, repo: target.repo }, deps);
      if (connected.connection.login.toLowerCase() !== connection.login.toLowerCase()) return otherAccount(connection.login);
      const next: Connection = { ...connection, token };
      if (connected.connection.expiresAt) next.expiresAt = connected.connection.expiresAt;
      else delete next.expiresAt;
      work.current.connection = next;
      work.current.found = connected.found;
      const key = work.current.key;
      if (open) {
        open.token.token = token;
        if (key) setRemembered(await remember(next, key));
        setOpen({ ...open, connection: next });
        dispatch({ type: "tokenReplaced", target: targetOf(next) });
        void open.engine.syncNow();
        return null;
      }
      work.current.remote = connected.remote;
      if (key) {
        setRemembered(await remember(next, key));
        if (await openWith(next, key, null)) dispatch({ type: "opened", target: targetOf(next) });
        return null;
      }
      dispatch({ type: "found", target: targetOf(next), found: foundOf(connected.found) });
      return null;
    } catch (err) {
      const cause = err instanceof ConnectFailed ? err.cause : err;
      // A token that can't reach this repo was made for another one, or, in
      // an organization, may still wait for an owner's approval.
      return cause instanceof RepoNotFoundError && !target.ownerIsOrg ? OTHER_REPO : connectError(cause, target).message;
    }
  }

  /** A restore landed (#9): this device's sync state is cleared and the
   * page reloads, so it starts in the restored epoch afresh, joined with
   * the saved key (SyncEngine.restore's contract). */
  async function afterRestore(): Promise<void> {
    await clearSyncState();
    globalThis.location.reload();
  }

  /** Forget this device finished: nothing of it is left here. */
  function forgotten() {
    // api.ts lets go of the old ledger's backend (and its document).
    installBackend(httpBackend);
    setOpen(null);
    setView("ledger");
    work.current = { connection: null, remote: null, found: null, key: null };
    dispatch({ type: "forgotten" });
  }

  forgottenRef.current = forgotten;

  /** Forget this device from a screen that can't open the ledger (a dead
   * token, a ledger that won't open): the open engine, if there is one,
   * tells what's unsaved. Resolves to an error to show, or null. */
  async function onForget(): Promise<string | null> {
    const outcome = await confirmAndForget(open?.engine ?? null);
    if (outcome.kind === "forgotten") forgotten();
    return outcome.kind === "failed" ? outcome.message : null;
  }

  /** "Create a new ledger from this device" (no ledger left in the repo):
   * a genesis of what it shows, then the join into it. A ledger that
   * appeared meanwhile (another device's, or a create that won a race) is
   * joined instead. What rejoin answered, or an error to show. */
  async function onCreateFromDevice(): Promise<RejoinResult | string> {
    const key = work.current.key;
    if (!open || !key) return "This device can't create a ledger now.";
    try {
      const created = await createFromDevice(open.engine, open.remote, key, open.connection.login);
      if (created.kind === "unknown") return CREATE_UNKNOWN;
      if (created.kind === "failed") return created.detail;
      if (created.kind === "tooLarge") return `This device's ledger is too large to save as one file: ${created.detail}`;
      if (created.kind === "exists" && created.damagedFile) return damagedFileMessage(created.damagedFile);
      return await open.engine.rejoin();
    } catch (err) {
      if (tokenRefused(err)) {
        dispatch({ type: "tokenRejected" });
        return TOKEN_REFUSED;
      }
      return connectError(err, targetOf(open.connection), { write: true }).message;
    }
  }

  /** Try again from a blocked screen: with what this device saved, open
   * the ledger again; with a connection from the steps, look at the repo
   * again; with neither, back to the connect card. */
  async function onRetry() {
    const { connection, key } = work.current;
    if (!connection) return dispatch({ type: "retry" });
    if (key && !open) {
      if (await openWith(connection, key, null)) dispatch({ type: "opened", target: targetOf(connection) });
      return;
    }
    try {
      const found = await findLedger(await currentRemote(connection));
      work.current.found = found;
      dispatch({ type: "found", target: targetOf(connection), found: foundOf(found) });
    } catch (err) {
      failed(err, connection);
    }
  }

  if (!started) {
    return (
      <Shell>
        <p className="sync-message">Loading...</p>
      </Shell>
    );
  }

  if (screen.kind === "app") {
    if (!open) {
      return (
        <Shell>
          <p className="sync-message">Opening your ledger...</p>
        </Shell>
      );
    }
    const target = targetOf(open.connection);
    const viewSlot = ledgerViews.slot(`${target.owner}/${target.repo}`, () => {
      try {
        return open.engine.current().settings.modules;
      } catch {
        return null;
      }
    });
    return (
      // Settings goes in the bar, outside the part SyncHost re-keys on
      // every join, so a change from another device doesn't remount it
      // (and lose what's typed, or an open dialog).
      <SyncHost
        engine={open.engine}
        bar={
          <>
            <SyncPanel />
            {restoreNote && (
              <p className="sync-message-line" role="status" data-testid="gh-restore-note">
                {restoreNote}{" "}
                <button type="button" className="gh-secondary" onClick={() => setRestoreNote(null)}>
                  OK
                </button>
              </p>
            )}
            <EpochGonePanel engine={open.engine} onCreate={onCreateFromDevice} onForget={onForget} />
            {view === "settings" && (
              <Shell>
                <Settings
              engine={open.engine}
              backend={open.backend}
              connection={{ ...target, login: open.connection.login, expiresAt: open.connection.expiresAt }}
              onDone={(changed) => {
                setBackupNotice(null);
                if (changed) setSettingsRevision((n) => n + 1);
                setView("ledger");
              }}
              onReplaceToken={replaceToken}
              onForgotten={forgotten}
              deviceKey={work.current.key}
              backupNotice={backupNotice}
              onRestored={afterRestore}
              onTokenRejected={() => {
                setBackupNotice("GitHub refused the token, so nothing was restored. Pick the backup file again.");
                dispatch({ type: "tokenRejected" });
              }}
            />
              </Shell>
            )}
          </>
        }
      >
        {view === "ledger" && (
          // headerActions and view are read inside Ledger's GitHub-only
          // branches (App.tsx, #8 decision 16).
          // A section that can't be loaded (offline) shows a message, not a
          // blank screen (SectionLoadBoundary.tsx).
          <SectionLoadBoundary onHome={() => ledgerViews.goHome()} saving={() => open.engine.writing || open.engine.getState().pendingCount > 0}>
            <Ledger
              key={`${target.owner}/${target.repo}#${settingsRevision}`}
              session={null}
              headerActions={<HeaderActions onSettings={() => setView("settings")} />}
              view={viewSlot}
            />
          </SectionLoadBoundary>
        )}
      </SyncHost>
    );
  }

  const back = () => dispatch({ type: "back" });
  return (
    <Shell>
      {screen.kind === "unsupported" && <Unsupported screen={screen} />}
      {screen.kind === "misconfigured" && <Misconfigured screen={screen} />}
      {screen.kind === "welcome" && <Welcome onChoose={(path) => dispatch({ type: "choose", path })} />}
      {screen.kind === "step" && screen.step !== "connect" && (
        <StepCard screen={screen} onOrg={(org) => dispatch({ type: "org", org })} onBack={back} onNext={() => dispatch({ type: "next" })} />
      )}
      {screen.kind === "step" && screen.step === "connect" && <ConnectStep key={screen.path} screen={screen} onConnect={(token, owner, repo) => onConnect(screen.path, token, owner, repo)} onBack={back} />}
      {screen.kind === "create" && <CreateLedger screen={screen} defaultSections={sections} remembered={remembered} onCreate={onCreate} onRestoreBackup={onRestoreBackup} onBack={back} />}
      {screen.kind === "unlock" && <Unlock screen={screen} remembered={remembered} onUnlock={onUnlock} onBack={back} />}
      {screen.kind === "blocked" && <Blocked screen={screen} onRetry={() => void onRetry()} onBack={back} onForget={work.current.connection ? onForget : undefined} />}
      {screen.kind === "replaceToken" && <ReplaceToken screen={screen} onReplace={onReplace} onForget={onForget} />}
      <DialogHost />
    </Shell>
  );
}

