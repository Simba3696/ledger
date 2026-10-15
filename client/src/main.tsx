import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// The one import() of GitHub-storage code (ADR-0007). In the default build
// __LEDGER_STORAGE__ is "supabase", so this branch and its chunk are dropped
// and the bundle is the Supabase app alone. scripts/check-storage-isolation.mjs
// fails if any other file imports backend/ or githubStorage code.
if (__LEDGER_STORAGE__ === 'github') {
  void import('./backend/github').then((m) => m.startGithubStorage(document.getElementById('root')!))
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
