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

  return {
    plugins: github ? [react(), pagesBaseFiles()] : [react()],
    define: {
      __LEDGER_STORAGE__: JSON.stringify(storage),
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

// GitHub mode only. A project Pages site is served under /<repo>/, so the
// PWA files that name absolute paths must carry the base. Rewrites the
// manifest copied into the output folder (client/public's copy stays the
// single source and is never edited), and is the one place GitHub-mode-only
// tags are added to index.html.
function pagesBaseFiles(): Plugin {
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
      return html.replace(
        /(href|src)="\/(favicon\.png|apple-touch-icon\.png|manifest\.webmanifest)"/g,
        (_match, attr: string, file: string) => `${attr}="${base}${file}"`,
      )
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
