import { createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Entry point of the GitHub storage build (ADR-0007), reached only through
// the dynamic import in main.tsx. Everything GitHub-mode-only hangs off
// startGithubStorage, so none of it reaches the default (Supabase) bundle.

export const GITHUB_API_BASE = 'https://api.github.com'
export const DATA_FILE_NAME = 'ledger.json.enc'
export const DEFAULT_REPO_NAME = 'ledger-data'

// Placeholder until the GitHub gate, sync host and shared Ledger tree land.
// The constants are rendered as data attributes so they stay in the minified
// chunk: scripts/check-storage-isolation.mjs uses them as the positive
// control that GitHub-mode code is present here and absent from the default
// build.
export function startGithubStorage(rootEl: HTMLElement): void {
  document.documentElement.dataset.storage = 'github'
  createRoot(rootEl).render(
    createElement(
      StrictMode,
      null,
      createElement(
        'p',
        { 'data-api': GITHUB_API_BASE, 'data-repo': DEFAULT_REPO_NAME, 'data-file': DATA_FILE_NAME },
        'GitHub storage mode is not set up yet',
      ),
    ),
  )
}
