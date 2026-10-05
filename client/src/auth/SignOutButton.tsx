import { signOut } from "./session";
import "./SignIn.css";

/** The header's sign-out control: an icon (a door with an arrow out) rather
 * than a text button, so it fits next to ThemeToggle on a phone. */
export function SignOutButton() {
  return (
    <button
      type="button"
      className="sign-out-btn"
      onClick={() => void signOut()}
      aria-label="Sign out"
      title="Sign out"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
    </button>
  );
}
