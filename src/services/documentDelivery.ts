/**
 * Ad-hoc document delivery — used by the voice-agent "send_document" tool to
 * re-send an already-generated PDF (contract, work order, health report, etc.)
 * to a customer by email or SMS. Nodemailer transport mirrors the pattern used
 * by confirmationEmail.ts / supplierEmail.ts / dailySummary.ts.
 */

import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";

const BRANDED_FOOTER = `
  <p style="font-size:14px;color:#888;margin:16px 0 0;border-top:1px solid #eee;padding-top:12px;">
    Red Cedar Electric LLC &middot; Licensed &amp; Insured<br>
    Serving Middle Tennessee
  </p>`;

function getTransporter() {
  const gmailUser = process.env.GMAIL_USER;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!gmailUser || !clientId || !clientSecret || !refreshToken) {
    return null;
  }

  return {
    transporter: nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2" as const,
        user: gmailUser,
        clientId,
        clientSecret,
        refreshToken,
      },
    }),
    from: `"Red Cedar Electric" <${gmailUser}>`,
  };
}

export function humanizeDocType(type: string): string {
  switch (type) {
    case "work_order": return "Work Order";
    case "material_list": return "Material List";
    case "contract": return "Contract";
    case "change_order": return "Change Order";
    case "signed": return "Signed Agreement";
    case "health_report": return "Electrical Health Record";
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
}

export async function sendDocumentEmail(input: SendDocumentEmailInput): Promise<boolean> {
  const mail = getTransporter();
  if (!mail) {
    console.warn("[DocumentDelivery] Gmail not configured — skipping.");
    return false;
  }

  if (!fs.existsSync(input.pdfPath)) {
    console.error(`[DocumentDelivery] PDF not found on disk: ${input.pdfPath}`);
    return false;
  }

  const label = humanizeDocType(input.docType);
  const filename = path.basename(input.pdfPath);
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
        <p style="font-size:14px;color:#555;">If you have any questions, reply to this email or call (731) 462-0443.</p>
        ${BRANDED_FOOTER}
      </div>
    </div>`;

  try {
    await mail.transporter.sendMail({
      from: mail.from,
      to: input.to,
      subject: `${label} — Red Cedar Electric`,
      html,
      attachments: [{ filename, path: input.pdfPath }],
    });
    console.log(`[DocumentDelivery] Sent ${input.docType} to ${input.to}`);
    return true;
  } catch (err) {
    console.error("[DocumentDelivery] Send failed:", err);
    return false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
