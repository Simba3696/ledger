import { Card } from "../Shell";
import type { Screen } from "./flow";

// The screens with nothing to fill in (#8): a browser that can't run
// Ledger, a misconfigured copy, and what stops a ledger from opening (a
// newer ledger, a damaged file named for the person to fix, a listing
// GitHub cut short).

export function Unsupported({ screen }: { screen: Extract<Screen, { kind: "unsupported" }> }) {
  return (
    <Card title="This browser can't run Ledger" focusKey="unsupported">
      <p>{screen.message}</p>
    </Card>
  );
}

export function Misconfigured({ screen }: { screen: Extract<Screen, { kind: "misconfigured" }> }) {
  return (
    <Card title="This copy of Ledger is misconfigured" focusKey="misconfigured">
      <p>{screen.message}</p>
      <p className="gh-note">Whoever runs this site needs to fix its settings and build it again.</p>
    </Card>
  );
}

export function Blocked({ screen, onRetry, onBack }: { screen: Extract<Screen, { kind: "blocked" }>; onRetry: () => void; onBack: () => void }) {
  return (
    <Card title="Ledger can't open this yet" focusKey="blocked">
      <p>{screen.message}</p>
      <div className="gh-actions">
        <button type="button" className="gh-secondary" onClick={onBack}>
          Back
        </button>
        {screen.retry && (
          <button type="button" className="submit-btn" onClick={onRetry} data-testid="gh-retry">
            Try again
          </button>
        )}
      </div>
    </Card>
  );
}
