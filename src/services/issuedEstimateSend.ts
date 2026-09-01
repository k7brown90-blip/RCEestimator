/**
 * The two emails in the send-and-sign loop. (P027)
 *
 *   1. `sendEstimateEmail`  — OPERATOR-TRIGGERED, to the customer, carrying the tokenized link.
 *   2. `notifyOwnerSigned`  — INTERNAL, to SUMMARY_EMAIL, when a customer signs.
 *
 * ── WHY THIS IS NOT BEHIND `automationGate` ────────────────────────────────────────────────
 *
 * The 2026-08-11 manual-first deferral gates AUTOMATED customer sends: the 8 AM reminder cron,
 * booking confirmations, the web-lead auto-reply, inbound auto-replies. All four share one
 * property — they fire without a human deciding, in response to a clock or a webhook.
 *
 * Kyle's 2026-08-17 ruling orders something different: *"I can email the customer and have them
 * sign an estimate in the app."* A send that happens because Kyle tapped Send, on one estimate he
 * is looking at, after a confirm. That is not automation; it is the operator using the tool.
 *
 * So `sendEstimateEmail` is deliberately NOT a member of the `CustomerSendWorkflow` union and
 * `AUTOMATED_CUSTOMER_SENDS` is neither read nor written by this file. The gate stays exactly as
 * P013/P017 left it. What replaces the gate as the safety property is the CALLER: this function
 * has exactly one, a PIN-authenticated route handler. Nothing scheduled, retried or webhook-driven
 * may call it, and the negative test in `tests/issuedEstimate.test.ts` pins that the unauthenticated
 * caller gets a 401 rather than a sent email.
 *
 * Every send is recorded on the row (sentAt / sentBy / sentTo), appended to the estimate's event
 * log, and written to SystemEvent — so a send is as visible after the fact as a suppressed one.
 *
 * NO TWILIO. Nothing in this file touches SMS. The customer gets an email; Kyle gets an email.
 */

import type { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import { sendBrandedEmail, escapeHtml } from "./confirmationEmail";
import { generateGeneratorReport, generateHealthReport } from "./pdfGenerator";
import { logSystemEvent } from "./systemEvents";
// The invoice send renders the customer's PDF itself rather than reading a stored file — same
// reason the filed copies are rendered on demand: nothing to drift, nothing lost to a deploy.
import { renderEstimatePdf } from "./issuedEstimatePdf";
import { getCompanyProfile } from "./companyProfile";
import { stripeConfigured } from "./stripePayments";
import sharp from "sharp";

export type SendResult = { ok: true; to: string } | { ok: false; reason: string };

/**
 * Job photos chosen by the operator to ride an estimate or invoice email
 * (photo gallery, Kyle 2026-08-28). Guarded twice:
 *  - a photo only attaches if it was taken at THIS estimate's service address —
 *    a wrong id cannot leak another customer's job onto this email;
 *  - each image is downscaled for email and the count is capped, so a send
 *    can't balloon past what mail providers accept.
 */
const MAX_EMAIL_PHOTOS = 10;

async function photoAttachments(
  prisma: PrismaClient,
  photoIds: string[],
  serviceAddressId: string,
): Promise<{ attachments: Array<{ filename: string; content: Buffer; contentType: string }>; refused: string[] }> {
  const ids = [...new Set(photoIds)].slice(0, MAX_EMAIL_PHOTOS);
  const photos = await prisma.visitPhoto.findMany({
    where: { id: { in: ids }, visit: { propertyId: serviceAddressId } },
    select: { id: true, data: true, caption: true },
  });
  const found = new Set(photos.map((p) => p.id));
  const refused = ids.filter((id) => !found.has(id));
  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  for (const [i, photo] of photos.entries()) {
    try {
      const content = await sharp(Buffer.from(photo.data))
        .rotate()
        .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      const label = (photo.caption ?? "").trim().replace(/[^a-z0-9 _-]/gi, "").slice(0, 40);
      attachments.push({
        filename: `photo-${i + 1}${label ? `-${label.replace(/\s+/g, "-")}` : ""}.jpg`,
        content,
        contentType: "image/jpeg",
      });
    } catch {
      refused.push(photo.id); // a corrupt image must not sink the send
    }
  }
  return { attachments, refused };
}

/** Absolute base URL for customer links. Railway sets RAILWAY_PUBLIC_DOMAIN. */
export function publicBaseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (domain) return `https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
  return "http://localhost:8080";
}

export function estimateLink(token: string): string {
  return `${publicBaseUrl()}/e/${token}`;
}

/**
 * Email one estimate to its customer. Operator action only.
 *
 * Refuses rather than guesses when there is no address — an estimate with no customer email is a
 * data problem Kyle fixes on the account, not something to paper over by sending it to himself.
 */
/**
 * Email the SIGNED invoice to the customer, with the PDF attached.
 *
 * Kyle, 2026-08-21: *"The signed estimates need to be labeled invoices and they need to be
 * emailed."* And from the picker on the account page: *"I cannot email the invoice to the
 * client."*
 *
 * ── WHY THIS IS NOT sendEstimateEmail WITH A FLAG ──────────────────────────────────────────────
 *
 * That function refuses outright once an estimate is signed, and it should: it exists to send an
 * offer and ask for a signature, and re-sending that after the fact invites a customer to sign a
 * thing they already signed. This is the opposite document with the opposite guard — it refuses
 * anything NOT signed.
 *
 * ── THE PDF IS THE CUSTOMER'S COPY, RENDERED HERE ──────────────────────────────────────────────
 *
 * Rendered at send time from the frozen estimate rather than pulled from a stored file, for the
 * same reason the filed copies are: nothing to drift, nothing to lose to a deploy that wipes
 * `generated/`. Explicitly the "customer" audience — this is the one document that must never
 * carry line pricing or labour hours, and the bug that prompted this work was a hardcoded
 * "company" on the route that served it.
 *
 * It bills what they BOUGHT. renderEstimatePdf re-sums from `selectedOptions`, so a customer who
 * took one option out of three is invoiced for one.
 */
export async function sendInvoiceEmail(
  prisma: PrismaClient,
  estimateId: string,
  opts: { sentBy: string; toOverride?: string | null; message?: string | null; photoIds?: string[] }
): Promise<SendResult> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      options: { orderBy: { option: "asc" } },
    },
  });
  if (!est) return { ok: false, reason: "Estimate not found." };
  if (!est.signedAt) {
    return { ok: false, reason: "This estimate has not been signed yet, so there is no invoice to send." };
  }

  const to = (opts.toOverride ?? est.customerEmail ?? "").trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return {
      ok: false,
      reason:
        "No valid customer email address on this estimate. Add one to the customer record, or " +
        "supply an address when sending.",
    };
  }

  const profile = await getCompanyProfile();
  const pdf = await renderEstimatePdf(
    {
      number: est.number,
      revision: est.revision,
      title: est.title,
      customerName: est.customerName,
      serviceAddress: est.serviceAddress,
      scopeText: est.scopeText,
      total: est.total,
      tripCharge: est.tripCharge,
      signedAt: est.signedAt,
      signedByName: est.signerName,
      signatureImage: est.signatureImage,
      createdAt: est.createdAt,
      options: est.options,
      selectedOptions: est.selectedOptions,
      // The frozen working of the job-level material check, for the company copy (2026-08-21).
      materialCaps: est.materialCapsJson ? JSON.parse(est.materialCapsJson) : null,
      comboCap: est.comboCapJson ? JSON.parse(est.comboCapJson) : null,
      discountType: est.discountType,
      discountPercent: est.discountPercent,
      discount: est.discountJson ? JSON.parse(est.discountJson) : null,
      lines: est.lines.map((l) => ({
        option: l.option,
        description: l.description,
        quantity: l.quantity,
        lineTotal: l.lineTotal,
        laborHours: l.laborHours,
        materialSell: l.materialSell,
        materialCost: l.materialCost,
      })),
    },
    "customer",
    profile,
  );

  // What they actually owe — the same arithmetic the PDF prints, so the email and its attachment
  // cannot quote different numbers.
  const taken = new Set((est.selectedOptions ?? []) as string[]);
  // The third gate's frozen reduction (2026-08-22) — the email body and the attached PDF must
  // state the same number, and both read the same stored figure.
  const comboReduction = est.comboCapJson
    ? ((JSON.parse(est.comboCapJson) as { applied: boolean; reduction: number }).applied
        ? (JSON.parse(est.comboCapJson) as { reduction: number }).reduction
        : 0)
    : 0;
  const progAmount = est.discountJson
    ? ((JSON.parse(est.discountJson) as { amount: number }).amount ?? 0)
    : 0;
  const billed =
    taken.size > 0 && est.options.length > 0
      ? Math.round(
          (est.options.filter((o) => taken.has(o.option)).reduce((n, o) => n + o.subtotal, 0) +
            est.tripCharge - comboReduction - progAmount) * 100,
        ) / 100
      : Math.round((est.total - comboReduction - progAmount) * 100) / 100;

  const firstName = est.customerName.trim().split(/\s+/)[0] || est.customerName;
  const note = (opts.message ?? "").trim();
  // Pay online (Stripe, 2026-08-25): the link is OUR durable /pay route, which
  // mints a fresh Checkout session per click — a raw session URL would expire
  // in a day. Only rendered while Stripe is configured on the service.
  const payUrl = stripeConfigured() ? `${publicBaseUrl()}/pay/${est.token}` : null;
  const bodyHtml = `
    <p style="font-size:15px;">Hi ${escapeHtml(firstName)},</p>
    <p style="font-size:15px;">Thank you for approving <strong>${escapeHtml(est.title)}</strong>.
    Your signed invoice is attached.</p>
    ${note ? `<p style="font-size:15px;">${escapeHtml(note)}</p>` : ""}
    <p style="font-size:15px;">Invoice <strong>${escapeHtml(est.number)}</strong>${
      est.revision > 1 ? ` (revision ${est.revision})` : ""
    } &middot; Total <strong>${`$${billed.toFixed(2)}`}</strong></p>
    ${payUrl ? `
    <p style="margin:24px 0;">
      <a href="${escapeHtml(payUrl)}"
         style="background:#1a5c2e;color:#fff;text-decoration:none;padding:14px 28px;
                border-radius:6px;font-size:16px;font-weight:600;display:inline-block;">
        Pay online
      </a>
    </p>` : ""}
    <p style="font-size:14px;">Thank you,<br>Kyle Brown<br>Red Cedar Electric LLC</p>`;

  // Job photos the operator chose to include — before/after shots belong on
  // the invoice for completed work (photo gallery, Kyle 2026-08-28).
  const photos = opts.photoIds && opts.photoIds.length > 0
    ? await photoAttachments(prisma, opts.photoIds, est.serviceAddressId)
    : { attachments: [], refused: [] };

  const sent = await sendBrandedEmail({
    to,
    subject: `Your invoice from Red Cedar Electric — ${est.number}`,
    headline: "Your invoice",
    bodyHtml,
    attachments: [
      { filename: `invoice-${est.number}.pdf`, content: pdf, contentType: "application/pdf" },
      ...photos.attachments,
    ],
  });

  if (!sent) {
    logSystemEvent("error", "issued-estimate", `Invoice ${est.number} send FAILED to ${to}`, {
      estimateId: est.id,
      sentBy: opts.sentBy,
    });
    return { ok: false, reason: "The email could not be sent. Check the Gmail connection and try again." };
  }

  // The estimate's own sent* fields belong to the ESTIMATE send and are left alone — overwriting
  // them would erase when the offer went out. The invoice send is recorded as its own event.
  await prisma.issuedEstimateEvent.create({
    data: {
      estimateId: est.id,
      type: "invoice_sent",
      actor: opts.sentBy,
      detail: `Invoice emailed to ${to} (rev ${est.revision}, ${`$${billed.toFixed(2)}`})`,
    },
  });

  logSystemEvent("info", "issued-estimate", `Invoice ${est.number} emailed to ${to}`, {
    estimateId: est.id,
    sentBy: opts.sentBy,
  });
  return { ok: true, to };
}

export async function sendEstimateEmail(
  prisma: PrismaClient,
  estimateId: string,
  opts: {
    sentBy: string;
    toOverride?: string | null;
    message?: string | null;
    photoIds?: string[];
    /** Support documentation (Kyle, 2026-08-29: "I should be able to add the
     * reports here for the electrical assessment, generator report, and any
     * photos") — rendered fresh from the newest assessment at the estimate's
     * address, so the attachment is never a stale file. */
    attachHealthReport?: boolean;
    attachGeneratorReport?: boolean;
  }
): Promise<SendResult> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    include: { supersededBy: { select: { id: true } } },
  });
  if (!est) return { ok: false, reason: "Estimate not found." };
  if (est.supersededBy) {
    return { ok: false, reason: "This estimate has been superseded by a newer revision. Send that one instead." };
  }
  if (est.status === "void") return { ok: false, reason: "This estimate is void." };
  if (est.signedAt) return { ok: false, reason: "This estimate is already signed." };

  const to = (opts.toOverride ?? est.customerEmail ?? "").trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return {
      ok: false,
      reason:
        "No valid customer email address on this estimate. Add one to the customer record, or " +
        "supply an address when sending.",
    };
  }

  const link = estimateLink(est.token);
  const firstName = est.customerName.trim().split(/\s+/)[0] || est.customerName;
  const note = (opts.message ?? "").trim();

  // Flat total only. The email carries no line detail and — like the page — no hours.
  const bodyHtml = `
    <p style="font-size:15px;">Hi ${escapeHtml(firstName)},</p>
    <p style="font-size:15px;">Your estimate for <strong>${escapeHtml(est.title)}</strong> is ready.
    You can review it and accept it online using the private link below.</p>
    ${note ? `<p style="font-size:15px;">${escapeHtml(note)}</p>` : ""}
    <p style="margin:24px 0;">
      <a href="${escapeHtml(link)}"
         style="background:#1a5c2e;color:#fff;text-decoration:none;padding:14px 28px;
                border-radius:6px;font-size:16px;font-weight:600;display:inline-block;">
        View &amp; accept your estimate
      </a>
    </p>
    <p style="font-size:13px;color:#666;">Estimate ${escapeHtml(est.number)}${est.revision > 1 ? ` (revision ${est.revision})` : ""}
    &middot; Total ${`$${est.total.toFixed(2)}`} &middot; Valid ${est.validDays} days.</p>
    <p style="font-size:13px;color:#666;">If the button does not work, copy this link into your browser:<br>
    <span style="word-break:break-all;">${escapeHtml(link)}</span></p>
    <p style="font-size:14px;">Thank you,<br>Kyle Brown<br>Red Cedar Electric LLC</p>`;

  // Job photos the operator chose to include (photo gallery, Kyle 2026-08-28) —
  // assessment shots that show the customer what the estimate is talking about.
  const photos = opts.photoIds && opts.photoIds.length > 0
    ? await photoAttachments(prisma, opts.photoIds, est.serviceAddressId)
    : { attachments: [], refused: [] };

  // Support documentation, rendered fresh at send time (2026-08-29). Refuses
  // plainly when the record to render from doesn't exist — an email that
  // silently arrived thinner than the operator ticked would be worse.
  const docAttachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  if (opts.attachHealthReport || opts.attachGeneratorReport) {
    const inspection = await prisma.healthInspection.findFirst({
      where: { propertyId: est.serviceAddressId },
      orderBy: { inspectionDate: "desc" },
      select: { id: true, loadCalcJson: true },
    });
    if (!inspection) {
      return { ok: false, reason: "No electrical assessment is on file for this address — the report attachments can't be produced." };
    }
    if (opts.attachHealthReport) {
      const report = await generateHealthReport(inspection.id);
      docAttachments.push({
        filename: `electrical-health-record-${est.number}.pdf`,
        content: await fs.promises.readFile(report.pdfPath),
        contentType: "application/pdf",
      });
    }
    if (opts.attachGeneratorReport) {
      if (!inspection.loadCalcJson) {
        return { ok: false, reason: "This address's assessment has no load calculation — the generator sizing sheet can't be produced." };
      }
      const report = await generateGeneratorReport(inspection.id);
      docAttachments.push({
        filename: `generator-sizing-data-sheet-${est.number}.pdf`,
        content: await fs.promises.readFile(report.pdfPath),
        contentType: "application/pdf",
      });
    }
  }

  const allAttachments = [...docAttachments, ...photos.attachments];
  const sent = await sendBrandedEmail({
    to,
    subject: `Your estimate from Red Cedar Electric — ${est.number}`,
    headline: "Your estimate is ready",
    bodyHtml,
    ...(allAttachments.length > 0 ? { attachments: allAttachments } : {}),
  });

  if (!sent) {
    logSystemEvent("error", "issued-estimate", `Estimate ${est.number} send FAILED to ${to}`, {
      estimateId: est.id,
      sentBy: opts.sentBy,
    });
    return { ok: false, reason: "The email could not be sent. Check the Gmail connection and try again." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.issuedEstimate.update({
      where: { id: est.id },
      data: {
        sentAt: new Date(),
        sentBy: opts.sentBy,
        sentTo: to,
        // A re-send of an already-viewed estimate does not rewind it to "sent".
        status: est.status === "draft" ? "sent" : est.status,
      },
    });
    await tx.issuedEstimateEvent.create({
      data: {
        estimateId: est.id,
        type: "sent",
        actor: opts.sentBy,
        detail: `Emailed to ${to} (rev ${est.revision})`,
      },
    });
  });

  logSystemEvent("info", "issued-estimate", `Estimate ${est.number} emailed to ${to}`, {
    estimateId: est.id,
    revision: est.revision,
    sentBy: opts.sentBy,
  });

  return { ok: true, to };
}

/**
 * Tell Kyle an estimate was signed. INTERNAL — this is not a customer send and the manual-first
 * ruling does not reach it; it is the same lane as the daily digest.
 */
/**
 * Tell Kyle the FIRST time a customer opens their estimate (2026-08-22).
 *
 * Kyle asked whether he can know if his emails were read. The honest answer: an email-open pixel
 * lies in both directions (Apple auto-loads images; other clients block them). What cannot lie is
 * the estimate link itself — the customer either opened the page with the price on it or they did
 * not. This fires on that moment, because it is the actionable one: they are holding his number
 * RIGHT NOW, and a call within the hour beats one three days later.
 *
 * Internal only, to SUMMARY_EMAIL — same rules as the signature notification above it, and like
 * it, deliberately NOT behind automationGate: nothing here emails a customer.
 *
 * ONE CAVEAT THE EMAIL STATES OUT LOUD: corporate mail scanners prefetch links. A "view" seconds
 * after the send is probably a machine, and the email says so rather than letting Kyle sprint for
 * the phone over a bot.
 */
export async function notifyOwnerViewed(prisma: PrismaClient, estimateId: string): Promise<boolean> {
  const est = await prisma.issuedEstimate.findUnique({ where: { id: estimateId } });
  if (!est || !est.firstViewedAt) return false;

  const to = (process.env.SUMMARY_EMAIL ?? process.env.GMAIL_USER ?? "").trim();
  if (!to) {
    console.warn("[IssuedEstimate] SUMMARY_EMAIL not set — view notification skipped.");
    return false;
  }

  const secondsAfterSend =
    est.sentAt ? Math.round((est.firstViewedAt.getTime() - est.sentAt.getTime()) / 1000) : null;
  const scannerNote =
    secondsAfterSend !== null && secondsAfterSend < 120
      ? `<p style="font-size:13px;color:#a15c00;">Opened ${secondsAfterSend}s after sending — this is
         often a mail scanner rather than the customer. Treat with salt.</p>`
      : "";

  const bodyHtml = `
    <p style="font-size:16px;"><strong>${escapeHtml(est.customerName)}</strong> just opened estimate
    <strong>${escapeHtml(est.number)}</strong> for the first time.</p>
    <table style="font-size:14px;border-collapse:collapse;">
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Job</td><td>${escapeHtml(est.title)}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Total</td><td><strong>$${est.total.toFixed(2)}</strong></td></tr>
      ${est.customerPhone ? `<tr><td style="padding:3px 12px 3px 0;color:#666;">Phone</td><td>${escapeHtml(est.customerPhone)}</td></tr>` : ""}
    </table>
    ${scannerNote}
    <p style="font-size:14px;margin-top:14px;">They are looking at your price right now — this is
    the moment a call lands best.</p>`;

  return sendBrandedEmail({
    to,
    subject: `VIEWED — ${est.number} — ${est.customerName} — $${est.total.toFixed(2)}`,
    headline: "Estimate opened",
    bodyHtml,
  });
}

export async function notifyOwnerSigned(prisma: PrismaClient, estimateId: string): Promise<boolean> {
  const est = await prisma.issuedEstimate.findUnique({ where: { id: estimateId } });
  if (!est) return false;

  const to = (process.env.SUMMARY_EMAIL ?? process.env.GMAIL_USER ?? "").trim();
  if (!to) {
    console.warn("[IssuedEstimate] SUMMARY_EMAIL not set — sign notification skipped.");
    return false;
  }

  const bodyHtml = `
    <p style="font-size:16px;"><strong>${escapeHtml(est.signerName ?? "The customer")}</strong>
    signed estimate <strong>${escapeHtml(est.number)}</strong>${est.revision > 1 ? ` (rev ${est.revision})` : ""}.</p>
    <table style="font-size:14px;border-collapse:collapse;">
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Customer</td><td>${escapeHtml(est.customerName)}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Job</td><td>${escapeHtml(est.title)}</td></tr>
      ${est.serviceAddress ? `<tr><td style="padding:3px 12px 3px 0;color:#666;">Address</td><td>${escapeHtml(est.serviceAddress)}</td></tr>` : ""}
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Total</td><td><strong>$${est.total.toFixed(2)}</strong></td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666;">Signed at</td><td>${est.signedAt?.toISOString() ?? ""}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666;">IP</td><td>${escapeHtml(est.signerIp ?? "unknown")}</td></tr>
    </table>
    <p style="font-size:14px;margin-top:18px;">The estimate is now locked. Any change needs a new
    revision, which voids the customer's current link.</p>`;

  return sendBrandedEmail({
    to,
    subject: `SIGNED — ${est.number} — ${est.customerName} — $${est.total.toFixed(2)}`,
    headline: "Estimate signed",
    bodyHtml,
  });
}
