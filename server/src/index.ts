import "dotenv/config";
import express from "express";
import cors from "cors";
import { router } from "./routes.js";
import { DB_DIR } from "./excel/ledger.js";

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api", router);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`Ledger server listening on http://localhost:${port}`);
  console.log(`Reading/writing Excel files in: ${DB_DIR}`);
});
