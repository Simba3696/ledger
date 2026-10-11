// Proves the GitHub storage mode (ADR-0007) stays out of the default
// (Supabase) bundle, and that the GitHub Pages build really contains it.
//
//   npm run check:isolation
//
// Run after both builds: `npm run build -w client` (client/dist) and
// `npm run build:pages -w client -- --base /<repo>/` (client/dist-pages).
// Prints one line per failed check and exits 1, or prints a one-line summary
// and exits 0. Node 22, no dependencies. ESM, so the root package stays
// CommonJS (netlify.toml, [functions]).
//
// Forbidden tokens must be string literals that survive minification.
// Identifiers (DocumentBackend, merge3, ConflictDialog, ...) are renamed by
// the minifier, so their absence proves nothing. Each child that adds
// GitHub-mode code appends at least one string-literal sentinel from it to
// FORBIDDEN_IN_DEFAULT. The list is append-only, one token per line.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FORBIDDEN_IN_DEFAULT = [
  'api.github.com',
  'AES-GCM',
  'ledger.json.enc',
  'DocumentBackend',
  'PBKDF2',
  'ledger:github',
  'ledger:document-backend',
  '.genesis.enc',
  'Git Repository is empty.',
  'ledger:sync',
  'Ledger is open in another tab',
  'sync identity was in use elsewhere',
  'Ledger was updated on another device',
  'own snapshot in the repo is not its history',
  'its log is not compacted',
  'own log would be refused',
]

// No file in the default build may have these in its name.
const FORBIDDEN_IN_DEFAULT_FILE_NAMES = ['github', 'DocumentBackend']

// Literals the GitHub build must contain (client/src/backend/github), behind
// the dynamic import: present in a non-entry chunk, absent from the entry.
const POSITIVE_CONTROL = ['ledger.json.enc', 'api.github.com', 'PBKDF2', 'ledger:github', 'ledger:document-backend']

// GitHub Pages can't send headers, so the GitHub build carries its
// Content-Security-Policy as a meta tag (client/vite.config.ts). The default
// build gets its CSP from netlify.toml and must have no meta tag.
const CSP_META = /<meta\s[^>]*http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi
const PAGES_CONNECT_SRC = ["'self'", 'https://api.github.com']

// The one file allowed to import() GitHub-mode code.
const MOUNT_FILE = 'main.tsx'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = path.join(root, 'client')
const distDir = path.join(clientDir, 'dist')
const pagesDir = path.join(clientDir, 'dist-pages')
const srcDir = path.join(clientDir, 'src')
const githubSrcDirs = [path.join(srcDir, 'backend'), path.join(srcDir, 'githubStorage')]

const failures = []
let checks = 0

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

// `name` documents the check where it is declared; failures name the file.
function check(_name, fn) {
  checks++
  fn()
}

// --- Default build: client/dist -------------------------------------------

function checkDefaultBuild() {
  if (!existsSync(distDir)) {
    failures.push(`${rel(distDir)}: missing; run \`npm run build -w client\` first`)
    checks += 3
    return
  }
  const files = walk(distDir)
  check('default build has no forbidden tokens', () => {
    for (const file of files) {
      const content = readFileSync(file)
      for (const token of FORBIDDEN_IN_DEFAULT) {
        if (content.includes(token)) failures.push(`${rel(file)}: contains forbidden token "${token}"`)
      }
    }
  })
  check('default build has no GitHub-mode file names', () => {
    for (const file of files) {
      const name = path.relative(distDir, file)
      for (const token of FORBIDDEN_IN_DEFAULT_FILE_NAMES) {
        if (name.toLowerCase().includes(token.toLowerCase())) {
          failures.push(`${rel(file)}: file name contains "${token}"`)
        }
      }
    }
  })
  check('default build index.html has no CSP meta', () => {
    const indexPath = path.join(distDir, 'index.html')
    if (!existsSync(indexPath)) {
      failures.push(`${rel(indexPath)}: missing`)
      return
    }
    if (readFileSync(indexPath, 'utf8').match(CSP_META)) failures.push(`${rel(indexPath)}: has a Content-Security-Policy meta tag`)
  })
}

// --- GitHub build: client/dist-pages ---------------------------------------

function attr(tag, name) {
  return tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]
}

function checkPagesBuild() {
  if (!existsSync(pagesDir)) {
    failures.push(`${rel(pagesDir)}: missing; run \`npm run build:pages -w client -- --base /<repo>/\` first`)
    checks += 7
    return
  }
  const indexPath = path.join(pagesDir, 'index.html')
  const html = readFileSync(indexPath, 'utf8')
  const tags = html.match(/<(script|link)\b[^>]*>/g) ?? []
  const entryTag = tags.find((t) => t.startsWith('<script') && attr(t, 'type') === 'module' && attr(t, 'src'))
  const entrySrc = entryTag && attr(entryTag, 'src')
  const baseMatch = entrySrc?.match(/^(.*\/)assets\/[^/]+\.js$/)
  const base = baseMatch?.[1]
  if (!entrySrc || !base) {
    failures.push(`${rel(indexPath)}: no <script type="module" src=".../assets/*.js"> to read the entry chunk and base from`)
    checks += 7
    return
  }

  // The entry chunk, plus any chunk index.html preloads with it, loads before
  // any dynamic import runs.
  const toFile = (url) => path.join(pagesDir, url.slice(base.length))
  const entryFiles = new Set([toFile(entrySrc)])
  for (const t of tags) {
    if (attr(t, 'rel') === 'modulepreload' && attr(t, 'href')?.startsWith(base)) entryFiles.add(toFile(attr(t, 'href')))
  }
  const chunks = walk(pagesDir).filter((f) => f.endsWith('.js'))
  const lazyChunks = chunks.filter((f) => !entryFiles.has(f))

  check('GitHub build carries GitHub-mode code in a lazy chunk', () => {
    for (const token of POSITIVE_CONTROL) {
      if (!lazyChunks.some((f) => readFileSync(f, 'utf8').includes(token))) {
        failures.push(`${rel(pagesDir)}: no non-entry JS chunk contains "${token}" (positive control)`)
      }
    }
  })
  check('GitHub build entry chunk has no GitHub-mode code', () => {
    for (const file of entryFiles) {
      if (!existsSync(file)) {
        failures.push(`${rel(file)}: entry chunk named in index.html does not exist`)
        continue
      }
      const content = readFileSync(file, 'utf8')
      for (const token of POSITIVE_CONTROL) {
        if (content.includes(token)) failures.push(`${rel(file)}: entry chunk contains "${token}"`)
      }
    }
  })
  check('GitHub build index.html names no data file', () => {
    if (html.includes('ledger.json.enc')) failures.push(`${rel(indexPath)}: contains "ledger.json.enc"`)
  })
  check('GitHub build index.html carries the CSP meta before any script or link', () => {
    const metas = html.match(CSP_META) ?? []
    if (metas.length !== 1) {
      failures.push(`${rel(indexPath)}: expected one Content-Security-Policy meta tag, found ${metas.length}`)
      return
    }
    const policy = attr(metas[0], 'content') ?? ''
    const connect = policy
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .find(([name]) => name === 'connect-src')
    for (const source of PAGES_CONNECT_SRC) {
      if (!connect?.includes(source)) failures.push(`${rel(indexPath)}: CSP connect-src does not allow ${source}`)
    }
    const firstResource = html.search(/<(script|link)\b/)
    if (firstResource >= 0 && html.indexOf(metas[0]) > firstResource) {
      failures.push(`${rel(indexPath)}: the CSP meta comes after a <script> or <link>`)
    }
  })

  const manifestPath = path.join(pagesDir, 'manifest.webmanifest')
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
  check('GitHub build manifest start_url and scope equal the base', () => {
    if (!manifest) {
      failures.push(`${rel(manifestPath)}: missing`)
      return
    }
    for (const key of ['start_url', 'scope']) {
      if (manifest[key] !== base) failures.push(`${rel(manifestPath)}: ${key} is ${JSON.stringify(manifest[key])}, expected "${base}"`)
    }
  })
  check('GitHub build manifest icons start with the base', () => {
    if (!manifest) return
    const icons = manifest.icons ?? []
    if (icons.length === 0) failures.push(`${rel(manifestPath)}: no icons`)
    for (const icon of icons) {
      if (!String(icon.src).startsWith(base)) failures.push(`${rel(manifestPath)}: icon src "${icon.src}" does not start with "${base}"`)
    }
  })
  check('GitHub build index.html URLs start with the base', () => {
    for (const t of tags) {
      const isScript = t.startsWith('<script')
      const relName = attr(t, 'rel')
      if (!isScript && !['icon', 'apple-touch-icon', 'manifest', 'modulepreload', 'stylesheet'].includes(relName)) continue
      const url = isScript ? attr(t, 'src') : attr(t, 'href')
      if (!url || /^[a-z]+:/i.test(url)) continue // inline script, or another origin (Google Fonts)
      if (!url.startsWith(base)) failures.push(`${rel(indexPath)}: ${isScript ? 'script src' : `${relName} href`} "${url}" does not start with "${base}"`)
    }
  })
}

// --- Source: client/src ---------------------------------------------------

function isTestFile(file) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.split(path.sep).includes('__tests__')
}

function targetsGithubCode(file, specifier) {
  if (/(^|\/)(backend|githubStorage)(\/|$)/.test(specifier)) return true
  if (!specifier.startsWith('.')) return false
  const target = path.resolve(path.dirname(file), specifier)
  return githubSrcDirs.some((dir) => target === dir || target.startsWith(dir + path.sep))
}

function checkSource() {
  check('only main.tsx imports GitHub-mode code', () => {
    const files = walk(srcDir).filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !f.endsWith('.d.ts') && !isTestFile(f))
    let mountImports = 0
    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      for (const m of content.matchAll(/\bimport\s*\(\s*(['"`])([^'"`]+)\1/g)) {
        if (!targetsGithubCode(file, m[2])) continue
        if (path.relative(srcDir, file) === MOUNT_FILE) {
          mountImports++
          continue
        }
        const line = content.slice(0, m.index).split('\n').length
        failures.push(`${rel(file)}:${line}: import("${m[2]}") of GitHub-mode code; only client/src/${MOUNT_FILE} may import it`)
      }
    }
    if (mountImports !== 1) {
      failures.push(`client/src/${MOUNT_FILE}: expected exactly one import() of GitHub-mode code, found ${mountImports}`)
    }
  })
}

checkDefaultBuild()
checkPagesBuild()
checkSource()

if (failures.length > 0) {
  for (const line of failures) console.error(line)
  process.exit(1)
}
console.log(`check:isolation: ${checks} checks passed (client/dist clean of ${FORBIDDEN_IN_DEFAULT.length} tokens and CSP meta, client/dist-pages lazy-loads GitHub mode with its CSP meta, single import() in client/src/${MOUNT_FILE})`)
