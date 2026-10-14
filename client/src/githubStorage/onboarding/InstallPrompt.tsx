import { useState } from "react";
import { appInstallUrl } from "../links";
import { GitHubLink } from "../Shell";

// "Give Ledger access to <repo>" (#10): signed in with GitHub, but the
// GitHub App isn't installed on the chosen repository, so GitHub would only
// answer 404. The install page opens in a new tab; Check again here uses the
// same sign-in, so nobody signs in twice.

export function InstallPrompt({ owner, repo, slug, onCheckAgain }: { owner: string; repo: string; slug: string; onCheckAgain: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);

  async function check() {
    setChecking(true);
    try {
      await onCheckAgain();
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="gh-install" role="status" data-testid="gh-install-prompt">
      <p>
        <strong>{`Give Ledger access to ${owner}/${repo}`}</strong>
      </p>
      <p className="gh-note">
        You're signed in, but Ledger's GitHub App can't reach this repository yet. On GitHub, install it on <strong>{owner}</strong>, choose
        "Only select repositories" and pick <strong>{repo}</strong>. Then come back here.
      </p>
      <GitHubLink href={appInstallUrl(slug)} testId="gh-install-link">
        Open GitHub: give access
      </GitHubLink>
      <button type="button" className="gh-secondary" disabled={checking} onClick={() => void check()} data-testid="gh-install-check">
        {checking ? "Checking..." : "Check again"}
      </button>
    </div>
  );
}
