import { OTHER_REPO } from "../token";
import { DEFAULT_REPO_NAME } from "../links";

// The GitHub gate's screens and the moves between them (#8): a pure
// reducer, no React and no network, so every path is tested on its own.
// The gate does the work (checkEnvironment, findLedger, createLedger,
// openGenesis, initialize) and reports each outcome here as an event.

/** The three ways in from Welcome. */
export type Path = "personal" | "household" | "member";

/** One walkthrough card. "connect" is the paste-the-token card that ends
 * every path. */
export type Step = "org" | "repo" | "policy" | "members" | "accept" | "token" | "connect";

export const STEPS: Record<Path, readonly Step[]> = {
  // Just me: create the repo, create the token, paste it.
  personal: ["repo", "token", "connect"],
  // Setting up a household: an organization, its repo, its token policy,
  // inviting members, the owner's own token, paste it.
  household: ["org", "repo", "policy", "members", "token", "connect"],
  // Joining one: accept the invitation, create a token, paste it.
  member: ["accept", "token", "connect"],
};

/** The repo a ledger lives in. */
export interface Target {
  owner: string;
  repo: string;
  /** An organization (a household), whose tokens may wait for approval. */
  ownerIsOrg: boolean;
}

/** Why Unlock is asking for the passphrase. */
type UnlockReason =
  /** Connecting found a ledger. */
  | "existing"
  /** Someone created the ledger while this device was creating one. */
  | "createdMeanwhile"
  /** Another device's create won the race (createLedger "replaced", D32). */
  | "raceLost"
  /** The saved key doesn't open the ledger now (its passphrase changed, or
   * a racing create's winner used another salt). */
  | "keyChanged";

export type Screen =
  | { kind: "unsupported"; message: string }
  | { kind: "misconfigured"; message: string }
  | { kind: "welcome" }
  | {
      kind: "step";
      path: Path;
      step: Step;
      /** The organization: typed on the household path, or the invite's. */
      org: string | null;
      /** The repo's owner when known before connecting (an invite's, or the
       * organization); the personal path uses the token's login. */
      owner: string | null;
      repo: string;
      error: string | null;
      /** A 404 from an organization's repo: the token may await approval,
       * so the card offers "Check again". */
      awaitingApproval: boolean;
    }
  /** `path`: the walkthrough path that led here (Back returns to its
   * connect card), or null on a later start. */
  | { kind: "create"; target: Target; path: Path | null; error: string | null }
  /** `joining`: the race-lost Unlock over an open ledger (D32): Back and a
   * join go back to it. */
  | { kind: "unlock"; target: Target; path: Path | null; reason: UnlockReason; error: string | null; joining?: true }
  /** Nothing to do here but read, and perhaps try again. */
  | { kind: "blocked"; target: Target | null; path: Path | null; message: string; retry: boolean }
  | { kind: "replaceToken"; target: Target; error: string | null }
  | { kind: "app"; target: Target };

/** What findLedger found, as the gate reports it. */
type Found =
  | { kind: "none" }
  | { kind: "ledger" }
  | { kind: "needsUpdate" }
  /** A genesis the app can't read, named for the person to fix on GitHub
   * (damagedFileMessage, D26). */
  | { kind: "damaged"; message: string }
  /** GitHub cut the listing short: nothing can be decided. */
  | { kind: "unknown" };

/** What createLedger answered, as the gate reports it. */
type Created =
  | { kind: "created" }
  | { kind: "exists" }
  | { kind: "replaced" }
  | { kind: "unknown" }
  /** A damaged file is in the way (named), or the create failed. */
  | { kind: "failed"; message: string };

export type FlowEvent =
  | {
      type: "start";
      /** checkEnvironment(): a browser that can't run Ledger at all. */
      environment: { ok: true } | { ok: false; message: string };
      /** VITE_DEFAULT_MODULES: a misconfigured copy of Ledger. */
      defaults: { ok: true } | { ok: false; message: string };
      /** A saved connection, and whether a key is saved for its ledger. */
      saved: { target: Target; hasKey: boolean } | null;
      /** An invite link's repo (readInvite). */
      invite: { owner: string; repo: string } | null;
    }
  | { type: "choose"; path: Path }
  | { type: "org"; org: string }
  | { type: "next" }
  | { type: "back" }
  | { type: "connectFailed"; message: string; awaitingApproval: boolean }
  | { type: "found"; target: Target; found: Found }
  | { type: "created"; created: Created }
  | { type: "createFailed"; message: string }
  | { type: "unlocked" }
  | { type: "wrongPassphrase" }
  | { type: "keyChanged" }
  /** The open ledger lost a racing create (D32): join the winner. */
  | { type: "joinRace" }
  /** That join met two different passphrases (D35's way on). */
  | { type: "raceOtherKey" }
  /** Unlock couldn't go on, for a reason it says. */
  | { type: "unlockFailed"; message: string }
  | { type: "tokenRejected" }
  | { type: "tokenReplaced"; target: Target }
  /** The gate opened the ledger itself (a retry with what was saved). */
  | { type: "opened"; target: Target }
  | { type: "retry" }
  | { type: "forgotten" }
  /** Back from signing in with GitHub (#10) with nothing saved yet: the
   * connect card of the path the sign-in started on, for the repo it was
   * aimed at, with what went wrong if it failed. */
  | { type: "signInReturned"; path: Path; org: string | null; owner: string | null; repo: string; error: string | null };

export const WRONG_PASSPHRASE = "Wrong passphrase";
export const NEEDS_UPDATE = "This ledger was saved by a newer version of Ledger. Update the app to open it.";
export const LISTING_CUT = "Couldn't read the whole repository from GitHub. Try again.";
export const RACE_OTHER_KEY = "";
export const CREATE_UNKNOWN = "Couldn't confirm with GitHub that the ledger was saved. Try again.";

function stepScreen(path: Path, step: Step, from: Partial<Extract<Screen, { kind: "step" }>> = {}): Extract<Screen, { kind: "step" }> {
  return { kind: "step", path, step, org: null, owner: null, repo: DEFAULT_REPO_NAME, ...from, error: null, awaitingApproval: false };
}

/** The connect card again, on the path that led here, for the repo
 * connecting was aimed at. A later start has no path: the owner tells. */
function backToConnect(target: Target | null, path: Path | null): Screen {
  if (target === null) return { kind: "welcome" };
  const on = path ?? (target.ownerIsOrg ? "member" : "personal");
  return stepScreen(on, "connect", { owner: target.owner, repo: target.repo, org: target.ownerIsOrg ? target.owner : null });
}

/** The walkthrough path of the screen an outcome arrives on. */
function pathOf(screen: Screen): Path | null {
  return screen.kind === "step" || screen.kind === "create" || screen.kind === "unlock" || screen.kind === "blocked" ? screen.path : null;
}

const sameRepo = (a: Target, b: Target) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

export function initialScreen(): Screen {
  return { kind: "welcome" };
}

export function flow(screen: Screen, event: FlowEvent): Screen {
  switch (event.type) {
    case "start":
      if (!event.environment.ok) return { kind: "unsupported", message: event.environment.message };
      if (!event.defaults.ok) return { kind: "misconfigured", message: event.defaults.message };
      if (event.saved !== null) return event.saved.hasKey ? { kind: "app", target: event.saved.target } : { kind: "unlock", target: event.saved.target, path: null, reason: "existing", error: null };
      if (event.invite !== null) return stepScreen("member", "accept", { org: event.invite.owner, owner: event.invite.owner, repo: event.invite.repo });
      return { kind: "welcome" };

    case "choose":
      if (screen.kind !== "welcome") return screen;
      return stepScreen(event.path, STEPS[event.path][0]);

    case "org":
      if (screen.kind !== "step") return screen;
      return { ...screen, org: event.org, owner: event.org };

    case "next": {
      if (screen.kind !== "step") return screen;
      const steps = STEPS[screen.path];
      const at = steps.indexOf(screen.step);
      // A household path can't go on without its organization's name:
      // every later link, and the repo joined, are built from it.
      if ((screen.step === "org" || screen.step === "accept") && !screen.org) return screen;
      return at < steps.length - 1 ? { ...screen, step: steps[at + 1], error: null, awaitingApproval: false } : screen;
    }

    case "back": {
      if (screen.kind === "step") {
        const steps = STEPS[screen.path];
        const at = steps.indexOf(screen.step);
        return at > 0 ? { ...screen, step: steps[at - 1], error: null, awaitingApproval: false } : { kind: "welcome" };
      }
      if (screen.kind === "create" || screen.kind === "unlock" || screen.kind === "blocked") return backToConnect(screen.target, screen.path);
      return screen;
    }

    case "connectFailed":
      if (screen.kind === "step") return { ...screen, error: event.message, awaitingApproval: event.awaitingApproval };
      if (screen.kind === "replaceToken") return { ...screen, error: event.message };
      return screen;

    case "found": {
      const path = pathOf(screen);
      switch (event.found.kind) {
        case "none":
          return { kind: "create", target: event.target, path, error: null };
        case "ledger":
          return { kind: "unlock", target: event.target, path, reason: "existing", error: null };
        case "needsUpdate":
          return { kind: "blocked", target: event.target, path, message: NEEDS_UPDATE, retry: false };
        case "damaged":
          return { kind: "blocked", target: event.target, path, message: event.found.message, retry: true };
        case "unknown":
          return { kind: "blocked", target: event.target, path, message: LISTING_CUT, retry: true };
      }
      return screen;
    }

    case "created": {
      if (screen.kind !== "create") return screen;
      const { target, path } = screen;
      switch (event.created.kind) {
        case "created":
          return { kind: "app", target };
        case "exists":
          return { kind: "unlock", target, path, reason: "createdMeanwhile", error: null };
        case "replaced":
          return { kind: "unlock", target, path, reason: "raceLost", error: null };
        case "unknown":
          return { kind: "blocked", target, path, message: CREATE_UNKNOWN, retry: true };
        case "failed":
          return { kind: "blocked", target, path, message: event.created.message, retry: true };
      }
      return screen;
    }

    case "createFailed":
      return screen.kind === "create" ? { ...screen, error: event.message } : screen;

    case "unlocked":
      return screen.kind === "unlock" ? { kind: "app", target: screen.target } : screen;

    case "wrongPassphrase":
      return screen.kind === "unlock" ? { ...screen, error: WRONG_PASSPHRASE } : screen;

    case "keyChanged":
      return screen.kind === "app" ? { kind: "unlock", target: screen.target, path: null, reason: "keyChanged", error: null } : screen;

    case "tokenRejected": {
      // A 401 anywhere a connection exists. Before one exists, connecting
      // reports it as connectFailed instead. Already on Replace token, what
      // it shows (an error) stays.
      if (screen.kind === "replaceToken") return screen;
      const target = "target" in screen ? screen.target : null;
      return target ? { kind: "replaceToken", target, error: null } : screen;
    }

    case "tokenReplaced":
      if (screen.kind !== "replaceToken") return screen;
      return sameRepo(screen.target, event.target) ? { kind: "app", target: screen.target } : { ...screen, error: OTHER_REPO };

    case "opened":
      return { kind: "app", target: event.target };

    case "retry":
      return screen.kind === "blocked" && screen.retry ? backToConnect(screen.target, screen.path) : screen;

    case "forgotten":
      return { kind: "welcome" };

    case "joinRace":
    case "raceOtherKey":
    case "unlockFailed":
      return screen;

    case "signInReturned":
      if (screen.kind !== "welcome" && screen.kind !== "step") return screen;
      return { ...stepScreen(event.path, "connect", { org: event.org, owner: event.owner, repo: event.repo }), error: event.error };
  }
}
