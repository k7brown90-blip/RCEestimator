/**
 * Unpaid-invoice follow-up (Kyle, 2026-09-02: "yes the ... unpaid invoice
 * follow up" — nothing was nudging a customer whose check never came).
 *
 * The daily 6 PM sweep: every signed, unvoided, unsuperseded invoice with a
 * real balance gets a gentle reminder when SEVEN quiet days have passed since
 * the last activity (signing, a payment, the previous reminder, or the job's
 * completion) — at most THREE reminders, then it goes quiet and stays a red
 * row on the Invoices page for Kyle to chase personally. Test-account
 * invoices never remind.
 *
 * "Final Payment depends on the work being done." (Kyle, 2026-09-19, after
 * the sweep emailed a balance reminder for a signed job that hadn't started.)
 * An invoice is only a candidate once its job — the Visit named by
 * `IssuedEstimate.jobVisitId` — is marked `status: "completed"` with a
 * `completedAt` stamp. No job, or a job still in progress, means no reminder.
 *
 * Gated as a first-class customer-send workflow.
 *
 * ONE INVOICE EMAIL (Kyle, 2026-10-27, "one tool for one task"): the sweep sends the SAME email a
 * person sends from the "Email the customer" panel - issuedEstimateSend.sendInvoiceEmail, the
 * itemized invoice PDF attached, the balance and the pay link - in its reminder voice, which stamps
 * this sweep's clock. There is no separate "Send reminder" button or bill any more: a person who
 * emails an invoice that already went to the same address gets the reminder voice, and the same
 * stamp, from the panel itself. The schedule below is unchanged.
 */

import type { PrismaClient } from "@prisma/client";
import { paymentSummary } from "./stripePayments";
import { customerSendsEnabled, logCustomerSendSkipped } from "./automationGate";
import { EXCLUDE_TEST_ACCOUNT } from "./accountSpine";
import { sendInvoiceEmail } from "./issuedEstimateSend";
import { invoiceRootId } from "./invoiceGroup";
import { FINANCING_IN_PROGRESS, financingInProgress } from "./financingFee";
import { logSystemEvent } from "./systemEvents";

/**
 * FINANCING IN PROGRESS (Kyle, 2026-10-08; Phase 6 Unit 6C, item K). A customer whose balance is
 * being paid through Synchrony is not chased — not by the daily sweep and not by the manual button.
 * The money comes when the customer releases it with Synchrony, and the pay link a reminder
 * carries is closed. The warranty receivable is exempt for the same reason (the homeowner's
 * balance is the only one reminded). The exemption ends on its own: remove the fee (with a
 * reason) when the financing falls through and the reminders resume; record the Synchrony
 * payment and the invoice is paid in full. A LOCKED fee (the Synchrony payment is recorded) is
 * paid: anything still owed after it is plain invoice money with an open pay link, so it IS
 * reminded (review finding, 2026-10-09).
 */
export const REMINDER_PAUSED_FOR_FINANCING =
  `${FINANCING_IN_PROGRESS} — no reminder is sent. If the financing falls through, remove the financing fee (with a reason) and reminders resume.`;

const QUIET_DAYS = 7;
const MAX_REMINDERS = 3;

export async function sendInvoiceReminder(
  prisma: PrismaClient,
  estimateId: string,
): Promise<{ ok: true; to: string; amount: number } | { ok: false; reason: string }> {
  // ONE rolled-up balance (2026-09-20): a change order's id chases — and stamps — its root.
  estimateId = await invoiceRootId(prisma, estimateId);
  // The manual button is covered too: "a human pressed it" lifts the pacing, not the exemption.
  const before = await paymentSummary(prisma, estimateId, "https://unused.invalid");
  if (before && financingInProgress(before)) return { ok: false, reason: REMINDER_PAUSED_FOR_FINANCING };
  // sendInvoiceEmail in the reminder voice writes the pacing stamp and the log line itself.
  const result = await sendInvoiceEmail(prisma, estimateId, { sentBy: "system:invoice-reminder", reminder: true });
  return result.ok ? { ok: true, to: result.to, amount: result.amount } : result;
}

export async function sweepInvoiceReminders(prisma: PrismaClient): Promise<{ reminded: number; skipped: number }> {
  if (!customerSendsEnabled("invoiceReminders")) {
    logCustomerSendSkipped("invoiceReminders");
    return { reminded: 0, skipped: 0 };
  }
  const candidates = await prisma.issuedEstimate.findMany({
    where: {
      signedAt: { not: null },
      // Positive, not `not: "void"` (2026-09-20): a status this sweep has never heard of — lost
      // was the first — must fall OUT of the candidate list, never into it.
      status: "signed",
      voidedAt: null,
      // PUNCHLIST N3 (2026-09-22): NO `supersededBy: null` here. Since "A signed revision takes
      // over its invoice" (2026-09-21), a signed root superseded by a still-UNSIGNED revision is
      // still the live invoice — `/invoices` dropped this same filter for the same reason. Kept
      // here it silently paused every balance reminder for the entire window between "revise" and
      // "the revision is signed", which can be indefinite.
      // A change order is not an invoice of its own (2026-09-20): its balance rides its root's
      // reminder, its root's clock, its root's three-strike count. Never a second reminder.
      changeOrderForId: null,
      paymentRemindersSent: { lt: MAX_REMINDERS },
      ...EXCLUDE_TEST_ACCOUNT,
    },
    select: { id: true, number: true, signedAt: true, lastPaymentReminderAt: true, jobVisitId: true },
  });
  const jobVisitIds = [...new Set(candidates.map((c) => c.jobVisitId).filter((id): id is string => !!id))];
  const jobVisits = jobVisitIds.length
    ? await prisma.visit.findMany({ where: { id: { in: jobVisitIds } }, select: { id: true, status: true, completedAt: true } })
    : [];
  const jobVisitById = new Map(jobVisits.map((v) => [v.id, v]));
  const cutoff = Date.now() - QUIET_DAYS * 24 * 3600 * 1000;
  let reminded = 0;
  let skipped = 0;
  for (const est of candidates) {
    // "Final Payment depends on the work being done" (Kyle, 2026-09-19). No
    // job, or a job not yet completed, is never a candidate — never sent.
    const job = est.jobVisitId ? jobVisitById.get(est.jobVisitId) : undefined;
    if (!job || job.status !== "completed" || !job.completedAt) { skipped += 1; continue; }

    // HOMEOWNER balance only (Kyle, 2026-09-10: "the homeowner is never reminded
    // about the warranty share"). paidInFull / balance are the homeowner's
    // figures; the warranty company's open receivable never puts a customer on
    // this list. Pinned by tests/warrantyPayments.test.ts.
    const summary = await paymentSummary(prisma, est.id, "https://unused.invalid");
    if (!summary || summary.paidInFull || summary.balance <= 0.009) continue;
    // FINANCING IN PROGRESS (Kyle, 2026-10-08; services/financingFee.ts): the balance is being
    // paid through Synchrony — the pay link this reminder carries is closed and the money comes
    // when the customer releases it. Chasing them would be the warranty receivable's mistake over
    // again. The office removes the fee (with a reason) if the financing falls through, and the
    // reminders resume on their own.
    if (financingInProgress(summary)) { skipped += 1; continue; }
    const lastPaid = summary.payments
      .filter((pmt) => pmt.status === "paid" && !pmt.voidedAt && pmt.paidAt && pmt.payer !== "warranty")
      .reduce<Date | null>((latest, pmt) => (!latest || pmt.paidAt! > latest ? pmt.paidAt! : latest), null);
    const anchor = Math.max(
      est.signedAt?.getTime() ?? 0,
      lastPaid?.getTime() ?? 0,
      est.lastPaymentReminderAt?.getTime() ?? 0,
      job.completedAt.getTime(),
    );
    if (anchor > cutoff) { skipped += 1; continue; }
    // One invoice that cannot render (its PDF now rides the reminder) must not stop the rest of the
    // sweep, today and every day after (review finding, 2026-10-27).
    try {
      const result = await sendInvoiceReminder(prisma, est.id);
      if (result.ok) reminded += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      logSystemEvent("error", "invoices", `Payment reminder failed for invoice ${est.id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { reminded, skipped };
}
