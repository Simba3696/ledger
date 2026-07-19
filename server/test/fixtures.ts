import ExcelJS from "exceljs";
import { CATEGORY_COLORS, type Category } from "../src/excel/categoryColors.js";

// Mirrors the real sheets' conventions (verified against the user's actual
// workbooks during development) so tests exercise the same code paths a real
// file would. Entirely synthetic data — no real financial records are ever
// written to this repo.
const AMOUNT_NUMFMT =
  '_ [$₹-4009]\\ * #,##0.00_ ;_ [$₹-4009]\\ * \\-#,##0.00_ ;_ [$₹-4009]\\ * "-"??_ ;_ @_ ';

export interface SeedEntry {
  amount: number; // positive rupee amount
  remarks: string;
  category: Category;
  isCard?: boolean;
}

function addSeedRow(sheet: ExcelJS.Worksheet, rowNumber: number, entry: SeedEntry, isLast: boolean) {
  const fill: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: CATEGORY_COLORS[entry.category] } };
  const closingBottom: Partial<ExcelJS.Border> = { style: "medium", color: { argb: "FF000000" } };
  const row = sheet.getRow(rowNumber);

  const cell1 = row.getCell(1);
  cell1.value = -Math.abs(entry.amount);
  cell1.numFmt = AMOUNT_NUMFMT;
  cell1.fill = fill;
  cell1.alignment = { horizontal: "right", vertical: "middle" };
  cell1.border = {
    left: { style: "medium" },
    right: { style: "medium" },
    top: { style: "thin" },
    bottom: isLast ? closingBottom : { style: "thin" },
  };

  const cell2 = row.getCell(2);
  cell2.value = entry.remarks;
  cell2.fill = fill;
  cell2.alignment = { horizontal: "left", vertical: "middle" };
  cell2.border = cell1.border;

  if (entry.isCard) {
    const cell3 = row.getCell(3);
    cell3.value = "CC";
    cell3.fill = fill;
    cell3.border = { right: { style: "medium" }, top: { style: "medium" }, bottom: { style: "medium" } };
  }

  row.commit();
}

export interface FixtureSheet {
  name: string;
  entries: SeedEntry[];
  protect?: boolean;
}

/** Builds a synthetic workbook matching the real sheets' conventions and
 * writes it to `filePath`. Each key in `sheets` is a month sheet name. */
export async function buildFixtureWorkbook(filePath: string, sheets: FixtureSheet[]): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  for (const { name, entries, protect } of sheets) {
    const sheet = workbook.addWorksheet(name);
    sheet.getRow(1).getCell(1).value = "Amount";
    sheet.getRow(1).getCell(2).value = "Remarks";
    sheet.getRow(1).getCell(3).value = "CC";

    entries.forEach((entry, i) => addSeedRow(sheet, i + 2, entry, i === entries.length - 1));

    if (protect) {
      await sheet.protect("test-password", {});
    }
  }
  await workbook.xlsx.writeFile(filePath);
}
