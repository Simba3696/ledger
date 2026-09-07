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

// Serves the production client build (npm run start), so the whole app is
// reachable from one port with no dev-server/HMR overhead. Gated on actually
// running from a build (this file's own directory is server/dist, i.e.
// `node dist/index.js`), not merely on client/dist existing — `npm run dev`
// runs this same source file directly via `tsx watch src/index.ts`, and
// client/dist commonly *does* already exist on disk from an earlier `npm
// run build` in the same checkout. Without this check, a dev session on
// :4000 would silently serve that stale build next to Vite's live one on
// :5173, with no indication anything was out of date — confusing against
// real data specifically because the Remote-access setup below trains you
// to think of :4000 as "the app".
const isBuiltRun = path.basename(__dirname) === "dist";
if (isBuiltRun && existsSync(CLIENT_DIST)) {
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
