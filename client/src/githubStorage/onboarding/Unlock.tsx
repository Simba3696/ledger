import { useRef, useState, type FormEvent } from "react";
import { useFocusOnError } from "../focusOnError";
import { Card, ErrorText } from "../Shell";
import type { Screen } from "./flow";

// Unlock (#8): the household passphrase, once per device. The key is
// derived from the ledger's own salt; a wrong passphrase stays here and
// writes nothing.

type UnlockScreen = Extract<Screen, { kind: "unlock" }>;

const WHY: Record<UnlockScreen["reason"], string> = {
  existing: "This repository already holds a ledger. Enter its passphrase to open it on this device.",
  createdMeanwhile: "Someone created the ledger while you were setting up. Enter the household passphrase to open it.",
  raceLost:
    "Someone else in your household created the ledger at the same moment, and theirs is the one in the repo. Enter the household passphrase to join it. Nothing on this device is lost: anything you entered here is offered back, to re-apply.",
  keyChanged: "The ledger's passphrase is different from the one this device knows. Enter the current passphrase.",
};

export function Unlock({
  screen,
  remembered,
  onUnlock,
  onBack,
}: {
  screen: UnlockScreen;
  /** False when this browser won't keep the key: it will ask each time. */
  remembered: boolean;
  onUnlock: (passphrase: string) => Promise<void>;
  onBack: () => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useFocusOnError(screen.error, busy, field);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await onUnlock(passphrase);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Enter your passphrase" focusKey={`unlock-${screen.reason}`}>
      <p>{WHY[screen.reason]}</p>
      {!remembered && <p className="gh-note">This browser won't remember your passphrase, so you'll enter it each time.</p>}
      <form onSubmit={(e) => void submit(e)} className="gh-choices">
        <fieldset disabled={busy}>
          <label>
            Passphrase
            <input ref={field} type="password" name="passphrase" autoComplete="current-password" value={passphrase} data-testid="gh-unlock-passphrase" onChange={(e) => setPassphrase(e.target.value)} />
          </label>
          {screen.error && <ErrorText>{screen.error}</ErrorText>}
          <div className="gh-actions">
            <button type="button" className="gh-secondary" onClick={onBack}>
              Back
            </button>
            <button type="submit" className="submit-btn" disabled={busy || passphrase === ""} data-testid="gh-unlock">
              {screen.joining ? (busy ? "Joining..." : "Join ledger") : busy ? "Opening..." : "Open ledger"}
            </button>
          </div>
        </fieldset>
      </form>
    </Card>
  );
}
