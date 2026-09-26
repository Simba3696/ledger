import { useLayoutEffect, useState } from "react";
import "./ThemeToggle.css";

type Theme = "light" | "dark";

const STORAGE_KEY = "ledger-theme";
// Same --light-bg/--dark-bg values as index.css — kept in sync manually
// (there's no way to read a CSS custom property back out for a <meta> tag).
const THEME_COLOR: Record<Theme, string> = { light: "#eaf3ec", dark: "#16171d" };

function getInitialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);

    // The two <meta name="theme-color" media="(prefers-color-scheme: ...)">
    // tags in index.html only track the OS-level preference — once the user
    // explicitly overrides it here, update the color directly so the
    // browser/OS chrome (status bar, home-screen splash) still matches
    // instead of reverting to whatever the OS setting says.
    document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
      meta.setAttribute("content", THEME_COLOR[theme]);
    });
  }, [theme]);

  return (
    <button
      type="button"
      className={`theme-toggle ${theme}`}
      onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      <span className="theme-toggle-thumb" aria-hidden="true">
        {theme === "dark" ? "🌙" : "☀️"}
      </span>
    </button>
  );
}
