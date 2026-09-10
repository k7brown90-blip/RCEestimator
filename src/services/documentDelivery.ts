/**
 * Ad-hoc document delivery — used by the voice-agent "send_document" tool to
 * re-send an already-generated PDF (contract, work order, health report, etc.)
 * to a customer by email or SMS.
 *
 * Kyle, 2026-09-09: "I need the emails working, very few are actually getting
 * through, this is priority number one." This is a customer send, so it goes
 * through services/transactionalEmail.ts like every other one — Resend first,
 * Gmail as the automatic fallback, one EmailDelivery row (kind "document").
 * The email's content is unchanged.
 */

import fs from "node:fs";
import path from "node:path";
import { getCompanyProfile } from "./companyProfile";
import { sendCustomerEmail } from "./transactionalEmail";
import { htmlToPlainText } from "./confirmationEmail";

const BRANDED_FOOTER = `
  <p style="font-size:14px;color:#888;margin:16px 0 0;border-top:1px solid #eee;padding-top:12px;">
    Red Cedar Electric LLC &middot; Licensed &amp; Insured<br>
    Serving Middle Tennessee
  </p>`;

export function humanizeDocType(type: string): string {
  switch (type) {
    case "work_order": return "Work Order";
    case "material_list": return "Material List";
    case "contract": return "Contract";
    case "change_order": return "Change Order";
    case "signed": return "Signed Agreement";
    case "health_report": return "Electrical Health Record";
    case "cure_certificate": return "Certificate of Correction";
    case "upgrade_record": return "Record of Upgrade";
    case "finding_declination": return "Acknowledgment of Declined Work";
    default:
      return type
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
  }
}

interface SendDocumentEmailInput {
  to: string;
  customerName: string;
  docType: string;      // raw type, human-labeled internally
  pdfPath: string;      // absolute local path to the PDF
  note?: string;        // optional receptionist-added message
  /** Attribution for the delivery row, when the caller knows them. */
  issuedEstimateId?: string | null;
  visitId?: string | null;
}

export async function sendDocumentEmail(input: SendDocumentEmailInput): Promise<boolean> {
  if (!fs.existsSync(input.pdfPath)) {
    console.error(`[DocumentDelivery] PDF not found on disk: ${input.pdfPath}`);
    return false;
  }

  const label = humanizeDocType(input.docType);
  const filename = path.basename(input.pdfPath);
  // The same number the attached PDF prints in its footer. These had drifted —
  // the document said one thing and the email delivering it said another, which
  // on a code-cited certificate undercuts the one claim it's making.
  const { phone } = await getCompanyProfile();
  const noteBlock = input.note
    ? `<p style="font-size:15px;margin:0 0 16px;">${escapeHtml(input.note)}</p>`
    : "";

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;color:#333;">
      <div style="background:#1a5c2e;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
        <h1 style="margin:0;font-size:20px;">${label}</h1>
        <p style="margin:4px 0 0;font-size:14px;opacity:0.9;">Red Cedar Electric LLC</p>
      </div>
      <div style="padding:20px 24px;background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;">
        <p style="font-size:16px;margin:0 0 16px;">Hi ${escapeHtml(input.customerName)},</p>
        <p style="font-size:15px;margin:0 0 16px;">Your ${label.toLowerCase()} from Red Cedar Electric is attached to this email.</p>
        ${noteBlock}
        <p style="font-size:14px;color:#555;">If you have any questions, reply to this email or call ${phone}.</p>
        ${BRANDED_FOOTER}
      </div>
    </div>`;

  // Read the bytes here: both pipes take a Buffer (Resend wants base64, not a path).
  const pdf = await fs.promises.readFile(input.pdfPath);
  const result = await sendCustomerEmail({
    to: input.to,
    subject: `${label} — Red Cedar Electric`,
    html,
    text: htmlToPlainText(html),
    attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
    kind: "document",
    issuedEstimateId: input.issuedEstimateId ?? null,
    visitId: input.visitId ?? null,
  });
  if (result.ok) {
    console.log(`[DocumentDelivery] Sent ${input.docType} to ${input.to} via ${result.provider}`);
  } else {
    console.error(`[DocumentDelivery] Send failed: ${result.error}`);
  }
  return result.ok;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
