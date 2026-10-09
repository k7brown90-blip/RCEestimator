/**
 * Void a recorded payment — the administrator's exit from a Payment row (Kyle, 2026-10-08,
 * one-estimating-system plan decision 11; Phase 6 Unit 6B).
 *
 *   "Only the administrator can void a recorded payment: CRM only (the PIN session is the
 *    administrator — there are no per-user CRM roles today), NO tech route at all, not even
 *    for a technician with role admin; reason required; row kept, marked void, audit trail."
 *
 * Until this existed NO Payment row could be edited or voided anywhere (the only writers were
 * routes/financials.ts, issuedEstimateService.adoptSupersededInvoice and the Stripe webhook),
 * which broke the standing "nothing the app creates is permanent" rule: a check typed against
 * the wrong invoice, or a deposit keyed twice, was on the books for good.
 *
 * THE RULES
 *   - The row is KEPT and marked (`voidedAt`, `voidedBy`, `voidReason`). Never deleted: the
 *     ledger still shows that it was recorded and then taken back, and by whom.
 *   - A reason is required (1-300 characters) and lands on the row, on the invoice's event
 *     trail (IssuedEstimateEvent "payment_voided", like "terms_changed") and in a SystemEvent.
 *   - A row voided once cannot be voided again.
 *   - A STRIPE row is refused. A card payment is money that moved through Stripe; taking it
 *     back is a REFUND in the Stripe Dashboard (the same manual-refund rule a voided estimate
 *     has always had — app.ts "refund is a manual Stripe Dashboard action"). Since 2026-10-09
 *     (ruling 7, services/paymentRefunds.ts) that refund is RECORDED here by the webhook —
 *     charge.refunded / refund.* — as PaymentRefund rows, refundedAmount on the payment and
 *     status "refunded" when it is all back; marking the row void here would say "no money"
 *     while Stripe still held it, and would double-count against the refund record.
 *   - Only the CRM session reaches this (routes/financials.ts, behind pinAuthMiddleware). The
 *     technician router has no route to it and must never get one — tests/paymentVoid.test.ts
 *     walks the tech router to pin that.
 *
 * EVERY MONEY READER EXCLUDES A VOIDED ROW. The filter is `voidedAt: null` (NOT_VOID below) and
 * lives in: stripePayments.paymentSummary (balance, depositPaid, depositSatisfied, paidInFull —
 * read by the pay page, the field payment-info, the scheduling gate, receipts, reminders),
 * lifetimeCollected.COLLECTED_PAYMENT_WHERE (accounts list, account summary, lead funnel),
 * routes/financials.ts yearLedger (P&L collected + CSV), app.ts GET /invoices, GET /jobs
 * deposit gate, the warranty-receivable readers, the void-estimate "refund by hand" list,
 * officeAcceptance.undo's payment count, bankStatements (a voided payment is never a match
 * for a bank deposit), paymentReceipts (no receipt for a voided row). The commission basis
 * (timeTracking.commissionBasisForJob) reads its REVENUE off the signed estimate, but since
 * Unit 6D it reads Payment rows for the job's FEES — Synchrony's cut (financingCut, voidedAt
 * null) and Stripe's processing fee per card payment — so voiding a Synchrony row removes its
 * cut from the basis and raises the profit (corrected 2026-10-09; the earlier "a void changes
 * nothing there" was stale). Auditing a void's effects must include the commission.
 *
 * A BANK DEPOSIT ALREADY CONFIRMED AGAINST THE ROW (review finding, 2026-10-09): a BankLine
 * classified already_counted / matchedKind "payment" pointing at this payment would otherwise
 * keep saying "already counted as collected" about money that no longer counts anywhere. The
 * void REOPENS that line in the same transaction — back to unclassified, Kyle's own reset (so
 * the rules leave it alone), with a hint naming the voided payment — so the deposit shows up in
 * the bank review queue again to be matched to the replacement payment or classified. The
 * count comes back on the result and the CRM says so beside the voided row.
 */

import type { PrismaClient } from "@prisma/client";
import { logSystemEvent } from "./systemEvents";

/** The `where` fragment every money reader adds. A voided row is not money. */
export const NOT_VOID = { voidedAt: null } as const;

export const VOID_REASON_MAX = 300;

/** The one actor that may void a payment — the CRM PIN session is the administrator. */
export const PAYMENT_VOID_ACTOR = "human:crm-session";

export class PaymentVoidError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "PaymentVoidError";
  }
}

export interface VoidedPayment {
  id: string;
  estimateId: string | null;
  amount: number;
  method: string;
  voidedAt: Date;
  voidedBy: string;
  voidReason: string;
  /** Bank-statement lines that had been confirmed as this payment and were sent back to the review queue (2026-10-09). */
  bankLinesReopened: number;
}

/**
 * Mark one payment void. Throws PaymentVoidError (400 bad reason, 404 no such row, 409 already
 * void / Stripe row). Writes the row, the invoice's audit event (when the row is on an invoice)
 * and a SystemEvent, in that order; the first two in one transaction.
 */
export async function voidPayment(
  prisma: PrismaClient,
  paymentId: string,
  reason: string,
  actor: string = PAYMENT_VOID_ACTOR,
): Promise<VoidedPayment> {
  const why = (reason ?? "").trim();
  if (why.length === 0) throw new PaymentVoidError("Say why this payment is being voided.", 400);
  if (why.length > VOID_REASON_MAX) throw new PaymentVoidError(`Keep the reason under ${VOID_REASON_MAX} characters.`, 400);

  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new PaymentVoidError("Payment not found.", 404);
  if (payment.voidedAt) {
    throw new PaymentVoidError(
      `This payment was already voided on ${payment.voidedAt.toISOString().slice(0, 10)}${payment.voidReason ? ` — ${payment.voidReason}` : ""}.`,
      409,
    );
  }
  if (payment.method === "stripe" || payment.stripeSessionId) {
    throw new PaymentVoidError(
      "A card payment is refunded in Stripe, not voided here — issue the refund from the Stripe Dashboard; this row stays as the record of the charge.",
      409,
    );
  }

  const est = payment.estimateId
    ? await prisma.issuedEstimate.findUnique({ where: { id: payment.estimateId }, select: { id: true, number: true } })
    : null;
  const now = new Date();
  const label = `$${payment.amount.toFixed(2)} ${payment.method}${payment.checkNumber ? ` #${payment.checkNumber}` : ""}` +
    `${payment.payer === "warranty" ? " (warranty company)" : ""}${payment.kind !== "other" ? ` ${payment.kind}` : ""}` +
    `${payment.paidAt ? ` received ${payment.paidAt.toISOString().slice(0, 10)}` : ""}`;

  const { row, bankLinesReopened } = await prisma.$transaction(async (tx) => {
    // CONDITIONAL WRITE (review finding, 2026-10-09): the already-void check above ran outside
    // this transaction, so two voids racing each other (a double submit, a retry, two tabs) would
    // both pass it and the second would overwrite the first one's reason and time. Writing only
    // where voidedAt is still null makes the second one update nothing — and it is told so.
    const updated = await tx.payment.updateMany({
      where: { id: payment.id, voidedAt: null },
      data: { voidedAt: now, voidedBy: actor, voidReason: why },
    });
    if (updated.count === 0) throw new PaymentVoidError("This payment was already voided.", 409);
    // A bank deposit confirmed as this payment goes back to the review queue (header).
    const reopened = await tx.bankLine.updateMany({
      where: { matchedKind: "payment", matchedId: payment.id, classification: "already_counted" },
      data: {
        classification: "unclassified",
        category: null,
        transferKind: null,
        counterpartyAccountId: null,
        matchedKind: null,
        matchedId: null,
        matchedMonth: null,
        reason: null,
        hint: `This deposit had been confirmed as the ${label} payment, which was voided on ${now.toISOString().slice(0, 10)} (${why}). Match it to the replacement payment, or classify it.`,
        classifiedBy: "owner",
        classifiedAt: now,
      },
    });
    if (est) {
      await tx.issuedEstimateEvent.create({
        data: {
          estimateId: est.id,
          type: "payment_voided",
          actor,
          detail: `Payment voided — ${label}: ${why}${reopened.count > 0 ? ` (${reopened.count} bank deposit line${reopened.count > 1 ? "s" : ""} sent back to the bank review queue)` : ""}`,
        },
      });
    }
    const after = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    return { row: after, bankLinesReopened: reopened.count };
  });

  logSystemEvent(
    "warn",
    "financials",
    `Payment voided — ${label}${est ? ` on ${est.number}` : " (not against an invoice)"}: ${why}${bankLinesReopened > 0 ? ` — ${bankLinesReopened} bank deposit line(s) reopened for review` : ""}`,
    { paymentId: payment.id, estimateId: est?.id ?? null, amount: payment.amount, method: payment.method, actor, bankLinesReopened },
  );

  return {
    id: row.id,
    estimateId: row.estimateId,
    amount: row.amount,
    method: row.method,
    voidedAt: row.voidedAt!,
    voidedBy: row.voidedBy!,
    voidReason: row.voidReason!,
    bankLinesReopened,
  };
}
