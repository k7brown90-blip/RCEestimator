/**
 * Processing costs on the job (Kyle, 2026-10-09, ruling 6 of the one-estimating-system plan):
 * "Job card, account summary and job profitability subtract Synchrony's cut AND card processing
 * fees, so job profit agrees with the P&L and the commission card."
 *
 * CROSS-READER: for a financed job and a card-paid job, GET /jobs, GET /accounts/:id/summary,
 * /financials/job-profitability, /financials/summary (the P&L) and commissionBasisForJob all name
 * the same Synchrony's cut and the same card processing fees — one attribution
 * (services/jobProcessingCosts.ts), never a second. A card fee Stripe cannot give yet is PENDING
 * with the reason on every surface, never $0.
 *
 * No Stripe call leaves this file: the client is mocked at services/stripePayments with
 * checkout.sessions.retrieve (the per-payment fee) and balanceTransactions.list (the P&L's fee
 * rows), both answering off the same balance transactions.
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
  /** Balance transactions the P&L's stripeFeeRows pages through — keyed by charge id. */
  balanceTransactions: [] as Array<{ id: string; type: "charge" | "payment"; fee: number; net: number; created: number; source: string }>,
}));

vi.mock("../src/services/stripePayments", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/stripePayments")>();
  return {
    ...mod,
    stripeConfigured: () => true,
    stripe: () => ({
      checkout: { sessions: { retrieve: mocks.retrieve } },
      balanceTransactions: {
        list: (params: { type: "charge" | "payment" }) => ({
          async *[Symbol.asyncIterator]() {
            for (const tx of mocks.balanceTransactions.filter((t) => t.type === params.type)) yield tx;
          },
        }),
      },
    }),
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
import { commissionBasisForJob } from "../src/services/timeTracking";
import { processingCostsForJobs } from "../src/services/jobProcessingCosts";
import { resetStripeFeeCache, resetStripeSessionFeeCache } from "../src/services/treasury";

const MARK = "JPC6";
/** A year no other test records money in — the P&L assertions sum the whole year. */
const YEAR = 2039;
const round2 = (n: number) => Math.round(n * 100) / 100;

let customerId: string;
let propertyId: string;
let draftId: string;
let financedVisitId: string;
let cardVisitId: string;
let financedEstimateId: string;
let cardEstimateId: string;

/** What Stripe would return for `checkout.sessions.retrieve(id, { expand: [...] })`, per session. */
function session(id: string, tx: { fee: number; net: number; created: number } | "pending") {
  if (tx === "pending") return { id, payment_intent: { id: `pi_${id}`, latest_charge: null } };
  return {
    id,
    payment_intent: {
      id: `pi_${id}`,
      latest_charge: { id: `ch_${id}`, balance_transaction: { id: `txn_${id}`, fee: tx.fee, net: tx.net, created: tx.created } },
    },
  };
}
const JULY = Math.floor(Date.UTC(YEAR, 6, 10, 12) / 1000);
const FEES: Record<string, { fee: number; net: number; created: number } | "pending"> = {
  cs_jpc_dep: { fee: 997, net: 32336, created: JULY },
  cs_jpc_bal: { fee: 2003, net: 64664, created: JULY + 3600 },
  cs_jpc_pending: "pending",
};

async function issue(input: { suffix: string; visitId: string }) {
  return prisma.issuedEstimate.create({
    data: {
      number: `0000-${MARK}${input.suffix}`,
      token: `jpc6${input.suffix.charCodeAt(0).toString(16)}${Date.now().toString(16)}`.padEnd(64, "0"),
      status: "signed",
      draftId,
      customerId,
      serviceAddressId: propertyId,
      customerName: `${MARK} Customer`,
      customerEmail: "jpc6-customer@example.com",
      serviceAddress: "6 Processing Lane, Hermitage, TN",
      title: "Panel upgrade",
      scopeText: "Panel upgrade.",
      workSubtotal: 925,
      tripCharge: 75,
      total: 1000,
      sentAt: new Date(),
      sentTo: "jpc6-customer@example.com",
      visitId: input.visitId,
      jobVisitId: input.visitId,
      signedAt: new Date(Date.UTC(YEAR, 4, 1)),
      signerName: `${MARK} Customer`,
      signedChannel: "email",
      selectedOptions: ["A"],
      comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
      options: { create: [{ option: "A", label: "Panel", subtotal: 925, lineCount: 1 }] },
    },
  });
}

const cleanup = async () => {
  await prisma.payment.deleteMany({ where: { note: { startsWith: `${MARK} ` } } });
  const estIds = (await prisma.issuedEstimate.findMany({ where: { number: { startsWith: `0000-${MARK}` } }, select: { id: true } })).map((e) => e.id);
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: `${MARK} draft` } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: `${MARK}-SUP` } });
  await prisma.visit.deleteMany({ where: { purpose: { startsWith: `${MARK} ` } } });
  await prisma.property.deleteMany({ where: { name: `${MARK} property` } });
  await prisma.customer.deleteMany({ where: { name: `${MARK} Customer` } });
};

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "jpc6-customer@example.com" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} property`, addressLine1: "6 Processing Lane", city: "Hermitage", state: "TN", postalCode: "37076" },
  });
  propertyId = property.id;
  await prisma.priceBookSupplier.create({ data: { id: `${MARK}-SUP`, name: `${MARK} Supply`, quotable: "YES" } });
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} draft`, supplierId: `${MARK}-SUP` } });
  draftId = draft.id;
  const financed = await prisma.visit.create({
    data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} financed job`, status: "completed", completedAt: new Date(Date.UTC(YEAR, 5, 20)) },
  });
  financedVisitId = financed.id;
  const card = await prisma.visit.create({
    data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} card job`, status: "completed", completedAt: new Date(Date.UTC(YEAR, 6, 20)) },
  });
  cardVisitId = card.id;
  financedEstimateId = (await issue({ suffix: "F", visitId: financedVisitId })).id;
  cardEstimateId = (await issue({ suffix: "C", visitId: cardVisitId })).id;
});

afterAll(cleanup);

beforeEach(async () => {
  await prisma.payment.deleteMany({ where: { note: { startsWith: `${MARK} ` } } });
  resetStripeSessionFeeCache();
  resetStripeFeeCache();
  mocks.retrieve.mockReset();
  mocks.retrieve.mockImplementation(async (id: string) => {
    const tx = FEES[id];
    if (!tx) throw new Error(`No such checkout session: ${id}`);
    return session(id, tx);
  });
  mocks.balanceTransactions = Object.entries(FEES).flatMap(([id, tx]) =>
    tx === "pending" ? [] : [{ id: `txn_${id}`, type: "charge" as const, fee: tx.fee, net: tx.net, created: tx.created, source: `ch_${id}` }]);
});

const jobOf = async (visitId: string) => (await request(app).get("/jobs")).body.find((j: { visitId: string }) => j.visitId === visitId);
const accountJobOf = async (visitId: string) => (await request(app).get(`/accounts/${customerId}/summary`)).body.jobs.find((j: { visitId: string }) => j.visitId === visitId);
const profitRowOf = async (visitId: string) => (await request(app).get(`/financials/job-profitability?year=${YEAR}`)).body.find((r: { visitId: string }) => r.visitId === visitId);
const pl = async () => (await request(app).get(`/financials/summary?year=${YEAR}`)).body;

describe("Synchrony's cut and card processing fees come off the job on every surface, from one attribution", () => {
  it("a financed job: the job card, the account summary, job profitability, the P&L and the commission basis name the same cut", async () => {
    // The Synchrony payment as recordSynchronyPayment writes it: gross, the cut and the net captured.
    const paid = await prisma.payment.create({
      data: {
        customerId, estimateId: financedEstimateId, visitId: financedVisitId, note: `${MARK} synchrony`,
        amount: 1000, method: "synchrony", kind: "final", payer: "customer", status: "paid", paidAt: new Date(Date.UTC(YEAR, 5, 10)),
        financingPlanNumber: "965", financingAuthNumber: "SYN-1", financingCut: 30.5, financingNet: 969.5,
      },
    });

    const job = await jobOf(financedVisitId);
    expect(job, "a completed signed job is on the Jobs tab").toBeTruthy();
    expect(job.costs).toMatchObject({ revenue: 1000, materialCost: 0, laborCost: 0, overhead: 0, synchronyCut: 30.5, cardFees: 0, cardFeesPending: [] });
    expect(job.costs.totalCost).toBe(30.5);
    expect(job.costs.grossProfit).toBe(969.5);

    const accountJob = await accountJobOf(financedVisitId);
    expect(accountJob.costs).toEqual(job.costs);

    const row = await profitRowOf(financedVisitId);
    expect(row).toMatchObject({ quoted: 1000, synchronyCut: 30.5, cardFees: 0, cardFeesPending: [], margin: 969.5, marginBeforeLabor: 969.5 });

    const ledger = await pl();
    expect(ledger.months[5].synchronyCuts).toBe(30.5);
    expect(ledger.totals.synchronyCuts).toBe(job.costs.synchronyCut);

    const basis = await commissionBasisForJob(financedVisitId);
    expect(basis.feeRows.filter((f) => f.kind === "synchrony")).toEqual([{ kind: "synchrony", id: paid.id, label: "Synchrony's cut — Plan 965", category: "financing", amount: 30.5 }]);
    expect(basis.fees).toBe(job.costs.synchronyCut);
    expect(basis.profit).toBe(job.costs.grossProfit);

    // The one attribution, asked directly.
    const direct = (await processingCostsForJobs([{ visitId: financedVisitId, rootEstimateId: financedEstimateId }])).get(financedVisitId)!;
    expect(direct).toMatchObject({ synchronyCut: 30.5, cardFees: 0, cardFeesPending: [] });
    expect(direct.synchronyRows).toEqual([{ paymentId: paid.id, amount: 30.5, planNumber: "965" }]);
  });

  it("a card-paid job: the same Stripe fees, read off each payment's own balance transaction, on every surface", async () => {
    const deposit = await prisma.payment.create({
      data: { customerId, estimateId: cardEstimateId, note: `${MARK} card deposit`, amount: 333.33, method: "stripe", kind: "deposit", status: "paid", stripeSessionId: "cs_jpc_dep", paidAt: new Date(Date.UTC(YEAR, 6, 10, 12)) },
    });
    // The balance landed against the VISIT only (no invoice on the row) — attributed through the visit.
    const balance = await prisma.payment.create({
      data: { customerId, visitId: cardVisitId, note: `${MARK} card balance`, amount: 666.67, method: "stripe", kind: "final", status: "paid", stripeSessionId: "cs_jpc_bal", paidAt: new Date(Date.UTC(YEAR, 6, 10, 13)) },
    });
    // A check carries no card fee; a voided card payment is no money.
    await prisma.payment.create({ data: { customerId, estimateId: cardEstimateId, note: `${MARK} check`, amount: 50, method: "check", kind: "other", status: "paid", paidAt: new Date(Date.UTC(YEAR, 6, 11)) } });
    await prisma.payment.create({
      data: { customerId, estimateId: cardEstimateId, note: `${MARK} voided card`, amount: 100, method: "stripe", kind: "other", status: "paid", stripeSessionId: "cs_jpc_voided", paidAt: new Date(Date.UTC(YEAR, 6, 12)), voidedAt: new Date(), voidedBy: "human:crm-session", voidReason: "test" },
    });

    const job = await jobOf(cardVisitId);
    expect(job.costs).toMatchObject({ revenue: 1000, synchronyCut: 0, cardFees: 30, cardFeesPending: [] });
    expect(job.costs.totalCost).toBe(30);
    expect(job.costs.grossProfit).toBe(970);
    expect(job.costs.margin).toBe(97);
    // Each payment's fee was read once; the voided row and the check asked Stripe nothing.
    expect(mocks.retrieve.mock.calls.map((c) => c[0] as string).filter((id) => id.startsWith("cs_jpc")).sort()).toEqual(["cs_jpc_bal", "cs_jpc_dep"]);

    const accountJob = await accountJobOf(cardVisitId);
    expect(accountJob.costs).toEqual(job.costs);
    const summary = (await request(app).get(`/accounts/${customerId}/summary`)).body;
    // Lifetime cost rolls off the same per-job costs — processing costs included (financed job has none this test).
    expect(summary.totals.lifetimeCost).toBe(round2(summary.jobs.reduce((s: number, j: { costs: { totalCost: number } }) => s + j.costs.totalCost, 0)));

    const row = await profitRowOf(cardVisitId);
    expect(row).toMatchObject({ quoted: 1000, synchronyCut: 0, cardFees: 30, cardFeesPending: [], margin: 970, marginBeforeLabor: 970 });

    // The P&L reads the same balance transactions: July's Stripe fees are the job's card fees.
    const ledger = await pl();
    expect(ledger.feesAvailable).toBe(true);
    expect(ledger.months[6].stripeFees).toBe(30);
    expect(ledger.totals.stripeFees).toBe(job.costs.cardFees);

    const basis = await commissionBasisForJob(cardVisitId);
    expect(basis.feeRows.filter((f) => f.kind === "stripe")).toEqual([
      { kind: "stripe", id: deposit.id, category: "card_processing", amount: 9.97, label: expect.stringMatching(/^Card processing fee — \$333\.33 deposit paid by card/) },
      { kind: "stripe", id: balance.id, category: "card_processing", amount: 20.03, label: expect.stringMatching(/^Card processing fee — \$666\.67 final paid by card/) },
    ]);
    expect(basis.feeProblems).toEqual([]);
    expect(basis.fees).toBe(job.costs.cardFees);
    expect(basis.profit).toBe(job.costs.grossProfit);
  });

  it("a fee Stripe cannot give yet is PENDING with the reason on the job card, the account, the report and the commission — never $0", async () => {
    await prisma.payment.create({
      data: { customerId, estimateId: cardEstimateId, note: `${MARK} card deposit`, amount: 333.33, method: "stripe", kind: "deposit", status: "paid", stripeSessionId: "cs_jpc_dep", paidAt: new Date(Date.UTC(YEAR, 6, 10, 12)) },
    });
    const pending = await prisma.payment.create({
      data: { customerId, estimateId: cardEstimateId, note: `${MARK} card pending`, amount: 666.67, method: "stripe", kind: "final", status: "paid", stripeSessionId: "cs_jpc_pending", paidAt: new Date(Date.UTC(YEAR, 6, 15)) },
    });

    const job = await jobOf(cardVisitId);
    expect(job.costs.cardFees).toBe(9.97);
    expect(job.costs.cardFeesPending).toEqual([{ paymentId: pending.id, amount: 666.67, reason: expect.stringMatching(/not settled/) }]);
    // Computed from what IS known — the screen labels the profit "before pending card fees".
    expect(job.costs.totalCost).toBe(9.97);
    expect(job.costs.grossProfit).toBe(990.03);
    expect((await accountJobOf(cardVisitId)).costs).toEqual(job.costs);
    const row = await profitRowOf(cardVisitId);
    expect(row).toMatchObject({ cardFees: 9.97, margin: 990.03 });
    expect(row.cardFeesPending).toEqual(job.costs.cardFeesPending);

    // The commission pays real money, so it refuses to compute around the missing fee (rule 6).
    const basis = await commissionBasisForJob(cardVisitId);
    expect(basis.feeProblems).toEqual([{ paymentId: pending.id, amount: 666.67, reason: expect.stringMatching(/not settled/) }]);
    expect(basis.profit).toBeNull();
    expect(basis.feeRows.filter((f) => f.kind === "stripe").map((f) => f.amount)).toEqual([9.97]);
  });

  it("a card payment on a signed CHANGE ORDER of the job's invoice is the job's too — the same group paymentSummary sums", async () => {
    const changeOrder = await prisma.issuedEstimate.create({
      data: {
        number: `0000-${MARK}X`,
        token: `jpc6x${Date.now().toString(16)}`.padEnd(64, "0"),
        status: "signed", draftId, customerId, serviceAddressId: propertyId,
        customerName: `${MARK} Customer`, customerEmail: "jpc6-customer@example.com", serviceAddress: "6 Processing Lane, Hermitage, TN",
        title: "Add a circuit", scopeText: "Add a circuit.", workSubtotal: 200, tripCharge: 0, total: 200,
        sentAt: new Date(), sentTo: "jpc6-customer@example.com", visitId: cardVisitId, jobVisitId: cardVisitId,
        signedAt: new Date(Date.UTC(YEAR, 6, 5)), signerName: `${MARK} Customer`, signedChannel: "email",
        changeOrderForId: cardEstimateId, selectedOptions: ["A"],
        comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
        options: { create: [{ option: "A", label: "Circuit", subtotal: 200, lineCount: 1 }] },
      },
    });
    await prisma.payment.create({
      data: { customerId, estimateId: changeOrder.id, note: `${MARK} card on change order`, amount: 666.67, method: "stripe", kind: "final", status: "paid", stripeSessionId: "cs_jpc_bal", paidAt: new Date(Date.UTC(YEAR, 6, 10, 13)) },
    });
    const job = await jobOf(cardVisitId);
    expect(job.costs.cardFees).toBe(20.03);
    expect(job.costs.revenue).toBe(1200);
    expect((await commissionBasisForJob(cardVisitId)).fees).toBe(20.03);
    await prisma.payment.deleteMany({ where: { estimateId: changeOrder.id } });
    await prisma.issuedEstimate.delete({ where: { id: changeOrder.id } });
  });
});
