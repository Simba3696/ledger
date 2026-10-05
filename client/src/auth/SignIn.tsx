import { useState, type FormEvent, type ReactNode } from "react";
import { ThemeToggle } from "../components/ThemeToggle";
import { LoadingOverlay } from "../components/LoadingOverlay";
import logoIcon from "../assets/logo-icon.png";
import { supabase } from "./supabase";
import { signOut } from "./session";
import "./SignIn.css";

/** The page frame for the screens shown before the app itself: the same
 * header as the app (so the theme toggle, which also applies the saved
 * theme, is there too) around one centered card. */
export function AuthShell({ children }: { children: ReactNode }) {
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
      {children}
    </div>
  );
}

/** Shown while the stored session is being read. */
export function AuthLoading() {
  return (
    <AuthShell>
      <div className="tab-loading">
        <LoadingOverlay active />
      </div>
    </AuthShell>
  );
}

/** Email + password sign-in. There's no sign-up or magic-link option: the
 * deployment has exactly one account, created by its owner in Supabase
 * (ADR-0002), and sign-ups are disabled there. */
export function SignIn({ notice }: { notice: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setSubmitting(true);
    setError(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      // On success onAuthStateChange swaps this screen for the app, so
      // there's nothing more to do here.
      if (error) setError(error.message);
    } catch (err) {
      setError((err as Error).message || "Couldn't reach the sign-in service. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = submitting || !supabase;

  return (
    <AuthShell>
      <form className="auth-card" onSubmit={handleSubmit} aria-busy={submitting}>
        <h2>Sign in</h2>
        {notice && !error && <p className="auth-notice">{notice}</p>}
        <fieldset disabled={disabled}>
          <label>
            Email
            <input
              type="email"
              name="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="submit-btn">
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </fieldset>
      </form>
    </AuthShell>
  );
}

/** A signed-in account that isn't this deployment's owner (the API's 403). */
export function NotAllowed({ email }: { email: string | undefined }) {
  return (
    <AuthShell>
      <div className="auth-card">
        <h2>Not allowed</h2>
        <p className="error" role="alert">
          This account is not allowed on this deployment.
        </p>
        {email && <p className="auth-notice">Signed in as {email}.</p>}
        <button type="button" className="submit-btn" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </AuthShell>
  );
}
