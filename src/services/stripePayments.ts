/**
 * Stripe payments — the "Pay online" path on invoices. (Kyle, 2026-08-25:
 * "I need to get a payment processor set up that we can integrate here." His
 * pick: Stripe.)
 *
 * Shape of the integration, per Stripe's own current guidance (the
 * stripe-best-practices skill, API 2026-07-29.dahlia):
 *
 * - CHECKOUT SESSIONS, created ON DEMAND. The invoice email carries a link to
 *   OUR /pay/:token route, never a raw session URL — sessions expire in 24h,
 *   emails live for years. The route mints a fresh session per click and
 *   redirects.
 * - NO payment_method_types anywhere: dynamic payment methods let the
 *   Dashboard decide what to offer (cards, ACH, …) and rank them.
 * - FULFILLMENT LIVES IN THE WEBHOOK, not the success page. Both
 *   checkout.session.completed and checkout.session.async_payment_succeeded
 *   are handled, gated on payment_status !== 'unpaid' — ACH-style methods
 *   complete the session days before the money clears. Signature verified.
 * - AUTOMATIC TAX is gated behind STRIPE_AUTOMATIC_TAX=1 and OFF by default:
 *   enabling it without an active TN registration in the Dashboard silently
 *   collects zero tax while looking on. Kyle flips it after registering
 *   (Dashboard → Tax → set head office + add the Tennessee registration).
 * - The key lives in a Railway env var (STRIPE_SECRET_KEY), never in code.
 *   When it is absent every surface simply hides the pay option.
 *
 * The amount charged is the signed invoice's billed total — taken options +
 * trip − frozen discounts — the same arithmetic the invoice PDF prints.
 */

import Stripe from "stripe";
import type { PrismaClient } from "@prisma/client";
import { logSystemEvent } from "./systemEvents";
import { sendKyleNotificationEmail } from "./confirmationEmail";

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

let client: Stripe | null = null;
function stripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set.");
    client = new Stripe(key);
  }
  return client;
}

/** Taken options + trip − combo − discount: the invoice arithmetic, one place. */
export function billedTotalOf(est: {
  total: number;
  tripCharge: number;
  selectedOptions: string[];
  comboCapJson: string | null;
  discountJson: string | null;
  optionsSubtotals: { option: string; subtotal: number }[];
}): number {
  if (est.selectedOptions.length === 0) return est.total;
  const taken = new Set(est.selectedOptions);
  const subtotals = est.optionsSubtotals
    .filter((o) => taken.has(o.option))
    .reduce((n, o) => n + o.subtotal, 0);
  const combo = est.comboCapJson
    ? (JSON.parse(est.comboCapJson) as { applied: boolean; reduction: number })
    : null;
  const disc = est.discountJson ? ((JSON.parse(est.discountJson) as { amount: number }).amount ?? 0) : 0;
  return Math.round((subtotals + est.tripCharge - (combo?.applied ? combo.reduction : 0) - disc) * 100) / 100;
}

const randomSuffix = () =>
  Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The ⅓ deposit (Kyle, 2026-08-25: "a 1/3 deposit on every job. Deposit
 * required before it can be scheduled. This is different from estimates.").
 *
 * His rulings, same day: exact third rounded to the cent; every job, no
 * small-job floor; change orders carry their own ⅓ (each signed estimate —
 * original or change order — computes its own deposit); and deposits are
 * NON-REFUNDABLE UP TO $300 — "a $1200 deposit will refund $900, the $300 is
 * kept for labor and processing." The keep amount is disclosed on the payment
 * page (below); refunds themselves run through the Stripe Dashboard.
 */
export const DEPOSIT_NONREFUNDABLE_CAP = 300;

/**
 * The NON-CARD DISCOUNT (reframed on Kyle's ruling, 2026-08-25): "the
 * additional 3% is charged regardless, checks, cash, zelle, save 3%. To be
 * legal it cannot be seen as a punishment for using a card but that does not
 * mean there can't be a reward for other forms of payment."
 *
 * So: the INVOICE TOTAL IS THE CARD PRICE. A card pays it in full, no fee
 * line, nothing added. Every other method — bank transfer, cash, check,
 * Zelle — earns a 3% DISCOUNT off what's due, recorded as its own visible
 * Payment row (method "discount") so the invoice still closes to exactly
 * zero and the books show real money and reward separately. A discount rows
 * counts toward the balance and the deposit gate, but never toward
 * "collected" in the financials — it isn't money, it's a thank-you.
 */
export const NONCARD_DISCOUNT_PCT = 0.03;

export function depositDueOf(billedTotal: number): number {
  return round2(billedTotal / 3);
}

/** What a cancelled job keeps from a paid deposit, per the $300 cap. */
export function depositKeptOnCancel(depositPaid: number): number {
  return round2(Math.min(depositPaid, DEPOSIT_NONREFUNDABLE_CAP));
}

export interface PaymentSummary {
  estimateId: string;
  number: string;
  billedTotal: number;
  depositDue: number;
  /** Paid rows only. */
  depositPaid: number;
  totalPaid: number;
  balance: number;
  depositSatisfied: boolean;
  paidInFull: boolean;
  payUrl: string;        // balance
  depositPayUrl: string; // deposit
  payments: { id: string; amount: number; method: string; kind: string; status: string; paidAt: Date | null }[];
}

/** One place that answers "where does the money on this estimate stand?" */
export async function paymentSummary(
  prisma: PrismaClient,
  estimateId: string,
  origin: string,
): Promise<PaymentSummary | null> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    include: { options: true },
  });
  if (!est) return null;

  const billedTotal = billedTotalOf({
    total: est.total,
    tripCharge: est.tripCharge,
    selectedOptions: est.selectedOptions,
    comboCapJson: est.comboCapJson,
    discountJson: est.discountJson,
    optionsSubtotals: est.options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
  });
  const payments = await prisma.payment.findMany({
    where: { estimateId },
    orderBy: { createdAt: "desc" },
  });
  const paid = payments.filter((p) => p.status === "paid");
  const totalPaid = round2(paid.reduce((s, p) => s + p.amount, 0));
  const depositPaid = round2(paid.filter((p) => p.kind === "deposit").reduce((s, p) => s + p.amount, 0));
  const depositDue = depositDueOf(billedTotal);

  return {
    estimateId: est.id,
    number: est.number,
    billedTotal,
    depositDue,
    depositPaid,
    totalPaid,
    balance: round2(billedTotal - totalPaid),
    // Any money at or past the deposit satisfies the gate — a customer who paid
    // in full up front did not fail to pay a deposit.
    depositSatisfied: totalPaid >= depositDue - 0.01,
    paidInFull: totalPaid >= billedTotal - 0.01,
    payUrl: `${origin}/pay/${est.token}`,
    depositPayUrl: `${origin}/pay/${est.token}?type=deposit`,
    payments: payments.map((p) => ({
      id: p.id, amount: p.amount, method: p.method, kind: p.kind, status: p.status, paidAt: p.paidAt,
    })),
  };
}

/**
 * Mint a Checkout Session for a SIGNED estimate's billed total.
 * Returns the session URL to redirect the customer to.
 */
/** What's chargeable right now on this token, for the chooser page. */
export async function chargeableAmount(
  prisma: PrismaClient,
  estimateToken: string,
  payType: "balance" | "deposit",
): Promise<
  // amount = the invoice (card) price due. discount/discounted = the 3%
  // non-card reward and the resulting bank/cash/check/Zelle price.
  | { ok: true; estimateId: string; number: string; title: string; amount: number; discount: number; discounted: number }
  | { ok: false; reason: string }
> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { token: estimateToken },
    select: { id: true, signedAt: true, status: true, title: true },
  });
  if (!est) return { ok: false, reason: "Invoice not found." };
  if (!est.signedAt) return { ok: false, reason: "This estimate has not been signed yet." };
  if (est.status === "void") return { ok: false, reason: "This invoice is void." };

  const summary = (await paymentSummary(prisma, est.id, "https://unused.invalid"))!;
  if (summary.paidInFull) return { ok: false, reason: "This invoice has already been paid — thank you!" };
  if (payType === "deposit" && summary.depositSatisfied) {
    return { ok: false, reason: "The deposit on this job has already been paid — thank you!" };
  }
  const amount = payType === "deposit"
    ? round2(Math.min(summary.depositDue - summary.depositPaid, summary.balance))
    : summary.balance;
  if (!(amount > 0)) return { ok: false, reason: "Nothing is due on this invoice." };
  const discounted = round2(amount * (1 - NONCARD_DISCOUNT_PCT));
  return {
    ok: true,
    estimateId: est.id,
    number: summary.number,
    title: est.title,
    amount,
    // Exact complement, so payment + discount always sums to precisely the due.
    discount: round2(amount - discounted),
    discounted,
  };
}

export async function createInvoiceCheckoutSession(
  prisma: PrismaClient,
  estimateToken: string,
  origin: string,
  // "deposit" charges the ⅓ down (less any deposit already paid); "balance"
  // charges what remains after every paid row. (Kyle, 2026-08-25.)
  payType: "balance" | "deposit" = "balance",
  // bank = ACH only, no fee; card = card only, +3% as its own line item.
  method: "bank" | "card" = "card",
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  if (!stripeConfigured()) return { ok: false, reason: "Online payment is not configured." };

  const chargeable = await chargeableAmount(prisma, estimateToken, payType);
  if (!chargeable.ok) return chargeable;

  const full = await prisma.issuedEstimate.findUnique({ where: { id: chargeable.estimateId } });
  // Card pays the invoice price. Bank pays the discounted price, and the 3%
  // reward becomes its own recorded discount row via webhook metadata.
  const charged = method === "bank" ? chargeable.discounted : chargeable.amount;
  const discountApplied = method === "bank" ? chargeable.discount : 0;

  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(charged * 100),
          product_data: {
            name: payType === "deposit"
              ? `Deposit (1/3) — Invoice ${chargeable.number}: ${full!.title}`
              : `Invoice ${chargeable.number} — ${full!.title}`,
            // The non-refundable term is DISCLOSED where the card is entered —
            // a kept deposit the customer never saw coming is a chargeback.
            description: [
              discountApplied > 0 ? `3% non-card discount applied (−$${discountApplied.toFixed(2)}).` : null,
              payType === "deposit"
                ? `${full!.serviceAddress ?? ""} — Deposits are non-refundable up to $${DEPOSIT_NONREFUNDABLE_CAP} if the job is cancelled.`.trim()
                : full!.serviceAddress ?? null,
            ].filter(Boolean).join(" ") || undefined,
          },
        },
      },
    ],
    customer_email: full!.customerEmail ?? undefined,
    // Method steering via EXCLUSION, per Stripe's own guidance — never
    // payment_method_types. Bank hides card; card hides the bank rail.
    // ("link" is not an excludable type — live Stripe rejected it on go-live day.)
    excluded_payment_method_types: (method === "bank"
      ? ["card"]
      : ["us_bank_account"]) as Stripe.Checkout.SessionCreateParams.ExcludedPaymentMethodType[],
    // Fulfillment keys off these in the webhook — never trust the success page.
    metadata: {
      estimateId: chargeable.estimateId,
      estimateNumber: chargeable.number,
      customerId: full!.customerId,
      visitId: full!.jobVisitId ?? "",
      kind: payType === "deposit" ? "deposit" : "final",
      // The money actually moving. The discount rides separately so the
      // webhook can record both and the invoice closes to exactly zero.
      baseAmount: String(charged),
      discountAmount: String(discountApplied),
    },
    // NO SALES TAX — Kyle, 2026-08-25: "I don't charge sales tax, its a
    // service business." The TN contractor posture: tax is paid on materials
    // at purchase; the customer's invoice carries none. The automatic_tax
    // gate that used to sit here is deliberately gone, not just off.
    integration_identifier: `rce-invoice-${randomSuffix()}`,
    success_url: `${origin}/e/${full!.token}?paid=1`,
    cancel_url: `${origin}/e/${full!.token}`,
  } as Stripe.Checkout.SessionCreateParams);

  if (!session.url) return { ok: false, reason: "Stripe did not return a checkout URL." };
  return { ok: true, url: session.url };
}

/**
 * Webhook fulfillment. Verifies the signature against the RAW request body,
 * then records the payment idempotently (session id is unique on Payment).
 */
export async function handleStripeWebhook(
  prisma: PrismaClient,
  rawBody: Buffer,
  signature: string,
): Promise<{ received: true } | { received: false; reason: string }> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { received: false, reason: "STRIPE_WEBHOOK_SECRET is not set." };

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    logSystemEvent("warn", "stripe", "Webhook signature verification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { received: false, reason: "Invalid signature." };
  }

  const recordPaid = async (session: Stripe.Checkout.Session) => {
    // Delayed-notification methods complete the session while still unpaid —
    // record only when the money is actually in flight or landed.
    if (session.payment_status === "unpaid") return;
    const estimateId = session.metadata?.estimateId ?? null;
    // The money that actually moved (the discount rides as its own row below).
    const base = Number(session.metadata?.baseAmount);
    const amount = Number.isFinite(base) && base > 0 ? base : (session.amount_total ?? 0) / 100;
    // Receipt goes out only on the FIRST paid recording — Stripe retries and
    // duplicate events must not re-email the customer.
    const existed = await prisma.payment.findUnique({
      where: { stripeSessionId: session.id },
      select: { id: true, status: true },
    });
    const firstPaidRecording = !existed || existed.status !== "paid";
    await prisma.payment.upsert({
      where: { stripeSessionId: session.id },
      create: {
        stripeSessionId: session.id,
        estimateId,
        customerId: session.metadata?.customerId || null,
        visitId: session.metadata?.visitId || null,
        amount,
        method: "stripe",
        kind: session.metadata?.kind === "deposit" ? "deposit" : "final",
        status: "paid",
        paidAt: new Date(),
      },
      update: { status: "paid", paidAt: new Date(), amount },
    });
    logSystemEvent("info", "stripe", `Payment received — $${amount.toFixed(2)} on invoice ${session.metadata?.estimateNumber ?? "?"}`, {
      sessionId: session.id,
      estimateId,
    });
    sendKyleNotificationEmail(
      `Payment received: $${amount.toFixed(2)}`,
      `Invoice ${session.metadata?.estimateNumber ?? "?"} was paid online via Stripe.\nAmount: $${amount.toFixed(2)}\nSession: ${session.id}`,
    ).catch(() => {});
    // The 3% non-card reward (Kyle's ruling): a bank payment carries its
    // discount as its own row, so the balance closes to zero and the books
    // show money and reward separately. First recording only.
    const discountAmt = Number(session.metadata?.discountAmount);
    if (firstPaidRecording && Number.isFinite(discountAmt) && discountAmt > 0) {
      await prisma.payment.create({
        data: {
          estimateId,
          customerId: session.metadata?.customerId || null,
          visitId: session.metadata?.visitId || null,
          amount: discountAmt,
          method: "discount",
          kind: session.metadata?.kind === "deposit" ? "deposit" : "final",
          status: "paid",
          paidAt: new Date(),
          note: `3% non-card discount (bank transfer, session ${session.id})`,
        },
      });
    }

    // The customer's receipt (Kyle, 2026-08-25: "final receipts to email that
    // show something is paid"). Fire-and-forget — the payment is already durable.
    if (firstPaidRecording) {
      const row = await prisma.payment.findUnique({ where: { stripeSessionId: session.id }, select: { id: true } });
      if (row) {
        const { sendPaymentReceiptEmail } = await import("./paymentReceipts");
        sendPaymentReceiptEmail(prisma, row.id).catch((err) =>
          console.error("[stripe] receipt email failed:", err));
      }
    }
  };

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await recordPaid(event.data.object as Stripe.Checkout.Session);
      break;
    case "checkout.session.async_payment_failed": {
      const session = event.data.object as Stripe.Checkout.Session;
      await prisma.payment.upsert({
        where: { stripeSessionId: session.id },
        create: {
          stripeSessionId: session.id,
          estimateId: session.metadata?.estimateId ?? null,
          customerId: session.metadata?.customerId || null,
          visitId: session.metadata?.visitId || null,
          amount: (session.amount_total ?? 0) / 100,
          method: "stripe",
          status: "failed",
        },
        update: { status: "failed" },
      });
      logSystemEvent("warn", "stripe", `Async payment FAILED on invoice ${session.metadata?.estimateNumber ?? "?"}`, {
        sessionId: session.id,
      });
      break;
    }
    default:
      // Unhandled event types are acknowledged, not errored — Stripe retries errors.
      break;
  }
  return { received: true };
}
