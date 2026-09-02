/**
 * Email the Electrical Health Record to the customer — with delivery proof.
 *
 * Kyle, 2026-08-24: "This health record needs submitted and saved to their
 * account so there needs to be a dedicated space to view and even email the
 * document from the app."
 *
 * Two callers, one rule set: the CRM (owner session) and the field PWA (the
 * assigned technician). Both run through here so the critical-finding gate and
 * the delivery log cannot be bypassed by choosing the other door.
 *
 * THE GATE: a report carrying a critical finding is not customer-facing until
 * the licensed contractor has reviewed it. That rule already governed the CRM's
 * review flow; the email send is where it now has teeth.
 *
 * THE LOG: every successful send writes a HealthReportDelivery row — when, to
 * what address, by whom. The record only protects anyone if delivery can be
 * proven after the fact; see the liability ruling of 2026-08-07.
 *
 * The PDF is rendered fresh at send time. generated/ is wiped on every deploy,
 * so attaching a previously saved file would race the release cycle — rendering
 * from the database is the only path that always works.
 */

import fs from "node:fs/promises";
import { prisma } from "../lib/prisma";
import { sendBrandedEmail } from "./confirmationEmail";
import { generateHealthReport, generateGeneratorReport } from "./pdfGenerator";
import { logSystemEvent } from "./systemEvents";

export type HealthReportEmailResult =
  | { sent: true; sentTo: string; documentId: string; deliveryId: string }
  | { sent: false; reason: string };

export async function sendHealthReportEmail(
  inspectionId: string,
  opts: {
    to?: string | null;
    sentBy: string;
    /**
     * Attach the generator sizing report too (Kyle, 2026-09-01, field app step 3:
     * "email the load calc, electrical assesment, and generator sizing report").
     * That report IS the load-calc sheet — the Article 220 math line by line plus
     * the sizing — so one attachment covers both asks. Refused (not silently
     * skipped) when the inspection has no load calculation.
     */
    includeGenerator?: boolean;
    /**
     * This send REPLACES a report the customer already holds (a revision —
     * Kyle, 2026-09-01: "the customer isn't left holding an inaccurate
     * calculation"). Changes the subject and says so in the body.
     */
    corrected?: { replacesDate: string };
  },
): Promise<HealthReportEmailResult> {
  const inspection = await prisma.healthInspection.findUnique({
    where: { id: inspectionId },
    include: {
      customer: { select: { name: true, email: true } },
      property: { select: { addressLine1: true, city: true, state: true } },
    },
  });
  if (!inspection) return { sent: false, reason: "Inspection not found." };
  if (opts.includeGenerator && !inspection.loadCalcJson) {
    return {
      sent: false,
      reason: "This assessment has no load calculation — run the A2 load calc first, or send the report alone.",
    };
  }

  const criticals = (() => {
    try {
      return JSON.parse(inspection.criticalFindingsJson) as string[];
    } catch {
      return [];
    }
  })();
  if (criticals.length > 0 && !inspection.contractorReviewed) {
    return {
      sent: false,
      reason:
        "This report carries a critical finding and has not been contractor-reviewed. " +
        "Review it in the CRM first — an unreviewed critical report never goes to a customer.",
    };
  }

  const sentTo = (opts.to ?? inspection.customer.email)?.trim();
  if (!sentTo) {
    return { sent: false, reason: "No email address — the account has none on file and none was provided." };
  }

  // Fresh render, fresh Document row — the attachment is read back immediately,
  // before any deploy could sweep generated/ out from under it.
  const { documentId, pdfPath } = await generateHealthReport(inspectionId);
  const pdfBytes = await fs.readFile(pdfPath);
  let generatorDoc: { documentId: string; bytes: Buffer } | null = null;
  if (opts.includeGenerator) {
    const gen = await generateGeneratorReport(inspectionId);
    generatorDoc = { documentId: gen.documentId, bytes: await fs.readFile(gen.pdfPath) };
  }

  const address = `${inspection.property.addressLine1}, ${inspection.property.city}, ${inspection.property.state}`;
  const dateStr = inspection.inspectionDate.toLocaleDateString("en-US", { timeZone: "America/Chicago" });

  const ok = await sendBrandedEmail({
    to: sentTo,
    subject: opts.corrected
      ? `Corrected — Your Electrical Health Record — ${address}`
      : `Your Electrical Health Record — ${address}`,
    headline: opts.corrected ? "Your corrected Electrical Health Record" : "Your Electrical Health Record",
    bodyHtml: `
      <p>Hi ${inspection.customer.name},</p>
      ${opts.corrected ? `<p style="background:#F8EEDD;border-radius:6px;padding:10px 12px;"><strong>This replaces the report we sent you dated ${opts.corrected.replacesDate}.</strong> We corrected the record — please use this version and disregard the earlier one.</p>` : ""}
      <p>Attached ${generatorDoc ? "are the documents" : "is the Electrical Health Record"} from our assessment of
      <strong>${address}</strong> on ${dateStr}. ${generatorDoc
        ? "The Electrical Health Record documents what we measured, what passed, and anything worth correcting — with the code basis for each finding. The Load Calculation &amp; Generator Sizing sheet shows the Article 220 math line by line and what it means for standby power at your home."
        : "It documents what we measured, what passed, and anything worth correcting or keeping an eye on — including the code basis for each finding, so you can tell a violation from a recommendation."}</p>
      <p>Keep it with your home records; it's yours. If you'd like to talk
      through any finding, just reply to this email or call us.</p>
      <p style="color:#666;font-size:12px;">"We don't guess. We measure."</p>`,
    attachments: [
      {
        filename: `Electrical-Health-Record-${dateStr.replaceAll("/", "-")}.pdf`,
        content: pdfBytes,
        contentType: "application/pdf",
      },
      ...(generatorDoc
        ? [{
            filename: `Load-Calc-and-Generator-Sizing-${dateStr.replaceAll("/", "-")}.pdf`,
            content: generatorDoc.bytes,
            contentType: "application/pdf",
          }]
        : []),
    ],
  });

  if (!ok) {
    return { sent: false, reason: "Email transport failed — see the system event log for the cause." };
  }

  const delivery = await prisma.healthReportDelivery.create({
    data: { inspectionId, documentId, sentTo, sentBy: opts.sentBy },
  });
  await prisma.document.update({ where: { id: documentId }, data: { sentAt: delivery.sentAt } });

  if (generatorDoc) {
    await prisma.document.update({ where: { id: generatorDoc.documentId }, data: { sentAt: delivery.sentAt } }).catch(() => {});
  }
  logSystemEvent("info", "health-record", `Health report emailed to ${sentTo}${generatorDoc ? " with the load-calc & generator sizing sheet" : ""}`, {
    inspectionId,
    documentId,
    generatorDocumentId: generatorDoc?.documentId ?? null,
    sentBy: opts.sentBy,
    property: address,
  });

  return { sent: true, sentTo, documentId, deliveryId: delivery.id };
}
