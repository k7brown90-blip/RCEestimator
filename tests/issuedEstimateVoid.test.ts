/**
 * Unit C2, 2026-09-17 — void a signed estimate.
 *
 * Debug report, /calendar: "There is no way to cancel an appointment. Or a signed estimate which
 * we need to be able to do." Kyle: "Yes, it should cancel the job." Deposit refunds stay manual
 * in Stripe under the existing rule, and open P.O.s are left for Kyle to cancel himself — this
 * route must not touch either.
 *
 * What these pin:
 *   1. Only a SIGNED estimate can be voided — delete is for the unsigned.
 *   2. A reason is required.
 *   3. Voiding a signed estimate whose job was never scheduled cancels the job directly — no
 *      "your appointment is cancelled" message for an appointment that never existed.
 *   4. A voided estimate cannot be voided twice.
 *   5. Money (Payment rows) and P.O. rows are read back in the response, never written to.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { addLine, createDraft } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { TEST_SIGNATURE } from "./helpers/signature";
import {
  deleteAtomics,
  ensurePriceBookGates,
  quotableAtomic,
  seedAtomics,
} from "./helpers/priceBookFixture";

const MARK = "C2VOID";
const GOOD_A = "BF001";

let customerId: string;
let propertyId: string;
let visitId: string;
const draftIds: string[] = [];

async function cleanEstimatesFor(ids: string[]) {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: ids } } });
  const estIds = ests.map((e) => e.id);
  await prisma.payment.deleteMany({ where: { estimateId: { in: estIds } } });
  const jobIds = ests.map((e) => e.jobVisitId).filter((v): v is string => Boolean(v));
  await prisma.purchaseOrder.deleteMany({ where: { jobId: { in: jobIds } } });
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
  await prisma.visit.deleteMany({ where: { id: { in: jobIds } } });
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(GOOD_A)]);

  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, email: "c2void-customer@example.com", phone: "615-555-0199" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: {
      customerId,
      name: `${MARK} House`,
      addressLine1: "17 Void Way",
      city: "La Vergne",
      state: "TN",
      postalCode: "37086",
    },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "estimate" },
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
  await deleteAtomics([GOOD_A]);
});

/** A draft attached to the job, carrying one quotable line. */
async function quotableDraft(title: string) {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: GOOD_A, quantity: 1, quantitySource: "COUNT" });
  return d;
}

/** Issues, then signs in person (creates the job — unscheduled, per createJobFromSignedEstimate). */
async function issueAndSign(title: string) {
  const d = await quotableDraft(title);
  const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
  expect(g.ok).toBe(true);
  if (!g.ok) throw new Error("graduation failed");
  const signed = await request(app)
    .post(`/issued-estimates/${g.estimateId}/sign-in-person`)
    .send({ signerName: "C2 Customer", signatureImage: TEST_SIGNATURE });
  expect(signed.status).toBe(200);
  const est = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: g.estimateId } });
  expect(est.jobVisitId).not.toBeNull();
  const job = await prisma.visit.findUniqueOrThrow({ where: { id: est.jobVisitId! } });
  expect(job.scheduledStart).toBeNull();
  return { estimateId: g.estimateId, jobId: est.jobVisitId as string };
}

describe("void refuses what it must", () => {
  it("refuses an unsigned estimate — points at Delete instead", async () => {
    const d = await quotableDraft("unsigned");
    const g = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
    expect(g.ok).toBe(true);
    if (!g.ok) return;

    const res = await request(app).post(`/issued-estimates/${g.estimateId}/void`).send({ reason: "changed mind" });
    expect(res.status).toBe(409);
    expect(res.body.voided).toBe(false);
    expect(res.body.error).toMatch(/delete/i);

    const est = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: g.estimateId } });
    expect(est.voidedAt).toBeNull();
    expect(est.status).not.toBe("void");
  });

  it("requires a non-empty reason", async () => {
    const { estimateId } = await issueAndSign("no-reason");

    const empty = await request(app).post(`/issued-estimates/${estimateId}/void`).send({ reason: "" });
    expect(empty.status).toBe(400);

    const missing = await request(app).post(`/issued-estimates/${estimateId}/void`).send({});
    expect(missing.status).toBe(400);

    const est = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: estimateId } });
    expect(est.voidedAt).toBeNull();
  });
});

describe("void of a signed estimate with an unscheduled job", () => {
  it("cancels the job directly, with no customer message, and refuses a second void", async () => {
    const { estimateId, jobId } = await issueAndSign("unscheduled-job");

    const res = await request(app)
      .post(`/issued-estimates/${estimateId}/void`)
      .send({ reason: "Customer backed out before scheduling" });
    expect(res.status).toBe(200);
    expect(res.body.voided).toBe(true);
    expect(res.body.jobId).toBe(jobId);
    expect(res.body.jobAction).toBe("cancelled_unscheduled");
    // No appointment ever existed, so cancelJob's customer-notification path must never run.
    expect(res.body.customerNotified).toBe(false);
    expect(res.body.kyleNotified).toBe(false);

    const est = await prisma.issuedEstimate.findUniqueOrThrow({ where: { id: estimateId } });
    expect(est.voidedAt).not.toBeNull();
    expect(est.voidReason).toBe("Customer backed out before scheduling");
    expect(est.status).toBe("void");

    const events = await prisma.issuedEstimateEvent.findMany({ where: { estimateId } });
    expect(events.map((e) => e.type)).toContain("voided");

    const job = await prisma.visit.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("cancelled");

    // A second void is refused, and the row is left exactly as the first void left it.
    const again = await request(app)
      .post(`/issued-estimates/${estimateId}/void`)
      .send({ reason: "trying again" });
    expect(again.status).toBe(409);
    expect(again.body.voided).toBe(false);
    expect(again.body.error).toMatch(/already void/i);

    const jobAfter = await prisma.visit.findUniqueOrThrow({ where: { id: jobId } });
    expect(jobAfter.status).toBe("cancelled");
  });
});

describe("money and P.O. rows are reported, never touched", () => {
  it("leaves a paid deposit and an open P.O. exactly as they were, and reports both back", async () => {
    const { estimateId, jobId } = await issueAndSign("money-and-po");

    const payment = await prisma.payment.create({
      data: {
        customerId,
        estimateId,
        amount: 150,
        method: "stripe",
        kind: "deposit",
        status: "paid",
        paidAt: new Date(),
      },
    });

    const poRes = await request(app).post("/purchase-orders").send({ supplier: "C2Void SiteOne", jobId });
    expect(poRes.status).toBe(201);
    const poNumber = poRes.body.number as string;

    const res = await request(app)
      .post(`/issued-estimates/${estimateId}/void`)
      .send({ reason: "Refund and P.O. handled by hand" });
    expect(res.status).toBe(200);
    expect(res.body.voided).toBe(true);

    // Reported back so Kyle knows what to do by hand...
    expect(res.body.paymentsTotal).toBe(150);
    expect(res.body.payments.map((p: { id: string }) => p.id)).toContain(payment.id);
    expect(res.body.openPurchaseOrders.map((p: { number: string }) => p.number)).toContain(poNumber);

    // ...and untouched in the database.
    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(paymentAfter.status).toBe("paid");
    expect(paymentAfter.amount).toBe(150);

    const poAfter = await prisma.purchaseOrder.findFirstOrThrow({ where: { number: poNumber } });
    expect(poAfter.status).toBe("open");
    expect(poAfter.cancelledAt).toBeNull();
  });
});
