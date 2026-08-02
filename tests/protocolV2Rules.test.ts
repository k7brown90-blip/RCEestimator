/**
 * Protocol v2 foundation — the rules that make the Health Record defensible.
 *
 * Covers the two rule engines:
 *  - measurementRules: hard validation rules 1–3 (§12.3), the §3.3 energized
 *    main-lug torque refusal, and the §1.4 converging-MONITOR escalation
 *  - codeEraResolver: §1.3 AHJ edition resolution and hard rule 5 — no FAIL
 *    against a code provision newer than the install era unless retroactive
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import {
  validateMeasurement,
  applyClassificationCeiling,
  escalateConvergingMonitors,
  MeasurementRuleError,
} from "../src/services/measurementRules";
import {
  resolveAhjEdition,
  classifyAgainstRequirement,
  editionForInstallYear,
} from "../src/services/codeEraResolver";

const LIVE = { serviceSideEnergized: false };
const ENERGIZED = { serviceSideEnergized: true };

describe("measurement hard rules (§12.3)", () => {
  it("rule 1: refuses a thermal reading without companion load current", () => {
    expect(() =>
      validateMeasurement(
        { measurementType: "stab_thermal_delta_t", measuredValue: 2.5, unit: "C", comparativeReferenceItemId: "item-x" },
        LIVE,
      ),
    ).toThrow(MeasurementRuleError);
  });

  it("rule 2: refuses a comparative reading without a named reference", () => {
    expect(() =>
      validateMeasurement(
        { measurementType: "thermal_delta_t", measuredValue: 2.5, unit: "C", loadAmperageAtReading: 14 },
        LIVE,
      ),
    ).toThrow(/comparativeReferenceItemId/);
  });

  it("accepts a fully-specified comparative thermal reading", () => {
    const row = validateMeasurement(
      {
        measurementType: "stab_thermal_delta_t",
        measuredValue: 2.5,
        unit: "C",
        loadAmperageAtReading: 14,
        comparativeReferenceItemId: "item-neighbor-stab",
        comparativeLoadDeltaAmps: 1.2,
      },
      LIVE,
    );
    expect(row.classificationCeiling).toBe("pass_fail");
  });

  it("rule 3: forces monitor_max onto grounding resistance regardless of what the client sends", () => {
    const row = validateMeasurement(
      { measurementType: "grounding_resistance", measuredValue: 22, unit: "ohm", classificationCeiling: "pass_fail" },
      LIVE,
    );
    expect(row.classificationCeiling).toBe("monitor_max");
  });

  it("§3.3 settled policy: refuses torque on a service-side energized enclosure", () => {
    expect(() =>
      validateMeasurement({ measurementType: "torque", measuredValue: 250, unit: "in_lb" }, ENERGIZED),
    ).toThrow(/service-side energized/);
    // Same reading on a de-energizable load-side enclosure is fine.
    expect(() =>
      validateMeasurement({ measurementType: "torque", measuredValue: 250, unit: "in_lb" }, LIVE),
    ).not.toThrow();
  });

  it("caps a FAIL to MONITOR when the only failing evidence is monitor_max metrics", () => {
    const capped = applyClassificationCeiling("fail", [
      { classificationCeiling: "monitor_max", passed: false },
    ]);
    expect(capped).toEqual({ classification: "monitor", capped: true });

    // Mixed evidence: an uncapped failing metric keeps the FAIL.
    const kept = applyClassificationCeiling("fail", [
      { classificationCeiling: "monitor_max", passed: false },
      { classificationCeiling: "pass_fail", passed: false },
    ]);
    expect(kept).toEqual({ classification: "fail", capped: false });

    // FAIL on visual grounds alone (no failing measurement) is untouched.
    const visual = applyClassificationCeiling("fail", [
      { classificationCeiling: "monitor_max", passed: true },
    ]);
    expect(visual.capped).toBe(false);
  });

  it("§1.4: two MONITORs at the same physical component escalate; separate components don't", () => {
    const items = [
      { classification: "monitor", enclosureId: "e1", componentType: "bus_stab", locationLabel: null, busLeg: "A", stabPosition: 4 },
      { classification: "monitor", enclosureId: "e1", componentType: "bus_stab", locationLabel: null, busLeg: "A", stabPosition: 4 },
      { classification: "monitor", enclosureId: "e1", componentType: "bus_stab", locationLabel: null, busLeg: "B", stabPosition: 2 },
      { classification: "pass", enclosureId: "e1", componentType: "bus_stab", locationLabel: null, busLeg: "A", stabPosition: 4 },
    ];
    const result = escalateConvergingMonitors(items);
    expect(result[0].escalate).toBe(true);
    expect(result[1].escalate).toBe(true);
    expect(result[2].escalate).toBe(false);
    expect(result[3].escalate).toBe(false);
  });
});

describe("code-era resolver (§1.3, hard rule 5)", () => {
  let customerId: string;
  let propertyId2017Install: string;
  let propertyUnknownInstall: string;
  let propertyOverride2023: string;
  let reqSpd: string;
  let reqGfciKitchen: string;
  let reqRetroactive: string;

  beforeAll(async () => {
    const customer = await prisma.customer.create({ data: { name: "CodeEra Test Customer" } });
    customerId = customer.id;

    const mkProperty = (name: string, extra: Record<string, unknown>) =>
      prisma.property.create({
        data: {
          customerId,
          name,
          addressLine1: "1 CodeEra Way",
          city: "Murfreesboro", // 2017 jurisdiction
          state: "TN",
          postalCode: "37127",
          ...extra,
        },
      });

    const p1 = await mkProperty("CodeEra 2001 install", { estimatedInstallYear: 2001 });
    propertyId2017Install = p1.id;
    const p2 = await mkProperty("CodeEra unknown install", {});
    propertyUnknownInstall = p2.id;
    const p3 = await mkProperty("CodeEra 2023 override", { ahjCodeEdition: "2023", estimatedInstallYear: 2024 });
    propertyOverride2023 = p3.id;

    const spd = await prisma.codeRequirement.upsert({
      where: { id: "test-req-spd" },
      create: {
        id: "test-req-spd",
        necArticle: "230.67",
        necEditionIntroduced: "2020",
        requirementType: "spd",
        appliesTo: "dwelling unit services",
        isRetroactive: false,
        description: "test SPD requirement",
      },
      update: {},
    });
    reqSpd = spd.id;

    const gfci = await prisma.codeRequirement.upsert({
      where: { id: "test-req-gfci-kitchen" },
      create: {
        id: "test-req-gfci-kitchen",
        necArticle: "210.8(A)(6)",
        necEditionIntroduced: "pre2017",
        requirementType: "gfci_location",
        appliesTo: "kitchen countertop receptacles",
        isRetroactive: false,
        description: "test kitchen GFCI",
      },
      update: {},
    });
    reqGfciKitchen = gfci.id;

    const retro = await prisma.codeRequirement.upsert({
      where: { id: "test-req-retroactive" },
      create: {
        id: "test-req-retroactive",
        necArticle: "TEST.RETRO",
        necEditionIntroduced: "2017",
        requirementType: "other",
        appliesTo: "test",
        isRetroactive: true,
        description: "test retroactive requirement",
      },
      update: {},
    });
    reqRetroactive = retro.id;
  });

  afterAll(async () => {
    await prisma.codeRequirement.deleteMany({ where: { id: { startsWith: "test-req-" } } });
    await prisma.property.deleteMany({ where: { customerId } });
    await prisma.customer.delete({ where: { id: customerId } });
  });

  it("resolves the AHJ edition from the jurisdiction, and honors a property override", async () => {
    const derived = await resolveAhjEdition(propertyId2017Install);
    expect(derived.edition).toBe("2017");
    expect(derived.source).toBe("jurisdiction");

    const overridden = await resolveAhjEdition(propertyOverride2023);
    expect(overridden.edition).toBe("2023");
    expect(overridden.source).toBe("property_override");
  });

  it("blocks a FAIL against a requirement newer than the install era → UPGRADE with reason", async () => {
    // 2001 install, SPD introduced 2020, AHJ 2017: not even adopted here.
    const result = await classifyAgainstRequirement({
      propertyId: propertyId2017Install,
      codeRequirementId: reqSpd,
      deficient: true,
    });
    expect(result.classification).toBe("upgrade");
    expect(result.reason).toContain("2020");
  });

  it("FAILs a deficiency the install-era code already required", async () => {
    const result = await classifyAgainstRequirement({
      propertyId: propertyId2017Install,
      codeRequirementId: reqGfciKitchen,
      deficient: true,
    });
    expect(result.classification).toBe("fail");
  });

  it("unknown install year is conservative: UPGRADE, never FAIL, with disclosure", async () => {
    const result = await classifyAgainstRequirement({
      propertyId: propertyUnknownInstall,
      codeRequirementId: reqGfciKitchen,
      deficient: true,
    });
    // GFCI kitchen is pre2017 (baseline) — with unknown install year the rule
    // still refuses to assume the era. Conservative answer stands.
    expect(result.classification).toBe("upgrade");
    expect(result.reason).toContain("Install era unknown");
  });

  it("a retroactive requirement FAILs regardless of install era", async () => {
    const result = await classifyAgainstRequirement({
      propertyId: propertyId2017Install, // 2001 install, requirement 2017 — but retroactive
      codeRequirementId: reqRetroactive,
      deficient: true,
    });
    expect(result.classification).toBe("fail");
  });

  it("a compliant condition is PASS whatever the editions say", async () => {
    const result = await classifyAgainstRequirement({
      propertyId: propertyId2017Install,
      codeRequirementId: reqSpd,
      deficient: false,
    });
    expect(result.classification).toBe("pass");
  });

  it("maps install years onto edition eras with the platform's 2017 baseline", () => {
    expect(editionForInstallYear(2001)).toBe("pre2017");
    expect(editionForInstallYear(2017)).toBe("2017");
    expect(editionForInstallYear(2021)).toBe("2020");
    expect(editionForInstallYear(2025)).toBe("2023");
  });
});
