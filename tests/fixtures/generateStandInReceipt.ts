/**
 * Generates the stand-in Home Depot order PDF used by
 * tests/receiptVisionPdf.test.ts when the real fixture (Kyle's actual
 * PO-2026-0021.pdf, order #WH45461428) is not on disk at
 * tests/fixtures/home-depot-order-WH45461428.pdf.
 *
 * This mirrors the REAL order's layout — item name with the manufacturer
 * model code in parentheses, price/item, qty, line total per row, then
 * Subtotal / Sales Tax / Total — but uses its own made-up numbers (chosen so
 * lines + tax == total to the cent) rather than Kyle's real order, since the
 * real order's total is proven only by the real file. The test that reads
 * this fixture stubs the OpenAI call and never asks a model to OCR it, so
 * only the layout needs to be faithful, not the exact figures.
 *
 * One-off generator, not run by the test suite itself. Regenerate with:
 *   npx tsx tests/fixtures/generateStandInReceipt.ts
 */
import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";
import path from "node:path";

export const STAND_IN_LINES = [
  { name: "Combination Arc-Fault/GFCI Circuit Breaker (HOM115CAFIC)", qty: 3, unitCost: 45.97, lineTotal: 137.91 },
  { name: "GFCI Circuit Breaker, 20 Amp (HOM120GFICP)", qty: 2, unitCost: 52.0, lineTotal: 104.0 },
  { name: "Multi-Function Circuit Breaker (HOM3060M200PCVP)", qty: 1, unitCost: 214.0, lineTotal: 214.0 },
  { name: "200 Amp Main Breaker Load Center", qty: 1, unitCost: 189.96, lineTotal: 189.96 },
];
export const STAND_IN_SUBTOTAL = 645.87;
export const STAND_IN_TAX = 55.71;
export const STAND_IN_TOTAL = 701.58;
export const STAND_IN_VENDOR = "The Home Depot";
export const STAND_IN_ORDER_NUMBER = "WH-STANDIN-0001";

export function renderStandInReceiptPdf(): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margin: 50, compress: false });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.fontSize(16).text(STAND_IN_VENDOR);
  doc.fontSize(9).text(`Online Order — Order #${STAND_IN_ORDER_NUMBER}`);
  doc.moveDown(0.8);

  const NAME_X = 50;
  const PRICE_X = 330;
  const QTY_X = 400;
  const TOTAL_X = 450;

  doc.fontSize(9).font("Helvetica-Bold");
  let y = doc.y;
  doc.text("Item", NAME_X, y, { width: 270 });
  doc.text("Price/Item", PRICE_X, y, { width: 65, align: "right" });
  doc.text("Qty", QTY_X, y, { width: 45, align: "right" });
  doc.text("Total", TOTAL_X, y, { width: 65, align: "right" });
  doc.moveDown(0.5);
  doc.font("Helvetica");

  for (const line of STAND_IN_LINES) {
    y = doc.y;
    doc.text(line.name, NAME_X, y, { width: 270 });
    doc.text(line.unitCost.toFixed(2), PRICE_X, y, { width: 65, align: "right" });
    doc.text(String(line.qty), QTY_X, y, { width: 45, align: "right" });
    doc.text(line.lineTotal.toFixed(2), TOTAL_X, y, { width: 65, align: "right" });
    doc.moveDown(0.6);
  }

  doc.moveDown(0.5);
  doc.text(`Subtotal: $${STAND_IN_SUBTOTAL.toFixed(2)}`, { align: "right" });
  doc.text(`Sales Tax: $${STAND_IN_TAX.toFixed(2)}`, { align: "right" });
  doc.font("Helvetica-Bold").text(`Total: $${STAND_IN_TOTAL.toFixed(2)}`, { align: "right" });

  doc.end();
  return done;
}

if (require.main === module) {
  renderStandInReceiptPdf()
    .then((buf) => {
      const out = path.join(__dirname, "home-depot-order-standin.pdf");
      createWriteStream(out).end(buf, () => console.log(`Wrote ${out} (${buf.length} bytes)`));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
