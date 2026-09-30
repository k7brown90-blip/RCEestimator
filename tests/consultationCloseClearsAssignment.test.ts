import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

// Regression for the 2026-09-24 "Eric Ward" bug: closing a consultation from
// the CRM (POST /visits/:id/complete-consultation) left visit.status =
// "estimate" (deliberate — consultations archive, they don't become
// "completed jobs") but never touched VisitAssignment, so the tech's phone
// kept the card forever. Fix has two halves: the writer now also completes
// the assignment, and the reader (GET /health-record/assignments) now also
// excludes any visit with completedAt set.

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;

beforeAll(async () => {
  await prisma.technician.deleteMany({ where: { name: "Consult Close Test Tech" } });

  const customer = await prisma.customer.create({
    data: { name: "Consult Close Test Customer", phone: "615-555-0199" },
  });
  customerId = customer.id;

  const property = await prisma.property.create({
    data: {
      customerId,
      name: "Consult Close Test House",
      addressLine1: "144 Madison Mill Drive",
      city: "Murfreesboro",
      state: "TN",
      postalCode: "37127",
    },
  });
  propertyId = property.id;

  const visit = await prisma.visit.create({
    data: {
      propertyId,
      customerId,
      mode: "estimate",
      purpose: "Estimate consultation",
      status: "estimate",
      scheduledStart: new Date("2026-09-21T14:00:00Z"),
    },
  });
  visitId = visit.id;

  const techRes = await request(app)
    .post("/health-record-admin/technicians")
    .send({ name: "Consult Close Test Tech", role: "technician" })
    .expect(201);
  technicianId = techRes.body.id;
  techToken = techRes.body.accessToken;

  await request(app)
    .post(`/health-record-admin/visits/${visitId}/assign`)
    .send({ technicianId })
    .expect(201);
});

afterAll(async () => {
  await prisma.visitAssignment.deleteMany({ where: { visitId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await prisma.visit.deleteMany({ where: { id: visitId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
});

describe("closing a consultation clears the tech's phone", () => {
  it("shows up on the tech's assignment list before the consultation is closed", async () => {
    const res = await request(app)
      .get("/health-record/assignments")
      .set("Authorization", `Bearer ${techToken}`)
      .expect(200);
    const found = res.body.data.find((a: { visitId: string }) => a.visitId === visitId);
    expect(found).toBeDefined();
  });

  it("POST /visits/:id/complete-consultation completes the visit's assignment(s), not just the visit", async () => {
    await request(app)
      .post(`/visits/${visitId}/complete-consultation`)
      .expect(200);

    const visit = await prisma.visit.findUnique({ where: { id: visitId } });
    // Deliberate: consultations archive, they never become "completed" jobs.
    expect(visit?.status).toBe("estimate");
    expect(visit?.completedAt).not.toBeNull();

    const assignments = await prisma.visitAssignment.findMany({ where: { visitId } });
    expect(assignments.length).toBeGreaterThan(0);
    for (const a of assignments) {
      expect(a.status).toBe("completed");
      expect(["assigned", "in_progress"]).not.toContain(a.status);
    }
  });

  it("no longer appears on GET /health-record/assignments once completedAt is set", async () => {
    const res = await request(app)
      .get("/health-record/assignments")
      .set("Authorization", `Bearer ${techToken}`)
      .expect(200);
    const found = res.body.data.find((a: { visitId: string }) => a.visitId === visitId);
    expect(found).toBeUndefined();
  });

  it("the reader alone excludes a visit with completedAt set even if its assignment is still assigned/in_progress (the exact shape of the Eric Ward cards already stuck in production)", async () => {
    // Simulate data left behind by the old buggy writer: visit closed
    // (completedAt set, status still "estimate") but the assignment never
    // got touched. This isolates the health-record.ts reader fix from the
    // app.ts/server.ts writer fix above.
    const stuckVisit = await prisma.visit.create({
      data: {
        propertyId,
        customerId,
        mode: "estimate",
        purpose: "Estimate consultation — legacy stuck card",
        status: "estimate",
        completedAt: new Date(),
        scheduledStart: new Date("2026-09-23T14:00:00Z"),
      },
    });
    await prisma.visitAssignment.create({
      data: { visitId: stuckVisit.id, technicianId, status: "assigned" },
    });

    try {
      const res = await request(app)
        .get("/health-record/assignments")
        .set("Authorization", `Bearer ${techToken}`)
        .expect(200);
      const found = res.body.data.find((a: { visitId: string }) => a.visitId === stuckVisit.id);
      expect(found).toBeUndefined();
    } finally {
      await prisma.visitAssignment.deleteMany({ where: { visitId: stuckVisit.id } });
      await prisma.visit.delete({ where: { id: stuckVisit.id } });
    }
  });
});
