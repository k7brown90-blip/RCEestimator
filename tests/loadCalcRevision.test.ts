/**
 * The CRM load-calc correction (Kyle, 2026-09-01, 9:45pm report):
 *
 *   "This should not be making duplicates. It should overwrite like I said.
 *    The updates are not applying to the report either. When an update to the
 *    calculations is made it needs to recalculate the load."
 *
 * Three properties pinned here:
 *   1. RECALCULATE — the revision's stored result is calculateLoad() of the
 *      corrected inputs, not a copy of the old numbers.
 *   2. OVERWRITE — every list shows ONLY the correction; the superseded row
 *      stays in the database as history but never as a card.
 *   3. ONE CHAIN — correcting an already-superseded record refuses; the edit
 *      always lands on what currently stands.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { calculateLoad, type LoadCalcInput } from "../shared/loadcalc/loadcalc";

let customerId: string;
let propertyId: string;
let visitId: string;
const ORIGINAL_ID = "lcrev-original-0001";

const baseInput = (coolingVA: number): LoadCalcInput => ({
  mode: "tech",
  occupancy: "dwellingSingleFamily",
  serviceAmps: 225,
  serviceVoltage: 240,
  floorAreaSqFt: 2383,
  loads: [
    { id: "l1", type: "range", label: "Range", nameplateKW: 12, nameplateRead: true },
    { id: "l2", type: "fixedAppliance", label: "Built-in microwave", nameplateVA: 1500, nameplateRead: true },
    { id: "l3", type: "cooling", label: "A/C", nameplateVA: coolingVA, nameplateRead: true },
  ],
});

beforeAll(async () => {
  await prisma.healthInspection.deleteMany({ where: { id: { startsWith: "lcrev-" } } });
  const customer = await prisma.customer.create({ data: { name: "LoadCalc Revision Customer", phone: "615-555-0142" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: { customerId, name: "LCRev House", addressLine1: "1007 Test Dr", city: "Spring Hill", state: "TN", postalCode: "37174" },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { propertyId, customerId, mode: "diagnostic", purpose: "Assessment", status: "scheduled" },
  });
  visitId = visit.id;

  const input = baseInput(66000); // the fat-fingered nameplate
  await prisma.healthInspection.create({
    data: {
      id: ORIGINAL_ID,
      visitId, propertyId, customerId,
      jurisdictionId: "murfreesboro",
      inspectionDate: new Date("2026-09-01T15:00:00Z"),
      itemsAssessed: 9,
      criticalFindingsJson: "[]",
      contractorReviewed: true,
      itemsJson: "[]",
      loadCalcJson: JSON.stringify({ input, result: calculateLoad(input) }),
    },
  });
});

afterAll(async () => {
  await prisma.healthInspection.deleteMany({ where: { customerId } });
  await prisma.capacityCheck.deleteMany({ where: { customerId } }).catch(() => {});
  await prisma.visit.deleteMany({ where: { id: visitId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
});

describe("correcting a load calc from the CRM", () => {
  let revisionId: string;

  it("recalculates with the shared engine, supersedes, and reports the resend state", async () => {
    const corrected = baseInput(24000); // the real nameplate
    const res = await request(app)
      .put(`/health-record-admin/inspections/${ORIGINAL_ID}/load-calc`)
      .send({ serviceAmps: corrected.serviceAmps, floorAreaSqFt: corrected.floorAreaSqFt, loads: corrected.loads })
      .expect(200);
    revisionId = res.body.inspectionId;
    expect(revisionId).toBeTruthy();
    expect(revisionId).not.toBe(ORIGINAL_ID);
    // Never emailed → nothing stale to replace, and the response says so.
    expect(res.body.resend.sent).toBe(false);
    expect(String(res.body.resend.skipped)).toMatch(/never emailed/i);

    const revision = await prisma.healthInspection.findUnique({ where: { id: revisionId } });
    expect(revision!.revisesId).toBe(ORIGINAL_ID);
    const stored = JSON.parse(revision!.loadCalcJson!) as { input: LoadCalcInput; result: { governingAmps: number } };
    // RECALCULATED, not copied: the stored result equals the engine run fresh.
    const fresh = calculateLoad(corrected);
    expect(stored.result.governingAmps).toBeCloseTo(fresh.governingAmps, 5);
    const before = calculateLoad(baseInput(66000));
    expect(stored.result.governingAmps).toBeLessThan(before.governingAmps);

    const original = await prisma.healthInspection.findUnique({ where: { id: ORIGINAL_ID } });
    expect(original!.supersededById).toBe(revisionId);
  });

  it("overwrites in every list: only the correction shows as a card", async () => {
    const res = await request(app).get(`/health-record-admin/customers/${customerId}/inspections`).expect(200);
    const rows = res.body as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toContain(revisionId);
    expect(rows.map((r) => r.id)).not.toContain(ORIGINAL_ID);
    expect(rows.filter((r) => r.id === revisionId || r.id === ORIGINAL_ID)).toHaveLength(1);
  });

  it("refuses to correct the superseded original — the chain has one head", async () => {
    const res = await request(app)
      .put(`/health-record-admin/inspections/${ORIGINAL_ID}/load-calc`)
      .send({ serviceAmps: 225, floorAreaSqFt: 2383, loads: baseInput(24000).loads })
      .expect(409);
    expect(String(res.body.error)).toMatch(/already corrected/i);
  });
});
