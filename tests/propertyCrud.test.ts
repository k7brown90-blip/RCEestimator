import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/services/twilio");
vi.mock("googleapis");

import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

/**
 * Addresses: creating, editing, moving and — carefully — deleting.
 *
 * The delete guard is the point. `PropertyFinding` and `Document` cascade from
 * Property, so deleting an address silently destroyed the defect ledger and any
 * cure certificates issued against it. Those are the legal record. The old check
 * only looked at visits.
 */

const TAG = "PC Test";

async function wipe() {
  const customers = await prisma.customer.findMany({
    where: { name: { startsWith: TAG } }, select: { id: true },
  });
  const ids = customers.map((c) => c.id);
  if (ids.length === 0) return;
  const properties = await prisma.property.findMany({
    where: { customerId: { in: ids } }, select: { id: true },
  });
  const propertyIds = properties.map((p) => p.id);

  await prisma.capacityCheck.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyFinding.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.document.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.healthInspection.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.visit.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.systemSnapshot.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.customer.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(wipe);
afterAll(wipe);

const address = (customerId: string, overrides: Record<string, unknown> = {}) => ({
  customerId,
  name: "Main House",
  addressLine1: "100 Cedar Ln",
  city: "Murfreesboro",
  state: "TN",
  postalCode: "37130",
  ...overrides,
});

const makeCustomer = (suffix: string) =>
  prisma.customer.create({ data: { name: `${TAG} ${suffix}` } });

describe("POST /properties", () => {
  it("accepts the fields the account form used to drop", async () => {
    const customer = await makeCustomer("Create");
    const res = await request(app)
      .post("/properties")
      .send(address(customer.id, {
        addressLine2: "Unit B",
        notes: "Gate code 1234",
        occupancyType: "commercial",
        jurisdictionId: "murfreesboro",
      }))
      .expect(201);

    expect(res.body.addressLine2).toBe("Unit B");
    expect(res.body.notes).toBe("Gate code 1234");
    expect(res.body.occupancyType).toBe("commercial");
    // Without a write path, jurisdictionResolver's documented "explicit office
    // override" step was dead code.
    expect(res.body.jurisdictionId).toBe("murfreesboro");
  });

  it("defaults occupancy to residential and leaves the jurisdiction to be derived", async () => {
    const customer = await makeCustomer("Defaults");
    const res = await request(app).post("/properties").send(address(customer.id)).expect(201);
    expect(res.body.occupancyType).toBe("residential");
    expect(res.body.jurisdictionId).toBeNull();
  });

  it("rejects a jurisdiction the field app doesn't know", async () => {
    const customer = await makeCustomer("BadJurisdiction");
    await request(app)
      .post("/properties")
      .send(address(customer.id, { jurisdictionId: "atlantis" }))
      .expect(400);
  });

  it("seeds the system snapshot", async () => {
    const customer = await makeCustomer("Snapshot");
    const res = await request(app).post("/properties").send(address(customer.id)).expect(201);
    const snapshot = await prisma.systemSnapshot.findUniqueOrThrow({ where: { propertyId: res.body.id } });
    expect(snapshot.deficienciesJson).toBe("[]");
  });
});

describe("PATCH /properties/:propertyId", () => {
  it("moves an address to another account when it has no history", async () => {
    const from = await makeCustomer("MoveFrom");
    const to = await makeCustomer("MoveTo");
    const created = await request(app).post("/properties").send(address(from.id)).expect(201);

    const res = await request(app)
      .patch(`/properties/${created.body.id}`)
      .send({ customerId: to.id })
      .expect(200);
    expect(res.body.customerId).toBe(to.id);
  });

  it("refuses to move an address that already has job history", async () => {
    // Visit.customerId is denormalized alongside Visit.propertyId, so moving the
    // address alone would leave every past job pointing at the old account.
    const from = await makeCustomer("HistFrom");
    const to = await makeCustomer("HistTo");
    const created = await request(app).post("/properties").send(address(from.id)).expect(201);
    await prisma.visit.create({
      data: { propertyId: created.body.id, customerId: from.id, mode: "service_diagnostic" },
    });

    await request(app)
      .patch(`/properties/${created.body.id}`)
      .send({ customerId: to.id })
      .expect(409)
      .expect((res) => expect(res.body.error).toMatch(/job history/));
  });

  it("still allows ordinary edits on an address with history", async () => {
    const customer = await makeCustomer("EditWithHistory");
    const created = await request(app).post("/properties").send(address(customer.id)).expect(201);
    await prisma.visit.create({
      data: { propertyId: created.body.id, customerId: customer.id, mode: "service_diagnostic" },
    });

    const res = await request(app)
      .patch(`/properties/${created.body.id}`)
      .send({ addressLine2: "Rear unit", jurisdictionId: "franklin" })
      .expect(200);
    expect(res.body.addressLine2).toBe("Rear unit");
    expect(res.body.jurisdictionId).toBe("franklin");
  });
});

describe("DELETE /properties/:propertyId", () => {
  it("deletes a clean address and its snapshot", async () => {
    const customer = await makeCustomer("CleanDelete");
    const created = await request(app).post("/properties").send(address(customer.id)).expect(201);

    await request(app).delete(`/properties/${created.body.id}`).expect(204);
    expect(await prisma.systemSnapshot.count({ where: { propertyId: created.body.id } })).toBe(0);
  });

  it("refuses when there are visits", async () => {
    const customer = await makeCustomer("VisitBlock");
    const created = await request(app).post("/properties").send(address(customer.id)).expect(201);
    await prisma.visit.create({
      data: { propertyId: created.body.id, customerId: customer.id, mode: "service_diagnostic" },
    });
    await request(app).delete(`/properties/${created.body.id}`).expect(409);
  });

  it("refuses when there are findings, and the findings survive", async () => {
    // The important one: PropertyFinding cascades, so before this guard the
    // delete succeeded and took the defect ledger with it.
    const customer = await makeCustomer("FindingBlock");
    const created = await request(app).post("/properties").send(address(customer.id)).expect(201);
    const finding = await prisma.propertyFinding.create({
      data: {
        propertyId: created.body.id,
        customerId: customer.id,
        itemId: "C4",
        track: "defect",
        title: "Main bonding jumper",
        citationsJson: JSON.stringify(["250.24(B)"]),
        jurisdictionId: "murfreesboro",
        severity: "FAIL",
        findingText: "Bars separated with no bonding conductor.",
        openedInspectionId: "pc-test-insp",
        openedVisitId: "pc-test-visit",
        openedAt: new Date(),
      },
    });

    const res = await request(app).delete(`/properties/${created.body.id}`).expect(409);
    expect(res.body.error).toMatch(/finding/);
    expect(await prisma.propertyFinding.findUnique({ where: { id: finding.id } })).not.toBeNull();
  });

  it("refuses when there is a document, and names it in the message", async () => {
    const customer = await makeCustomer("DocBlock");
    const created = await request(app).post("/properties").send(address(customer.id)).expect(201);
    await prisma.document.create({
      data: { propertyId: created.body.id, type: "cure_certificate", pdfUrl: "/tmp/pc-test.pdf" },
    });

    const res = await request(app).delete(`/properties/${created.body.id}`).expect(409);
    expect(res.body.blockers.some((b: string) => b.includes("document"))).toBe(true);
  });

  it("refuses when there is a capacity calculation", async () => {
    // CapacityCheck.propertyId has no relation at all, so these would orphan.
    const customer = await makeCustomer("CapacityBlock");
    const created = await request(app).post("/properties").send(address(customer.id)).expect(201);
    await prisma.capacityCheck.create({
      data: {
        id: "pc-test-capacity",
        propertyId: created.body.id,
        customerId: customer.id,
        method: "220.83",
        serviceAmps: 100,
        calculatedAmps: 88,
        loadPct: 88,
        fits: true,
        inputJson: "{}",
        resultJson: "{}",
      },
    });

    await request(app).delete(`/properties/${created.body.id}`).expect(409);
  });
});
