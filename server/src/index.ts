import "dotenv/config";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { router } from "./routes.js";
import { DB_DIR } from "./excel/ledger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, "../../client/dist");

const app = express();
app.use(express.json());
app.use("/api", router);

// Serves the production client build when it exists (npm run start), so the
// whole app is reachable from one port with no dev-server/HMR overhead.
// Harmless during `npm run dev` — the folder won't exist yet, so this block
// is skipped and Vite's own dev server (port 5173) handles the frontend.
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
}

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`Ledger server listening on http://localhost:${port}`);
  console.log(`Reading/writing Excel files in: ${DB_DIR}`);
});
