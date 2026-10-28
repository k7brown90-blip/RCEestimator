/**
 * The financing fee and the Synchrony payment (Kyle, 2026-10-08, one-estimating-system plan
 * decisions 7, 8, 11 and 12; Phase 6 Unit 6A).
 *
 * What these pin:
 *   1. FEE MATH comes from shared/financing.ts (never a second formula), on the balance AFTER the
 *      deposit; the fee stays OUT of billedTotal and depositDue; the balance carries it.
 *   2. DECISION 8: no deposit collected (or no deposit required) → no fee, with the reason.
 *   3. THE CARD PATH NEVER SEES THE FEE: chargeableAmount / /pay/:token refuse while a fee is on;
 *      a cash/check record is refused too; the field QR payload carries the fee read-only.
 *   4. CROSS-READER: paymentSummary, GET /invoices, GET /jobs, the account summary, job
 *      profitability, the P&L's invoiced, the commission basis, the field payment-info and the
 *      final-bill email all agree on the fee-inclusive balance / fee-inclusive revenue.
 *   5. THE SYNCHRONY PAYMENT: gross closes the invoice, Synchrony's cut (full rate) and the net
 *      are captured, the cut is a P&L expense, bank matching matches the NET, the fee LOCKS.
 *   6. VOIDING the Synchrony payment (6B) unlocks the fee; removing the fee reopens the card path.
 *   7. A signed revision taking over the invoice carries the fee with it.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { chargeableAmount, paymentSummary } from "../src/services/stripePayments";
import { getActiveFinancingPlans } from "../src/services/financingSettings";
import { dollarsToCents, financingFeeCents, lenderCutCents } from "../shared/financing";
import { candidatesFor, loadClassifyContext } from "../src/services/bankStatements";
import { adoptSupersededInvoice } from "../src/services/issuedEstimateService";
import { commissionBasisForJob } from "../src/services/timeTracking";
import { FINANCING_IN_PROGRESS, FinancingFeeError, applyFinancingFee, recordSynchronyPayment, removeFinancingFee } from "../src/services/financingFee";
import { sweepInvoiceReminders } from "../src/services/invoiceReminders";

delete process.env.STRIPE_SECRET_KEY;
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
}));
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
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
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { sendInvoiceEmail } from "../src/services/issuedEstimateSend";

const MARK = "FFEE";
/** A year no other test records money in — the P&L assertions sum the whole year. */
const LEDGER_YEAR = 2018;
const ORIGIN = "https://unused.invalid";
const round2 = (n: number) => Math.round(n * 100) / 100;

let customerId: string;
let propertyId: string;
let draftId: string;
let techToken: string;
let technicianId: string;

const cleanup = async () => {
  const estIds = (await prisma.issuedEstimate.findMany({ where: { number: { startsWith: `0000-${MARK}` } }, select: { id: true } })).map((e) => e.id);
  await prisma.payment.deleteMany({ where: { OR: [{ estimateId: { in: estIds } }, { note: { startsWith: `${MARK} ` } }] } });
  await prisma.financingFee.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: `${MARK} draft` } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: `${MARK}-SUP` } });
  await prisma.visitAssignment.deleteMany({ where: { visit: { purpose: `${MARK} visit` } } });
  await prisma.visit.deleteMany({ where: { purpose: `${MARK} visit` } });
  await prisma.property.deleteMany({ where: { name: `${MARK} property` } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: `${MARK} Customer` } } });
  await prisma.technician.deleteMany({ where: { name: `${MARK} Tech` } });
  await prisma.systemEvent.deleteMany({ where: { message: { contains: `0000-${MARK}` } } });
};

/** A $425 signed estimate (trip $75 + $350 option A) — deposit ⅓ = $141.67, balance after it $283.33. */
async function issue(input: { suffix: string; visitId?: string | null; depositRequired?: boolean; signedAt?: Date; supersedesId?: string }) {
  return prisma.issuedEstimate.create({
    data: {
      number: `0000-${MARK}${input.suffix}`,
      // 64 hex characters — the shape /e/:token insists on (getEstimateByToken).
      token: `ffee${input.suffix.charCodeAt(0).toString(16)}${input.supersedesId ? "b" : "a"}${Date.now().toString(16)}`.padEnd(64, "0"),
      status: "signed",
      draftId,
      customerId,
      serviceAddressId: propertyId,
      customerName: `${MARK} Customer`,
      customerEmail: "ffee-customer@example.com",
      serviceAddress: "12 Finance Lane, Hermitage, TN",
      title: "Panel upgrade",
      scopeText: "Panel upgrade.",
      workSubtotal: 350,
      tripCharge: 75,
      total: 425,
      sentAt: new Date(),
      sentTo: "ffee-customer@example.com",
      visitId: input.visitId ?? null,
      jobVisitId: input.visitId ?? null,
      signedAt: input.signedAt ?? new Date(),
      signerName: `${MARK} Customer`,
      signedChannel: "email",
      depositRequired: input.depositRequired ?? true,
      ...(input.supersedesId ? { supersedesId: input.supersedesId, revision: 2 } : {}),
      selectedOptions: ["A"],
      comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
      options: { create: [{ option: "A", label: "Panel", subtotal: 350, lineCount: 2 }] },
    },
  });
}

const summaryOf = (id: string) => paymentSummary(prisma, id, ORIGIN);
const record = (body: Record<string, unknown>) => request(app).post("/financials/payments").send(body);
const addFee = (estimateId: string, planNumber: string) => request(app).post("/financials/financing-fees").send({ estimateId, planNumber });
const removeFee = (id: string, reason?: string) => request(app).post(`/financials/financing-fees/${id}/remove`).send(reason === undefined ? {} : { reason });
const voidIt = (id: string, reason: string) => request(app).post(`/financials/payments/${id}/void`).send({ reason });
const depositOn = (estimateId: string) => record({ amount: 141.67, method: "cash", kind: "deposit", estimateId, customerId, paidAt: `${LEDGER_YEAR}-05-01T12:00:00.000Z` });

/** The plan the office picks: the first active one in Settings (the seeded defaults unless a test left a list). */
async function firstPlan() {
  const plans = await getActiveFinancingPlans();
  expect(plans.length).toBeGreaterThan(0);
  return plans[0];
}

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "ffee-customer@example.com" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} property`, addressLine1: "12 Finance Lane", city: "Hermitage", state: "TN", postalCode: "37076" },
  });
  propertyId = property.id;
  await prisma.priceBookSupplier.create({ data: { id: `${MARK}-SUP`, name: `${MARK} Supply`, quotable: "YES" } });
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} draft`, supplierId: `${MARK}-SUP` } });
  draftId = draft.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `ffee-tech-${customer.id}`, role: "technician" } });
  technicianId = tech.id;
  techToken = tech.accessToken;
});

afterAll(cleanup);

// ─── 1-5. The whole path on one invoice, every reader checked at each step ───────────────────

describe("the financing fee, the Synchrony payment, and every reader in between", () => {
  it("fee from the shared calculator on the balance after the deposit; out of the deposit; the card path closed; every reader agrees; the Synchrony payment closes it net of the cut; void unlocks; remove reopens", async () => {
    const plan = await firstPlan();
    const visit = await prisma.visit.create({
      data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} visit`, status: "scheduled" },
    });
    const est = await issue({ suffix: "1", visitId: visit.id });

    // DECISION 8 — the deposit first.
    const noDeposit = await addFee(est.id, plan.planNumber);
    expect(noDeposit.status).toBe(409);
    expect(noDeposit.body.error).toMatch(/deposit has not been collected/);
    const opts0 = await request(app).get(`/financials/financing-fees/options?estimateId=${est.id}`);
    expect(opts0.status).toBe(200);
    expect(opts0.body.blockedReason).toMatch(/deposit/);

    expect((await depositOn(est.id)).status).toBe(201);
    const before = (await summaryOf(est.id))!;
    expect(before).toMatchObject({ balance: 283.33, balanceBeforeFee: 283.33, financingFee: null, depositSatisfied: true });

    // The options the panel shows: each plan's fee on the balance — from the one calculator.
    const opts = await request(app).get(`/financials/financing-fees/options?estimateId=${est.id}`);
    expect(opts.body.blockedReason).toBeNull();
    expect(opts.body.balance).toBe(283.33);
    const expectedFee = financingFeeCents(dollarsToCents(283.33), plan.discountRatePct) / 100;
    const shown = opts.body.options.find((o: { planNumber: string }) => o.planNumber === plan.planNumber);
    expect(shown).toMatchObject({ fee: expectedFee, financed: round2(283.33 + expectedFee) });
    // No rate rides on the options payload.
    expect(JSON.stringify(opts.body)).not.toMatch(/discountRatePct|paymentFactorPct/);

    // An unknown plan is refused; the real one is applied.
    expect((await addFee(est.id, "000")).status).toBe(400);
    const applied = await addFee(est.id, plan.planNumber);
    expect(applied.status).toBe(201);
    expect(applied.body).toMatchObject({ planNumber: plan.planNumber, fee: expectedFee, feeBase: 283.33, locked: false });
    expect(JSON.stringify(applied.body)).not.toMatch(/discountRatePct/);
    const feeId = applied.body.id as string;
    // A second press cannot make a second fee.
    expect((await addFee(est.id, plan.planNumber)).status).toBe(409);

    // 1. The fee is OUT of billedTotal and depositDue, IN the balance.
    const withFee = (await summaryOf(est.id))!;
    const owed = round2(283.33 + expectedFee);
    expect(withFee).toMatchObject({
      billedTotal: 425, depositDue: 141.67, totalPaid: 141.67,
      balanceBeforeFee: 283.33, balance: owed, paidInFull: false, depositSatisfied: true,
    });
    expect(withFee.financingFee).toMatchObject({ id: feeId, planNumber: plan.planNumber, fee: expectedFee, locked: false });

    // 3. THE CARD PATH NEVER SEES THE FEE.
    const charge = await chargeableAmount(prisma, est.token, "balance");
    expect(charge.ok).toBe(false);
    expect((charge as { reason: string }).reason).toContain(FINANCING_IN_PROGRESS);
    const payPage = await request(app).get(`/pay/${est.token}`);
    expect(payPage.status).toBe(400);
    expect(payPage.text).toContain(FINANCING_IN_PROGRESS);
    expect(payPage.text).not.toContain(owed.toFixed(2));
    const checkout = await request(app).get(`/pay/${est.token}/checkout`);
    expect(checkout.status).toBe(400);
    // A check for the plain balance is refused too — it would leave the fee owing.
    const cash = await record({ amount: 283.33, method: "check", kind: "final", estimateId: est.id, customerId });
    expect(cash.status).toBe(409);
    expect(cash.body.error).toContain(FINANCING_IN_PROGRESS);

    // 4. CROSS-READER.
    const inv = await request(app).get("/invoices");
    const row = inv.body.find((i: { id: string }) => i.id === est.id);
    expect(row).toMatchObject({ billedTotal: 425, depositDue: 141.67, totalPaid: 141.67, balance: owed, paymentStatus: "deposit_paid" });
    expect(row.financingFee).toMatchObject({ id: feeId, planNumber: plan.planNumber, fee: expectedFee, locked: false });

    const revenueWithFee = round2(425 + expectedFee);
    const jobs = await request(app).get("/jobs");
    const job = jobs.body.find((j: { visitId: string }) => j.visitId === visit.id);
    expect(job, "the deposit gate is a third of the documents, never of the fee").toBeTruthy();
    expect(job.costs.revenue).toBe(revenueWithFee);
    const account = await request(app).get(`/accounts/${customerId}/summary`);
    const accountJob = account.body.jobs.find((j: { visitId: string }) => j.visitId === visit.id);
    expect(accountJob.costs).toEqual(job.costs);
    const profit = await request(app).get(`/financials/job-profitability?year=${new Date().getFullYear()}`);
    const profitRow = profit.body.find((r: { visitId: string }) => r.visitId === visit.id);
    expect(profitRow.quoted).toBe(revenueWithFee);
    const basis = await commissionBasisForJob(visit.id);
    expect(basis.revenue).toBe(revenueWithFee);
    expect(basis.financingFee).toBe(expectedFee);

    // The P&L: the fee is invoiced in the month it was applied, as its own line.
    await prisma.financingFee.update({ where: { id: feeId }, data: { appliedAt: new Date(`${LEDGER_YEAR}-05-02T12:00:00.000Z`) } });
    const pl = await request(app).get(`/financials/summary?year=${LEDGER_YEAR}`);
    expect(pl.body.months[4].invoiced).toBe(expectedFee); // the estimate itself was signed this year, not 2018
    expect(pl.body.totals.collected).toBe(141.67);

    // The field: the fee read-only, the balance with it, the reason — and no rate, no QR offered by the server's words.
    await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
    const field = await request(app).get(`/health-record/visits/${visit.id}/payment-info`).set("Authorization", `Bearer ${techToken}`);
    expect(field.status).toBe(200);
    expect(field.body.data).toMatchObject({ balance: owed, paidInFull: false });
    expect(field.body.data.financing).toMatchObject({ planNumber: plan.planNumber, fee: expectedFee, reason: FINANCING_IN_PROGRESS });
    expect(field.text).not.toMatch(/discountRatePct|feeBase|lenderCut/);

    // The final bill: the fee as its own line, the fee-inclusive balance, and NO pay link.
    emailMock.sendBrandedEmail.mockClear();
    const bill = await sendInvoiceEmail(prisma, est.id, { sentBy: "test" });
    expect(bill).toMatchObject({ ok: true, amount: owed });
    const html = emailMock.sendBrandedEmail.mock.calls[0][0].bodyHtml as string;
    expect(html).toContain(`Financing fee — Plan ${plan.planNumber}`);
    expect(html).toContain(`$${expectedFee.toFixed(2)}`);
    expect(html).toContain(`$${owed.toFixed(2)}`);
    expect(html).not.toContain("/pay/");
    expect(html).toContain("Synchrony");

    // The customer's own page (/e/:token): the fee as its own line, the balance with it, no rate, and
    // the deposit block says the balance is going through Synchrony rather than "due at completion".
    const page = await request(app).get(`/e/${est.token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`Financing fee — Plan ${plan.planNumber}`);
    expect(page.text).toContain(`$${owed.toFixed(2)}`);
    expect(page.text).toContain("being paid through your Synchrony financing");
    expect(page.text).not.toMatch(/discountRatePct|feeBase/);

    // Reminders pause while the balance is financed (the pay link is closed).
    await prisma.visit.update({ where: { id: visit.id }, data: { status: "completed", completedAt: new Date(Date.now() - 30 * 86400_000) } });
    await prisma.issuedEstimate.update({ where: { id: est.id }, data: { signedAt: new Date(Date.now() - 30 * 86400_000) } });
    await prisma.payment.updateMany({ where: { estimateId: est.id }, data: { paidAt: new Date(Date.now() - 30 * 86400_000) } });
    process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS = "on";
    try {
      emailMock.sendBrandedEmail.mockClear();
      await sweepInvoiceReminders(prisma);
      expect(emailMock.sendBrandedEmail.mock.calls.some((c) => c[0].issuedEstimateId === est.id)).toBe(false);
    } finally {
      delete process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS;
    }
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).paymentRemindersSent).toBe(0);
    await prisma.payment.updateMany({ where: { estimateId: est.id }, data: { paidAt: new Date(`${LEDGER_YEAR}-05-01T12:00:00.000Z`) } });

    // 5. THE SYNCHRONY PAYMENT — needs the authorization number; the plan must be the fee's.
    expect((await record({ amount: owed, method: "synchrony", estimateId: est.id })).status).toBe(400);
    const wrongPlan = await record({ amount: owed, method: "synchrony", estimateId: est.id, planNumber: "000", authNumber: "A1" });
    expect(wrongPlan.status).toBe(409);
    expect(wrongPlan.body.error).toMatch(/remove the fee and add it again/);
    const tooMuch = await record({ amount: owed + 1, method: "synchrony", estimateId: est.id, planNumber: plan.planNumber, authNumber: "A1" });
    expect(tooMuch.status).toBe(409);
    expect((await record({ amount: owed, method: "synchrony", payer: "warranty", estimateId: est.id, authNumber: "A1" })).status).toBe(400);

    const paid = await record({ amount: owed, method: "synchrony", estimateId: est.id, planNumber: plan.planNumber, authNumber: "SYN-12345", paidAt: `${LEDGER_YEAR}-06-10T12:00:00.000Z` });
    expect(paid.status).toBe(201);
    const cut = lenderCutCents(dollarsToCents(owed), plan.discountRatePct) / 100;
    const net = round2(owed - cut);
    expect(paid.body).toMatchObject({
      method: "synchrony", amount: owed, kind: "final", payer: "customer", status: "paid",
      financingFeeId: feeId, financingPlanNumber: plan.planNumber, financingAuthNumber: "SYN-12345", financingCut: cut, financingNet: net,
    });
    const closed = (await summaryOf(est.id))!;
    expect(closed).toMatchObject({ totalPaid: round2(141.67 + owed), balance: 0, paidInFull: true, fullyPaid: true });
    expect(closed.financingFee).toMatchObject({ id: feeId, locked: true, lockedByPaymentId: paid.body.id });
    expect(closed.payments.find((p) => p.id === paid.body.id)).toMatchObject({ financingAuthNumber: "SYN-12345", financingNet: net, financingCut: cut });
    const invPaid = (await request(app).get("/invoices")).body.find((i: { id: string }) => i.id === est.id);
    expect(invPaid).toMatchObject({ balance: 0, paymentStatus: "paid", collected: round2(141.67 + owed) });

    // Locked: the fee cannot be removed while the payment stands.
    const locked = await removeFee(feeId, "changed their mind");
    expect(locked.status).toBe(409);
    expect(locked.body.error).toMatch(/void that payment first/);
    // A second Synchrony payment against the same fee is refused.
    expect((await record({ amount: 1, method: "synchrony", estimateId: est.id, planNumber: plan.planNumber, authNumber: "X" })).status).toBe(409);

    // The P&L: collected GROSS, the cut as its own expense.
    const plPaid = await request(app).get(`/financials/summary?year=${LEDGER_YEAR}`);
    expect(plPaid.body.totals.collected).toBe(round2(141.67 + owed));
    expect(plPaid.body.months[5].synchronyCuts).toBe(cut);
    expect(plPaid.body.totals.synchronyCuts).toBe(cut);
    expect(plPaid.body.expensesByCategory.find((c: { category: string }) => c.category === "synchrony_cuts")).toMatchObject({ total: cut });
    expect(plPaid.body.months[5].expenses).toBeGreaterThanOrEqual(cut);

    // Bank matching: the statement shows the NET; the gross never matches.
    const ctx = await loadClassifyContext(prisma, [LEDGER_YEAR]);
    const line = { accountId: "acct", postedAt: new Date(`${LEDGER_YEAR}-06-12T12:00:00.000Z`), amount: net, description: "SYNCHRONY FUNDING", bankType: null, payeeKey: "synchrony" };
    expect(candidatesFor(line, ctx).payments.find((p) => p.id === paid.body.id)).toMatchObject({ amount: net, method: "synchrony" });
    expect(candidatesFor({ ...line, amount: owed }, ctx).payments.find((p) => p.id === paid.body.id)).toBeUndefined();

    // The commission basis: the cut is a fee of the job, shown as its own row.
    const basisPaid = await commissionBasisForJob(visit.id);
    expect(basisPaid.feeRows.find((f) => f.kind === "synchrony")).toMatchObject({ id: paid.body.id, amount: cut });
    expect(basisPaid.fees).toBe(cut);
    expect(basisPaid.profit).toBe(round2(revenueWithFee - basisPaid.materialCost - cut));

    // THE JOB CARD, THE ACCOUNT SUMMARY AND JOB PROFITABILITY subtract the cut too (Kyle,
    // 2026-10-09, ruling 6) — its own field, inside the cost, so the job's profit agrees with the
    // commission basis and the P&L. Deliberately updated: before this ruling the job card added the
    // fee to revenue and never subtracted what Synchrony kept.
    const jobPaid = (await request(app).get("/jobs")).body.find((j: { visitId: string }) => j.visitId === visit.id);
    expect(jobPaid.costs).toMatchObject({ revenue: revenueWithFee, synchronyCut: cut, cardFees: 0, cardFeesPending: [] });
    expect(jobPaid.costs.totalCost).toBe(round2(jobPaid.costs.materialCost + jobPaid.costs.laborCost + jobPaid.costs.overhead + cut));
    expect(jobPaid.costs.grossProfit).toBe(round2(revenueWithFee - jobPaid.costs.totalCost));
    expect(jobPaid.costs.grossProfit).toBe(basisPaid.profit); // no labor, no material: the two profits are the same number
    const accountPaid = (await request(app).get(`/accounts/${customerId}/summary`)).body.jobs.find((j: { visitId: string }) => j.visitId === visit.id);
    expect(accountPaid.costs).toEqual(jobPaid.costs);
    // The visit was completed 30 days ago above — the report year is that date's, not today's.
    const profitPaid = (await request(app).get(`/financials/job-profitability?year=${new Date(Date.now() - 30 * 86400_000).getFullYear()}`)).body.find((r: { visitId: string }) => r.visitId === visit.id);
    expect(profitPaid).toMatchObject({ quoted: revenueWithFee, synchronyCut: cut, cardFees: 0, cardFeesPending: [] });
    expect(profitPaid.margin).toBe(round2(revenueWithFee - profitPaid.materialSpend - profitPaid.laborCost - cut));
    expect(profitPaid.marginBeforeLabor).toBe(round2(revenueWithFee - profitPaid.materialSpend - cut));

    // The audit trail.
    const events = await prisma.issuedEstimateEvent.findMany({ where: { estimateId: est.id }, select: { type: true } });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["financing_fee_applied", "synchrony_payment"]));

    // 6. VOID (6B) unlocks the fee; the balance reopens fee-inclusive; the cut leaves the P&L.
    const voided = await voidIt(paid.body.id, "Synchrony reversed the funding");
    expect(voided.status).toBe(200);
    const reopened = (await summaryOf(est.id))!;
    expect(reopened).toMatchObject({ balance: owed, paidInFull: false });
    expect(reopened.financingFee).toMatchObject({ id: feeId, locked: false, lockedByPaymentId: null });
    expect((await request(app).get(`/financials/summary?year=${LEDGER_YEAR}`)).body.totals.synchronyCuts).toBe(0);
    expect((await commissionBasisForJob(visit.id)).feeRows.find((f) => f.kind === "synchrony")).toBeUndefined();

    // Remove the fee — reason required — and the card path is open again at the plain balance.
    expect((await removeFee(feeId)).status).toBe(400);
    expect((await removeFee(feeId, "   ")).status).toBe(400);
    const removed = await removeFee(feeId, "Customer declined by Synchrony — paying by check");
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ ok: true, id: feeId, removeReason: "Customer declined by Synchrony — paying by check" });
    expect((await removeFee(feeId, "again")).status).toBe(409);
    const plain = (await summaryOf(est.id))!;
    expect(plain).toMatchObject({ balance: 283.33, balanceBeforeFee: 283.33, financingFee: null });
    expect(await chargeableAmount(prisma, est.token, "balance")).toMatchObject({ ok: true, amount: 283.33 });
    expect((await commissionBasisForJob(visit.id)).revenue).toBe(425);
    const feeRow = await prisma.financingFee.findUniqueOrThrow({ where: { id: feeId } });
    expect(feeRow.removedAt).toBeTruthy(); // kept, never deleted
    expect((await prisma.issuedEstimateEvent.findMany({ where: { estimateId: est.id, type: "financing_fee_removed" } })).length).toBe(1);
    // With the fee gone, a check closes the plain balance.
    expect((await record({ amount: 283.33, method: "check", kind: "final", estimateId: est.id, customerId })).status).toBe(201);
    expect((await summaryOf(est.id))!.paidInFull).toBe(true);
    // 30s, not the default 5s (2026-10-27): the invoice send in the middle of this walk is now THE
    // invoice email (it renders the itemized PDF) instead of a PDF-less bill, which is the point of
    // the change and adds real time to a test that already does a dozen route calls.
  }, 30_000);
});

// ─── 2. Decision 8, the other refusals ──────────────────────────────────────────────────────

describe("refusals", () => {
  it("no deposit REQUIRED is no financing either — no no-deposit financing", async () => {
    const plan = await firstPlan();
    const est = await issue({ suffix: "2", depositRequired: false });
    const res = await addFee(est.id, plan.planNumber);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no no-deposit financing/);
    await expect(applyFinancingFee(prisma, est.id, plan.planNumber)).rejects.toBeInstanceOf(FinancingFeeError);
  });

  it("a paid-in-full invoice has nothing to finance; a Synchrony payment without a fee is refused", async () => {
    const plan = await firstPlan();
    const est = await issue({ suffix: "3" });
    expect((await depositOn(est.id)).status).toBe(201);
    await expect(recordSynchronyPayment(prisma, { estimateId: est.id, authNumber: "A" })).rejects.toMatchObject({ statusCode: 409 });
    const syn = await record({ amount: 283.33, method: "synchrony", estimateId: est.id, authNumber: "A" });
    expect(syn.status).toBe(409);
    expect(syn.body.error).toMatch(/Add the financing fee first/);
    expect((await record({ amount: 283.33, method: "check", estimateId: est.id, customerId })).status).toBe(201);
    const res = await addFee(est.id, plan.planNumber);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/paid in full/);
  });

  it("404 for an unknown estimate or fee; the service throws the same typed errors", async () => {
    expect((await addFee("no-such-estimate", "965")).status).toBe(404);
    expect((await removeFee("no-such-fee", "why")).status).toBe(404);
    expect((await request(app).get("/financials/financing-fees/options?estimateId=no-such")).status).toBe(404);
    await expect(removeFinancingFee(prisma, "no-such-fee", "why")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("there is NO technician route for the fee or the Synchrony payment", async () => {
    const est = await issue({ suffix: "4" });
    for (const path of ["/health-record/financing-fees", "/health-record/financials/financing-fees", `/health-record/financials/payments`]) {
      const res = await request(app).post(path).set("Authorization", `Bearer ${techToken}`).send({ estimateId: est.id, planNumber: "965", method: "synchrony" });
      expect(res.status, path).toBe(404);
    }
  });
});

// ─── 7. A signed revision carries the fee ───────────────────────────────────────────────────

describe("a signed revision takes over the invoice — the fee moves with it", () => {
  it("adoptSupersededInvoice re-points the fee record (live and removed alike) at the revision", async () => {
    const plan = await firstPlan();
    const root = await issue({ suffix: "5" });
    expect((await depositOn(root.id)).status).toBe(201);
    const applied = await addFee(root.id, plan.planNumber);
    expect(applied.status).toBe(201);

    const rev = await issue({ suffix: "5", supersedesId: root.id });
    const adopted = await prisma.$transaction((tx) => adoptSupersededInvoice(tx, rev.id, "customer"));
    expect(adopted?.replaced.map((r) => r.id)).toEqual([root.id]);

    const fee = await prisma.financingFee.findUniqueOrThrow({ where: { id: applied.body.id } });
    expect(fee.estimateId).toBe(rev.id);
    const s = (await summaryOf(rev.id))!;
    expect(s.estimateId).toBe(rev.id);
    expect(s.financingFee).toMatchObject({ id: applied.body.id, fee: applied.body.fee });
    expect(s.balance).toBe(round2(283.33 + applied.body.fee));
    expect(s.totalPaid).toBe(141.67);
    const old = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: root.id } });
    expect(old.status).toBe("void");
    expect(old.voidReason).toContain("financing fee record");
  });
});
