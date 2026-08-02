/**
 * Measurement validation — protocol v2 hard rules (§12.3), enforced at the
 * write path so an invalid measurement cannot become a row, no matter which
 * client sent it. "The app must block this, not merely discourage it."
 *
 * Rules implemented here:
 *   1. No thermal or stab measurement without companion load current — a
 *      thermal number without load is meaningless and creates a misleading
 *      record (a stab at 14 A runs warmer than one at 1 A regardless of
 *      condition, §8.3).
 *   2. No comparative measurement without a comparative reference — the
 *      report must state what it was compared against.
 *   3. Interface-resistance-type metrics carry classification_ceiling
 *      monitor_max: they may never be the sole basis of a FAIL (NEMA AB 4).
 *   4. methodConditionsMet=false is allowed but the flag rides the row so the
 *      report template MUST disclose the out-of-condition reading.
 *   5. (Code-era rule — lives in codeEraResolver.classifyAgainstRequirement.)
 *   §3.3 settled policy: an item on a service-side-energized enclosure may
 *      NEVER carry a torque record. Not a warning. A refusal.
 */

export const THERMAL_TYPES = new Set([
  "thermal_delta_t",
  "thermal_absolute",
  "stab_thermal_delta_t",
]);

export const COMPARATIVE_TYPES = new Set([
  "thermal_delta_t",
  "stab_thermal_delta_t",
]);

/** Metrics that may cap at MONITOR and never solely justify a FAIL (rule 3). */
export const MONITOR_MAX_TYPES = new Set([
  "grounding_resistance", // instrument/method dependent — see §3.3 grounding limitation
]);

export interface MeasurementInput {
  measurementType: string;
  measuredValue: number;
  unit: string;
  referenceValueApplied?: number | null;
  referenceSourceId?: string | null;
  referenceMethod?: string | null;
  comparativeReferenceItemId?: string | null;
  comparativeLoadDeltaAmps?: number | null;
  loadAmperageAtReading?: number | null;
  ambientAtReadingC?: number | null;
  methodStandard?: string | null;
  methodConditionsMet?: boolean;
  classificationCeiling?: string;
  passed?: boolean | null;
}

export interface MeasurementValidationContext {
  /** From the item's enclosure — §3.3 settled policy. */
  serviceSideEnergized: boolean;
}

export class MeasurementRuleError extends Error {
  constructor(
    public readonly rule: string,
    message: string,
  ) {
    super(message);
    this.name = "MeasurementRuleError";
  }
}

/**
 * Validate one measurement against the hard rules. Throws MeasurementRuleError
 * on violation; returns the normalized row values (ceiling forced where the
 * protocol demands it) on success.
 */
export function validateMeasurement(
  input: MeasurementInput,
  ctx: MeasurementValidationContext,
): MeasurementInput {
  // §3.3 — torque on an energized service side: refused outright.
  if (input.measurementType === "torque" && ctx.serviceSideEnergized) {
    throw new MeasurementRuleError(
      "service_side_energized",
      "Torque may not be recorded for a service-side energized enclosure. These terminations receive " +
        "thermal scan and structured visual assessment only (protocol §3.3, settled policy). " +
        "Record the thermal reading and the bus visual assessment instead.",
    );
  }

  // Rule 1 — thermal/stab readings require companion load current.
  if (THERMAL_TYPES.has(input.measurementType)) {
    if (input.loadAmperageAtReading == null) {
      throw new MeasurementRuleError(
        "companion_current_required",
        `A ${input.measurementType} reading cannot be saved without loadAmperageAtReading. Without the load ` +
          "the number is meaningless and creates a misleading record (protocol §12.3 rule 1, §8.3).",
      );
    }
  }

  // Rule 2 — comparative readings must name their reference.
  if (COMPARATIVE_TYPES.has(input.measurementType)) {
    if (!input.comparativeReferenceItemId) {
      throw new MeasurementRuleError(
        "comparative_reference_required",
        `A ${input.measurementType} reading is comparative and cannot be saved without ` +
          "comparativeReferenceItemId — the report must be able to state what it was compared against " +
          "(protocol §12.3 rule 2).",
      );
    }
  }

  // Rule 3 — monitor_max ceiling is forced, not requested.
  let ceiling = input.classificationCeiling ?? "pass_fail";
  if (MONITOR_MAX_TYPES.has(input.measurementType)) {
    ceiling = "monitor_max";
  }

  return { ...input, classificationCeiling: ceiling, methodConditionsMet: input.methodConditionsMet ?? true };
}

/**
 * Rule 3 enforcement at classification time: an item whose ONLY failing
 * evidence is monitor_max measurements cannot be classified FAIL.
 *
 * `measurements` are the item's rows; `proposed` is the classification the
 * client asked for. Returns the permitted classification.
 */
export function applyClassificationCeiling(
  proposed: string,
  measurements: Array<{ classificationCeiling: string; passed: boolean | null }>,
): { classification: string; capped: boolean } {
  if (proposed !== "fail") return { classification: proposed, capped: false };

  const failingEvidence = measurements.filter((m) => m.passed === false);
  if (failingEvidence.length === 0) {
    // FAIL on visual/structured grounds (e.g. bus rubric) — measurements not the basis.
    return { classification: proposed, capped: false };
  }
  const allCapped = failingEvidence.every((m) => m.classificationCeiling === "monitor_max");
  if (allCapped) {
    return { classification: "monitor", capped: true };
  }
  return { classification: proposed, capped: false };
}

/**
 * §1.4 escalation rule: two or more MONITOR findings at the same physical
 * component escalate to FAIL — converging weak indicators at one interface
 * are stronger than any one alone.
 */
export function escalateConvergingMonitors(
  items: Array<{ classification: string; enclosureId: string | null; componentType: string; locationLabel: string | null; busLeg: string | null; stabPosition: number | null }>,
): Array<{ index: number; escalate: boolean }> {
  const keyOf = (i: (typeof items)[number]) =>
    `${i.enclosureId ?? "none"}|${i.componentType}|${i.locationLabel ?? ""}|${i.busLeg ?? ""}|${i.stabPosition ?? ""}`;

  const monitorCounts = new Map<string, number>();
  for (const item of items) {
    if (item.classification === "monitor") {
      const k = keyOf(item);
      monitorCounts.set(k, (monitorCounts.get(k) ?? 0) + 1);
    }
  }

  return items.map((item, index) => ({
    index,
    escalate: item.classification === "monitor" && (monitorCounts.get(keyOf(item)) ?? 0) >= 2,
  }));
}
