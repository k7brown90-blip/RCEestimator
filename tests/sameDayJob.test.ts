/**
 * Complete work now · Schedule for later · Pause job (Kyle, 2026-09-21).
 *
 * Pins the six done-criteria of .claude/plans/2026-09-21-complete-work-now.md:
 *   1. Complete work now leaves ONE Visit carrying the estimate, time, P.O.s and payments, shown
 *      as a job; its Mark complete closes the job and the balance reminder becomes eligible.
 *   2. A same-day job sends the customer nothing — the deposit-request email never goes out.
 *   3. Schedule for later leaves a contracted job for the admin; the field can no longer book.
 *   4. Pause returns a job to the admin keeping its money and records; distinct from the clock pause.
 *   5. The consultation's hours (and its P.O.s' fees) appear on the job in all four readers.
 *   6. The field deposit checkbox reaches `depositRequired`.
 *
 * The field signs through the customer's PUBLIC page (POST /e/:token/sign), exactly as the phone
 * does, so the deposit-request hold is exercised on the real door. Customer emails are counted,
 * never sent (sendBrandedEmail mocked); the calendar is mocked and its deletes recorded.
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

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
}));
const calendarMock = vi.hoisted(() => ({ deleted: [] as string[] }));
vi.mock("googleapis", () => {
  class MockOAuth2 {
    setCredentials() {}
  }
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: { primary: { busy: [] } } } }) },
        events: {
          list: vi.fn().mockResolvedValue({ data: { items: [] } }),
          insert: vi.fn().mockResolvedValue({ data: { id: `evt_${crypto.randomUUID()}` } }),
          delete: vi.fn().mockImplementation((p: { eventId: string }) => { calendarMock.deleted.push(p.eventId); return Promise.resolve({}); }),
          get: vi.fn().mockResolvedValue({ data: {} }),
        },
      }),
    },
  };
});
// Customer emails are counted, never sent.
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(true) };
});

import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { createPurchaseOrder, defaultTruckId } from "../src/services/purchaseOrders";
import { recomputeVisitLabor, jobTime, commissionBasisForJob } from "../src/services/timeTracking";
import { sweepInvoiceReminders } from "../src/services/invoiceReminders";
import { EVENT_DEPOSIT_CANCELLED, EVENT_DEPOSIT_HELD, EVENT_DEPOSIT_RELEASED, EVENT_JOB_PAUSED, EVENT_SAME_DAY_JOB } from "../src/services/sameDayJob";
import { signedBy } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "SDJ";
const ITEM = "SDJ001";
const newId = () => crypto.randomUUID().replaceAll("-", "");
const HOUR = 3_600_000;

let customerId: string;
let propertyId: string;
let technicianId: string;
let techToken: string;
let truckId: string;
const draftIds: string[] = [];
const visitIds: string[] = [];
const spendIds: string[] = [];

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);

/** Deposit-request emails sent so far, by estimate id. */
const depositEmailsFor = (estimateId: string) =>
  emailMock.sendBrandedEmail.mock.calls.filter((c) => c[0].kind === "deposit" && c[0].issuedEstimateId === estimateId).length;

/** Poll the database until `check` is true — the sign door's job creation and deposit step are fire-and-forget. */
async function waitFor(check: () => Promise<boolean>, what: string, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

/** A technician's consultation, underway: status estimate, booked an hour ago, this tech assigned. */
async function consultation(label: string, opts: { assigned?: boolean; scheduledStart?: Date | null } = {}) {
  const visit = await prisma.visit.create({
    data: {
      customerId, propertyId, mode: "onsite", purpose: `${MARK} ${label}`, status: "estimate",
      scheduledStart: opts.scheduledStart === undefined ? new Date(Date.now() - HOUR) : opts.scheduledStart,
      scheduledEnd: opts.scheduledStart === undefined ? new Date(Date.now() + HOUR) : null,
    },
  });
  visitIds.push(visit.id);
  if (opts.assigned !== false) await prisma.visitAssignment.create({ data: { visitId: visit.id, technicianId } });
  return visit;
}

/** Build and ISSUE a quote on the visit through the FIELD route, with the deposit checkbox as given. */
async function issueFromField(visitId: string, body: { depositRequired?: boolean } = {}) {
  const d = await createDraft(prisma, { title: `${MARK} quote`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: ITEM, quantity: 2, quantitySource: "COUNT" });
  const res = await auth(request(app).post(`/health-record/quotes/${d.id}/issue`)).send(body);
  expect(res.status).toBe(201);
  return prisma.issuedEstimate.findUniqueOrThrow({ where: { id: res.body.data.estimateId as string } });
}

/** The customer signs on the PUBLIC page — the door the field app opens. Waits for the sign door's async steps. */
async function signOnPublicPage(estimateId: string) {
  const est = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: estimateId } });
  const res = await request(app).post(`/e/${est.token}/sign`).type("form").send(signedBy("Field Customer"));
  expect(res.status).toBe(200);
  await waitFor(async () => Boolean((await prisma.issuedEstimate.findUnique({ where: { id: estimateId } }))?.jobVisitId), "job creation after sign");
  // Every signature in this file either holds the request (an event) or sends it (a counted email).
  await waitFor(async () => {
    const held = await prisma.issuedEstimateEvent.count({ where: { estimateId, type: EVENT_DEPOSIT_HELD } });
    return held > 0 || depositEmailsFor(estimateId) > 0;
  }, "deposit step after sign");
  // The owner notification runs after the deposit step; give it a tick so nothing lands mid-assertion.
  await new Promise((r) => setTimeout(r, 100));
  return prisma.issuedEstimate.findUniqueOrThrow({ where: { id: estimateId } });
}

async function clock(visitId: string, minutes: number, opts: { open?: boolean } = {}) {
  const startedAt = new Date(Date.now() - minutes * 60_000 - 60_000);
  const row = await prisma.timeEntry.create({
    data: opts.open
      ? { visitId, technicianId, startedAt }
      : { visitId, technicianId, startedAt, endedAt: new Date(startedAt.getTime() + minutes * 60_000), minutes, endedReason: "completed", rateApplied: 30 },
  });
  await recomputeVisitLabor(visitId);
  return row;
}

async function poWithFee(visitId: string, feeAmount: number) {
  const po = await createPurchaseOrder({
    supplier: `${MARK} Permit Office`, purpose: "truck_stock", truckId, jobId: visitId, openedBy: "tech", openedByTechnicianId: technicianId,
    actor: "test", lines: [{ name: "Electrical permit", qty: 1 }],
  });
  const spend = await prisma.cardSpend.create({
    data: {
      stripeTransactionId: `sdj_${newId()}`, stripeCardId: "card_sdj", truckId, kind: "permit", amount: feeAmount,
      merchantName: `${MARK} Permit Office`, purchaseOrderId: po.id, occurredAt: new Date(),
    },
  });
  spendIds.push(spend.id);
  return po;
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ITEM)]);
  truckId = await defaultTruckId();
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Homeowner`, email: `sdj-${newId()}@example.com`, phone: "615-555-0177" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "9 Same Day Dr", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  propertyId = property.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `sdj-${newId()}`, hourlyRate: 30 } });
  technicianId = tech.id;
  techToken = tech.accessToken;
});

afterAll(async () => {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: draftIds } }, select: { id: true, jobVisitId: true } });
  const estIds = ests.map((e) => e.id);
  const allVisitIds = [...new Set([...visitIds, ...ests.map((e) => e.jobVisitId).filter((v): v is string => Boolean(v))])];
  await prisma.payment.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.emailDelivery.deleteMany({ where: { issuedEstimateId: { in: estIds } } });
  await prisma.cardSpend.deleteMany({ where: { id: { in: spendIds } } });
  const pos = await prisma.purchaseOrder.findMany({ where: { jobId: { in: allVisitIds } }, select: { id: true } });
  await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: { in: pos.map((p) => p.id) } } });
  await prisma.purchaseOrder.deleteMany({ where: { id: { in: pos.map((p) => p.id) } } });
  await prisma.timeEntry.deleteMany({ where: { visitId: { in: allVisitIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: allVisitIds } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ITEM]);
});

describe("Complete work now — one Visit, no customer message, closes as a job", () => {
  let consult: { id: string };
  let est: Awaited<ReturnType<typeof issueFromField>>;
  let mintedJobId: string;

  it("the field deposit checkbox reaches depositRequired (check 6)", async () => {
    consult = await consultation("water heater circuit");
    est = await issueFromField(consult.id, { depositRequired: false });
    expect(est.depositRequired).toBe(false);
    // And the other way, on a second draft (a different visit — one live quote per visit).
    const other = await consultation("deposit on");
    const on = await issueFromField(other.id, { depositRequired: true });
    expect(on.depositRequired).toBe(true);
  });

  it("the public-page signature mints the job but HOLDS the deposit request while the tech's consultation is open (check 2)", async () => {
    // Time and a P.O. already on the consultation before the customer signs — the day's work.
    await clock(consult.id, 60);
    await poWithFee(consult.id, 40);
    est = await signOnPublicPage(est.id);
    expect(est.jobVisitId).toBeTruthy();
    expect(est.jobVisitId).not.toBe(consult.id);
    mintedJobId = est.jobVisitId!;
    const held = await prisma.issuedEstimateEvent.count({ where: { estimateId: est.id, type: EVENT_DEPOSIT_HELD } });
    expect(held).toBe(1);
    expect(depositEmailsFor(est.id)).toBe(0);
    const brief = await auth(request(app).get(`/health-record/visits/${consult.id}/job-brief`));
    expect(brief.body.data.choicePending).toBe(true);
    expect(brief.body.data.estimate.signedAt).toBeTruthy();
  });

  it("Complete work now: the consultation becomes the job, the empty minted Visit is gone, everything stays on the one Visit (check 1)", async () => {
    const res = await auth(request(app).post(`/health-record/visits/${consult.id}/complete-work-now`)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ jobVisitId: consult.id, removedVisitId: mintedJobId, alreadyDone: false });

    const after = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } });
    expect(after.jobVisitId).toBe(consult.id);
    expect(after.visitId).toBe(consult.id);
    expect(await prisma.visit.findUnique({ where: { id: mintedJobId } })).toBeNull();
    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: consult.id } });
    expect(visit.status).toBe("in_progress");
    expect(visit.contractedAt?.getTime()).toBe(after.signedAt!.getTime());
    expect(visit.estimatedCost).toBe(after.total);
    expect(visit.scheduledStart).not.toBeNull(); // the consultation's calendar block stays
    expect(visit.laborHours).toBe(1);
    expect(await prisma.purchaseOrder.count({ where: { jobId: consult.id } })).toBe(1);
    expect(await prisma.timeEntry.count({ where: { visitId: consult.id } })).toBe(1);
    expect(await prisma.visitAssignment.count({ where: { visitId: consult.id, technicianId } })).toBe(1);
    const types = (await prisma.issuedEstimateEvent.findMany({ where: { estimateId: est.id }, select: { type: true } })).map((e) => e.type);
    expect(types).toContain(EVENT_SAME_DAY_JOB);
    expect(types).toContain(EVENT_DEPOSIT_CANCELLED);

    // A second tap is idempotent.
    const again = await auth(request(app).post(`/health-record/visits/${consult.id}/complete-work-now`)).send({});
    expect(again.status).toBe(200);
    expect(again.body.data.alreadyDone).toBe(true);
  });

  it("it shows as a JOB — on the Jobs tab with its hours, and to the phone as a job with no choice pending", async () => {
    const jobs = await request(app).get("/jobs");
    const card = (jobs.body as Array<{ visitId: string; status: string; costs: { laborHours: number }; estimate: { id: string } | null }>).find((j) => j.visitId === consult.id);
    expect(card).toBeTruthy();
    expect(card!.status).toBe("in_progress");
    expect(card!.costs.laborHours).toBe(1);
    expect(card!.estimate?.id).toBe(est.id);
    expect((jobs.body as Array<{ visitId: string }>).some((j) => j.visitId === mintedJobId)).toBe(false);

    const brief = await auth(request(app).get(`/health-record/visits/${consult.id}/job-brief`));
    expect(brief.body.data.status).toBe("in_progress");
    expect(brief.body.data.choicePending).toBe(false);
    expect(brief.body.data.estimate.number).toBe(est.number);
    const pay = await auth(request(app).get(`/health-record/visits/${consult.id}/payment-info`));
    expect(pay.body.data.number).toBe(est.number);
  });

  it("the field's Mark complete takes the JOB branch, and the balance reminder becomes eligible; still no deposit email (checks 1, 2)", async () => {
    const res = await auth(request(app).post(`/health-record/visits/${consult.id}/complete`)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.completed).toBe(true);
    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: consult.id } });
    expect(visit.status).toBe("completed");
    expect(visit.completedAt).not.toBeNull();

    // The reminder sweep's own rule: the estimate's jobVisitId job is completed with completedAt,
    // and the quiet days have passed — so it reminds. Before this build the job stayed
    // "contracted" forever and this could never fire.
    await prisma.visit.update({ where: { id: consult.id }, data: { completedAt: new Date(Date.now() - 20 * 86_400_000) } });
    await prisma.issuedEstimate.update({ where: { id: est.id }, data: { signedAt: new Date(Date.now() - 30 * 86_400_000) } });
    process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS = "on";
    try {
      await sweepInvoiceReminders(prisma);
    } finally {
      delete process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS;
    }
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } });
    expect(row.paymentRemindersSent).toBe(1);

    // Through all of it: no deposit-request email, no appointment email, for this same-day job.
    expect(depositEmailsFor(est.id)).toBe(0);
    const kindsForJob = emailMock.sendBrandedEmail.mock.calls.filter((c) => c[0].issuedEstimateId === est.id).map((c) => c[0].kind as string);
    expect(kindsForJob).not.toContain("deposit");
    expect(kindsForJob).not.toContain("appointment");
  });

  it("refuses to fold in a minted job the office already scheduled — nothing attached is ever deleted", async () => {
    const c = await consultation("office was quick");
    let e = await issueFromField(c.id, { depositRequired: false });
    e = await signOnPublicPage(e.id);
    await prisma.visit.update({ where: { id: e.jobVisitId! }, data: { scheduledStart: new Date(Date.now() + 5 * 86_400_000), googleEventId: "evt_office" } });
    const res = await auth(request(app).post(`/health-record/visits/${c.id}/complete-work-now`)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/already scheduled/i);
    expect(await prisma.visit.findUnique({ where: { id: e.jobVisitId! } })).not.toBeNull();
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("estimate");
  });
});

describe("Schedule for later — the job goes to the office; the field cannot book (check 3)", () => {
  let consult: { id: string };
  let est: Awaited<ReturnType<typeof issueFromField>>;
  let jobId: string;

  it("the held deposit request is released when the tech chooses Schedule for later; the consultation closes properly", async () => {
    consult = await consultation("service upgrade");
    est = await issueFromField(consult.id, {});
    expect(est.depositRequired).toBe(true);
    await clock(consult.id, 120);
    await poWithFee(consult.id, 75);
    est = await signOnPublicPage(est.id);
    jobId = est.jobVisitId!;
    expect(depositEmailsFor(est.id)).toBe(0);

    const res = await auth(request(app).post(`/health-record/visits/${consult.id}/schedule-for-later`)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ jobVisitId: jobId, depositRequestReleased: true });

    const c = await prisma.visit.findUniqueOrThrow({ where: { id: consult.id } });
    expect(c.status).toBe("estimate");
    expect(c.completedAt).not.toBeNull();
    expect(c.nextStep).toBe("archived");
    expect((await prisma.visitAssignment.findFirstOrThrow({ where: { visitId: consult.id, technicianId } })).status).toBe("completed");
    const job = await prisma.visit.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("contracted");
    expect(job.scheduledStart).toBeNull();
    expect(job.googleEventId).toBeNull();
    // The deposit request went out exactly once — now, not at the signature.
    expect(depositEmailsFor(est.id)).toBe(1);
    const types = (await prisma.issuedEstimateEvent.findMany({ where: { estimateId: est.id }, orderBy: { at: "asc" }, select: { type: true } })).map((e) => e.type);
    expect(types).toContain(EVENT_DEPOSIT_RELEASED);
    expect(types.indexOf(EVENT_DEPOSIT_HELD)).toBeLessThan(types.indexOf(EVENT_DEPOSIT_RELEASED));
  });

  it("the field's own booking route is gone", async () => {
    const res = await auth(request(app).post(`/health-record/visits/${jobId}/schedule`)).send({ date: "2030-01-15", time: "08:00" });
    expect(res.status).toBe(404);
    const avail = await auth(request(app).get(`/health-record/schedule-availability?date=2030-01-15`));
    expect(avail.status).toBe(404);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: jobId } })).scheduledStart).toBeNull();
  });

  it("the consultation's hours and fees roll onto the job in all four readers (check 5)", async () => {
    // An hour on the job itself, two on the consultation, a $75 permit on the consultation's P.O.
    await prisma.visitAssignment.create({ data: { visitId: jobId, technicianId } });
    await clock(jobId, 60);
    // Open the deposit gate so the Jobs tab lists the contracted job.
    await prisma.payment.create({ data: { customerId, estimateId: est.id, visitId: jobId, amount: est.total, method: "cash", status: "paid", paidAt: new Date() } });

    // Reader 1 — the Jobs card.
    const jobs = await request(app).get("/jobs");
    const card = (jobs.body as Array<{ visitId: string; costs: { laborHours: number }; costsRolledUpTo: string | null }>).find((j) => j.visitId === jobId);
    expect(card).toBeTruthy();
    expect(card!.costs.laborHours).toBe(3);

    // Reader 2 — job profitability.
    const year = new Date().getFullYear();
    const prof = await request(app).get(`/financials/job-profitability?year=${year}`);
    expect(prof.status).toBe(200);
    const row = (prof.body as Array<{ visitId: string; laborHours: number }>).find((r) => r.visitId === jobId);
    expect(row).toBeTruthy();
    expect(row!.laborHours).toBe(3);

    // Reader 3 — the job's own time view.
    const time = await jobTime(jobId);
    expect(time.totalMinutes).toBe(180);
    expect(time.sessions.map((s) => s.visitId).sort()).toEqual([consult.id, jobId].sort());

    // Reader 4 — the commission basis: the permit on the consultation's P.O. is this job's fee.
    const basis = await commissionBasisForJob(jobId);
    expect(basis.fees).toBe(75);

    // And the account page, which always did it, still agrees.
    const summary = await request(app).get(`/accounts/${customerId}/summary`);
    const acct = (summary.body.jobs as Array<{ visitId: string; costs: { laborHours: number }; costsRolledUpTo: string | null }>);
    expect(acct.find((j) => j.visitId === jobId)!.costs.laborHours).toBe(3);
    expect(acct.find((j) => j.visitId === consult.id)!.costsRolledUpTo).toBe(jobId);
  });

  it("Pause job (field) sends a job underway back to scheduling, keeping everything on it; the customer hears nothing (check 4)", async () => {
    await prisma.visit.update({
      where: { id: jobId },
      data: { status: "in_progress", scheduledStart: new Date(Date.now() - 2 * HOUR), scheduledEnd: new Date(Date.now() + 4 * HOUR), googleEventId: "evt_pause_future" },
    });
    await clock(jobId, 30, { open: true });
    const emailsBefore = emailMock.sendBrandedEmail.mock.calls.length;

    const res = await auth(request(app).post(`/health-record/visits/${jobId}/pause-job`)).send({ reason: "ran out of daylight" });
    expect(res.status).toBe(200);
    expect(res.body.data.paused).toBe(true);
    expect(res.body.data.sessionsClosed).toBe(1);

    const job = await prisma.visit.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("contracted");
    expect(job.scheduledStart).toBeNull();
    expect(job.scheduledEnd).toBeNull();
    // The block had not ended: the calendar event is released.
    expect(calendarMock.deleted).toContain("evt_pause_future");
    expect(job.googleEventId).toBeNull();
    // Everything stays: estimate link, payment, P.O. on the chain, time (the open session closed as "paused").
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).jobVisitId).toBe(jobId);
    expect(await prisma.payment.count({ where: { estimateId: est.id, status: "paid" } })).toBe(1);
    expect(await prisma.purchaseOrder.count({ where: { jobId: consult.id } })).toBe(1);
    expect(await prisma.timeEntry.count({ where: { visitId: jobId, endedAt: null } })).toBe(0);
    expect((await prisma.timeEntry.findFirstOrThrow({ where: { visitId: jobId, endedReason: "paused" } })).minutes).toBeGreaterThan(0);
    expect(job.laborHours).toBeGreaterThanOrEqual(1);
    expect(await prisma.visitAssignment.count({ where: { visitId: jobId, technicianId } })).toBe(1);
    const types = (await prisma.issuedEstimateEvent.findMany({ where: { estimateId: est.id }, select: { type: true } })).map((e) => e.type);
    expect(types).toContain(EVENT_JOB_PAUSED);
    expect(emailMock.sendBrandedEmail.mock.calls.length).toBe(emailsBefore);

    // Paused = contracted = back on the office's unscheduled rail, and schedulable again.
    const jobs = await request(app).get("/jobs");
    expect((jobs.body as Array<{ visitId: string; status: string }>).find((j) => j.visitId === jobId)!.status).toBe("contracted");
    const again = await request(app).post(`/jobs/${jobId}/pause-for-later`).send({});
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already waiting/i);
  });

  it("the CLOCK's pause is a different verb: it closes a session and leaves the job exactly where it was", async () => {
    await prisma.visit.update({ where: { id: jobId }, data: { status: "in_progress", scheduledStart: new Date(Date.now() - HOUR), scheduledEnd: new Date(Date.now() + HOUR) } });
    await clock(jobId, 15, { open: true });
    const res = await auth(request(app).post(`/health-record/visits/${jobId}/pause`)).send({});
    expect(res.status).toBe(200);
    const job = await prisma.visit.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("in_progress");
    expect(job.scheduledStart).not.toBeNull();
    expect(await prisma.timeEntry.count({ where: { visitId: jobId, endedAt: null } })).toBe(0);
  });

  it("Pause job (CRM) on a block that already ended keeps the calendar history and releases the booking", async () => {
    await prisma.visit.update({
      where: { id: jobId },
      data: { status: "scheduled", scheduledStart: new Date(Date.now() - 3 * 86_400_000), scheduledEnd: new Date(Date.now() - 2 * 86_400_000), googleEventId: "evt_pause_past" },
    });
    const res = await request(app).post(`/jobs/${jobId}/pause-for-later`).send({ reason: "did not finish" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ paused: true, calendarEventDeleted: false });
    const job = await prisma.visit.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("contracted");
    expect(job.scheduledStart).toBeNull();
    expect(job.googleEventId).toBe("evt_pause_past");
    expect(calendarMock.deleted).not.toContain("evt_pause_past");
  });

  it("closing a consultation with a signed, undecided estimate IS Schedule for later", async () => {
    const c = await consultation("closed without choosing");
    let e = await issueFromField(c.id, { depositRequired: true });
    e = await signOnPublicPage(e.id);
    expect(depositEmailsFor(e.id)).toBe(0);
    const res = await auth(request(app).post(`/health-record/visits/${c.id}/complete`)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ completed: true, scheduledForLater: true, jobVisitId: e.jobVisitId });
    expect(depositEmailsFor(e.id)).toBe(1);
    expect((await prisma.visit.findUniqueOrThrow({ where: { id: e.jobVisitId! } })).status).toBe("contracted");
  });
});

describe("the ordinary signature is unchanged", () => {
  it("a signature with no technician's consultation open sends the deposit request at once", async () => {
    // No technician on this visit: the office built and emailed the quote (the CRM's own issue path).
    const v = await consultation("emailed from the office", { assigned: false, scheduledStart: null });
    const d = await createDraft(prisma, { title: `${MARK} office quote`, supplierId: "HD", visitId: v.id });
    draftIds.push(d.id);
    await addLine(prisma, d.id, { itemId: ITEM, quantity: 1, quantitySource: "COUNT" });
    const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    if (!g.ok) throw new Error(g.reasons.join("; "));
    const e = await signOnPublicPage(g.estimateId);
    expect(await prisma.issuedEstimateEvent.count({ where: { estimateId: e.id, type: EVENT_DEPOSIT_HELD } })).toBe(0);
    expect(depositEmailsFor(e.id)).toBe(1);
  });
});
