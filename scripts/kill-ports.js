const { execSync } = require("node:child_process");

// Server (PORT) and Vite client (fixed via strictPort in vite.config.ts).
const PORTS = [4000, 5173];

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
      execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      console.log(`Killed stale process ${pid} on port ${port}`);
    } catch {
      // already gone
    }
  }
}

for (const port of PORTS) killPort(port);
