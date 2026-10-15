import { useEffect, useRef, type ReactNode } from "react";
import logoIcon from "../assets/logo-icon.png";
import { ThemeToggle } from "../components/ThemeToggle";
import "../shared.css";
import "../auth/SignIn.css";
import "./githubStorage.css";

// The frame of every GitHub-mode screen before the ledger opens (#8): the
// logo and the theme toggle, as the Supabase sign-in's shell has them, and
// one card. Its own copy, so client/src/auth stays untouched; only the
// .auth-card styles are shared.

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header>
        <div className="brand">
          <img src={logoIcon} alt="" className="brand-logo" />
          <h1>Ledger</h1>
        </div>
        <div className="header-right">
          <ThemeToggle />
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}

/** One screen's card. Its heading takes focus whenever `focusKey` changes,
 * so a screen reader hears each step, and keyboard focus starts there. */
/** A card's close button, top right of its heading: a panel opened over the
 * ledger (Settings) closes the way a dialog does. */
export interface CardClose {
  label: string;
  onClose: () => void;
  disabled?: boolean;
  testId?: string;
}

export function Card({ title, focusKey, close, children }: { title: string; focusKey: string; close?: CardClose; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [focusKey]);
  const h2 = (
    <h2 id={`gh-${focusKey}`} ref={heading} tabIndex={-1}>
      {title}
    </h2>
  );
  return (
    <section className="auth-card gh-card" aria-labelledby={`gh-${focusKey}`}>
      {close ? (
        <div className="gh-card-head">
          {h2}
          <button type="button" className="gh-close" aria-label={close.label} title={close.label} disabled={close.disabled} onClick={close.onClose} data-testid={close.testId}>
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ) : (
        h2
      )}
      {children}
    </section>
  );
}

/** A link that opens GitHub in a new tab, styled as the card's main action. */
export function GitHubLink({ href, children, testId }: { href: string; children: ReactNode; testId?: string }) {
  return (
    <a className="gh-link submit-btn" href={href} target="_blank" rel="noopener noreferrer" data-testid={testId}>
      {children}
    </a>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p className="error" role="alert">
      {children}
    </p>
  );
}
