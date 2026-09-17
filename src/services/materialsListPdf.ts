/**
 * The materials list — Unit L, 2026-09-17.
 *
 * Kyle, on the "Materials used" card: "I should be able to pull up a materials list from this
 * card. A button that pulls up a pdf would be fine." Then, on what it should show: "the materials
 * list pdf should show the materials from the line items used to quote the job."
 *
 * Interpretation stated to and confirmed by Kyle: the TAKEN lines of every signed, non-void,
 * non-superseded estimate on the job (original and change orders), assemblies expanded to their
 * component materials, grouped per item — item, description, quantity, unit.
 *
 * DELIBERATELY NO COSTS, no on-hand, no short figures — `MaterialNeedLine`
 * (services/jobMaterials.ts) carries none of those, so there is nothing here to accidentally
 * print. This is a shopping/reference list, not a priced document, and not the P.O. shortage
 * view.
 *
 * Same house PDF tool as issuedEstimatePdf.ts (pdfkit, uncompressed for the same reason: a signed
 * assertion that no cost column is present should be checkable in the raw bytes, not just "the
 * code that writes it looks right").
 */

import PDFDocument from "pdfkit";
import { getCompanyProfile, type CompanyProfile } from "./companyProfile";
import type { MaterialNeedLine } from "./jobMaterials";

export interface MaterialsListPdfInput {
  customerName: string | null;
  serviceAddress: string | null;
  /** e.g. "Panel Upgrade — 108 Maple Dr, Nashville" — the same job-label shape used elsewhere. */
  jobLabel: string | null;
  /** Every signed estimate this list was built from (original + change orders). */
  estimateNumbers: string[];
  lines: MaterialNeedLine[];
}

/** Trim trailing zeros off a quantity rounded to 4 decimal places — "3.0000" reads as "3". */
function formatQty(qty: number): string {
  return (Math.round(qty * 10000) / 10000).toString();
}

export async function renderMaterialsListPdf(
  input: MaterialsListPdfInput,
  profileOverride?: CompanyProfile,
): Promise<Buffer> {
  const profile = profileOverride ?? (await getCompanyProfile());
  const doc = new PDFDocument({ size: "LETTER", margin: 50, compress: false });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // ── Header ──
  doc.fontSize(18).text(profile.legalName);
  doc.fontSize(9).fillColor("#555").text(`${profile.phone} · ${profile.email}`).fillColor("#000");
  doc.moveDown(0.8);

  doc.fontSize(14).text("Materials list");
  doc.moveDown(0.3).fontSize(10);
  if (input.customerName) doc.text(input.customerName);
  if (input.serviceAddress) doc.text(input.serviceAddress);
  if (input.jobLabel) doc.text(input.jobLabel);
  doc.text(
    input.estimateNumbers.length > 0
      ? `Estimate${input.estimateNumbers.length > 1 ? "s" : ""}: ${input.estimateNumbers.join(", ")}`
      : "No signed estimate on this job.",
  );
  doc.fillColor("#555")
    .text(`Generated ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })}`)
    .fillColor("#000");
  doc.moveDown(0.8);

  // ── Body ──
  if (input.estimateNumbers.length === 0) {
    doc.fontSize(11).text("This job has no signed estimate yet — there is nothing to list.");
  } else if (input.lines.length === 0) {
    doc.fontSize(11).text("The signed estimate(s) on this job carry no material lines.");
  } else {
    const ITEM_X = 50;
    const DESC_X = 140;
    const QTY_X = 390;
    const UNIT_X = 460;

    doc.fontSize(9).font("Helvetica-Bold");
    let y = doc.y;
    doc.text("Item", ITEM_X, y, { width: 85 });
    doc.text("Description", DESC_X, y, { width: 245 });
    doc.text("Qty", QTY_X, y, { width: 65, align: "right" });
    doc.text("Unit", UNIT_X, y, { width: 102, align: "right" });
    doc.font("Helvetica");
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor("#ccc").stroke();
    doc.moveDown(0.3);

    const sorted = [...input.lines].sort((a, b) => a.name.localeCompare(b.name));
    for (const line of sorted) {
      // A new page mid-table needs the row to actually land on it, not get cut off.
      if (doc.y > 700) {
        doc.addPage();
      }
      y = doc.y;
      doc.fontSize(9);
      // Never "null" — a missing description or unit prints the same em dash the rest of the app
      // uses for "we don't have this."
      doc.text(line.itemId?.trim() || "—", ITEM_X, y, { width: 85 });
      doc.text(line.name?.trim() || "—", DESC_X, y, { width: 245 });
      doc.text(formatQty(line.qty), QTY_X, y, { width: 65, align: "right" });
      doc.text(line.unit?.trim() || "—", UNIT_X, y, { width: 102, align: "right" });
      doc.moveDown(0.5);
    }
  }

  doc.end();
  return done;
}
