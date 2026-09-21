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
/** The one Stripe client. Exported for the Issuing/Treasury reads in services/cardSpend.ts. */
export function stripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set.");
    client = new Stripe(key);
  }
  return client;
}

/**
 * A home-warranty company paying PART of an estimate (Kyle, 2026-09-09: "The
 * warranty company is covering $370 of this bill. I need to get a signature
 * from the home owner first to clarify they owe the remainder and be able to
 * show on the invoice sent to her that the warranty is covering what ever
 * their chosen amount is with the claim number.").
 *
 * The homeowner is the customer of record and signs; the warranty company is a
 * SECOND PAYER. This is the record the credit is generated from — it is never
 * typed as a discount. Stored as IssuedEstimate.warrantyJson.
 */
export interface WarrantyClaim {
  company: string;
  claimNumber: string;
  authNumber: string | null;
  coveredAmount: number;
  note: string | null;
  /** ISO timestamp of when the claim was recorded on the estimate. */
  setAt: string;
  /*
    Receivable tracking (Kyle, 2026-09-10: "Patricia's warranty portion of the
    job is not getting tracked and doesn't have a system to record its payment
    to that job when that check comes in"). The warranty share is a RECEIVABLE
    with dates: submitted to the company, expected (submitted + 45 days per
    RELY's agreement), approved, check received, check deposited. Chased
    separately from the homeowner, who is never reminded about it. Bookkeeping
    only — never the price — so these move after signing, each move with a
    reason on the trail. Written only through the tracking route and the
    warranty-payment route; absent on claims recorded before 2026-09-10.
  */
  submittedAt: string | null;
  expectedAt: string | null;
  approvedAt: string | null;
  receivedAt: string | null;
  depositedAt: string | null;
  checkNumber: string | null;
  events: WarrantyClaimEvent[];
}

/** One line of the claim's trail — who moved what, when, and why. */
export interface WarrantyClaimEvent {
  at: string;
  actor: string;
  /** "tracking" | "payment" | … */
  kind: string;
  /** Kyle's stated reason, verbatim. */
  reason?: string;
  /** What moved — "submittedAt — → 2026-09-10; expectedAt — → 2026-10-25". */
  detail?: string;
}

/** The days RELY's service-provider agreement allows before a submitted claim is due. */
export const WARRANTY_EXPECTED_DAYS = 45;

const isoOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() && !Number.isNaN(Date.parse(v)) ? v : null;

/** Tolerant parse — a malformed column must never take down an invoice. */
export function parseWarrantyJson(json: string | null | undefined): WarrantyClaim | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Partial<WarrantyClaim>;
    if (!raw || typeof raw.claimNumber !== "string" || typeof raw.coveredAmount !== "number") return null;
    if (!Number.isFinite(raw.coveredAmount) || raw.coveredAmount <= 0) return null;
    return {
      company: typeof raw.company === "string" && raw.company.trim() ? raw.company : "RELY Home",
      claimNumber: raw.claimNumber,
      authNumber: typeof raw.authNumber === "string" && raw.authNumber.trim() ? raw.authNumber : null,
      coveredAmount: Math.round(raw.coveredAmount * 100) / 100,
      note: typeof raw.note === "string" && raw.note.trim() ? raw.note : null,
      setAt: typeof raw.setAt === "string" ? raw.setAt : "",
      submittedAt: isoOrNull(raw.submittedAt),
      expectedAt: isoOrNull(raw.expectedAt),
      approvedAt: isoOrNull(raw.approvedAt),
      receivedAt: isoOrNull(raw.receivedAt),
      depositedAt: isoOrNull(raw.depositedAt),
      checkNumber: typeof raw.checkNumber === "string" && raw.checkNumber.trim() ? raw.checkNumber.trim() : null,
      events: Array.isArray(raw.events)
        ? raw.events
          .filter((e): e is WarrantyClaimEvent =>
            Boolean(e) && typeof e === "object" && typeof (e as WarrantyClaimEvent).at === "string" && typeof (e as WarrantyClaimEvent).kind === "string")
          .map((e) => ({
            at: e.at,
            actor: typeof e.actor === "string" ? e.actor : "unknown",
            kind: e.kind,
            ...(typeof e.reason === "string" && e.reason.trim() ? { reason: e.reason } : {}),
            ...(typeof e.detail === "string" && e.detail.trim() ? { detail: e.detail } : {}),
          }))
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Where a warranty receivable stands (Kyle, 2026-09-10). "overdue" = the
 * expected date has passed and money is still owed; "paid" wins over everything.
 */
export type WarrantyReceivableStatus = "not submitted" | "submitted" | "overdue" | "paid";

export function warrantyReceivableStatus(
  claim: Pick<WarrantyClaim, "submittedAt" | "expectedAt">,
  balance: number,
  now: Date = new Date(),
): WarrantyReceivableStatus {
  if (balance <= 0.01) return "paid";
  if (!claim.submittedAt) return "not submitted";
  if (claim.expectedAt && Date.parse(claim.expectedAt) < now.getTime()) return "overdue";
  return "submitted";
}

export interface BilledTotalInput {
  total: number;
  tripCharge: number;
  selectedOptions: string[];
  comboCapJson: string | null;
  discountJson: string | null;
  /** Optional so every historical caller keeps compiling; absent means no coverage. */
  warrantyJson?: string | null;
  optionsSubtotals: { option: string; subtotal: number }[];
}

/**
 * Taken options + trip − combo − discount, BEFORE any warranty coverage: what
 * the work bills in total, across both payers. This is the figure a warranty
 * claim is capped against.
 */
export function preCoverageTotalOf(est: BilledTotalInput): number {
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

/**
 * What the JOB EARNS in total — homeowner share + warranty share (Kyle,
 * 2026-09-10: the job earned $425 on Option A, $370 of it from RELY). This is
 * the revenue rung for job costing, the account summary, and job
 * profitability. The invoice, deposit, and balance surfaces stay on
 * billedTotalOf (the homeowner share); the warranty share is its own receivable.
 */
export function fullBillOf(est: BilledTotalInput): number {
  return preCoverageTotalOf(est);
}

/**
 * What the warranty company is actually credited on this estimate: the
 * recorded coverage, capped at the pre-coverage total (a claim can never
 * cover more than the bill). Null when no claim is recorded.
 */
export function warrantyCoverageOf(est: BilledTotalInput): { applied: number; claim: WarrantyClaim } | null {
  const claim = parseWarrantyJson(est.warrantyJson);
  if (!claim) return null;
  const pre = preCoverageTotalOf(est);
  const applied = Math.round(Math.max(0, Math.min(claim.coveredAmount, pre)) * 100) / 100;
  return { applied, claim };
}

/**
 * Taken options + trip − combo − discount − warranty coverage: the invoice
 * arithmetic, one place. With a warranty claim on the row this is the
 * HOMEOWNER SHARE — the deposit (⅓) and balance divide this number, which is
 * the intended behaviour (Kyle, 2026-09-09: the homeowner signs for, and owes,
 * the remainder). Never below zero.
 */
export function billedTotalOf(est: BilledTotalInput): number {
  const pre = preCoverageTotalOf(est);
  const coverage = warrantyCoverageOf(est);
  if (!coverage) return pre;
  return Math.round(Math.max(0, pre - coverage.applied) * 100) / 100;
}

/** The frozen arithmetic inputs of one issued row. */
function moneyOfRow(row: {
  total: number; tripCharge: number; selectedOptions: string[]; comboCapJson: string | null;
  discountJson: string | null; warrantyJson: string | null; options: { option: string; subtotal: number }[];
}): BilledTotalInput {
  return {
    total: row.total,
    tripCharge: row.tripCharge,
    selectedOptions: row.selectedOptions,
    comboCapJson: row.comboCapJson,
    discountJson: row.discountJson,
    warrantyJson: row.warrantyJson,
    optionsSubtotals: row.options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
  };
}

const randomSuffix = () =>
  Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The ⅓ deposit (Kyle, 2026-08-25: "a 1/3 deposit on every job. Deposit
 * required before it can be scheduled. This is different from estimates.").
 *
 * His rulings, same day: exact third rounded to the cent; every job, no
 * small-job floor; and deposits are NON-REFUNDABLE UP TO $300 — "a $1200
 * deposit will refund $900, the $300 is kept for labor and processing." The
 * keep amount is disclosed on the payment page (below); refunds themselves run
 * through the Stripe Dashboard.
 *
 * SUPERSEDED 2026-09-20 (Kyle, after the Godwin job): "change orders carry
 * their own ⅓" is gone. The deposit is OPTIONAL per document
 * (IssuedEstimate.depositRequired — on by default for an estimate, OFF for a
 * change order) and is ⅓ of the homeowner shares of the documents that
 * require one, across the whole invoice group (services/invoiceGroup.ts). The
 * cap and the deposit emails apply only when a deposit is actually due.
 */
export const DEPOSIT_NONREFUNDABLE_CAP = 300;

/**
 * ONE PRICE, EVERY METHOD (Kyle, 2026-08-30: "keep it straight to the invoice
 * amount, no check or cash discount"). Card, bank transfer, cash, check, and
 * Zelle all pay exactly what the invoice says — no card fee, no non-card
 * reward. The 3% non-card discount that ran 2026-08-25 → 08-30 is retired;
 * the only trace left is that paymentSummary/financials still tolerate the
 * legacy Payment rows it wrote (method "discount") so those invoices keep
 * closing to zero and "collected" stays real money only.
 */

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
  /**
   * The HOMEOWNER share — coverage already off — of the WHOLE INVOICE: the root
   * estimate plus every signed, live change order on it (Kyle, 2026-09-20).
   */
  billedTotal: number;
  /** ⅓ of the shares that require a deposit; 0 when none does. */
  depositDue: number;
  /** Some document on this invoice requires a deposit (depositDue > 0). */
  depositRequired: boolean;
  /**
   * The documents the invoice is made of — the root first, then its signed
   * change orders — each with its own frozen billed share. What every
   * "the invoice" surface lists beneath the total.
   */
  documents: {
    id: string; number: string; revision: number; title: string;
    kind: "invoice" | "change_order"; signedAt: Date | null;
    billedTotal: number; depositRequired: boolean;
  }[];
  /** Paid rows only — customer (homeowner) rows. */
  depositPaid: number;
  /** Homeowner money only (payer "customer"); a warranty check never lands here. */
  totalPaid: number;
  /** The homeowner's balance. */
  balance: number;
  depositSatisfied: boolean;
  /** The HOMEOWNER is paid up (balance ≤ $0.01). The warranty share may still be open. */
  paidInFull: boolean;
  /** Both payers are paid up — the homeowner AND the warranty company (Kyle, 2026-09-10). */
  fullyPaid: boolean;
  payUrl: string;        // balance
  depositPayUrl: string; // deposit
  payments: {
    id: string; amount: number; method: string; kind: string; status: string; paidAt: Date | null;
    /** "customer" | "warranty" (Kyle, 2026-09-10). */
    payer: string;
    checkNumber: string | null;
  }[];
  /**
   * Home-warranty coverage (Kyle, 2026-09-09). `warrantyCovered` is what the
   * warranty company is credited — already subtracted from `billedTotal`, which
   * is therefore the homeowner share. Zero / null when no claim is recorded.
   */
  warrantyCovered: number;
  warrantyClaim: { company: string; claimNumber: string; authNumber: string | null } | null;
  /**
   * The warranty company's side of the account (Kyle, 2026-09-10: "one
   * account, two payers"): what it owes, what it has paid (payer "warranty"
   * rows), what remains, and the claim with its tracking dates. Null when no
   * claim is recorded.
   */
  warranty: { covered: number; paid: number; balance: number; claim: WarrantyClaim } | null;
}

/**
 * Split paid rows by payer (Kyle, 2026-09-10). Rows written before the column
 * existed default to "customer"; legacy "discount" rows stay on the homeowner
 * side where they have always closed balances.
 */
export function splitPaidByPayer<T extends { amount: number; payer?: string | null }>(paid: T[]): {
  customer: T[];
  warranty: T[];
  customerPaid: number;
  warrantyPaid: number;
} {
  const customer = paid.filter((p) => p.payer !== "warranty");
  const warranty = paid.filter((p) => p.payer === "warranty");
  return {
    customer,
    warranty,
    customerPaid: round2(customer.reduce((s, p) => s + p.amount, 0)),
    warrantyPaid: round2(warranty.reduce((s, p) => s + p.amount, 0)),
  };
}

/**
 * One place that answers "where does the money on this INVOICE stand?"
 *
 * Since 2026-09-20 the invoice is the GROUP: the root estimate plus every signed, live change
 * order pointing at it (services/invoiceGroup.ts). Asked about a change order's id, this
 * answers about its root — `estimateId`, `number` and the pay links in the result are the
 * ROOT's, because a change order has no invoice, deposit or pay link of its own any more.
 */
export async function paymentSummary(
  prisma: PrismaClient,
  estimateId: string,
  origin: string,
): Promise<PaymentSummary | null> {
  // Dynamic: invoiceGroup imports the arithmetic from this module.
  const { loadInvoiceGroup } = await import("./invoiceGroup");
  const group = await loadInvoiceGroup(prisma, estimateId);
  if (!group) return null;
  const est = group.root;

  // The homeowner share of the whole invoice: coverage already off, every
  // live document summed. The ⅓ is a third of the shares that REQUIRE a
  // deposit (depositBase), not of the whole job — and zero when none does.
  const billedTotal = group.billedTotal;
  const rootCoverage = warrantyCoverageOf(moneyOfRow(est));
  const coverage = group.warrantyCovered > 0
    ? { applied: group.warrantyCovered, claim: rootCoverage?.claim ?? group.documents.find((d) => d.warrantyClaim)!.warrantyClaim! }
    : null;
  const payments = await prisma.payment.findMany({
    where: { estimateId: { in: group.ids } },
    orderBy: { createdAt: "desc" },
  });
  const paid = payments.filter((p) => p.status === "paid");
  // Two payers, two ledgers (Kyle, 2026-09-10): the homeowner's money closes
  // the homeowner share; the warranty company's money closes the covered
  // amount. Neither ever reduces the other's balance.
  const split = splitPaidByPayer(paid);
  const totalPaid = split.customerPaid;
  const depositPaid = round2(split.customer.filter((p) => p.kind === "deposit").reduce((s, p) => s + p.amount, 0));
  const depositDue = group.depositDue;
  const homeownerBalance = round2(billedTotal - totalPaid);
  const warranty = coverage
    ? {
      covered: coverage.applied,
      paid: split.warrantyPaid,
      balance: round2(coverage.applied - split.warrantyPaid),
      claim: coverage.claim,
    }
    : null;

  return {
    estimateId: est.id,
    number: est.number,
    billedTotal,
    depositDue,
    depositRequired: group.depositRequired,
    documents: group.documents.map((d) => ({
      id: d.id, number: d.number, revision: d.revision, title: d.title, kind: d.kind,
      signedAt: d.signedAt, billedTotal: d.billedTotal, depositRequired: d.depositRequired,
    })),
    depositPaid,
    totalPaid,
    balance: homeownerBalance,
    // Any money at or past the deposit satisfies the gate — a customer who paid
    // in full up front did not fail to pay a deposit. No deposit required
    // (depositDue 0) satisfies it outright: nothing gates scheduling.
    depositSatisfied: totalPaid >= depositDue - 0.01,
    paidInFull: homeownerBalance <= 0.01,
    fullyPaid: homeownerBalance <= 0.01 && (!warranty || warranty.balance <= 0.01),
    payUrl: `${origin}/pay/${est.token}`,
    depositPayUrl: `${origin}/pay/${est.token}?type=deposit`,
    payments: payments.map((p) => ({
      id: p.id, amount: p.amount, method: p.method, kind: p.kind, status: p.status, paidAt: p.paidAt,
      payer: p.payer, checkNumber: p.checkNumber,
    })),
    warrantyCovered: coverage?.applied ?? 0,
    warrantyClaim: coverage
      ? { company: coverage.claim.company, claimNumber: coverage.claim.claimNumber, authNumber: coverage.claim.authNumber }
      : null,
    warranty,
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
  // amount = what's due right now, the same figure for every payment method.
  // estimateId/number/title are the ROOT invoice's; documents lists what it is made of.
  | { ok: true; estimateId: string; number: string; title: string; amount: number; documents: PaymentSummary["documents"] }
  | { ok: false; reason: string }
> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { token: estimateToken },
    select: { id: true, signedAt: true, status: true, title: true },
  });
  if (!est) return { ok: false, reason: "Invoice not found." };
  // A lost estimate is unsigned, so the next line would already refuse it — but it would say
  // "not signed yet", which invites a customer to go sign a quote the office has closed. Named
  // first, with the honest answer (2026-09-20). /pay/:token and /checkout both come through here.
  if (est.status === "lost") return { ok: false, reason: "This estimate has been closed and is not open for payment. Call Red Cedar Electric if you would like to move forward." };
  if (!est.signedAt) return { ok: false, reason: "This estimate has not been signed yet." };
  if (est.status === "void") return { ok: false, reason: "This invoice is void." };

  // A change order's link pays the WHOLE invoice — the summary resolves to
  // the root, and the root is what the session and the payment are recorded
  // against (Kyle, 2026-09-20: "allow a single payment once its all finished").
  const summary = (await paymentSummary(prisma, est.id, "https://unused.invalid"))!;
  if (summary.paidInFull) return { ok: false, reason: "This invoice has already been paid — thank you!" };
  if (payType === "deposit" && !summary.depositRequired) {
    return { ok: false, reason: "No deposit is required on this invoice — the balance is due at completion." };
  }
  if (payType === "deposit" && summary.depositSatisfied) {
    return { ok: false, reason: "The deposit on this job has already been paid — thank you!" };
  }
  const amount = payType === "deposit"
    ? round2(Math.min(summary.depositDue - summary.depositPaid, summary.balance))
    : summary.balance;
  if (!(amount > 0)) return { ok: false, reason: "Nothing is due on this invoice." };
  const root = summary.estimateId === est.id
    ? est
    : (await prisma.issuedEstimate.findUnique({ where: { id: summary.estimateId }, select: { id: true, title: true } }))!;
  return { ok: true, estimateId: root.id, number: summary.number, title: root.title, amount, documents: summary.documents };
}

export async function createInvoiceCheckoutSession(
  prisma: PrismaClient,
  estimateToken: string,
  origin: string,
  // "deposit" charges the ⅓ down (less any deposit already paid); "balance"
  // charges what remains after every paid row. (Kyle, 2026-08-25.)
  payType: "balance" | "deposit" = "balance",
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  if (!stripeConfigured()) return { ok: false, reason: "Online payment is not configured." };

  const chargeable = await chargeableAmount(prisma, estimateToken, payType);
  if (!chargeable.ok) return chargeable;

  const full = await prisma.issuedEstimate.findUnique({ where: { id: chargeable.estimateId } });
  // One price for every rail — card and bank both pay exactly what's due.
  const charged = chargeable.amount;

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
            description: payType === "deposit"
              ? `${full!.serviceAddress ?? ""} — Deposits are non-refundable up to $${DEPOSIT_NONREFUNDABLE_CAP} if the job is cancelled.`.trim()
              : full!.serviceAddress ?? undefined,
          },
        },
      },
    ],
    customer_email: full!.customerEmail ?? undefined,
    // No payment_method_types and no exclusions: dynamic payment methods let
    // the Dashboard offer card AND bank transfer side by side, same price.
    // Fulfillment keys off these in the webhook — never trust the success page.
    metadata: {
      estimateId: chargeable.estimateId,
      estimateNumber: chargeable.number,
      customerId: full!.customerId,
      visitId: full!.jobVisitId ?? "",
      kind: payType === "deposit" ? "deposit" : "final",
      baseAmount: String(charged),
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

  await dispatchStripeEvent(prisma, event);
  return { received: true };
}

/** Per-process memory: the Issuing-webhook-is-a-duplicate-feed notice logs once, not per event. */
let issuingWebhookNoticeLogged = false;
/** Test hook: forget the notice was logged. */
export function resetIssuingWebhookNotice(): void {
  issuingWebhookNoticeLogged = false;
}

/**
 * The event switch, separated from signature verification so it can be
 * exercised with a hand-built event. Checkout fulfilment stays exactly as it
 * was; Issuing webhook events are acknowledged and create nothing (Kyle,
 * 2026-09-21 — the v2 money-management feed in services/cardSpend.ts is the
 * one source of card spend).
 */
export async function dispatchStripeEvent(prisma: PrismaClient, event: Stripe.Event): Promise<void> {
  const recordPaid = async (session: Stripe.Checkout.Session) => {
    // Delayed-notification methods complete the session while still unpaid —
    // record only when the money is actually in flight or landed.
    if (session.payment_status === "unpaid") return;
    const estimateId = session.metadata?.estimateId ?? null;
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
    // One card charge, one expense (Kyle, 2026-09-21, PUNCHLIST N9): classic
    // Issuing is not enabled on this account ("not set up to use Issuing" —
    // the LIST call is refused) but these webhook EVENTS still arrive, and
    // used to create a second CardSpend for every swipe the v2 money-
    // management feed (services/cardSpend.ts syncFinancialAccountTransactions)
    // already recorded, with no shared id to dedup on. The v2 feed is now the
    // ONE source of card spend — these events are acknowledged (so Stripe
    // stops retrying) and create nothing. One INFO SystemEvent per process,
    // not one per event.
    case "issuing_transaction.created":
    case "issuing_transaction.updated": {
      if (!issuingWebhookNoticeLogged) {
        issuingWebhookNoticeLogged = true;
        logSystemEvent(
          "info", "card-spend",
          "Issuing webhook event received and ignored — the v2 money-management feed is the one source of card spend (Kyle, 2026-09-21)",
          { eventType: event.type },
        );
      }
      break;
    }
    default:
      // Unhandled event types are acknowledged, not errored — Stripe retries errors.
      break;
  }
}
