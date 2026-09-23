/**
 * An estimate can be LOST (Kyle, 2026-09-20; drawers plan Phase 2, trap 3).
 *
 * "The mark lost would also live with an estimate for when we give an estimate but they either
 * hire someone else or end up not moving forward with the job." This is the row the win rate
 * (Estimate -> Job, the funnel's third phase) reads — until it existed a quote lost to another
 * contractor was indistinguishable from one still sitting out.
 *
 * LOST IS NOT VOID. Void = the document is dead and leaves the denominator. Lost = the customer
 * decided and stays in it. Every consumer trap 3 named is pinned here, in the order the plan
 * listed them:
 *   1. the first-view flip never un-loses a lost estimate;
 *   2. the /pay/:token link refuses, in the customer's words;
 *   3. send refuses until reopened;
 *   4. the expiry sweep never relabels a lost row;
 *   5. the reminder sweep never nudges one (even a row with signedAt set by hand);
 *   6. the jobs tracker reads it as "declined" (tests/jobsEstimateTracker.test.ts);
 *   7. terms / warranty / warranty-tracking refuse;
 *  10. the field's estimate filters are ALLOW-LISTS — a lost row with signedAt set never becomes
 *      the technician's brief or the materials plan; the invoice roll-up drops a lost change order.
 * Plus: the transitions allowed and refused, reopen, and that the signature path refuses at its
 * one shared write.
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
// Customer emails are counted, never sent.
const emailMock = vi.hoisted(() => ({ sendBrandedEmail: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/services/confirmationEmail", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/services/confirmationEmail")>();
  return { ...mod, sendBrandedEmail: emailMock.sendBrandedEmail, sendKyleNotificationEmail: vi.fn().mockResolvedValue(undefined) };
});

import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft, recordFirstView } from "../src/services/issuedEstimateService";
import { sendEstimateEmail } from "../src/services/issuedEstimateSend";
import { chargeableAmount } from "../src/services/stripePayments";
import { sweepExpiredEstimates, reopenedStatusOf } from "../src/services/estimateExpiry";
import { sweepInvoiceReminders } from "../src/services/invoiceReminders";
import { loadInvoiceGroup, signedRootForJob } from "../src/services/invoiceGroup";
import { jobMaterials, materialNeedListForJob } from "../src/services/jobMaterials";
import { LOSABLE_STATUSES, LOST_REASONS } from "../shared/estimateStatus";
import { TEST_SIGNATURE } from "./helpers/signature";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "LOSTEST";
const ATOMIC = "LT001";
const DAY = 86_400_000;

let customerId: string;
let propertyId: string;
let visitId: string;
const draftIds: string[] = [];
const jobIds: string[] = [];

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(ATOMIC)]);
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "lost-customer@example.com", phone: "615-555-0142" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "4 Lost Ln", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} consult`, status: "estimate" },
  });
  visitId = visit.id;
});

afterAll(async () => {
  const ests = await prisma.issuedEstimate.findMany({ where: { customerId }, select: { id: true } });
  const ids = ests.map((e) => e.id);
  await prisma.payment.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimateOption.deleteMany({ where: { estimateId: { in: ids } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: ids } }, data: { supersedesId: null, changeOrderForId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: ids } } });
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftQuestion.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.purchaseOrder.deleteMany({ where: { jobId: { in: jobIds } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([ATOMIC]);
});

/** Issue a one-line estimate; it starts as "draft" (issued, not yet emailed). */
async function issue(title: string, at: { visitId?: string | null } = {}) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId: at.visitId === undefined ? visitId : at.visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: ATOMIC, quantity: 1, quantitySource: "COUNT" });
  const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
  if (!g.ok) throw new Error(`graduation failed: ${JSON.stringify(g)}`);
  const est = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: g.estimateId } });
  return est;
}

/** Put an issued row where a test needs it, the way the real paths would have. */
async function put(id: string, status: "sent" | "viewed" | "expired", extra: { ageDays?: number } = {}) {
  const sentAt = new Date(Date.now() - (extra.ageDays ?? 1) * DAY);
  return prisma.issuedEstimate.update({
    where: { id },
    data: {
      status,
      sentAt,
      sentTo: "lost-customer@example.com",
      firstViewedAt: status === "viewed" ? new Date(sentAt.getTime() + 3600_000) : null,
      ...(extra.ageDays ? { createdAt: new Date(Date.now() - extra.ageDays * DAY) } : {}),
    },
  });
}

const markLost = (id: string, body: Record<string, unknown> = { reason: "price", notes: "went with a cheaper bid" }) =>
  request(app).post(`/issued-estimates/${id}/lost`).send(body);

describe("the vocabulary is one list", () => {
  it("estimates lose for the same reasons leads do, and only sent / viewed / expired can be lost", () => {
    expect([...LOST_REASONS]).toEqual(["price", "timing", "referral", "trust", "scope", "other"]);
    expect([...LOSABLE_STATUSES]).toEqual(["sent", "viewed", "expired"]);
  });
});

describe("transitions", () => {
  it("a SENT estimate can be lost: status, stamp, reason, notes and an event", async () => {
    const est = await issue("sent-lost");
    await put(est.id, "sent");
    const res = await markLost(est.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ lost: true, reason: "price", notes: "went with a cheaper bid" });
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } });
    expect(row.status).toBe("lost");
    expect(row.lostAt).not.toBeNull();
    expect(row.lostReason).toBe("price");
    expect(row.lostNotes).toBe("went with a cheaper bid");
    // Lost is not void: the void columns are untouched.
    expect(row.voidedAt).toBeNull();
    expect(row.voidReason).toBeNull();
    const events = await prisma.issuedEstimateEvent.findMany({ where: { estimateId: est.id, type: "lost" } });
    expect(events).toHaveLength(1);
    expect(events[0].detail).toContain("(was sent)");
  });

  it("a VIEWED estimate can be lost", async () => {
    const est = await issue("viewed-lost");
    await put(est.id, "viewed");
    expect((await markLost(est.id, { reason: "timing" })).status).toBe(200);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).lostNotes).toBeNull();
  });

  it("an EXPIRED estimate can be lost — Kyle usually hears 'we went with someone else' after the window", async () => {
    const est = await issue("expired-lost");
    await put(est.id, "expired", { ageDays: 45 });
    expect((await markLost(est.id, { reason: "referral" })).status).toBe(200);
  });

  it("a DRAFT is refused and pointed at Delete — it never went to the customer", async () => {
    const est = await issue("draft-refused");
    const res = await markLost(est.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/never sent.*delete/i);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).status).toBe("draft");
  });

  it("a SIGNED estimate is refused and pointed at Void — it is a sale", async () => {
    const est = await issue("signed-refused");
    const signed = await request(app).post(`/issued-estimates/${est.id}/sign-in-person`).send({ signerName: "Lost Tester", signatureImage: TEST_SIGNATURE });
    expect(signed.status).toBe(200);
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } });
    if (row.jobVisitId) jobIds.push(row.jobVisitId);
    const res = await markLost(est.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/signed.*void/i);
  });

  it("a VOID estimate is refused — a dead document is not a lost quote", async () => {
    const est = await issue("void-refused");
    await put(est.id, "sent");
    await prisma.issuedEstimate.update({ where: { id: est.id }, data: { status: "void", voidedAt: new Date(), voidReason: "wrong price" } });
    const res = await markLost(est.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/void/i);
  });

  it("a lost estimate cannot be lost twice", async () => {
    const est = await issue("twice");
    await put(est.id, "sent");
    expect((await markLost(est.id)).status).toBe(200);
    const again = await markLost(est.id, { reason: "other" });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already/i);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).lostReason).toBe("price");
  });

  it("a SUPERSEDED revision is refused and names the live one", async () => {
    const est = await issue("superseded");
    await put(est.id, "sent");
    const revised = await request(app).post(`/issued-estimates/${est.id}/revise`).send({});
    expect(revised.status, JSON.stringify(revised.body)).toBe(201);
    const res = await markLost(est.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/rev 2/);
  });

  it("the reason must come from the shared list", async () => {
    const est = await issue("bad-reason");
    await put(est.id, "sent");
    expect((await markLost(est.id, { reason: "ghosted" })).status).toBe(400);
    expect((await markLost(est.id, {})).status).toBe(400);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).status).toBe("sent");
  });
});

describe("reopen — the way back (Kyle's standing rule)", () => {
  it("returns to VIEWED when the customer had opened it, clearing every lost column", async () => {
    const est = await issue("reopen-viewed");
    await put(est.id, "viewed");
    expect((await markLost(est.id)).status).toBe(200);
    const res = await request(app).post(`/issued-estimates/${est.id}/reopen`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ reopened: true, status: "viewed" });
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } });
    expect(row.status).toBe("viewed");
    expect(row.lostAt).toBeNull();
    expect(row.lostReason).toBeNull();
    expect(row.lostNotes).toBeNull();
    const events = await prisma.issuedEstimateEvent.findMany({ where: { estimateId: est.id, type: "reopened" } });
    expect(events).toHaveLength(1);
    expect(events[0].detail).toContain("had been lost: price");
  });

  it("returns to SENT when it was never opened", async () => {
    const est = await issue("reopen-sent");
    await put(est.id, "sent");
    await markLost(est.id);
    const res = await request(app).post(`/issued-estimates/${est.id}/reopen`).send({});
    expect(res.body).toEqual({ reopened: true, status: "sent" });
  });

  it("returns to EXPIRED when the window closed while it sat lost — the sweep's own arithmetic, at once", async () => {
    const est = await issue("reopen-expired");
    await put(est.id, "viewed", { ageDays: 40 });
    await prisma.issuedEstimate.update({ where: { id: est.id }, data: { status: "expired" } });
    await markLost(est.id, { reason: "scope" });
    const res = await request(app).post(`/issued-estimates/${est.id}/reopen`).send({});
    expect(res.body).toEqual({ reopened: true, status: "expired" });
    // The pure function, for the record.
    const base = { firstViewedAt: null, createdAt: new Date(), validDays: 30 };
    expect(reopenedStatusOf(base)).toBe("sent");
    expect(reopenedStatusOf({ ...base, firstViewedAt: new Date() })).toBe("viewed");
    expect(reopenedStatusOf({ ...base, createdAt: new Date(Date.now() - 31 * DAY) })).toBe("expired");
  });

  it("refuses an estimate that is not lost", async () => {
    const est = await issue("reopen-not-lost");
    await put(est.id, "sent");
    const res = await request(app).post(`/issued-estimates/${est.id}/reopen`).send({});
    expect(res.status).toBe(409);
  });
});

describe("the customer's link on a lost estimate", () => {
  it("1. still reads, but a re-open never un-loses it, records a view, or writes a viewed event", async () => {
    const est = await issue("link-view");
    await put(est.id, "sent");
    await markLost(est.id);
    const page = await request(app).get(`/e/${est.token}`);
    expect(page.status).toBe(200);
    await recordFirstView(prisma, est.id);
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } });
    expect(row.status).toBe("lost");
    expect(row.firstViewedAt).toBeNull();
    expect(await prisma.issuedEstimateEvent.count({ where: { estimateId: est.id, type: "viewed" } })).toBe(0);
  });

  it("PUNCHLIST A12: renders 'closed', not the live sign form, so a customer never fills it in only to be refused at submit", async () => {
    const est = await issue("link-closed-render");
    await put(est.id, "sent");
    await markLost(est.id);
    const page = await request(app).get(`/e/${est.token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("This estimate has been closed");
    expect(page.text).not.toContain('id="signForm"');
    expect(page.text).not.toContain("Accept &amp; Sign");
  });

  it("refuses the signature through BOTH doors, in the customer's words", async () => {
    const est = await issue("link-sign");
    await put(est.id, "viewed");
    await markLost(est.id);
    const emailed = await request(app).post(`/e/${est.token}/sign`).send({ signerName: "Lost Tester", signatureImage: TEST_SIGNATURE });
    expect(emailed.status).toBe(400);
    expect(emailed.text).toContain("has been closed");
    const inPerson = await request(app).post(`/issued-estimates/${est.id}/sign-in-person`).send({ signerName: "Lost Tester", signatureImage: TEST_SIGNATURE });
    expect(inPerson.status).toBe(400);
    expect(inPerson.body.error).toContain("has been closed");
    const row = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } });
    expect(row.signedAt).toBeNull();
    expect(row.status).toBe("lost");
  });

  it("2. the /pay/:token link refuses — and says closed, not 'not signed yet'", async () => {
    const est = await issue("link-pay");
    await put(est.id, "sent");
    await markLost(est.id);
    const amount = await chargeableAmount(prisma, est.token, "balance");
    expect(amount.ok).toBe(false);
    if (!amount.ok) expect(amount.reason).toMatch(/closed/);
    const page = await request(app).get(`/pay/${est.token}`);
    expect(page.status).toBe(400);
    expect(page.text).toContain("closed");
    expect(page.text).not.toContain("not been signed");
    // /pay/:token/checkout runs the same chargeableAmount guard, behind a "Stripe configured"
    // check that the test environment cannot pass — so the guard itself is what is pinned above.
  });

  it("3. send refuses until reopened — sending is reopening the conversation", async () => {
    const est = await issue("link-send");
    await put(est.id, "sent");
    await markLost(est.id);
    const result = await sendEstimateEmail(prisma, est.id, { sentBy: "test" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/lost.*Reopen/i);
    const viaRoute = await request(app).post(`/issued-estimates/${est.id}/send`).send({});
    expect(viaRoute.status).toBe(400);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).status).toBe("lost");
  });
});

describe("sweeps, guards and the drawer's reads", () => {
  it("4. the expiry sweep relabels a stale SENT row and leaves a stale LOST row exactly as it is", async () => {
    const stale = await issue("sweep-sent");
    await put(stale.id, "sent", { ageDays: 40 });
    const lost = await issue("sweep-lost");
    await put(lost.id, "viewed", { ageDays: 40 });
    await markLost(lost.id, { reason: "trust" });
    const r = await sweepExpiredEstimates(prisma);
    expect(r.expired).toContain(stale.id);
    expect(r.expired).not.toContain(lost.id);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("expired");
    const lostRow = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: lost.id } });
    expect(lostRow.status).toBe("lost");
    expect(lostRow.lostReason).toBe("trust");
  });

  it("5. the reminder sweep never nudges a lost row — even one with signedAt set by hand", async () => {
    // The impossible row, written directly: signedAt + a completed job + status "lost". The API
    // cannot produce it; the allow-list must still keep it off the candidate list.
    const job = await prisma.visit.create({
      data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} reminder job`, status: "completed", completedAt: new Date(Date.now() - 20 * DAY) },
    });
    jobIds.push(job.id);
    const est = await issue("reminder-lost", { visitId: null });
    await prisma.issuedEstimate.update({
      where: { id: est.id },
      data: { status: "lost", lostAt: new Date(), lostReason: "price", signedAt: new Date(Date.now() - 30 * DAY), jobVisitId: job.id, sentAt: new Date(Date.now() - 31 * DAY) },
    });
    process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS = "on";
    try {
      emailMock.sendBrandedEmail.mockClear();
      await sweepInvoiceReminders(prisma);
    } finally {
      delete process.env.AUTOMATED_CUSTOMER_SENDS_INVOICE_REMINDERS;
    }
    const sentFor = emailMock.sendBrandedEmail.mock.calls.map((c) => c[0].issuedEstimateId as string);
    expect(sentFor).not.toContain(est.id);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).paymentRemindersSent).toBe(0);
  });

  it("7. terms, warranty coverage and claim tracking all refuse a lost estimate and name reopen", async () => {
    const est = await issue("guards");
    await put(est.id, "sent");
    await markLost(est.id);
    const terms = await request(app).patch(`/issued-estimates/${est.id}/terms`).send({ depositRequired: false });
    expect(terms.status).toBe(409);
    expect(terms.body.error).toMatch(/lost.*reopen/i);
    const warranty = await request(app).patch(`/issued-estimates/${est.id}/warranty`).send({ company: "RELY", claimNumber: "1", authNumber: "1", coveredAmount: 10 });
    expect(warranty.status).toBe(409);
    expect(warranty.body.error).toMatch(/lost.*reopen/i);
    const tracking = await request(app).patch(`/issued-estimates/${est.id}/warranty/tracking`).send({ submittedAt: new Date().toISOString(), reason: "test" });
    expect(tracking.status).toBe(409);
    expect(tracking.body.error).toMatch(/lost.*reopen/i);
    expect((await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: est.id } })).depositRequired).toBe(true);
  });

  it("a lost estimate can still be deleted — it is unsigned, and everything has a way out", async () => {
    const est = await issue("delete-lost");
    await put(est.id, "sent");
    await markLost(est.id);
    const res = await request(app).delete(`/issued-estimates/${est.id}`);
    expect(res.status).toBe(200);
    expect(await prisma.issuedEstimate.findUnique({ where: { id: est.id } })).toBeNull();
  });

  it("the drawer's record and the Estimates chain both carry when and why", async () => {
    const est = await issue("reads");
    await put(est.id, "viewed");
    await markLost(est.id, { reason: "scope", notes: "decided on a smaller job" });
    const record = await request(app).get(`/issued-estimates/${est.id}/record`);
    expect(record.status).toBe(200);
    expect(record.body.estimate.status).toBe("lost");
    expect(record.body.estimate.lostReason).toBe("scope");
    expect(record.body.estimate.lostNotes).toBe("decided on a smaller job");
    expect(record.body.estimate.lostAt).toBeTruthy();
    expect(record.body.estimate.token).toBeUndefined();
    const chain = await request(app).get("/issued-estimates/chain");
    const row = (chain.body.estimates as Array<{ id: string; status: string; lostReason: string | null; lostAt: string | null }>).find((r) => r.id === est.id);
    expect(row?.status).toBe("lost");
    expect(row?.lostReason).toBe("scope");
    expect(row?.lostAt).toBeTruthy();
  });
});

describe("10. the field reads ALLOW-LISTS — a lost row never reaches a technician", () => {
  it("a lost row with signedAt set by hand is not the job's brief, its materials plan, or its need list", async () => {
    const job = await prisma.visit.create({
      data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} field job`, status: "contracted" },
    });
    jobIds.push(job.id);
    const est = await issue("field-lost", { visitId: null });
    await prisma.issuedEstimate.update({
      where: { id: est.id },
      data: { status: "lost", lostAt: new Date(), lostReason: "price", signedAt: new Date(), jobVisitId: job.id },
    });
    expect(await signedRootForJob(prisma, job.id)).toBeNull();
    const need = await materialNeedListForJob(job.id);
    expect(need.estimates).toEqual([]);
    expect(need.lines).toEqual([]);
    const view = await jobMaterials(job.id);
    expect(view.estimate).toBeNull();
    expect(view.suggested).toEqual([]);
    // Reopened and then genuinely signed, the same row IS the brief — the filter is on status.
    await prisma.issuedEstimate.update({ where: { id: est.id }, data: { status: "signed", lostAt: null, lostReason: null } });
    expect((await signedRootForJob(prisma, job.id))?.id).toBe(est.id);
    expect((await jobMaterials(job.id)).estimate?.id).toBe(est.id);
    expect((await materialNeedListForJob(job.id)).estimates.map((e) => e.id)).toEqual([est.id]);
  });

  it("the invoice roll-up counts only SIGNED change orders — a lost one drops out cleanly", async () => {
    const root = await issue("co-root");
    const signed = await request(app).post(`/issued-estimates/${root.id}/sign-in-person`).send({ signerName: "Lost Tester", signatureImage: TEST_SIGNATURE });
    expect(signed.status).toBe(200);
    const rootRow = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: root.id } });
    if (rootRow.jobVisitId) jobIds.push(rootRow.jobVisitId);
    // A change order the customer turned down: sent, then lost. And the impossible variant with
    // signedAt set by hand, which the allow-list must also exclude.
    const lostCo = await issue("co-lost", { visitId: null });
    await put(lostCo.id, "sent");
    await prisma.issuedEstimate.update({ where: { id: lostCo.id }, data: { changeOrderForId: root.id, depositRequired: false } });
    expect((await markLost(lostCo.id, { reason: "price" })).status).toBe(200);
    const ghostCo = await issue("co-ghost", { visitId: null });
    await prisma.issuedEstimate.update({
      where: { id: ghostCo.id },
      data: { changeOrderForId: root.id, status: "lost", lostAt: new Date(), lostReason: "other", signedAt: new Date() },
    });
    const group = await loadInvoiceGroup(prisma, root.id);
    expect(group?.changeOrders).toEqual([]);
    expect(group?.ids).toEqual([root.id]);
    expect(group?.documents.map((d) => d.id)).toEqual([root.id]);
    // Asking by the lost change order's id still answers about its root (it stands with the invoice
    // it pointed at, it just adds nothing to it).
    expect((await loadInvoiceGroup(prisma, lostCo.id))?.root.id).toBe(root.id);
  });
});
