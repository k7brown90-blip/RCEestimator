/**
 * Protocol v2 inspection ingest — the server-side enforcement point.
 *
 * The PWA validates as the tech works, but the write path is where the
 * protocol's hard rules actually live ("the app must block this, not merely
 * discourage it", §12.3). Everything here runs BEFORE the inspection is
 * persisted; a payload that breaks a hard rule is rejected whole, stays in
 * the PWA's offline queue, and comes back fixed.
 *
 * Enforced here:
 *  - Measurement rules 1–3 + §3.3 torque-on-energized refusal
 *    (services/measurementRules.ts) with enclosure context resolved from the
 *    payload and the DB
 *  - Rule 3 ceiling at item level: FAIL demoted to MONITOR when the only
 *    failing evidence is monitor_max metrics
 *  - Hard rule 5 via codeEraResolver when an item cites a CodeRequirement:
 *    an illegal FAIL is demoted to UPGRADE with the reason recorded in
 *    techNote — never silently
 *  - §1.4 converging-MONITOR escalation across the batch
 *  - Rule 6 sampling gate: an inspection whose failed sample never expanded
 *    to 100% cannot close
 *  - MONITOR recurrence lands in the internal-only MonitorTracker (§1.5),
 *    idempotent across re-pushes of the same inspection
 *
 * Idempotency: v2 rows for an inspection are replaced wholesale on re-push
 * (delete + create inside one transaction), mirroring the itemsJson upsert.
 */

import { z } from "zod";
import { prisma } from "../lib/prisma";
import {
  validateMeasurement,
  applyClassificationCeiling,
  escalateConvergingMonitors,
  MeasurementRuleError,
} from "./measurementRules";
import { classifyAgainstRequirement } from "./codeEraResolver";

// ── Payload schema ───────────────────────────────────────────────────────────

const measurementSchema = z.object({
  measurementType: z.string().min(1),
  measuredValue: z.number(),
  unit: z.string().min(1),
  referenceValueApplied: z.number().nullable().optional(),
  referenceSourceId: z.string().nullable().optional(),
  referenceMethod: z.enum(["panel_label", "manufacturer_doc", "generic_fallback"]).nullable().optional(),
  comparativeReferenceItemId: z.string().nullable().optional(),
  comparativeLoadDeltaAmps: z.number().nullable().optional(),
  loadAmperageAtReading: z.number().nullable().optional(),
  ambientAtReadingC: z.number().nullable().optional(),
  methodStandard: z.string().nullable().optional(),
  methodConditionsMet: z.boolean().optional(),
  classificationCeiling: z.enum(["pass_fail", "monitor_max", "informational_only"]).optional(),
  passed: z.boolean().nullable().optional(),
});

const busVisualSchema = z.object({
  corrosionLocation: z.enum(["stab_contact_patch", "bar_flat_non_contact", "bolted_joint", "neutral_bar", "ground_bar"]),
  corrosionProduct: z.enum(["white_powdery", "green_blue", "black_brown", "red_rust"]).nullable().optional(),
  platingStatus: z.enum(["intact", "tarnished_intact", "breached_localized", "breached_at_contact", "absent"]),
  materialLoss: z.enum(["none", "surface_film", "light_pitting", "deep_pitting", "erosion_deformation"]),
  arcSignature: z.enum(["none", "spatter", "rounded_melted_edges", "material_transfer"]),
  adjacentPolymer: z.enum(["unaffected", "discolored", "browned_embrittled", "charred"]),
  heatTintMetal: z.enum(["none", "straw", "blue_purple"]),
});

const enclosureSchema = z.object({
  locationKey: z.string().min(1),
  enclosureType: z.enum(["service_equipment", "main_disconnect", "main_panel", "subpanel", "equipment_disconnect"]),
  disconnectSubtype: z.enum(["breakered", "fused", "non_fused_switch", "pullout"]).nullable().optional(),
  equipmentServed: z.string().nullable().optional(),
  locationDescription: z.string().nullable().optional(),
  distanceFromMainFt: z.number().nullable().optional(),
  labelTorqueValueObserved: z.string().nullable().optional(),
  labelLegible: z.boolean().nullable().optional(),
  busMaterial: z.string().nullable().optional(),
  serviceSideEnergized: z.boolean().optional(),
});

const itemSchema = z.object({
  componentType: z.string().min(1),
  locationKey: z.string().nullable().optional(), // → Enclosure at this property
  locationLabel: z.string().nullable().optional(),
  circuitNumber: z.string().nullable().optional(),
  busLeg: z.string().nullable().optional(),
  stabPosition: z.number().int().nullable().optional(),
  classification: z.enum(["pass", "fail", "monitor", "upgrade"]),
  /** When the classification is code-referenced, hard rule 5 re-judges it server-side. */
  codeRequirementId: z.string().nullable().optional(),
  techNote: z.string().nullable().optional(),
  customerVisible: z.boolean().optional(),
  measurements: z.array(measurementSchema).optional(),
  busVisual: busVisualSchema.nullable().optional(),
});

const gfciCoverageSchema = z.object({
  locationDescriptor: z.string().min(1),
  requiredAtInstall: z.boolean(),
  requiredCurrentCode: z.boolean(),
  protectionSource: z.enum(["none", "device", "upstream_device", "panel_breaker"]),
  functionTestResult: z.enum(["pass", "fail", "not_tested"]).nullable().optional(),
  classification: z.enum(["pass", "fail", "monitor", "upgrade"]),
});

const samplingRecordSchema = z.object({
  category: z.enum(["receptacle", "torque", "switch", "fixture"]),
  totalCount: z.number().int().nonnegative(),
  testedCount: z.number().int().nonnegative(),
  basis: z.string().min(1),
  expandedDueToFail: z.boolean().optional(),
  untestedLocations: z.string().nullable().optional(),
});

export const v2PayloadSchema = z.object({
  enclosures: z.array(enclosureSchema).default([]),
  items: z.array(itemSchema).default([]),
  gfciCoverage: z.array(gfciCoverageSchema).default([]),
  samplingRecords: z.array(samplingRecordSchema).default([]),
});

export type V2Payload = z.infer<typeof v2PayloadSchema>;

export class V2IngestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "V2IngestError";
  }
}

// ── Pre-persist validation (throws — nothing written) ───────────────────────

export interface ValidatedV2 {
  payload: V2Payload;
  /** item index → normalized measurements */
  normalizedMeasurements: Map<number, ReturnType<typeof validateMeasurement>[]>;
  /** item index → final classification + audit note additions */
  finalClassifications: Map<number, { classification: string; noteAppend: string[] }>;
}

/**
 * Run every hard rule against the payload. Throws V2IngestError (mapped to a
 * 422 by the route) so a violating inspection never persists in any form.
 */
export async function validateV2Payload(
  propertyId: string,
  payload: V2Payload,
): Promise<ValidatedV2> {
  // Rule 6 — the sampling gate. An inspection that found a FAIL inside a
  // sample and did not expand that category to 100% is not closeable (§6.3).
  for (const s of payload.samplingRecords) {
    if (s.expandedDueToFail && s.testedCount < s.totalCount) {
      throw new V2IngestError(
        "sampling_expansion_incomplete",
        `Sampling category "${s.category}" found a FAIL and must expand to 100% before the inspection can ` +
          `close (protocol §6.3 / rule 6): ${s.testedCount}/${s.totalCount} tested.`,
      );
    }
  }

  // Enclosure context: payload rows win (they're this visit's observations),
  // existing DB rows fill gaps for items referencing known enclosures.
  const energizedByKey = new Map<string, boolean>();
  const existing = await prisma.enclosure.findMany({
    where: { propertyId },
    select: { locationKey: true, serviceSideEnergized: true },
  });
  for (const e of existing) energizedByKey.set(e.locationKey, e.serviceSideEnergized);
  for (const e of payload.enclosures) energizedByKey.set(e.locationKey, e.serviceSideEnergized ?? false);

  const normalizedMeasurements = new Map<number, ReturnType<typeof validateMeasurement>[]>();

  payload.items.forEach((item, index) => {
    const ctx = {
      serviceSideEnergized: item.locationKey ? (energizedByKey.get(item.locationKey) ?? false) : false,
    };
    const normalized: ReturnType<typeof validateMeasurement>[] = [];
    for (const m of item.measurements ?? []) {
      try {
        normalized.push(validateMeasurement(m, ctx));
      } catch (err) {
        if (err instanceof MeasurementRuleError) {
          throw new V2IngestError(err.rule, `Item ${index} (${item.componentType}): ${err.message}`);
        }
        throw err;
      }
    }
    normalizedMeasurements.set(index, normalized);
  });

  // Classification pipeline: ceiling (rule 3) → code-era re-judgment (rule 5)
  // → converging-MONITOR escalation (§1.4). Order matters: escalation runs on
  // post-demotion classifications so two demoted MONITORs still converge.
  const finalClassifications = new Map<number, { classification: string; noteAppend: string[] }>();

  for (const [index, item] of payload.items.entries()) {
    const noteAppend: string[] = [];
    let classification: string = item.classification;

    const ceiling = applyClassificationCeiling(
      classification,
      (normalizedMeasurements.get(index) ?? []).map((m) => ({
        classificationCeiling: m.classificationCeiling ?? "pass_fail",
        passed: m.passed ?? null,
      })),
    );
    if (ceiling.capped) {
      classification = ceiling.classification;
      noteAppend.push(
        "[rule 3] FAIL demoted to MONITOR: the only failing evidence is interface-resistance-type metrics, " +
          "which may not be the sole criteria of acceptability (NEMA AB 4 / protocol §12.3 rule 3).",
      );
    }

    if (item.codeRequirementId && classification === "fail") {
      const judged = await classifyAgainstRequirement({
        propertyId,
        codeRequirementId: item.codeRequirementId,
        deficient: true,
      });
      if (judged.classification !== "fail") {
        classification = judged.classification;
        noteAppend.push(`[rule 5] ${judged.reason ?? "FAIL blocked by code-era rule."}`);
      }
    }

    finalClassifications.set(index, { classification, noteAppend });
  }

  // §1.4 — escalate on the post-demotion state.
  const escalation = escalateConvergingMonitors(
    payload.items.map((item, index) => ({
      classification: finalClassifications.get(index)!.classification,
      enclosureId: item.locationKey ?? null, // physical identity pre-persist
      componentType: item.componentType,
      locationLabel: item.locationLabel ?? null,
      busLeg: item.busLeg ?? null,
      stabPosition: item.stabPosition ?? null,
    })),
  );
  for (const { index, escalate } of escalation) {
    if (escalate) {
      const entry = finalClassifications.get(index)!;
      entry.classification = "fail";
      entry.noteAppend.push(
        "[§1.4] Escalated MONITOR → FAIL: two or more MONITOR findings converge at this physical component.",
      );
    }
  }

  return { payload, normalizedMeasurements, finalClassifications };
}

// ── Persist (transactional, replace-on-repush) ──────────────────────────────

export async function persistV2(
  inspectionId: string,
  propertyId: string,
  validated: ValidatedV2,
): Promise<{ enclosures: number; items: number; measurements: number; monitorsTracked: number }> {
  const { payload, normalizedMeasurements, finalClassifications } = validated;

  let measurementCount = 0;
  let monitorsTracked = 0;

  await prisma.$transaction(async (tx) => {
    // Enclosures: upsert by (propertyId, locationKey) — the physical panel
    // persists across inspections; observations refresh it.
    const enclosureIds = new Map<string, string>();
    for (const e of payload.enclosures) {
      const { locationKey, serviceSideEnergized, ...fields } = e;
      const row = await tx.enclosure.upsert({
        where: { propertyId_locationKey: { propertyId, locationKey } },
        create: { propertyId, locationKey, serviceSideEnergized: serviceSideEnergized ?? false, ...fields },
        update: { serviceSideEnergized: serviceSideEnergized ?? false, ...fields },
      });
      enclosureIds.set(locationKey, row.id);
    }
    // Items may reference enclosures recorded on a previous visit.
    for (const item of payload.items) {
      if (item.locationKey && !enclosureIds.has(item.locationKey)) {
        const known = await tx.enclosure.findUnique({
          where: { propertyId_locationKey: { propertyId, locationKey: item.locationKey } },
          select: { id: true },
        });
        if (known) enclosureIds.set(item.locationKey, known.id);
      }
    }

    // Replace-on-repush: the PWA's offline queue may retry a whole inspection.
    await tx.inspectionItem.deleteMany({ where: { inspectionId } });
    await tx.gfciCoverage.deleteMany({ where: { inspectionId } });
    await tx.samplingRecord.deleteMany({ where: { inspectionId } });

    for (const [index, item] of payload.items.entries()) {
      const final = finalClassifications.get(index)!;
      const techNote = [item.techNote, ...final.noteAppend].filter(Boolean).join("\n") || null;

      const created = await tx.inspectionItem.create({
        data: {
          inspectionId,
          enclosureId: item.locationKey ? (enclosureIds.get(item.locationKey) ?? null) : null,
          componentType: item.componentType,
          locationLabel: item.locationLabel ?? null,
          circuitNumber: item.circuitNumber ?? null,
          busLeg: item.busLeg ?? null,
          stabPosition: item.stabPosition ?? null,
          classification: final.classification,
          techNote,
          customerVisible: item.customerVisible ?? true,
        },
      });

      for (const m of normalizedMeasurements.get(index) ?? []) {
        await tx.measurement.create({
          data: {
            inspectionItemId: created.id,
            measurementType: m.measurementType,
            measuredValue: m.measuredValue,
            unit: m.unit,
            referenceValueApplied: m.referenceValueApplied ?? null,
            referenceSourceId: m.referenceSourceId ?? null,
            referenceMethod: m.referenceMethod ?? null,
            comparativeReferenceItemId: m.comparativeReferenceItemId ?? null,
            comparativeLoadDeltaAmps: m.comparativeLoadDeltaAmps ?? null,
            loadAmperageAtReading: m.loadAmperageAtReading ?? null,
            ambientAtReadingC: m.ambientAtReadingC ?? null,
            methodStandard: m.methodStandard ?? null,
            methodConditionsMet: m.methodConditionsMet ?? true,
            classificationCeiling: m.classificationCeiling ?? "pass_fail",
            passed: m.passed ?? null,
          },
        });
        measurementCount += 1;
      }

      if (item.busVisual) {
        await tx.busVisualAssessment.create({
          data: { inspectionItemId: created.id, ...item.busVisual },
        });
      }

      // §1.5 MONITOR recurrence — internal only. Keyed by physical component;
      // idempotent: a re-push of the same inspection never double-counts.
      if (final.classification === "monitor") {
        const locationKey = item.locationKey ?? "_default";
        const existing = await tx.monitorTracker.findFirst({
          where: { propertyId, locationKey, componentType: item.componentType },
        });
        if (!existing) {
          await tx.monitorTracker.create({
            data: {
              propertyId,
              inspectionItemId: created.id,
              locationKey,
              componentType: item.componentType,
              firstObservedInspectionId: inspectionId,
              lastObservedInspectionId: inspectionId,
              occurrenceCount: 1,
            },
          });
        } else if (existing.lastObservedInspectionId !== inspectionId) {
          await tx.monitorTracker.update({
            where: { id: existing.id },
            data: {
              lastObservedInspectionId: inspectionId,
              inspectionItemId: created.id,
              occurrenceCount: { increment: 1 },
            },
          });
        }
        monitorsTracked += 1;
      }
    }

    for (const g of payload.gfciCoverage) {
      await tx.gfciCoverage.create({ data: { inspectionId, ...g } });
    }
    for (const s of payload.samplingRecords) {
      await tx.samplingRecord.create({
        data: { inspectionId, ...s, expandedDueToFail: s.expandedDueToFail ?? false },
      });
    }
  });

  return {
    enclosures: payload.enclosures.length,
    items: payload.items.length,
    measurements: measurementCount,
    monitorsTracked,
  };
}
