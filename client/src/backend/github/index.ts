import { createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { GitHubGate } from '../../githubStorage/GitHubGate'
import { Shell } from '../../githubStorage/Shell'
import { completeSignIn, isSignInReturn, SIGN_IN_INCOMPLETE, signInConfig, type SignInResult } from './appAuth'

// Entry point of the GitHub storage build (ADR-0007), reached only through
// the dynamic import in main.tsx. Everything GitHub-mode-only hangs off
// startGithubStorage, so none of it reaches the default (Supabase) bundle:
// the gate (#8) walks a person to an open ledger, then renders #7's
// SyncHost around the shared Ledger with a DocumentBackend behind api.ts.
// A return from Sign in with GitHub (#10) is finished first: its code and
// state leave the address bar before the gate renders, and the gate gets
// the result. The exchange can take a while (the helper, then GitHub), so
// the page says so meanwhile.

export function startGithubStorage(rootEl: HTMLElement): void {
  document.documentElement.dataset.storage = 'github'
  const root = createRoot(rootEl)
  const config = signInConfig()
  const returning = config !== null && isSignInReturn(globalThis.location.href)
  const finishing = completeSignIn(config)
  if (returning) {
    root.render(createElement(Shell, null, createElement('p', { className: 'sync-message', role: 'status' }, 'Signing in with GitHub...')))
  }
  const render = (signIn: SignInResult) => root.render(createElement(StrictMode, null, createElement(GitHubGate, { signIn })))
  finishing.then(render, () => render({ kind: 'failed', message: SIGN_IN_INCOMPLETE, resume: null }))
}
