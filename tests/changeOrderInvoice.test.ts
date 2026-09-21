/**
 * The change order joins the invoice (Kyle, 2026-09-20, after the Godwin job).
 *
 *   "I showed up to replace an exterior light and he had other issues... Every one a new
 *    estimate, a new deposit requirement, and a new charge."
 *   "The change order should reopen that estimate with the existing items still frozen, add the
 *    change order items, get signature, then the total updates and work continues with a deposit
 *    optional... The change order will also have to have the option to 'add to current job'."
 *
 * What these pin (services/invoiceGroup.ts and everything that reads it):
 *   1. The issued change order carries a FROZEN link to its root; the deposit defaults OFF and
 *      "add to current job" defaults ON when the parent has a live job.
 *   2. An UNSIGNED change order counts nothing on the invoice.
 *   3. A SIGNED change order joins the parent's job (no second Visit) and its share joins the
 *      invoice — one billed total, one balance, one pay link — with the deposit unchanged.
 *   4. Every "the invoice" surface reads the roll-up: the job's payment info, /invoices (the
 *      change order is not its own row), the customer pay page, the field job brief.
 *   5. The deposit is optional, and the manual override moves it after issue.
 *   6. Void: a root with live change orders is REFUSED; voiding one change order takes only its
 *      share off and leaves the job open for the rest; then the root can be voided.
 *   7. The reminder sweep never treats a change order as a second invoice.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
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
// Customer emails are counted, never sent.
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { chargeableAmount, paymentSummary } from "../src/services/stripePayments";
import { loadInvoiceGroup, signedRootForJob } from "../src/services/invoiceGroup";
import { sweepInvoiceReminders } from "../src/services/invoiceReminders";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "COINV";
const ITEM = "COINV1";
const ORIGIN = "https://unused.invalid";
const round2 = (n: number) => Math.round(n * 100) / 100;

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;
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
    data: { name: `${MARK} Godwin`, email: "coinv-godwin@example.com", phone: "615-555-0142" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "4 Change Order Ct", city: "La Vergne", state: "TN", postalCode: "37086" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} exterior light`, status: "estimate" },
  });
  visitId = visit.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `coinv-${crypto.randomUUID()}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
});

afterAll(async () => {
  await cleanEstimatesFor(draftIds);
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { technicianId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM]);
});

/** A draft on the job with `qty` of the fixture item. */
async function quotableDraft(title: string, qty = 1) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: ITEM, quantity: qty, quantitySource: "COUNT" });
  return d;
}

async function issue(draftId: string, extra: { depositRequired?: boolean; addToCurrentJob?: boolean } = {}) {
  const g = await graduateDraft(prisma, { draftId, accountId: customerId, serviceAddressId: propertyId, ...extra });
  expect(g.ok).toBe(true);
  if (!g.ok) throw new Error(g.reasons.join("; "));
  return prisma.issuedEstimate.findUniqueOrThrow({ where: { id: g.estimateId } });
}

async function signInPerson(estimateId: string) {
  const res = await request(app)
    .post(`/issued-estimates/${estimateId}/sign-in-person`)
    .send({ signerName: "Mr Godwin", signatureImage: TEST_SIGNATURE });
  expect(res.status).toBe(200);
  return prisma.issuedEstimate.findUniqueOrThrow({ where: { id: estimateId } });
}

/** Raise a change order through the route, add lines, issue it. */
async function raiseChangeOrder(parentId: string, qty: number, extra: { depositRequired?: boolean; addToCurrentJob?: boolean } = {}) {
  const raised = await request(app).post(`/issued-estimates/${parentId}/change-order`).send({});
  expect(raised.status).toBe(201);
  const draftId = raised.body.draftId as string;
  draftIds.push(draftId);
  await addLine(prisma, draftId, { itemId: ITEM, quantity: qty, quantitySource: "COUNT" });
  return issue(draftId, extra);
}

describe("the change order joins the invoice", () => {
  let parent: Awaited<ReturnType<typeof issue>>;
  let jobId: string;
  let co: Awaited<ReturnType<typeof issue>>;
  let parentShare: number;

  it("a signed estimate is one invoice with a ⅓ deposit, exactly as before", async () => {
    const d = await quotableDraft("exterior light");
    parent = await issue(d.id);
    expect(parent.changeOrderForId).toBeNull();
    expect(parent.depositRequired).toBe(true);
    parent = await signInPerson(parent.id);
    expect(parent.jobVisitId).not.toBeNull();
    jobId = parent.jobVisitId!;

    const s = (await paymentSummary(prisma, parent.id, ORIGIN))!;
    parentShare = s.billedTotal;
    expect(parentShare).toBeGreaterThan(0);
    expect(s.depositRequired).toBe(true);
    expect(s.depositDue).toBe(round2(parentShare / 3));
    expect(s.depositSatisfied).toBe(false);
    expect(s.documents).toHaveLength(1);
    expect(s.documents[0]).toMatchObject({ id: parent.id, kind: "invoice" });
  });

  it("the issued change order freezes its root link; deposit OFF and add-to-current-job ON by default", async () => {
    co = await raiseChangeOrder(parent.id, 2);
    expect(co.changeOrderForId).toBe(parent.id);
    expect(co.depositRequired).toBe(false);
    expect(co.addToCurrentJob).toBe(true);
    expect(co.signedAt).toBeNull();
  });

  it("an UNSIGNED change order counts nothing on the invoice", async () => {
    const s = (await paymentSummary(prisma, parent.id, ORIGIN))!;
    expect(s.billedTotal).toBe(parentShare);
    expect(s.documents).toHaveLength(1);
    // Asked about the change order itself, the answer is still the (unchanged) invoice.
    const viaCo = (await paymentSummary(prisma, co.id, ORIGIN))!;
    expect(viaCo.estimateId).toBe(parent.id);
    expect(viaCo.billedTotal).toBe(parentShare);
  });

  it("signing it adds to the CURRENT job — no second visit — and its share joins the invoice; the deposit does not grow", async () => {
    const visitsBefore = await prisma.visit.count({ where: { customerId } });
    co = await signInPerson(co.id);
    expect(co.jobVisitId).toBe(jobId);
    expect(await prisma.visit.count({ where: { customerId } })).toBe(visitsBefore);
    const joined = await prisma.issuedEstimateEvent.findFirst({ where: { estimateId: co.id, type: "job_joined" } });
    expect(joined).not.toBeNull();

    const group = (await loadInvoiceGroup(prisma, co.id))!;
    expect(group.root.id).toBe(parent.id);
    expect(group.changeOrders.map((c) => c.id)).toEqual([co.id]);
    const coShare = group.documents[1].billedTotal;
    expect(coShare).toBeGreaterThan(0);

    const s = (await paymentSummary(prisma, parent.id, ORIGIN))!;
    expect(s.billedTotal).toBe(round2(parentShare + coShare));
    expect(s.balance).toBe(round2(parentShare + coShare));
    // The change order carries no deposit of its own (Kyle: "deposit optional" for change orders).
    expect(s.depositDue).toBe(round2(parentShare / 3));
    expect(s.documents.map((d) => [d.id, d.kind])).toEqual([[parent.id, "invoice"], [co.id, "change_order"]]);
    // ONE pay link — the root's — whichever document's page the customer is on.
    expect(s.payUrl).toContain(parent.token);
    const viaCo = (await paymentSummary(prisma, co.id, ORIGIN))!;
    expect(viaCo.estimateId).toBe(parent.id);
    expect(viaCo.payUrl).toBe(s.payUrl);
  });

  it("the customer's pay link on the change order charges the ONE rolled-up balance against the root", async () => {
    const balance = await chargeableAmount(prisma, co.token, "balance");
    expect(balance.ok).toBe(true);
    if (!balance.ok) return;
    const s = (await paymentSummary(prisma, parent.id, ORIGIN))!;
    expect(balance.estimateId).toBe(parent.id);
    expect(balance.number).toBe(parent.number);
    expect(balance.amount).toBe(s.balance);
    expect(balance.documents).toHaveLength(2);
    // The deposit ask is the root's third, on either link.
    const dep = await chargeableAmount(prisma, co.token, "deposit");
    expect(dep.ok).toBe(true);
    if (dep.ok) expect(dep.amount).toBe(round2(parentShare / 3));
    // The public pay page lists both documents above the amount.
    const page = await request(app).get(`/pay/${co.token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(parent.number);
    expect(page.text).toContain(`Change order ${co.number}`);
  });

  it("a payment recorded against the change order lands on the ROOT and closes the one balance", async () => {
    const before = (await paymentSummary(prisma, parent.id, ORIGIN))!;
    const res = await request(app).post("/financials/payments").send({ amount: 10, method: "cash", kind: "final", estimateId: co.id, customerId });
    expect(res.status).toBe(201);
    expect(res.body.estimateId).toBe(parent.id);
    const after = (await paymentSummary(prisma, co.id, ORIGIN))!;
    expect(after.totalPaid).toBe(round2(before.totalPaid + 10));
    expect(after.balance).toBe(round2(before.balance - 10));
  });

  it("the job's payment info, /invoices and the account rows all read the roll-up — the change order is never its own invoice", async () => {
    const s = (await paymentSummary(prisma, parent.id, ORIGIN))!;
    const root = await signedRootForJob(prisma, jobId);
    expect(root?.id).toBe(parent.id);

    const job = await request(app).get(`/jobs/${jobId}/payment-info`);
    expect(job.status).toBe(200);
    expect(job.body.number).toBe(parent.number);
    expect(job.body.billedTotal).toBe(s.billedTotal);
    expect(job.body.documents).toHaveLength(2);

    const invoices = await request(app).get("/invoices");
    expect(invoices.status).toBe(200);
    const rows = invoices.body as Array<{ id: string; billedTotal: number; balance: number; changeOrders: Array<{ id: string }>; depositRequired: boolean }>;
    expect(rows.find((r) => r.id === co.id)).toBeUndefined();
    const row = rows.find((r) => r.id === parent.id)!;
    expect(row.billedTotal).toBe(s.billedTotal);
    expect(row.balance).toBe(s.balance);
    expect(row.changeOrders.map((c) => c.id)).toEqual([co.id]);
    expect(row.depositRequired).toBe(true);

    const account = await request(app).get(`/accounts/${customerId}/estimates`);
    const coRow = (account.body.estimates as Array<{ id: string; changeOrderForId: string | null; changeOrderForNumber: string | null }>).find((e) => e.id === co.id)!;
    expect(coRow.changeOrderForId).toBe(parent.id);
    expect(coRow.changeOrderForNumber).toBe(parent.number);
  });

  it("the tech's job brief carries the change order's scope beneath the root's", async () => {
    await prisma.visitAssignment.create({ data: { visitId: jobId, technicianId } });
    const brief = await request(app).get(`/health-record/visits/${jobId}/job-brief`).set("Authorization", `Bearer ${techToken}`);
    expect(brief.status).toBe(200);
    expect(brief.body.data.estimate.number).toBe(parent.number);
    expect(brief.body.data.estimate.lines.length).toBeGreaterThan(0);
    expect(brief.body.data.estimate.changeOrders).toHaveLength(1);
    expect(brief.body.data.estimate.changeOrders[0].number).toBe(co.number);
    expect(brief.body.data.estimate.changeOrders[0].lines[0].quantity).toBe(2);
    const pay = await request(app).get(`/health-record/visits/${jobId}/payment-info`).set("Authorization", `Bearer ${techToken}`);
    expect(pay.body.data.number).toBe(parent.number);
  });

  it("the reminder sweep chases the root once and never the change order", async () => {
    // A finished job, long quiet: the root is a candidate; the change order must not be a second one.
    await prisma.visit.update({ where: { id: jobId }, data: { status: "completed", completedAt: new Date(Date.now() - 20 * 86_400_000) } });
    await prisma.issuedEstimate.updateMany({ where: { id: { in: [parent.id, co.id] } }, data: { signedAt: new Date(Date.now() - 30 * 86_400_000) } });
    await prisma.payment.updateMany({ where: { estimateId: parent.id }, data: { paidAt: new Date(Date.now() - 25 * 86_400_000) } });
    process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS = "on";
    try {
      emailMock.sendBrandedEmail.mockClear();
      await sweepInvoiceReminders(prisma);
    } finally {
      delete process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS;
    }
    const sentFor = emailMock.sendBrandedEmail.mock.calls.map((c) => c[0].issuedEstimateId as string).filter((id) => id === parent.id || id === co.id);
    expect(sentFor).toEqual([parent.id]);
    const rootRow = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: parent.id } });
    const coRow = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: co.id } });
    expect(rootRow.paymentRemindersSent).toBe(1);
    expect(coRow.paymentRemindersSent).toBe(0);
    // Put the job back so the void tests below see a live, unscheduled job.
    await prisma.visit.update({ where: { id: jobId }, data: { status: "contracted", completedAt: null } });
  });

  it("void: a root with a live change order is refused; voiding the change order takes only its share off and leaves the job open; then the root voids", async () => {
    const refused = await request(app).post(`/issued-estimates/${parent.id}/void`).send({ reason: "customer cancelled" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain(co.number);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: parent.id } })).voidedAt).toBeNull();

    const voidCo = await request(app).post(`/issued-estimates/${co.id}/void`).send({ reason: "decided against the extra fixtures" });
    expect(voidCo.status).toBe(200);
    expect(voidCo.body.jobAction).toBe("left_open_other_estimates");
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("contracted");
    const s = (await paymentSummary(prisma, parent.id, ORIGIN))!;
    expect(s.billedTotal).toBe(parentShare);
    expect(s.documents).toHaveLength(1);

    const voidRoot = await request(app).post(`/issued-estimates/${parent.id}/void`).send({ reason: "customer cancelled" });
    expect(voidRoot.status).toBe(200);
    expect(voidRoot.body.jobAction).toBe("cancelled_unscheduled");
  });
});

describe("the deposit is optional, with a manual override", () => {
  it("an estimate issued with the deposit off gates nothing, emails no deposit ask, and the page says so", async () => {
    const d = await quotableDraft("small job, no deposit");
    let est = await issue(d.id, { depositRequired: false });
    expect(est.depositRequired).toBe(false);
    emailMock.sendBrandedEmail.mockClear();
    est = await signInPerson(est.id);

    const s = (await paymentSummary(prisma, est.id, ORIGIN))!;
    expect(s.depositRequired).toBe(false);
    expect(s.depositDue).toBe(0);
    expect(s.depositSatisfied).toBe(true);
    expect(s.paidInFull).toBe(false);
    // The deposit request is never sent — the sign door's invoice email may be, the deposit email may not.
    const kinds = emailMock.sendBrandedEmail.mock.calls.map((c) => c[0].kind as string);
    expect(kinds).not.toContain("deposit");
    const ask = await request(app).post(`/issued-estimates/${est.id}/email-deposit-request`);
    expect(ask.status).toBe(400);
    expect(ask.body.error).toMatch(/no deposit is required/i);
    const dep = await chargeableAmount(prisma, est.token, "deposit");
    expect(dep.ok).toBe(false);
    // The customer's signed page: no "Next step — your deposit", and it says none is needed.
    const page = await request(app).get(`/e/${est.token}`);
    expect(page.status).toBe(200);
    expect(page.text).not.toContain("Next step — your deposit");
    expect(page.text).toContain("no deposit is needed");
    // The Jobs tab qualifies it without a deposit (Kyle, 2026-08-26 rule, now honouring the flag).
    const jobs = await request(app).get("/jobs");
    expect((jobs.body as Array<{ visitId: string }>).some((j) => j.visitId === est.jobVisitId)).toBe(true);

    // The manual override: turn it on after issue, and today's ⅓ is back.
    const on = await request(app).patch(`/issued-estimates/${est.id}/terms`).send({ depositRequired: true });
    expect(on.status).toBe(200);
    expect(on.body.depositRequired).toBe(true);
    const after = (await paymentSummary(prisma, est.id, ORIGIN))!;
    expect(after.depositRequired).toBe(true);
    expect(after.depositDue).toBe(round2(after.billedTotal / 3));
    expect(after.depositSatisfied).toBe(false);
    const trail = await prisma.issuedEstimateEvent.findFirst({ where: { estimateId: est.id, type: "terms_changed" } });
    expect(trail?.detail).toContain("deposit required");
  });

  it("a change order can carry its own deposit when Kyle ticks it — the ⅓ is then a third of BOTH shares", async () => {
    const d = await quotableDraft("bigger job");
    let parent = await issue(d.id);
    parent = await signInPerson(parent.id);
    const co = await raiseChangeOrder(parent.id, 1, { depositRequired: true });
    expect(co.depositRequired).toBe(true);
    await signInPerson(co.id);
    const s = (await paymentSummary(prisma, parent.id, ORIGIN))!;
    expect(s.documents).toHaveLength(2);
    expect(s.depositDue).toBe(round2(s.billedTotal / 3));
  });

  it("a change order that is NOT added to the current job gets a job of its own", async () => {
    const d = await quotableDraft("separate visit");
    let parent = await issue(d.id);
    parent = await signInPerson(parent.id);
    const co = await raiseChangeOrder(parent.id, 1, { addToCurrentJob: false });
    expect(co.addToCurrentJob).toBe(false);
    const signed = await signInPerson(co.id);
    expect(signed.jobVisitId).not.toBeNull();
    expect(signed.jobVisitId).not.toBe(parent.jobVisitId);
    // Still ONE invoice: the money joins the root even when the work is scheduled separately.
    const s = (await paymentSummary(prisma, co.id, ORIGIN))!;
    expect(s.estimateId).toBe(parent.id);
    expect(s.documents).toHaveLength(2);
  });
});
