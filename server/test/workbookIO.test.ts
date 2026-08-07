import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import ExcelJS from "exceljs";

// Same pattern as finances.test.ts: LEDGER_DB_DIR must be set before
// workbookIO.ts's top-level DB_DIR evaluates, so it's imported dynamically
// after the env var is set rather than via a static top-level import.
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-workbookio-test-"));
process.env.LEDGER_DB_DIR = scratchDir;

const { saveWorkbook, DB_DIR, MAX_BACKUPS_PER_FILE } = await import("../src/excel/workbookIO.js");

const BACKUP_DIR = path.join(DB_DIR, ".backups");

function seedFakeBackup(base: string, stamp: string) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(path.join(BACKUP_DIR, `${base}.${stamp}.xlsx`), "fake");
}

function backupsFor(base: string): string[] {
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.startsWith(`${base}.`) && name.endsWith(".xlsx"))
    .sort();
}

async function newWorkbook(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Sheet1");
  return workbook;
}

describe("saveWorkbook backups", () => {
  it("only backs up once per process run, not on every save", async () => {
    const base = "OnceTest";
    const filePath = path.join(DB_DIR, `${base}.xlsx`);
    fs.writeFileSync(filePath, "original"); // must exist for a backup to fire at all

    await saveWorkbook(await newWorkbook(), filePath);
    await saveWorkbook(await newWorkbook(), filePath);
    await saveWorkbook(await newWorkbook(), filePath);

    expect(backupsFor(base)).toHaveLength(1);
  });

  it("prunes down to the most recent MAX_BACKUPS_PER_FILE, oldest first", async () => {
    const base = "PruneTest";
    const filePath = path.join(DB_DIR, `${base}.xlsx`);
    fs.writeFileSync(filePath, "original");

    // Pre-seed more than the cap worth of "prior runs'" backups.
    const preseeded = MAX_BACKUPS_PER_FILE + 5;
    for (let i = 1; i <= preseeded; i++) {
      seedFakeBackup(base, `2020-01-${String(i).padStart(2, "0")}T00-00-00-000Z`);
    }

    await saveWorkbook(await newWorkbook(), filePath); // this run's own backup

    const remaining = backupsFor(base);
    // +1 for the backup saveWorkbook itself just created this run.
    expect(remaining).toHaveLength(MAX_BACKUPS_PER_FILE);
    // The oldest 6 of the 15 preseeded (01-01 through 01-06) should be gone,
    // leaving 01-07 through 01-15 (9) plus today's fresh one (1) = 10.
    expect(remaining[0]).toContain("2020-01-07");
    expect(remaining.some((f) => f.includes("2020-01-01"))).toBe(false);
    expect(remaining.some((f) => f.includes("2020-01-06"))).toBe(false);
  });

  it("never prunes another source file's backups", async () => {
    const pruned = "IsolationPruned";
    const untouched = "IsolationUntouched";
    fs.writeFileSync(path.join(DB_DIR, `${pruned}.xlsx`), "original");

    for (let i = 1; i <= MAX_BACKUPS_PER_FILE + 3; i++) {
      seedFakeBackup(pruned, `2021-01-${String(i).padStart(2, "0")}T00-00-00-000Z`);
    }
    for (let i = 1; i <= 3; i++) {
      seedFakeBackup(untouched, `2021-01-${String(i).padStart(2, "0")}T00-00-00-000Z`);
    }

    await saveWorkbook(await newWorkbook(), path.join(DB_DIR, `${pruned}.xlsx`));

    expect(backupsFor(pruned)).toHaveLength(MAX_BACKUPS_PER_FILE);
    expect(backupsFor(untouched)).toHaveLength(3); // untouched by the other file's pruning
  });
});
