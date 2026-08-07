const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Minimal .env reader (no dependency) — just enough to pick up PORT/
// VITE_DEV_PORT overrides from server/.env and client/.env, so a separate
// checkout/worktree of this repo (e.g. one used for experimentation) can
// target its own dev ports instead of force-killing whatever's listening on
// the *other* checkout's ports — this script's whole job is to kill
// anything already listening, so getting this wrong would kill a
// completely unrelated running server. Defaults (4000/5173) are unchanged
// for any checkout with no .env override, e.g. the main production one.
function readEnvFile(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (match) vars[match[1]] = match[2].replace(/^["']|["']$/, "").replace(/["']$/, "");
  }
  return vars;
}

const serverEnv = readEnvFile(path.join(__dirname, "..", "server", ".env"));
const clientEnv = readEnvFile(path.join(__dirname, "..", "client", ".env"));

// Server (PORT) and Vite client (VITE_DEV_PORT) — overridable per-checkout.
const PORTS = [
  Number(process.env.PORT || serverEnv.PORT) || 4000,
  Number(process.env.VITE_DEV_PORT || clientEnv.VITE_DEV_PORT) || 5173,
];

function killPort(port) {
  let output;
  try {
    output = execSync("netstat -ano", { encoding: "utf8" });
  } catch {
    return;
  }

  const pids = new Set();
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== "TCP" || parts[3] !== "LISTENING") continue;
    const localPort = parts[1]?.split(":").pop();
    if (localPort === String(port)) pids.add(parts[4]);
  }

  for (const pid of pids) {
    if (!pid || pid === "0") continue;
    try {
      // /T also kills any children of this PID — the port holder itself is
      // usually the deepest process in the tree (tsx/vite), but this is
      // cheap insurance against leaving grandchildren behind.
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
      console.log(`Killed stale process ${pid} on port ${port}`);
    } catch {
      // already gone
    }
  }
}

for (const port of PORTS) killPort(port);
