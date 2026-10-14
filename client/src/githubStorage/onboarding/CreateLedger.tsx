import { useMemo, useRef, useState, type FormEvent } from "react";
import type { ModuleName } from "../../api";
import { defaultTimeZone, SECTION_LABELS, SECTIONS, timeZones } from "../defaults";
import { useFocusOnError } from "../focusOnError";
import { Card, ErrorText } from "../Shell";
import { createProblem } from "./createForm";
import type { Screen } from "./flow";

// Create (#8): the household passphrase, the sections and the time zone of
// a new ledger. Nothing is sent until every field is valid; the gate then
// writes the genesis (createLedger) and opens it.

export function CreateLedger({
  screen,
  defaultSections,
  remembered,
  onCreate,
  onBack,
}: {
  screen: Extract<Screen, { kind: "create" }>;
  defaultSections: readonly ModuleName[];
  /** False when this browser won't keep the key: it will ask each time. */
  remembered: boolean;
  onCreate: (passphrase: string, choices: { modules: ModuleName[]; timeZone: string }) => Promise<void>;
  onBack: () => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saved, setSaved] = useState(false);
  const [sections, setSections] = useState<ModuleName[]>([...defaultSections]);
  const [timeZone, setTimeZone] = useState(defaultTimeZone);
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const zones = useMemo(() => timeZones(), []);
  const problem = createProblem({ passphrase, confirm, saved, sections, timeZone });

  function toggle(section: ModuleName, on: boolean) {
    setSections((was) => SECTIONS.filter((s) => (s === section ? on : was.includes(s))));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (problem) {
      setShown(problem);
      return;
    }
    setShown(null);
    setBusy(true);
    try {
      await onCreate(passphrase, { modules: sections, timeZone: timeZone.trim() });
    } finally {
      setBusy(false);
    }
  }

  const error = shown ?? screen.error;
  const firstField = useRef<HTMLInputElement>(null);
  useFocusOnError(screen.error, busy, firstField);
  return (
    <Card title="Create your ledger" focusKey="create">
      <p>
        Ledger will keep its data in <strong>{`${screen.target.owner}/${screen.target.repo}`}</strong>, encrypted with a passphrase you choose now.
        {screen.target.ownerIsOrg ? " Everyone in your household will type the same passphrase on their own device." : ""}
      </p>
      {!remembered && <p className="gh-note">This browser won't remember your passphrase, so you'll enter it each time.</p>}
      <form onSubmit={(e) => void submit(e)} className="gh-choices">
        <fieldset disabled={busy}>
          <label>
            Passphrase
            <input ref={firstField} type="password" name="new-passphrase" autoComplete="new-password" value={passphrase} data-testid="gh-passphrase" onChange={(e) => setPassphrase(e.target.value)} />
          </label>
          <label>
            Passphrase again
            <input type="password" name="confirm-passphrase" autoComplete="new-password" value={confirm} data-testid="gh-passphrase-confirm" onChange={(e) => setConfirm(e.target.value)} />
          </label>
          <label className="gh-check">
            <input type="checkbox" checked={saved} data-testid="gh-passphrase-saved" onChange={(e) => setSaved(e.target.checked)} />
            <span>I've saved this passphrase somewhere safe. If it's lost, nobody (not GitHub, not the app's makers) can open this ledger.</span>
          </label>
          <fieldset className="gh-sections">
            <legend>Sections (the Dashboard is always on)</legend>
            {SECTIONS.map((section) => (
              <label key={section} className="gh-check">
                <input type="checkbox" checked={sections.includes(section)} data-testid={`gh-section-${section}`} onChange={(e) => toggle(section, e.target.checked)} />
                <span>{SECTION_LABELS[section]}</span>
              </label>
            ))}
          </fieldset>
          <label>
            Time zone (what "today" means)
            {zones ? (
              <select value={timeZone} data-testid="gh-time-zone" onChange={(e) => setTimeZone(e.target.value)}>
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            ) : (
              <input name="time-zone" autoComplete="off" value={timeZone} data-testid="gh-time-zone" onChange={(e) => setTimeZone(e.target.value)} />
            )}
          </label>
          {error && <ErrorText>{error}</ErrorText>}
          <div className="gh-actions">
            <button type="button" className="gh-secondary" onClick={onBack}>
              Back
            </button>
            {/* Enabled while the form is incomplete, so pressing it says what's
                missing; nothing is sent until it's all valid. */}
            <button type="submit" className="submit-btn" disabled={busy} data-testid="gh-create">
              {busy ? "Creating..." : "Create ledger"}
            </button>
          </div>
        </fieldset>
      </form>
    </Card>
  );
}
