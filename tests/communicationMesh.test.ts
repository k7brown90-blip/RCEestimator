/**
 * Communication mesh tests — inbound SMS routing, appointment confirmation
 * (page + SMS keywords), tech job-site photos, receipt capture, and the
 * web-lead auto-reply hook.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { prisma } from "../src/lib/prisma";

process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "test-webhook-secret";
process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
delete process.env.OPENAI_API_KEY; // vision parse must degrade gracefully in tests

const sendSmsMock = vi.fn().mockResolvedValue({ sid: "SM_mock" });

vi.mock("../src/services/twilio", () => ({
  sendSms: (...args: unknown[]) => sendSmsMock(...args),
  KYLE_PHONE: "+19706661626",
  isFromKyle: (from: string) => from.replace(/[\s\-()]/g, "").endsWith("9706661626"),
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

import { app } from "../src/app";
import { parseConfirmationKeyword } from "../src/routes/inboundSms";

const CUSTOMER_PHONE = "+16155501234";
const TECH_PHONE = "+16155505678";
const TECH_TOKEN = `mesh-tech-${Date.now()}`;

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let confirmationToken: string;

beforeAll(async () => {
  const customer = await prisma.customer.create({
    data: { name: "Mesh Customer", phone: CUSTOMER_PHONE, email: "mesh@example.com" },
  });
  customerId = customer.id;

  const property = await prisma.property.create({
    data: { customerId, name: "Mesh House", addressLine1: "7 Mesh Way", city: "Franklin", state: "TN", postalCode: "37064" },
  });
  propertyId = property.id;

  confirmationToken = crypto.randomBytes(16).toString("base64url");
  const visit = await prisma.visit.create({
    data: {
      customerId,
      propertyId,
      mode: "onsite",
      purpose: "Panel swap",
      jobType: "Panel Upgrade",
      status: "scheduled",
      scheduledStart: new Date(Date.now() + 48 * 3600_000),
      scheduledEnd: new Date(Date.now() + 50 * 3600_000),
      confirmationToken,
    },
  });
  visitId = visit.id;

  const tech = await prisma.technician.create({
    data: { name: "Mesh Tech", phone: TECH_PHONE, employeeNumber: "MESH-01", accessToken: TECH_TOKEN, isActive: true },
  });
  technicianId = tech.id;

  await prisma.visitAssignment.create({ data: { visitId, technicianId, status: "assigned" } });
});

afterAll(async () => {
  await prisma.inboundMessage.deleteMany({ where: { fromPhone: { in: [CUSTOMER_PHONE, TECH_PHONE, "+15550009999"] } } });
  await prisma.receipt.deleteMany({ where: { technicianId } });
  await prisma.visitPhoto.deleteMany({ where: { visitId } });
  await prisma.visitAssignment.deleteMany({ where: { visitId } });
  await prisma.lead.deleteMany({ where: { name: "Mesh Web Lead" } });
  await prisma.visit.deleteMany({ where: { id: visitId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
});

describe("confirmation keyword parsing", () => {
  it("maps common replies to actions", () => {
    expect(parseConfirmationKeyword("YES")).toBe("confirm");
    expect(parseConfirmationKeyword("yes please")).toBe("confirm");
    expect(parseConfirmationKeyword("Confirm")).toBe("confirm");
    expect(parseConfirmationKeyword("reschedule")).toBe("reschedule");
    expect(parseConfirmationKeyword("NO")).toBe("cancel");
    expect(parseConfirmationKeyword("cancel it")).toBe("cancel");
    expect(parseConfirmationKeyword("what time again?")).toBeNull();
  });
});

describe("public confirmation page", () => {
  it("renders the confirmation page for a valid token", async () => {
    const res = await request(app).get(`/api/confirm/${confirmationToken}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Mesh");
    expect(res.text).toContain("Confirm Appointment");
  });

  it("404s for an unknown token", async () => {
    const res = await request(app).get("/api/confirm/not-a-real-token-123");
    expect(res.status).toBe(404);
  });

  it("applies confirm action via email link and records channel", async () => {
    const res = await request(app).get(`/api/confirm/${confirmationToken}?action=confirm`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("confirmed");

    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: visitId } });
    expect(visit.confirmationStatus).toBe("confirmed");
    expect(visit.confirmationChannel).toBe("email_link");
    expect(visit.confirmedAt).not.toBeNull();
  });

  it("applies reschedule via POST form", async () => {
    const res = await request(app)
      .post(`/api/confirm/${confirmationToken}`)
      .type("form")
      .send({ action: "reschedule" });
    expect(res.status).toBe(200);

    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: visitId } });
    expect(visit.confirmationStatus).toBe("reschedule_requested");
  });

  it("rejects unknown actions", async () => {
    const res = await request(app)
      .post(`/api/confirm/${confirmationToken}`)
      .type("form")
      .send({ action: "explode" });
    expect(res.status).toBe(400);
  });
});

describe("inbound SMS routing", () => {
  it("confirms the upcoming visit on a customer YES reply", async () => {
    await prisma.visit.update({ where: { id: visitId }, data: { confirmationStatus: "unconfirmed", confirmedAt: null } });

    const res = await request(app)
      .post("/sms/inbound")
      .type("form")
      .send({ From: CUSTOMER_PHONE, Body: "YES" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("xml");

    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: visitId } });
    expect(visit.confirmationStatus).toBe("confirmed");
    expect(visit.confirmationChannel).toBe("sms_reply");

    const logged = await prisma.inboundMessage.findFirst({
      where: { fromPhone: CUSTOMER_PHONE, handledAs: "confirmation_reply" },
    });
    expect(logged).not.toBeNull();
    expect(logged!.matchType).toBe("customer");
  });

  it("logs a tech text as a note on their active assignment", async () => {
    const res = await request(app)
      .post("/sms/inbound")
      .type("form")
      .send({ From: TECH_PHONE, Body: "Panel cover was rusted through, replaced hardware" });
    expect(res.status).toBe(200);

    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: visitId } });
    expect(visit.notes).toContain("rusted through");
    expect(visit.notes).toContain("Mesh Tech");

    const logged = await prisma.inboundMessage.findFirst({ where: { fromPhone: TECH_PHONE, handledAs: "tech_note" } });
    expect(logged).not.toBeNull();
  });

  it("forwards unknown-sender texts to Kyle", async () => {
    // Forwarding is gated OFF in production (no-Twilio-texts ruling 2026-08-13). The routing
    // logic this test pins — that an unrecognised number reaches Kyle rather than vanishing —
    // only runs on the enabled path, so the leg is opened here. The gated behaviour is the
    // test below it.
    process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS = "on";
    sendSmsMock.mockClear();
    const res = await request(app)
      .post("/sms/inbound")
      .type("form")
      .send({ From: "+15550009999", Body: "hey is this the electrician" });
    expect(res.status).toBe(200);

    expect(sendSmsMock).toHaveBeenCalledWith("+19706661626", expect.stringContaining("UNKNOWN SMS"));
    const logged = await prisma.inboundMessage.findFirst({ where: { fromPhone: "+15550009999" } });
    expect(logged!.matchType).toBe("unknown");
    delete process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS;
  });

  it("TWILIO GATE: an unknown-sender text is still received and logged, but not forwarded", async () => {
    // Inbound is deliberately NOT gated — receiving is not sending. The message must still be
    // parsed and written to InboundMessage; only the outbound forward is suppressed.
    delete process.env.TWILIO_SENDS_OPERATOR_NOTIFICATIONS;
    delete process.env.TWILIO_SENDS;
    sendSmsMock.mockClear();

    const res = await request(app)
      .post("/sms/inbound")
      .type("form")
      .send({ From: "+15550008888", Body: "gated inbound test" });
    expect(res.status).toBe(200);

    expect(sendSmsMock).not.toHaveBeenCalled();
    const logged = await prisma.inboundMessage.findFirst({ where: { fromPhone: "+15550008888" } });
    expect(logged).not.toBeNull();
    expect(logged!.matchType).toBe("unknown");
    expect(logged!.body).toBe("gated inbound test");
  });
});

describe("tech PWA job-site photos", () => {
  it("uploads a photo and serves it back to the CRM", async () => {
    const photoId = crypto.randomUUID();
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

    const up = await request(app)
      .put(`/health-record/visits/${visitId}/photos/${photoId}`)
      .set("Authorization", `Bearer ${TECH_TOKEN}`)
      .set("Content-Type", "image/png")
      .set("x-photo-caption", encodeURIComponent("Before — old panel"))
      .send(png);
    expect(up.status).toBe(201);

    // Idempotent retry
    const retry = await request(app)
      .put(`/health-record/visits/${visitId}/photos/${photoId}`)
      .set("Authorization", `Bearer ${TECH_TOKEN}`)
      .set("Content-Type", "image/png")
      .send(png);
    expect(retry.status).toBe(201);

    const photos = await prisma.visitPhoto.findMany({ where: { visitId } });
    expect(photos).toHaveLength(1);
    expect(photos[0].caption).toBe("Before — old panel");
    expect(photos[0].technicianId).toBe(technicianId);
  });

  it("rejects uploads without a tech token", async () => {
    const res = await request(app)
      .put(`/health-record/visits/${visitId}/photos/${crypto.randomUUID()}`)
      .set("Content-Type", "image/png")
      .send(Buffer.from("deadbeef", "hex"));
    expect(res.status).toBe(401);
  });
});

describe("tech PWA receipt capture", () => {
  it("stores a receipt in pending_review when vision is unavailable", async () => {
    const receiptId = crypto.randomUUID();
    const jpg = Buffer.from("ffd8ffe000104a464946", "hex");

    const res = await request(app)
      .put(`/health-record/receipts/${receiptId}?jobId=${visitId}&category=materials&vendor=Test%20Supply&amount=142.50`)
      .set("Authorization", `Bearer ${TECH_TOKEN}`)
      .set("Content-Type", "image/jpeg")
      .send(jpg);
    expect(res.status).toBe(201);
    expect(res.body.data.amount).toBe(142.5);
    expect(res.body.data.status).toBe("pending_review");

    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(receipt.source).toBe("tech_pwa");
    expect(receipt.technicianId).toBe(technicianId);
    expect(receipt.imageData).not.toBeNull();
  });

  it("rolls confirmed material receipts into the job's actualMaterialCost via admin review", async () => {
    const receipt = await prisma.receipt.findFirstOrThrow({ where: { technicianId, jobId: visitId } });

    // PIN auth is disabled in test mode (no PIN_HASH), so the admin router is
    // reachable — exercise the review flow: confirm the receipt and check the
    // material cost roll-up onto the job.
    const res = await request(app)
      .patch(`/health-record-admin/receipts/${receipt.id}`)
      .send({ status: "confirmed", amount: 150.0 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("confirmed");

    const visit = await prisma.visit.findUniqueOrThrow({ where: { id: visitId } });
    expect(visit.actualMaterialCost).toBe(150.0);
  });
});

describe("web lead auto-reply hook", () => {
  it("accepts a web lead and doesn't fail when email sending is unconfigured", async () => {
    const res = await request(app)
      .post("/leads")
      .set("webhook_secret", process.env.WEBHOOK_SECRET!)
      .send({ name: "Mesh Web Lead", email: "weblead@example.com", phone: "+16150001111", source: "web", jobType: "EV Charger" });
    expect(res.status).toBe(201);
  });
});
