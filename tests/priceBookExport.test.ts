/**
 * The .xlsx snapshot is a report of the database — these tests prove the bytes
 * that come back actually open as a workbook carrying the book's rows, in the
 * app's category order, with the retired trail and rate config alongside.
 */

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { exportPriceBookXlsx } from "../src/services/priceBookExport";

const item = (over: Record<string, unknown>) => ({
  itemId: "x", description: "X", category: "CAT", subCategory: null, unitLabel: null,
  sector: null, rowType: "MATERIAL + LABOR", notes: null, companyCost: 10, companyPrice: 20,
  markupTier: "T3", laborNormal: 1, laborDifficult: 1.5, laborVeryDifficult: 2,
  sellNormal: 170, sellDifficult: 245, sellVeryDifficult: 320, source: "kyles-tab",
  retiredAt: null, ...over,
});

// Just enough PrismaClient for the export path: active + retired item queries,
// the category groupBy + meta order, and the five markup-tier config rows.
function fakePrisma() {
  const active = [
    item({ itemId: "b-item", category: "SECOND" }),
    item({ itemId: "a-item", category: "FIRST" }),
  ];
  const retired = [item({ itemId: "old-item", category: "FIRST", retiredAt: new Date("2026-08-25T12:00:00Z") })];
  return {
    priceBookAtomic: {
      findMany: (args: { where: { retiredAt: null | { not: null } } }) =>
        Promise.resolve(args.where.retiredAt === null ? active : retired),
      groupBy: () =>
        Promise.resolve([
          { category: "FIRST", _count: { _all: 1 } },
          { category: "SECOND", _count: { _all: 1 } },
        ]),
    },
    priceBookCategoryMeta: {
      // SECOND is ordered ahead of FIRST, so the sheet must lead with b-item.
      findMany: () => Promise.resolve([{ name: "SECOND", sortOrder: 0 }, { name: "FIRST", sortOrder: 1 }]),
    },
    priceBookRateConfig: {
      findMany: () =>
        Promise.resolve([1, 2, 3, 4, 5].map((n) => ({ key: `markupTier${n}`, numberValue: n }))),
    },
  } as never;
}

describe("exportPriceBookXlsx", () => {
  it("produces a workbook with the three sheets, rows in category display order", async () => {
    const bytes = await exportPriceBookXlsx(fakePrisma());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);

    expect(wb.worksheets.map((s) => s.name)).toEqual(["Price Book", "Retired", "Rate Config"]);

    const book = wb.getWorksheet("Price Book")!;
    expect(book.rowCount).toBe(3); // header + 2 items
    expect(book.getRow(2).getCell(1).value).toBe("b-item"); // SECOND ordered first
    expect(book.getRow(3).getCell(1).value).toBe("a-item");
    expect(book.getRow(2).getCell(13).value).toBe(170); // sell normal survives round-trip

    const retired = wb.getWorksheet("Retired")!;
    expect(retired.rowCount).toBe(2);
    expect(retired.getRow(2).getCell(1).value).toBe("old-item");
    expect(retired.getRow(2).getCell(18).value).toBe("2026-08-25");

    const rates = wb.getWorksheet("Rate Config")!;
    expect(rates.getRow(2).getCell(2).value).toBe(150); // labor rate
    expect(rates.getRow(3).getCell(2).value).toBe(1); // tier 1
  });
});
