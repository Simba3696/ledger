import { createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as encryption from '../crypto'
import * as contents from './contents'
import * as deviceStore from './deviceStore'
import { createEmptyDocument } from '../document/createDocument'
import { DocumentBackend } from '../document/DocumentBackend'

// Entry point of the GitHub storage build (ADR-0007), reached only through
// the dynamic import in main.tsx. Everything GitHub-mode-only hangs off
// startGithubStorage, so none of it reaches the default (Supabase) bundle.

// The encryption, device key store and GitHub contents client, for the sync
// engine and onboarding UI to call. Until they do, nothing calls them and
// the minifier would drop them, so the placeholder names them: that keeps
// their string literals (PBKDF2, ledger:github) in this lazy chunk, where
// check:isolation looks for them.
const githubStorageModules = { encryption, contents, deviceStore }

export const GITHUB_API_BASE = 'https://api.github.com'
export const DATA_FILE_NAME = 'ledger.json.enc'
export const DEFAULT_REPO_NAME = 'ledger-data'

// Placeholder until the GitHub gate, sync host and shared Ledger tree land.
// The constants are rendered as data attributes so they stay in the minified
// chunk: scripts/check-storage-isolation.mjs uses them as the positive
// control that GitHub-mode code is present here and absent from the default
// build.
export function startGithubStorage(rootEl: HTMLElement): void {
  // The document store the sync host (#7) will put behind api.ts, named here
  // like the modules above so it ships in this lazy chunk, with the
  // ledger:document-backend tag check:isolation looks for.
  const documentStorage = { DocumentBackend, createEmptyDocument }
  document.documentElement.dataset.storage = 'github'
  createRoot(rootEl).render(
    createElement(
      StrictMode,
      null,
      createElement(
        'p',
        {
          'data-api': GITHUB_API_BASE,
          'data-repo': DEFAULT_REPO_NAME,
          'data-file': DATA_FILE_NAME,
          'data-modules': [...Object.keys(githubStorageModules), ...Object.keys(documentStorage)].join(' '),
        },
        'GitHub storage mode is not set up yet',
      ),
    ),
  )
}
