/**
 * One calculation history per address.
 *
 * The Article 220 calculation taken on item A2 during a Health Record used to
 * land only on `HealthInspection.loadCalcJson`, while a standalone capacity
 * check landed in `CapacityCheck`. Same house, same question, two places to
 * look — and two Red Cedar documents that could quote different amperages for
 * the same service with nothing on screen explaining the difference.
 *
 * This folds the assessment-derived calculation into the same table, so the
 * account page shows one ordered history and a customer can be answered from
 * it without anyone hunting.
 */

import { prisma } from "../lib/prisma";
import {
  capacityCheck220_83,
  type LoadCalcInput,
  type LoadItem,
} from "../../shared/loadcalc/loadcalc";

/** What the PWA stores on an inspection: the input it used and the result it showed. */
interface StoredLoadCalc {
  input?: Partial<LoadCalcInput>;
  result?: unknown;
  /** P031 generator sizing recommendation, when the technician produced one. */
  generator?: unknown;
}

function isUsable(raw: unknown): raw is StoredLoadCalc & { input: LoadCalcInput } {
  if (!raw || typeof raw !== "object") return false;
  const input = (raw as StoredLoadCalc).input;
  return Boolean(
    input &&
    typeof input === "object" &&
    typeof input.serviceAmps === "number" &&
    input.serviceAmps > 0 &&
    Array.isArray(input.loads),
  );
}

/**
 * Derive the id from the inspection, so re-pushing a record — which the offline
 * queue does routinely — reconciles to the same row instead of accumulating a
 * new calculation on the account every time a phone retries.
 */
export const capacityCheckIdForInspection = (inspectionId: string) => `${inspectionId}-a2`;

/**
 * Record the A2 calculation as a capacity check.
 *
 * Tolerant on purpose: a malformed `loadCalc` from an old bundle must not fail
 * the inspection push. The record itself is what matters; this is a convenience
 * view of it, and a missing row is recoverable while a rejected inspection is a
 * technician's afternoon.
 */
export async function recordInspectionLoadCalc(input: {
  inspectionId: string;
  visitId: string;
  propertyId: string;
  customerId: string;
  technicianId: string | null;
  loadCalc: unknown;
}): Promise<{ id: string } | null> {
  if (!isUsable(input.loadCalc)) return null;

  try {
    const stored = input.loadCalc.input;
    const calcInput: LoadCalcInput = {
      mode: stored.mode ?? "tech",
      occupancy: stored.occupancy ?? "dwellingSingleFamily",
      serviceAmps: stored.serviceAmps,
      serviceVoltage: 240,
      floorAreaSqFt: stored.floorAreaSqFt ?? 0,
      loads: stored.loads ?? [],
    };
    // The panel's "future loads" ARE 220.83's new loads — the same list asked
    // the same question, so the two surfaces cannot answer it differently.
    const newLoads: LoadItem[] = stored.futureLoads ?? [];
    const result = capacityCheck220_83(calcInput, newLoads);

    const id = capacityCheckIdForInspection(input.inspectionId);
    const data = {
      visitId: input.visitId,
      propertyId: input.propertyId,
      customerId: input.customerId,
      technicianId: input.technicianId,
      method: "220.83",
      serviceAmps: Math.round(calcInput.serviceAmps),
      serviceVoltage: 240,
      floorAreaSqFt: Math.round(calcInput.floorAreaSqFt),
      variant: result.variant,
      newLoadLabel: newLoads.map((load) => load.label).join(", ") || null,
      calculatedAmps: result.amps,
      loadPct: result.loadPct,
      fits: result.fits,
      qualifies: true,
      inputJson: JSON.stringify({ input: calcInput, newLoads }),
      resultJson: JSON.stringify(result),
      sourceInspectionId: input.inspectionId,
      // P031: the generator recommendation rides the same row so the account
      // shows one calculation history — and so issuing an estimate can find it.
      generatorJson: input.loadCalc.generator !== undefined
        ? JSON.stringify(input.loadCalc.generator)
        : null,
    };

    await prisma.capacityCheck.upsert({
      where: { id },
      create: { id, ...data },
      update: data,
    });
    return { id };
  } catch (error) {
    console.error("[capacityCheckStore] Could not derive a capacity check from the record:", error);
    return null;
  }
}
