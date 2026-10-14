import { useState, type FormEvent } from "react";
import { Card, ErrorText } from "../Shell";
import { checkPastedToken } from "../token";
import type { Screen } from "./flow";

// Replace token (#8): GitHub answered 401, so the token expired or was
// revoked. Everything on this device is kept, unsynced changes included;
// a new token for the same repository picks up where it left off, with no
// passphrase prompt.

const TOKEN_EXPIRED = "GitHub no longer accepts this token (it expired or was revoked). Paste a new one.";

export function ReplaceToken({
  screen,
  onReplace,
  onForget,
}: {
  screen: Extract<Screen, { kind: "replaceToken" }>;
  onReplace: (token: string) => Promise<void>;
  /** For when no new token will come (access was removed): resolves to an
   * error to show, or null. */
  onForget: () => Promise<string | null>;
}) {
  const [token, setToken] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);

  async function forget() {
    setBusy(true);
    try {
      setForgetError(await onForget());
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const checked = checkPastedToken(token);
    if (!checked.ok) {
      setPasteError(checked.message);
      return;
    }
    setPasteError(null);
    setBusy(true);
    try {
      await onReplace(checked.token);
    } finally {
      setBusy(false);
    }
  }

  const error = pasteError ?? screen.error;
  return (
    <Card title="Replace your token" focusKey="replace-token">
      <p>{TOKEN_EXPIRED}</p>
      <p className="gh-note">
        It must reach <strong>{`${screen.target.owner}/${screen.target.repo}`}</strong>. Your changes on this device are kept.
      </p>
      <form onSubmit={(e) => void submit(e)} className="gh-choices">
        <fieldset disabled={busy}>
          <label>
            New token
            <input type="password" name="token" autoComplete="off" autoCapitalize="none" spellCheck={false} value={token} data-testid="gh-replace-token" onChange={(e) => setToken(e.target.value)} />
          </label>
          {error && <ErrorText>{error}</ErrorText>}
          <button type="submit" className="submit-btn" disabled={busy || token.trim() === ""} data-testid="gh-replace">
            {busy ? "Checking..." : "Use this token"}
          </button>
        </fieldset>
      </form>
      <p className="gh-note">No longer have access to this repository? Forget this device instead.</p>
      {forgetError && <ErrorText>{forgetError}</ErrorText>}
      <button type="button" className="gh-secondary gh-danger" disabled={busy} onClick={() => void forget()} data-testid="gh-replace-forget">
        Forget this device
      </button>
    </Card>
  );
}
