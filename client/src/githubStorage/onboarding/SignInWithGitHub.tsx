import { useState } from "react";
import { ErrorText } from "../Shell";

// The "Sign in with GitHub" button (#10): a shortcut past pasting a token,
// shown only in a build given a GitHub App and its sign-in helper
// (signInConfig()). It leaves for github.com in this tab; the page comes
// back with a code that completeSignIn() exchanges.

export function SignInWithGitHub({ onSignIn, disabled = false }: { onSignIn: () => Promise<void>; disabled?: boolean }) {
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setLeaving(true);
    setError(null);
    try {
      await onSignIn();
    } catch {
      setLeaving(false);
      setError("Couldn't start the sign-in. Try again.");
    }
  }

  return (
    <div className="gh-signin">
      <button type="button" className="submit-btn" disabled={disabled || leaving} onClick={() => void signIn()} data-testid="gh-signin">
        {leaving ? "Opening GitHub..." : "Sign in with GitHub"}
      </button>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
