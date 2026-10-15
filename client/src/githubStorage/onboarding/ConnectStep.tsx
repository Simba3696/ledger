import { useRef, useState, type FormEvent } from "react";
import { isGitHubName } from "../links";
import { useFocusOnError } from "../focusOnError";
import { Card, ErrorText } from "../Shell";
import { checkPastedToken } from "../token";
import { STEPS, type Screen } from "./flow";
import { InstallPrompt } from "./InstallPrompt";
import { SignInWithGitHub } from "./SignInWithGitHub";

// The last walkthrough card (#8): paste the token. Checked as pasted before
// any request (a classic or App token never leaves the page); the gate then
// connects and moves on, or says what GitHub answered. A build with Sign in
// with GitHub (#10) also offers the button above the paste field, for the
// repo the fields name; the paste path is unchanged.

type StepScreen = Extract<Screen, { kind: "step" }>;

/** Sign in with GitHub on this card (#10), when the build has it. */
export interface ConnectSignIn {
  /** Leaves for github.com, to come back connecting `owner`/`repo`. */
  onSignIn: (owner: string | null, repo: string) => Promise<void>;
  /** Back from signing in, connecting with the App's token. */
  connecting: boolean;
  /** The App isn't on the repo: the install prompt, and Check again. */
  install: { owner: string; repo: string; slug: string; onCheckAgain: () => Promise<void> } | null;
}

export function ConnectStep({
  screen,
  onConnect,
  onBack,
  signIn = null,
}: {
  screen: StepScreen;
  /** Connects with a checked token; the gate reports the outcome. `owner`
   * null means the token's own account. */
  onConnect: (token: string, owner: string | null, repo: string) => Promise<void>;
  onBack: () => void;
  signIn?: ConnectSignIn | null;
}) {
  const [token, setToken] = useState("");
  const [owner, setOwner] = useState(screen.owner ?? "");
  const [repo, setRepo] = useState(screen.repo);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const steps = STEPS[screen.path];

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const checked = checkPastedToken(token);
    if (!checked.ok) {
      setPasteError(checked.message);
      return;
    }
    setPasteError(null);
    setBusy(true);
    try {
      await onConnect(checked.token, owner.trim() === "" ? null : owner.trim(), repo.trim());
    } finally {
      setBusy(false);
    }
  }

  const repoValid = isGitHubName(repo.trim()) && (owner.trim() === "" || isGitHubName(owner.trim()));
  const error = pasteError ?? screen.error;
  const tokenField = useRef<HTMLInputElement>(null);
  useFocusOnError(error, busy, tokenField);
  return (
    <Card title="Paste your token" focusKey={`${screen.path}-connect`}>
      <p className="gh-step-count">{`Step ${steps.length} of ${steps.length}`}</p>
      {signIn && (
        <>
          {signIn.install ? (
            <InstallPrompt owner={signIn.install.owner} repo={signIn.install.repo} slug={signIn.install.slug} onCheckAgain={signIn.install.onCheckAgain} />
          ) : signIn.connecting ? (
            <p className="sync-message" role="status">
              Signed in. Connecting...
            </p>
          ) : (
            <SignInWithGitHub disabled={busy || !repoValid} onSignIn={() => signIn.onSignIn(owner.trim() === "" ? null : owner.trim(), repo.trim())} />
          )}
          <p className="gh-or">or paste a token</p>
        </>
      )}
      <form onSubmit={(e) => void submit(e)} className="gh-choices">
        <fieldset disabled={busy}>
          <label>
            Token
            <input
              type="password"
              name="token"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              ref={tokenField}
              value={token}
              data-testid="gh-token"
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <details>
            <summary>Different repository?</summary>
            <label>
              Owner (a GitHub user or organization)
              <input name="owner" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Your GitHub username" value={owner} data-testid="gh-owner" onChange={(e) => setOwner(e.target.value)} />
            </label>
            <label>
              Repository
              <input name="repo" autoComplete="off" autoCapitalize="none" spellCheck={false} value={repo} data-testid="gh-repo" onChange={(e) => setRepo(e.target.value)} />
            </label>
          </details>
          {error && <ErrorText>{error}</ErrorText>}
          <div className="gh-actions">
            <button type="button" className="gh-secondary" onClick={onBack}>
              Back
            </button>
            {screen.awaitingApproval ? (
              <button type="button" className="submit-btn" disabled={busy} onClick={() => void submit()} data-testid="gh-check-again">
                Check again
              </button>
            ) : (
              <button type="submit" className="submit-btn" disabled={busy || token.trim() === "" || !repoValid} data-testid="gh-connect">
                {busy ? "Connecting..." : "Connect"}
              </button>
            )}
          </div>
        </fieldset>
      </form>
    </Card>
  );
}
