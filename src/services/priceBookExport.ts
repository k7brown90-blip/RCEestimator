/**
 * Price book → .xlsx snapshot (Phase 2 of the in-app editor).
 *
 * The database is the book; this export is a REPORT of it, never an input.
 * Option A's pitch, ratified 2026-08-30: "the app can export an .xlsx snapshot
 * whenever you want a spreadsheet view — the workbook becomes a report, not an
 * input." Nothing reads these files back.
 *
 * Three sheets:
 *   Price Book  — every active item, in category display order.
 *   Retired     — retire-never-delete's paper trail.
 *   Rate Config — the labor rate and markup tiers the prices derive from.
 */

import ExcelJS from "exceljs";
import type { PrismaClient } from "@prisma/client";
import { listCategories, loadPricingContext } from "./priceBookCatalog";

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" },
};
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFFFFFFF" } };

const ITEM_COLUMNS = [
  { header: "Item ID", key: "itemId", width: 34 },
  { header: "Description", key: "description", width: 52 },
  { header: "Category", key: "category", width: 26 },
  { header: "Sub-category", key: "subCategory", width: 18 },
  { header: "Unit", key: "unitLabel", width: 12 },
  { header: "Row type", key: "rowType", width: 18 },
  { header: "Company cost", key: "companyCost", width: 14, money: true },
  { header: "Tier", key: "markupTier", width: 7 },
  { header: "Material w/ markup", key: "companyPrice", width: 17, money: true },
  { header: "Hrs normal", key: "laborNormal", width: 11 },
  { header: "Hrs difficult", key: "laborDifficult", width: 12 },
  { header: "Hrs very difficult", key: "laborVeryDifficult", width: 15 },
  { header: "Sell normal", key: "sellNormal", width: 12, money: true },
  { header: "Sell difficult", key: "sellDifficult", width: 13, money: true },
  { header: "Sell very difficult", key: "sellVeryDifficult", width: 16, money: true },
  { header: "Notes", key: "notes", width: 40 },
  { header: "Source", key: "source", width: 12 },
] as const;

function addItemSheet(
  wb: ExcelJS.Workbook,
  name: string,
  rows: Array<Record<string, unknown>>,
  extraColumns: Array<{ header: string; key: string; width: number }> = [],
): void {
  const sheet = wb.addWorksheet(name);
  sheet.columns = [...ITEM_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width })), ...extraColumns];
  const head = sheet.getRow(1);
  head.fill = HEADER_FILL;
  head.font = HEADER_FONT as ExcelJS.Font;
  for (const row of rows) sheet.addRow(row);
  for (const col of ITEM_COLUMNS) {
    if ("money" in col && col.money) sheet.getColumn(col.key).numFmt = '"$"#,##0.00';
  }
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

/** Build the snapshot workbook. Returns xlsx bytes ready to send. */
export async function exportPriceBookXlsx(prisma: PrismaClient): Promise<Buffer> {
  const [active, retired, categories, { tiers, rate }] = await Promise.all([
    prisma.priceBookAtomic.findMany({ where: { retiredAt: null } }),
    prisma.priceBookAtomic.findMany({ where: { retiredAt: { not: null } }, orderBy: { retiredAt: "desc" } }),
    listCategories(prisma),
    loadPricingContext(prisma),
  ]);

  // Category display order carries into the sheet, same as the app shows it.
  const catOrder = new Map(categories.map((c, i) => [c.name, i]));
  active.sort((a, b) =>
    (catOrder.get(a.category ?? "") ?? 9999) - (catOrder.get(b.category ?? "") ?? 9999)
    || (a.subCategory ?? "").localeCompare(b.subCategory ?? "")
    || a.itemId.localeCompare(b.itemId));

  const wb = new ExcelJS.Workbook();
  wb.creator = "RCE Estimating";
  wb.created = new Date();

  addItemSheet(wb, "Price Book", active as unknown as Array<Record<string, unknown>>);
  addItemSheet(
    wb,
    "Retired",
    retired.map((r) => ({ ...r, retiredAt: r.retiredAt?.toISOString().slice(0, 10) ?? "" })) as unknown as Array<Record<string, unknown>>,
    [{ header: "Retired on", key: "retiredAt", width: 12 }],
  );

  const rates = wb.addWorksheet("Rate Config");
  rates.columns = [
    { header: "Setting", key: "k", width: 34 },
    { header: "Value", key: "v", width: 14 },
  ];
  const rHead = rates.getRow(1);
  rHead.fill = HEADER_FILL;
  rHead.font = HEADER_FONT as ExcelJS.Font;
  rates.addRow({ k: "Labor rate ($/hour)", v: rate });
  rates.addRow({ k: "Markup tier 1 (cost under $1.00)", v: tiers.tier1 });
  rates.addRow({ k: "Markup tier 2 ($1.00–$9.99)", v: tiers.tier2 });
  rates.addRow({ k: "Markup tier 3 ($10.00–$49.99)", v: tiers.tier3 });
  rates.addRow({ k: "Markup tier 4 ($50.00–$199.99)", v: tiers.tier4 });
  rates.addRow({ k: "Markup tier 5 ($200.00 and up)", v: tiers.tier5 });
  rates.addRow({ k: "Sell formula", v: null });
  rates.addRow({ k: "  material = cost × tier multiplier", v: null });
  rates.addRow({ k: "  sell = hours × rate + material", v: null });

  const bytes = await wb.xlsx.writeBuffer();
  return Buffer.from(bytes as ArrayBuffer);
}
