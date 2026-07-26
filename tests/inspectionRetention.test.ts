/**
 * Tier 3 — retention loop: contractor review action + annual-inspection
 * renewal lead generation.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { generateInspectionRenewalLeads, RENEWAL_MONTHS } from "../src/services/inspectionRetention";

let customerId: string;
let propertyId: string;
let visitId: string;

function monthsAgo(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

async function createInspection(id: string, inspectionDate: Date, propId = propertyId) {
  return prisma.healthInspection.create({
    data: {
      id,
      visitId,
      propertyId: propId,
      customerId,
      jurisdictionId: "murfreesboro",
      inspectionDate,
      score: 88,
      itemsAssessed: 28,
      criticalFindingsJson: "[]",
      contractorReviewed: false,
      itemsJson: "[]",
    },
  });
}

async function cleanup() {
  await prisma.lead.deleteMany({ where: { OR: [{ name: "T3 Retention Customer" }, { notes: { contains: "[InspectionRenewal t3-" } }] } });
  await prisma.healthInspection.deleteMany({ where: { id: { startsWith: "t3-" } } });
}

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await prisma.visit.deleteMany({ where: { id: visitId } });
  await prisma.property.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
});

// Shared fixtures
beforeEach(async () => {
  if (customerId) return;
  const customer = await prisma.customer.create({
    data: { name: "T3 Retention Customer", phone: "+16155550190", email: "t3@example.com" },
  });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: {
      customerId, name: "T3 House", addressLine1: "9 Renewal Rd",
      city: "Murfreesboro", state: "TN", postalCode: "37127",
    },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { propertyId, customerId, mode: "diagnostic", purpose: "T3 retention test" },
  });
  visitId = visit.id;
});

describe("contractor review action", () => {
  it("records reviewer and timestamp", async () => {
    await createInspection("t3-review-1", monthsAgo(1));
    const res = await request(app)
      .post("/health-record-admin/inspections/t3-review-1/review")
      .send({ reviewedBy: "Kyle" })
      .expect(200);
    expect(res.body.contractorReviewed).toBe(true);
    expect(res.body.reviewedBy).toBe("Kyle");
    expect(res.body.reviewedAt).toBeTruthy();
  });

  it("404s for an unknown inspection and validates the reviewer", async () => {
    await request(app)
      .post("/health-record-admin/inspections/no-such/review")
      .send({ reviewedBy: "Kyle" })
      .expect(404);
    await createInspection("t3-review-2", monthsAgo(1));
    await request(app)
      .post("/health-record-admin/inspections/t3-review-2/review")
      .send({})
      .expect(422);
  });
});

describe("annual-inspection retention sweep", () => {
  it("creates a renewal lead for a property whose latest inspection is past the window", async () => {
    await createInspection("t3-old-1", monthsAgo(RENEWAL_MONTHS + 1));
    const result = await generateInspectionRenewalLeads();
    expect(result.created).toBe(1);

    const lead = await prisma.lead.findFirst({ where: { notes: { contains: "[InspectionRenewal t3-old-1]" } } });
    expect(lead).not.toBeNull();
    expect(lead?.customerId).toBe(customerId);
    expect(lead?.propertyId).toBe(propertyId);
    expect(lead?.source).toBe("retention");
    expect(lead?.jobType).toBe("Annual electrical health inspection");
    expect(lead?.leadStatus).toBe("new");
    expect(lead?.followUpDate).not.toBeNull();
    expect(lead?.notes).toContain("9 Renewal Rd");
  });

  it("is idempotent — a second sweep creates nothing new", async () => {
    await createInspection("t3-old-2", monthsAgo(RENEWAL_MONTHS + 2));
    await generateInspectionRenewalLeads();
    const second = await generateInspectionRenewalLeads();
    expect(second.created).toBe(0);
    expect(await prisma.lead.count({ where: { notes: { contains: "[InspectionRenewal t3-old-2]" } } })).toBe(1);
  });

  it("skips properties with a recent inspection", async () => {
    await createInspection("t3-recent-1", monthsAgo(2));
    const result = await generateInspectionRenewalLeads();
    expect(result.checked).toBe(0);
    expect(result.created).toBe(0);
  });

  it("a re-inspection resets the clock — only the latest inspection counts", async () => {
    await createInspection("t3-old-3", monthsAgo(RENEWAL_MONTHS + 6));
    await createInspection("t3-new-3", monthsAgo(1)); // same property, renewed
    const result = await generateInspectionRenewalLeads();
    expect(result.checked).toBe(0);
    expect(result.created).toBe(0);
    expect(await prisma.lead.count({ where: { notes: { contains: "[InspectionRenewal t3-old-3]" } } })).toBe(0);
  });

  it("the admin manual trigger runs the sweep", async () => {
    await createInspection("t3-old-4", monthsAgo(RENEWAL_MONTHS + 3));
    const res = await request(app)
      .post("/health-record-admin/retention/run")
      .send({})
      .expect(200);
    expect(res.body.created).toBe(1);
  });
});
