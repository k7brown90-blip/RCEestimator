/**
 * The estimate as a PDF — one generator, two audiences. (Step 4)
 *
 * Kyle, 2026-08-19:
 *
 *   *"once the estimate is emailed or signed we each should get a PDF copy"*
 *   *"The PDF for the company can save as a copy on the customers account under that job."*
 *   *"the labor units and line item pricing will have to show for the company copy… The customer
 *    only needs the final price of each option or combination of options."*
 *
 * ── NOTHING IS WRITTEN TO DISK, AND THAT IS DELIBERATE ─────────────────────────────────────────
 *
 * `pdfGenerator.ts` writes its documents into `generated/documents/` and `Document.pdfUrl` holds
 * a filesystem path. On Railway that directory does not survive a deploy, so every one of those
 * PDFs is already unreachable the moment the service restarts — `GET /documents/:id/pdf` answers
 * "PDF file not found" for anything generated before the last release. That is a pre-existing
 * defect, flagged rather than inherited.
 *
 * These are generated ON DEMAND from the frozen `IssuedEstimate` instead. It is safe precisely
 * because the estimate is immutable: the same record renders the same document every time, so
 * there is nothing a stored copy would preserve that regeneration does not. No blob storage, no
 * ephemeral directory, and no way for a saved file to drift from the record it claims to be.
 *
 * ── ONE GENERATOR ──────────────────────────────────────────────────────────────────────────────
 *
 * The audience decides which columns are emitted. It is one function rather than two so the
 * customer's copy and Kyle's copy cannot disagree about what the work is or what it costs —
 * which is the failure `companyProfile.ts` was created to fix and which happened again anyway
 * with the phone number.
 */

import PDFDocument from "pdfkit";
import type { PriceBookOption } from "@prisma/client";
import { getCompanyProfile, type CompanyProfile } from "./companyProfile";

export type PdfAudience = "customer" | "company";

export interface PdfLine {
  option: PriceBookOption;
  description: string;
  quantity: number;
  lineTotal: number;
  laborHours: number | null;
  materialSell: number | null;
}

export interface PdfEstimate {
  number: string;
  revision: number;
  title: string | null;
  customerName: string | null;
  serviceAddress: string | null;
  scopeText: string | null;
  total: number;
  tripCharge: number;
  signedAt: Date | null;
  signedByName: string | null;
  createdAt: Date;
  lines: PdfLine[];
}

const OPTIONS: PriceBookOption[] = ["A", "B", "C"];

function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

/** Sum a group without inventing a value for a missing one. */
function sum(values: Array<number | null>): number {
  return values.reduce<number>((n, v) => n + (v ?? 0), 0);
}

/**
 * Render the estimate. Returns the finished PDF bytes.
 *
 * Buffered rather than streamed to the response so a failure half-way through produces an error
 * the caller can answer, instead of a truncated file the reader has no way to recognise as
 * broken.
 */
export async function renderEstimatePdf(
  estimate: PdfEstimate,
  audience: PdfAudience,
  profileOverride?: CompanyProfile,
): Promise<Buffer> {
  const profile = profileOverride ?? (await getCompanyProfile());
  /*
    COMPRESSION OFF, ON PURPOSE.

    These two documents are defined as much by what they must NOT contain as by what they do: the
    customer's copy must carry no labour hours and no line prices. With Flate compression the
    drawn text is not readable in the file, so neither a test nor a person can verify that claim
    without a PDF parser — the assertion becomes "the code that writes it looks right", which is
    exactly the kind of proof that fails quietly.

    Uncompressed, the drawn text survives in the file as hex strings — `<524345>` for "RCE" — so
    the finished document can be read back and checked against what it was supposed to contain.
    (Not plain text: pdfkit hex-encodes it either way. Compression is what would put it out of
    reach entirely.) The cost is a larger file on a one-page estimate, which is nothing next to
    being able to verify it.
  */
  const doc = new PDFDocument({ size: "LETTER", margin: 50, compress: false });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // ── Header ──
  doc.fontSize(18).text(profile.legalName);
  doc.fontSize(9).fillColor("#555")
    .text(`${profile.phone} · ${profile.email}`)
    .text(profile.tagline);
  doc.moveDown(0.8).fillColor("#000");

  doc.fontSize(14).text(
    `Estimate ${estimate.number}${estimate.revision > 1 ? ` (revision ${estimate.revision})` : ""}`,
  );
  if (audience === "company") {
    doc.fontSize(9).fillColor("#a15c00").text("COMPANY COPY — not for the customer").fillColor("#000");
  }
  doc.moveDown(0.4);

  doc.fontSize(10);
  if (estimate.title) doc.text(estimate.title);
  if (estimate.customerName) doc.text(estimate.customerName);
  if (estimate.serviceAddress) doc.text(estimate.serviceAddress);
  doc.fillColor("#555").text(`Prepared ${estimate.createdAt.toLocaleDateString("en-US")}`).fillColor("#000");
  doc.moveDown(0.8);

  if (estimate.scopeText) {
    doc.fontSize(10).text(estimate.scopeText, { width: 500 });
    doc.moveDown(0.8);
  }

  // ── Options ──
  for (const option of OPTIONS) {
    const lines = estimate.lines.filter((l) => l.option === option);
    if (lines.length === 0) continue;

    const optionTotal = sum(lines.map((l) => l.lineTotal));
    doc.moveDown(0.4);
    doc.fontSize(12).text(`Option ${option}`, { continued: true })
      .text(money(optionTotal), { align: "right" });
    doc.moveTo(50, doc.y + 2).lineTo(562, doc.y + 2).strokeColor("#ccc").stroke();
    doc.moveDown(0.5);

    for (const line of lines) {
      doc.fontSize(10).fillColor("#000")
        .text(`${line.description}  × ${line.quantity}`, { width: 380, continued: false });

      // The whole audience split, in one branch. A customer line stops at description and
      // quantity — no line price, no hours (Kyle, 2026-08-19).
      if (audience === "company") {
        const bits = [
          line.laborHours === null ? "hours not recorded" : `${line.laborHours.toFixed(2)} hr`,
          line.materialSell === null
            ? "material not recorded"
            : line.materialSell === 0
              ? "customer-supplied"
              : `${money(line.materialSell)} material`,
          money(line.lineTotal),
        ];
        doc.fontSize(8).fillColor("#666").text(`    ${bits.join("  ·  ")}`).fillColor("#000");
      }
      doc.moveDown(0.2);
    }
  }

  // ── Totals ──
  doc.moveDown(0.8);
  doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor("#333").stroke();
  doc.moveDown(0.4);
  if (estimate.tripCharge > 0) {
    doc.fontSize(10).text("Trip charge", { continued: true })
      .text(money(estimate.tripCharge), { align: "right" });
  }
  doc.fontSize(13).text("ESTIMATE TOTAL", { continued: true })
    .text(money(estimate.total), { align: "right" });

  // ── The company's working sheet ──
  if (audience === "company") {
    doc.moveDown(1.2);
    doc.fontSize(12).text("Material to order");
    doc.fontSize(8).fillColor("#666")
      .text("Labour-only lines are omitted — a customer-supplied fixture has nothing to buy.")
      .fillColor("#000");
    doc.moveDown(0.3);

    const materials = new Map<string, { description: string; quantity: number }>();
    for (const line of estimate.lines) {
      if (!line.materialSell) continue;
      const row = materials.get(line.description);
      if (row) row.quantity += line.quantity;
      else materials.set(line.description, { description: line.description, quantity: line.quantity });
    }

    if (materials.size === 0) {
      doc.fontSize(10).text("Nothing to order — all labour.");
    } else {
      for (const row of [...materials.values()].sort((a, b) => a.description.localeCompare(b.description))) {
        doc.fontSize(10).text(`${row.description}  × ${row.quantity}`);
      }
    }

    const hours = sum(estimate.lines.map((l) => l.laborHours));
    const anyMissing = estimate.lines.some((l) => l.laborHours === null);
    doc.moveDown(0.6);
    doc.fontSize(10).text(
      `Labour to schedule: ${hours.toFixed(2)} hr${anyMissing ? " (some lines have no recorded hours)" : ""}`,
    );
  }

  // ── Signature ──
  if (estimate.signedAt) {
    doc.moveDown(1);
    doc.fontSize(10).fillColor("#0a5c2e")
      .text(`Accepted by ${estimate.signedByName ?? "the customer"} on ${estimate.signedAt.toLocaleString("en-US")}`)
      .fillColor("#000");
  }

  doc.end();
  return done;
}
