import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { getDbDir, LedgerError } from "./workbookIO.js";
import { addMonths, addYears, formatDate, parseDate, startOfDay } from "./dateMath.js";

function subscriptionsPath(): string {
  return path.join(getDbDir(), "Subscriptions.xlsx");
}
const SHEET_NAME = "Subscriptions";
const HEADERS = ["Service", "Amount", "Duration", "Expiry", "Card/Bank"];

type Duration = "Monthly" | "Yearly";

/** A recurring subscription, tracked flat (not month-indexed) like Debts and
 * EMI — the set of active subscriptions changes as you add or cancel one. */
interface SubscriptionEntry {
  row: number;
  service: string;
  amount: number;
  duration: Duration;
  /** The last known/entered renewal date — not necessarily in the future; see
   * `nextExpiry`, which auto-advances past it. */
  expiryAnchor: string; // YYYY-MM-DD
  /** Free text ("N/A" if not billed to a card), matching the source sheet. */
  cardOrBank: string;
}

export interface SubscriptionEntryComputed extends SubscriptionEntry {
  /** `expiryAnchor` advanced forward by whole Monthly/Yearly cycles until
   * it's on or after today — never written back, so `expiryAnchor` always
   * stays the real last-entered renewal date and this stays in sync with
   * "now" on every read. */
  nextExpiry: string; // YYYY-MM-DD
}

function advanceToOnOrAfter(anchor: Date, duration: Duration, today: Date): Date {
  let date = anchor;
  for (let i = 0; i < 1200 && date < today; i++) {
    date = duration === "Monthly" ? addMonths(date, 1) : addYears(date, 1);
  }
  return date;
}

function withComputed(entry: SubscriptionEntry, today: Date = new Date()): SubscriptionEntryComputed {
  const nextExpiry = formatDate(advanceToOnOrAfter(parseDate(entry.expiryAnchor), entry.duration, startOfDay(today)));
  return { ...entry, nextExpiry };
}

function resolveNumber(value: ExcelJS.CellValue): number | null {
  if (typeof value === "number") return value;
  if (value && typeof value === "object" && "result" in value && typeof value.result === "number") {
    return value.result;
  }
  return null;
}

async function loadOrCreateWorkbook(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  if (fs.existsSync(subscriptionsPath())) {
    await workbook.xlsx.readFile(subscriptionsPath());
  } else {
    workbook.addWorksheet(SHEET_NAME).addRow(HEADERS);
  }
  return workbook;
}

function getSubscriptionsSheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) throw new LedgerError(`Subscriptions.xlsx is missing its "${SHEET_NAME}" sheet`, 500);
  return sheet;
}

export async function listSubscriptions(today: Date = new Date()): Promise<SubscriptionEntryComputed[]> {
  const workbook = await loadOrCreateWorkbook();
  const sheet = getSubscriptionsSheet(workbook);
  const entries: SubscriptionEntry[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const service = row.getCell(1).value;
    const amount = resolveNumber(row.getCell(2).value);
    const duration = row.getCell(3).value;
    const expiryAnchor = row.getCell(4).value;
    const cardOrBank = row.getCell(5).value;
    if (
      typeof service === "string" &&
      service.trim() &&
      amount !== null &&
      (duration === "Monthly" || duration === "Yearly") &&
      typeof expiryAnchor === "string"
    ) {
      entries.push({
        row: rowNumber,
        service,
        amount,
        duration,
        expiryAnchor,
        cardOrBank: typeof cardOrBank === "string" ? cardOrBank : "",
      });
    }
  });
  return entries.map((e) => withComputed(e, today));
}
