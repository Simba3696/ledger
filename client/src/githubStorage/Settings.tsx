import { useMemo, useState, type FormEvent } from "react";
import type { ModuleName } from "../api";
import type { DocumentBackend } from "../backend/document/DocumentBackend";
import type { SyncEngine } from "../backend/sync/SyncEngine";
import { DialogHost } from "../components/Dialog";
import { confirmDialog } from "../components/dialogs";
import { forget } from "./connection";
import { SECTION_LABELS, SECTIONS, timeZones } from "./defaults";
import { inviteLink, orgPendingTokensUrl, orgPeopleUrl, repoAccessUrl } from "./links";
import { Card, ErrorText } from "./Shell";
import { checkPastedToken } from "./token";

// GitHub mode's Settings (#8), opened from the header's gear: the
// connection (and a new token), the sections and time zone, the household
// invite, and Forget this device. It replaces the ledger on screen inside
// SyncHost, so the sync status stays live; Done brings the ledger back,
// remounted when something changed, so its nav reflects the sections.

const EXPIRY_WARNING_DAYS = 14;

export interface SettingsConnection {
  owner: string;
  repo: string;
  login: string;
  ownerIsOrg: boolean;
  /** ISO, when known: a browser can't read GitHub's expiry header. */
  expiresAt?: string;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function Settings({
  engine,
  backend,
  connection,
  onDone,
  onReplaceToken,
  onForgotten,
}: {
  engine: SyncEngine;
  backend: DocumentBackend;
  connection: SettingsConnection;
  /** Back to the ledger; `changed` when the sections or time zone were saved. */
  onDone: (changed: boolean) => void;
  /** Resolves to an error to show, or null once the new token is in use. */
  onReplaceToken: (token: string) => Promise<string | null>;
  onForgotten: () => void;
}) {
  const settings = engine.current().settings;
  const [sections, setSections] = useState<ModuleName[]>([...settings.modules]);
  const [timeZone, setTimeZone] = useState(settings.timeZone);
  const zones = useMemo(() => timeZones([settings.timeZone]), [settings.timeZone]);
  const [changed, setChanged] = useState(false);
  const [settingsNote, setSettingsNote] = useState<{ error: boolean; text: string } | null>(null);
  const [token, setToken] = useState("");
  const [tokenNote, setTokenNote] = useState<{ error: boolean; text: string } | null>(null);
  const [forgetError, setForgetError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const expires = connection.expiresAt ? new Date(connection.expiresAt) : null;
  const daysLeft = expires ? Math.ceil((expires.getTime() - Date.now()) / 86_400_000) : null;
  const invite = inviteLink(globalThis.location, connection.owner, connection.repo);

  function toggle(section: ModuleName, on: boolean) {
    setSections((was) => SECTIONS.filter((s) => (s === section ? on : was.includes(s))));
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    if (sections.length === 0) return setSettingsNote({ error: true, text: "Choose at least one section." });
    setBusy(true);
    try {
      await backend.updateSettings({ modules: sections, timeZone: timeZone.trim() });
      setChanged(true);
      setSettingsNote({ error: false, text: "Saved." });
    } catch (err) {
      setSettingsNote({ error: true, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function replaceToken(e: FormEvent) {
    e.preventDefault();
    const checked = checkPastedToken(token);
    if (!checked.ok) return setTokenNote({ error: true, text: checked.message });
    setBusy(true);
    try {
      const error = await onReplaceToken(checked.token);
      setTokenNote(error ? { error: true, text: error } : { error: false, text: "This device now uses the new token." });
      if (!error) setToken("");
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(invite);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function forgetDevice() {
    setForgetError(null);
    let state = engine.getState();
    if (state.pendingCount > 0) {
      const sync = await confirmDialog({
        message: `${plural(state.pendingCount, "change")} on this device ${state.pendingCount === 1 ? "hasn't" : "haven't"} been saved to GitHub yet. Sync now first?`,
        confirmLabel: "Sync now",
        cancelLabel: "Cancel",
      });
      if (!sync) return;
      await engine.syncNow();
      state = engine.getState();
    }
    const unsaved = state.pendingCount + state.leftBehindOwnCount;
    const confirmed = await confirmDialog(
      unsaved > 0
        ? {
            message: `${plural(unsaved, "change")} on this device ${unsaved === 1 ? "hasn't" : "haven't"} been saved to GitHub yet and will be lost. Forget this device anyway?`,
            confirmLabel: "Forget anyway",
            destructive: true,
          }
        : {
            message: "Forget this device? Ledger's copy of your data, the passphrase key and the token are removed from this browser. Nothing on GitHub changes, and you can connect again at any time.",
            confirmLabel: "Forget this device",
            destructive: true,
          },
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      const done = await forget(engine, { force: unsaved > 0 });
      if (done.ok) return onForgotten();
      // Something changed on the device after the dialog: ask again.
      setForgetError(`${plural(done.pendingCount + done.leftBehindOwnCount, "change")} still ${done.pendingCount + done.leftBehindOwnCount === 1 ? "isn't" : "aren't"} on GitHub. Nothing was forgotten.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <DialogHost />
      <Card title="Settings" focusKey="settings">
        <div className="gh-actions">
          <span />
          <button type="button" className="submit-btn" onClick={() => onDone(changed)} data-testid="gh-settings-done">
            Done
          </button>
        </div>

        <section className="gh-settings-section" aria-labelledby="gh-settings-connection">
          <h3 id="gh-settings-connection">Connection</h3>
          <p>
            Your data is in <strong>{`${connection.owner}/${connection.repo}`}</strong>, reached as <strong>{connection.login}</strong> on GitHub.
          </p>
          {daysLeft !== null && daysLeft <= EXPIRY_WARNING_DAYS ? (
            <p className="gh-warning" role="status">
              {daysLeft <= 0 ? "This token has expired." : `This token expires in ${plural(daysLeft, "day")}.`} Create a new one and paste it below.
            </p>
          ) : (
            <p className="gh-note">{expires ? `The token expires on ${expires.toLocaleDateString()}.` : "GitHub doesn't tell Ledger when a token expires; when it stops working, Ledger asks for a new one."}</p>
          )}
          <form onSubmit={(e) => void replaceToken(e)} className="gh-choices">
            <fieldset disabled={busy}>
              <label>
                Replace token
                <input type="password" name="token" autoComplete="off" autoCapitalize="none" spellCheck={false} value={token} data-testid="gh-settings-token" onChange={(e) => setToken(e.target.value)} />
              </label>
              {tokenNote && (tokenNote.error ? <ErrorText>{tokenNote.text}</ErrorText> : <p className="gh-note" role="status">{tokenNote.text}</p>)}
              <button type="submit" className="gh-secondary" disabled={token.trim() === ""} data-testid="gh-settings-replace">
                Use this token
              </button>
            </fieldset>
          </form>
        </section>

        <section className="gh-settings-section" aria-labelledby="gh-settings-sections">
          <h3 id="gh-settings-sections">Sections and time zone</h3>
          <form onSubmit={(e) => void saveSettings(e)} className="gh-choices">
            <fieldset disabled={busy}>
              <fieldset className="gh-sections">
                <legend>Sections (the Dashboard is always on)</legend>
                {SECTIONS.map((section) => (
                  <label key={section} className="gh-check">
                    <input type="checkbox" checked={sections.includes(section)} data-testid={`gh-settings-section-${section}`} onChange={(e) => toggle(section, e.target.checked)} />
                    <span>{SECTION_LABELS[section]}</span>
                  </label>
                ))}
              </fieldset>
              <label>
                Time zone (what "today" means)
                {zones ? (
                  <select value={timeZone} data-testid="gh-settings-time-zone" onChange={(e) => setTimeZone(e.target.value)}>
                    {zones.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input name="time-zone" autoComplete="off" value={timeZone} data-testid="gh-settings-time-zone" onChange={(e) => setTimeZone(e.target.value)} />
                )}
              </label>
              {settingsNote && (settingsNote.error ? <ErrorText>{settingsNote.text}</ErrorText> : <p className="gh-note" role="status">{settingsNote.text}</p>)}
              <button type="submit" className="submit-btn" data-testid="gh-settings-save">
                Save
              </button>
            </fieldset>
          </form>
        </section>

        {connection.ownerIsOrg && (
          <section className="gh-settings-section" aria-labelledby="gh-settings-household">
            <h3 id="gh-settings-household">Household</h3>
            <p>Send this link to someone you've invited. Tell them the passphrase in person, never in the link or a chat.</p>
            <p className="gh-invite" data-testid="gh-invite-link">
              {invite}
            </p>
            <button type="button" className="gh-secondary" onClick={() => void copyInvite()} data-testid="gh-copy-invite">
              {copied ? "Copied" : "Copy invite link"}
            </button>
            <ul>
              <li>
                Invite them on GitHub:{" "}
                <a href={orgPeopleUrl(connection.owner)} target="_blank" rel="noopener noreferrer">
                  people
                </a>
                , then give them <strong>Write</strong> on the{" "}
                <a href={repoAccessUrl(connection.owner, connection.repo)} target="_blank" rel="noopener noreferrer">
                  repository's access page
                </a>
                .
              </li>
              <li>
                Approve their token under{" "}
                <a href={orgPendingTokensUrl(connection.owner)} target="_blank" rel="noopener noreferrer">
                  pending token requests
                </a>
                .
              </li>
            </ul>
          </section>
        )}

        <section className="gh-settings-section" aria-labelledby="gh-settings-device">
          <h3 id="gh-settings-device">This device</h3>
          <p className="gh-note">Removes Ledger's copy of your data, the passphrase key and the token from this browser. Nothing on GitHub changes.</p>
          {forgetError && <ErrorText>{forgetError}</ErrorText>}
          <button type="button" className="gh-secondary gh-danger" disabled={busy} onClick={() => void forgetDevice()} data-testid="gh-forget">
            Forget this device
          </button>
        </section>
      </Card>
    </>
  );
}
