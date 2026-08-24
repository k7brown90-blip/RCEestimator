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
import { generateHealthReport } from "./pdfGenerator";
import { logSystemEvent } from "./systemEvents";

export type HealthReportEmailResult =
  | { sent: true; sentTo: string; documentId: string; deliveryId: string }
  | { sent: false; reason: string };

export async function sendHealthReportEmail(
  inspectionId: string,
  opts: { to?: string | null; sentBy: string },
): Promise<HealthReportEmailResult> {
  const inspection = await prisma.healthInspection.findUnique({
    where: { id: inspectionId },
    include: {
      customer: { select: { name: true, email: true } },
      property: { select: { addressLine1: true, city: true, state: true } },
    },
  });
  if (!inspection) return { sent: false, reason: "Inspection not found." };

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

  const address = `${inspection.property.addressLine1}, ${inspection.property.city}, ${inspection.property.state}`;
  const dateStr = inspection.inspectionDate.toLocaleDateString("en-US", { timeZone: "America/Chicago" });

  const ok = await sendBrandedEmail({
    to: sentTo,
    subject: `Your Electrical Health Record — ${address}`,
    headline: "Your Electrical Health Record",
    bodyHtml: `
      <p>Hi ${inspection.customer.name},</p>
      <p>Attached is the Electrical Health Record from our assessment of
      <strong>${address}</strong> on ${dateStr}. It documents what we measured,
      what passed, and anything worth correcting or keeping an eye on —
      including the code basis for each finding, so you can tell a violation
      from a recommendation.</p>
      <p>Keep it with your home records; it's yours. If you'd like to talk
      through any finding, just reply to this email or call us.</p>
      <p style="color:#666;font-size:12px;">"We don't guess. We measure."</p>`,
    attachments: [
      {
        filename: `Electrical-Health-Record-${dateStr.replaceAll("/", "-")}.pdf`,
        content: pdfBytes,
        contentType: "application/pdf",
      },
    ],
  });

  if (!ok) {
    return { sent: false, reason: "Email transport failed — see the system event log for the cause." };
  }

  const delivery = await prisma.healthReportDelivery.create({
    data: { inspectionId, documentId, sentTo, sentBy: opts.sentBy },
  });
  await prisma.document.update({ where: { id: documentId }, data: { sentAt: delivery.sentAt } });

  logSystemEvent("info", "health-record", `Health report emailed to ${sentTo}`, {
    inspectionId,
    documentId,
    sentBy: opts.sentBy,
    property: address,
  });

  return { sent: true, sentTo, documentId, deliveryId: delivery.id };
}
