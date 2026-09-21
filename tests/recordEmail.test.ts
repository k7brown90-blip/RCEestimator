/**
 * The single-recipient follow-up email (2026-09-20 communications build, Phase 4):
 * "Follow ups can be done by sending an email straight from the CRM."
 *
 * Pins:
 *   1. POST /communications/email sends through the SAME sendCustomerEmail pipe as every other
 *      customer email (fetch stubbed here, never real network) and writes ONE EmailDelivery row
 *      per send, tagged leadId / customerId / visitId per target — the thread the drawers read
 *      back via GET /email-deliveries.
 *   2. An unsubscribed address is NOT refused — it PROCEEDS (relationship mail, not a campaign
 *      list) and the response says so (`suppressed: true`) rather than pretending the flag isn't
 *      there.
 *   3. 404 for an unknown record, 400 when there is no address anywhere to send to.
 *   4. The campaign-membership add/remove pair on the lead — the standing rule's exit.
 *
 * Nothing here touches the network: fetch is stubbed (Resend), nodemailer and googleapis mocked —
 * same pattern as tests/transactionalEmail.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

process.env.GMAIL_USER = "service@example.test";
process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
process.env.RESEND_API_KEY = "re_test_key_never_used";
delete process.env.TRANSACTIONAL_EMAIL_PROVIDER;

vi.mock("../src/services/twilio");
vi.mock("googleapis");

const mail = vi.hoisted(() => ({ sendMail: vi.fn<(opts: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: mail.sendMail }) } }));

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal("fetch", fetchMock);

function resendOk(id: string): Response {
  return new Response(JSON.stringify({ id }), { status: 200, headers: { "Content-Type": "application/json" } });
}

import { app } from "../src/app";

const RUN = Date.now();
const DOMAIN = `rectest-${RUN}.example`;
const TAG = "RecEmail";

let leadId: string;
let accountId: string;
let accountEmail: string;
let visitId: string;
let propertyId: string;

const cleanup = async () => {
  await prisma.emailDelivery.deleteMany({ where: { to: { endsWith: `@${DOMAIN}` } } });
  await prisma.emailListMember.deleteMany({ where: { leadId: { not: null }, name: { startsWith: TAG } } });
  await prisma.visit.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.property.deleteMany({ where: { customer: { name: { startsWith: TAG } } } });
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: TAG } } });
  await prisma.emailSuppression.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
};

beforeAll(async () => {
  await cleanup();
  const lead = await prisma.lead.create({ data: { name: `${TAG} Lead`, email: `lead@${DOMAIN}`, source: "web" } });
  leadId = lead.id;

  accountEmail = `account@${DOMAIN}`;
  const account = await prisma.customer.create({ data: { name: `${TAG} Account`, email: accountEmail } });
  accountId = account.id;
  const property = await prisma.property.create({
    data: { customerId: accountId, name: `${TAG} property`, addressLine1: "1 Test Way", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { propertyId, customerId: accountId, mode: "service_call", status: "scheduled" },
  });
  visitId = visit.id;
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(resendOk(`rectest_${RUN}_${Math.random()}`));
  mail.sendMail.mockReset();
});

describe("POST /communications/email", () => {
  it("sends to the lead's own address when `to` is omitted, and logs an EmailDelivery row tagged leadId", async () => {
    const res = await request(app)
      .post("/communications/email")
      .send({ target: "lead", id: leadId, subject: "Checking in", body: "Just following up." })
      .expect(200);

    expect(res.body).toEqual({ sent: true, to: `lead@${DOMAIN}`, suppressed: false });

    const rows = await prisma.emailDelivery.findMany({ where: { leadId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ to: `lead@${DOMAIN}`, kind: "communication", customerId: null, visitId: null });
  });

  it("sends to an override address for an account and tags it customerId, never leadId", async () => {
    const to = `override@${DOMAIN}`;
    const res = await request(app)
      .post("/communications/email")
      .send({ target: "account", id: accountId, to, subject: "Your quote", body: "Any questions, just reply." })
      .expect(200);

    expect(res.body.to).toBe(to);
    const rows = await prisma.emailDelivery.findMany({ where: { customerId: accountId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ to, kind: "communication", leadId: null, visitId: null });
  });

  it("sends about a job and tags it visitId", async () => {
    const res = await request(app)
      .post("/communications/email")
      .send({ target: "job", id: visitId, subject: "See you Tuesday", body: "Reminder about the appointment." })
      .expect(200);

    expect(res.body.to).toBe(accountEmail);
    const rows = await prisma.emailDelivery.findMany({ where: { visitId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ to: accountEmail, kind: "communication", leadId: null, customerId: null });
  });

  it("proceeds for an unsubscribed address (relationship mail, not a campaign) and says so", async () => {
    const to = `unsub@${DOMAIN}`;
    await prisma.emailSuppression.create({ data: { email: to, reason: "unsubscribed" } });

    const res = await request(app)
      .post("/communications/email")
      .send({ target: "lead", id: leadId, to, subject: "Following up", body: "About your estimate." })
      .expect(200);

    expect(res.body).toEqual({ sent: true, to, suppressed: true });
    expect(fetchMock).toHaveBeenCalled();
  });

  it("404s for an unknown lead", async () => {
    await request(app)
      .post("/communications/email")
      .send({ target: "lead", id: "no-such-lead", subject: "x", body: "y" })
      .expect(404);
  });

  it("400s when the record has no address on file and none is typed", async () => {
    const bare = await prisma.lead.create({ data: { name: `${TAG} Bare`, source: "phone" } });
    try {
      const res = await request(app)
        .post("/communications/email")
        .send({ target: "lead", id: bare.id, subject: "x", body: "y" })
        .expect(400);
      expect(res.body.error).toMatch(/no email address/i);
    } finally {
      await prisma.lead.delete({ where: { id: bare.id } });
    }
  });

  it("requires a non-empty subject and body", async () => {
    await request(app)
      .post("/communications/email")
      .send({ target: "lead", id: leadId, subject: "", body: "" })
      .expect(400);
  });
});

describe("GET /email-deliveries", () => {
  it("filters by leadId and customerId, same shape the estimate/visit thread already uses", async () => {
    await request(app).post("/communications/email").send({ target: "lead", id: leadId, subject: "s1", body: "b1" }).expect(200);
    const byLead = await request(app).get(`/email-deliveries?leadId=${leadId}`).expect(200);
    expect(byLead.body.length).toBeGreaterThan(0);
    expect(byLead.body.every((r: { leadId: string | null }) => r.leadId === leadId)).toBe(true);
  });
});

describe("Lead campaign membership — add and its exit", () => {
  it("adds a lead to the default list, then removes it from the same door", async () => {
    const added = await request(app).post(`/leads/${leadId}/add-to-campaign`).expect(200);
    expect(added.body.added).toBe(true);

    const members = await prisma.emailListMember.findMany({ where: { leadId } });
    expect(members.length).toBeGreaterThan(0);

    const removed = await request(app).delete(`/leads/${leadId}/campaign`).expect(200);
    expect(removed.body.removed).toBeGreaterThan(0);

    const after = await prisma.emailListMember.findMany({ where: { leadId } });
    expect(after).toHaveLength(0);
  });
});
