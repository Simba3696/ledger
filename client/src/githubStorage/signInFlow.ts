import { AppNotInstalledError, SIGN_IN_EXPIRED, SIGN_IN_INCOMPLETE, type AppTokens, type SignInResult } from "../backend/github/appAuth";
import { GitHubAuthError, RepoNotFoundError } from "../backend/github/contents";
import type { Connection } from "../backend/github/deviceStore";
import { appSessionFor, ConnectFailed, connect, OtherAccountError, type Connected, type Deps } from "./ledgerAccess";
import { STEPS, type FlowEvent, type Path } from "./onboarding/flow";
import { connectError, OTHER_REPO } from "./token";

// The gate's Sign in with GitHub decisions (#10), one function each, so
// they are tested without React: what a return from github.com leads to,
// replacing a connection's credentials with a pasted token or a new
// sign-in, connecting with a sign-in (or the install prompt), and the
// sign-in-expired Replace token screen. GitHubGate.tsx does the rest.

/** Shown after installing the App from the install prompt, in the tab
 * GitHub opened for it. */
export const INSTALLED = "Ledger's GitHub App now has access. Go back to the tab where you signed in and choose Check again.";

/** Replace token refuses another account's credentials: the engine and
 * every record stamp carry the login this device joined with. */
function otherAccount(login: string): string {
  return `This token belongs to another GitHub account. Use a token from ${login}'s account.`;
}

const isPath = (path: string | null): path is Path => path !== null && Object.hasOwn(STEPS, path);

export type ReturnPlan =
  | { kind: "none" }
  /** Say this, and start as usual. */
  | { kind: "notice"; message: string }
  /** Signed in again from Replace token: these tokens replace the saved ones. */
  | { kind: "replace"; tokens: AppTokens }
  /** Signing in again from Replace token failed: back to it, with this. */
  | { kind: "replaceFailed"; message: string }
  /** Nothing saved yet: the connect card the sign-in started on, then
   * connecting with these tokens (none when it failed). */
  | { kind: "connect"; event: Extract<FlowEvent, { type: "signInReturned" }>; tokens: AppTokens | null };

/** What the gate does on a page load with completeSignIn()'s result, given
 * whether this device has a saved connection. A return this tab didn't
 * start a sign-in for (no resume) is only a notice. */
export function planReturn(result: SignInResult, hasSaved: boolean): ReturnPlan {
  if (result.kind === "none") return { kind: "none" };
  if (result.kind === "installed") return { kind: "notice", message: INSTALLED };
  if (result.resume === null) return { kind: "notice", message: result.kind === "failed" ? result.message : SIGN_IN_INCOMPLETE };
  if (hasSaved) return result.kind === "signedIn" ? { kind: "replace", tokens: result.tokens } : { kind: "replaceFailed", message: result.message };
  const { resume } = result;
  return {
    kind: "connect",
    event: {
      type: "signInReturned",
      path: isPath(resume.path) ? resume.path : "personal",
      org: resume.org,
      owner: resume.owner,
      repo: resume.repo,
      error: result.kind === "failed" ? result.message : null,
    },
    tokens: result.kind === "signedIn" ? result.tokens : null,
  };
}

export type Replaced = { ok: true; next: Connection; connected: Connected } | { ok: false; message: string };

/** Replace token's check (#8), for a pasted token or a new sign-in's
 * tokens: the same account first, then the same repo. On success, the
 * connection to keep: a pasted token makes it kind "pat" (any App fields
 * go), a sign-in kind "app" (the record its session refreshes into). */
export async function replaceCredentials(connection: Connection, credentials: string | AppTokens, deps: Deps): Promise<Replaced> {
  const target = { owner: connection.owner, repo: connection.repo, ownerIsOrg: connection.owner.toLowerCase() !== connection.login.toLowerCase() };
  try {
    const connected = await connect(credentials, target, deps, { login: connection.login });
    if (typeof credentials !== "string") return { ok: true, next: connected.connection, connected };
    const next: Connection = { ...connection, kind: "pat", token: credentials };
    delete next.refreshToken;
    delete next.refreshTokenExpiresAt;
    if (connected.connection.expiresAt) next.expiresAt = connected.connection.expiresAt;
    else delete next.expiresAt;
    return { ok: true, next, connected };
  } catch (err) {
    const cause = err instanceof ConnectFailed ? err.cause : err;
    if (cause instanceof OtherAccountError) return { ok: false, message: otherAccount(connection.login) };
    // A sign-in whose App doesn't reach this repo is for another one.
    if (cause instanceof AppNotInstalledError) return { ok: false, message: OTHER_REPO };
    if (typeof credentials !== "string" && cause instanceof GitHubAuthError) return { ok: false, message: SIGN_IN_INCOMPLETE };
    // A token that can't reach this repo was made for another one, or, in
    // an organization, may still wait for an owner's approval.
    if (cause instanceof RepoNotFoundError && !target.ownerIsOrg) return { ok: false, message: OTHER_REPO };
    return { ok: false, message: connectError(cause, target).message };
  }
}

export type SignedInConnect = { kind: "connected"; connected: Connected } | { kind: "install"; owner: string; repo: string } | { kind: "failed"; message: string };

/** Back from signing in with nothing saved: connects with the App's token
 * as a pasted one connects, or asks for the App to be installed on the
 * repo (Check again calls this again with the same tokens). */
export async function connectSignedIn(path: Path, tokens: AppTokens, owner: string | null, repo: string, deps: Deps): Promise<SignedInConnect> {
  try {
    return { kind: "connected", connected: await connect(tokens, { owner, repo }, deps) };
  } catch (err) {
    const cause = err instanceof ConnectFailed ? err.cause : err;
    if (cause instanceof AppNotInstalledError) return { kind: "install", owner: cause.owner, repo: cause.repo };
    if (cause instanceof GitHubAuthError) return { kind: "failed", message: SIGN_IN_INCOMPLETE };
    const tried = err instanceof ConnectFailed ? err.owner : owner;
    return { kind: "failed", message: connectError(cause, { owner: tried ?? "your account", repo, ownerIsOrg: path !== "personal" && tried !== null }).message };
  }
}

/** On Replace token: an App session that GitHub refused even after a
 * refresh ends, here and in the saved record (unless another tab has
 * refreshed it since). Unsynced changes stay in the sync state. */
export function expireOnReplace(connection: Connection | null, deps: Deps): Promise<void> {
  return connection?.kind === "app" ? appSessionFor(connection, deps).expire() : Promise.resolve();
}

/** What Replace token says in an App session, and whether it offers the
 * Sign in with GitHub button (not without this build's sign-in). Null for
 * a pasted token's connection, which #8's screen covers. */
export function replaceSignIn(kind: Connection["kind"] | undefined, configured: boolean): { message: string; canSignIn: boolean } | null {
  if (kind !== "app") return null;
  return { message: SIGN_IN_EXPIRED, canSignIn: configured };
}
