/**
 * Protocol v2 ingest — the push endpoint as enforcement point.
 *
 * A violating inspection must be rejected whole (422) with nothing persisted;
 * a clean one writes enclosures, items, measurements, bus visuals, GFCI
 * coverage and sampling records transactionally, applies the classification
 * pipeline (ceiling → code-era → converging-MONITOR escalation), feeds the
 * internal MonitorTracker idempotently, and replaces its own rows on re-push.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import crypto from "node:crypto";
import { app } from "../src/app";
import { prisma } from "../src/lib/prisma";

let customerId: string;
let propertyId: string;
let visitId: string;
let techToken: string;

const uuid = () => crypto.randomUUID();

function basePush(inspectionId: string, v2: Record<string, unknown>) {
  return {
    inspectionId,
    visitId,
    jurisdictionId: "rutherford",
    inspectionDate: new Date().toISOString(),
    score: null,
    schemaVersion: "v2",
    scope: "full",
    itemsAssessed: 0,
    criticalFindings: [],
    contractorReviewed: false,
    items: [],
    v2,
  };
}

const SERVICE_ENCLOSURE = {
  locationKey: "service_main",
  enclosureType: "service_equipment",
  serviceSideEnergized: true,
  busMaterial: "aluminum_tin_plated",
};

const SUBPANEL = {
  locationKey: "subpanel_garage",
  enclosureType: "subpanel",
  serviceSideEnergized: false,
};

beforeAll(async () => {
  const customer = await prisma.customer.create({ data: { name: "V2 Ingest Customer" } });
  customerId = customer.id;
  const property = await prisma.property.create({
    data: {
      customerId,
      name: "V2 Ingest House",
      addressLine1: "12 Protocol Pl",
      city: "Murfreesboro",
      state: "TN",
      postalCode: "37127",
      estimatedInstallYear: 2001,
    },
  });
  propertyId = property.id;
  const visit = await prisma.visit.create({
    data: { propertyId, customerId, mode: "service", status: "estimate", jobType: "health assessment" },
  });
  visitId = visit.id;
  techToken = `v2-ingest-tech-${Date.now()}`;
  await prisma.technician.create({
    data: { name: "V2 Ingest Tech", accessToken: techToken },
  });
});

afterAll(async () => {
  await prisma.healthInspection.deleteMany({ where: { propertyId } });
  await prisma.monitorTracker.deleteMany({ where: { propertyId } });
  await prisma.enclosure.deleteMany({ where: { propertyId } });
  await prisma.codeRequirement.deleteMany({ where: { id: { startsWith: "v2test-" } } });
  await prisma.visit.deleteMany({ where: { propertyId } });
  await prisma.technician.deleteMany({ where: { accessToken: techToken } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
});

const push = (body: object) =>
  request(app).post("/health-record/inspections").set("Authorization", `Bearer ${techToken}`).send(body);

describe("v2 ingest — hard-rule rejection (nothing persists)", () => {
  it("rejects a thermal reading without companion current, and the inspection does not exist", async () => {
    const id = uuid();
    const res = await push(
      basePush(id, {
        enclosures: [SUBPANEL],
        items: [
          {
            componentType: "bus_stab",
            locationKey: "subpanel_garage",
            classification: "pass",
            measurements: [
              { measurementType: "stab_thermal_delta_t", measuredValue: 2, unit: "C", comparativeReferenceItemId: "neighbor" },
            ],
          },
        ],
      }),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("companion_current_required");
    expect(await prisma.healthInspection.findUnique({ where: { id } })).toBeNull();
  });

  it("§3.3: rejects torque on a line-side lug, accepts it on a branch breaker in the same energized enclosure", async () => {
    // The lug defaults to energized via the line-side heuristic → refused.
    const lugRes = await push(
      basePush(uuid(), {
        enclosures: [SERVICE_ENCLOSURE],
        items: [
          {
            componentType: "lug",
            locationKey: "service_main",
            classification: "pass",
            measurements: [{ measurementType: "torque", measuredValue: 250, unit: "in_lb" }],
          },
        ],
      }),
    );
    expect(lugRes.status).toBe(422);
    expect(lugRes.body.error.code).toBe("service_side_energized");

    // A branch breaker in the SAME enclosure is load-side — switched off and
    // torqued normally. Blocking it was the bug this rule-scope fix corrects.
    const breakerRes = await push(
      basePush(uuid(), {
        enclosures: [SERVICE_ENCLOSURE],
        items: [
          {
            componentType: "breaker",
            locationKey: "service_main",
            circuitNumber: "12",
            classification: "pass",
            measurements: [{ measurementType: "torque", measuredValue: 20, unit: "in_lb" }],
          },
        ],
      }),
    );
    expect(breakerRes.status).toBe(201);

    // And the tech's explicit flag overrides the heuristic in both directions:
    // a lug marked de-energizable takes a torque record.
    const overrideRes = await push(
      basePush(uuid(), {
        enclosures: [SERVICE_ENCLOSURE],
        items: [
          {
            componentType: "lug",
            locationKey: "service_main",
            classification: "pass",
            serviceSideEnergized: false,
            measurements: [{ measurementType: "torque", measuredValue: 250, unit: "in_lb" }],
          },
        ],
      }),
    );
    expect(overrideRes.status).toBe(201);
    const overrideItems = await prisma.inspectionItem.findMany({ where: { inspectionId: (overrideRes.body.data as { id: string }).id } });
    expect(overrideItems[0].serviceSideEnergized).toBe(false);
  });

  it("rule 6: rejects close when a failed sample never expanded to 100%", async () => {
    const res = await push(
      basePush(uuid(), {
        samplingRecords: [
          { category: "torque", totalCount: 20, testedCount: 12, basis: "25% largest-load first", expandedDueToFail: true },
        ],
      }),
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("sampling_expansion_incomplete");
  });
});

describe("v2 ingest — classification pipeline and persistence", () => {
  it("writes the full structure, demotes per rules, escalates converging MONITORs, tracks recurrence", async () => {
    await prisma.codeRequirement.upsert({
      where: { id: "v2test-spd" },
      create: {
        id: "v2test-spd",
        necArticle: "230.67",
        necEditionIntroduced: "2020",
        requirementType: "spd",
        appliesTo: "dwelling unit services",
        isRetroactive: false,
        description: "test",
      },
      update: {},
    });

    const id = uuid();
    const res = await push(
      basePush(id, {
        enclosures: [SERVICE_ENCLOSURE, SUBPANEL],
        items: [
          // rule 3: FAIL whose only failing evidence is monitor_max → MONITOR
          {
            componentType: "ground_bar",
            locationKey: "subpanel_garage",
            classification: "fail",
            measurements: [
              { measurementType: "grounding_resistance", measuredValue: 90, unit: "ohm", passed: false },
            ],
          },
          // rule 5: FAIL on SPD absence, 2001 install, 2017 AHJ → UPGRADE
          {
            componentType: "spd",
            locationKey: "service_main",
            classification: "fail",
            codeRequirementId: "v2test-spd",
          },
          // §1.4: two MONITORs at the same stab → both escalate to FAIL
          { componentType: "bus_stab", locationKey: "subpanel_garage", busLeg: "A", stabPosition: 4, classification: "monitor" },
          { componentType: "bus_stab", locationKey: "subpanel_garage", busLeg: "A", stabPosition: 4, classification: "monitor" },
          // clean pass with a valid comparative thermal + bus visual
          {
            componentType: "bus_stab",
            locationKey: "subpanel_garage",
            busLeg: "B",
            stabPosition: 1,
            classification: "pass",
            measurements: [
              {
                measurementType: "stab_thermal_delta_t",
                measuredValue: 0.4,
                unit: "C",
                loadAmperageAtReading: 12.5,
                comparativeReferenceItemId: "leg-B-stab-3",
                passed: true,
              },
            ],
            busVisual: {
              corrosionLocation: "bar_flat_non_contact",
              platingStatus: "tarnished_intact",
              materialLoss: "surface_film",
              arcSignature: "none",
              adjacentPolymer: "unaffected",
              heatTintMetal: "none",
            },
          },
        ],
        gfciCoverage: [
          {
            locationDescriptor: "kitchen counter east",
            requiredAtInstall: true,
            requiredCurrentCode: true,
            protectionSource: "panel_breaker",
            functionTestResult: "pass",
            classification: "pass",
          },
        ],
        samplingRecords: [
          { category: "receptacle", totalCount: 40, testedCount: 12, basis: "one per branch circuit, 25% minimum", untestedLocations: "bedrooms 2-3" },
        ],
      }),
    );

    expect(res.status).toBe(201);
    expect(res.body.data.v2).toMatchObject({ enclosures: 2, items: 5, measurements: 2 });

    const items = await prisma.inspectionItem.findMany({
      where: { inspectionId: id },
      orderBy: { createdAt: "asc" },
      include: { measurements: true, busVisual: true, enclosure: true },
    });
    expect(items).toHaveLength(5);

    // rule 3 demotion, with the reason on the record
    expect(items[0].classification).toBe("monitor");
    expect(items[0].techNote).toContain("[rule 3]");
    expect(items[0].measurements[0].classificationCeiling).toBe("monitor_max");

    // rule 5 demotion to UPGRADE with the code-era reason
    expect(items[1].classification).toBe("upgrade");
    expect(items[1].techNote).toContain("[rule 5]");
    expect(items[1].techNote).toContain("2020");

    // §1.4 escalation of the converging stabs
    expect(items[2].classification).toBe("fail");
    expect(items[3].classification).toBe("fail");
    expect(items[2].techNote).toContain("[§1.4]");

    // the clean pass, linked to its enclosure and rubric
    expect(items[4].classification).toBe("pass");
    expect(items[4].enclosure?.locationKey).toBe("subpanel_garage");
    expect(items[4].busVisual?.platingStatus).toBe("tarnished_intact");

    const gfci = await prisma.gfciCoverage.findMany({ where: { inspectionId: id } });
    expect(gfci).toHaveLength(1);
    const sampling = await prisma.samplingRecord.findMany({ where: { inspectionId: id } });
    expect(sampling[0].untestedLocations).toBe("bedrooms 2-3");

    // MONITOR recurrence in the internal tracker — rule-3 demoted item counts
    const trackers = await prisma.monitorTracker.findMany({ where: { propertyId } });
    expect(trackers.some((t) => t.componentType === "ground_bar" && t.occurrenceCount === 1)).toBe(true);

    // Re-push (offline queue retry): rows replaced, tracker NOT double-counted
    const rePush = await push(
      basePush(id, {
        enclosures: [SUBPANEL],
        items: [
          {
            componentType: "ground_bar",
            locationKey: "subpanel_garage",
            classification: "monitor",
          },
        ],
      }),
    );
    expect(rePush.status).toBe(201);
    const itemsAfter = await prisma.inspectionItem.findMany({ where: { inspectionId: id } });
    expect(itemsAfter).toHaveLength(1);
    const trackerAfter = await prisma.monitorTracker.findFirst({ where: { propertyId, componentType: "ground_bar" } });
    expect(trackerAfter?.occurrenceCount).toBe(1);
  });

  it("a v1 push without a v2 section still works untouched", async () => {
    const id = uuid();
    const body = basePush(id, {});
    delete (body as Record<string, unknown>).v2;
    const res = await push(body);
    expect(res.status).toBe(201);
    expect(res.body.data.v2).toBeNull();
  });
});
