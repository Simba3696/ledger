import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keeps the configuration docs honest (LLD §9): every environment variable
// the code reads is documented in its .env.example, every `# NAME=` example
// there is still read by something, and every variable a deployment sets is
// in docs/DEPLOY.md. No database needed.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx|js)$/.test(entry.name) ? [full] : [];
  });
}

/** Names read as `process.env.X`, `env.X` (an injected env object) or
 * `import.meta.env.X` across the given files. */
function envReads(files: string[]): Set<string> {
  const names = new Set<string>();
  for (const file of files) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) names.add(m[1]);
  }
  return names;
}

/** The `# NAME=value` examples an .env.example offers to uncomment. */
function exampleNames(file: string): Set<string> {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  return new Set([...text.matchAll(/^#\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
}

function mentions(file: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

// Set by the hosting platform (or Node tooling), never by an owner; the
// server only reads them to recognise where it runs.
const PLATFORM = new Set(["NODE_ENV", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "LAMBDA_TASK_ROOT"]);
// Meaningful only on a developer's machine, never on Netlify.
const LOCAL_ONLY = new Set(["PORT", "AUTH_DISABLED", "VITE_DEV_PORT", "VITE_API_PROXY_TARGET"]);

const serverReads = envReads([
  ...sourceFiles(path.join(ROOT, "server/src")),
  ...sourceFiles(path.join(ROOT, "netlify/functions")),
]);
const clientReads = envReads([...sourceFiles(path.join(ROOT, "client/src")), path.join(ROOT, "client/vite.config.ts")]);
// kill-ports.js reads one port from each side.
const killPortsReads = envReads([path.join(ROOT, "scripts/kill-ports.js")]);

describe("environment variable documentation", () => {
  it("finds the variables it is checking (guards the scan itself)", () => {
    expect([...serverReads]).toEqual(expect.arrayContaining(["DATABASE_URL", "SUPABASE_URL", "OWNER_EMAIL", "PORT"]));
    expect([...clientReads]).toEqual(expect.arrayContaining(["VITE_SUPABASE_URL", "VITE_DEV_PORT"]));
  });

  it("server/.env.example documents every variable the server reads", () => {
    const missing = [...serverReads].filter((name) => !mentions("server/.env.example", name));
    expect(missing).toEqual([]);
  });

  it("client/.env.example documents every variable the client and its Vite config read", () => {
    const missing = [...clientReads].filter((name) => !mentions("client/.env.example", name));
    expect(missing).toEqual([]);
  });

  it("both .env.example files together document what scripts/kill-ports.js reads", () => {
    expect([...killPortsReads]).toEqual(expect.arrayContaining(["PORT", "VITE_DEV_PORT"]));
    const missing = [...killPortsReads].filter(
      (name) => !mentions("server/.env.example", name) && !mentions("client/.env.example", name),
    );
    expect(missing).toEqual([]);
  });

  it("every example setting in the .env.example files is still read by the code", () => {
    expect([...exampleNames("server/.env.example")].filter((n) => !serverReads.has(n))).toEqual([]);
    expect([...exampleNames("client/.env.example")].filter((n) => !clientReads.has(n))).toEqual([]);
  });

  it("docs/DEPLOY.md and LLD §9 cover every variable a deployment sets", () => {
    const deployed = [...serverReads, ...clientReads].filter((n) => !PLATFORM.has(n) && !LOCAL_ONLY.has(n));
    expect(deployed).toEqual(expect.arrayContaining(["DATABASE_URL", "VITE_SUPABASE_ANON_KEY", "ENABLED_MODULES", "APP_TIMEZONE"]));
    expect(deployed.filter((n) => !mentions("docs/DEPLOY.md", n))).toEqual([]);
    expect(deployed.filter((n) => !mentions("docs/architecture/LLD.md", n))).toEqual([]);
  });

  it("LLD §9 also lists the local-only variables", () => {
    const local = [...serverReads, ...clientReads, ...killPortsReads].filter((n) => LOCAL_ONLY.has(n));
    expect(local).toEqual(expect.arrayContaining([...LOCAL_ONLY]));
    expect(local.filter((n) => !mentions("docs/architecture/LLD.md", n))).toEqual([]);
  });
});
