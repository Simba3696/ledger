// One-time import of an Excel-edition data folder into this edition's
// database (LLD §8). Usage: see HELP below, or `npm run import-xlsx -- --help`.
// The work is in scripts/legacy-excel/importer.ts.
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { formatReport, ImportError, importXlsx } from "./legacy-excel/importer.js";

const HELP = `Imports an Excel-edition data folder (the "Expenses (YYYY).xlsx" workbooks,
Finances.xlsx, Debts.xlsx, EMI.xlsx, Subscriptions.xlsx, CreditCardBills.xlsx
and categories.json) into an empty database of this edition. The folder is only
read, never changed. Everything is written in one transaction: if anything
fails, nothing is saved.

Usage:
  npm run import-xlsx -- --from <folder> [options]
  npx tsx scripts/import-xlsx.ts --from <folder> [options]

Options:
  --from <folder>         The Excel edition's data folder (its LEDGER_DB_DIR). Required.
                          A relative path is from the directory you ran the
                          command in.
  --database-url <url>    The database to import into. Default: DATABASE_URL from
                          server/.env (a DATABASE_URL in the shell is ignored).
  --dry-run               Read and check everything, write it inside a transaction,
                          print the report, then roll the transaction back. Nothing
                          is saved.
  --force                 Import into a database that already has data by first
                          deleting EVERY row in categories, ledger_years, expenses,
                          month_locks, finance_months, savings_balances, debts,
                          emis, subscriptions and card_bills (truncate, inside the
                          same transaction). Without it, the import refuses to run
                          if any of those tables has rows, except the four default
                          categories a new deployment starts with, which it replaces.
  --yes                   Required to write to a database that isn't on this
                          computer (any host but localhost/127.0.0.1/::1), such as
                          a hosted Supabase project. Not needed with --dry-run.
  --help                  Show this text.

Rows a database column can't hold (a blank remark, an amount of 0, an impossible
date, ...) are skipped and listed; nothing is silently changed. An expense whose
fill colour matches no category is imported without a category and listed.
Exit code: 0 when the import (or dry run) completed, 1 on a fatal error (nothing
written), 2 on a usage error.`;

interface Args {
  from?: string;
  databaseUrl?: string;
  dryRun: boolean;
  force: boolean;
  yes: boolean;
  help: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, force: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      return v;
    };
    if (arg === "--from") args.from = value();
    else if (arg === "--database-url") args.databaseUrl = value();
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--yes") args.yes = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new UsageError(`Unknown option: ${arg}`);
  }
  return args;
}

/** DATABASE_URL from server/.env, next to this script's repository. */
function databaseUrlFromServerEnv(): string | undefined {
  const envPath = path.resolve(path.dirname(process.argv[1] ?? "."), "..", "server", ".env");
  if (!fs.existsSync(envPath)) return undefined;
  return dotenv.parse(fs.readFileSync(envPath)).DATABASE_URL;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Where a URL points, without its password: "host:port/db as user". */
function describeTarget(url: URL): string {
  const db = url.pathname.replace(/^\//, "") || "postgres";
  return `${url.hostname}:${url.port || "5432"}/${db}${url.username ? ` as ${decodeURIComponent(url.username)}` : ""}`;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (!args.from) {
    console.error(`--from <folder> is required.\n\n${HELP}`);
    return 2;
  }

  const databaseUrl = args.databaseUrl ?? databaseUrlFromServerEnv();
  if (!databaseUrl) {
    console.error("No database: pass --database-url, or set DATABASE_URL in server/.env.");
    return 2;
  }
  let target: URL;
  try {
    target = new URL(databaseUrl);
  } catch {
    // Never echo the value: it holds the password.
    console.error("The database URL isn't a valid postgresql:// URL.");
    return 2;
  }
  if (target.protocol !== "postgresql:" && target.protocol !== "postgres:") {
    console.error("The database URL must start with postgresql://.");
    return 2;
  }

  // `npm run` starts this script in the repository root; INIT_CWD is where
  // the command was typed, which a relative --from means.
  const from = path.resolve(process.env.INIT_CWD ?? process.cwd(), args.from);
  const local = LOCAL_HOSTS.has(target.hostname);
  console.log(`Source: ${from}`);
  console.log(`Target: ${describeTarget(target)}${local ? " (this computer)" : " (REMOTE)"}`);
  console.log(`Mode:   ${args.dryRun ? "dry run (rolled back, nothing saved)" : "import"}${args.force ? ", --force (existing rows are deleted first)" : ""}\n`);
  if (!local && !args.dryRun && !args.yes) {
    console.error(
      `Refusing to write to ${target.hostname} without --yes. Check the target above is the database you mean, ` +
        "run with --dry-run first, then add --yes.",
    );
    return 1;
  }

  try {
    const report = await importXlsx({ from, databaseUrl, dryRun: args.dryRun, force: args.force });
    console.log(formatReport(report));
    return 0;
  } catch (e) {
    if (e instanceof ImportError) {
      console.error(`Import stopped, nothing was written: ${e.message}`);
    } else {
      // A database error: its message names the problem (connection, auth,
      // a constraint) but never the URL's password.
      const err = e as Error & { code?: string };
      console.error(`Import failed, nothing was written: ${err.code ? `${err.code} ` : ""}${err.message}`);
    }
    return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(`Import failed: ${(e as Error).message}`);
    process.exitCode = 1;
  },
);
