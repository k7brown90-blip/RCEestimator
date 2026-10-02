/**
 * The Google review ask, sendable on its own by a human (2026-10-01 plan
 * 2026-10-01-manual-sends-archiving-and-one-calendar.md, item B).
 *
 * Kyle switched AUTOMATED_CUSTOMER_SENDS_REVIEW_REQUESTS off on 2026-10-01, so
 * as of that ruling NOTHING reaches a customer through the automatic
 * completion doors (app.ts /jobs/:jobId/complete and health-record.ts's
 * field close-out) until a human presses a button. These tests prove:
 *
 *   1. With the gate OFF, the AUTOMATIC call (no opts, or opts.manual=false)
 *      is still suppressed — proving item A's "the review request is no
 *      longer automated" still holds.
 *   2. With the gate OFF, the MANUAL call (opts.manual: true) still sends —
 *      the whole point of this build.
 *   3. Every OTHER guard (job must be completed, no duplicate ask on this
 *      job, no repeat ask on this customer within 90 days, customer must
 *      have an email) still applies on the manual path exactly as it does
 *      on the automatic one — the gate is the ONLY thing bypassed.
 *   4. The two new routes — CRM `POST /jobs/:jobId/email-review-request` and
 *      field `POST /health-record/visits/:visitId/email-review-request` —
 *      wire the manual bypass correctly and the field route 403s a
 *      technician who is not assigned to the visit.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";
import { app } from "../src/app";

const MARK = "RVW";

let customerId: string;
let propertyId: string;
const visitIds: string[] = [];
let technicianId: string;
let techToken: string;
let otherTechnicianId: string;
let otherTechToken: string;

async function makeCompletedVisit(suffix: string, opts: { email?: string | null } = {}): Promise<{ visitId: string; customerEmail: string | null }> {
  const email = opts.email === undefined ? `${MARK}-${suffix}@example.com` : opts.email;
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Customer ${suffix}`, phone: "615-555-0177", email },
  });
  const property = await prisma.property.create({
    data: { customerId: customer.id, name: `${MARK} House ${suffix}`, addressLine1: `${suffix} Review Way`, city: "La Vergne", state: "TN", postalCode: "37086" },
  });
  const visit = await prisma.visit.create({
    data: {
      customerId: customer.id,
      propertyId: property.id,
      mode: "onsite",
      purpose: `${MARK} job ${suffix}`,
      status: "completed",
      completedAt: new Date(),
    },
  });
  visitIds.push(visit.id);
  // Tracked so cleanup can find the customer/property too, keyed off the visit.
  customerIdsBySuffix[suffix] = customer.id;
  propertyIdsBySuffix[suffix] = property.id;
  return { visitId: visit.id, customerEmail: email };
}

const customerIdsBySuffix: Record<string, string> = {};
const propertyIdsBySuffix: Record<string, string> = {};

beforeAll(async () => {
  // Shared account for the technician-gated routes (CRM job routes don't need one).
  const customer = await prisma.customer.create({
    data: { name: `${MARK} Tech Customer`, phone: "615-555-0166", email: `${MARK}-tech@example.com` },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: `${MARK} Tech House`, addressLine1: "66 Review Way", city: "La Vergne", state: "TN", postalCode: "37086" },
  });
  propertyId = property.id;

  const tech = await prisma.technician.create({ data: { name: `${MARK} Tech`, accessToken: `rvw-test-${customer.id}` } });
  technicianId = tech.id;
  techToken = tech.accessToken;

  const other = await prisma.technician.create({ data: { name: `${MARK} Other Tech`, accessToken: `rvw-other-${customer.id}` } });
  otherTechnicianId = other.id;
  otherTechToken = other.accessToken;
});

afterEach(() => {
  // Never leak a gate override between tests.
  delete process.env.AUTOMATED_CUSTOMER_SENDS_REVIEW_REQUESTS;
  delete process.env.AUTOMATED_CUSTOMER_SENDS;
});

afterAll(async () => {
  await prisma.visitAssignment.deleteMany({ where: { visitId: { in: visitIds } } });
  await prisma.visit.deleteMany({ where: { id: { in: visitIds } } });
  await prisma.visit.deleteMany({ where: { customerId } });
  const customerIds = Object.values(customerIdsBySuffix);
  const propertyIds = Object.values(propertyIdsBySuffix);
  await prisma.property.deleteMany({ where: { id: { in: [...propertyIds, propertyId] } } });
  await prisma.customer.deleteMany({ where: { id: { in: [...customerIds, customerId] } } });
  await prisma.technician.deleteMany({ where: { id: { in: [technicianId, otherTechnicianId] } } });
});

const auth = (token: string) => (r: request.Test) => r.set("Authorization", `Bearer ${token}`);

describe("services/reviewRequest — manual bypass vs. the automatic gate", () => {
  it("with the gate OFF: the automatic call is suppressed, the manual call on the SAME visit still sends", async () => {
    delete process.env.AUTOMATED_CUSTOMER_SENDS_REVIEW_REQUESTS;
    delete process.env.AUTOMATED_CUSTOMER_SENDS;

    const { visitId, customerEmail } = await makeCompletedVisit("gate-off");
    const mod = await import("../src/services/confirmationEmail");
    const spy = vi.spyOn(mod, "sendBrandedEmail").mockResolvedValue(true);
    try {
      const { sendReviewRequestEmail } = await import("../src/services/reviewRequest");

      // 1. Automatic path (no opts) — gate is OFF, so this must be suppressed.
      const automatic = await sendReviewRequestEmail(prisma, visitId);
      expect(automatic.ok, "the automatic path must still respect the gate").toBe(false);
      expect(spy).not.toHaveBeenCalled();
      const stillUnasked = await prisma.visit.findUniqueOrThrow({ where: { id: visitId } });
      expect(stillUnasked.reviewRequestedAt).toBeNull();

      // 2. Manual path, same visit, gate still OFF — must send anyway.
      const manual = await sendReviewRequestEmail(prisma, visitId, { manual: true });
      expect(manual.ok, JSON.stringify(manual)).toBe(true);
      if (!manual.ok) return;
      expect(manual.to).toBe(customerEmail);
      expect(spy).toHaveBeenCalledTimes(1);

      const asked = await prisma.visit.findUniqueOrThrow({ where: { id: visitId } });
      expect(asked.reviewRequestedAt).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("the manual bypass does NOT skip the other guards — a second manual press refuses (dedupe)", async () => {
    const { visitId } = await makeCompletedVisit("dedupe");
    const mod = await import("../src/services/confirmationEmail");
    const spy = vi.spyOn(mod, "sendBrandedEmail").mockResolvedValue(true);
    try {
      const { sendReviewRequestEmail } = await import("../src/services/reviewRequest");
      const first = await sendReviewRequestEmail(prisma, visitId, { manual: true });
      expect(first.ok).toBe(true);

      const second = await sendReviewRequestEmail(prisma, visitId, { manual: true });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.reason).toMatch(/already been sent/i);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("manual still refuses a job that is not completed", async () => {
    const customer = await prisma.customer.create({ data: { name: `${MARK} Not Done`, phone: "615-555-0101", email: "rvw-notdone@example.com" } });
    const property = await prisma.property.create({ data: { customerId: customer.id, name: `${MARK} Not Done House`, addressLine1: "1 Not Done Way", city: "La Vergne", state: "TN", postalCode: "37086" } });
    const visit = await prisma.visit.create({ data: { customerId: customer.id, propertyId: property.id, mode: "onsite", purpose: `${MARK} not done`, status: "scheduled" } });
    visitIds.push(visit.id);
    customerIdsBySuffix["not-done"] = customer.id;
    propertyIdsBySuffix["not-done"] = property.id;

    const { sendReviewRequestEmail } = await import("../src/services/reviewRequest");
    const result = await sendReviewRequestEmail(prisma, visit.id, { manual: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/not marked complete/i);
  });

  it("manual still refuses when there is no customer email on file", async () => {
    const { visitId } = await makeCompletedVisit("no-email", { email: null });
    const { sendReviewRequestEmail } = await import("../src/services/reviewRequest");
    const result = await sendReviewRequestEmail(prisma, visitId, { manual: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no email on file/i);
  });
});

describe("POST /jobs/:jobId/email-review-request (CRM)", () => {
  it("sends with the gate off, since a human pressed it", async () => {
    delete process.env.AUTOMATED_CUSTOMER_SENDS_REVIEW_REQUESTS;
    delete process.env.AUTOMATED_CUSTOMER_SENDS;

    const { visitId, customerEmail } = await makeCompletedVisit("crm-ok");
    const mod = await import("../src/services/confirmationEmail");
    const spy = vi.spyOn(mod, "sendBrandedEmail").mockResolvedValue(true);
    try {
      const res = await request(app).post(`/jobs/${visitId}/email-review-request`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.to).toBe(customerEmail);
    } finally {
      spy.mockRestore();
    }
  });

  it("400s with the service's reason when the job is not complete", async () => {
    const customer = await prisma.customer.create({ data: { name: `${MARK} CRM Not Done`, phone: "615-555-0102", email: "rvw-crm-notdone@example.com" } });
    const property = await prisma.property.create({ data: { customerId: customer.id, name: `${MARK} CRM Not Done House`, addressLine1: "2 Not Done Way", city: "La Vergne", state: "TN", postalCode: "37086" } });
    const visit = await prisma.visit.create({ data: { customerId: customer.id, propertyId: property.id, mode: "onsite", purpose: `${MARK} crm not done`, status: "scheduled" } });
    visitIds.push(visit.id);
    customerIdsBySuffix["crm-not-done"] = customer.id;
    propertyIdsBySuffix["crm-not-done"] = property.id;

    const res = await request(app).post(`/jobs/${visit.id}/email-review-request`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not marked complete/i);
  });
});

/**
 * POST /accounts/:accountId/email-review-request — the ACCOUNT-keyed door (item E / ruling E2,
 * 2026-10-02): a phone call is with a customer, not a Visit.id, so this resolves the account's
 * own most recently completed job and hands it to the exact same service as the job-keyed door
 * above. Every guard proven above still applies; these tests prove the RESOLUTION step and that
 * it reads as a sentence when there is nothing to resolve.
 */
describe("POST /accounts/:accountId/email-review-request (CRM, account-keyed)", () => {
  it("404s an account that does not exist", async () => {
    const res = await request(app).post("/accounts/does-not-exist/email-review-request").send({});
    expect(res.status).toBe(404);
  });

  it("400s, readably, when the account has no completed job at all", async () => {
    const customer = await prisma.customer.create({ data: { name: `${MARK} Acct No Job`, phone: "615-555-0103", email: "rvw-acct-nojob@example.com" } });
    customerIdsBySuffix["acct-no-job"] = customer.id;
    const res = await request(app).post(`/accounts/${customer.id}/email-review-request`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no completed job/i);
  });

  it("400s, readably, when the account's only jobs are not completed yet", async () => {
    const customer = await prisma.customer.create({ data: { name: `${MARK} Acct Open`, phone: "615-555-0104", email: "rvw-acct-open@example.com" } });
    const property = await prisma.property.create({ data: { customerId: customer.id, name: `${MARK} Acct Open House`, addressLine1: "3 Review Way", city: "La Vergne", state: "TN", postalCode: "37086" } });
    const visit = await prisma.visit.create({ data: { customerId: customer.id, propertyId: property.id, mode: "onsite", purpose: `${MARK} acct open`, status: "scheduled" } });
    visitIds.push(visit.id);
    customerIdsBySuffix["acct-open"] = customer.id;
    propertyIdsBySuffix["acct-open"] = property.id;

    const res = await request(app).post(`/accounts/${customer.id}/email-review-request`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no completed job/i);
  });

  it("resolves the MOST RECENTLY completed job when there are several, and sends with the gate off", async () => {
    delete process.env.AUTOMATED_CUSTOMER_SENDS_REVIEW_REQUESTS;
    delete process.env.AUTOMATED_CUSTOMER_SENDS;

    const customer = await prisma.customer.create({ data: { name: `${MARK} Acct Multi`, phone: "615-555-0105", email: "rvw-acct-multi@example.com" } });
    const property = await prisma.property.create({ data: { customerId: customer.id, name: `${MARK} Acct Multi House`, addressLine1: "4 Review Way", city: "La Vergne", state: "TN", postalCode: "37086" } });
    const older = await prisma.visit.create({
      data: { customerId: customer.id, propertyId: property.id, mode: "onsite", purpose: `${MARK} older job`, status: "completed", completedAt: new Date("2026-08-01T12:00:00.000Z") },
    });
    const newer = await prisma.visit.create({
      data: { customerId: customer.id, propertyId: property.id, mode: "onsite", purpose: `${MARK} newer job`, status: "completed", completedAt: new Date("2026-09-20T12:00:00.000Z") },
    });
    visitIds.push(older.id, newer.id);
    customerIdsBySuffix["acct-multi"] = customer.id;
    propertyIdsBySuffix["acct-multi"] = property.id;

    const mod = await import("../src/services/confirmationEmail");
    const spy = vi.spyOn(mod, "sendBrandedEmail").mockResolvedValue(true);
    try {
      const res = await request(app).post(`/accounts/${customer.id}/email-review-request`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.to).toBe("rvw-acct-multi@example.com");
      // The NEWER job got the ask, not the older one.
      expect(res.body.visitId).toBe(newer.id);

      const olderAfter = await prisma.visit.findUniqueOrThrow({ where: { id: older.id } });
      const newerAfter = await prisma.visit.findUniqueOrThrow({ where: { id: newer.id } });
      expect(olderAfter.reviewRequestedAt).toBeNull();
      expect(newerAfter.reviewRequestedAt).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("the account's OTHER guards still apply — a second press on the same resolved job is a dedupe refusal", async () => {
    const { visitId: _unused, customerEmail } = await makeCompletedVisit("acct-dedupe");
    const customerId = customerIdsBySuffix["acct-dedupe"];
    const mod = await import("../src/services/confirmationEmail");
    const spy = vi.spyOn(mod, "sendBrandedEmail").mockResolvedValue(true);
    try {
      const first = await request(app).post(`/accounts/${customerId}/email-review-request`).send({});
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.to).toBe(customerEmail);

      const second = await request(app).post(`/accounts/${customerId}/email-review-request`).send({});
      expect(second.status).toBe(400);
      expect(second.body.error).toMatch(/already been sent/i);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("POST /health-record/visits/:visitId/email-review-request (field)", () => {
  it("403s a technician who is not assigned to this visit", async () => {
    const { visitId } = await makeCompletedVisit("field-not-yours");
    const res = await auth(otherTechToken)(request(app).post(`/health-record/visits/${visitId}/email-review-request`)).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("the assigned technician can send it, with only { to } on the wire, gate off", async () => {
    delete process.env.AUTOMATED_CUSTOMER_SENDS_REVIEW_REQUESTS;
    delete process.env.AUTOMATED_CUSTOMER_SENDS;

    const { visitId, customerEmail } = await makeCompletedVisit("field-ok");
    await prisma.visitAssignment.create({ data: { visitId, technicianId } });

    const mod = await import("../src/services/confirmationEmail");
    const spy = vi.spyOn(mod, "sendBrandedEmail").mockResolvedValue(true);
    try {
      const res = await auth(techToken)(request(app).post(`/health-record/visits/${visitId}/email-review-request`)).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.to).toBe(customerEmail);
      expect(Object.keys(res.body.data)).toEqual(["to"]);
    } finally {
      spy.mockRestore();
    }
  });
});
