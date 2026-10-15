import { Card } from "../Shell";
import type { Path } from "./flow";

// The first screen of GitHub mode (#8): three ways in.

export function Welcome({ onChoose }: { onChoose: (path: Path) => void }) {
  return (
    <Card title="Set up Ledger" focusKey="welcome">
      <p>Ledger keeps your data in a private GitHub repository that only you (and your household) can reach, encrypted with a passphrase only you know. You need a free GitHub account.</p>
      <div className="gh-choices">
        <button type="button" className="submit-btn" data-testid="gh-welcome-personal" onClick={() => onChoose("personal")}>
          Just me
        </button>
        <button type="button" className="submit-btn" data-testid="gh-welcome-household" onClick={() => onChoose("household")}>
          My household (I'm setting it up)
        </button>
        <button type="button" className="submit-btn" data-testid="gh-welcome-member" onClick={() => onChoose("member")}>
          Join a household someone set up
        </button>
      </div>
    </Card>
  );
}
