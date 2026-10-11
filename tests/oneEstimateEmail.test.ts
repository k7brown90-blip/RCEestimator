/**
 * Phase 4 of the one-estimating-system plan (2026-10-08): the estimate email and the financing
 * link are ONE service behind two doors.
 *
 *   1. FINANCING BEFORE SIGNING. Kyle: "the financing link should be able to be sent before
 *      signing." sendFinancingEmail needs only an issued estimate and a customer email. It is sent
 *      from the CRM (POST /issued-estimates/:id/email-financing) and the phone
 *      (POST /health-record/issued-estimates/:id/email-financing) on an estimate nobody has
 *      signed, and refuses - in the SERVICE, so both doors answer in the same words - a void, a
 *      lost and a superseded estimate. Signed is still allowed (the payment panel sends it).
 *      tests/financingEmail.test.ts keeps pinning that the email carries no credit terms; this file
 *      does not touch that.
 *
 *   2. THE ESTIMATE EMAIL'S OPTIONS REACH THE SERVICE IDENTICALLY. The CRM's POST
 *      /issued-estimates/:id/send used to take an address, a note, the two reports and the
 *      financing line while the phone's POST /health-record/issued-estimates/:id/email took photo
 *      ids only. Both now parse with estimateEmailBodySchema and call sendEstimateEmail through
 *      sendEstimateEmailFromBody, so the same body produces the same email, the same defaults and
 *      the same refusals through either door - only `sentBy` (who pressed it) differs.
 *
 * Builds its own price-book fixture (Kyle's 2026-09-15 ruling - tests/helpers/priceBookFixture.ts).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";
import { deleteAtomics, ensurePriceBookGates, quotableAtomic, seedAtomics } from "./helpers/priceBookFixture";
import { ESTIMATE_EMAIL_DEFAULTS, estimateEmailRequest } from "../shared/estimateEmail";

const MARK = "OEE";
const GOOD = "OEE001";
const CUSTOMER_EMAIL = "oee-customer@example.com";

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;
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
    data: { name: `${MARK} Customer`, phone: "615-555-0177", email: CUSTOMER_EMAIL },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} House`, addressLine1: "77 One Email Way", city: "Murfreesboro", state: "TN", postalCode: "37127" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: `${MARK} job`, status: "scheduled" },
  });
  visitId = visit.id;
  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `oee-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;
  await prisma.visitAssignment.create({ data: { visitId, technicianId } });
});

afterAll(async () => {
  await cleanEstimatesFor(draftIds);
  await prisma.priceBookDraftLine.deleteMany({ where: { draftId: { in: draftIds } } });
  await prisma.priceBookDraftEstimate.deleteMany({ where: { id: { in: draftIds } } });
  await prisma.visitAssignment.deleteMany({ where: { visitId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await deleteAtomics([GOOD]);
});

const tech = (r: request.Test) => r.set("Authorization", `Bearer ${techToken}`);

/** Issue a fresh estimate through the field quote flow (visitId set), returning its id. Unsigned. */
async function issueEstimate(title: string): Promise<string> {
  const draft = await prisma.priceBookDraftEstimate.create({ data: { title: `${MARK} ${title}`, supplierId: "HD", visitId } });
  draftIds.push(draft.id);
  const line = await tech(request(app).post(`/health-record/quotes/${draft.id}/lines`)).send({
    itemId: GOOD, quantity: 1, quantitySource: "COUNT",
  });
  expect(line.status, JSON.stringify(line.body)).toBe(201);
  const issued = await tech(request(app).post(`/health-record/quotes/${draft.id}/issue`)).send({});
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  return issued.body.data.estimateId as string;
}

type Mail = { to: string; kind?: string; subject: string; bodyHtml: string; attachments?: unknown };
type MailSpy = { mock: { calls: unknown[][] } } & { mockRestore: () => void };
/** What went to sendBrandedEmail, in order. */
const mails = (spy: MailSpy): Mail[] => spy.mock.calls.map((call) => call[0] as Mail);

async function withMailSpy<T>(fn: (spy: MailSpy) => Promise<T>): Promise<T> {
  const mod = await import("../src/services/confirmationEmail");
  const spy = vi.spyOn(mod, "sendBrandedEmail").mockResolvedValue(true);
  try {
    return await fn(spy);
  } finally {
    spy.mockRestore();
  }
}

const crmFinancing = (id: string) => request(app).post(`/issued-estimates/${id}/email-financing`).send({});
const fieldFinancing = (id: string) => tech(request(app).post(`/health-record/issued-estimates/${id}/email-financing`)).send({});

// ─── 1. Financing link before signing ────────────────────────────────────────

describe("the financing link before signing", () => {
  it("goes out on an issued, UNSIGNED estimate from the CRM door and the field door", async () => {
    await withMailSpy(async (spy) => {
      const id = await issueEstimate("fin-unsigned");
      const before = await prisma.issuedEstimate.findUnique({ where: { id } });
      expect(before!.signedAt).toBeNull();

      const crm = await crmFinancing(id);
      expect(crm.status, JSON.stringify(crm.body)).toBe(200);
      expect(crm.body.to).toBe(CUSTOMER_EMAIL);

      const field = await fieldFinancing(id);
      expect(field.status, JSON.stringify(field.body)).toBe(200);
      expect(field.body.data.to).toBe(CUSTOMER_EMAIL);

      expect(spy).toHaveBeenCalledTimes(2);
      const [a, b] = mails(spy);
      expect(a.kind).toBe("financing");
      expect(b.kind).toBe("financing");
      // One service, one email: the same words from either door.
      expect(a.bodyHtml).toBe(b.bodyHtml);
      expect(a.subject).toBe(b.subject);

      // Sending the link is not signing, and it does not move the estimate.
      const after = await prisma.issuedEstimate.findUnique({ where: { id } });
      expect(after!.signedAt).toBeNull();
      expect(after!.status).toBe(before!.status);
    });
  });

  it("is still allowed once the estimate is signed (the payment panel sends it)", async () => {
    await withMailSpy(async () => {
      const id = await issueEstimate("fin-signed");
      await prisma.issuedEstimate.update({ where: { id }, data: { status: "signed", signedAt: new Date(), signerName: "T" } });
      expect((await crmFinancing(id)).status).toBe(200);
      expect((await fieldFinancing(id)).status).toBe(200);
    });
  });

  it("refuses a VOID estimate in the service - the same words and nothing sent, from both doors", async () => {
    await withMailSpy(async (spy) => {
      const id = await issueEstimate("fin-void");
      await prisma.issuedEstimate.update({ where: { id }, data: { status: "void", voidedAt: new Date(), voidReason: "test" } });

      const crm = await crmFinancing(id);
      expect(crm.status).toBe(400);
      expect(crm.body.error).toMatch(/void/i);
      const field = await fieldFinancing(id);
      expect(field.status).toBe(409);
      expect(field.body.error.code).toBe("not_sent");
      expect(field.body.error.message).toBe(crm.body.error);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("refuses a LOST estimate and says how to get it back, from both doors", async () => {
    await withMailSpy(async (spy) => {
      const id = await issueEstimate("fin-lost");
      await prisma.issuedEstimate.update({ where: { id }, data: { status: "lost" } });

      const crm = await crmFinancing(id);
      expect(crm.status).toBe(400);
      expect(crm.body.error).toMatch(/lost/i);
      expect(crm.body.error).toMatch(/reopen/i);
      const field = await fieldFinancing(id);
      expect(field.status).toBe(409);
      expect(field.body.error.message).toBe(crm.body.error);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("refuses a SUPERSEDED estimate - the newer revision is the one to send", async () => {
    await withMailSpy(async (spy) => {
      const oldId = await issueEstimate("fin-old-rev");
      const newId = await issueEstimate("fin-new-rev");
      await prisma.issuedEstimate.update({ where: { id: newId }, data: { supersedesId: oldId } });

      const crm = await crmFinancing(oldId);
      expect(crm.status).toBe(400);
      expect(crm.body.error).toMatch(/superseded/i);
      const field = await fieldFinancing(oldId);
      expect(field.status).toBe(409);
      expect(field.body.error.message).toBe(crm.body.error);
      expect(spy).not.toHaveBeenCalled();

      // The newer revision is the live one and goes out.
      expect((await crmFinancing(newId)).status).toBe(200);
    });
  });

  it("the phone still cannot send it for an estimate on a visit that is not theirs", async () => {
    const id = await issueEstimate("fin-not-yours");
    const stranger = await prisma.technician.create({ data: { name: `${MARK} Stranger`, accessToken: `oee-stranger-${customerId}` } });
    try {
      const res = await request(app)
        .post(`/health-record/issued-estimates/${id}/email-financing`)
        .set("Authorization", `Bearer ${stranger.accessToken}`)
        .send({});
      expect(res.status).toBe(403);
    } finally {
      await prisma.technician.delete({ where: { id: stranger.id } });
    }
  });
});

// ─── 2. The estimate email: one body, one service ────────────────────────────

const crmSend = (id: string, body: Record<string, unknown>) => request(app).post(`/issued-estimates/${id}/send`).send(body);
const fieldSend = (id: string, body: Record<string, unknown>) =>
  tech(request(app).post(`/health-record/issued-estimates/${id}/email`)).send(body);

describe("the estimate email's options reach the service identically from both doors", () => {
  it("the shared defaults: financing line ON, nothing attached, nothing else sent", () => {
    expect(ESTIMATE_EMAIL_DEFAULTS).toEqual({
      to: "", message: "", photoIds: [], attachHealthReport: false, attachGeneratorReport: false, includeFinancingLink: true,
    });
    // Nothing chosen is the empty body the phone has always sent.
    expect(JSON.parse(JSON.stringify(estimateEmailRequest()))).toEqual({});
    // Only a switched-OFF financing box is sent; a ticked one is the server's default.
    expect(JSON.parse(JSON.stringify(estimateEmailRequest({ includeFinancingLink: false })))).toEqual({ includeFinancingLink: false });
    expect(JSON.parse(JSON.stringify(estimateEmailRequest({
      to: " other@example.com ", message: " hello ", photoIds: ["p1"], attachHealthReport: true, attachGeneratorReport: true,
    })))).toEqual({ to: "other@example.com", message: "hello", photoIds: ["p1"], attachHealthReport: true, attachGeneratorReport: true });
  });

  it("the default body sends the same email through either door, financing line included", async () => {
    await withMailSpy(async (spy) => {
      const id = await issueEstimate("email-default");
      const body = estimateEmailRequest();
      const crm = await crmSend(id, body as Record<string, unknown>);
      const field = await fieldSend(id, body as Record<string, unknown>);
      expect(crm.status, JSON.stringify(crm.body)).toBe(200);
      expect(field.status, JSON.stringify(field.body)).toBe(200);

      const [a, b] = mails(spy);
      expect(a.to).toBe(CUSTOMER_EMAIL);
      expect(b.to).toBe(CUSTOMER_EMAIL);
      expect(a.subject).toBe(b.subject);
      expect(a.bodyHtml).toBe(b.bodyHtml);
      expect(a.attachments).toBeUndefined();
      expect(b.attachments).toBeUndefined();
      // Kyle, 2026-10-10: the one-line pitch became a "Finance this project" button + monthly payments.
      expect(String(a.bodyHtml)).toContain("Finance this project");
    });
  });

  it("an address override, a note and the financing box OFF reach the email identically", async () => {
    await withMailSpy(async (spy) => {
      const id = await issueEstimate("email-options");
      const body = estimateEmailRequest({ to: "spouse@example.com", message: "Call me with questions", includeFinancingLink: false });
      const crm = await crmSend(id, body as Record<string, unknown>);
      const field = await fieldSend(id, body as Record<string, unknown>);
      expect(crm.body.to).toBe("spouse@example.com");
      expect(field.body.data.to).toBe("spouse@example.com");

      const [a, b] = mails(spy);
      expect(a.to).toBe("spouse@example.com");
      expect(b.to).toBe("spouse@example.com");
      expect(a.bodyHtml).toBe(b.bodyHtml);
      expect(String(b.bodyHtml)).toContain("Call me with questions");
      expect(String(b.bodyHtml)).not.toContain("Finance this project");

      // Who pressed it is the one difference, and it is recorded.
      const est = await prisma.issuedEstimate.findUnique({ where: { id } });
      expect(est!.sentBy).toBe(`tech:${technicianId}`);
    });
  });

  it("the report attachments refuse in the same words from both doors when there is no assessment at the address", async () => {
    await withMailSpy(async (spy) => {
      const id = await issueEstimate("email-reports");
      for (const choice of [{ attachHealthReport: true }, { attachGeneratorReport: true }]) {
        const body = estimateEmailRequest(choice);
        const crm = await crmSend(id, body as Record<string, unknown>);
        const field = await fieldSend(id, body as Record<string, unknown>);
        expect(crm.status).toBe(400);
        expect(crm.body.error).toMatch(/no electrical assessment is on file/i);
        expect(field.status).toBe(409);
        expect(field.body.error.message).toBe(crm.body.error);
      }
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("the same refusals: void, a bad address, more than ten photos - nothing sent", async () => {
    await withMailSpy(async (spy) => {
      const id = await issueEstimate("email-refusals");

      // A bad address override fails the one shared schema: both doors answer 4xx, nothing sent.
      const crmBad = await crmSend(id, { to: "not-an-email" });
      const fieldBad = await fieldSend(id, { to: "not-an-email" });
      expect(crmBad.status).toBeGreaterThanOrEqual(400);
      expect(crmBad.status).toBeLessThan(500);
      expect(fieldBad.status).toBeGreaterThanOrEqual(400);
      expect(fieldBad.status).toBeLessThan(500);

      const tooMany = { photoIds: Array.from({ length: 11 }, (_, i) => `p${i}`) };
      const crmMany = await crmSend(id, tooMany);
      const fieldMany = await fieldSend(id, tooMany);
      expect(crmMany.status).toBeGreaterThanOrEqual(400);
      expect(crmMany.status).toBeLessThan(500);
      expect(fieldMany.status).toBeGreaterThanOrEqual(400);
      expect(fieldMany.status).toBeLessThan(500);
      expect(spy).not.toHaveBeenCalled();

      await prisma.issuedEstimate.update({ where: { id }, data: { status: "void", voidedAt: new Date(), voidReason: "test" } });
      const crm = await crmSend(id, {});
      const field = await fieldSend(id, {});
      expect(crm.status).toBe(400);
      expect(field.status).toBe(409);
      expect(field.body.error.message).toBe(crm.body.error);
      expect(String(crm.body.error)).toMatch(/void/i);
    });
  });
});
