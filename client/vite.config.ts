import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Loaded manually (not just import.meta.env) so a plain VITE_API_PROXY_TARGET
  // in client/.env can retarget the dev-server proxy too, not just VITE_*
  // values consumed by application code — lets a separate checkout/worktree
  // run entirely on its own ports without touching another checkout's server.
  const env = loadEnv(mode, process.cwd(), '')
  const port = Number(env.VITE_DEV_PORT) || 5173
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:4000'

  // `vite build --mode github` is the static GitHub Pages build (ADR-0007).
  // __LEDGER_STORAGE__ is defined in every mode, so main.tsx's check is a
  // literal comparison the minifier folds: the default (Supabase) build
  // drops the GitHub branch and its dynamic import entirely.
  const storage = mode === 'github' ? 'github' : 'supabase'
  const github = storage === 'github'
  // Sign in with GitHub (#10, ADR-0009), GitHub build only: with all three
  // settings the helper's origin joins the CSP's connect-src. With any one
  // missing or blank, all three are built in as "", so no part of them (a
  // lone helper URL, say) reaches the bundle, and there is no button.
  const signIn = github ? signInSettings(env) : null

  return {
    plugins: github ? [react(), pagesBaseFiles(signIn ? [signIn.helperOrigin] : [])] : [react()],
    define: {
      __LEDGER_STORAGE__: JSON.stringify(storage),
      ...(github && !signIn ? NO_SIGN_IN : {}),
    },
    // Netlify publishes client/dist (netlify.toml), so the GitHub build
    // writes elsewhere and never touches it. The Pages base comes from
    // Vite's own --base flag (`--base /<repo>/`), not an env variable.
    ...(github ? { build: { outDir: 'dist-pages' } } : {}),
    server: {
      port,
      strictPort: true,
      proxy: {
        '/api': apiTarget,
      },
    },
  }
})

const SIGN_IN_SETTINGS = ['VITE_GITHUB_APP_CLIENT_ID', 'VITE_GITHUB_APP_SLUG', 'VITE_GITHUB_SIGNIN_HELPER_URL'] as const

/** What a GitHub build without (all of) the sign-in settings defines them
 * as: blank, as appAuth's signInConfig() reads "no sign-in". */
const NO_SIGN_IN = Object.fromEntries(SIGN_IN_SETTINGS.map((name) => [`import.meta.env.${name}`, '""']))

/** The sign-in helper's origin, when all three sign-in settings are set
 * and non-blank, else null. A helper URL that isn't one stops the build. */
function signInSettings(env: Record<string, string>): { helperOrigin: string } | null {
  const clientId = env.VITE_GITHUB_APP_CLIENT_ID?.trim()
  const slug = env.VITE_GITHUB_APP_SLUG?.trim()
  const helperUrl = env.VITE_GITHUB_SIGNIN_HELPER_URL?.trim()
  if (!clientId || !slug || !helperUrl) return null
  let helperOrigin: string
  try {
    helperOrigin = new URL(helperUrl).origin
  } catch {
    throw new Error(`VITE_GITHUB_SIGNIN_HELPER_URL is not a URL: ${helperUrl}`)
  }
  return { helperOrigin }
}

// The GitHub Pages build's Content-Security-Policy. It mirrors the header in
// netlify.toml, except that connect-src allows GitHub's API instead of
// Supabase, plus the sign-in helper when the build has one (#10).
// frame-ancestors is left out: browsers ignore it in a meta tag.
function pagesCsp(connectExtra: string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    ["connect-src 'self' https://api.github.com", ...connectExtra].join(' '),
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ')
}

// GitHub mode only. A project Pages site is served under /<repo>/, so the
// PWA files that name absolute paths must carry the base. Rewrites the
// manifest copied into the output folder (client/public's copy stays the
// single source and is never edited), and is the one place GitHub-mode-only
// tags (the CSP meta) are added to index.html.
function pagesBaseFiles(connectExtra: string[]): Plugin {
  let base = '/'
  let outDir = ''
  let publicDir = ''
  return {
    name: 'ledger-pages-base-files',
    apply: 'build',
    configResolved(config) {
      base = config.base
      outDir = path.resolve(config.root, config.build.outDir)
      publicDir = config.publicDir
    },
    transformIndexHtml(html) {
      // Vite already prefixes public-file links with base; this covers any
      // it leaves root-relative.
      const based = html.replace(
        /(href|src)="\/(favicon\.png|apple-touch-icon\.png|manifest\.webmanifest)"/g,
        (_match, attr: string, file: string) => `${attr}="${base}${file}"`,
      )
      // GitHub Pages can't send response headers, so the CSP is a meta tag,
      // placed right after the charset so it covers every later tag.
      const charset = /<meta charset="UTF-8" \/>/i
      if (!charset.test(based)) throw new Error('index.html has no <meta charset="UTF-8" /> to put the CSP after')
      return based.replace(charset, (tag) => `${tag}\n    <meta http-equiv="Content-Security-Policy" content="${pagesCsp(connectExtra)}" />`)
    },
    async writeBundle() {
      const source = JSON.parse(await readFile(path.join(publicDir, 'manifest.webmanifest'), 'utf8')) as {
        icons?: { src: string }[]
      }
      const manifest = {
        ...source,
        start_url: base,
        scope: base,
        icons: (source.icons ?? []).map((icon) => ({ ...icon, src: base + icon.src.replace(/^\//, '') })),
      }
      await writeFile(path.join(outDir, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n')
    },
  }
}
