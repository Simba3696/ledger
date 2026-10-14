import { Component, type ReactNode } from "react";
import { isChunkLoadError } from "./sectionLoading";
import { Shell } from "./Shell";

// Around the shared Ledger in GitHub mode. A section that can't be loaded
// (offline before its chunk was, sectionLoading.ts) made React.lazy throw
// with nothing to catch it: a blank screen. This shows a message instead.
// React.lazy keeps a failed load for the life of the page, so Try again
// reloads it, once online and with nothing still being saved; Back to Dashboard opens the Ledger again on the Dashboard,
// which is in the main chunk. Any other error is left to fail as before.

const OFFLINE = "This part of Ledger hasn't loaded yet, and you seem to be offline. It will open once you're back online: then tap Try again.";
const FAILED = "This part of Ledger couldn't be loaded. Check your connection and tap Try again.";
const STILL_OFFLINE = "You still seem to be offline.";
const STILL_SAVING = "Ledger is still saving your changes. Try again once they're saved.";

interface Props {
  children?: ReactNode;
  /** The Ledger is to open on the Dashboard when it mounts again. */
  onHome: () => void;
  online?: () => boolean;
  /** A change is still being saved on this device or sent to GitHub: a
   * reload could cut it off. */
  saving?: () => boolean;
  reload?: () => void;
}

interface State {
  failed: { error: unknown } | null;
  /** Why Try again didn't reload. */
  note: string | null;
}

export class SectionLoadBoundary extends Component<Props, State> {
  state: State = { failed: null, note: null };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: { error }, note: null };
  }

  #online(): boolean {
    return (this.props.online ?? (() => navigator.onLine))();
  }

  #tryAgain = () => {
    if (!this.#online()) return this.setState({ note: STILL_OFFLINE });
    if (this.props.saving?.()) return this.setState({ note: STILL_SAVING });
    (this.props.reload ?? (() => window.location.reload()))();
  };

  #home = () => {
    this.props.onHome();
    this.setState({ failed: null, note: null });
  };

  render() {
    const { failed, note } = this.state;
    if (failed === null) return this.props.children;
    if (!isChunkLoadError(failed.error)) throw failed.error;
    return (
      <Shell>
        <div className="sync-message" role="alert" data-testid="gh-section-unloaded">
          <p>{this.#online() ? FAILED : OFFLINE}</p>
          {note && <p>{note}</p>}
          <button type="button" onClick={this.#tryAgain}>
            Try again
          </button>
          <button type="button" onClick={this.#home}>
            Back to Dashboard
          </button>
        </div>
      </Shell>
    );
  }
}
