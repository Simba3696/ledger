/**
 * Shared by the e2e scripts (regression.ts, expensesOnly.ts, screenshots.ts): this
 * checkout's ports and server settings, and starting/stopping `npm run dev`
 * against the LOCAL database.
 */
import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

// Same minimal .env reader as scripts/kill-ports.js, for the same reason:
// this checkout's server/.env / client/.env may override the default dev
// ports (e.g. to run alongside another checkout without colliding) — the
// dev server these scripts spawn picks that up automatically via its own
// dotenv/vite loading, so the scripts must read the same values themselves
// or they'll wait on the wrong port forever (or worse, silently fall back to
// whatever's actually on 4000, which could be a *different* checkout's
// live server entirely).
function readEnvFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return vars;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (match) vars[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return vars;
}
export const serverEnv = readEnvFile(path.join(ROOT, "server", ".env"));
const clientEnv = readEnvFile(path.join(ROOT, "client", ".env"));
export const SERVER_PORT = Number(serverEnv.PORT) || 4000;
export const CLIENT_PORT = Number(clientEnv.VITE_DEV_PORT) || 5173;

/** The dev server refuses to start without auth configured (LLD §6), which
 * would otherwise surface only as a timeout waiting on its port. The client
 * has no sign-in screen yet, so e2e runs need AUTH_DISABLED=true. */
export function assertAuthDisabled(): void {
  if (serverEnv.AUTH_DISABLED !== "true") {
    throw new Error(
      "server/.env must set AUTH_DISABLED=true for e2e until the client has a sign-in screen " +
        "(see server/.env.example and docs/architecture/LLD.md §6).",
    );
  }
}

export async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet, keep polling
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

/** Spawns `npm run dev` (server + client on this checkout's ports) with
 * `extraEnv` added to its environment, e.g. ENABLED_MODULES. dotenv never
 * overrides a variable that is already set, so these win over server/.env
 * without editing it. Resolves once both ports answer. */
export async function startDevServer(extraEnv: Record<string, string> = {}): Promise<ChildProcessWithoutNullStreams> {
  const devProcess = spawn("npm", ["run", "dev"], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    shell: true,
  });
  devProcess.stdout.on("data", () => {});
  devProcess.stderr.on("data", () => {});
  try {
    await waitForServer(`http://localhost:${SERVER_PORT}/api/categories`, 30000);
    await waitForServer(`http://localhost:${CLIENT_PORT}`, 30000);
  } catch (err) {
    stopDevServer(devProcess);
    throw err;
  }
  return devProcess;
}

export function stopDevServer(devProcess: ChildProcessWithoutNullStreams | undefined): void {
  console.log("Stopping dev server...");
  // `npm run dev` was spawned with `shell: true` (needed to resolve `npm`
  // via PATH on Windows), which makes `devProcess` a wrapper around cmd.exe
  // — plain `.kill()` only kills that wrapper, not the concurrently/vite/
  // tsx descendants it spawned, leaving them as orphaned background
  // node.exe processes. `taskkill /T` kills the whole tree rooted at the
  // wrapper's PID instead.
  if (devProcess?.pid) {
    try {
      execSync(`taskkill /PID ${devProcess.pid} /T /F`, { stdio: "ignore" });
    } catch {
      // already gone
    }
  }
  try {
    execSync("node scripts/kill-ports.js", { cwd: ROOT, stdio: "ignore" });
  } catch {
    // best-effort cleanup
  }
}
