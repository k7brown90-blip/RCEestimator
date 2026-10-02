/**
 * The property page's health record (plan item C, 2026-10-02,
 * ".claude/plans/2026-10-02-account-property-and-the-estimate-that-knows-the-job.md"):
 * "we can also add in diagnostics reports here" — aggregated per PROPERTY, across every
 * visit at that address, the same way `/health-record-admin/properties/:propertyId/inspections`
 * already aggregates electrical assessments (that route existed before this plan item; only
 * the diagnostic-reports one below is new).
 *
 * Covers the one new server route this unit added:
 *   GET /health-record-admin/properties/:propertyId/diagnostic-reports
 *
 * Two properties, two reports — the test that matters is that address B's report never shows
 * up under address A's query, mirroring the existing visit-scoped route
 * (`/health-record-admin/visits/:visitId/diagnostic-reports`) this one sits beside.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

let customerId: string;
let propertyAId: string;
let propertyBId: string;
let visitAId: string;
let visitBId: string;
const REPORT_A_ID = "ph-test-report-a";
const REPORT_B_ID = "ph-test-report-b";

beforeAll(async () => {
  const customer = await prisma.customer.create({
    data: { name: "Property Health Record Test Customer", phone: "615-555-0199" },
  });
  customerId = customer.id;

  const propertyA = await prisma.property.create({
    data: { customerId, name: "Address A", addressLine1: "1 Test Way", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  propertyAId = propertyA.id;
  const propertyB = await prisma.property.create({
    data: { customerId, name: "Address B", addressLine1: "2 Test Way", city: "Smyrna", state: "TN", postalCode: "37167" },
  });
  propertyBId = propertyB.id;

  const visitA = await prisma.visit.create({
    data: { propertyId: propertyAId, customerId, mode: "service_diagnostic", purpose: "Diagnostic", visitDate: new Date() },
  });
  visitAId = visitA.id;
  const visitB = await prisma.visit.create({
    data: { propertyId: propertyBId, customerId, mode: "service_diagnostic", purpose: "Diagnostic", visitDate: new Date() },
  });
  visitBId = visitB.id;

  await prisma.diagnosticReport.create({
    data: {
      id: REPORT_A_ID,
      visitId: visitAId,
      propertyId: propertyAId,
      customerId,
      reportDate: new Date("2026-09-15T00:00:00Z"),
      complaint: "Kitchen outlets dead",
      circuitLabel: "Kitchen small appliance",
      coverage: "whole_circuit",
      status: "complete",
    },
  });
  await prisma.diagnosticReport.create({
    data: {
      id: REPORT_B_ID,
      visitId: visitBId,
      propertyId: propertyBId,
      customerId,
      reportDate: new Date("2026-09-16T00:00:00Z"),
      complaint: "Garage circuit tripping",
      circuitLabel: "Garage",
      coverage: "partial",
      coverageNote: "Stopped at the junction box behind the water heater — access blocked.",
      status: "in_progress",
    },
  });
});

afterAll(async () => {
  await prisma.diagnosticReport.deleteMany({ where: { customerId } });
  await prisma.visit.deleteMany({ where: { customerId } });
  await prisma.property.deleteMany({ where: { customerId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
});

describe("GET /health-record-admin/properties/:propertyId/diagnostic-reports", () => {
  it("returns only the diagnostic reports run at THIS address", async () => {
    const res = await request(app)
      .get(`/health-record-admin/properties/${propertyAId}/diagnostic-reports`)
      .expect(200);

    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0].id).toBe(REPORT_A_ID);
    expect(res.body.reports[0].visitId).toBe(visitAId);
    expect(res.body.reports[0].complaint).toBe("Kitchen outlets dead");
    expect(res.body.reports[0].status).toBe("complete");
    // The warranty sentence the report prints on its face — confirms serializeDiagnosticReport
    // ran (not a raw prisma row), the same shape the visit-scoped route already returns.
    expect(typeof res.body.reports[0].coverageStatement).toBe("string");
    expect(res.body.reports[0].coverageStatement.length).toBeGreaterThan(0);
  });

  it("never leaks address B's report into address A's list, and vice versa", async () => {
    const resA = await request(app).get(`/health-record-admin/properties/${propertyAId}/diagnostic-reports`).expect(200);
    expect(resA.body.reports.map((r: { id: string }) => r.id)).not.toContain(REPORT_B_ID);

    const resB = await request(app).get(`/health-record-admin/properties/${propertyBId}/diagnostic-reports`).expect(200);
    expect(resB.body.reports.map((r: { id: string }) => r.id)).not.toContain(REPORT_A_ID);
    expect(resB.body.reports[0].coverage).toBe("partial");
    expect(resB.body.reports[0].status).toBe("in_progress");
  });

  it("returns an empty list, not an error, for an address with no diagnostics on file", async () => {
    const emptyProperty = await prisma.property.create({
      data: { customerId, name: "Address C", addressLine1: "3 Test Way", city: "Smyrna", state: "TN", postalCode: "37167" },
    });
    const res = await request(app)
      .get(`/health-record-admin/properties/${emptyProperty.id}/diagnostic-reports`)
      .expect(200);
    expect(res.body.reports).toEqual([]);
  });
});
