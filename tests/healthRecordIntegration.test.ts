import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

// End-to-end loop: admin creates technician → assigns a visit → tech pulls
// assignments with bearer token → tech pushes a completed inspection → record
// lands on the customer's account, assignment closes, critical finding surfaces.

let customerId: string;
let propertyId: string;
let visitId: string;
let technicianId: string;
let techToken: string;

const INSPECTION_ID = "hr-test-inspection-0001";

// The exact payload the PWA would queue offline — retries replay this verbatim.
const inspectionPayload = () => ({
  inspectionId: INSPECTION_ID,
  visitId,
  jurisdictionId: "murfreesboro",
  inspectionDate: "2026-08-01T15:30:00Z",
  score: 69,
  itemsAssessed: 28,
  criticalFindings: ["C4"],
  contractorReviewed: true,
  items: [{ itemId: "C4", result: "ACTION", measured: { bus_config: "separated" }, photoIds: [] }],
  loadCalc: { input: { serviceAmps: 200 }, result: { governingAmps: 109 } },
  appVersion: "1.0.0",
});

beforeAll(async () => {
  // Clean any residue from prior runs (idempotent test setup).
  await prisma.healthInspection.deleteMany({ where: { id: INSPECTION_ID } });
  await prisma.technician.deleteMany({ where: { name: "HR Test Tech" } });

  const customer = await prisma.customer.create({
    data: { name: "HR Test Customer", phone: "615-555-0100" },
  });
  customerId = customer.id;

  const property = await prisma.property.create({
    data: {
      customerId,
      name: "HR Test House",
      addressLine1: "123 Integration Way",
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
      mode: "diagnostic",
      purpose: "Electrical health inspection",
      status: "scheduled",
      scheduledStart: new Date("2026-08-01T14:00:00Z"),
    },
  });
  visitId = visit.id;
});

afterAll(async () => {
  await prisma.finding.deleteMany({ where: { visitId } });
  await prisma.healthInspection.deleteMany({ where: { customerId } });
  await prisma.visitAssignment.deleteMany({ where: { visitId } });
  await prisma.technician.deleteMany({ where: { id: technicianId } });
  await prisma.visit.deleteMany({ where: { id: visitId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
});

describe("health record CRM integration", () => {
  it("admin creates a technician and receives an access token", async () => {
    const res = await request(app)
      .post("/health-record-admin/technicians")
      .send({ name: "HR Test Tech", role: "technician" })
      .expect(201);
    technicianId = res.body.id;
    techToken = res.body.accessToken;
    expect(techToken).toBeTruthy();
    expect(res.body.isActive).toBe(true);
  });

  it("admin assigns the visit to the technician (idempotent upsert)", async () => {
    const res = await request(app)
      .post(`/health-record-admin/visits/${visitId}/assign`)
      .send({ technicianId })
      .expect(201);
    expect(res.body.status).toBe("assigned");

    // Re-assign does not duplicate (unique visitId+technicianId).
    await request(app)
      .post(`/health-record-admin/visits/${visitId}/assign`)
      .send({ technicianId })
      .expect(201);
    const assignments = await prisma.visitAssignment.findMany({ where: { visitId } });
    expect(assignments.length).toBe(1);
  });

  it("rejects tech endpoints without a valid bearer token", async () => {
    await request(app).get("/health-record/assignments").expect(401);
    await request(app)
      .get("/health-record/assignments")
      .set("Authorization", "Bearer not-a-real-token")
      .expect(401);
  });

  it("technician pulls assignments with property/customer context", async () => {
    const res = await request(app)
      .get("/health-record/assignments")
      .set("Authorization", `Bearer ${techToken}`)
      .expect(200);
    const assignment = res.body.data.find((a: { visitId: string }) => a.visitId === visitId);
    expect(assignment).toBeDefined();
    expect(assignment.customerId).toBe(customerId);
    expect(assignment.propertyId).toBe(propertyId);
    // Address is structured rather than a single string, so the PWA can render
    // the parts without re-parsing what the server already had split apart.
    expect(assignment.address.line1).toBe("123 Integration Way");
    expect(assignment.address.city).toBe("Murfreesboro");
    expect(assignment.address.formatted).toContain("123 Integration Way");
    // Jurisdiction is resolved by the office, never guessed on the phone.
    expect(assignment.jurisdictionId).toBe("murfreesboro");
    expect(assignment.jurisdictionSource).toBe("city");
  });

  it("technician pushes a completed inspection — saved to the customer account", async () => {
    const res = await request(app)
      .post("/health-record/inspections")
      .set("Authorization", `Bearer ${techToken}`)
      .send(inspectionPayload())
      .expect(201);
    expect(res.body.data.id).toBe(INSPECTION_ID);

    const stored = await prisma.healthInspection.findUnique({ where: { id: INSPECTION_ID } });
    expect(stored?.customerId).toBe(customerId);
    expect(stored?.propertyId).toBe(propertyId);
    expect(stored?.technicianId).toBe(technicianId);
    expect(stored?.score).toBe(69);
    // A payload carrying a score is a v1 record and stays labelled as one, so
    // the PDF reproduces the report that was actually delivered.
    expect(stored?.schemaVersion).toBe("v1");
    expect(JSON.parse(stored!.criticalFindingsJson)).toEqual(["C4"]);
    expect(JSON.parse(stored!.loadCalcJson!).result.governingAmps).toBe(109);

    // Assignment auto-closed.
    const assignment = await prisma.visitAssignment.findFirst({ where: { visitId, technicianId } });
    expect(assignment?.status).toBe("completed");
    expect(assignment?.completedAt).not.toBeNull();

    // Critical finding surfaced into the visit's Finding chain.
    const findings = await prisma.finding.findMany({ where: { visitId } });
    expect(findings.length).toBe(1);
    expect(findings[0].findingText).toContain("C4");
  });

  it("accepts a v2 findings-led push with no score", async () => {
    const res = await request(app)
      .post("/health-record/inspections")
      .set("Authorization", `Bearer ${techToken}`)
      .send({
        ...inspectionPayload(),
        inspectionId: "hr-test-inspection-v2",
        score: undefined,
        schemaVersion: "v2",
        scope: "phase1",
        failCount: 2,
        monitorCount: 1,
        passCount: 16,
        belowStandardCount: 0,
        naCount: 1,
      })
      .expect(201);
    expect(res.body.data.id).toBe("hr-test-inspection-v2");

    const stored = await prisma.healthInspection.findUnique({
      where: { id: "hr-test-inspection-v2" },
    });
    expect(stored?.score).toBeNull();
    expect(stored?.schemaVersion).toBe("v2");
    expect(stored?.scope).toBe("phase1");
    expect(stored?.failCount).toBe(2);
    expect(stored?.monitorCount).toBe(1);
    expect(stored?.passCount).toBe(16);
    expect(stored?.naCount).toBe(1);

    // This suite shares state across blocks; later tests count inspections and
    // findings. Each distinct inspection id mints its own tagged Finding.
    await prisma.healthInspection.delete({ where: { id: "hr-test-inspection-v2" } });
    await prisma.finding.deleteMany({ where: { findingText: { contains: "hr-test-inspection-v2" } } });
  });

  it("accepts a v3 consolidated-walk push, sub-panel instance rows included", async () => {
    const res = await request(app)
      .post("/health-record/inspections")
      .set("Authorization", `Bearer ${techToken}`)
      .send({
        ...inspectionPayload(),
        inspectionId: "hr-test-inspection-v3",
        score: undefined,
        schemaVersion: "v3",
        scope: "full",
        criticalFindings: ["SUB:garage"],
        failCount: 1,
        monitorCount: 0,
        passCount: 7,
        belowStandardCount: 0,
        naCount: 0,
        items: [
          { itemId: "MAIN", result: "PASS", measured: {}, photoIds: [] },
          {
            itemId: "SUB:garage",
            result: "FAIL",
            locationId: "Garage",
            measured: { neutral_ground: "bonded_error" },
            photoIds: [],
            resolutionNote: "Separate neutrals and grounds; remove bonding screw.",
          },
        ],
      })
      .expect(201);
    expect(res.body.data.id).toBe("hr-test-inspection-v3");

    const stored = await prisma.healthInspection.findUnique({
      where: { id: "hr-test-inspection-v3" },
    });
    expect(stored?.schemaVersion).toBe("v3");
    // The instance row keeps its location label — the PDF names it
    // "Interior panel / sub-panel — Garage" from exactly this field.
    const items = JSON.parse(stored!.itemsJson) as { itemId: string; locationId?: string }[];
    expect(items.find((row) => row.itemId === "SUB:garage")?.locationId).toBe("Garage");
    expect(JSON.parse(stored!.criticalFindingsJson)).toEqual(["SUB:garage"]);

    await prisma.healthInspection.delete({ where: { id: "hr-test-inspection-v3" } });
    await prisma.finding.deleteMany({ where: { findingText: { contains: "hr-test-inspection-v3" } } });
  });

  it("still accepts a v1 payload from a phone running a stale service worker", async () => {
    // Rejecting the old shape would silently lose inspections already queued on
    // a technician's device.
    await request(app)
      .post("/health-record/inspections")
      .set("Authorization", `Bearer ${techToken}`)
      .send({ ...inspectionPayload(), inspectionId: "hr-test-inspection-legacy", score: 82 })
      .expect(201);

    const stored = await prisma.healthInspection.findUnique({
      where: { id: "hr-test-inspection-legacy" },
    });
    expect(stored?.score).toBe(82);
    expect(stored?.schemaVersion).toBe("v1");
    expect(stored?.scope).toBe("full");

    await prisma.healthInspection.delete({ where: { id: "hr-test-inspection-legacy" } });
    await prisma.finding.deleteMany({ where: { findingText: { contains: "hr-test-inspection-legacy" } } });
  });

  it("no longer writes the capped-score language into the finding chain", async () => {
    await request(app)
      .post("/health-record/inspections")
      .set("Authorization", `Bearer ${techToken}`)
      .send(inspectionPayload())
      .expect(201);

    const findings = await prisma.finding.findMany({ where: { visitId } });
    expect(findings[0].findingText).not.toContain("capped");
    expect(findings[0].findingText).toContain("contractor review required");
  });

  it("push is idempotent — offline-queue retry replays the identical payload without duplicating", async () => {
    await request(app)
      .post("/health-record/inspections")
      .set("Authorization", `Bearer ${techToken}`)
      .send(inspectionPayload())
      .expect(201);

    expect(await prisma.healthInspection.count({ where: { id: INSPECTION_ID } })).toBe(1);
    expect(await prisma.finding.count({ where: { visitId } })).toBe(1);
    // Full payload preserved through the retry.
    const stored = await prisma.healthInspection.findUnique({ where: { id: INSPECTION_ID } });
    expect(JSON.parse(stored!.loadCalcJson!).result.governingAmps).toBe(109);
  });

  it("admin reads the inspection history on the customer account", async () => {
    const res = await request(app)
      .get(`/health-record-admin/customers/${customerId}/inspections`)
      .expect(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].id).toBe(INSPECTION_ID);
    expect(res.body[0].score).toBe(69);
    expect(res.body[0].technician.name).toBe("HR Test Tech");

    const detail = await request(app)
      .get(`/health-record-admin/inspections/${INSPECTION_ID}`)
      .expect(200);
    expect(detail.body.loadCalcJson).toBeTruthy();
  });

  it("rejects an inspection push for a nonexistent visit", async () => {
    await request(app)
      .post("/health-record/inspections")
      .set("Authorization", `Bearer ${techToken}`)
      .send({
        inspectionId: "hr-test-inspection-0002",
        visitId: "no-such-visit",
        jurisdictionId: "murfreesboro",
        inspectionDate: "2026-08-01T15:30:00Z",
        score: 100,
        itemsAssessed: 28,
        criticalFindings: [],
        contractorReviewed: false,
        items: [],
      })
      .expect(404);
  });

  it("uploads photo evidence idempotently and serves it back to the admin", async () => {
    const photoBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]); // JPEG-ish stub
    const photoId = "hr-test-photo-0001";

    // Photo for an unknown inspection is rejected (must push inspection first).
    await request(app)
      .put(`/health-record/inspections/no-such-inspection/photos/${photoId}`)
      .set("Authorization", `Bearer ${techToken}`)
      .set("Content-Type", "image/jpeg")
      .send(photoBytes)
      .expect(404);

    // Upload against the synced inspection succeeds; retry is idempotent.
    for (let i = 0; i < 2; i += 1) {
      const res = await request(app)
        .put(`/health-record/inspections/${INSPECTION_ID}/photos/${photoId}`)
        .set("Authorization", `Bearer ${techToken}`)
        .set("Content-Type", "image/jpeg")
        .send(photoBytes)
        .expect(201);
      expect(res.body.data.sizeBytes).toBe(photoBytes.length);
    }
    expect(await prisma.inspectionPhoto.count({ where: { inspectionId: INSPECTION_ID } })).toBe(1);

    // Admin detail lists the photo metadata; bytes endpoint round-trips exactly.
    const detail = await request(app)
      .get(`/health-record-admin/inspections/${INSPECTION_ID}`)
      .expect(200);
    expect(detail.body.photos.length).toBe(1);
    expect(detail.body.photos[0].id).toBe(photoId);

    const image = await request(app)
      .get(`/health-record-admin/photos/${photoId}`)
      .expect(200)
      .expect("Content-Type", /image\/jpeg/);
    expect(Buffer.compare(image.body as Buffer, photoBytes)).toBe(0);
  });

  it("renders the inspection into the customer's document chain as a PDF", async () => {
    const res = await request(app)
      .post(`/health-record-admin/inspections/${INSPECTION_ID}/report`)
      .send({})
      .expect(201);
    expect(res.body.documentId).toBeTruthy();

    const document = await prisma.document.findUnique({ where: { id: res.body.documentId } });
    expect(document?.type).toBe("health_report");
    expect(document?.jobId).toBe(visitId);

    const fs = await import("node:fs");
    expect(fs.existsSync(res.body.pdfPath)).toBe(true);
    expect(fs.statSync(res.body.pdfPath).size).toBeGreaterThan(1000);

    await prisma.document.delete({ where: { id: res.body.documentId } });
    fs.unlinkSync(res.body.pdfPath);

    // Unknown inspection → 404
    await request(app)
      .post("/health-record-admin/inspections/no-such/report")
      .send({})
      .expect(404);
  });

  it("deactivating a technician invalidates their token", async () => {
    await request(app)
      .patch(`/health-record-admin/technicians/${technicianId}`)
      .send({ isActive: false })
      .expect(200);
    await request(app)
      .get("/health-record/assignments")
      .set("Authorization", `Bearer ${techToken}`)
      .expect(401);
    // Reactivate for cleanup consistency.
    await request(app)
      .patch(`/health-record-admin/technicians/${technicianId}`)
      .send({ isActive: true })
      .expect(200);
  });
});
