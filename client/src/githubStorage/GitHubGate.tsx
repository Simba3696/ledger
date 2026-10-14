import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ModuleName } from "../api";
import { Ledger } from "../App";
import { checkEnvironment } from "../backend/crypto";
import { RepoNotFoundError } from "../backend/github/contents";
import type { Connection } from "../backend/github/deviceStore";
import { damagedFileMessage, findLedger, type LedgerFound } from "../backend/sync/ledgerRepo";
import type { DeviceKey } from "../backend/sync/records";
import type { SyncEngine, SyncRemote } from "../backend/sync/SyncEngine";
import { loadSaved, remember } from "./connection";
import { defaultSections, SECTIONS } from "./defaults";
import { ConnectFailed, connect, createNew, openLedger, remoteFor, unlock, type Deps, type Start, type TokenHolder } from "./ledgerAccess";
import { readInvite } from "./links";
import { ConnectStep } from "./onboarding/ConnectStep";
import { CreateLedger } from "./onboarding/CreateLedger";
import { flow, initialScreen, type FlowEvent, type Path, type Target } from "./onboarding/flow";
import { Blocked, Misconfigured, Unsupported } from "./onboarding/Messages";
import { ReplaceToken } from "./onboarding/ReplaceToken";
import { StepCard } from "./onboarding/Steps";
import { Unlock } from "./onboarding/Unlock";
import { Welcome } from "./onboarding/Welcome";
import { Shell } from "./Shell";
import { SyncHost } from "./sync/SyncHost";
import { SyncPanel } from "./sync/SyncPanel";
import { connectError, OTHER_REPO } from "./token";

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
  token: TokenHolder;
  connection: Connection;
}

export function GitHubGate({ deps = {} }: { deps?: Deps }) {
  const [screen, dispatch] = useReducer(flow, undefined, initialScreen);
  const [started, setStarted] = useState(false);
  const [remembered, setRemembered] = useState(true);
  const [sections, setSections] = useState<readonly ModuleName[]>(SECTIONS);
  const [open, setOpen] = useState<OpenLedger | null>(null);
  /** What the steps found so far: the connection, its repo, the ledger
   * findLedger found, and the key once derived. */
  const work = useRef<{ connection: Connection | null; remote: SyncRemote | null; found: LedgerFound | null; key: DeviceKey | null }>({ connection: null, remote: null, found: null, key: null });
  const startedOnce = useRef(false);

  /** Opens the ledger on this device. False when it couldn't, and the flow
   * was told why. */
  const openWith = useCallback(
    async (connection: Connection, key: DeviceKey, start: Start | null): Promise<boolean> => {
      try {
        const opened = await openLedger(connection, key, start, deps);
        if (opened.kind === "open") {
          setOpen({ engine: opened.engine, token: opened.token, connection });
          return true;
        }
        work.current.found = opened.found;
        if (opened.kind === "keyChanged") dispatch({ type: "keyChanged" });
        else dispatch({ type: "found", target: targetOf(connection), found: foundOf(opened.found) });
      } catch (err) {
        const { message } = connectError(err, targetOf(connection));
        dispatch({ type: "found", target: targetOf(connection), found: { kind: "damaged", message } });
      }
      return false;
    },
    [deps],
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

  // GitHub refused the token while the ledger is open: Replace token. The
  // engine keeps every change on the device meanwhile.
  useEffect(() => {
    if (!open) return;
    const check = () => {
      if (open.engine.getState().status === "needsToken") dispatch({ type: "tokenRejected" });
    };
    check();
    return open.engine.subscribe(check);
  }, [open]);

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

  /** The ledger in the repo now, for Unlock after a create that found one,
   * or on a later start. */
  async function currentLedger(): Promise<LedgerFound> {
    const { connection } = work.current;
    work.current.remote ??= await remoteFor(connection!, deps);
    return findLedger(work.current.remote);
  }

  async function onCreate(passphrase: string, choices: { modules: ModuleName[]; timeZone: string }) {
    const { connection, remote } = work.current;
    if (!connection || !remote) return;
    try {
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
          work.current.found = await currentLedger();
          return dispatch({ type: "created", created: { kind: "exists" } });
        case "replaced":
          work.current.found = await currentLedger();
          return dispatch({ type: "created", created: { kind: "replaced" } });
        case "unknown":
          return dispatch({ type: "created", created: { kind: "unknown" } });
        case "failed":
          return dispatch({ type: "created", created: { kind: "failed", message: result.detail } });
      }
    } catch (err) {
      dispatch({ type: "createFailed", message: connectError(err, targetOf(connection), { write: true }).message });
    }
  }

  async function onUnlock(passphrase: string) {
    const { connection } = work.current;
    if (!connection) return;
    try {
      const found = work.current.found?.kind === "ledger" ? work.current.found : await currentLedger();
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
      dispatch({ type: "found", target: targetOf(connection), found: { kind: "damaged", message: connectError(err, targetOf(connection)).message } });
    }
  }

  async function onReplace(token: string) {
    if (!open) return;
    const target = targetOf(open.connection);
    try {
      const connected = await connect(token, { owner: target.owner, repo: target.repo }, deps);
      const next: Connection = { ...open.connection, token, login: connected.connection.login };
      if (connected.connection.expiresAt) next.expiresAt = connected.connection.expiresAt;
      else delete next.expiresAt;
      open.token.token = token;
      if (work.current.key) setRemembered(await remember(next, work.current.key));
      setOpen({ ...open, connection: next });
      dispatch({ type: "tokenReplaced", target: targetOf(next) });
      void open.engine.syncNow();
    } catch (err) {
      const cause = err instanceof ConnectFailed ? err.cause : err;
      // A token that can't reach this ledger's repo was made for another.
      const message = cause instanceof RepoNotFoundError ? OTHER_REPO : connectError(cause, target).message;
      dispatch({ type: "connectFailed", message, awaitingApproval: false });
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
    return (
      <SyncHost engine={open.engine} bar={<SyncPanel />}>
        <Ledger key={`${open.connection.owner}/${open.connection.repo}`} session={null} />
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
      {screen.kind === "create" && <CreateLedger screen={screen} defaultSections={sections} onCreate={onCreate} onBack={back} />}
      {screen.kind === "unlock" && <Unlock screen={screen} remembered={remembered} onUnlock={onUnlock} onBack={back} />}
      {screen.kind === "blocked" && <Blocked screen={screen} onRetry={() => dispatch({ type: "retry" })} onBack={back} />}
      {screen.kind === "replaceToken" && <ReplaceToken screen={screen} onReplace={onReplace} />}
    </Shell>
  );
}

