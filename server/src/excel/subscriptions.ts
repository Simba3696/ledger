import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";
import { DB_DIR, LedgerError, saveWorkbook } from "./workbookIO.js";
import { addMonths, addYears, formatDate, parseDate, startOfDay } from "./dateMath.js";

const SUBSCRIPTIONS_PATH = path.join(DB_DIR, "Subscriptions.xlsx");
const SHEET_NAME = "Subscriptions";
const HEADERS = ["Service", "Amount", "Duration", "Expiry", "Card/Bank"];

export type Duration = "Monthly" | "Yearly";

/** A recurring subscription, tracked flat (not month-indexed) like Debts and
 * EMI — the set of active subscriptions changes as you add or cancel one. */
export interface SubscriptionEntry {
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

export function withComputed(entry: SubscriptionEntry, today: Date = new Date()): SubscriptionEntryComputed {
  const nextExpiry = formatDate(advanceToOnOrAfter(parseDate(entry.expiryAnchor), entry.duration, startOfDay(today)));
  return { ...entry, nextExpiry };
}

function validateEntry(service: string, amount: number, duration: string, expiryAnchor: string) {
  if (!service) throw new LedgerError("Service is required", 400);
  if (!Number.isFinite(amount) || amount <= 0) throw new LedgerError("Amount must be a positive number", 400);
  if (duration !== "Monthly" && duration !== "Yearly") throw new LedgerError('Duration must be "Monthly" or "Yearly"', 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiryAnchor)) throw new LedgerError("Expiry must be YYYY-MM-DD", 400);
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
  if (fs.existsSync(SUBSCRIPTIONS_PATH)) {
    await workbook.xlsx.readFile(SUBSCRIPTIONS_PATH);
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

function assertRealSubscriptionRow(sheet: ExcelJS.Worksheet, row: number) {
  const service = row >= 2 ? sheet.getRow(row).getCell(1).value : null;
  if (typeof service !== "string" || !service.trim()) {
    throw new LedgerError(`No subscription at row ${row}`, 404);
  }
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

export interface SubscriptionEditsInput {
  service: string;
  amount: number;
  duration: Duration;
  expiryAnchor: string; // YYYY-MM-DD
  cardOrBank: string;
}

export async function addSubscription(
  input: SubscriptionEditsInput,
  today: Date = new Date(),
): Promise<SubscriptionEntryComputed> {
  const service = input.service.trim();
  validateEntry(service, input.amount, input.duration, input.expiryAnchor);

  const workbook = await loadOrCreateWorkbook();
  const sheet = getSubscriptionsSheet(workbook);
  const rowNumber = sheet.rowCount + 1;
  const row = sheet.getRow(rowNumber);
  row.getCell(1).value = service;
  row.getCell(2).value = input.amount;
  row.getCell(3).value = input.duration;
  row.getCell(4).value = input.expiryAnchor;
  row.getCell(5).value = input.cardOrBank.trim();
  row.commit();

  await saveWorkbook(workbook, SUBSCRIPTIONS_PATH);
  const entry: SubscriptionEntry = {
    row: rowNumber,
    service,
    amount: input.amount,
    duration: input.duration,
    expiryAnchor: input.expiryAnchor,
    cardOrBank: input.cardOrBank.trim(),
  };
  return withComputed(entry, today);
}

export async function updateSubscription(
  rowNumber: number,
  input: SubscriptionEditsInput,
  today: Date = new Date(),
): Promise<SubscriptionEntryComputed> {
  const service = input.service.trim();
  validateEntry(service, input.amount, input.duration, input.expiryAnchor);

  const workbook = await loadOrCreateWorkbook();
  const sheet = getSubscriptionsSheet(workbook);
  assertRealSubscriptionRow(sheet, rowNumber);

  const row = sheet.getRow(rowNumber);
  row.getCell(1).value = service;
  row.getCell(2).value = input.amount;
  row.getCell(3).value = input.duration;
  row.getCell(4).value = input.expiryAnchor;
  row.getCell(5).value = input.cardOrBank.trim();
  row.commit();

  await saveWorkbook(workbook, SUBSCRIPTIONS_PATH);
  const entry: SubscriptionEntry = {
    row: rowNumber,
    service,
    amount: input.amount,
    duration: input.duration,
    expiryAnchor: input.expiryAnchor,
    cardOrBank: input.cardOrBank.trim(),
  };
  return withComputed(entry, today);
}

export async function deleteSubscription(rowNumber: number): Promise<void> {
  const workbook = await loadOrCreateWorkbook();
  const sheet = getSubscriptionsSheet(workbook);
  assertRealSubscriptionRow(sheet, rowNumber);

  sheet.spliceRows(rowNumber, 1);
  await saveWorkbook(workbook, SUBSCRIPTIONS_PATH);
}
