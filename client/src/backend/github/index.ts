import { createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { GitHubGate } from '../../githubStorage/GitHubGate'

// Entry point of the GitHub storage build (ADR-0007), reached only through
// the dynamic import in main.tsx. Everything GitHub-mode-only hangs off
// startGithubStorage, so none of it reaches the default (Supabase) bundle:
// the gate (#8) walks a person to an open ledger, then renders #7's
// SyncHost around the shared Ledger with a DocumentBackend behind api.ts.

export function startGithubStorage(rootEl: HTMLElement): void {
  document.documentElement.dataset.storage = 'github'
  createRoot(rootEl).render(createElement(StrictMode, null, createElement(GitHubGate)))
}
