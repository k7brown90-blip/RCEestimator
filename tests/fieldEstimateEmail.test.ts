/**
 * POST /health-record/issued-estimates/:id/email (2026-10-01).
 *
 * Replaces the field's old "share via text" button on the post-issue screen
 * (QuoteScreen.tsx) — Red Cedar has no SMS (Kyle, 2026-08-16: "There will be
 * NO automated texting ONLY emails"), so the technician now emails the
 * estimate instead, through the SAME `sendEstimateEmail` the CRM's own
 * `POST /issued-estimates/:id/send` calls (src/app.ts:3185) — one send, one
 * template, no second mail path.
 *
 * Pins what the new route's guard does, mirroring the assignment check every
 * other tech-scoped send already uses (health-record.ts's
 * /visits/:visitId/email-payment-request): a technician may only email an
 * estimate that belongs to a visit assigned to them, by `visitId` OR
 * `jobVisitId`. This is the "403 when not assigned" case the plan calls out
 * especially — a technician on a different visit must not be able to email
 * someone else's estimate.
 *
 * Builds its own price-book fixture rather than depending on an imported
 * catalog (Kyle's 2026-09-15 ruling — see tests/helpers/priceBookFixture.ts).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "FEE";
const GOOD = "FEE001";
const CUSTOMER_EMAIL = "fee-customer@example.com";

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;
let otherTechnicianId: string;
let otherTechToken: string;
const draftIds: string[] = [];

async function cleanEstimatesFor(ids: string[]) {
  const ests = await prisma.issuedEstimate.findMany({ where: { draftId: { in: ids } } });
  const estIds = ests.map((e) => e.id);
  await prisma.issuedEstimateEvent.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimateLine.deleteMany({ where: { estimateId: { in: estIds } } });
  await prisma.issuedEstimate.updateMany({ where: { id: { in: estIds } }, data: { supersedesId: null } });
  await prisma.issuedEstimate.deleteMany({ where: { id: { in: estIds } } });
}

beforeAll(async () => {
  await ensurePriceBookGates();
  await seedAtomics([quotableAtomic(GOOD)]);

  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer`, phone: "615-555-0188", email: CUSTOMER_EMAIL },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "41 Field Email Way", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" },
  });
  visitId = visit.id;

  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `fee-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId, technicianId } });

  // A SECOND technician, deliberately never assigned to this visit — proves the 403.
  const other = await prisma.technician.create({ data: { name: `${MARK} Other Tech`, accessToken: `fee-other-${customer.id}` } });
  otherTechnicianId = other.id;
  otherTechToken = other.accessToken;
});

afterAll(async () => {
  await cleanEstimatesFor(draftIds);
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId } });
  await prisma.technician.deleteMany({ where: { id: { in: [technicianId, otherTechnicianId] } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([GOOD]);
});

const auth = (token: string) => (r: request.Test) => r.set("Authorization", `Bearer ${token}`);

/** Issue a fresh estimate on the shared visit, returning its id. */
async function issueEstimate(title: string): Promise<string> {
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title, supplierId: "HD", visitId } });
  draftIds.push(draft.id);
  const line = await auth(techToken)(request(app).post(`/health-record/quotes/${draft.id}/lines`)).send({
    itemId: GOOD, quantity: 1, quantitySource: "COUNT",
  });
  expect(line.status, JSON.stringify(line.body)).toBe(201);
  const issued = await auth(techToken)(request(app).post(`/health-record/quotes/${draft.id}/issue`)).send({});
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  return issued.body.data.estimateId as string;
}

describe("POST /health-record/issued-estimates/:id/email", () => {
  it("403s a technician who is not assigned to this estimate's visit", async () => {
    const estimateId = await issueEstimate(`${MARK} not-yours`);

    const res = await auth(otherTechToken)(request(app).post(`/health-record/issued-estimates/${estimateId}/email`)).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");

    // And it must not have sent anything.
    const est = await prisma.issuedEstimate.findUnique({ where: { id: estimateId } });
    expect(est!.sentAt).toBeNull();
  });

  it("404s an estimate id that does not exist", async () => {
    const res = await auth(techToken)(request(app).post("/health-record/issued-estimates/does-not-exist/email")).send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("the assigned technician can send it, through the same sendEstimateEmail the CRM uses, with the token never on the wire", async () => {
    const mod = await import("../src/services/confirmationEmail");
    const spy = vi.spyOn(mod, "sendBrandedEmail").mockResolvedValue(true);
    try {
      const estimateId = await issueEstimate(`${MARK} send-ok`);

      const res = await auth(techToken)(request(app).post(`/health-record/issued-estimates/${estimateId}/email`)).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.to).toBe(CUSTOMER_EMAIL);
      // Only `to` comes back — no token, no customerUrl, no draft internals.
      expect(Object.keys(res.body.data)).toEqual(["to"]);

      const est = await prisma.issuedEstimate.findUnique({ where: { id: estimateId }, include: { events: true } });
      expect(est!.sentAt).not.toBeNull();
      expect(est!.sentBy).toBe(`tech:${technicianId}`);
      expect(est!.sentTo).toBe(CUSTOMER_EMAIL);
      expect(est!.events.map((e) => e.type)).toContain("sent");

      // The email that actually went out carries the token in the LINK, never in this route's response.
      const html = String(spy.mock.calls[0][0].bodyHtml);
      expect(html).toContain(est!.token);
    } finally {
      spy.mockRestore();
    }
  });

  it("surfaces a send refusal as 409 rather than a silent failure (already void)", async () => {
    const estimateId = await issueEstimate(`${MARK} void-refusal`);
    await prisma.issuedEstimate.update({ where: { id: estimateId }, data: { status: "void", voidedAt: new Date(), voidReason: "test" } });

    const res = await auth(techToken)(request(app).post(`/health-record/issued-estimates/${estimateId}/email`)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("not_sent");
    expect(res.body.error.message).toMatch(/void/i);
  });
});
