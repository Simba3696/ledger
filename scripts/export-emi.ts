// Writes the EMI export files (Excel, JSON and two CSVs) into exports/.
//
// It reads the EMI list and the Upcoming EMIs chart's figures from a running
// app's existing read-only API (GET /api/emi and
// /api/emi-monthly-projection?months=auto), then builds the export locally
// with server/src/excel/emiExport.ts. So it never opens the data folder and
// never changes the running app: the export reflects exactly what the app
// shows. Start the app first (or have the Scheduled Task running), then:
//
//   npm run export:emi -- --from 2026-10 --to 2030-06 --salary 67000 --expenses 20000
//
// Options: --from/--to (YYYY-MM, required), --salary and --expenses (required:
// the app doesn't store them), --server (default http://localhost:<PORT from
// server/.env, or 4000>), --out (default exports/). exports/ is gitignored.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EmiEntryComputed, EmiMonthlyProjection } from "../server/src/excel/emi.js";
import { buildEmiExportFrom, exportJson, exportXlsx, monthlyCsv, plansCsv } from "../server/src/excel/emiExport.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPort(): string {
  const envFile = path.join(ROOT, "server", ".env");
  if (!fs.existsSync(envFile)) return "4000";
  const m = /^\s*PORT\s*=\s*(\d+)/m.exec(fs.readFileSync(envFile, "utf8"));
  return m ? m[1] : "4000";
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z]+)$/.exec(argv[i]);
    if (!m || argv[i + 1] === undefined) throw new Error(`Unexpected argument: ${argv[i]}`);
    args[m[1]] = argv[++i];
  }
  return args;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["from", "to", "salary", "expenses"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  const server = (args.server ?? `http://localhost:${readPort()}`).replace(/\/$/, "");
  const outDir = path.resolve(ROOT, args.out ?? "exports");

  // Read both as of the same moment the export is stamped with.
  const today = new Date();
  const [emis, chart] = await Promise.all([
    getJson<EmiEntryComputed[]>(`${server}/api/emi`),
    getJson<EmiMonthlyProjection[]>(`${server}/api/emi-monthly-projection?months=auto`),
  ]);
  const data = buildEmiExportFrom(emis, chart, {
    from: args.from,
    to: args.to,
    monthlySalary: Number(args.salary),
    essentialExpenses: Number(args.expenses),
    today,
  });

  fs.mkdirSync(outDir, { recursive: true });
  const files: [string, string | Buffer][] = [
    ["emi_full_export.xlsx", await exportXlsx(data)],
    ["emi_full_export.json", exportJson(data)],
    ["emi_full_export.csv", plansCsv(data)],
    ["emi_monthly_projection.csv", monthlyCsv(data)],
  ];
  for (const [name, body] of files) {
    const target = path.join(outDir, name);
    fs.writeFileSync(target, body);
    console.log(`Wrote ${target}`);
  }
  const failed = data.validation.filter((v) => !v.passed);
  console.log(
    failed.length
      ? `Validation: ${failed.length} check(s) need attention: ${failed.map((v) => v.check).join("; ")}`
      : "Validation: every check passed",
  );
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
