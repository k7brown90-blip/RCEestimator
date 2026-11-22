/**
 * The Phase 1 events at the code sites where they happen (work order agent-team, BA6): one test per
 * site, each asserting exactly ONE HubEvent of the right type, and that the event never costs the
 * caller anything.
 *
 *   estimate.viewed    recordFirstView (first view only)
 *   estimate.signed    signEstimateInPerson and the emailed-link route /e/:token/sign
 *   estimate.accepted  POST /issued-estimates/:id/accept (acceptEstimateFromOffice): one accepted, ZERO signed
 *   payment.received   Stripe checkout.session.completed (a retry adds none), POST /financials/payments
 *                      (cash, a warranty company's check, a Synchrony payment)
 *   lead.created       POST /leads (the website door) and POST /crm/leads (the office door); NOT a renewal lead
 *   lead.web_chat      the booking chat's update_work_order, only on the call that made the lead
 *   job.completed      POST /jobs/:id/complete and the field's POST /health-record/visits/:id/complete
 *   material.used      POST /jobs/:id/consume (consumeForJob)
 *
 * Nothing here has an agent address set, so every event is recorded as no_target and nothing leaves
 * the process; hubEvents.test.ts covers delivery.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

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
  class MockOAuth2 { setCredentials() {} }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: { list: vi.fn().mockResolvedValue({ data: { items: [] } }), delete: vi.fn().mockResolvedValue({}) },
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
import { prisma } from "../src/lib/prisma";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft, recordFirstView, signEstimateInPerson } from "../src/services/issuedEstimateService";
import { dispatchStripeEvent, paymentSummary } from "../src/services/stripePayments";
import { runTool, type ToolContext } from "../src/services/bookingChat/tools";
import { getActiveFinancingPlans } from "../src/services/financingSettings";
import { defaultTruckId } from "../src/services/purchaseOrders";
import { emitHubEventSafe } from "../src/services/hubEvents";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "HUBSITE";
const ATOMIC = "HS001";
const WIRE = "HUBSITE-WIRE";
const DAY = 86_400_000;
const WEBHOOK_SECRET = "hubsite-webhook-secret";
const round2 = (n: number) => Math.round(n * 100) / 100;

let customerId: string;
let propertyId: string;
let supplierId: string;
const draftIds: string[] = [];

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Events of one type whose payload mentions `needle` (an id). Other tests' leftovers never match. */
const eventsOf = (type: string, needle: string) =>
  prisma.hubEvent.findMany({ where: { type, payloadJson: { contains: needle } }, orderBy: { createdAt: "asc" } });

/** Wait for the first event, then wait again to show no second one follows: "exactly one". */
async function exactlyOne(type: string, needle: string) {
  const end = Date.now() + 4000;
  while (Date.now() < end && (await eventsOf(type, needle)).length === 0) await pause(25);
  await pause(200);
  const rows = await eventsOf(type, needle);
  expect(rows, `${type} for ${needle}`).toHaveLength(1);
  return { row: rows[0], payload: JSON.parse(rows[0].payloadJson) as Record<string, unknown> };
}

async function none(type: string, needle: string) {
  await pause(250);
  expect(await eventsOf(type, needle)).toHaveLength(0);
}

async function wipeEvents() {
  await prisma.hubEventAttempt.deleteMany();
  await prisma.hubEvent.deleteMany();
}

beforeAll(async () => {
  delete process.env.HUB_AGENT_WEBHOOK_URL;
  process.env.WEBHOOK_SECRET = WEBHOOK_SECRET;
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ATOMIC)]);
  const customer = await prisma.customer.create({ data: { name: `${MARK} Customer`, email: "hubsite@example.com", phone: "615-555-0166" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "7 Event Ct", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  propertyId = property.id;
  await prisma.priceBookSupplier.create({ data: { id: `${MARK}-SUP`, name: `${MARK} Supply`, quotable: "YES" } });
  supplierId = `${MARK}-SUP`;
  await prisma.priceBookAtomic.deleteMany({ where: { itemId: WIRE } });
  await defaultTruckId();
});
beforeEach(wipeEvents);

afterAll(async () => {
  delete process.env.WEBHOOK_SECRET;
  const ests = await prisma.issuedEstimate.findMany({ where: { customerId }, select: { id: true } });
  const ids = ests.map((e) => e.id);
  await prisma.payment.deleteMany({ where: { OR: [{ estimateId: { in: ids } }, { customerId }] } });
  await prisma.financingFee.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.document.deleteMany({ where: { issuedEstimateId: { in: ids } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimateOption.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: ids } }, data: { supersedesId: null, changeOrderForId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: ids } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.stockMovement.deleteMany({ where: { itemId: { in: [WIRE] } } });
  await prisma.stockLevel.deleteMany({ where: { itemId: WIRE } });
  await prisma.purchaseOrder.deleteMany({ where: { job: { customerId } } });
  await prisma.visitAssignment.deleteMany({ where: { visit: { customerId } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.priceBookSupplier.deleteMany({ where: { id: supplierId } });
  await prisma.lead.deleteMany({ where: { name: { startsWith: MARK } } });
  await prisma.technician.deleteMany({ where: { name: { startsWith: MARK } } });
  await deleteAtomics([ATOMIC]);
  await wipeEvents();
});

async function issue(title: string) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId: null });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: ATOMIC, quantity: 1, quantitySource: "COUNT" });
  const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
  if (!g.ok) throw new Error(`graduation failed: ${JSON.stringify(g)}`);
  return prisma.issuedEstimate.findUniqueOrThrow({ where: { id: g.estimateId } });
}

async function put(id: string, status: "sent" | "viewed") {
  const sentAt = new Date(Date.now() - DAY);
  return prisma.issuedEstimate.update({
    where: { id },
    data: { status, sentAt, sentTo: "hubsite@example.com", firstViewedAt: status === "viewed" ? new Date(sentAt.getTime() + 3600_000) : null },
  });
}

describe("estimate events", () => {
  it("estimate.viewed: the first view emits one; a second view emits none", async () => {
    const est = await put((await issue("viewed")).id, "sent");
    await recordFirstView(prisma, est.id);
    await recordFirstView(prisma, est.id);
    const { payload } = await exactlyOne("estimate.viewed", est.id);
    expect(payload).toMatchObject({ estimate_id: est.id, estimate_number: est.number, revision: est.revision, customer_id: customerId, type: "estimate.viewed" });
    expect(payload.summary).toBe(`Estimate ${est.number} rev ${est.revision} viewed`);
    expect(JSON.stringify(payload)).not.toContain("hubsite@example.com");
    expect(JSON.stringify(payload)).not.toContain(MARK);
  });

  it("estimate.viewed: two simultaneous first opens (a mail scanner and the customer) record one view and emit one event", async () => {
    const est = await put((await issue("viewed-race")).id, "sent");
    await Promise.all([1, 2, 3, 4].map(() => recordFirstView(prisma, est.id)));
    await exactlyOne("estimate.viewed", est.id);
    expect(await prisma.issuedEstimateEvent.count({ where: { estimateId: est.id, type: "viewed" } })).toBe(1);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).status).toBe("viewed");
  });

  it("estimate.viewed: a lost estimate records no view and so no event", async () => {
    const est = await issue("viewed-lost");
    await prisma.issuedEstimate.update({ where: { id: est.id }, data: { status: "lost" } });
    await recordFirstView(prisma, est.id);
    await none("estimate.viewed", est.id);
  });

  it("estimate.signed: in-person signing emits one signed and no accepted", async () => {
    const est = await put((await issue("signed-in-person")).id, "sent");
    const r = await signEstimateInPerson(prisma, est.id, { signerName: "Bryan Crawford", signatureImage: TEST_SIGNATURE });
    expect(r.ok).toBe(true);
    const { payload } = await exactlyOne("estimate.signed", est.id);
    expect(payload).toMatchObject({ estimate_id: est.id, estimate_number: est.number, total: est.total });
    expect(JSON.stringify(payload)).not.toContain("Bryan");
    await none("estimate.accepted", est.id);
  });

  it("estimate.signed: the customer's emailed link emits one; a second press of Sign emits no second", async () => {
    const est = await put((await issue("signed-email")).id, "sent");
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } });
    const res = await request(app).post(`/e/${row.token}/sign`).send({ signerName: "Email Signer", signatureImage: TEST_SIGNATURE });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await request(app).post(`/e/${row.token}/sign`).send({ signerName: "Email Signer", signatureImage: TEST_SIGNATURE });
    await exactlyOne("estimate.signed", est.id);
    await none("estimate.accepted", est.id);
  });

  it("estimate.accepted: an office-recorded acceptance emits one accepted and ZERO signed, with no name and no job id", async () => {
    const est = await put((await issue("accepted")).id, "sent");
    const res = await request(app).post(`/issued-estimates/${est.id}/accept`).send({ acceptedVia: "phone", acceptedBy: "Bryan Crawford", note: "called back" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.jobVisitId).toBeTruthy();
    const { payload } = await exactlyOne("estimate.accepted", est.id);
    expect(payload).toMatchObject({ estimate_id: est.id, accepted_via: "phone", total: est.total, customer_id: customerId });
    expect(Array.isArray(payload.option_letters)).toBe(true);
    const text = JSON.stringify(payload);
    expect(text).not.toContain("Bryan");
    expect(text).not.toContain("called back");
    expect(text).not.toContain(res.body.jobVisitId as string);
    expect(Object.keys(payload)).not.toContain("job_id");
    await none("estimate.signed", est.id);
    // A refused acceptance (already accepted) emits nothing more.
    const again = await request(app).post(`/issued-estimates/${est.id}/accept`).send({ acceptedVia: "phone", acceptedBy: "Bryan Crawford" });
    expect(again.status).toBe(409);
    await pause(200);
    expect(await eventsOf("estimate.accepted", est.id)).toHaveLength(1);
  });
});

describe("payment.received", () => {
  it("Stripe: the first paid recording emits one; a retried or duplicated event emits no second", async () => {
    const est = await put((await issue("stripe")).id, "sent");
    const event = {
      id: "evt_hubsite_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_test_hubsite_${Date.now()}`, payment_status: "paid", amount_total: 5000, payment_intent: "pi_hubsite_1",
          metadata: { estimateId: est.id, customerId, baseAmount: "50", estimateNumber: est.number, kind: "deposit" },
        },
      },
    } as never;
    await dispatchStripeEvent(prisma, event);
    await dispatchStripeEvent(prisma, event);
    const payment = await prisma.payment.findFirstOrThrow({ where: { estimateId: est.id } });
    const { payload } = await exactlyOne("payment.received", payment.id);
    expect(payload).toMatchObject({ payment_id: payment.id, estimate_id: est.id, customer_id: customerId, amount: 50, method: "stripe", kind: "deposit", payer: "customer" });
    expect(JSON.stringify(payload)).not.toMatch(/cs_test|pi_hubsite|stripe_/);
  });

  it("an event failure never fails the Stripe 200: a payment whose estimate is gone still records", async () => {
    const event = {
      id: "evt_hubsite_2",
      type: "checkout.session.completed",
      data: { object: { id: `cs_test_hubsite_gone_${Date.now()}`, payment_status: "paid", amount_total: 1000, metadata: { baseAmount: "10", customerId } } },
    } as never;
    await expect(dispatchStripeEvent(prisma, event)).resolves.toBeUndefined();
  });

  it("a payment recorded by hand (cash) emits one, with no check number or note", async () => {
    const est = await put((await issue("cash")).id, "sent");
    const res = await request(app).post("/financials/payments").send({ amount: 25, method: "cash", kind: "other", estimateId: est.id, customerId, note: "left under the mat" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { payload } = await exactlyOne("payment.received", res.body.id);
    expect(payload).toMatchObject({ payment_id: res.body.id, estimate_id: est.id, amount: 25, method: "cash", payer: "customer" });
    expect(JSON.stringify(payload)).not.toContain("under the mat");
  });

  it("a warranty company's check emits one, payer warranty", async () => {
    const est = await put((await issue("warranty")).id, "sent");
    await prisma.issuedEstimate.update({
      where: { id: est.id },
      data: {
        status: "signed", signedAt: new Date(), signerName: "W", signedChannel: "email", selectedOptions: ["A"],
        warrantyJson: JSON.stringify({ company: "RELY Home", claimNumber: "343467219", authNumber: "auth1", coveredAmount: 370, note: "n", setAt: "2026-09-09T15:00:00.000Z" }),
      },
    });
    const res = await request(app).post("/financials/payments").send({ amount: 1, method: "check", checkNumber: "9912", kind: "final", payer: "warranty", estimateId: est.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { payload } = await exactlyOne("payment.received", res.body.id);
    expect(payload).toMatchObject({ payment_id: res.body.id, payer: "warranty", method: "check" });
    expect(JSON.stringify(payload)).not.toMatch(/RELY|343467219|9912/);
  });

  it("a Synchrony payment emits one", async () => {
    const plan = (await getActiveFinancingPlans())[0];
    const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} fin draft`, supplierId } });
    const visit = await prisma.visit.create({ data: { customerId, propertyId, mode: "service_diagnostic", purpose: `${MARK} visit`, status: "scheduled" } });
    const est = await prisma.issuedEstimate.create({
      data: {
        number: `0000-${MARK}FIN`, token: `hubsitefin${Date.now().toString(16)}`.padEnd(64, "0"), status: "signed", draftId: draft.id, customerId,
        serviceAddressId: propertyId, customerName: `${MARK} Customer`, customerEmail: "hubsite@example.com", serviceAddress: "7 Event Ct, Smyrna, TN",
        title: "Panel upgrade", scopeText: "Panel upgrade.", workSubtotal: 350, tripCharge: 75, total: 425, sentAt: new Date(), sentTo: "hubsite@example.com",
        visitId: visit.id, jobVisitId: visit.id, signedAt: new Date(), signerName: `${MARK} Customer`, signedChannel: "email", depositRequired: true,
        selectedOptions: ["A"], comboCapJson: JSON.stringify({ applied: false, reduction: 0, ceiling: 0, bandLabel: "n/a" }),
        options: { create: [{ option: "A", label: "Panel", subtotal: 350, lineCount: 2 }] },
      },
    });
    draftIds.push(draft.id);
    await request(app).post("/financials/payments").send({ amount: 141.67, method: "cash", kind: "deposit", estimateId: est.id, customerId }).expect(201);
    const fee = await request(app).post("/financials/financing-fees").send({ estimateId: est.id, planNumber: plan.planNumber });
    expect(fee.status, JSON.stringify(fee.body)).toBe(201);
    const owed = round2(283.33 + (fee.body.fee as number));
    const res = await request(app).post("/financials/payments").send({ amount: owed, method: "synchrony", estimateId: est.id, planNumber: plan.planNumber, authNumber: "AUTH-1" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { payload } = await exactlyOne("payment.received", res.body.id);
    expect(payload).toMatchObject({ payment_id: res.body.id, method: "synchrony", amount: owed, estimate_id: est.id });
    expect(JSON.stringify(payload)).not.toContain("AUTH-1");
    expect((await paymentSummary(prisma, est.id, "https://unused.invalid"))?.paidInFull).toBe(true);
  });
});

describe("lead events", () => {
  it("lead.created: the website door emits one, with no name, phone, email or address", async () => {
    const res = await request(app).post("/leads").set("webhook_secret", WEBHOOK_SECRET)
      .send({ name: `${MARK} Web Person`, phone: "615-555-0171", email: "web.person@example.com", address: "1 Private Rd", source: "web", platform: "google" });
    expect(res.status).toBe(201);
    const { payload } = await exactlyOne("lead.created", res.body.id);
    expect(payload).toMatchObject({ lead_id: res.body.id, source: "web", platform: "google", urgent: false });
    const text = JSON.stringify(payload);
    for (const leaked of ["Web Person", "0171", "web.person", "Private Rd", MARK]) expect(text).not.toContain(leaked);
  });

  it("lead.created: the office door emits one", async () => {
    const res = await request(app).post("/crm/leads").send({ name: `${MARK} Office Person`, phone: "(615) 555-0172", city: "Smyrna", postalCode: "37167" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { payload } = await exactlyOne("lead.created", res.body.lead.id);
    expect(payload).toMatchObject({ lead_id: res.body.lead.id, source: "manual" });
  });

  it("lead.created: a refused website lead (no secret) emits nothing", async () => {
    await request(app).post("/leads").send({ name: `${MARK} Refused` }).expect(401);
    await pause(200);
    expect(await prisma.hubEvent.count({ where: { type: "lead.created" } })).toBe(0);
  });

  it("lead.created: the automatic renewal lead never emits (no emit line in the retention sweep)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const text = readFileSync(join(__dirname, "..", "src", "services", "inspectionRetention.ts"), "utf8");
    expect(text).not.toMatch(/emitHubEvent/);
    // Nor does a draft lead an agent makes: the emit lives at the two routes, not in a lead-making service.
    for (const f of ["leadState.ts", "leadFunnel.ts", "leadBallpark.ts"]) {
      expect(readFileSync(join(__dirname, "..", "src", "services", f), "utf8")).not.toMatch(/emitHubEvent/);
    }
  });

  it("lead.web_chat: the call that makes the lead emits one; a later update of the same chat emits none", async () => {
    const chat = await prisma.bookingChat.create({ data: { token: `hubsite-chat-${Date.now()}` } });
    const ctx = (): ToolContext => ({ chatId: chat.id, smsConsent: undefined, ended: false, summaries: [] });
    const first = await runTool("update_work_order", JSON.stringify({ name: `${MARK} Chat Person`, phone: "(615) 555-0173" }), ctx());
    expect(first.output.ok).toBe(true);
    const lead = await prisma.lead.findFirstOrThrow({ where: { name: `${MARK} Chat Person` } });
    const { payload } = await exactlyOne("lead.web_chat", lead.id);
    expect(payload).toMatchObject({ lead_id: lead.id, source: "web" });
    expect(JSON.stringify(payload)).not.toContain("Chat Person");
    await runTool("update_work_order", JSON.stringify({ original_request: "Breaker trips" }), ctx());
    await pause(250);
    expect(await eventsOf("lead.web_chat", lead.id)).toHaveLength(1);
    // And a chat that has no phone yet makes no lead, so no event.
    const quiet = await prisma.bookingChat.create({ data: { token: `hubsite-chat2-${Date.now()}` } });
    await runTool("update_work_order", JSON.stringify({ name: `${MARK} No Phone` }), { chatId: quiet.id, smsConsent: undefined, ended: false, summaries: [] });
    expect(await prisma.lead.count({ where: { name: `${MARK} No Phone` } })).toBe(0);
    await prisma.bookingChat.deleteMany({ where: { id: { in: [chat.id, quiet.id] } } });
  });
});

describe("job.completed and material.used", () => {
  async function job() {
    return prisma.visit.create({
      data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, jobType: "Panel upgrade", status: "in_progress", visitDate: new Date() },
    });
  }

  it("job.completed: the CRM door emits one", async () => {
    const v = await job();
    const res = await request(app).post(`/jobs/${v.id}/complete`).send({});
    expect(res.status).toBe(200);
    const { payload } = await exactlyOne("job.completed", v.id);
    expect(payload).toMatchObject({ job_id: v.id, customer_id: customerId, summary: "Job marked complete" });
    expect(Object.keys(payload).sort()).toEqual(["customer_id", "event_id", "job_id", "occurred_at", "summary", "type"]);
    expect(JSON.stringify(payload)).not.toContain("Event Ct");
  });

  it("job.completed: the customer's typed job type (free text) never reaches the payload", async () => {
    const v = await prisma.visit.create({
      data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, jobType: "Panel for Mary Jones, gate code 4471", status: "in_progress", visitDate: new Date() },
    });
    await request(app).post(`/jobs/${v.id}/complete`).send({}).expect(200);
    const { row } = await exactlyOne("job.completed", v.id);
    for (const leaked of ["Mary", "Jones", "gate code", "4471", "Panel"]) expect(row.payloadJson).not.toContain(leaked);
  });

  it("job.completed: pressing Complete again on a finished job emits no second event (CRM door)", async () => {
    const v = await job();
    await request(app).post(`/jobs/${v.id}/complete`).send({}).expect(200);
    await request(app).post(`/jobs/${v.id}/complete`).send({}).expect(200);
    await exactlyOne("job.completed", v.id);
  });

  it("job.completed: the second technician closing out a two-tech job, and a repeat press, emit no second event (field door)", async () => {
    const a = await prisma.technician.create({ data: { name: `${MARK} Tech A`, accessToken: `hubsite-tecA-${Date.now()}`, role: "technician" } });
    const b = await prisma.technician.create({ data: { name: `${MARK} Tech B`, accessToken: `hubsite-tecB-${Date.now()}`, role: "technician" } });
    const v = await job();
    await prisma.visitAssignment.create({ data: { visitId: v.id, technicianId: a.id } });
    await prisma.visitAssignment.create({ data: { visitId: v.id, technicianId: b.id } });
    const close = (t: { accessToken: string }) =>
      request(app).post(`/health-record/visits/${v.id}/complete`).set("Authorization", `Bearer ${t.accessToken}`).send({});
    expect((await close(a)).status).toBe(200);
    expect((await close(b)).status).toBe(200);
    expect((await close(b)).status).toBe(200);
    await exactlyOne("job.completed", v.id);
    // Both assignments still closed out: only the announcement was held back.
    expect(await prisma.visitAssignment.count({ where: { visitId: v.id, status: "completed" } })).toBe(2);
  });

  it("job.completed: a cancelled job refuses and emits nothing", async () => {
    const v = await job();
    await prisma.visit.update({ where: { id: v.id }, data: { status: "cancelled" } });
    await request(app).post(`/jobs/${v.id}/complete`).send({}).expect(409);
    await none("job.completed", v.id);
  });

  it("job.completed: the field door emits one too", async () => {
    const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `hubsite-tech-${Date.now()}`, role: "technician" } });
    const v = await job();
    await prisma.visitAssignment.create({ data: { visitId: v.id, technicianId: tech.id } });
    const res = await request(app).post(`/health-record/visits/${v.id}/complete`).set("Authorization", `Bearer ${tech.accessToken}`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await exactlyOne("job.completed", v.id);
  });

  it("material.used: the consume door emits one event for the whole call, with movement ids and no item names", async () => {
    const v = await job();
    const res = await request(app).post(`/jobs/${v.id}/consume`).send({
      lines: [{ itemId: WIRE, name: "Secret Brand 12-2", qty: 5, unit: "ft" }, { itemId: `${WIRE}-2`, name: "Other thing", qty: 2, unit: "ea" }],
      reason: "used", allowNegative: true,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const ids = (res.body as Array<{ id: string }>).map((m) => m.id);
    const { payload } = await exactlyOne("material.used", v.id);
    expect(payload).toMatchObject({ job_id: v.id, line_count: 2 });
    expect([...(payload.movement_ids as string[])].sort()).toEqual([...ids].sort());
    expect(JSON.stringify(payload)).not.toMatch(/Secret Brand|Other thing|HUBSITE-WIRE/);
    await prisma.stockMovement.deleteMany({ where: { itemId: { in: [WIRE, `${WIRE}-2`] } } });
    await prisma.stockLevel.deleteMany({ where: { itemId: { in: [WIRE, `${WIRE}-2`] } } });
  });

  it("material.used: a refused consume (truck short, no override) emits nothing", async () => {
    const v = await job();
    const res = await request(app).post(`/jobs/${v.id}/consume`).send({ lines: [{ itemId: `${WIRE}-3`, name: "x", qty: 9999, unit: "ft" }], reason: "used" });
    expect(res.status).toBe(409);
    await none("material.used", v.id);
  });
});

describe("an event never costs its caller anything", () => {
  it("emitHubEventSafe resolves null, never throws, when the record does not exist", async () => {
    await expect(emitHubEventSafe({ type: "estimate.viewed", estimateId: "does-not-exist" })).resolves.toBeNull();
    await expect(emitHubEventSafe({ type: "material.used", jobId: "x", movementIds: [] })).resolves.toEqual(expect.any(String));
  });

  it("every emit site calls it as fire-and-forget: `void emitHubEventSafe(`, never awaited", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files = [
      "services/issuedEstimateService.ts", "services/officeAcceptance.ts", "services/stripePayments.ts", "routes/financials.ts",
      "services/financingFee.ts", "app.ts", "routes/health-record.ts", "services/jobMaterials.ts", "services/bookingChat/tools.ts", "services/hub.ts",
    ];
    for (const f of files) {
      const text = readFileSync(join(__dirname, "..", "src", f), "utf8");
      const calls = text.match(/emitHubEventSafe\(/g) ?? [];
      const voided = text.match(/void emitHubEventSafe\(/g) ?? [];
      // The import line has no "(" after the name, so every call in the file is a voided one.
      expect(voided.length, f).toBe(calls.length);
      expect(calls.length, f).toBeGreaterThan(0);
    }
  });
});
