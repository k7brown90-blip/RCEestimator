/**
 * Card refunds recorded from Stripe (Kyle, 2026-10-09, ruling 7 of the one-estimating-system plan):
 * "the app listens for Stripe's refund events (charge.refunded) and records the refund itself, so a
 * refunded card payment stops counting as collected."
 *
 * What these pin:
 *   1. IDEMPOTENT by Stripe's refund id: the same charge.refunded twice writes one PaymentRefund row,
 *      one invoice event, and changes nothing the second time.
 *   2. PARTIAL THEN FULL: a partial refund nets the row (status stays "paid", refundedAmount > 0);
 *      the full one marks it "refunded". The row is never deleted.
 *   3. READERS AGREE: paymentSummary (balance, depositPaid, depositSatisfied, paidInFull), GET
 *      /invoices, the account's lifetime collected, the P&L's collected (negative in the month
 *      refunded) and its CSV, GET /jobs' deposit gate, the year ledger (/financials/payments) all
 *      count collected = paid − refunded. The job's card processing fee STAYS (Stripe keeps it).
 *   4. UNSIGNED EVENT REJECTED: handleStripeWebhook answers "Invalid signature." and records nothing.
 *   5. UNKNOWN PAYMENT: a refund for a charge this app never recorded is logged (SystemEvent, warn)
 *      and acknowledged — never a crash.
 *   6. An OLD row (no PaymentIntent on it) is matched by asking Stripe for the Checkout Session and
 *      backfilled; a refund's own lifecycle (pending → succeeded → failed) counts only while
 *      succeeded; a late checkout.session.completed retry never turns a refunded row back on.
 *
 * No Stripe call leaves this file: the client is mocked at services/stripePayments. Signature
 * verification is the real SDK's (`webhooks.constructEvent` needs no network).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import Stripe from "stripe";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
process.env.STRIPE_SECRET_KEY = "rk_test_mocked_never_used";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_refunds_never_used";

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  sessionsList: vi.fn(),
  refundsList: vi.fn(),
}));

// The SDK package itself is mocked (as tests/paymentVoid.test.ts does), not stripePayments'
// `stripe()` export: paymentRefunds.ts sits in stripePayments' own import graph, so a mock of that
// module's exports is bypassed for it (vitest loads the original graph to build the mock). Every
// `new Stripe(key)` in the app gets this class; only the signature verifier is the real one.
vi.mock("stripe", async (importOriginal) => {
  const real = await importOriginal<{ default: typeof Stripe }>();
  const verifier = new real.default("sk_test_never_used_offline"); // no network on construction
  class MockStripe {
    static webhooks = real.default.webhooks;
    webhooks = verifier.webhooks;
    checkout = { sessions: { retrieve: mocks.retrieve, list: mocks.sessionsList } };
    refunds = { list: mocks.refundsList };
    balanceTransactions = { list: () => ({ async *[Symbol.asyncIterator]() { /* no fee rows */ } }) };
  }
  return { ...real, default: MockStripe };
});
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 { setCredentials() {} }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }) },
      }),
    },
  };
});
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true), sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: emailMock.sendKyleNotificationEmail };
});

import { app } from "../src/app";
import { dispatchStripeEvent, handleStripeWebhook, paymentSummary } from "../src/services/stripePayments";
import { collectedByCustomer } from "../src/services/lifetimeCollected";
import { commissionBasisForJob } from "../src/services/timeTracking";
import { resetStripeSessionFeeCache } from "../src/services/treasury";
import { collectedOf, recordRefundsFromCharge } from "../src/services/paymentRefunds";

const MARK = "RFD7";
/** A year no other test records money in — the P&L assertions sum the whole year. */
const YEAR = 2040;
const JUNE = new Date(Date.UTC(YEAR, 5, 10, 12));
const AUGUST = new Date(Date.UTC(YEAR, 7, 3, 12));
const unix = (d: Date) => Math.floor(d.getTime() / 1000);
const round2 = (n: number) => Math.round(n * 100) / 100;
const settle = () => new Promise((r) => setTimeout(r, 250)); // fire-and-forget writes land

let customerId: string;
let propertyId: string;
let draftId: string;
let visitId: string;
let estimateId: string;
let estimateNumber: string;
let eventSeq = 0;

type RefundSeed = { id: string; amount: number; status?: string; reason?: string | null; created?: number; charge?: string; paymentIntent?: string };
function refundObject(r: RefundSeed) {
  return {
    id: r.id, object: "refund", amount: r.amount, currency: "usd", status: r.status ?? "succeeded",
    reason: r.reason === undefined ? "requested_by_customer" : r.reason, created: r.created ?? unix(AUGUST),
    charge: r.charge ?? null, payment_intent: r.paymentIntent ?? null,
  };
}
/** `created` is the EVENT's own time (Stripe's event.created) — the order a charge snapshot is applied in. */
function chargeRefundedEvent(input: { chargeId: string; paymentIntentId: string; amount: number; amountRefunded: number; refunds: RefundSeed[] | null; created?: number }) {
  const charge = {
    id: input.chargeId, object: "charge", amount: input.amount, amount_refunded: input.amountRefunded, currency: "usd",
    payment_intent: input.paymentIntentId, refunded: input.amountRefunded >= input.amount,
    ...(input.refunds ? { refunds: { object: "list", data: input.refunds.map((r) => refundObject({ ...r, charge: input.chargeId, paymentIntent: input.paymentIntentId })) } } : {}),
  };
  return { id: `evt_${MARK}_${++eventSeq}`, object: "event", type: "charge.refunded", created: input.created, data: { object: charge } } as unknown as Stripe.Event;
}
function refundEvent(type: "refund.created" | "refund.updated" | "refund.failed", r: RefundSeed, created?: number) {
  return { id: `evt_${MARK}_${++eventSeq}`, object: "event", type, created, data: { object: refundObject(r) } } as unknown as Stripe.Event;
}
function completedSessionEvent(input: { sessionId: string; paymentIntentId: string; amount: number; kind: "deposit" | "final" }) {
  return {
    id: `evt_${MARK}_${++eventSeq}`, object: "event", type: "checkout.session.completed",
    data: { object: {
      id: input.sessionId, object: "checkout.session", payment_status: "paid", payment_intent: input.paymentIntentId,
      amount_total: Math.round(input.amount * 100),
      metadata: { estimateId, estimateNumber, customerId, visitId, kind: input.kind, baseAmount: String(input.amount) },
    } },
  } as unknown as Stripe.Event;
}

/** A card payment as the webhook records it since 2026-10-09: session + PaymentIntent on the row. */
async function cardPayment(input: { session: string; intent?: string | null; amount: number; kind: "deposit" | "final"; paidAt?: Date }) {
  return prisma.payment.create({
    data: {
      customerId, estimateId, visitId, amount: input.amount, method: "stripe", kind: input.kind, status: "paid",
      stripeSessionId: input.session, stripePaymentIntentId: input.intent === undefined ? `pi_${input.session}` : input.intent,
      paidAt: input.paidAt ?? JUNE, note: `${MARK} card`,
    },
  });
}

const summaryOf = () => paymentSummary(prisma, estimateId, "https://unused.invalid");
const invoiceRow = async () => (await request(app).get("/invoices")).body.find((i: { id: string }) => i.id === estimateId);
const lifetime = async () => (await collectedByCustomer(prisma, [customerId])).get(customerId);
const pl = async () => (await request(app).get(`/financials/summary?year=${YEAR}`)).body;
const jobListed = async () => Boolean((await request(app).get("/jobs")).body.find((j: { visitId: string }) => j.visitId === visitId));
const paymentRow = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id }, include: { refunds: { orderBy: { refundedAt: "asc" } } } });
const refundEvents = () => prisma.issuedEstimateEvent.count({ where: { estimateId, type: "payment_refunded" } });

const cleanup = async () => {
  await prisma.payment.deleteMany({ where: { OR: [{ note: { startsWith: `${MARK} ` } }, { stripeSessionId: { startsWith: "cs_rf_" } }] } });
  const estIds = (await prisma.issuedEstimate.findMany({ where: { number: { startsWith: `0000-${MARK}` } }, select: { id: true } })).map((e) => e.id);
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: `${MARK} draft` } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: `${MARK}-SUP` } });
  await prisma.visit.deleteMany({ where: { purpose: `${MARK} visit` } });
  await prisma.property.deleteMany({ where: { name: `${MARK} property` } });
  await prisma.customer.deleteMany({ where: { name: `${MARK} Customer` } });
  await prisma.systemEvent.deleteMany({ where: { OR: [{ message: { contains: `0000-${MARK}` } }, { detailsJson: { contains: "pi_rf_" } }] } });
};

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "rfd7-customer@example.com" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} property`, addressLine1: "7 Refund Lane", city: "Hermitage", state: "TN", postalCode: "37076" },
  });
  propertyId = property.id;
  await prisma.priceBookSupplier.create({ data: { id: `${MARK}-SUP`, name: `${MARK} Supply`, quotable: "YES" } });
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} draft`, supplierId: `${MARK}-SUP` } });
  draftId = draft.id;
  // Scheduled, not completed: GET /jobs lists it only while the ⅓ deposit is satisfied.
  const visit = await prisma.visit.create({ data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} visit`, status: "scheduled" } });
  visitId = visit.id;
  estimateNumber = `0000-${MARK}A`;
  const est = await prisma.issuedEstimate.create({
    data: {
      number: estimateNumber,
      token: `rfd7a${Date.now().toString(16)}`.padEnd(64, "0"),
      status: "signed", draftId, customerId, serviceAddressId: propertyId,
      customerName: `${MARK} Customer`, customerEmail: "rfd7-customer@example.com", serviceAddress: "7 Refund Lane, Hermitage, TN",
      title: "Panel upgrade", scopeText: "Panel upgrade.", workSubtotal: 925, tripCharge: 75, total: 1000,
      sentAt: new Date(), sentTo: "rfd7-customer@example.com", visitId, jobVisitId: visitId,
      signedAt: new Date(Date.UTC(YEAR, 4, 1)), signerName: `${MARK} Customer`, signedChannel: "email", depositRequired: true,
      selectedOptions: ["A"],
      comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
      options: { create: [{ option: "A", label: "Panel", subtotal: 925, lineCount: 1 }] },
    },
  });
  estimateId = est.id;
});

afterAll(cleanup);

beforeEach(async () => {
  await prisma.payment.deleteMany({ where: { OR: [{ note: { startsWith: `${MARK} ` } }, { stripeSessionId: { startsWith: "cs_rf_" } }] } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId } });
  resetStripeSessionFeeCache();
  mocks.retrieve.mockReset();
  mocks.retrieve.mockImplementation(async (id: string) => ({
    id, payment_intent: { id: `pi_${id}`, latest_charge: { id: `ch_${id}`, balance_transaction: { id: `txn_${id}`, fee: id === "cs_rf_dep" ? 997 : 2003, net: 0, created: unix(JUNE) } } },
  }));
  mocks.sessionsList.mockReset();
  mocks.sessionsList.mockResolvedValue({ data: [] });
  mocks.refundsList.mockReset();
  mocks.refundsList.mockRejectedValue(new Error("refunds.list not expected in this test"));
  emailMock.sendKyleNotificationEmail.mockClear();
});

describe("a card refund made in Stripe is recorded here and stops counting as collected — on every reader", () => {
  it("partial, then the same event again (idempotent), then full: paymentSummary, /invoices, lifetime, the P&L, GET /jobs and the ledger agree", async () => {
    // The deposit arrives through the webhook, as in production — the PaymentIntent is captured on the row.
    await dispatchStripeEvent(prisma, completedSessionEvent({ sessionId: "cs_rf_dep", paymentIntentId: "pi_cs_rf_dep", amount: 333.33, kind: "deposit" }));
    const deposit = await prisma.payment.findUniqueOrThrow({ where: { stripeSessionId: "cs_rf_dep" } });
    expect(deposit).toMatchObject({ status: "paid", amount: 333.33, stripePaymentIntentId: "pi_cs_rf_dep", refundedAmount: 0, refundedAt: null });
    await prisma.payment.update({ where: { id: deposit.id }, data: { paidAt: JUNE, note: `${MARK} deposit` } });
    emailMock.sendKyleNotificationEmail.mockClear(); // the deposit's own "Payment received" notice
    const balance = await cardPayment({ session: "cs_rf_bal", amount: 666.67, kind: "final" });

    expect(await summaryOf()).toMatchObject({ totalPaid: 1000, depositPaid: 333.33, balance: 0, paidInFull: true, depositSatisfied: true });
    expect(await jobListed()).toBe(true);
    expect((await pl()).totals.collected).toBe(1000);

    // 1. PARTIAL: $250 of the $666.67 balance payment refunded in the Stripe Dashboard.
    const partial = chargeRefundedEvent({ chargeId: "ch_cs_rf_bal", paymentIntentId: "pi_cs_rf_bal", amount: 66667, amountRefunded: 25000, refunds: [{ id: "re_rf_bal_1", amount: 25000 }] });
    await dispatchStripeEvent(prisma, partial);
    let row = await paymentRow(balance.id);
    expect(row).toMatchObject({ status: "paid", amount: 666.67, refundedAmount: 250, stripeChargeId: "ch_cs_rf_bal" });
    expect(row.refundedAt).toEqual(AUGUST);
    expect(row.refunds).toHaveLength(1);
    expect(row.refunds[0]).toMatchObject({ stripeRefundId: "re_rf_bal_1", amount: 250, status: "succeeded", reason: "requested_by_customer", stripeChargeId: "ch_cs_rf_bal" });
    expect(collectedOf(row)).toBe(416.67);
    expect(await refundEvents()).toBe(1);
    expect(emailMock.sendKyleNotificationEmail).toHaveBeenCalledTimes(1);
    expect(emailMock.sendKyleNotificationEmail.mock.calls[0][0]).toMatch(/Refund recorded: \$250\.00/);

    // The readers: paid − refunded.
    let summary = (await summaryOf())!;
    expect(summary).toMatchObject({ totalPaid: 750, depositPaid: 333.33, balance: 250, paidInFull: false, depositSatisfied: true });
    const listed = summary.payments.find((p) => p.id === balance.id)!;
    expect(listed).toMatchObject({ status: "paid", amount: 666.67, refundedAmount: 250 });
    expect(listed.refunds).toHaveLength(1);
    expect(await invoiceRow()).toMatchObject({ totalPaid: 750, balance: 250, collected: 750, paymentStatus: "deposit_paid" });
    expect((await lifetime())!.collected).toBe(750);
    let ledger = await pl();
    expect(ledger.months[5].collected).toBe(1000); // paid in June, gross
    expect(ledger.months[7].collected).toBe(-250); // refunded in August
    expect(ledger.totals.collected).toBe(750);
    const csv = await request(app).get(`/financials/export?year=${YEAR}`);
    expect(csv.text).toContain(`${YEAR}-08-03,income,collected,"Refund (stripe refund) — Refunded in Stripe (re_rf_bal_1) — requested by customer",-250.00`);

    // 2. IDEMPOTENT: Stripe retries the same event — nothing is written twice, nothing changes.
    await dispatchStripeEvent(prisma, partial);
    row = await paymentRow(balance.id);
    expect(row).toMatchObject({ status: "paid", refundedAmount: 250 });
    expect(row.refunds).toHaveLength(1);
    expect(await refundEvents()).toBe(1);
    expect(emailMock.sendKyleNotificationEmail).toHaveBeenCalledTimes(1);
    expect((await summaryOf())!.totalPaid).toBe(750);

    // 3. FULL: the rest goes back — the charge's cumulative amount with both refunds listed.
    await dispatchStripeEvent(prisma, chargeRefundedEvent({
      chargeId: "ch_cs_rf_bal", paymentIntentId: "pi_cs_rf_bal", amount: 66667, amountRefunded: 66667,
      refunds: [{ id: "re_rf_bal_1", amount: 25000 }, { id: "re_rf_bal_2", amount: 41667, created: unix(AUGUST) + 3600, reason: null }],
    }));
    row = await paymentRow(balance.id);
    expect(row).toMatchObject({ status: "refunded", amount: 666.67, refundedAmount: 666.67 });
    expect(row.refunds.map((r) => [r.stripeRefundId, r.amount])).toEqual([["re_rf_bal_1", 250], ["re_rf_bal_2", 416.67]]);
    expect(collectedOf(row)).toBe(0);
    expect(await refundEvents()).toBe(2);
    summary = (await summaryOf())!;
    expect(summary).toMatchObject({ totalPaid: 333.33, depositPaid: 333.33, balance: 666.67, paidInFull: false, depositSatisfied: true });
    // The row is still LISTED, marked — never dropped from the ledger.
    expect(summary.payments.find((p) => p.id === balance.id)).toMatchObject({ status: "refunded", refundedAmount: 666.67 });
    expect(await invoiceRow()).toMatchObject({ totalPaid: 333.33, balance: 666.67, collected: 333.33, paymentStatus: "deposit_paid" });
    expect((await lifetime())!.collected).toBe(333.33);
    ledger = await pl();
    expect(ledger.months[7].collected).toBe(-666.67);
    expect(ledger.totals.collected).toBe(333.33);
    const yearLedger = (await request(app).get(`/financials/payments?year=${new Date().getFullYear()}`)).body.find((p: { id: string }) => p.id === balance.id);
    expect(yearLedger).toMatchObject({ status: "refunded", refundedAmount: 666.67 });
    expect(yearLedger.refunds).toHaveLength(2);

    // The job's card processing fee STAYS — Stripe keeps its fee on a refund — and says so.
    const basis = await commissionBasisForJob(visitId);
    const feeRow = basis.feeRows.find((f) => f.kind === "stripe" && f.id === balance.id)!;
    expect(feeRow).toMatchObject({ amount: 20.03 });
    expect(feeRow.label).toMatch(/later refunded — Stripe keeps its fee/);
    const job = (await request(app).get("/jobs")).body.find((j: { visitId: string }) => j.visitId === visitId);
    expect(job.costs.cardFees).toBe(30); // 9.97 + 20.03

    // 4. The DEPOSIT refunded in full: the ⅓ gate closes again and the job leaves the Jobs tab.
    await dispatchStripeEvent(prisma, chargeRefundedEvent({ chargeId: "ch_cs_rf_dep", paymentIntentId: "pi_cs_rf_dep", amount: 33333, amountRefunded: 33333, refunds: [{ id: "re_rf_dep_1", amount: 33333 }] }));
    expect(await summaryOf()).toMatchObject({ totalPaid: 0, depositPaid: 0, balance: 1000, depositSatisfied: false, paidInFull: false });
    expect(await jobListed()).toBe(false);
    expect(await invoiceRow()).toMatchObject({ collected: 0, paymentStatus: "unpaid" });
    expect((await lifetime())?.collected ?? 0).toBe(0);
    expect((await pl()).totals.collected).toBe(0);

    // 5. A late retry of the deposit's checkout.session.completed never turns the money back on.
    emailMock.sendBrandedEmail.mockClear();
    await dispatchStripeEvent(prisma, completedSessionEvent({ sessionId: "cs_rf_dep", paymentIntentId: "pi_cs_rf_dep", amount: 333.33, kind: "deposit" }));
    await settle();
    expect(await prisma.payment.findUniqueOrThrow({ where: { stripeSessionId: "cs_rf_dep" } })).toMatchObject({ status: "refunded", refundedAmount: 333.33 });
    expect((await summaryOf())!.totalPaid).toBe(0);
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled(); // no receipt re-sent for a refunded row
  });

  it("an old row with no PaymentIntent on it is matched by asking Stripe for its Checkout Session, and backfilled", async () => {
    const old = await cardPayment({ session: "cs_rf_old", intent: null, amount: 100, kind: "final" });
    mocks.sessionsList.mockImplementation(async (params: { payment_intent: string }) => ({ data: params.payment_intent === "pi_rf_old" ? [{ id: "cs_rf_old" }] : [] }));
    const result = await recordRefundsFromCharge(prisma, chargeRefundedEvent({ chargeId: "ch_rf_old", paymentIntentId: "pi_rf_old", amount: 10000, amountRefunded: 10000, refunds: [{ id: "re_rf_old_1", amount: 10000 }] }).data.object as Stripe.Charge);
    expect(result).toMatchObject({ applied: "recorded", paymentId: old.id, refundedAmount: 100, fullyRefunded: true });
    expect(mocks.sessionsList).toHaveBeenCalledWith({ payment_intent: "pi_rf_old", limit: 1 });
    const row = await paymentRow(old.id);
    expect(row).toMatchObject({ status: "refunded", refundedAmount: 100, stripePaymentIntentId: "pi_rf_old", stripeChargeId: "ch_rf_old" });
    // The next event for the same charge is a plain lookup — Stripe is not asked again.
    mocks.sessionsList.mockClear();
    await dispatchStripeEvent(prisma, chargeRefundedEvent({ chargeId: "ch_rf_old", paymentIntentId: "pi_rf_old", amount: 10000, amountRefunded: 10000, refunds: [{ id: "re_rf_old_1", amount: 10000 }] }));
    expect(mocks.sessionsList).not.toHaveBeenCalled();
  });

  it("a refund for a payment this app does not have is logged and acknowledged — never a crash", async () => {
    const before = await prisma.paymentRefund.count();
    const event = chargeRefundedEvent({ chargeId: "ch_rf_nobody", paymentIntentId: "pi_rf_nobody", amount: 5000, amountRefunded: 5000, refunds: [{ id: "re_rf_nobody_1", amount: 5000 }] });
    await expect(dispatchStripeEvent(prisma, event)).resolves.toBeUndefined();
    expect(await recordRefundsFromCharge(prisma, event.data.object as Stripe.Charge)).toEqual({ applied: "unknown_payment" });
    expect(await prisma.paymentRefund.count()).toBe(before);
    await settle();
    const logged = await prisma.systemEvent.findFirst({ where: { level: "warn", source: "stripe", message: { contains: "does not have" }, detailsJson: { contains: "pi_rf_nobody" } } });
    expect(logged).toBeTruthy();
    expect(logged!.message).toMatch(/\$50\.00/);
  });

  it("a refund's own lifecycle: pending counts nothing, succeeded counts, failed comes back off", async () => {
    const bank = await cardPayment({ session: "cs_rf_bank", amount: 200, kind: "final" });
    const seed = { id: "re_rf_bank_1", amount: 20000, charge: "ch_cs_rf_bank", paymentIntent: "pi_cs_rf_bank" };
    await dispatchStripeEvent(prisma, refundEvent("refund.created", { ...seed, status: "pending" }));
    expect(await paymentRow(bank.id)).toMatchObject({ status: "paid", refundedAmount: 0, refundedAt: null });
    expect((await paymentRow(bank.id)).refunds[0]).toMatchObject({ stripeRefundId: "re_rf_bank_1", status: "pending" });
    expect((await summaryOf())!.totalPaid).toBe(200);

    await dispatchStripeEvent(prisma, refundEvent("refund.updated", { ...seed, status: "succeeded" }));
    expect(await paymentRow(bank.id)).toMatchObject({ status: "refunded", refundedAmount: 200 });
    expect((await summaryOf())!.totalPaid).toBe(0);

    await dispatchStripeEvent(prisma, refundEvent("refund.failed", { ...seed, status: "failed" }));
    const row = await paymentRow(bank.id);
    expect(row).toMatchObject({ status: "paid", refundedAmount: 0, refundedAt: null });
    expect(row.refunds[0].status).toBe("failed");
    expect((await summaryOf())!.totalPaid).toBe(200);
  });

  it("a charge.refunded that carries no refund list, from a key that cannot list refunds, still records the amount — as the unlisted stand-in row the P&L reads too", async () => {
    const paid = await cardPayment({ session: "cs_rf_nolist", amount: 100, kind: "final" });
    await dispatchStripeEvent(prisma, chargeRefundedEvent({ chargeId: "ch_cs_rf_nolist", paymentIntentId: "pi_cs_rf_nolist", amount: 10000, amountRefunded: 4000, refunds: null, created: unix(AUGUST) }));
    expect(mocks.refundsList).toHaveBeenCalledWith({ charge: "ch_cs_rf_nolist", limit: 100 });
    let row = await paymentRow(paid.id);
    expect(row).toMatchObject({ status: "paid", refundedAmount: 40 });
    expect(row.refundedAt).toEqual(AUGUST);
    // The money Stripe did not name is its own row, so the invoice, the account AND the P&L read
    // the same thing (review finding, 2026-10-09: the P&L only reads rows and missed this refund).
    expect(row.refunds).toHaveLength(1);
    expect(row.refunds[0]).toMatchObject({ stripeRefundId: "ch_cs_rf_nolist:unlisted", amount: 40, status: "succeeded", reason: null });
    expect((await summaryOf())!.totalPaid).toBe(60);
    const ledger = await pl();
    expect(ledger.months[7].collected).toBe(-40);
    expect(ledger.totals.collected).toBe(60);
    const csv = await request(app).get(`/financials/export?year=${YEAR}`);
    expect(csv.text).toContain(`${YEAR}-08-03,income,collected,"Refund (stripe refund) — Refunded in Stripe (charge ch_cs_rf_nolist — Stripe did not name the refund)",-40.00`);

    // The refund's own event arrives later and NAMES it: the named row replaces the stand-in —
    // never both, never double-counted — and the total is unchanged.
    emailMock.sendKyleNotificationEmail.mockClear();
    await dispatchStripeEvent(prisma, refundEvent("refund.created", { id: "re_rf_nolist_1", amount: 4000, charge: "ch_cs_rf_nolist", paymentIntent: "pi_cs_rf_nolist" }));
    row = await paymentRow(paid.id);
    expect(row).toMatchObject({ status: "paid", refundedAmount: 40 });
    expect(row.refunds.map((r) => [r.stripeRefundId, r.amount, r.status])).toEqual([["re_rf_nolist_1", 40, "succeeded"]]);
    expect(emailMock.sendKyleNotificationEmail).not.toHaveBeenCalled();
    expect((await pl()).totals.collected).toBe(60);

    // A second, named-later refund: the charge snapshot (no list) grows the stand-in by the part
    // it cannot name; the name arrives; the stand-in goes.
    await dispatchStripeEvent(prisma, chargeRefundedEvent({ chargeId: "ch_cs_rf_nolist", paymentIntentId: "pi_cs_rf_nolist", amount: 10000, amountRefunded: 10000, refunds: null, created: unix(AUGUST) + 60 }));
    row = await paymentRow(paid.id);
    expect(row).toMatchObject({ status: "refunded", refundedAmount: 100 });
    expect(row.refunds.map((r) => [r.stripeRefundId, r.amount])).toEqual([["re_rf_nolist_1", 40], ["ch_cs_rf_nolist:unlisted", 60]]);
    await dispatchStripeEvent(prisma, refundEvent("refund.created", { id: "re_rf_nolist_2", amount: 6000, charge: "ch_cs_rf_nolist", paymentIntent: "pi_cs_rf_nolist", created: unix(AUGUST) + 60 }));
    row = await paymentRow(paid.id);
    expect(row).toMatchObject({ status: "refunded", refundedAmount: 100 });
    expect(row.refunds.map((r) => r.stripeRefundId).sort()).toEqual(["re_rf_nolist_1", "re_rf_nolist_2"]);
    expect((await pl()).totals.collected).toBe(0);
  });

  it("ONE RULE, EVERY ORDER: charge.refunded and a PENDING refund.created in either order never flip-flop the total or send a false 'Refund reversed'", async () => {
    // Order A: the charge snapshot first (amount_refunded already counts the pending refund), then the refund's own event.
    const a = await cardPayment({ session: "cs_rf_mixa", amount: 200, kind: "final" });
    const seedA = { id: "re_rf_mixa_1", amount: 20000, charge: "ch_cs_rf_mixa", paymentIntent: "pi_cs_rf_mixa" };
    await dispatchStripeEvent(prisma, chargeRefundedEvent({ chargeId: "ch_cs_rf_mixa", paymentIntentId: "pi_cs_rf_mixa", amount: 20000, amountRefunded: 20000, refunds: [{ ...seedA, status: "pending" }] }));
    expect(await paymentRow(a.id)).toMatchObject({ status: "paid", refundedAmount: 0, refundedAt: null }); // pending counts nothing — on this path too
    await dispatchStripeEvent(prisma, refundEvent("refund.created", { ...seedA, status: "pending" }));
    expect(await paymentRow(a.id)).toMatchObject({ status: "paid", refundedAmount: 0 });
    expect(emailMock.sendKyleNotificationEmail).not.toHaveBeenCalled();
    await dispatchStripeEvent(prisma, refundEvent("refund.updated", { ...seedA, status: "succeeded" }));
    expect(await paymentRow(a.id)).toMatchObject({ status: "refunded", refundedAmount: 200 });
    expect(emailMock.sendKyleNotificationEmail).toHaveBeenCalledTimes(1);
    expect(emailMock.sendKyleNotificationEmail.mock.calls[0][0]).toMatch(/^Refund recorded/);

    // Order B: the refund's own event first, then the charge snapshot, then success.
    emailMock.sendKyleNotificationEmail.mockClear();
    const b = await cardPayment({ session: "cs_rf_mixb", amount: 200, kind: "final" });
    const seedB = { id: "re_rf_mixb_1", amount: 20000, charge: "ch_cs_rf_mixb", paymentIntent: "pi_cs_rf_mixb" };
    await dispatchStripeEvent(prisma, refundEvent("refund.created", { ...seedB, status: "pending" }));
    await dispatchStripeEvent(prisma, chargeRefundedEvent({ chargeId: "ch_cs_rf_mixb", paymentIntentId: "pi_cs_rf_mixb", amount: 20000, amountRefunded: 20000, refunds: [{ ...seedB, status: "pending" }] }));
    expect(await paymentRow(b.id)).toMatchObject({ status: "paid", refundedAmount: 0 });
    expect(emailMock.sendKyleNotificationEmail).not.toHaveBeenCalled();
    await dispatchStripeEvent(prisma, refundEvent("refund.updated", { ...seedB, status: "succeeded" }));
    await dispatchStripeEvent(prisma, chargeRefundedEvent({ chargeId: "ch_cs_rf_mixb", paymentIntentId: "pi_cs_rf_mixb", amount: 20000, amountRefunded: 20000, refunds: [{ ...seedB, status: "succeeded" }] }));
    expect(await paymentRow(b.id)).toMatchObject({ status: "refunded", refundedAmount: 200 });
    expect(emailMock.sendKyleNotificationEmail).toHaveBeenCalledTimes(1);
    expect(emailMock.sendKyleNotificationEmail.mock.calls[0][0]).toMatch(/^Refund recorded/);
    expect(await prisma.issuedEstimateEvent.count({ where: { estimateId, type: "payment_refunded", detail: { contains: "failed or was canceled" } } })).toBe(0);
  });

  it("a STALE snapshot never lowers the total: a retried older charge.refunded, or a 'pending' delivered after 'succeeded', is ignored", async () => {
    const paid = await cardPayment({ session: "cs_rf_stale", amount: 300, kind: "final" });
    const t0 = unix(AUGUST);
    const first = chargeRefundedEvent({ chargeId: "ch_cs_rf_stale", paymentIntentId: "pi_cs_rf_stale", amount: 30000, amountRefunded: 10000, refunds: [{ id: "re_rf_stale_1", amount: 10000 }], created: t0 });
    const second = chargeRefundedEvent({
      chargeId: "ch_cs_rf_stale", paymentIntentId: "pi_cs_rf_stale", amount: 30000, amountRefunded: 30000,
      refunds: [{ id: "re_rf_stale_1", amount: 10000 }, { id: "re_rf_stale_2", amount: 20000, created: t0 + 600 }], created: t0 + 600,
    });
    await dispatchStripeEvent(prisma, second);
    expect(await paymentRow(paid.id)).toMatchObject({ status: "refunded", refundedAmount: 300 });
    emailMock.sendKyleNotificationEmail.mockClear();

    // Stripe retries the FIRST event after the second landed: the total stays, the row stays refunded, no email.
    await dispatchStripeEvent(prisma, first);
    const row = await paymentRow(paid.id);
    expect(row).toMatchObject({ status: "refunded", refundedAmount: 300 });
    expect(row.refunds.map((r) => [r.stripeRefundId, r.status])).toEqual([["re_rf_stale_1", "succeeded"], ["re_rf_stale_2", "succeeded"]]);
    expect(emailMock.sendKyleNotificationEmail).not.toHaveBeenCalled();

    // A late 'pending' snapshot of a refund already succeeded cannot take it back off.
    await dispatchStripeEvent(prisma, refundEvent("refund.created", { id: "re_rf_stale_2", amount: 20000, status: "pending", charge: "ch_cs_rf_stale", paymentIntent: "pi_cs_rf_stale" }, t0 + 300));
    expect(await paymentRow(paid.id)).toMatchObject({ status: "refunded", refundedAmount: 300 });
    expect(emailMock.sendKyleNotificationEmail).not.toHaveBeenCalled();
    expect(await prisma.issuedEstimateEvent.count({ where: { estimateId, type: "payment_refunded", detail: { contains: "failed or was canceled" } } })).toBe(0);

    // The no-ids world has the same guard: an older snapshot of the charge leaves the stand-in alone.
    const nolist = await cardPayment({ session: "cs_rf_stale2", amount: 100, kind: "final" });
    await dispatchStripeEvent(prisma, chargeRefundedEvent({ chargeId: "ch_cs_rf_stale2", paymentIntentId: "pi_cs_rf_stale2", amount: 10000, amountRefunded: 10000, refunds: null, created: t0 + 600 }));
    expect(await paymentRow(nolist.id)).toMatchObject({ status: "refunded", refundedAmount: 100 });
    await dispatchStripeEvent(prisma, chargeRefundedEvent({ chargeId: "ch_cs_rf_stale2", paymentIntentId: "pi_cs_rf_stale2", amount: 10000, amountRefunded: 4000, refunds: null, created: t0 }));
    expect(await paymentRow(nolist.id)).toMatchObject({ status: "refunded", refundedAmount: 100 });
    // A real failure (a NEWER snapshot with less refunded) still comes back off.
    await dispatchStripeEvent(prisma, chargeRefundedEvent({ chargeId: "ch_cs_rf_stale2", paymentIntentId: "pi_cs_rf_stale2", amount: 10000, amountRefunded: 4000, refunds: null, created: t0 + 1200 }));
    expect(await paymentRow(nolist.id)).toMatchObject({ status: "paid", refundedAmount: 40 });
  });

  it("an UNSIGNED event is rejected and records nothing; a signed one is recorded", async () => {
    const paid = await cardPayment({ session: "cs_rf_sig", amount: 100, kind: "final" });
    const event = chargeRefundedEvent({ chargeId: "ch_cs_rf_sig", paymentIntentId: "pi_cs_rf_sig", amount: 10000, amountRefunded: 10000, refunds: [{ id: "re_rf_sig_1", amount: 10000 }] });
    const payload = JSON.stringify(event);

    const forged = await handleStripeWebhook(prisma, Buffer.from(payload), "t=1700000000,v1=0000000000000000000000000000000000000000000000000000000000000000");
    expect(forged).toEqual({ received: false, reason: "Invalid signature." });
    const wrongSecret = await handleStripeWebhook(prisma, Buffer.from(payload), Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_someone_else" }));
    expect(wrongSecret).toEqual({ received: false, reason: "Invalid signature." });
    expect(await paymentRow(paid.id)).toMatchObject({ status: "paid", refundedAmount: 0 });
    expect(await prisma.paymentRefund.count({ where: { stripeRefundId: "re_rf_sig_1" } })).toBe(0);

    // The route itself answers 400 to a forged signature too.
    const res = await request(app).post("/stripe/webhook").set("Stripe-Signature", "t=1,v1=bad").set("Content-Type", "application/json").send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid signature.");

    const signed = await handleStripeWebhook(prisma, Buffer.from(payload), Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! }));
    expect(signed).toEqual({ received: true });
    expect(await paymentRow(paid.id)).toMatchObject({ status: "refunded", refundedAmount: 100 });
    expect(round2((await summaryOf())!.totalPaid)).toBe(0);
  });
});
