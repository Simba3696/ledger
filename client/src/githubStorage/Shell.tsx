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
export function Card({ title, focusKey, children }: { title: string; focusKey: string; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [focusKey]);
  return (
    <section className="auth-card gh-card" aria-labelledby={`gh-${focusKey}`}>
      <h2 id={`gh-${focusKey}`} ref={heading} tabIndex={-1}>
        {title}
      </h2>
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
