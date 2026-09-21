/**
 * Email the Circuit Diagnostic Report to the homeowner — with delivery proof.
 *
 * Kyle, 2026-09-20: "The homeowner gets the diagnostics report that documents
 * all wiring fixes made during the diagnostics, a review of what was wrong/what
 * was fixed, and the resolutions for any issues that were because of faulty or
 * damaged equipment/devices."
 *
 * Same posture as `healthReportEmail.ts`, for the same reasons, and deliberately
 * the same shape so there is one way this works rather than two:
 *  · ONE DOOR. The CRM and the field PWA both come through here, so no gate can
 *    be bypassed by choosing the other one.
 *  · THE GATE. An in-progress diagnostic is not customer-facing — the walk is
 *    not finished, so the coverage statement on the face of it would be a claim
 *    about a circuit nobody has finished testing. A voided one never goes out.
 *  · THE LOG. Every successful send writes a DiagnosticReportDelivery row. On a
 *    warranty callback this document is the defence, and a defence nobody can
 *    prove was delivered is Kyle's word against the customer's.
 *  · FRESH RENDER. generated/ is wiped on every deploy, so the PDF is rendered
 *    from the database at send time rather than attached from disk.
 */

import fs from "node:fs/promises";
import { prisma } from "../lib/prisma";
import { sendBrandedEmail } from "./confirmationEmail";
import { generateDiagnosticReport } from "./pdfGenerator";
import { logSystemEvent } from "./systemEvents";
import { REPORT_INCLUDE, serializeDiagnosticReport } from "./diagnosticReport";

export type DiagnosticReportEmailResult =
  | { sent: true; sentTo: string; documentId: string; deliveryId: string }
  | { sent: false; reason: string };

export async function sendDiagnosticReportEmail(
  reportId: string,
  opts: { to?: string | null; sentBy: string },
): Promise<DiagnosticReportEmailResult> {
  const report = await prisma.diagnosticReport.findUnique({
    where: { id: reportId },
    include: {
      ...REPORT_INCLUDE,
      customer: { select: { name: true, email: true } },
      property: { select: { addressLine1: true, city: true, state: true } },
    },
  });
  if (!report) return { sent: false, reason: "Diagnostic report not found." };
  if (report.status === "void") {
    return { sent: false, reason: "That diagnostic is void. A voided report is never sent to a customer." };
  }
  if (report.status !== "complete") {
    return {
      sent: false,
      reason:
        "This diagnostic is still in progress. Finish the circuit — breaker to last outlet — and mark it complete; " +
        "the report states whole-circuit coverage on its face and must not say that before the walk is done.",
    };
  }
  if (report.outlets.length === 0) {
    return { sent: false, reason: "No outlets were recorded, so there is no diagnostic to send." };
  }

  const sentTo = (opts.to ?? report.customer.email)?.trim();
  if (!sentTo) {
    return { sent: false, reason: "No email address — the account has none on file and none was provided." };
  }

  const view = serializeDiagnosticReport(report);
  const { documentId, pdfPath } = await generateDiagnosticReport(reportId);
  const pdfBytes = await fs.readFile(pdfPath);

  const address = `${report.property.addressLine1}, ${report.property.city}, ${report.property.state}`;
  const dateStr = report.reportDate.toLocaleDateString("en-US", { timeZone: "America/Chicago" });

  const resolutionsLine =
    view.defectCount > 0
      ? `<p>We also found <strong>${view.defectCount} piece${view.defectCount === 1 ? "" : "s"} of damaged or defective equipment</strong> on this circuit. That is equipment failing on its own account rather than a wiring fault, so it is not part of the diagnostic price — the report lists each one with a photo, and we will send a separate quote for the fix so you can decide.</p>`
      : `<p>We found no damaged or defective equipment on this circuit.</p>`;

  const ok = await sendBrandedEmail({
    kind: "health_record",
    to: sentTo,
    subject: `Your Circuit Diagnostic Report — ${report.circuitLabel} — ${address}`,
    headline: "Your Circuit Diagnostic Report",
    bodyHtml: `
      <p>Hi ${report.customer.name},</p>
      <p>Attached is the diagnostic report for <strong>${report.circuitLabel}</strong> at
      <strong>${address}</strong>, from ${dateStr}.</p>
      <p style="background:#F8EEDD;border-radius:6px;padding:10px 12px;">${view.coverageStatement}</p>
      <p>${view.fixedCount > 0
        ? `We made <strong>${view.fixedCount} wiring repair${view.fixedCount === 1 ? "" : "s"}</strong> while we were in there. Those are part of the diagnostic you paid for — there is nothing further owed on them.`
        : `No wiring repairs were needed on this circuit.`}</p>
      ${resolutionsLine}
      <p>Every box we opened is in the report with its readings and a photo. Keep it with your
      home records; it's yours. If you'd like to talk any of it through, just reply or call us.</p>
      <p style="color:#666;font-size:12px;">"We don't guess. We measure."</p>`,
    attachments: [
      {
        filename: `Circuit-Diagnostic-${dateStr.replaceAll("/", "-")}.pdf`,
        content: pdfBytes,
        contentType: "application/pdf",
      },
    ],
  });
  if (!ok) {
    return { sent: false, reason: "Email transport failed — see the system event log for the cause." };
  }

  const delivery = await prisma.diagnosticReportDelivery.create({
    data: { reportId, documentId, sentTo, sentBy: opts.sentBy },
  });
  await prisma.document.update({ where: { id: documentId }, data: { sentAt: delivery.sentAt } }).catch(() => {});

  logSystemEvent("info", "diagnostic-report", `Circuit diagnostic report emailed to ${sentTo}`, {
    reportId,
    documentId,
    sentBy: opts.sentBy,
    circuit: report.circuitLabel,
    examined: view.money.examinedTotal,
    overage: view.money.overageTotal,
    property: address,
  });

  return { sent: true, sentTo, documentId, deliveryId: delivery.id };
}
