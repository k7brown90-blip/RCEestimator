/**
 * Phase 6 review fixes (2026-10-09, one-estimating-system plan) — the money-path findings on the
 * financing fee, the Synchrony payment, the payment void and the commission, each pinned here.
 *
 * What these pin:
 *   1. A LOCKED fee opens every rail again. After the Synchrony payment is recorded the fee is PAID;
 *      a deposit check that bounces and is voided after that is plain invoice money — the check,
 *      the card path (chargeableAmount), the deposit request, the reminder and the field QR are all
 *      open for it. Only an UNPAID fee (financingInProgress) closes them.
 *   2. NO PARTIAL RELEASES (decision 8): a Synchrony amount below what is owed is refused.
 *   3. DECISION 7 holds only on the fee's base: a balance that drifted off it refuses the record,
 *      with the "remove the fee and add it again" exit.
 *   4. The deposit-request email is refused ON THE SERVER while financing is in progress — the CRM
 *      route, the field route and the service itself — not only greyed on the screen.
 *   5. The customer's page never shows a working-looking "Pay your deposit" while the link is closed,
 *      and a financed customer still reads "due upon receipt" (Structure item 4: everyone).
 *   6. The financed final bill says HOW to pay (release the funds), never "nothing to pay here".
 *   7. The PDF appendix prints the fee as its own line and prints at all on a one-document financed
 *      invoice (plan Detail B item J).
 *   8. Undoing an office acceptance is refused while a live fee is on the estimate.
 *   9. The P&L counts ONE live fee per invoice (the newest), like every other reader.
 *  10. Two voids racing each other: exactly one lands; the other is told the row was already void.
 *  11. A bank deposit already confirmed as the voided payment goes back to the review queue.
 *  12. Commission: a job-profit commission is recorded ONCE per tech per job; open or flagged-
 *      unconfirmed hours are MISSING (profit null, the button greyed), never $0.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { chargeableAmount, paymentSummary } from "../src/services/stripePayments";
import { getActiveFinancingPlans } from "../src/services/financingSettings";
import { dollarsToCents, financingFeeCents } from "../shared/financing";
import { FINANCING_IN_PROGRESS, financingInProgress, removeFinancingFee } from "../src/services/financingFee";
import { PaymentVoidError, voidPayment } from "../src/services/paymentVoid";
import { undoOfficeAcceptance } from "../src/services/officeAcceptance";
import { commissionBasisForJob } from "../src/services/timeTracking";
import { BALANCE_DUE_TERMS } from "../src/services/paymentTerms";
import { sendInvoiceReminder } from "../src/services/invoiceReminders";

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
import { sendBalanceRequestEmail, sendDepositRequestEmail } from "../src/services/paymentReceipts";

const MARK = "P6RF";
/** A year no other test records money in — the P&L assertion sums the whole year. */
const LEDGER_YEAR = 2017;
const ORIGIN = "https://unused.invalid";
const round2 = (n: number) => Math.round(n * 100) / 100;
const HOUR = 3600_000;

let customerId: string;
let propertyId: string;
let draftId: string;
let techToken: string;
let technicianId: string;

const cleanup = async () => {
  const estIds = (await prisma.issuedEstimate.findMany({ where: { number: { startsWith: `0000-${MARK}` } }, select: { id: true } })).map((e) => e.id);
  await prisma.bankAccount.deleteMany({ where: { name: `${MARK} Checking` } });
  await prisma.payment.deleteMany({ where: { OR: [{ estimateId: { in: estIds } }, { note: { startsWith: `${MARK} ` } }] } });
  await prisma.financingFee.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { title: `${MARK} draft` } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: `${MARK}-SUP` } });
  await prisma.commission.deleteMany({ where: { technician: { name: `${MARK} Tech` } } });
  await prisma.timeEntry.deleteMany({ where: { visit: { purpose: `${MARK} visit` } } });
  await prisma.visitAssignment.deleteMany({ where: { visit: { purpose: `${MARK} visit` } } });
  await prisma.visit.deleteMany({ where: { purpose: `${MARK} visit` } });
  await prisma.property.deleteMany({ where: { name: `${MARK} property` } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: `${MARK} Customer` } } });
  await prisma.technician.deleteMany({ where: { name: `${MARK} Tech` } });
  await prisma.systemEvent.deleteMany({ where: { message: { contains: `0000-${MARK}` } } });
};

/** A $425 signed estimate (trip $75 + $350 option A) — deposit 1/3 = $141.67, balance after it $283.33. */
async function issue(suffix: string, opts: { visitId?: string | null; signedChannel?: string } = {}) {
  return prisma.issuedEstimate.create({
    data: {
      number: `0000-${MARK}${suffix}`,
      // 64 hex characters — the shape /e/:token insists on (getEstimateByToken).
      token: `c6${suffix.charCodeAt(0).toString(16)}${Date.now().toString(16)}`.padEnd(64, "0"),
      status: "signed",
      draftId,
      customerId,
      serviceAddressId: propertyId,
      customerName: `${MARK} Customer`,
      customerEmail: "p6rf-customer@example.com",
      serviceAddress: "6 Review Lane, Hermitage, TN",
      title: "Panel upgrade",
      scopeText: "Panel upgrade.",
      workSubtotal: 350,
      tripCharge: 75,
      total: 425,
      sentAt: new Date(),
      sentTo: "p6rf-customer@example.com",
      visitId: opts.visitId ?? null,
      jobVisitId: opts.visitId ?? null,
      signedAt: new Date(),
      signerName: `${MARK} Customer`,
      signedChannel: opts.signedChannel ?? "email",
      ...(opts.signedChannel === "office" ? { acceptedVia: "phone", acceptedNote: "said yes on the phone" } : {}),
      depositRequired: true,
      selectedOptions: ["A"],
      comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
      options: { create: [{ option: "A", label: "Panel", subtotal: 350, lineCount: 2 }] },
    },
  });
}

const summaryOf = (id: string) => paymentSummary(prisma, id, ORIGIN);
const record = (body: Record<string, unknown>) => request(app).post("/financials/payments").send(body);
const addFee = (estimateId: string, planNumber: string) => request(app).post("/financials/financing-fees").send({ estimateId, planNumber });
const voidIt = (id: string, reason: string) => request(app).post(`/financials/payments/${id}/void`).send({ reason });
const depositOn = (estimateId: string) => record({ amount: 141.67, method: "check", kind: "deposit", estimateId, customerId, checkNumber: "1001", paidAt: `${LEDGER_YEAR}-05-01T12:00:00.000Z` });
const recordSynchrony = (estimateId: string, amount: number, planNumber: string, auth = "SYN-1") =>
  record({ amount, method: "synchrony", estimateId, planNumber, authNumber: auth, paidAt: `${LEDGER_YEAR}-06-10T12:00:00.000Z` });

async function firstPlan() {
  const plans = await getActiveFinancingPlans();
  expect(plans.length).toBeGreaterThan(0);
  return plans[0];
}

/** Deposit in, fee on — the state every scenario below starts from. Returns the fee and the amount owed. */
async function financed(estimateId: string) {
  const plan = await firstPlan();
  const dep = await depositOn(estimateId);
  expect(dep.status).toBe(201);
  const applied = await addFee(estimateId, plan.planNumber);
  expect(applied.status).toBe(201);
  const fee = financingFeeCents(dollarsToCents(283.33), plan.discountRatePct) / 100;
  return { plan, depositId: dep.body.id as string, feeId: applied.body.id as string, fee, owed: round2(283.33 + fee) };
}

const pdfOf = (estimateId: string) =>
  request(app).get(`/issued-estimates/${estimateId}/pdf?audience=customer`).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });

/** pdfkit text runs, joined with nothing (tests/issuedEstimatePdf.test.ts explains why). */
function pdfText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const parts: string[] = [];
  for (const m of raw.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    if (m[1].length % 2 !== 0) continue;
    parts.push(Buffer.from(m[1], "hex").toString("latin1"));
  }
  return parts.join("");
}

beforeAll(async () => {
  await cleanup();
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "p6rf-customer@example.com" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} property`, addressLine1: "6 Review Lane", city: "Hermitage", state: "TN", postalCode: "37076" },
  });
  propertyId = property.id;
  await prisma.priceBookSupplier.create({ data: { id: `${MARK}-SUP`, name: `${MARK} Supply`, quotable: "YES" } });
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} draft`, supplierId: `${MARK}-SUP` } });
  draftId = draft.id;
  const tech = await prisma.technician.create({
    data: { name: `${MARK} Tech`, accessToken: `p6rf-tech-${customer.id}`, role: "technician", hourlyRate: 30, commissionPercent: 10 },
  });
  technicianId = tech.id;
  techToken = tech.accessToken;
});

afterAll(cleanup);

// ─── 1. A locked fee is paid: every rail reopens for what is still owed ─────────────────────

describe("once the Synchrony payment is recorded, money still owed is plain invoice money", () => {
  it("a deposit check voided after the Synchrony payment can be collected again on every rail — nothing has to void Synchrony money", async () => {
    const visit = await prisma.visit.create({ data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} visit`, status: "scheduled" } });
    await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
    const est = await issue("1", { visitId: visit.id });
    const { plan, depositId, fee, owed } = await financed(est.id);
    const fieldInfo = () => request(app).get(`/health-record/visits/${visit.id}/payment-info`).set("Authorization", `Bearer ${techToken}`);

    // While the fee is unpaid the rails are closed — unchanged.
    const before = (await summaryOf(est.id))!;
    expect(financingInProgress(before)).toBe(true);
    expect((await chargeableAmount(prisma, est.token, "balance")).ok).toBe(false);
    expect((await fieldInfo()).body.data.financing).toMatchObject({ planNumber: plan.planNumber, fee });

    // The Synchrony payment closes the invoice and LOCKS (pays) the fee.
    const paid = await recordSynchrony(est.id, owed, plan.planNumber);
    expect(paid.status).toBe(201);
    const closed = (await summaryOf(est.id))!;
    expect(closed).toMatchObject({ paidInFull: true, balance: 0 });
    expect(closed.financingFee).toMatchObject({ locked: true });
    expect(financingInProgress(closed)).toBe(false);

    // The deposit check bounces — voided. $141.67 is owed again, and it is NOT fee money.
    expect((await voidIt(depositId, "Check bounced")).status).toBe(200);
    const reopened = (await summaryOf(est.id))!;
    expect(reopened).toMatchObject({ balance: 141.67, balanceBeforeFee: round2(141.67 - fee), paidInFull: false, depositSatisfied: true });
    expect(reopened.financingFee).toMatchObject({ locked: true });

    // Every rail is open for it, at exactly $141.67 — never a fee-inclusive figure.
    expect(await chargeableAmount(prisma, est.token, "balance")).toMatchObject({ ok: true, amount: 141.67 });
    const payPage = await request(app).get(`/pay/${est.token}`);
    expect(payPage.status).toBe(200);
    expect(payPage.text).not.toContain(FINANCING_IN_PROGRESS);
    const field = (await fieldInfo()).body.data;
    expect(field.financing).toBeNull();
    expect(field.balance).toBe(141.67);
    // The reminder is not paused either — the pay link it carries is open.
    emailMock.sendBrandedEmail.mockClear();
    expect(await sendInvoiceReminder(prisma, est.id)).toMatchObject({ ok: true, amount: 141.67 });
    expect(emailMock.sendBrandedEmail.mock.calls[0][0].bodyHtml).toContain("/pay/");
    // The customer's page shows the invoice is open again with the link, not a closed notice.
    const page = await request(app).get(`/e/${est.token}`);
    expect(page.text).not.toContain("paused for the moment");
    // A replacement check records (the rail that was the dead end), and the invoice closes again.
    const check = await record({ amount: 141.67, method: "check", kind: "deposit", estimateId: est.id, customerId, checkNumber: "1002" });
    expect(check.status).toBe(201);
    expect((await summaryOf(est.id))!.paidInFull).toBe(true);
    // The Synchrony payment was never touched: its cut is still on the P&L.
    const pl = await request(app).get(`/financials/summary?year=${LEDGER_YEAR}`);
    expect(pl.body.totals.synchronyCuts).toBeGreaterThan(0);
  });
});

// ─── 2-3. Decision 8 (no partial releases) and decision 7 (the fee's base) at recording ─────

describe("recording the Synchrony payment", () => {
  it("refuses a partial amount — Synchrony releases the whole financed amount at once", async () => {
    const est = await issue("2");
    const { plan, owed, feeId } = await financed(est.id);
    const partial = await recordSynchrony(est.id, round2(owed - 50), plan.planNumber);
    expect(partial.status).toBe(409);
    expect(partial.body.error).toMatch(/no partial releases/);
    expect(await prisma.payment.count({ where: { estimateId: est.id, method: "synchrony" } })).toBe(0);
    // The fee is still unlocked and removable — nothing got stuck.
    expect((await summaryOf(est.id))!.financingFee).toMatchObject({ id: feeId, locked: false });
    // The full amount records.
    expect((await recordSynchrony(est.id, owed, plan.planNumber)).status).toBe(201);
  });

  it("refuses when the balance drifted off the fee's base, and says to remove the fee and add it again", async () => {
    const est = await issue("3");
    const { plan, owed } = await financed(est.id);
    // The balance moves under the fee (a change order joining the invoice, or a payment voided):
    // here a $10 payment that lands on the invoice after the fee went on.
    await prisma.payment.create({ data: { amount: 10, method: "cash", kind: "other", payer: "customer", status: "paid", customerId, estimateId: est.id, paidAt: new Date(), note: `${MARK} drift` } });
    const drifted = (await summaryOf(est.id))!;
    expect(drifted.balanceBeforeFee).toBe(273.33);
    expect(drifted.financingFee!.feeBase).toBe(283.33);
    const refused = await recordSynchrony(est.id, round2(owed - 10), plan.planNumber);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/balance changed since the financing fee was added/);
    expect(refused.body.error).toMatch(/Remove the financing fee/);
    expect(await prisma.payment.count({ where: { estimateId: est.id, method: "synchrony" } })).toBe(0);
  });
});

// ─── 4-6. The customer never gets a dead end: deposit request, the page, the final bill ──────

describe("while financing is in progress and the deposit is not in", () => {
  it("the deposit request is refused on the server (CRM route, field route, the service), and the page shows the deposit closed with the reason", async () => {
    const visit = await prisma.visit.create({ data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} visit`, status: "scheduled" } });
    await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
    const est = await issue("4", { visitId: visit.id });
    const { depositId, feeId } = await financed(est.id);

    // The deposit is voided after the fee went on: fee unpaid, deposit unsatisfied.
    expect((await voidIt(depositId, "Check bounced")).status).toBe(200);
    const state = (await summaryOf(est.id))!;
    expect(state).toMatchObject({ depositSatisfied: false, depositRequired: true });
    expect(financingInProgress(state)).toBe(true);

    emailMock.sendBrandedEmail.mockClear();
    const crm = await request(app).post(`/issued-estimates/${est.id}/email-deposit-request`);
    expect(crm.status).toBe(409);
    expect(crm.body.error).toContain(FINANCING_IN_PROGRESS);
    const field = await request(app).post(`/health-record/visits/${visit.id}/email-payment-request`).set("Authorization", `Bearer ${techToken}`).send({ kind: "deposit" });
    expect(field.status).toBe(409);
    expect(field.body.error.message).toContain(FINANCING_IN_PROGRESS);
    await sendDepositRequestEmail(prisma, est.id, ORIGIN);
    expect(emailMock.sendBrandedEmail).not.toHaveBeenCalled();

    // The customer's page: no working-looking pay button; the closed deposit, the reason, the terms.
    const page = await request(app).get(`/e/${est.token}`);
    expect(page.status).toBe(200);
    expect(page.text).not.toContain("Pay your deposit");
    expect(page.text).toContain("paused for the moment");
    expect(page.text).toContain(BALANCE_DUE_TERMS);

    // Remove the fee: the deposit request sends again, with the link.
    await removeFinancingFee(prisma, feeId, "Deposit check bounced — re-collecting first");
    const again = await request(app).post(`/issued-estimates/${est.id}/email-deposit-request`);
    expect(again.status).toBe(200);
    expect(emailMock.sendBrandedEmail.mock.calls[0][0].bodyHtml).toContain("?type=deposit");
  });

  it("the financed customer's page keeps 'due upon receipt' beside the Synchrony sentence, and the final bill says how to pay — never 'nothing to pay'", async () => {
    const est = await issue("5");
    await financed(est.id);
    const page = await request(app).get(`/e/${est.token}`);
    expect(page.text).toContain("being paid through your Synchrony financing");
    expect(page.text).toContain(BALANCE_DUE_TERMS);

    emailMock.sendBrandedEmail.mockClear();
    expect((await sendBalanceRequestEmail(prisma, est.id, ORIGIN)).ok).toBe(true);
    const html = emailMock.sendBrandedEmail.mock.calls[0][0].bodyHtml as string;
    expect(html).not.toMatch(/nothing to pay/i);
    expect(html).toContain("release the funds with Synchrony");
    expect(html).not.toContain("/pay/");
  });
});

// ─── 7. The PDF names the fee ────────────────────────────────────────────────────────────────

describe("the signed invoice PDF", () => {
  it("prints the financing fee as its own line and a balance that adds up — on a one-document invoice too", async () => {
    const est = await issue("6");
    const { plan, fee, owed } = await financed(est.id);
    const pdf = await pdfOf(est.id);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    const text = pdfText(pdf.body as Buffer);
    expect(text).toContain(`Invoice ${est.number}`);
    expect(text).toContain("what is owed");
    expect(text).toContain(`Financing fee`);
    expect(text).toContain(`Plan ${plan.planNumber}`);
    expect(text).toContain(fee.toFixed(2));
    expect(text).toContain("Balance due");
    expect(text).toContain(owed.toFixed(2));
    // No rate on the customer's document.
    expect(text).not.toMatch(/discountRate/);
  });
});

// ─── 8. Undoing an office acceptance with a live fee ─────────────────────────────────────────

describe("undo acceptance", () => {
  it("is refused while a live financing fee is on the estimate — remove the fee first", async () => {
    const est = await issue("7", { signedChannel: "office" });
    const { depositId, feeId } = await financed(est.id);
    // Void the deposit so no payment blocks the undo — the fee alone must.
    expect((await voidIt(depositId, "Keyed against the wrong invoice")).status).toBe(200);
    const blocked = await undoOfficeAcceptance(prisma, est.id);
    expect(blocked.ok).toBe(false);
    expect((blocked as { reason: string }).reason).toMatch(/financing fee is on this invoice/);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).signedAt).not.toBeNull();
    await removeFinancingFee(prisma, feeId, "Customer never applied");
    expect((await undoOfficeAcceptance(prisma, est.id)).ok).toBe(true);
  });
});

// ─── 9. The P&L counts one live fee per invoice ──────────────────────────────────────────────

describe("the P&L's invoiced", () => {
  it("counts the NEWEST live fee per invoice only — the same row every other reader uses", async () => {
    const est = await issue("8");
    const { feeId, fee } = await financed(est.id);
    await prisma.financingFee.update({ where: { id: feeId }, data: { appliedAt: new Date(`${LEDGER_YEAR}-03-02T12:00:00.000Z`) } });
    // A second live row on the same root (the state the row locks now prevent) — the ledger must not double count.
    const first = await prisma.financingFee.findUniqueOrThrow({ where: { id: feeId } });
    const dup = await prisma.financingFee.create({
      data: {
        estimateId: est.id, planNumber: first.planNumber, planDescription: first.planDescription, discountRatePct: first.discountRatePct,
        feeBaseCents: first.feeBaseCents, feeCents: first.feeCents + 100, appliedBy: "test", appliedAt: new Date(`${LEDGER_YEAR}-03-05T12:00:00.000Z`),
      },
    });
    const newest = (await summaryOf(est.id))!.financingFee!;
    expect(newest.id).toBe(dup.id);
    const pl = await request(app).get(`/financials/summary?year=${LEDGER_YEAR}`);
    // March carries exactly one fee — the newest — and not the sum of both.
    expect(pl.body.months[2].invoiced).toBe(round2(fee + 1));
    await prisma.financingFee.delete({ where: { id: dup.id } });
  });
});

// ─── 10-11. The void: the race, and the bank line ────────────────────────────────────────────

describe("voiding a payment", () => {
  it("two voids racing each other: exactly one lands, and the first reason is never overwritten", async () => {
    const est = await issue("9");
    const dep = await depositOn(est.id);
    expect(dep.status).toBe(201);
    const results = await Promise.allSettled([
      voidPayment(prisma, dep.body.id, "first reason"),
      voidPayment(prisma, dep.body.id, "second reason"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(PaymentVoidError);
    expect((failed[0].reason as PaymentVoidError).statusCode).toBe(409);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: dep.body.id } });
    expect(row.voidReason).toBe((ok[0] as PromiseFulfilledResult<{ voidReason: string }>).value.voidReason);
    expect(await prisma.issuedEstimateEvent.count({ where: { estimateId: est.id, type: "payment_voided" } })).toBe(1);
  });

  it("a bank deposit already confirmed as the payment goes back to the review queue, and the void says so", async () => {
    const est = await issue("A");
    const dep = await depositOn(est.id);
    expect(dep.status).toBe(201);
    const account = await prisma.bankAccount.create({ data: { name: `${MARK} Checking`, kind: "checking", purpose: "operating", last4: "0006" } });
    const statement = await prisma.bankStatement.create({ data: { accountId: account.id, fileName: "p6rf.csv", fileHash: `p6rf-${Date.now()}`, format: "csv", lineCount: 1 } });
    const line = await prisma.bankLine.create({
      data: {
        accountId: account.id, statementId: statement.id, lineKey: "p6rf-1", postedAt: new Date(`${LEDGER_YEAR}-05-03T12:00:00.000Z`), amount: 141.67,
        description: "DEPOSIT CHECK 1001", payeeKey: "deposit", classification: "already_counted", matchedKind: "payment", matchedId: dep.body.id,
        reason: "confirmed by the owner", classifiedBy: "owner", classifiedAt: new Date(),
      },
    });
    const voided = await voidIt(dep.body.id, "Check bounced");
    expect(voided.status).toBe(200);
    expect(voided.body.bankLinesReopened).toBe(1);
    const after = await prisma.bankLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(after).toMatchObject({ classification: "unclassified", matchedKind: null, matchedId: null, classifiedBy: "owner" });
    expect(after.hint).toMatch(/was voided/);
    expect(after.hint).toMatch(/Check bounced/);
    const event = await prisma.issuedEstimateEvent.findFirst({ where: { estimateId: est.id, type: "payment_voided" } });
    expect(event!.detail).toMatch(/1 bank deposit line sent back/);
    // The queue the bank screen reads lists it again.
    const queue = await request(app).get("/bank/lines?classification=unclassified");
    expect(queue.status).toBe(200);
    expect((queue.body as { id: string }[]).some((l) => l.id === line.id)).toBe(true);
  });
});

// ─── 12. Commission: once per tech per job; pending hours are MISSING ────────────────────────

describe("recording a commission", () => {
  it("a job-profit commission is recorded once per tech per job — the second press is refused, and a void reopens it", async () => {
    const visit = await prisma.visit.create({
      data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} visit`, status: "completed", revenue: 1000 },
    });
    await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
    const first = await request(app).post("/time/commissions").send({ technicianId, visitId: visit.id, basis: "job_profit" });
    expect(first.status).toBe(201);
    expect(first.body.amount).toBe(100);
    const second = await request(app).post("/time/commissions").send({ technicianId, visitId: visit.id, basis: "job_profit" });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already recorded/);
    expect(second.body.error).toMatch(/void it first/);
    expect(await prisma.commission.count({ where: { technicianId, visitId: visit.id } })).toBe(1);
    const removed = await request(app).post(`/time/commissions/${first.body.id}/void`).send({ reason: "Entered twice" });
    expect(removed.status).toBe(200);
    expect((await request(app).post("/time/commissions").send({ technicianId, visitId: visit.id, basis: "job_profit" })).status).toBe(201);
  });

  it("a tech still clocked in, or a flagged session awaiting confirmation, is MISSING — profit null, the record refused — never $0 labor", async () => {
    const visit = await prisma.visit.create({
      data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} visit`, status: "in_progress", revenue: 1000 },
    });
    await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
    // Still clocked in.
    const open = await prisma.timeEntry.create({ data: { visitId: visit.id, technicianId, startedAt: new Date(Date.now() - 2 * HOUR), rateApplied: 30 } });
    let basis = await commissionBasisForJob(visit.id);
    expect(basis.profit).toBeNull();
    expect(basis.missing).toEqual(expect.arrayContaining([expect.stringMatching(/P6RF Tech is still clocked in/)]));
    let refused = await request(app).post("/time/commissions").send({ technicianId, visitId: visit.id, basis: "job_profit" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/still clocked in/);
    // Flagged at 12h and nobody has confirmed it.
    await prisma.timeEntry.update({
      where: { id: open.id },
      data: { endedAt: new Date(), minutes: 720, endedReason: "clock_out", flaggedAt: new Date(), confirmedAt: null },
    });
    basis = await commissionBasisForJob(visit.id);
    expect(basis.profit).toBeNull();
    expect(basis.missing).toEqual(expect.arrayContaining([expect.stringMatching(/flagged session on this job awaiting confirmation/)]));
    refused = await request(app).post("/time/commissions").send({ technicianId, visitId: visit.id, basis: "job_profit" });
    expect(refused.status).toBe(400);
    // Confirmed: the hours count and the profit computes (employer cost % may be unset — then that is the missing reason, not the hours).
    await prisma.timeEntry.update({ where: { id: open.id }, data: { confirmedAt: new Date(), minutes: 60 } });
    basis = await commissionBasisForJob(visit.id);
    expect(basis.missing.some((m) => /clocked in|awaiting confirmation/.test(m))).toBe(false);
    expect(basis.laborRows.find((r) => r.technicianId === technicianId)).toMatchObject({ hours: 1, wage: 30 });
  });
});
