import { Component, type ReactNode } from "react";
import { isChunkLoadError } from "./sectionLoading";
import { Shell } from "./Shell";

// Around the shared Ledger in GitHub mode. A section that can't be loaded
// (offline before its chunk was, sectionLoading.ts) made React.lazy throw
// with nothing to catch it: a blank screen. This shows a message instead.
// React.lazy keeps a failed load for the life of the page, so Try again
// reloads it; Back to Dashboard opens the Ledger again on the Dashboard,
// which is in the main chunk. Any other error is left to fail as before.

const OFFLINE = "This part of Ledger hasn't loaded yet, and you seem to be offline. It will open once you're back online: then tap Try again.";
const FAILED = "This part of Ledger couldn't be loaded. Check your connection and tap Try again.";

interface Props {
  children?: ReactNode;
  /** The Ledger is to open on the Dashboard when it mounts again. */
  onHome: () => void;
  online?: () => boolean;
  reload?: () => void;
}

interface State {
  failed: { error: unknown } | null;
  stillOffline: boolean;
}

export class SectionLoadBoundary extends Component<Props, State> {
  state: State = { failed: null, stillOffline: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: { error }, stillOffline: false };
  }

  #online(): boolean {
    return (this.props.online ?? (() => navigator.onLine))();
  }

  #tryAgain = () => {
    if (!this.#online()) return this.setState({ stillOffline: true });
    (this.props.reload ?? (() => window.location.reload()))();
  };

  #home = () => {
    this.props.onHome();
    this.setState({ failed: null, stillOffline: false });
  };

  render() {
    const { failed, stillOffline } = this.state;
    if (failed === null) return this.props.children;
    if (!isChunkLoadError(failed.error)) throw failed.error;
    return (
      <Shell>
        <div className="sync-message" role="alert" data-testid="gh-section-unloaded">
          <p>{this.#online() ? FAILED : OFFLINE}</p>
          {stillOffline && <p>You still seem to be offline.</p>}
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
