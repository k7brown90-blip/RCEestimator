/**
 * Customer / account deletion — a stub visit from lead conversion shouldn't
 * pin a test account forever, but any real work (estimate, photo, order,
 * inspection, scheduled or completed job) still refuses the delete.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { prisma } from "../src/lib/prisma";

vi.mock("../src/services/twilio", () => ({
  sendSms: vi.fn().mockResolvedValue({ sid: "SM_mock" }),
  KYLE_PHONE: "+19706661626",
  isFromKyle: vi.fn().mockReturnValue(false),
}));
vi.mock("googleapis", () => ({
  google: {
    auth: { OAuth2: class { setCredentials() {} } },
    calendar: () => ({ freebusy: { query: vi.fn().mockResolvedValue({ data: { calendars: {} } }) } }),
  },
}));

import { app } from "../src/app";

const TAG = "AcctDel";

async function makeCustomerWithProperty(name: string) {
  const customer = await prisma.customer.create({
    data: {
      name: `${TAG} ${name}`,
      phone: "+16155550123",
      properties: {
        create: {
          name: "Home",
          addressLine1: "1 Delete Test Ln",
          city: "La Vergne",
          state: "TN",
          postalCode: "37086",
        },
      },
    },
    include: { properties: true },
  });
  return { customer, property: customer.properties[0]! };
}

beforeEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await cleanup();
});

async function cleanup() {
  // Manual cascade — Property.customer is Restrict, so we can't just deleteMany
  // Customer with test rows left over from a refused delete.
  await prisma.lead.deleteMany({ where: { name: { startsWith: TAG } } });
  const tagged = await prisma.customer.findMany({
    where: { name: { startsWith: TAG } },
    select: { id: true },
  });
  const ids = tagged.map((c) => c.id);
  if (ids.length === 0) return;
  const visits = await prisma.visit.findMany({
    where: { customerId: { in: ids } },
    select: { id: true },
  });
  await prisma.estimate.deleteMany({ where: { visitId: { in: visits.map((v) => v.id) } } });
  await prisma.visit.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.property.deleteMany({ where: { customerId: { in: ids } } });
  await prisma.customer.deleteMany({ where: { id: { in: ids } } });
}

describe("DELETE /accounts/:id", () => {
  it("deletes an account with no visits", async () => {
    const { customer } = await makeCustomerWithProperty("Empty");
    await request(app).delete(`/accounts/${customer.id}`).expect(204);
    expect(await prisma.customer.findUnique({ where: { id: customer.id } })).toBeNull();
  });

  it("deletes a test account whose only visit is an unscheduled estimate stub", async () => {
    // The exact shape a lead conversion produces: Customer + Property + Visit
    // at status="estimate", no scheduledStart, no estimates, no photos.
    // This was the bug — an empty stub visit was treated as "job history".
    const { customer, property } = await makeCustomerWithProperty("Stub");
    const visit = await prisma.visit.create({
      data: { customerId: customer.id, propertyId: property.id, mode: "in_person" },
    });
    // A pointer from a Lead should be nulled but the Lead should survive.
    const lead = await prisma.lead.create({
      data: {
        name: `${TAG} Stub-Lead`, source: "phone", status: "converted",
        customerId: customer.id, propertyId: property.id, visitId: visit.id,
      },
    });

    await request(app).delete(`/accounts/${customer.id}`).expect(204);

    expect(await prisma.customer.findUnique({ where: { id: customer.id } })).toBeNull();
    expect(await prisma.property.findUnique({ where: { id: property.id } })).toBeNull();
    expect(await prisma.visit.findUnique({ where: { id: visit.id } })).toBeNull();

    const refreshedLead = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(refreshedLead).not.toBeNull();
    expect(refreshedLead?.customerId).toBeNull();
    expect(refreshedLead?.propertyId).toBeNull();
    expect(refreshedLead?.visitId).toBeNull();
    expect(refreshedLead?.status).toBe("new");
  });

  it("refuses when a visit has been scheduled", async () => {
    const { customer, property } = await makeCustomerWithProperty("Scheduled");
    await prisma.visit.create({
      data: {
        customerId: customer.id, propertyId: property.id, mode: "in_person",
        scheduledStart: new Date("2026-09-01T14:00:00Z"),
      },
    });

    const res = await request(app).delete(`/accounts/${customer.id}`).expect(409);
    expect(res.body.hasRealHistory).toBe(true);
    expect(res.body.message).toContain("scheduled appointment");
    expect(await prisma.customer.findUnique({ where: { id: customer.id } })).not.toBeNull();
  });

  it("refuses when a visit has past 'estimate' status (contracted, in_progress, completed)", async () => {
    const { customer, property } = await makeCustomerWithProperty("Contracted");
    await prisma.visit.create({
      data: { customerId: customer.id, propertyId: property.id, mode: "in_person", status: "contracted" },
    });

    const res = await request(app).delete(`/accounts/${customer.id}`).expect(409);
    expect(res.body.message).toContain("contracted");
  });

  it("refuses when an estimate exists", async () => {
    const { customer, property } = await makeCustomerWithProperty("WithEstimate");
    const visit = await prisma.visit.create({
      data: { customerId: customer.id, propertyId: property.id, mode: "in_person" },
    });
    await prisma.estimate.create({
      data: { visitId: visit.id, propertyId: property.id, title: "Test estimate" },
    });

    const res = await request(app).delete(`/accounts/${customer.id}`).expect(409);
    expect(res.body.message).toMatch(/estimate/i);
  });

  it("404s an unknown account", async () => {
    await request(app).delete(`/accounts/does-not-exist`).expect(404);
  });
});
