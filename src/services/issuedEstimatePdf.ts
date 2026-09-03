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
import { signatureBuffer } from "./signatureImage";
import { discountFor, discountLabel, programmeFor } from "./discounts";

export type PdfAudience = "customer" | "company";

export interface PdfLine {
  option: PriceBookOption;
  description: string;
  quantity: number;
  lineTotal: number;
  laborHours: number | null;
  /** Column F — what the customer is charged for material. */
  materialSell: number | null;
  /** Column E — what it costs Red Cedar. Tracked for spending, never shown to a customer. */
  materialCost: number | null;
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
  /** The drawn mark, as a validated PNG data URL. Null for estimates signed before 2026-08-20. */
  signatureImage?: string | null;
  createdAt: Date;
  lines: PdfLine[];
  /**
   * The options as they were named and priced at issue (Kyle, 2026-08-20: "Show the option names
   * on the pdf, that's necessary.").
   *
   * Optional, and the loop falls back to the bare letter when it is missing — an estimate issued
   * before options were nameable has no rows here and must still print.
   *
   * `subtotal` is the frozen figure rather than a re-sum of the lines. They agree, but the frozen
   * one is what the customer was shown and what they put their name to.
   */
  options?: Array<{
    option: PriceBookOption;
    label: string | null;
    note: string | null;
    subtotal: number;
  }>;
  /** What the customer actually bought. Empty or absent means the whole estimate. */
  selectedOptions?: PriceBookOption[];
  /**
   * The job-level material check's working, frozen at issue (2026-08-21). Company copy only —
   * the customer sees the resulting price, never the machinery that produced it.
   */
  materialCaps?: Record<
    string,
    { uncappedSell: number; cappedSell: number; ceiling: number; bandLabel: string; reduction: number; applied: boolean }
  > | null;
  /**
   * THE THIRD GATE's result for the options actually taken, frozen at signature (2026-08-22).
   * Kyle: "the final check against the total combined options... treat them as a single job."
   * Printed on BOTH copies — the customer's because it explains their price, the company's with
   * the working. Null before the gate existed or before anything is signed.
   */
  comboCap?: { reduction: number; ceiling: number; bandLabel: string; applied: boolean } | null;
  /** The programme in force ("military"|"senior"|"custom"), its custom percent, and — once signed — the frozen amount. */
  discountType?: string | null;
  discountPercent?: number | null;
  discount?: { amount: number; base: number } | null;
}

const OPTIONS: PriceBookOption[] = ["A", "B", "C"];

/** Money arithmetic to the cent — the billed total is re-summed from the options taken. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function money(v: number | null | undefined): string {
  // Null-safe: a line issued before a column existed has no value for it, and a document that
  // throws mid-render is worse than one that prints an em dash.
  if (v === null || v === undefined) return "—";
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

  /*
    ── A SIGNED DOCUMENT IS AN INVOICE ──────────────────────────────────────────────────────────

    Kyle, 2026-08-21: *"The signed estimates need to be labeled invoices."*

    Same document, same frozen numbers, same signature — what changes is what it IS. Before it is
    signed it is an offer; after, it is what the customer owes. Calling both an "Estimate" leaves
    him sending a customer a document that reads as a quote when he means it as a bill.

    The number does not change with the name. Invoice 2026-1022 and estimate 2026-1022 are the
    same agreement, which is what makes the chain auditable.
  */
  const isInvoice = Boolean(estimate.signedAt);
  doc.fontSize(14).text(
    `${isInvoice ? "Invoice" : "Estimate"} ${estimate.number}${
      estimate.revision > 1 ? ` (revision ${estimate.revision})` : ""
    }`,
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

  /*
    ── Options, BY NAME ──────────────────────────────────────────────────────────────────────────

    Kyle, 2026-08-20: *"Show the option names on the pdf, that's necessary."*

    This printed "Option A", "Option B", "Option C" — which tells whoever is holding the paper
    nothing about what is in them. The name is the scope: "Exterior pathway lights" is what makes
    this document usable for ordering and for talking to the customer about what they bought.

    Once the customer has signed, the options they DECLINED are not printed at all. Their
    agreement is what they bought; an option they said no to has no place on it.
  */
  const taken = new Set((estimate.selectedOptions ?? []) as string[]);
  const declinedAreKnown = Boolean(estimate.signedAt) && taken.size > 0;

  for (const option of OPTIONS) {
    const lines = estimate.lines.filter((l) => l.option === option);
    if (lines.length === 0) continue;
    if (declinedAreKnown && !taken.has(option)) continue;

    const meta = estimate.options?.find((o) => o.option === option);
    // The frozen subtotal when there is one; otherwise re-summed, which is the only thing an
    // estimate issued before options existed can offer.
    const optionTotal = meta ? meta.subtotal : sum(lines.map((l) => l.lineTotal));
    const heading = meta?.label ? `Option ${option} — ${meta.label}` : `Option ${option}`;

    doc.moveDown(0.4);
    doc.fontSize(12).text(heading, { continued: true })
      .text(money(optionTotal), { align: "right" });
    doc.moveTo(50, doc.y + 2).lineTo(562, doc.y + 2).strokeColor("#ccc").stroke();
    doc.moveDown(0.5);

    if (meta?.note) {
      doc.fontSize(9).fillColor("#555").text(meta.note, { width: 500 });
      doc.fillColor("#000");
      doc.moveDown(0.3);
    }

    for (const line of lines) {
      doc.fontSize(10).fillColor("#000")
        .text(`${line.description}  × ${line.quantity}`, { width: 380, continued: false });

      // The whole audience split, in one branch. A customer line stops at description and
      // quantity — no line price, no hours (Kyle, 2026-08-19).
      if (audience === "company") {
        /*
          THE BREAKDOWN, IN KYLE'S OWN TERMS (2026-08-20):

            "Column E = company cost. Column F = what we charge. The labor rate * difficulty
             labor unit is labor cost... Column F + ($150*labor difficulty unit) = total price"

          So the line reads: what it COSTS us, what we CHARGE for it, the labour, and the total.
          Cost and charge are different numbers doing different jobs — the charge is the price,
          the cost is what he tracks spending against — and collapsing them into one "material"
          figure is what made this unreadable.
        */
        /*
          Labour money is DERIVED from the frozen line: total minus what the material was charged
          at. Kyle's rule is "$150 * labor difficulty unit", and multiplying the hours by a rate
          read at print time would silently restate a signed document the day the rate changes.
          The subtraction can only ever reproduce what was actually agreed.
        */
        const labourCost = line.lineTotal - (line.materialSell ?? 0);
        const bits = [
          line.materialCost === null || line.materialCost === 0
            ? null
            : `cost ${money(line.materialCost)}`,
          line.materialSell === null
            ? "material not recorded"
            : line.materialSell === 0
              ? "customer-supplied"
              : `charge ${money(line.materialSell)}`,
          line.laborHours === null
            ? `labour ${money(labourCost)} (hours not recorded)`
            : `labour ${line.laborHours.toFixed(2)} hr = ${money(labourCost)}`,
          `TOTAL ${money(line.lineTotal)}`,
        ].filter(Boolean);
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
  /*
    ── THE TOTAL IS WHAT THEY BOUGHT ────────────────────────────────────────────────────────────

    Kyle, 2026-08-21: *"if someone checks specific options rather than all that the final invoice
    produced represents their actual selection and doesn't treat it as if they signed off on all
    of the options."*

    This printed `estimate.total` — the whole quoted amount, every option included. The line list
    above already drops what the customer declined, so a customer who took Option A out of three
    would have received a document showing one option and charging for all three. Wrong in the
    worse direction: it bills for work the page does not even show.

    Re-summed from the options actually taken, plus the trip charge once. Falls back to the frozen
    total when nothing was declined, or when the estimate predates options entirely — those two
    figures are the same number and the frozen one is the one the customer saw.
  */
  /*
    The third gate's frozen reduction comes off the billed figure (2026-08-22). It was computed
    from the same frozen lines this document prints, at the moment of signing, and stored — so
    the invoice, the signed page, and the emailed copy cannot disagree about it.
  */
  const comboReduction = estimate.comboCap?.applied ? estimate.comboCap.reduction : 0;
  /*
    The programme discount (2026-08-22). Signed: the FROZEN amount only. Unsigned: computed live
    from the same base the customer page uses — full offering, capped at $250 — so the paper and
    the screen quote the same figure.
  */
  const preDiscount =
    declinedAreKnown && estimate.options
      ? round2(
          estimate.options
            .filter((o) => taken.has(o.option))
            .reduce((n, o) => n + o.subtotal, 0) + estimate.tripCharge - comboReduction,
        )
      : round2(estimate.total - comboReduction);
  const progAmount = estimate.signedAt
    ? estimate.discount?.amount ?? 0
    : discountFor(programmeFor(estimate.discountType, estimate.discountPercent), preDiscount)?.amount ?? 0;
  const billed = round2(preDiscount - progAmount);

  if (comboReduction > 0) {
    doc.fontSize(10).fillColor("#1a5c2e")
      .text("Multi-option material discount", { continued: true })
      .text(`-${money(comboReduction)}`, { align: "right" });
    doc.fillColor("#000");
  }
  if (progAmount > 0) {
    const label = programmeFor(estimate.discountType, estimate.discountPercent);
    doc.fontSize(10).fillColor("#1a5c2e")
      .text(label ? discountLabel(label) : "Discount", { continued: true })
      .text(`-${money(progAmount)}`, { align: "right" });
    doc.fillColor("#000");
  }
  doc.fontSize(13).text(isInvoice ? "INVOICE TOTAL" : "ESTIMATE TOTAL", { continued: true })
    .text(money(billed), { align: "right" });

  // ── The company's working sheet ──
  if (audience === "company") {
    /*
      The material check's working, printed where the numbers it changed are read (2026-08-21).
      Kyle: "We have to plan the best way for the material mark ups work against total material
      cost so it stays within a reasonable range." When the ceiling bit, the company copy says by
      how much — the customer's copy just carries the resulting price.
    */
    if (estimate.comboCap?.applied) {
      doc.moveDown(0.6);
      doc.fontSize(9).fillColor("#1a5c2e")
        .text(
          `Combined selection priced as one job: ${estimate.comboCap.ceiling}x ceiling ` +
            `(${estimate.comboCap.bandLabel}) — ${money(estimate.comboCap.reduction)} off in combination. ` +
            `Labour untouched; one supply run.`,
        )
        .fillColor("#000");
    }
    const capsApplied = Object.entries(estimate.materialCaps ?? {}).filter(([, c]) => c.applied);
    if (capsApplied.length > 0) {
      doc.moveDown(0.8);
      doc.fontSize(9).fillColor("#a15c00");
      for (const [opt, c] of capsApplied) {
        doc.text(
          `Option ${opt}: material capped at ${c.ceiling}x (${c.bandLabel}) — ` +
            `${money(c.uncappedSell)} -> ${money(c.cappedSell)}, ${money(c.reduction)} off the per-item tiers.`,
        );
      }
      doc.fillColor("#000");
    }
    doc.moveDown(1.2);
    doc.fontSize(12).text("Material to order");
    doc.fontSize(8).fillColor("#666")
      .text("Labour-only lines are omitted — a customer-supplied fixture has nothing to buy.")
      .fillColor("#000");
    doc.moveDown(0.3);

    const materials = new Map<string, { description: string; quantity: number }>();
    for (const line of estimate.lines) {
      // Declined options have nothing to order. Listing them would send Kyle to the supply house
      // for parts the customer did not buy.
      if (declinedAreKnown && !taken.has(line.option)) continue;
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

    /*
      ── WHAT THE JOB COSTS AND HOW LONG IT TAKES ────────────────────────────────────────────

      Kyle, 2026-08-20: "This is how it needs to be calculated and shown on the company copy with
      the total labor hours calculated into total job length."

      So the hours are not left as a number to convert in his head — they are turned into days at
      an eight-hour day, which is the unit scheduling actually happens in.

      Material COST (column E) is totalled separately from what is charged, because that is the
      figure he tracks spending against. It is stated as a cost, never as a discount off the
      charge, and it never appears on the customer's copy.
    */
    /*
      ── THE SUMMARY DESCRIBES THE JOB HE IS ACTUALLY DOING ───────────────────────────────────

      These summed `estimate.lines` — every option, including ones the customer declined. On
      2026-1021 that reported 9.73 hr and $1459.50 of labour for a job the customer had cut down
      to Option A. This is the block Kyle schedules against and tracks spending against, so a
      figure covering work nobody bought is worse here than on the total: it books days he does
      not need and budgets money he will not spend.

      Same scope as the material list above and the billed total below — one selection, applied
      everywhere it changes an answer.
    */
    const jobLines = estimate.lines.filter((l) => !declinedAreKnown || taken.has(l.option));

    const hours = sum(jobLines.map((l) => l.laborHours));
    const anyMissingHours = jobLines.some((l) => l.laborHours === null);
    const materialSpend = sum(jobLines.map((l) => l.materialCost));
    const materialCharged = sum(jobLines.map((l) => l.materialSell));
    // Same derivation as the lines: what was charged, minus the material. Never a rate applied
    // after the fact to a document that has already been signed.
    const labourCost = sum(jobLines.map((l) => l.lineTotal - (l.materialSell ?? 0)));
    const effectiveRate = hours > 0 ? labourCost / hours : null;
    const days = hours / 8;

    doc.moveDown(0.8);
    doc.fontSize(12).text("Job summary");
    doc.moveDown(0.2);
    doc.fontSize(10);
    doc.text(`Material cost (what we spend):   ${money(materialSpend)}`);
    doc.text(`Material charged:                ${money(materialCharged)}`);
    doc.text(
      `Labour: ${hours.toFixed(2)} hr` +
        (effectiveRate === null ? "" : ` x ${money(effectiveRate)}/hr`) +
        ` = ${money(labourCost)}` +
        (anyMissingHours ? "  (some lines have no recorded hours)" : ""),
    );
    doc.text(
      `Job length: ${hours.toFixed(2)} hr = ${days.toFixed(2)} day(s) at 8 hr/day`,
    );
    /*
      Profit (Kyle, 2026-09-03: "I would like to see a profit calculation added
      here so I can gauge the success of each job") — what the job actually
      bills (taken options + trip - combo - discount, the same `billed` the
      invoice shows) minus what the material costs us. Labour is the owner's
      own earning on a one-man shop, so it lives inside the profit figure
      rather than being costed against it.
    */
    const jobProfit = round2(billed - materialSpend);
    doc.moveDown(0.2);
    doc.text(
      `Profit: ${money(billed)} billed - ${money(materialSpend)} material = ${money(jobProfit)}` +
        (billed > 0 ? `  (${((jobProfit / billed) * 100).toFixed(0)}% of billed)` : ""),
    );
  }

  // ── Signature ──
  if (estimate.signedAt) {
    doc.moveDown(1);
    doc.fontSize(10).fillColor("#0a5c2e")
      .text(`Accepted by ${estimate.signedByName ?? "the customer"} on ${estimate.signedAt.toLocaleString("en-US")}`)
      .fillColor("#000");

    /*
      The drawn mark. Embedded from the stored data URL, which `signatureImage.ts` verified was a
      PNG — by its magic bytes, not by what it claimed — before it was ever written.

      Guarded anyway. A record signed before 2026-08-20 has no drawing, and a malformed one must
      produce a document without a signature rather than no document at all: the PDF IS the record
      of acceptance, and failing to render it because the picture is bad would lose the fact along
      with the mark.
    */
    if (estimate.signatureImage) {
      try {
        doc.moveDown(0.4);
        doc.image(signatureBuffer(estimate.signatureImage), { fit: [220, 80] });
        doc.moveTo(50, doc.y + 2).lineTo(270, doc.y + 2).strokeColor("#999").stroke();
      } catch {
        doc.fontSize(8).fillColor("#a15c00")
          .text("(the signature image could not be rendered)").fillColor("#000");
      }
    }
  }

  doc.end();
  return done;
}
