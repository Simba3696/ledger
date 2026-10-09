// Defined by client/vite.config.ts in every mode: "github" for
// `vite build --mode github` (the GitHub Pages build, ADR-0007), else
// "supabase". Always a literal, so the minifier folds checks against it.
declare const __LEDGER_STORAGE__: 'supabase' | 'github'
