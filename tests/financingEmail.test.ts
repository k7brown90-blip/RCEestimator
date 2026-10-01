/**
 * The financing link, sendable on its own (2026-10-01 plan
 * 2026-10-01-manual-sends-archiving-and-one-calendar.md, item B).
 *
 * Covers:
 *   - services/financingEmail.ts: refuses cleanly with no customer email,
 *     sends through sendBrandedEmail (so it is logged as a delivery like
 *     every other customer email), and the rendered body carries NO credit
 *     terms — load-bearing per the 2026-09-16 Reg Z scoping, not a style
 *     choice.
 *   - POST /issued-estimates/:id/email-financing (CRM, app.ts) — success and
 *     the 400 refusal shape.
 *   - POST /health-record/issued-estimates/:id/email-financing (field,
 *     health-record.ts) — mirrors the estimate-email route added 2026-10-01:
 *     403 when the technician is not assigned to the estimate's visit, 404
 *     unknown estimate, success with the minimal `{ to }` response.
 *
 * Builds its own price-book fixture (Kyle's 2026-09-15 ruling — see
 * tests/helpers/priceBookFixture.ts) rather than depending on an imported
 * catalog.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { createDraft, addLine } from "../src/services/atomicEstimateService";
import { graduateDraft } from "../src/services/issuedEstimateService";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";

const MARK = "FIN";
const GOOD = "FIN001";
const CUSTOMER_EMAIL = "financing-customer@example.com";

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
    data: { name: `${MARK} Customer`, phone: "615-555-0199", email: CUSTOMER_EMAIL },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "19 Financing Way", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" },
  });
  visitId = visit.id;

  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `fin-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId, technicianId } });

  // A SECOND technician, never assigned — proves the 403.
  const other = await prisma.technician.create({ data: { name: `${MARK} Other Tech`, accessToken: `fin-other-${customer.id}` } });
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

/** A quotable draft graduated into a real IssuedEstimate (admin path), returning its id. */
async function issuedEstimateId(title: string): Promise<string> {
  const d = await createDraft(prisma, { title: `${MARK} ${title}`, supplierId: "HD", visitId });
  draftIds.push(d.id);
  await addLine(prisma, d.id, { itemId: GOOD, quantity: 1, quantitySource: "COUNT" });
  const result = await graduateDraft(prisma, { draftId: d.id, accountId: customerId, serviceAddressId: propertyId });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error("graduation failed");
  return result.estimateId;
}

/** Issue a fresh estimate through the FIELD quote flow, so visitId is set on the row. */
async function fieldIssuedEstimateId(title: string): Promise<string> {
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} ${title}`, supplierId: "HD", visitId } });
  draftIds.push(draft.id);
  const line = await auth(techToken)(request(app).post(`/health-record/quotes/${draft.id}/lines`)).send({
    itemId: GOOD, quantity: 1, quantitySource: "COUNT",
  });
  expect(line.status, JSON.stringify(line.body)).toBe(201);
  const issued = await auth(techToken)(request(app).post(`/health-record/quotes/${draft.id}/issue`)).send({});
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  return issued.body.data.estimateId as string;
}

// A deliberately strict net: no APR, no rate, no term length, no promo period, no approval
// language, no minimum payment — anything that would start stating actual credit terms.
const FORBIDDEN_CREDIT_TERMS = /\bapr\b|\binterest\b|\brate\b|\bmonths?\b|\b0%|promo|promotional|\bapproval\b|\bapproved\b|minimum payment|credit limit|finance charge/i;

describe("services/financingEmail — sendFinancingEmail", () => {
  it("refuses cleanly when there is no customer email on file", async () => {
    const estimateId = await issuedEstimateId("no-email");
    await prisma.issuedEstimate.update({ where: { id: estimateId }, data: { customerEmail: null } });

    const { sendFinancingEmail } = await import("../src/services/financingEmail");
    const result = await sendFinancingEmail(prisma, estimateId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no customer email/i);
  });

  it("returns a clean refusal for an unknown estimate id", async () => {
    const { sendFinancingEmail } = await import("../src/services/financingEmail");
    const result = await sendFinancingEmail(prisma, "does-not-exist");
    expect(result.ok).toBe(false);
  });

  it("sends through sendBrandedEmail with the configured financing link, and the body carries NO credit terms", async () => {
    const mod = await import("../src/services/confirmationEmail");
    const spy = vi.spyOn(mod, "sendBrandedEmail").mockResolvedValue(true);
    try {
      const estimateId = await issuedEstimateId("send-ok");
      const { sendFinancingEmail } = await import("../src/services/financingEmail");
      const { getCompanyProfile } = await import("../src/services/companyProfile");
      const { financingUrl } = await getCompanyProfile();

      const result = await sendFinancingEmail(prisma, estimateId);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.to).toBe(CUSTOMER_EMAIL);

      expect(spy).toHaveBeenCalledTimes(1);
      const call = spy.mock.calls[0][0];
      expect(call.to).toBe(CUSTOMER_EMAIL);
      expect(call.kind).toBe("financing");
      expect(call.issuedEstimateId).toBe(estimateId);
      expect(String(call.bodyHtml)).toContain(financingUrl);
      expect(String(call.bodyHtml)).not.toMatch(FORBIDDEN_CREDIT_TERMS);
      expect(String(call.subject)).not.toMatch(FORBIDDEN_CREDIT_TERMS);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("POST /issued-estimates/:id/email-financing (CRM)", () => {
  it("emails the financing link and responds with the minimum shape", async () => {
    const mod = await import("../src/services/confirmationEmail");
    const spy = vi.spyOn(mod, "sendBrandedEmail").mockResolvedValue(true);
    try {
      const estimateId = await issuedEstimateId("crm-ok");
      const res = await request(app).post(`/issued-estimates/${estimateId}/email-financing`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.to).toBe(CUSTOMER_EMAIL);
    } finally {
      spy.mockRestore();
    }
  });

  it("400s with a reason when there is no customer email", async () => {
    const estimateId = await issuedEstimateId("crm-no-email");
    await prisma.issuedEstimate.update({ where: { id: estimateId }, data: { customerEmail: null } });

    const res = await request(app).post(`/issued-estimates/${estimateId}/email-financing`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no customer email/i);
  });
});

describe("POST /health-record/issued-estimates/:id/email-financing (field)", () => {
  it("403s a technician who is not assigned to this estimate's visit", async () => {
    const estimateId = await fieldIssuedEstimateId("field-not-yours");

    const res = await auth(otherTechToken)(request(app).post(`/health-record/issued-estimates/${estimateId}/email-financing`)).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("404s an estimate id that does not exist", async () => {
    const res = await auth(techToken)(request(app).post("/health-record/issued-estimates/does-not-exist/email-financing")).send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("the assigned technician can send it, with only { to } on the wire", async () => {
    const mod = await import("../src/services/confirmationEmail");
    const spy = vi.spyOn(mod, "sendBrandedEmail").mockResolvedValue(true);
    try {
      const estimateId = await fieldIssuedEstimateId("field-send-ok");

      const res = await auth(techToken)(request(app).post(`/health-record/issued-estimates/${estimateId}/email-financing`)).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.to).toBe(CUSTOMER_EMAIL);
      expect(Object.keys(res.body.data)).toEqual(["to"]);
    } finally {
      spy.mockRestore();
    }
  });
});
