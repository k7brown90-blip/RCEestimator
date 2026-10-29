/**
 * Payment receipts (Kyle, 2026-08-25: "I need the final receipts to email
 * that show something is paid.")
 *
 * Every payment that lands against an invoice — card/ACH through the webhook,
 * or a cash/check recorded by hand — emails the customer a receipt: what was
 * paid, how, on which invoice, and what remains. Paid-in-full gets said in the
 * subject line, because that is the sentence the customer files the email for.
 *
 * Fire-and-forget at every call site: a receipt email must never be able to
 * fail the payment that is already durably recorded.
 */

import type { PrismaClient } from "@prisma/client";
import { sendBrandedEmail, escapeHtml } from "./confirmationEmail";
import { logSystemEvent } from "./systemEvents";
import { paymentSummary, type PaymentSummary } from "./stripePayments";
import { warrantyEmailLine } from "./warrantyNotice";
import { invoiceRootId } from "./invoiceGroup";
import { BALANCE_DUE_TERMS } from "./paymentTerms";
import { FINANCING_IN_PROGRESS, financingInProgress } from "./financingFee";
import { resolveRecipients, withCcText } from "./emailCc";
import { photoAttachments, renderInvoicePdf } from "./issuedEstimateSend";
import { renderReceiptReports } from "./receiptReports";
import { PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL } from "./paymentLabels";

/**
 * What the invoice is made of (Kyle, 2026-09-20): the root estimate and every signed change
 * order that joined it, one row each, above the total. Empty when the invoice is one document —
 * an ordinary bill reads exactly as it did.
 */
export function invoiceDocumentRows(summary: Pick<PaymentSummary, "documents">): string {
  if (summary.documents.length < 2) return "";
  return summary.documents.map((d) =>
    `<tr><td style="padding:4px 0;color:#666;">${d.kind === "change_order" ? "Change order" : "Invoice"} ${escapeHtml(d.number)} — ${escapeHtml(d.title)}</td>
     <td style="text-align:right;">$${d.billedTotal.toFixed(2)}</td></tr>`).join("");
}

/**
 * Home-warranty coverage (Kyle, 2026-09-09): the credit the warranty company
 * is billed for, shown above the homeowner's total so the statement adds up —
 * "Warranty coverage (RELY Home, claim 343467219): −$370.00 · billed to RELY Home".
 */
function warrantyRow(summary: {
  warrantyCovered: number;
  warrantyClaim: { company: string; claimNumber: string; authNumber: string | null } | null;
}): string {
  if (!summary.warrantyClaim || !(summary.warrantyCovered > 0)) return "";
  return `<tr><td colspan="2" style="padding:4px 0;color:#1a5c2e;">${escapeHtml(
    warrantyEmailLine(summary.warrantyClaim, summary.warrantyCovered),
  )}</td></tr>`;
}

const KIND_LABEL = PAYMENT_KIND_LABEL;
const METHOD_LABEL = PAYMENT_METHOD_LABEL;

/**
 * The financing fee as its own line (Kyle, 2026-10-08: "Shown as its own line, never folded in"),
 * above the balance, whenever one is applied on the invoice. Empty otherwise — an invoice paid any
 * other way reads exactly as it did.
 */
export function financingFeeRow(summary: Pick<PaymentSummary, "financingFee">): string {
  const fee = summary.financingFee;
  if (!fee) return "";
  return `<tr><td style="padding:4px 0;color:#666;">Financing fee — Plan ${escapeHtml(fee.planNumber)}</td>
    <td style="text-align:right;">$${fee.fee.toFixed(2)}</td></tr>`;
}

/**
 * Legacy discount credits (the retired 3% non-card programme, 2026-08-25 →
 * 08-30) — only ever non-empty on invoices that were paid while it ran, and
 * shown so the receipt's arithmetic still adds up on those.
 */
export function discountRows(summary: { payments: { method: string; kind: string; amount: number; voidedAt?: Date | null }[] }): string {
  const discounts = summary.payments.filter((p) => p.method === "discount" && !p.voidedAt);
  if (discounts.length === 0) return "";
  const total = discounts.reduce((s, d) => s + d.amount, 0);
  return `<tr><td style="padding:4px 0;color:#1a5c2e;">Discount credit</td>
    <td style="text-align:right;color:#1a5c2e;font-weight:600;">&minus;$${total.toFixed(2)}</td></tr>`;
}

/**
 * The deposit request (Kyle, 2026-08-25): the moment an estimate is signed —
 * either door — the customer gets "next step: your ⅓ deposit" with the pay
 * link, because a job can't be scheduled until the deposit is in and a
 * customer who signed from their kitchen table has no other way to hear that.
 * Skips itself when the deposit (or everything) is already paid — an
 * in-person customer who tapped the QR before Kyle left doesn't get nagged.
 *
 * ONE EMAIL TOOL (Kyle, 2026-10-27): when a person presses it (the "Email the customer" panel,
 * POST /customer-emails) it takes the panel's To, CC and note through the one recipient rule
 * (emailCc.resolveRecipients) and answers with WHY it did not send; the automatic call after a
 * signature passes nothing and ignores the answer, exactly as before. Nothing given = the customer
 * on file.
 */
export async function sendDepositRequestEmail(
  prisma: PrismaClient,
  estimateId: string,
  payBaseUrl: string,
  opts: { toOverride?: string | null; cc?: string[]; message?: string | null } = {},
): Promise<{ ok: true; to: string; cc: string[]; amount: number } | { ok: false; reason: string }> {
  // The deposit belongs to the INVOICE (2026-09-20): a change order's id resolves to its root,
  // and the ask, the number and the pay link are the root's.
  estimateId = await invoiceRootId(prisma, estimateId);
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: { number: true, title: true, token: true, customerName: true, customerEmail: true, signedAt: true },
  });
  if (!est) return { ok: false, reason: "Estimate not found." };
  if (!est.signedAt) return { ok: false, reason: "This estimate has not been signed yet." };
  const recipients = resolveRecipients(
    { toOverride: opts.toOverride, onFile: est.customerEmail, cc: opts.cc },
    "No customer email on file — add one to the account first, or type an address when sending.",
  );
  if (!recipients.ok) return { ok: false, reason: recipients.reason };
  const { to, cc } = recipients;

  const summary = await paymentSummary(prisma, estimateId, payBaseUrl);
  if (!summary) return { ok: false, reason: "Estimate not found." };
  // No deposit required (Kyle, 2026-09-20) means no deposit email — not a $0.00 ask.
  if (!summary.depositRequired) {
    return { ok: false, reason: "No deposit is required on this invoice — turn the deposit on first if you want one." };
  }
  if (summary.depositSatisfied || summary.paidInFull) return { ok: false, reason: "The deposit on this job is already in." };
  // FINANCING IN PROGRESS (review finding, 2026-10-09): a fee is on and not yet paid, so the
  // deposit pay link this email carries is closed (chargeableAmount refuses). Never send a
  // customer to a dead end - refused here with the reason, which the panel shows.
  if (financingInProgress(summary)) {
    return { ok: false, reason: `${FINANCING_IN_PROGRESS} — the deposit pay link is closed. Remove the financing fee (with a reason) to collect the deposit again, then add the fee back.` };
  }

  const due = Math.round((summary.depositDue - summary.depositPaid) * 100) / 100;
  const firstName = est.customerName.trim().split(/\s+/)[0] || est.customerName;
  const payUrl = `${payBaseUrl}/pay/${est.token}?type=deposit`;

  const sent = await sendBrandedEmail({
    kind: "deposit",
    estimateNumber: est.number,
    issuedEstimateId: estimateId,
    to,
    ...(cc.length > 0 ? { cc } : {}),
    subject: `Next step — your deposit for ${est.title} ($${due.toFixed(2)})`,
    headline: "Thank you — one step to get you scheduled",
    bodyHtml: `
      <p style="font-size:15px;">Hi ${escapeHtml(firstName)},</p>
      <p style="font-size:15px;">Thank you for approving <strong>${escapeHtml(est.title)}</strong>
      (invoice ${escapeHtml(est.number)}). To reserve your spot on the schedule, a deposit of
      <strong>$${due.toFixed(2)}</strong> — one third of the total — is due up front. We can't book
      the work until it's in.</p>
      ${(opts.message ?? "").trim() ? `<p style="font-size:15px;">${escapeHtml((opts.message ?? "").trim())}</p>` : ""}
      <p style="margin:24px 0;">
        <a href="${escapeHtml(payUrl)}"
           style="background:#1a5c2e;color:#fff;text-decoration:none;padding:14px 28px;
                  border-radius:6px;font-size:16px;font-weight:600;display:inline-block;">
          Pay your deposit — $${due.toFixed(2)}
        </a>
      </p>
      <p style="font-size:13px;color:#666;">Pay by card or bank transfer online, or by cash, check, or Zelle — same amount either way.
      Deposits are non-refundable up to $300 if the job is cancelled. ${BALANCE_DUE_TERMS}</p>
      <p style="font-size:14px;">Thank you,<br>Kyle Brown<br>Red Cedar Electric LLC</p>`,
  });
  if (!sent) return { ok: false, reason: "The email could not be sent — check the email connection." };
  logSystemEvent("info", "stripe", `Deposit request emailed to ${to} — $${due.toFixed(2)} on ${est.number}`, {
    estimateId,
  });
  return { ok: true, to, cc, amount: due };
}

export async function sendPaymentReceiptEmail(
  prisma: PrismaClient,
  paymentId: string,
): Promise<void> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  // No receipt for a voided row (2026-10-09, services/paymentVoid.ts) — it is not money received.
  if (!payment || payment.status !== "paid" || payment.voidedAt || !payment.estimateId) return;

  const est = await prisma.issuedEstimate.findUnique({
    where: { id: payment.estimateId },
    select: { number: true, title: true, customerName: true, customerEmail: true, serviceAddress: true },
  });
  if (!est?.customerEmail) return;

  const summary = await paymentSummary(prisma, payment.estimateId, "https://unused.invalid");
  if (!summary) return;
  // The receipt names the INVOICE (2026-09-20) — the root's number and title, whichever
  // document the payment row happens to sit on.
  if (summary.estimateId !== payment.estimateId) {
    const root = await prisma.issuedEstimate.findUnique({ where: { id: summary.estimateId }, select: { number: true, title: true } });
    if (root) { est.number = root.number; est.title = root.title; }
  }

  // The warranty company's check (Kyle, 2026-09-10) is not the homeowner's payment: the
  // homeowner is never written to about the warranty share — EXCEPT when that check settles
  // the whole invoice and their own balance is already zero, when the paid-in-full receipt
  // is the one document that says everything on the job is closed.
  const warrantyPayer = payment.payer === "warranty";
  if (warrantyPayer && !(summary.fullyPaid && summary.balance <= 0.01)) return;

  const paidInFull = summary.paidInFull;
  const firstName = est.customerName.trim().split(/\s+/)[0] || est.customerName;
  const dateStr = (payment.paidAt ?? payment.createdAt).toLocaleDateString("en-US", {
    timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric",
  });
  const paymentLabel = warrantyPayer
    ? `Warranty payment — ${escapeHtml(summary.warrantyClaim?.company ?? "warranty company")}${summary.warrantyClaim ? ` (claim ${escapeHtml(summary.warrantyClaim.claimNumber)})` : ""}`
    : (KIND_LABEL[payment.kind] ?? "Payment");

  const bodyHtml = `
    <p style="font-size:15px;">Hi ${escapeHtml(firstName)},</p>
    <p style="font-size:15px;">${warrantyPayer ? "Your warranty company's payment has arrived — everything on this invoice is now settled. Thank you." : "This is your receipt — thank you."}</p>
    <table style="width:100%;font-size:15px;border-collapse:collapse;margin:12px 0;">
      <tr><td style="padding:4px 0;color:#666;">Invoice</td><td style="text-align:right;">${escapeHtml(est.number)} — ${escapeHtml(est.title)}</td></tr>
      ${est.serviceAddress ? `<tr><td style="padding:4px 0;color:#666;">Service address</td><td style="text-align:right;">${escapeHtml(est.serviceAddress)}</td></tr>` : ""}
      <tr><td style="padding:4px 0;color:#666;">${paymentLabel}</td>
        <td style="text-align:right;font-weight:600;">$${payment.amount.toFixed(2)} ${METHOD_LABEL[payment.method] ?? "paid"} on ${dateStr}</td></tr>
      ${invoiceDocumentRows(summary)}
      ${warrantyRow(summary)}
      <tr><td style="padding:4px 0;color:#666;">${summary.warrantyCovered > 0 ? "Your total" : "Invoice total"}</td><td style="text-align:right;">$${summary.billedTotal.toFixed(2)}</td></tr>
      ${financingFeeRow(summary)}
      ${discountRows(summary)}
      <tr><td style="padding:4px 0;color:#666;">Paid to date</td><td style="text-align:right;">$${summary.totalPaid.toFixed(2)}</td></tr>
      <tr style="border-top:2px solid #1a5c2e;"><td style="padding:6px 0;font-weight:600;">${paidInFull ? "Balance" : "Remaining balance"}</td>
        <td style="text-align:right;font-weight:700;">${paidInFull ? "PAID IN FULL" : `$${summary.balance.toFixed(2)}`}</td></tr>
    </table>
    ${paidInFull
      ? `<p style="font-size:14px;">Your invoice is paid in full. It has been a pleasure — keep this receipt with your records.</p>`
      : `<p style="font-size:14px;color:#555;">${BALANCE_DUE_TERMS}</p>`}
    <p style="font-size:14px;">Thank you,<br>Kyle Brown<br>Red Cedar Electric LLC</p>`;

  const sent = await sendBrandedEmail({
    kind: "receipt",
    estimateNumber: est.number,
    issuedEstimateId: payment.estimateId,
    to: est.customerEmail,
    subject: paidInFull
      ? `Paid in full — receipt for Invoice ${est.number}`
      : `Receipt — $${payment.amount.toFixed(2)} received on Invoice ${est.number}`,
    headline: paidInFull ? "Paid in full — thank you" : "Payment received",
    bodyHtml,
  });

  if (sent) {
    logSystemEvent("info", "stripe", `Receipt emailed to ${est.customerEmail} — $${payment.amount.toFixed(2)} on ${est.number}${paidInFull ? " (paid in full)" : ""}`, {
      paymentId,
      estimateId: payment.estimateId,
    });
  }
}

/**
 * THE PAID-IN-FULL RECEIPT a person sends from the "Email the customer" panel (Kyle, 2026-10-29):
 *
 *   "I need a receipt that I can send to the customer that I can attach reports and photos too. This
 *    job has been paid in full and the email customer should have the receipt option once the
 *    payment is competed. Right now I need to email the receipt and the report with photos for the
 *    customers realtor so they can close out their home inspection punch list."
 *
 * Not the automatic receipt above (sendPaymentReceiptEmail - once per payment, the customer on file,
 * no attachments, untouched by this): this one is pressed, goes to the To and CC the panel chose,
 * and carries the itemized invoice PDF ALWAYS plus each report ticked and each photo picked.
 *
 *   - It names the ROOT invoice (invoiceRootId / summary.number), never a change order's own number.
 *   - REFUSED while anything is owing - a "receipt" for an open balance would be a lie in the
 *     customer's inbox. The panel greys the choice with the same sentence.
 *   - NEVER THINNER THAN TICKED: a report that is not this job's / not ready / will not render, or a
 *     photo outside the account, refuses the whole send with the reason (receiptReports.ts).
 *   - Who it goes to is decided by the one recipient rule (emailCc.resolveRecipients), exactly as
 *     sendDepositRequestEmail does above.
 */
export async function sendReceiptEmail(
  prisma: PrismaClient,
  estimateId: string,
  opts: {
    sentBy: string;
    toOverride?: string | null;
    cc?: string[];
    message?: string | null;
    photoIds?: string[];
    reports?: string[];
  },
): Promise<{ ok: true; to: string; cc: string[] } | { ok: false; reason: string }> {
  // The receipt belongs to the INVOICE: a change order's id resolves to its root.
  const rootId = await invoiceRootId(prisma, estimateId);
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: rootId },
    include: { lines: { orderBy: { sortOrder: "asc" } }, options: { orderBy: { option: "asc" } } },
  });
  if (!est) return { ok: false, reason: "Estimate not found." };
  if (!est.signedAt) return { ok: false, reason: "This estimate has not been signed yet, so there is no invoice to receipt." };

  const summary = await paymentSummary(prisma, rootId, "https://unused.invalid");
  if (!summary) return { ok: false, reason: "Estimate not found." };
  if (!summary.paidInFull) {
    return { ok: false, reason: `A receipt can go once the invoice is paid in full. $${summary.balance.toFixed(2)} is still owing on Invoice ${summary.number}.` };
  }

  const recipients = resolveRecipients(
    { toOverride: opts.toOverride, onFile: est.customerEmail, cc: opts.cc },
    "No customer email on file — add one to the account first, or type an address when sending.",
  );
  if (!recipients.ok) return { ok: false, reason: recipients.reason };
  const { to, cc } = recipients;

  // Photos: the same ownership-checked path every send uses. A photo it refuses refuses the send -
  // the email must not arrive thinner than the person ticked.
  const wantedPhotos = [...new Set(opts.photoIds ?? [])];
  const photos = wantedPhotos.length > 0
    ? await photoAttachments(prisma, wantedPhotos, { customerId: est.customerId })
    : { attachments: [], refused: [] as string[] };
  if (photos.refused.length > 0 || photos.attachments.length < wantedPhotos.length) {
    const n = Math.max(photos.refused.length, wantedPhotos.length - photos.attachments.length);
    return { ok: false, reason: `${n} of the photos you picked can't be sent (not on this customer's account, unreadable, or more than ten). Nothing was emailed.` };
  }

  const reports = await renderReceiptReports(prisma, est, opts.reports ?? []);
  if (!reports.ok) return { ok: false, reason: reports.reason };

  const invoicePdf = await renderInvoicePdf(prisma, est, summary);

  const note = (opts.message ?? "").trim();
  const firstName = est.customerName.trim().split(/\s+/)[0] || est.customerName;
  const lastPaid = summary.payments
    .filter((p) => p.status === "paid" && !p.voidedAt && p.paidAt)
    .map((p) => p.paidAt as Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const paidOn = lastPaid
    ? lastPaid.toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric" })
    : null;
  // Sent to someone other than the customer on file (the realtor): no first-name greeting meant for the homeowner.
  const toOnFile = (est.customerEmail ?? "").trim().toLowerCase() === to.toLowerCase();
  const extras = reports.attachments.length + photos.attachments.length;
  const bodyHtml = `
    <p style="font-size:15px;">${toOnFile ? `Hi ${escapeHtml(firstName)},` : "Hello,"}</p>
    <p style="font-size:15px;">${toOnFile ? "This is your receipt for" : `This is the receipt for ${escapeHtml(est.customerName)}'s job${est.serviceAddress ? ` at ${escapeHtml(est.serviceAddress)}` : ""} —`} <strong>${escapeHtml(est.title)}</strong> — Invoice <strong>${escapeHtml(summary.number)}</strong> is <strong>paid in full</strong>${paidOn ? ` as of ${escapeHtml(paidOn)}` : ""}. Thank you.</p>
    ${note ? `<p style="font-size:15px;">${escapeHtml(note)}</p>` : ""}
    <table style="width:100%;font-size:15px;border-collapse:collapse;margin:12px 0;">
      ${est.serviceAddress ? `<tr><td style="padding:4px 0;color:#666;">Service address</td><td style="text-align:right;">${escapeHtml(est.serviceAddress)}</td></tr>` : ""}
      ${invoiceDocumentRows(summary)}
      <tr><td style="padding:4px 0;color:#666;">${summary.warrantyCovered > 0 ? "Your total" : "Invoice total"}</td><td style="text-align:right;">$${summary.billedTotal.toFixed(2)}</td></tr>
      ${financingFeeRow(summary)}
      ${discountRows(summary)}
      <tr><td style="padding:4px 0;color:#666;">Paid to date</td><td style="text-align:right;">$${summary.totalPaid.toFixed(2)}</td></tr>
      <tr style="border-top:2px solid #1a5c2e;"><td style="padding:6px 0;font-weight:600;">Balance</td><td style="text-align:right;font-weight:700;">PAID IN FULL</td></tr>
    </table>
    <p style="font-size:14px;">The itemized invoice is attached${extras > 0 ? `, along with ${reports.attachments.length > 0 ? `${reports.attachments.length} report${reports.attachments.length === 1 ? "" : "s"}` : ""}${reports.attachments.length > 0 && photos.attachments.length > 0 ? " and " : ""}${photos.attachments.length > 0 ? `${photos.attachments.length} photo${photos.attachments.length === 1 ? "" : "s"}` : ""}` : ""}. Keep this with your records.</p>
    <p style="font-size:14px;">Thank you,<br>Kyle Brown<br>Red Cedar Electric LLC</p>`;

  const sent = await sendBrandedEmail({
    kind: "receipt",
    // The delivery row is the ROOT's: one invoice, one trail.
    estimateNumber: est.number,
    issuedEstimateId: rootId,
    to,
    ...(cc.length > 0 ? { cc } : {}),
    subject: `Paid in full — receipt for Invoice ${summary.number}`,
    headline: "Paid in full — thank you",
    bodyHtml,
    attachments: [
      { filename: `invoice-${est.number}.pdf`, content: invoicePdf, contentType: "application/pdf" },
      ...reports.attachments,
      ...photos.attachments,
    ],
  });
  if (!sent) return { ok: false, reason: "The email could not be sent — check the email connection." };

  await prisma.issuedEstimateEvent.create({
    data: {
      estimateId: rootId,
      type: "receipt_sent",
      actor: opts.sentBy,
      detail: `Paid-in-full receipt emailed to ${withCcText(to, cc)} (${reports.attachments.length} report${reports.attachments.length === 1 ? "" : "s"}, ${photos.attachments.length} photo${photos.attachments.length === 1 ? "" : "s"})`,
    },
  });
  logSystemEvent("info", "stripe", `Paid-in-full receipt emailed to ${withCcText(to, cc)} on ${summary.number}`, {
    estimateId: rootId,
    sentBy: opts.sentBy,
  });
  return { ok: true, to, cc };
}
