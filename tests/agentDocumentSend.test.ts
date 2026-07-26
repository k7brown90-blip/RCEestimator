/**
 * Voice-agent document delivery — the receptionist can re-send an existing
 * document PDF (contract, work order, health report, etc.) to a customer via
 * email, SMS, or both. Verifies the auth boundary, the recipient-resolution
 * logic, the delivery-service calls, and the sentAt stamp on success.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/prisma";

const TOKEN = process.env.AGENT_API_TOKEN ?? "test-agent-token";
process.env.AGENT_API_TOKEN = TOKEN;
process.env.GOOGLE_CLIENT_ID = "test_id";
process.env.GOOGLE_CLIENT_SECRET = "test_secret";
process.env.GOOGLE_REFRESH_TOKEN = "test_token";
process.env.GMAIL_USER = "service@example.com";

const sendSmsMock = vi.fn();
const sendDocumentEmailMock = vi.fn();
const generateHealthReportMock = vi.fn();

vi.mock("../src/services/twilio", () => ({
  sendSms: (...args: unknown[]) => sendSmsMock(...args),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/services/documentDelivery", async () => {
  const actual = await vi.importActual<typeof import("../src/services/documentDelivery")>(
    "../src/services/documentDelivery",
  );
  return {
    ...actual,
    sendDocumentEmail: (...args: unknown[]) => sendDocumentEmailMock(...args),
  };
});

vi.mock("../src/services/pdfGenerator", async () => {
  const actual = await vi.importActual<typeof import("../src/services/pdfGenerator")>(
    "../src/services/pdfGenerator",
  );
  return {
    ...actual,
    generateHealthReport: (...args: unknown[]) => generateHealthReportMock(...args),
  };
});

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

let customerId: string;
let propertyId: string;
let visitId: string;
let documentId: string;
let tempPdfPath: string;

beforeAll(async () => {
  // Real PDF file on disk so the delivery service (if not mocked) could attach it.
  tempPdfPath = path.join(process.cwd(), "generated", "documents", `test-doc-${Date.now()}.pdf`);
  fs.mkdirSync(path.dirname(tempPdfPath), { recursive: true });
  fs.writeFileSync(tempPdfPath, "%PDF-1.4\n%mock\n");

  const customer = await prisma.customer.create({
    data: {
      name: "DocSend Test Customer",
      email: "docsend@example.com",
      phone: "+16155551234",
    },
  });
  customerId = customer.id;

  const property = await prisma.property.create({
    data: {
      customerId,
      name: "DocSend House",
      addressLine1: "1 Test St",
      city: "Franklin",
      state: "TN",
      postalCode: "37064",
    },
  });
  propertyId = property.id;

  const visit = await prisma.visit.create({
    data: { customerId, propertyId, mode: "onsite", purpose: "DocSend test visit" },
  });
  visitId = visit.id;

  const doc = await prisma.document.create({
    data: {
      jobId: visitId,
      type: "contract",
      pdfUrl: tempPdfPath,
    },
  });
  documentId = doc.id;
});

afterAll(async () => {
  await prisma.document.deleteMany({ where: { jobId: visitId } });
  await prisma.visit.deleteMany({ where: { id: visitId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  if (fs.existsSync(tempPdfPath)) fs.unlinkSync(tempPdfPath);
});

beforeEach(async () => {
  sendSmsMock.mockReset();
  sendDocumentEmailMock.mockReset();
  generateHealthReportMock.mockReset();
  await prisma.agentIdempotency.deleteMany();
  await prisma.document.update({ where: { id: documentId }, data: { sentAt: null } });
});

describe("POST /agent/calendar/documents/send", () => {
  it("rejects requests without the agent bearer token", async () => {
    const res = await request(app)
      .post("/agent/calendar/documents/send")
      .send({ kind: "document", id: documentId, method: "email" });
    expect(res.status).toBe(401);
  });

  it("emails an existing document to the customer's on-file email and stamps sentAt", async () => {
    sendDocumentEmailMock.mockResolvedValue(true);

    const res = await request(app)
      .post("/agent/calendar/documents/send")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ kind: "document", id: documentId, method: "email" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.emailed).toBe(true);
    expect(res.body.data.sms_sent).toBe(false);
    expect(res.body.data.recipient_email).toBe("docsend@example.com");
    expect(sendDocumentEmailMock).toHaveBeenCalledTimes(1);
    const arg = sendDocumentEmailMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.to).toBe("docsend@example.com");
    expect(arg.docType).toBe("contract");

    const updated = await prisma.document.findUnique({ where: { id: documentId } });
    expect(updated?.sentAt).toBeTruthy();
  });

  it("uses an override email when provided instead of the on-file address", async () => {
    sendDocumentEmailMock.mockResolvedValue(true);

    const res = await request(app)
      .post("/agent/calendar/documents/send")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        kind: "document",
        id: documentId,
        method: "email",
        email: "override@example.com",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.recipient_email).toBe("override@example.com");
    const arg = sendDocumentEmailMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.to).toBe("override@example.com");
  });

  it("sends an SMS notification and skips email when method is 'sms'", async () => {
    sendSmsMock.mockResolvedValue({ sid: "SM_mock" });

    const res = await request(app)
      .post("/agent/calendar/documents/send")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ kind: "document", id: documentId, method: "sms" });

    expect(res.status).toBe(200);
    expect(res.body.data.sms_sent).toBe(true);
    expect(res.body.data.emailed).toBe(false);
    expect(sendDocumentEmailMock).not.toHaveBeenCalled();
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    expect(sendSmsMock.mock.calls[0][0]).toBe("+16155551234");
  });

  it("returns 404 when the referenced document does not exist", async () => {
    const res = await request(app)
      .post("/agent/calendar/documents/send")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ kind: "document", id: "nonexistent-id", method: "email" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.spoken_confirmation).toBeTruthy();
  });

  it("returns 400 with a spoken fallback when email is requested but none is on file", async () => {
    await prisma.customer.update({ where: { id: customerId }, data: { email: null } });

    const res = await request(app)
      .post("/agent/calendar/documents/send")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ kind: "document", id: documentId, method: "email" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("NO_EMAIL");
    expect(res.body.spoken_confirmation).toMatch(/email/i);

    // Restore for other tests
    await prisma.customer.update({
      where: { id: customerId },
      data: { email: "docsend@example.com" },
    });
  });

  it("regenerates a health report PDF and delivers it via email", async () => {
    // Create a live HealthInspection so the endpoint has a real record to key off.
    const inspectionId = `insp-${Date.now()}`;
    const generatedPath = path.join(
      process.cwd(),
      "generated",
      "documents",
      `health-report-${inspectionId}.pdf`,
    );
    fs.writeFileSync(generatedPath, "%PDF-1.4\n%mock\n");

    await prisma.healthInspection.create({
      data: {
        id: inspectionId,
        visitId,
        propertyId,
        customerId,
        jurisdictionId: "TN-DEFAULT",
        inspectionDate: new Date(),
        score: 82,
        itemsAssessed: 30,
        criticalFindingsJson: JSON.stringify([]),
        itemsJson: JSON.stringify([]),
      },
    });

    generateHealthReportMock.mockResolvedValue({
      documentId: `doc-${inspectionId}`,
      pdfPath: generatedPath,
    });
    sendDocumentEmailMock.mockResolvedValue(true);

    const res = await request(app)
      .post("/agent/calendar/documents/send")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ kind: "health_report", id: inspectionId, method: "email" });

    expect(res.status).toBe(200);
    expect(res.body.data.doc_type).toBe("health_report");
    expect(generateHealthReportMock).toHaveBeenCalledWith(inspectionId);
    const arg = sendDocumentEmailMock.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.docType).toBe("health_report");
    expect(arg.pdfPath).toBe(generatedPath);

    // Cleanup
    await prisma.healthInspection.delete({ where: { id: inspectionId } });
    if (fs.existsSync(generatedPath)) fs.unlinkSync(generatedPath);
  });

  it("returns 502 with a graceful spoken fallback when all delivery methods fail", async () => {
    sendDocumentEmailMock.mockResolvedValue(false);

    const res = await request(app)
      .post("/agent/calendar/documents/send")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ kind: "document", id: documentId, method: "email" });

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("DELIVERY_FAILED");
    expect(res.body.spoken_confirmation).toMatch(/flag it for Kyle/i);
  });

  it("honors x-client-request-id for idempotent replay", async () => {
    sendDocumentEmailMock.mockResolvedValue(true);
    const requestId = `req-${Date.now()}`;

    const first = await request(app)
      .post("/agent/calendar/documents/send")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("x-client-request-id", requestId)
      .send({ kind: "document", id: documentId, method: "email" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post("/agent/calendar/documents/send")
      .set("Authorization", `Bearer ${TOKEN}`)
      .set("x-client-request-id", requestId)
      .send({ kind: "document", id: documentId, method: "email" });
    expect(second.status).toBe(200);

    // Delivery service should only have been called once — the second was replayed from cache.
    expect(sendDocumentEmailMock).toHaveBeenCalledTimes(1);
  });
});
