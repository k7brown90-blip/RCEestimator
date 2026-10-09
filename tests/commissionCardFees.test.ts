/**
 * Commission on true profit — Stripe's processing fee per card payment (Kyle, 2026-10-08, decision
 * 10 of the one-estimating-system plan; Phase 6 Unit 6D): "card processing fees on the job's
 * payments" come off the profit a technician is paid on.
 *
 * A Payment row names its Checkout Session, not its charge, so the fee is read off that session's
 * own balance transaction (treasury.stripeFeeForSession) — one row per card payment, attributed to
 * the job through the payment's invoice (estimateId) or visit. A fee Stripe cannot give — a payment
 * not settled yet, a key without read scope, Stripe not configured — is MISSING: the basis shows the
 * reason and refuses to compute a profit, never treating the fee as $0.
 *
 * No Stripe call leaves this file: the client is mocked at services/stripePayments with only
 * checkout.sessions.retrieve, the one call the fee reader makes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
process.env.STRIPE_SECRET_KEY = "rk_test_mocked_never_used";

const mocks = vi.hoisted(() => ({
  retrieve: vi.fn(),
  configured: true,
}));

vi.mock("../src/services/stripePayments", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/stripePayments")>();
  return {
    ...mod,
    stripeConfigured: () => mocks.configured,
    stripe: () => ({ checkout: { sessions: { retrieve: mocks.retrieve } } }),
  };
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

import { app } from "../src/app";
import { commissionBasisForJob, commissionForJob } from "../src/services/timeTracking";
import { resetStripeSessionFeeCache, stripeFeeForSession } from "../src/services/treasury";

const MARK = "CCF6D";
let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let estimateId: string;
let draftId: string;

/** What Stripe would return for `checkout.sessions.retrieve(id, { expand: [...] })`, per session. */
function session(id: string, tx: { fee: number; net: number } | "pending") {
  if (tx === "pending") return { id, payment_intent: { id: `pi_${id}`, latest_charge: null } };
  return {
    id,
    payment_intent: {
      id: `pi_${id}`,
      latest_charge: { id: `ch_${id}`, balance_transaction: { id: `txn_${id}`, fee: tx.fee, net: tx.net, created: 1_700_000_000 } },
    },
  };
}

async function cardPayment(input: { session: string | null; amount: number; kind?: string; via: "estimate" | "visit"; voided?: boolean }) {
  return prisma.payment.create({
    data: {
      customerId,
      estimateId: input.via === "estimate" ? estimateId : null,
      visitId: input.via === "visit" ? visitId : null,
      amount: input.amount,
      method: "stripe",
      kind: input.kind ?? "final",
      status: "paid",
      stripeSessionId: input.session,
      paidAt: new Date("2026-10-01T15:00:00.000Z"),
      ...(input.voided ? { voidedAt: new Date(), voidedBy: "human:crm-session", voidReason: "test" } : {}),
    },
  });
}

beforeAll(async () => {
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "ccf6d-customer@example.com" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} property`, addressLine1: "6 Fee Lane", city: "Hermitage", state: "TN", postalCode: "37076" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { propertyId, customerId, mode: "service_diagnostic", purpose: `${MARK} job`, status: "completed", revenue: 1000 },
  });
  visitId = visit.id;
  const tech = await prisma.technician.create({
    data: { name: `${MARK} Tech`, accessToken: `ccf6d-tech-${customer.id}`, role: "technician", hourlyRate: 30, commissionPercent: 10 },
  });
  technicianId = tech.id;
  await prisma.priceBookSupplier.create({ data: { id: `${MARK}-SUP`, name: `${MARK} Supply`, quotable: "YES" } });
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} draft`, supplierId: `${MARK}-SUP` } });
  draftId = draft.id;
  const est = await prisma.issuedEstimate.create({
    data: {
      number: `0000-${MARK}A`,
      token: `ccf6d${Date.now().toString(16)}`.padEnd(64, "0"),
      status: "signed",
      draftId,
      customerId,
      serviceAddressId: propertyId,
      customerName: `${MARK} Customer`,
      customerEmail: "ccf6d-customer@example.com",
      serviceAddress: "6 Fee Lane, Hermitage, TN",
      title: "Panel upgrade",
      scopeText: "Panel upgrade.",
      workSubtotal: 925,
      tripCharge: 75,
      total: 1000,
      sentAt: new Date(),
      sentTo: "ccf6d-customer@example.com",
      visitId,
      jobVisitId: visitId,
      signedAt: new Date(),
      signerName: `${MARK} Customer`,
      signedChannel: "email",
      selectedOptions: ["A"],
      comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
      options: { create: [{ option: "A", label: "Panel", subtotal: 925, lineCount: 1 }] },
    },
  });
  estimateId = est.id;
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { OR: [{ estimateId }, { visitId }] } });
  await prisma.commission.deleteMany({ where: { technicianId } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId } });
  await prisma.issuedEstimate.delete({ where: { id: estimateId } });
  await prisma.priceBookDraftEstimate.delete({ where: { id: draftId } });
  await prisma.priceBookSupplier.delete({ where: { id: `${MARK}-SUP` } });
  await prisma.technician.delete({ where: { id: technicianId } });
  await prisma.visit.delete({ where: { id: visitId } });
  await prisma.property.delete({ where: { id: propertyId } });
  await prisma.customer.delete({ where: { id: customerId } });
});

beforeEach(async () => {
  await prisma.payment.deleteMany({ where: { OR: [{ estimateId }, { visitId }] } });
  await prisma.commission.deleteMany({ where: { technicianId } });
  resetStripeSessionFeeCache();
  mocks.configured = true;
  mocks.retrieve.mockReset();
  mocks.retrieve.mockImplementation(async (id: string, opts: { expand?: string[] }) => {
    expect(opts.expand).toEqual(["payment_intent.latest_charge.balance_transaction"]);
    switch (id) {
      case "cs_fee_ok_1": return session(id, { fee: 997, net: 32336 });
      case "cs_fee_ok_2": return session(id, { fee: 2003, net: 64664 });
      case "cs_fee_pending": return session(id, "pending");
      case "cs_fee_forbidden": throw Object.assign(new Error("This API key does not have the required permissions"), { statusCode: 403, type: "StripePermissionError" });
      default: throw new Error(`No such checkout session: ${id}`);
    }
  });
});

describe("Stripe's processing fee on each card payment is a fee of the job", () => {
  it("one row per card payment, read off the payment's own balance transaction, attributed through the invoice or the visit", async () => {
    const deposit = await cardPayment({ session: "cs_fee_ok_1", amount: 333.33, kind: "deposit", via: "estimate" });
    const balance = await cardPayment({ session: "cs_fee_ok_2", amount: 666.67, via: "visit" });
    // Neither of these carries a Stripe fee: a check is not a card, and a voided card payment is no money.
    await prisma.payment.create({ data: { customerId, estimateId, amount: 50, method: "check", kind: "other", status: "paid", paidAt: new Date() } });
    await cardPayment({ session: "cs_fee_voided", amount: 100, via: "estimate", voided: true });

    const basis = await commissionBasisForJob(visitId);
    expect(basis.feeRows.filter((f) => f.kind === "stripe")).toEqual([
      { kind: "stripe", id: deposit.id, category: "card_processing", amount: 9.97, label: expect.stringMatching(/^Card processing fee — \$333\.33 deposit paid by card/) },
      { kind: "stripe", id: balance.id, category: "card_processing", amount: 20.03, label: expect.stringMatching(/^Card processing fee — \$666\.67 final paid by card/) },
    ]);
    expect(basis.feeProblems).toEqual([]);
    expect(basis.fees).toBe(30);
    expect(basis.missing).toEqual([]);
    expect(basis.profit).toBe(970); // 1000 − 0 material − 30 fees − 0 labor
    expect(mocks.retrieve).toHaveBeenCalledTimes(2);
    expect(mocks.retrieve.mock.calls.map((c) => c[0]).sort()).toEqual(["cs_fee_ok_1", "cs_fee_ok_2"]);

    // Cached per session: the next quote asks Stripe nothing.
    const quote = await commissionForJob(visitId, technicianId);
    expect(quote.amount).toBe(97);
    expect(mocks.retrieve).toHaveBeenCalledTimes(2);

    // The P&L reads the same balance transaction: the reader's net agrees with Stripe's.
    expect(await stripeFeeForSession("cs_fee_ok_1")).toMatchObject({ ok: true, fee: 9.97, net: 323.36, chargeId: "ch_cs_fee_ok_1" });
  });

  it("a fee Stripe cannot give is MISSING — shown with the reason, never $0 — and the route refuses to record", async () => {
    await cardPayment({ session: "cs_fee_ok_1", amount: 333.33, kind: "deposit", via: "estimate" });
    const pending = await cardPayment({ session: "cs_fee_pending", amount: 666.67, via: "estimate" });

    let basis = await commissionBasisForJob(visitId);
    expect(basis.feeRows.filter((f) => f.kind === "stripe")).toHaveLength(1);
    expect(basis.feeProblems).toEqual([{ paymentId: pending.id, amount: 666.67, reason: expect.stringMatching(/not settled/) }]);
    expect(basis.profit).toBeNull();
    expect(basis.commissionableProfit).toBeNull();
    expect(basis.missing).toEqual([expect.stringMatching(/card processing fee on the \$666\.67 card payment could not be read: .*not settled/)]);

    const refused = await request(app).post("/time/commissions").send({ technicianId, visitId, basis: "job_profit" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/could not be read/);
    expect(await prisma.commission.count({ where: { technicianId } })).toBe(0);

    // A key without read scope says so in words Kyle can act on.
    await prisma.payment.update({ where: { id: pending.id }, data: { stripeSessionId: "cs_fee_forbidden" } });
    basis = await commissionBasisForJob(visitId);
    expect(basis.feeProblems[0].reason).toMatch(/read scope/);
    expect(basis.profit).toBeNull();

    // A card payment with no session on it cannot be looked up at all.
    await prisma.payment.update({ where: { id: pending.id }, data: { stripeSessionId: null } });
    basis = await commissionBasisForJob(visitId);
    expect(basis.feeProblems[0].reason).toMatch(/no Stripe session/);
    expect(basis.profit).toBeNull();
  });

  it("with Stripe not configured, a card payment's fee is a problem on the basis, not $0", async () => {
    mocks.configured = false;
    const paid = await cardPayment({ session: "cs_fee_ok_1", amount: 1000, via: "estimate" });
    const basis = await commissionBasisForJob(visitId);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(basis.feeProblems).toEqual([{ paymentId: paid.id, amount: 1000, reason: "STRIPE_SECRET_KEY is not set." }]);
    expect(basis.profit).toBeNull();
  });
});
