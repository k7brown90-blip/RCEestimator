/**
 * Unpaid-invoice follow-up (Kyle, 2026-09-02: "yes the ... unpaid invoice
 * follow up" — nothing was nudging a customer whose check never came).
 *
 * The daily 6 PM sweep: every signed, unvoided, unsuperseded invoice with a
 * real balance gets a gentle reminder when SEVEN quiet days have passed since
 * the last activity (signing, a payment, or the previous reminder) — at most
 * THREE reminders, then it goes quiet and stays a red row on the Invoices page
 * for Kyle to chase personally. Test-account invoices never remind.
 *
 * Gated as a first-class customer-send workflow; the manual button on the
 * Invoices page bypasses pacing (a human pressed it) but still stamps, so the
 * sweep's clock restarts.
 */

import type { PrismaClient } from "@prisma/client";
import { paymentSummary } from "./stripePayments";
import { sendBalanceRequestEmail } from "./paymentReceipts";
import { customerSendsEnabled, logCustomerSendSkipped } from "./automationGate";
import { logSystemEvent } from "./systemEvents";
import { EXCLUDE_TEST_ACCOUNT } from "./accountSpine";
import { publicBaseUrl } from "./issuedEstimateSend";

const QUIET_DAYS = 7;
const MAX_REMINDERS = 3;

export async function sendInvoiceReminder(
  prisma: PrismaClient,
  estimateId: string,
): Promise<{ ok: true; to: string; amount: number } | { ok: false; reason: string }> {
  const result = await sendBalanceRequestEmail(prisma, estimateId, publicBaseUrl(), { reminder: true });
  if (result.ok) {
    await prisma.issuedEstimate.update({
      where: { id: estimateId },
      data: { paymentRemindersSent: { increment: 1 }, lastPaymentReminderAt: new Date() },
    });
    logSystemEvent("info", "invoices", `Payment reminder emailed to ${result.to} — $${result.amount.toFixed(2)} open`, {
      estimateId,
    });
  }
  return result;
}

export async function sweepInvoiceReminders(prisma: PrismaClient): Promise<{ reminded: number; skipped: number }> {
  if (!customerSendsEnabled("invoiceReminders")) {
    logCustomerSendSkipped("invoiceReminders");
    return { reminded: 0, skipped: 0 };
  }
  const candidates = await prisma.issuedEstimate.findMany({
    where: {
      signedAt: { not: null },
      voidedAt: null,
      supersededBy: null,
      paymentRemindersSent: { lt: MAX_REMINDERS },
      ...EXCLUDE_TEST_ACCOUNT,
    },
    select: { id: true, number: true, signedAt: true, lastPaymentReminderAt: true },
  });
  const cutoff = Date.now() - QUIET_DAYS * 24 * 3600 * 1000;
  let reminded = 0;
  let skipped = 0;
  for (const est of candidates) {
    const summary = await paymentSummary(prisma, est.id, "https://unused.invalid");
    if (!summary || summary.paidInFull || summary.balance <= 0.009) continue;
    const lastPaid = summary.payments
      .filter((pmt) => pmt.status === "paid" && pmt.paidAt)
      .reduce<Date | null>((latest, pmt) => (!latest || pmt.paidAt! > latest ? pmt.paidAt! : latest), null);
    const anchor = Math.max(
      est.signedAt?.getTime() ?? 0,
      lastPaid?.getTime() ?? 0,
      est.lastPaymentReminderAt?.getTime() ?? 0,
    );
    if (anchor > cutoff) { skipped += 1; continue; }
    const result = await sendInvoiceReminder(prisma, est.id);
    if (result.ok) reminded += 1;
    else skipped += 1;
  }
  return { reminded, skipped };
}
