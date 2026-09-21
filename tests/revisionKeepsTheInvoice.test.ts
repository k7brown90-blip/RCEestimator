/**
 * A signed estimate that is REVISED keeps its invoice (2026-09-21, PUNCHLIST A1 / A11 / A9).
 *
 * The three live wrong numbers this pins, in the order they were found:
 *
 *   A1  — revising a SIGNED estimate created an unsigned revision and never re-pointed the
 *         change orders, and /invoices hid the old signed root the moment the revision existed
 *         (`supersededBy: null`). The customer's only signed agreement, its deposit and its
 *         change orders were listed nowhere. And if the revision was then signed, the old root
 *         stayed "signed" too: the P&L counted both, the job got a second Visit, and the
 *         deposit stayed on the row nothing listed.
 *
 *         THE RULE NOW: the invoice is the newest SIGNED revision of the number. While the
 *         revision is unsigned the old signed root IS the invoice and nothing moves. When the
 *         revision is signed, its change orders, its payments and its live job move to it in
 *         the signature's own transaction, and the replaced revision is voided with the reason
 *         written down (services/issuedEstimateService.ts adoptSupersededInvoice). Every money
 *         surface agrees by construction: void is already off all of them.
 *
 *   A11 — GET /jobs took the NEWEST issued row on a visit as the job card's estimate, so a
 *         change order marked lost on a sold job badged the job DECLINED. The card now shows
 *         the signed ROOT — the same document /jobs/:id/payment-info names.
 *
 *   A9  — the P&L's INVOICED line is an allow-list (`status: "signed"`), never `not: "void"`.
 *
 * Fixture shape follows tests/changeOrderInvoice.test.ts (real drafts, real signatures).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
vi.mock("stripe", () => ({ default: class MockStripe { constructor() { throw new Error("Stripe must not be constructed in tests"); } } }));
vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
  fetchTwilioMedia: vi.fn().mockResolvedValue(null),
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
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: vi.fn().mockResolvedValue(true), sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { paymentSummary } from "../src/services/stripePayments";
import { signedRootForJob } from "../src/services/invoiceGroup";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "RKINV";
const ITEM = "RKINV1";
const ORIGIN = "https://unused.invalid";
const YEAR = new Date().getFullYear();
const round2 = (n: number) => Math.round(n * 100) / 100;

let customerId: string;
let propertyId: string;
let visitId: string;
const draftIds: string[] = [];

async function cleanEstimatesFor(ids: string[]) {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: ids } } });
  const estIds = ests.map((e) => e.id);
  await prisma.payment.deleteMany({ where: { estimateId: { in: estIds } } });
  const jobIds = [...new Set(ests.map((e) => e.jobVisitId).filter((v): v is string => Boolean(v)))];
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: jobIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null, changeOrderForId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.visit.deleteMany({ where: { id: { in: jobIds } } });
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ITEM)]);
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Revised`, email: "rkinv-revised@example.com", phone: "615-555-0177" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "7 Revision Rd", city: "La Vergne", state: "TN", postalCode: "37086" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} panel`, status: "estimate" },
  });
  visitId = visit.id;
});

afterAll(async () => {
  await cleanEstimatesFor(draftIds);
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM]);
});

async function quotableDraft(title: string, qty = 1) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: ITEM, quantity: qty, quantitySource: "COUNT" });
  return d;
}

async function issue(draftId: string) {
  const g = await graduateDraft(prisma, { draftId, accountId: customerId, serviceAddressId: propertyId });
  expect(g.ok).toBe(true);
  if (!g.ok) throw new Error(g.reasons.join("; "));
  return prisma.issuedEstimate.findUniqueOrThrow({ where: { id: g.estimateId } });
}

async function signInPerson(estimateId: string) {
  const res = await request(app)
    .post(`/issued-estimates/${estimateId}/sign-in-person`)
    .send({ signerName: "Mrs Revised", signatureImage: TEST_SIGNATURE });
  expect(res.body, `the signature was refused: ${JSON.stringify(res.body)}`).toMatchObject({ signed: true });
  return prisma.issuedEstimate.findUniqueOrThrow({ where: { id: estimateId } });
}

async function raiseChangeOrder(parentId: string, qty: number) {
  const raised = await request(app).post(`/issued-estimates/${parentId}/change-order`).send({});
  expect(raised.status).toBe(201);
  const draftId = raised.body.draftId as string;
  draftIds.push(draftId);
  await addLine(prisma, draftId, { itemId: ITEM, quantity: qty, quantitySource: "COUNT" });
  return issue(draftId);
}

type InvoiceRow = { id: string; number: string; revision: number; billedTotal: number; totalPaid: number; balance: number; changeOrders: Array<{ id: string }> };
async function invoices(): Promise<InvoiceRow[]> {
  const res = await request(app).get("/invoices");
  expect(res.status).toBe(200);
  return res.body as InvoiceRow[];
}
type JobCard = { visitId: string; estimate: { id: string; status: string; hasAcceptance: boolean } | null; costs: { revenue: number | null } };
async function jobCard(jobId: string): Promise<JobCard> {
  const res = await request(app).get("/jobs");
  expect(res.status).toBe(200);
  const card = (res.body as JobCard[]).find((j) => j.visitId === jobId);
  expect(card, "the sold job is on the Jobs tab").toBeTruthy();
  return card!;
}
async function invoicedThisYear(): Promise<number> {
  const res = await request(app).get(`/financials/summary?year=${YEAR}`);
  expect(res.status).toBe(200);
  return res.body.totals.invoiced as number;
}
async function quotedOnProfitability(jobId: string): Promise<number | null | undefined> {
  const res = await request(app).get(`/financials/job-profitability?year=${YEAR}`);
  expect(res.status).toBe(200);
  return (res.body as Array<{ visitId: string; quoted: number | null }>).find((r) => r.visitId === jobId)?.quoted;
}

describe("a signed estimate keeps its invoice through a revision", () => {
  let root: Awaited<ReturnType<typeof issue>>;
  let co: Awaited<ReturnType<typeof issue>>;
  let rev: Awaited<ReturnType<typeof issue>>;
  let jobId: string;
  let rootShare: number;
  let coShare: number;
  let invoicedBefore: number;
  let jobsBefore: number;
  let deposit: number;

  it("the sale: a signed root, a signed change order on its job, and a deposit on the root", async () => {
    invoicedBefore = await invoicedThisYear();
    root = await signInPerson((await issue((await quotableDraft("panel")).id)).id);
    jobId = root.jobVisitId!;
    expect(jobId).toBeTruthy();
    co = await signInPerson((await raiseChangeOrder(root.id, 2)).id);
    expect(co.jobVisitId).toBe(jobId);
    expect(co.changeOrderForId).toBe(root.id);
    // The ⅓ deposit in full — the Jobs tab lists a sold job only once its deposit is in.
    deposit = (await paymentSummary(prisma, root.id, ORIGIN))!.depositDue;
    expect(deposit).toBeGreaterThan(0);
    const paid = await request(app).post("/financials/payments").send({ amount: deposit, method: "cash", kind: "deposit", estimateId: root.id, customerId });
    expect(paid.status).toBe(201);

    const s = (await paymentSummary(prisma, root.id, ORIGIN))!;
    rootShare = s.documents[0].billedTotal;
    coShare = s.documents[1].billedTotal;
    expect(s.totalPaid).toBe(deposit);
    expect(s.depositSatisfied).toBe(true);
    expect(round2(await invoicedThisYear() - invoicedBefore)).toBe(round2(rootShare + coShare));
    jobsBefore = await prisma.visit.count({ where: { customerId } });
  });

  it("revising the signed root leaves the invoice, its change order, its deposit and its job exactly where they were", async () => {
    // The trip charge waived is the one thing a revision of a signed estimate can change without
    // reopening the draft (a signed draft never reopens) — so the revision's total differs by $200.
    const revised = await request(app).post(`/issued-estimates/${root.id}/revise`).send({ waiveTrip: true });
    expect(revised.status).toBe(201);
    rev = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: revised.body.estimateId as string } });
    expect(rev.signedAt).toBeNull();
    expect(rev.supersedesId).toBe(root.id);
    expect(rev.number).toBe(root.number);

    // /invoices: the signed root is still the invoice — with its change order and its deposit.
    const rows = await invoices();
    expect(rows.find((r) => r.id === rev.id)).toBeUndefined();
    const row = rows.find((r) => r.id === root.id)!;
    expect(row, "the signed root stays on /invoices while its revision is unsigned").toBeTruthy();
    expect(row.changeOrders.map((c) => c.id)).toEqual([co.id]);
    expect(row.totalPaid).toBe(deposit);
    expect(row.billedTotal).toBe(round2(rootShare + coShare));

    // paymentSummary, the job's payment panel and the job card all still name the root.
    const s = (await paymentSummary(prisma, root.id, ORIGIN))!;
    expect(s.estimateId).toBe(root.id);
    expect(s.totalPaid).toBe(deposit);
    expect(s.documents.map((d) => d.id)).toEqual([root.id, co.id]);
    expect((await signedRootForJob(prisma, jobId))?.id).toBe(root.id);
    const card = await jobCard(jobId);
    expect(card.estimate?.id).toBe(root.id);
    expect(card.estimate?.status).toBe("accepted");
    expect(card.costs.revenue).toBe(round2(rootShare + coShare));

    // The P&L has not moved: the root is still the signed, live revenue.
    expect(round2(await invoicedThisYear() - invoicedBefore)).toBe(round2(rootShare + coShare));
    // The old root's link is dead; the deposit gate still reads the root's money.
    const rootRow = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: root.id } });
    expect(rootRow.status).toBe("signed");
    expect(rootRow.voidedAt).toBeNull();
  });

  it("signing the revision moves the change order, the deposit and the job onto it, and voids the replaced revision with the reason", async () => {
    const jobBefore = await prisma.visit.findUniqueOrThrow({ where: { id: jobId } });
    rev = await signInPerson(rev.id);

    // The same job — no second Visit — and "contracted for" moved by the difference in totals.
    expect(rev.jobVisitId).toBe(jobId);
    expect(await prisma.visit.count({ where: { customerId } })).toBe(jobsBefore);
    const jobAfter = await prisma.visit.findUniqueOrThrow({ where: { id: jobId } });
    expect(round2(jobAfter.estimatedCost! - jobBefore.estimatedCost!)).toBe(round2(rev.total - root.total));

    // The change order and the payment now name the signed revision — the ROOT.
    const coRow = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: co.id } });
    expect(coRow.changeOrderForId).toBe(rev.id);
    expect(await prisma.payment.count({ where: { estimateId: root.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { estimateId: rev.id } })).toBe(1);

    // The replaced revision is void, with the reason on the row and in its events.
    const rootRow = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: root.id } });
    expect(rootRow.status).toBe("void");
    expect(rootRow.voidedAt).not.toBeNull();
    expect(rootRow.voidReason).toContain(`Replaced by signed revision ${rev.revision}`);
    expect(await prisma.issuedEstimateEvent.findFirst({ where: { estimateId: root.id, type: "voided" } })).not.toBeNull();
    expect(await prisma.issuedEstimateEvent.findFirst({ where: { estimateId: rev.id, type: "invoice_taken_over" } })).not.toBeNull();

    // One invoice: the revision plus its change order, the deposit still on it.
    const s = (await paymentSummary(prisma, rev.id, ORIGIN))!;
    expect(s.documents.map((d) => [d.id, d.kind])).toEqual([[rev.id, "invoice"], [co.id, "change_order"]]);
    expect(s.totalPaid).toBe(deposit);
    expect(s.depositPaid).toBe(deposit);
    const revShare = s.documents[0].billedTotal;
    expect(revShare).toBe(round2(rootShare - 200));
    expect(s.billedTotal).toBe(round2(revShare + coShare));
    // Asked about the OLD row, the answer is the live invoice — where its money went.
    const viaOld = (await paymentSummary(prisma, root.id, ORIGIN))!;
    expect(viaOld.estimateId).toBe(rev.id);
    expect(viaOld.totalPaid).toBe(deposit);

    // /invoices lists the revision (with the change order), never the replaced root.
    const rows = await invoices();
    expect(rows.find((r) => r.id === root.id)).toBeUndefined();
    const row = rows.find((r) => r.id === rev.id)!;
    expect(row).toBeTruthy();
    expect(row.changeOrders.map((c) => c.id)).toEqual([co.id]);
    expect(row.totalPaid).toBe(deposit);
    expect(row.billedTotal).toBe(s.billedTotal);

    // The job card, the payment panel and job profitability all name the revision.
    expect((await signedRootForJob(prisma, jobId))?.id).toBe(rev.id);
    const card = await jobCard(jobId);
    expect(card.estimate?.id).toBe(rev.id);
    expect(card.estimate?.status).toBe("accepted");
    expect(card.costs.revenue).toBe(s.billedTotal);
    expect(await quotedOnProfitability(jobId)).toBe(s.billedTotal);

    // The P&L counts the invoice ONCE, at the revision's figure: the delta is the $200, not a
    // second invoice.
    expect(round2(await invoicedThisYear() - invoicedBefore)).toBe(round2(revShare + coShare));
  });

  it("A11: a change order marked LOST on the sold job never becomes the job card's estimate", async () => {
    const co2 = await raiseChangeOrder(rev.id, 1);
    // The fixture must reproduce the bug: the lost change order is the NEWEST issued row on the job.
    expect(co2.visitId === jobId || co2.jobVisitId === jobId).toBe(true);
    await prisma.issuedEstimate.update({ where: { id: co2.id }, data: { status: "sent", sentAt: new Date() } });
    const lost = await request(app).post(`/issued-estimates/${co2.id}/lost`).send({ reason: "price" });
    expect(lost.status).toBe(200);

    const card = await jobCard(jobId);
    expect(card.estimate?.id).toBe(rev.id);
    expect(card.estimate?.status).toBe("accepted");
    expect(card.estimate?.status).not.toBe("declined");
    expect(card.estimate?.hasAcceptance).toBe(true);
    // Its money is untouched: the lost change order counts nothing.
    const s = (await paymentSummary(prisma, rev.id, ORIGIN))!;
    expect(s.documents.map((d) => d.id)).toEqual([rev.id, co.id]);
    expect(card.costs.revenue).toBe(s.billedTotal);
  });

  it("A9: a row with signedAt set and any status but 'signed' is not invoiced revenue", async () => {
    const before = await invoicedThisYear();
    const stray = await prisma.issuedEstimate.create({
      data: {
        number: `0000-${MARK}-STRAY`, revision: 1, token: `${MARK.toLowerCase()}-stray-${Date.now()}`,
        status: "expired", draftId: draftIds[0], customerId, serviceAddressId: propertyId,
        customerName: `${MARK} Revised`, serviceAddress: "7 Revision Rd", title: `${MARK} stray`,
        workSubtotal: 1000, total: 1000, signedAt: new Date(), signedChannel: "email",
      },
    });
    expect(await invoicedThisYear()).toBe(before);
    expect((await invoices()).find((r) => r.id === stray.id)).toBeUndefined();
  });
});
