/**
 * Card refunds, recorded from Stripe — never typed (Kyle, 2026-10-09, ruling 7 of the
 * one-estimating-system plan: "the app listens for Stripe's refund events (charge.refunded) and
 * records the refund itself, so a refunded card payment stops counting as collected").
 *
 * Until this existed a refund made in the Stripe Dashboard never reached the app: the Payment row
 * kept status "paid" and counted as collected on the invoice, the account, the P&L and the job,
 * and `status: "refunded"` in the schema comment had no writer (audited 2026-10-09, Phase 6B).
 *
 * THE RULES
 *   - The refund is MADE in Stripe. There is no button here and must never be one: this module
 *     only RECORDS what Stripe says happened. Void still refuses a Stripe row (paymentVoid.ts).
 *   - Written only by the signature-verified webhook (stripePayments.handleStripeWebhook —
 *     dispatchStripeEvent). An unsigned event never reaches recordRefundsFromCharge.
 *   - IDEMPOTENT ON STRIPE'S REFUND ID: one PaymentRefund row per `re_…`, upserted. The same event
 *     twice, or charge.refunded followed by refund.updated for the same refund, writes nothing
 *     twice and logs nothing twice.
 *   - COLLECTED = amount − refundedAmount, everywhere (collectedOf below). A FULLY refunded row is
 *     also marked status "refunded" so a reader filtering status "paid" drops it outright; a PARTIAL
 *     refund keeps status "paid" with refundedAmount > 0 and every reader subtracts it:
 *     stripePayments.paymentSummary (balance, depositPaid, depositSatisfied, paidInFull — the pay
 *     page, the field payment-info, the scheduling gate, receipts, reminders), lifetimeCollected
 *     (accounts list, account summary, lead funnel), routes/financials.ts yearLedger (the P&L's
 *     collected — a refund is a NEGATIVE collected row in the month it was made — and the CSV),
 *     app.ts GET /invoices, GET /jobs' deposit gate, the warranty-receivable readers, the
 *     void-estimate "refund by hand" list. Bank matching never matched a Stripe row (payouts are
 *     batched), so it needs nothing. The job's card processing fee (jobProcessingCosts.ts) stays a
 *     cost of the job on a refunded payment — Stripe keeps its fee when a charge is refunded.
 *   - A refund for a payment this app does not have (a charge made outside the invoice flow) is
 *     LOGGED as a warning and acknowledged — never a crash, never a retry storm from Stripe.
 *   - Only a SUCCEEDED refund counts. A pending bank refund counts once refund.updated says so;
 *     a failed or canceled one is recorded with that status and comes back off the total.
 *   - ONE RULE, EVERY EVENT: the refunded total is the sum of the succeeded PaymentRefund rows,
 *     whether charge.refunded or a refund.* event arrived, in whatever order Stripe sent them.
 *     A refund Stripe would not name is still a row (the unlisted stand-in, below) so every
 *     reader — the P&L included — reads the same rows. See "ONE RULE FOR THE REFUNDED TOTAL".
 *
 * MATCHING THE PAYMENT. A Payment row names its Checkout Session (cs_…); a charge.refunded event
 * names the charge (ch_…) and its PaymentIntent (pi_…). Rows recorded since 2026-10-09 carry
 * stripePaymentIntentId (the webhook's session object names it) and are matched directly; older
 * rows are matched by asking Stripe which Checkout Session the PaymentIntent belongs to, then
 * backfilled so the next event is a plain lookup.
 */

import type { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";
import { logSystemEvent } from "./systemEvents";
import { sendKyleNotificationEmail } from "./confirmationEmail";
// Static both ways with stripePayments (it imports collectedOf from here): neither module uses
// the other at evaluation time, and a dynamic import here would not be seen by a test's mock of
// the Stripe client.
import { stripe, stripeConfigured } from "./stripePayments";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The one actor that writes a refund: Stripe's signed webhook. */
export const REFUND_ACTOR = "stripe:webhook";

/**
 * What a payment row is still worth: amount − refunded. Every money reader sums THIS, never
 * `amount` alone. Rows written before the column existed read refundedAmount 0 (the default).
 */
export function collectedOf(p: { amount: number; refundedAmount?: number | null }): number {
  return round2(p.amount - (p.refundedAmount ?? 0));
}

/** One refund as the webhook sees it — from a Charge's refund list or a Refund event. */
export interface RefundLike {
  id: string;
  /** Cents, as Stripe gives it. */
  amount: number;
  status: string | null;
  reason: string | null;
  /** Stripe's unix seconds. */
  created: number;
  chargeId: string | null;
  paymentIntentId: string | null;
}

export type RefundRecordResult =
  | { applied: "recorded"; paymentId: string; refundedAmount: number; fullyRefunded: boolean }
  | { applied: "unchanged"; paymentId: string; refundedAmount: number }
  | { applied: "unknown_payment" };

const idOf = (v: string | { id: string } | null | undefined): string | null =>
  typeof v === "string" ? v : v?.id ?? null;

function refundLikeOf(r: Stripe.Refund): RefundLike {
  return {
    id: r.id,
    amount: r.amount,
    status: r.status ?? null,
    reason: r.reason ?? null,
    created: r.created,
    chargeId: idOf(r.charge),
    paymentIntentId: idOf(r.payment_intent),
  };
}

/**
 * The Payment behind a Stripe charge / PaymentIntent, or null. Direct columns first; then Stripe
 * (Checkout Sessions read scope) for a row recorded before the intent was captured.
 */
export async function findPaymentForCharge(
  prisma: PrismaClient,
  keys: { chargeId: string | null; paymentIntentId: string | null },
): Promise<{ id: string; amount: number; status: string; estimateId: string | null; refundedAmount: number; stripeSessionId: string | null; stripeChargeId: string | null; stripePaymentIntentId: string | null } | null> {
  const select = { id: true, amount: true, status: true, estimateId: true, refundedAmount: true, stripeSessionId: true, stripeChargeId: true, stripePaymentIntentId: true } as const;
  if (keys.chargeId) {
    const byCharge = await prisma.payment.findFirst({ where: { stripeChargeId: keys.chargeId, method: "stripe" }, select });
    if (byCharge) return byCharge;
  }
  if (keys.paymentIntentId) {
    const byIntent = await prisma.payment.findFirst({ where: { stripePaymentIntentId: keys.paymentIntentId, method: "stripe" }, select });
    if (byIntent) return byIntent;
    // A row from before the intent was captured: ask Stripe which session the intent belongs to.
    if (stripeConfigured()) {
      try {
        const sessions = await stripe().checkout.sessions.list({ payment_intent: keys.paymentIntentId, limit: 1 });
        const sessionId = sessions.data[0]?.id;
        if (sessionId) {
          const bySession = await prisma.payment.findUnique({ where: { stripeSessionId: sessionId }, select });
          if (bySession) return bySession;
        }
      } catch (err) {
        logSystemEvent("warn", "stripe", "Could not ask Stripe which Checkout Session a refunded PaymentIntent belongs to", {
          paymentIntentId: keys.paymentIntentId, chargeId: keys.chargeId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return null;
}

/**
 * ── ONE RULE FOR THE REFUNDED TOTAL (review findings, 2026-10-09) ────────────────────────────
 *
 * refundedAmount = Σ PaymentRefund rows with status "succeeded". From EVERY event. Until this
 * date charge.refunded wrote the charge's own `amount_refunded` while refund.* events summed the
 * succeeded rows, and the two disagreed whenever a refund was still pending (Stripe raises
 * amount_refunded the moment a refund is CREATED, pending ones included): the total flip-flopped
 * between the two events, a false "Refund reversed" went out, and a stale or retried
 * charge.refunded could LOWER the total and flip a refunded row back to "paid".
 *
 *   - A named refund's status only moves FORWARD (pending → succeeded → failed/canceled is
 *     Stripe's own lifecycle; nothing goes back to pending). A snapshot that arrives late — Stripe
 *     retries an event with the same body, and promises no order — cannot overwrite a later state.
 *   - The charge's `amount_refunded` is used for ONE thing: money the event did not name. When
 *     the endpoint's API version leaves `refunds` off the Charge and the restricted key cannot
 *     list them, the amount is still recorded — as its own row, UNLISTED_REFUND_ID(chargeId),
 *     status "succeeded", dated at the event — so the P&L, the invoice, the account and the job
 *     all read the SAME rows (before this the P&L, which only reads rows, missed that refund
 *     entirely). It holds amount_refunded − Σ(named rows that count toward it: pending or
 *     succeeded), shrinks as named rows arrive (a refund.* event for a refund it stood in for),
 *     and goes away once every dollar is named. It follows only a NEWER charge event (its
 *     refundedAt is that event's own time) — a retried older snapshot leaves it alone.
 *
 * The stand-in is a placeholder for Stripe's own refund ids, not money history: the Payment's
 * event log (payment_refunded events, below) records every change to the total, and the named
 * rows that replace it ARE the history.
 */
const UNLISTED_SUFFIX = ":unlisted";
/** The row that stands in for refunds Stripe would not name on this charge. */
export const UNLISTED_REFUND_ID = (chargeId: string) => `${chargeId}${UNLISTED_SUFFIX}`;
export const isUnlistedRefundId = (stripeRefundId: string) => stripeRefundId.endsWith(UNLISTED_SUFFIX);

/** Stripe's refund lifecycle as an order: a row never moves to a lower rank. */
const STATUS_RANK: Record<string, number> = { pending: 0, requires_action: 0, succeeded: 1, failed: 2, canceled: 2 };
const rankOf = (status: string | null | undefined) => STATUS_RANK[status ?? "succeeded"] ?? 0;
/** Counts toward the charge's amount_refunded: pending or succeeded — Stripe takes it back off on failure. */
const countsOnCharge = (status: string) => rankOf(status) < 2;

/**
 * Apply what Stripe says about one payment's refunds. `amountRefundedCents` is the charge's own
 * cumulative `amount_refunded` when the event carried the charge (null for a refund.* event);
 * `eventCreated` is the event's own unix time, the order the charge's figure is applied in.
 */
async function applyRefunds(
  prisma: PrismaClient,
  payment: NonNullable<Awaited<ReturnType<typeof findPaymentForCharge>>>,
  input: { refunds: RefundLike[]; amountRefundedCents: number | null; eventCreated: number; chargeId: string | null; paymentIntentId: string | null; eventType: string },
): Promise<RefundRecordResult> {
  const result = await prisma.$transaction(async (tx) => {
    // Behind a row lock: two refund events for the same charge can arrive together.
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${payment.id} FOR UPDATE`;
    const current = await tx.payment.findUniqueOrThrow({
      where: { id: payment.id },
      select: { id: true, amount: true, status: true, estimateId: true, refundedAmount: true, refundedAt: true, stripeChargeId: true, stripePaymentIntentId: true },
    });
    const chargeId = current.stripeChargeId ?? input.chargeId ?? null;

    // The NAMED refunds: one row per Stripe id, status forward only.
    let newlyNamedCents = 0;
    for (const r of input.refunds) {
      const status = r.status ?? "succeeded";
      const existing = await tx.paymentRefund.findUnique({ where: { stripeRefundId: r.id }, select: { status: true } });
      if (!existing) {
        await tx.paymentRefund.create({
          data: {
            paymentId: current.id,
            stripeRefundId: r.id,
            stripeChargeId: r.chargeId ?? chargeId,
            amount: round2(r.amount / 100),
            status,
            reason: r.reason,
            refundedAt: new Date(r.created * 1000),
          },
        });
        newlyNamedCents += r.amount;
      } else if (rankOf(status) >= rankOf(existing.status)) {
        await tx.paymentRefund.update({
          where: { stripeRefundId: r.id },
          data: { amount: round2(r.amount / 100), status, reason: r.reason, stripeChargeId: r.chargeId ?? chargeId },
        });
      }
      // else: an older snapshot of a refund already past that state — ignored.
    }

    // The UNLISTED stand-in: only a charge event sizes it; a newly named refund shrinks it.
    if (chargeId) {
      const unlistedId = UNLISTED_REFUND_ID(chargeId);
      const standIn = await tx.paymentRefund.findUnique({ where: { stripeRefundId: unlistedId }, select: { amount: true, refundedAt: true } });
      const eventAt = new Date(input.eventCreated * 1000);
      if (input.amountRefundedCents != null) {
        const stale = standIn != null && standIn.refundedAt.getTime() > eventAt.getTime();
        if (!stale) {
          const named = await tx.paymentRefund.findMany({ where: { paymentId: current.id, NOT: { stripeRefundId: unlistedId } }, select: { amount: true, status: true } });
          const namedOnChargeCents = named.filter((r) => countsOnCharge(r.status)).reduce((s, r) => s + Math.round(r.amount * 100), 0);
          const unlistedCents = input.amountRefundedCents - namedOnChargeCents;
          if (unlistedCents > 0) {
            await tx.paymentRefund.upsert({
              where: { stripeRefundId: unlistedId },
              create: { paymentId: current.id, stripeRefundId: unlistedId, stripeChargeId: chargeId, amount: round2(unlistedCents / 100), status: "succeeded", reason: null, refundedAt: eventAt },
              update: { amount: round2(unlistedCents / 100), status: "succeeded", refundedAt: eventAt },
            });
          } else if (standIn) {
            await tx.paymentRefund.delete({ where: { stripeRefundId: unlistedId } });
          }
        }
      } else if (standIn && newlyNamedCents > 0) {
        const leftCents = Math.round(standIn.amount * 100) - newlyNamedCents;
        if (leftCents > 0) await tx.paymentRefund.update({ where: { stripeRefundId: unlistedId }, data: { amount: round2(leftCents / 100) } });
        else await tx.paymentRefund.delete({ where: { stripeRefundId: unlistedId } });
      }
    }

    const rows = await tx.paymentRefund.findMany({ where: { paymentId: current.id }, orderBy: { refundedAt: "asc" } });
    const succeeded = rows.filter((r) => r.status === "succeeded");
    const refundedAmount = round2(succeeded.reduce((s, r) => s + r.amount, 0));
    const fullyRefunded = refundedAmount >= current.amount - 0.005;
    const status = fullyRefunded ? "refunded" : current.status === "refunded" ? "paid" : current.status;
    const latestAt = succeeded.length > 0 ? succeeded[succeeded.length - 1].refundedAt : null;
    const refundedAt = refundedAmount > 0 ? (latestAt ?? current.refundedAt ?? new Date()) : null;

    // "Changed" means the MONEY changed — the refunded total or the row's status. A pending bank
    // refund, or the same event again, upserts its row and moves nothing: no event, no email.
    const changed = refundedAmount !== current.refundedAmount || status !== current.status;
    const reversed = refundedAmount < current.refundedAmount;

    await tx.payment.update({
      where: { id: current.id },
      data: {
        refundedAmount,
        refundedAt,
        status,
        stripeChargeId: current.stripeChargeId ?? input.chargeId ?? undefined,
        stripePaymentIntentId: current.stripePaymentIntentId ?? input.paymentIntentId ?? undefined,
      },
    });

    if (changed && current.estimateId) {
      const delta = round2(refundedAmount - current.refundedAmount);
      const ids = input.refunds.length > 0 ? ` (${input.refunds.map((r) => r.id).join(", ")})` : "";
      await tx.issuedEstimateEvent.create({
        data: {
          estimateId: current.estimateId,
          type: "payment_refunded",
          actor: REFUND_ACTOR,
          detail: reversed
            ? `A Stripe refund failed or was canceled — $${refundedAmount.toFixed(2)} of the $${current.amount.toFixed(2)} card payment now stands refunded ($${Math.abs(delta).toFixed(2)} back on the invoice)${ids}. Recorded from Stripe's ${input.eventType} event.`
            : `${fullyRefunded ? "Refunded in full" : "Partly refunded"} in Stripe — $${refundedAmount.toFixed(2)} of the $${current.amount.toFixed(2)} card payment${delta > 0 && !fullyRefunded ? ` ($${delta.toFixed(2)} this time)` : ""}${ids}. Recorded from Stripe's ${input.eventType} event.`,
        },
      });
    }
    return { changed, reversed, refundedAmount, fullyRefunded, amount: current.amount, estimateId: current.estimateId, previous: current.refundedAmount };
  });

  if (!result.changed) return { applied: "unchanged", paymentId: payment.id, refundedAmount: result.refundedAmount };

  const est = result.estimateId
    ? await prisma.issuedEstimate.findUnique({ where: { id: result.estimateId }, select: { number: true } })
    : null;
  const label = est ? `invoice ${est.number}` : "a payment with no invoice";
  const headline = result.reversed
    ? `Refund reversed — a Stripe refund failed or was canceled; $${result.refundedAmount.toFixed(2)} of the $${result.amount.toFixed(2)} card payment on ${label} now stands refunded`
    : `Refund recorded — $${result.refundedAmount.toFixed(2)} of the $${result.amount.toFixed(2)} card payment on ${label}${result.fullyRefunded ? " (refunded in full)" : ""}`;
  logSystemEvent("info", "stripe", headline, {
    paymentId: payment.id, estimateId: result.estimateId, refundedAmount: result.refundedAmount, previouslyRefunded: result.previous,
    chargeId: input.chargeId, paymentIntentId: input.paymentIntentId, refundIds: input.refunds.map((r) => r.id), eventType: input.eventType,
  });
  sendKyleNotificationEmail(
    result.reversed ? `Refund reversed: $${result.refundedAmount.toFixed(2)} now refunded` : `Refund recorded: $${result.refundedAmount.toFixed(2)}`,
    `${headline}.\nThe invoice, the account and the P&L count collected as paid minus refunded. The refund itself is made and managed in the Stripe Dashboard; this app only records what Stripe reports.`,
  ).catch(() => {});
  return { applied: "recorded", paymentId: payment.id, refundedAmount: result.refundedAmount, fullyRefunded: result.fullyRefunded };
}

function unknownPayment(input: { eventType: string; chargeId: string | null; paymentIntentId: string | null; amount: number; refundIds: string[] }): RefundRecordResult {
  logSystemEvent("warn", "stripe", `Refund of $${round2(input.amount / 100).toFixed(2)} received from Stripe for a payment this app does not have — nothing recorded`, {
    eventType: input.eventType, chargeId: input.chargeId, paymentIntentId: input.paymentIntentId, refundIds: input.refundIds,
  });
  return { applied: "unknown_payment" };
}

const nowUnix = () => Math.floor(Date.now() / 1000);

/**
 * charge.refunded — fires on every refund of a charge, partial or full. Its `refunds` list carries
 * the ids when the endpoint's API version still includes it, and is fetched from Stripe when it
 * does not; what neither names is recorded from the charge's cumulative `amount_refunded` as the
 * unlisted stand-in row (above). `eventCreated` is the Stripe event's own time — a retried older
 * snapshot must not undo a newer one.
 */
export async function recordRefundsFromCharge(prisma: PrismaClient, charge: Stripe.Charge, eventType = "charge.refunded", eventCreated: number = nowUnix()): Promise<RefundRecordResult> {
  const chargeId = charge.id;
  const paymentIntentId = idOf(charge.payment_intent);
  let refunds: RefundLike[] = (charge.refunds?.data ?? []).map(refundLikeOf);
  if (refunds.length === 0 && (charge.amount_refunded ?? 0) > 0) {
    if (stripeConfigured()) {
      try {
        const listed = await stripe().refunds.list({ charge: chargeId, limit: 100 });
        refunds = listed.data.map(refundLikeOf);
      } catch (err) {
        logSystemEvent("warn", "stripe", "The refunded charge carried no refund list and Stripe would not list its refunds — the amount is recorded without the refund ids", {
          chargeId, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  const payment = await findPaymentForCharge(prisma, { chargeId, paymentIntentId });
  if (!payment) return unknownPayment({ eventType, chargeId, paymentIntentId, amount: charge.amount_refunded ?? 0, refundIds: refunds.map((r) => r.id) });
  return applyRefunds(prisma, payment, { refunds, amountRefundedCents: charge.amount_refunded ?? null, eventCreated, chargeId, paymentIntentId, eventType });
}

/**
 * refund.created / refund.updated / refund.failed / charge.refund.updated — one refund's own
 * lifecycle (a bank refund pends, then succeeds or fails). Recorded by its id, status forward
 * only; the payment's total is the sum of its succeeded rows.
 */
export async function recordRefundEvent(prisma: PrismaClient, refund: Stripe.Refund, eventType: string, eventCreated: number = nowUnix()): Promise<RefundRecordResult> {
  const like = refundLikeOf(refund);
  const payment = await findPaymentForCharge(prisma, { chargeId: like.chargeId, paymentIntentId: like.paymentIntentId });
  if (!payment) return unknownPayment({ eventType, chargeId: like.chargeId, paymentIntentId: like.paymentIntentId, amount: like.amount, refundIds: [like.id] });
  return applyRefunds(prisma, payment, { refunds: [like], amountRefundedCents: null, eventCreated, chargeId: like.chargeId, paymentIntentId: like.paymentIntentId, eventType });
}
