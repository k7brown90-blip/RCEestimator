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
import { paymentSummary } from "./stripePayments";

const KIND_LABEL: Record<string, string> = {
  deposit: "Deposit (1/3)",
  final: "Payment",
  other: "Payment",
};

const METHOD_LABEL: Record<string, string> = {
  stripe: "paid online",
  cash: "paid in cash",
  check: "paid by check",
  zelle: "paid via Zelle",
  other: "paid",
};

/**
 * Legacy discount credits (the retired 3% non-card programme, 2026-08-25 →
 * 08-30) — only ever non-empty on invoices that were paid while it ran, and
 * shown so the receipt's arithmetic still adds up on those.
 */
function discountRows(summary: { payments: { method: string; kind: string; amount: number }[] }): string {
  const discounts = summary.payments.filter((p) => p.method === "discount");
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
 */
export async function sendDepositRequestEmail(
  prisma: PrismaClient,
  estimateId: string,
  payBaseUrl: string,
): Promise<void> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: { number: true, title: true, token: true, customerName: true, customerEmail: true, signedAt: true },
  });
  if (!est?.customerEmail || !est.signedAt) return;

  const summary = await paymentSummary(prisma, estimateId, payBaseUrl);
  if (!summary || summary.depositSatisfied || summary.paidInFull) return;

  const due = Math.round((summary.depositDue - summary.depositPaid) * 100) / 100;
  const firstName = est.customerName.trim().split(/\s+/)[0] || est.customerName;
  const payUrl = `${payBaseUrl}/pay/${est.token}?type=deposit`;

  const sent = await sendBrandedEmail({
    to: est.customerEmail,
    subject: `Next step — your deposit for ${est.title} ($${due.toFixed(2)})`,
    headline: "Thank you — one step to get you scheduled",
    bodyHtml: `
      <p style="font-size:15px;">Hi ${escapeHtml(firstName)},</p>
      <p style="font-size:15px;">Thank you for approving <strong>${escapeHtml(est.title)}</strong>
      (invoice ${escapeHtml(est.number)}). To reserve your spot on the schedule, a deposit of
      <strong>$${due.toFixed(2)}</strong> — one third of the total — is due up front. We can't book
      the work until it's in.</p>
      <p style="margin:24px 0;">
        <a href="${escapeHtml(payUrl)}"
           style="background:#1a5c2e;color:#fff;text-decoration:none;padding:14px 28px;
                  border-radius:6px;font-size:16px;font-weight:600;display:inline-block;">
          Pay your deposit — $${due.toFixed(2)}
        </a>
      </p>
      <p style="font-size:13px;color:#666;">Pay by card or bank transfer online, or by cash, check, or Zelle — same amount either way.
      Deposits are non-refundable up to $300 if the job is cancelled. The balance is due at completion.</p>
      <p style="font-size:14px;">Thank you,<br>Kyle Brown<br>Red Cedar Electric LLC</p>`,
  });
  if (sent) {
    logSystemEvent("info", "stripe", `Deposit request emailed to ${est.customerEmail} — $${due.toFixed(2)} on ${est.number}`, {
      estimateId,
    });
  }
}

export async function sendPaymentReceiptEmail(
  prisma: PrismaClient,
  paymentId: string,
): Promise<void> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.status !== "paid" || !payment.estimateId) return;

  const est = await prisma.issuedEstimate.findUnique({
    where: { id: payment.estimateId },
    select: { number: true, title: true, customerName: true, customerEmail: true, serviceAddress: true },
  });
  if (!est?.customerEmail) return;

  const summary = await paymentSummary(prisma, payment.estimateId, "https://unused.invalid");
  if (!summary) return;

  const paidInFull = summary.paidInFull;
  const firstName = est.customerName.trim().split(/\s+/)[0] || est.customerName;
  const dateStr = (payment.paidAt ?? payment.createdAt).toLocaleDateString("en-US", {
    timeZone: "America/Chicago", month: "long", day: "numeric", year: "numeric",
  });

  const bodyHtml = `
    <p style="font-size:15px;">Hi ${escapeHtml(firstName)},</p>
    <p style="font-size:15px;">This is your receipt — thank you.</p>
    <table style="width:100%;font-size:15px;border-collapse:collapse;margin:12px 0;">
      <tr><td style="padding:4px 0;color:#666;">Invoice</td><td style="text-align:right;">${escapeHtml(est.number)} — ${escapeHtml(est.title)}</td></tr>
      ${est.serviceAddress ? `<tr><td style="padding:4px 0;color:#666;">Service address</td><td style="text-align:right;">${escapeHtml(est.serviceAddress)}</td></tr>` : ""}
      <tr><td style="padding:4px 0;color:#666;">${KIND_LABEL[payment.kind] ?? "Payment"}</td>
        <td style="text-align:right;font-weight:600;">$${payment.amount.toFixed(2)} ${METHOD_LABEL[payment.method] ?? "paid"} on ${dateStr}</td></tr>
      <tr><td style="padding:4px 0;color:#666;">Invoice total</td><td style="text-align:right;">$${summary.billedTotal.toFixed(2)}</td></tr>
      ${discountRows(summary)}
      <tr><td style="padding:4px 0;color:#666;">Paid to date</td><td style="text-align:right;">$${summary.totalPaid.toFixed(2)}</td></tr>
      <tr style="border-top:2px solid #1a5c2e;"><td style="padding:6px 0;font-weight:600;">${paidInFull ? "Balance" : "Remaining balance"}</td>
        <td style="text-align:right;font-weight:700;">${paidInFull ? "PAID IN FULL" : `$${summary.balance.toFixed(2)}`}</td></tr>
    </table>
    ${paidInFull
      ? `<p style="font-size:14px;">Your invoice is paid in full. It has been a pleasure — keep this receipt with your records.</p>`
      : `<p style="font-size:14px;color:#555;">The remaining balance is due at completion of the work.</p>`}
    <p style="font-size:14px;">Thank you,<br>Kyle Brown<br>Red Cedar Electric LLC</p>`;

  const sent = await sendBrandedEmail({
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
