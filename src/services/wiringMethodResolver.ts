/**
 * Wiring Method Resolver
 *
 * Deterministic engine that selects the correct wiring method (cable type, gauge, conduit)
 * from circuit parameters. Estimator NEVER sees wire/conductor/conduit selection.
 *
 * Inputs:
 *   - occupancyType: 'residential' | 'commercial'  (from Property)
 *   - environment:   'interior' | 'exterior' | 'underground'
 *   - exposure:      'concealed' | 'exposed'
 *   - voltage:       120 | 240
 *   - amperage:      15 | 20 | 30 | 40 | 50 (branch) | higher (feeder)
 *   - cableLength:   linear feet (required)
 *
 * Outputs:
 *   - wiringMethod:      human-readable label ('NM-B 12/2', 'MC 12/2', 'EMT ¾" + THHN', etc.)
 *   - cableCode:         atomic unit code ('WIR-002', 'WIR-008', 'CON-001', etc.)
 *   - laborHrs:          total cable/conduit labor hours
 *   - laborCost:         labor at $90/hr (NECA helper rate)
 *   - materialCost:      cable/conduit material cost (markup applied downstream)
 *   - breakerMaterialCost: dynamic breaker cost for circuit unit
 *
 * Resolution rules (Phase 1 — residential only):
 *
 *   Residential + Interior + Concealed:
 *     → NM-B (Romex), gauge by amperage
 *   Residential + Interior + Exposed:
 *     → MC cable (metal-clad), ¾" EMT acceptable but MC preferred in residential
 *   Residential + Exterior + * :
 *     → UF cable or MC (UF if direct-burial, MC if surface)
 *   Residential + Underground:
 *     → UF direct-burial
 *   Feeder circuits:
 *     → SER cable (same-building) or UF (detached/underground)
 *   Commercial + * :
 *     → Interface built, residential fallback for Phase 1
 *       (Phase 2: EMT + THHN for commercial interior/exposed)
 */

import type { PrismaClient } from "@prisma/client";

const CABLE_LABOR_RATE = 90; // $90/hr — NECA helper rate for cable routing

// ─── Cable specs by code ──────────────────────────────────────────────────────

type CableSpec = {
  code: string;       // WIR-001, WIR-002, etc.
  laborHrPerLF: number;
  materialCostPerLF: number;
  label: string;
};

const CABLE_SPECS: Record<string, CableSpec> = {
  "WIR-001": { code: "WIR-001", laborHrPerLF: 0.04, materialCostPerLF: 0.45, label: "NM-B 14/2" },
  "WIR-002": { code: "WIR-002", laborHrPerLF: 0.05, materialCostPerLF: 0.65, label: "NM-B 12/2" },
  "WIR-003": { code: "WIR-003", laborHrPerLF: 0.05, materialCostPerLF: 1.15, label: "NM-B 12/3" },
  "WIR-004": { code: "WIR-004", laborHrPerLF: 0.05, materialCostPerLF: 0.90, label: "NM-B 10/2" },
  "WIR-005": { code: "WIR-005", laborHrPerLF: 0.06, materialCostPerLF: 1.10, label: "NM-B 10/3" },
  "WIR-006": { code: "WIR-006", laborHrPerLF: 0.07, materialCostPerLF: 1.70, label: "NM-B 6/2" },
  "WIR-007": { code: "WIR-007", laborHrPerLF: 0.07, materialCostPerLF: 2.00, label: "NM-B 6/3" },
  "WIR-008": { code: "WIR-008", laborHrPerLF: 0.06, materialCostPerLF: 0.85, label: "MC 12/2" },
  "WIR-009": { code: "WIR-009", laborHrPerLF: 0.08, materialCostPerLF: 4.50, label: "SER 2/0" },
  "WIR-010": { code: "WIR-010", laborHrPerLF: 0.10, materialCostPerLF: 3.75, label: "UF / Direct-Burial" },
  "WIR-011": { code: "WIR-011", laborHrPerLF: 0.02, materialCostPerLF: 0.12, label: "Low-Voltage 18/2" },
  "CON-001": { code: "CON-001", laborHrPerLF: 0.06, materialCostPerLF: 1.12, label: "EMT ¾\"" },
  "CON-002": { code: "CON-002", laborHrPerLF: 0.07, materialCostPerLF: 1.45, label: "EMT 1\"" },
  "CON-003": { code: "CON-003", laborHrPerLF: 0.05, materialCostPerLF: 0.84, label: "PVC ¾\"" },
  "CON-004": { code: "CON-004", laborHrPerLF: 0.06, materialCostPerLF: 1.00, label: "PVC 1\"" },
  "CON-005": { code: "CON-005", laborHrPerLF: 0.07, materialCostPerLF: 1.00, label: "Liquidtight Flex ¾\"" },
};

// ─── Breaker cost by amperage ─────────────────────────────────────────────────

const BREAKER_COST: Record<number, Record<"single" | "double", number>> = {
  15:  { single: 12, double: 35 },
  20:  { single: 18, double: 40 },
  30:  { single: 25, double: 55 },
  40:  { single: 30, double: 70 },
  50:  { single: 35, double: 90 },
  60:  { single: 40, double: 120 },
  100: { single: 65, double: 165 },
  125: { single: 80, double: 200 },
  150: { single: 95, double: 240 },
  200: { single: 120, double: 300 },
};

// ─── NM-B gauge selection (residential concealed interior) ────────────────────
// Maps [voltage, amperage] → WIR code

function resolveNMBGauge(
  voltage: 120 | 240,
  amperage: number,
  needsThreeWire: boolean
): string {
  if (voltage === 120) {
    if (amperage <= 15) return "WIR-001"; // 14/2
    return "WIR-002";                     // 12/2 (20A)
  }
  // 240V
  if (amperage <= 20) return "WIR-002";   // 12/2
  if (amperage <= 30)  return needsThreeWire ? "WIR-005" : "WIR-004"; // 10/3 or 10/2
  if (amperage <= 50)  return needsThreeWire ? "WIR-007" : "WIR-006"; // 6/3 or 6/2
  return "WIR-009"; // SER for larger feeders
}

// ─── Resolution logic ─────────────────────────────────────────────────────────

export type ResolveCableInput = {
  occupancyType: "residential" | "commercial";
  environment: "interior" | "exterior" | "underground";
  exposure: "concealed" | "exposed";
  voltage: 120 | 240;
  amperage: number;
  cableLength: number;           // linear feet
  needsThreeWire?: boolean;      // true for dryer (10/3, 6/3), range (6/3)
  resolverGroup?: string;        // 'branch_circuit' | 'feeder_circuit' | 'service'
};

export type ResolveCableResult = {
  wiringMethod: string;          // human label shown nowhere (stored for audit)
  cableCode: string;             // WIR-xxx or CON-xxx
  cableLaborHrs: number;
  cableLaborCost: number;        // @ $90/hr
  cableMaterialCost: number;     // before markup
  breakerMaterialCost: number;   // dynamic breaker cost
};

export function resolveWiringMethod(input: ResolveCableInput): ResolveCableResult {
  const { occupancyType, environment, exposure, voltage, amperage, cableLength, needsThreeWire = false, resolverGroup } = input;

  // ── Feeder / service cable ───────────────────────────────────────────────
  if (resolverGroup === "feeder_circuit" || resolverGroup === "service") {
    // Same-building feeder: SER cable
    // Detached / underground: UF
    const isUnderground = environment === "underground";
    const spec = isUnderground ? CABLE_SPECS["WIR-010"] : CABLE_SPECS["WIR-009"];
    return buildResult(spec, cableLength, voltage, amperage, "double");
  }

  // ── Branch circuit: underground ──────────────────────────────────────────
  if (environment === "underground") {
    const spec = CABLE_SPECS["WIR-010"]; // UF cable
    return buildResult(spec, cableLength, voltage, amperage, voltage === 120 ? "single" : "double");
  }

  // ── Residential ──────────────────────────────────────────────────────────
  if (occupancyType === "residential") {
    if (environment === "interior" && exposure === "concealed") {
      // NM-B (Romex) — standard residential concealed
      const cableCode = resolveNMBGauge(voltage, amperage, needsThreeWire);
      const spec = CABLE_SPECS[cableCode];
      return buildResult(spec, cableLength, voltage, amperage, voltage === 120 ? "single" : "double");
    }

    if (environment === "interior" && exposure === "exposed") {
      // MC cable for residential exposed interior
      const spec = CABLE_SPECS["WIR-008"];
      return buildResult(spec, cableLength, voltage, amperage, voltage === 120 ? "single" : "double");
    }

    if (environment === "exterior") {
      // UF for exterior / direct-burial capable
      const spec = CABLE_SPECS["WIR-010"];
      return buildResult(spec, cableLength, voltage, amperage, voltage === 120 ? "single" : "double");
    }
  }

  // ── Commercial (Phase 1 fallback — uses residential until Phase 2) ────────
  // Phase 2: EMT + THHN for commercial interior/exposed
  // For now, fall through to the same residential logic
  if (environment === "interior" && exposure === "concealed") {
    const cableCode = resolveNMBGauge(voltage, amperage, needsThreeWire);
    const spec = CABLE_SPECS[cableCode];
    return buildResult(spec, cableLength, voltage, amperage, voltage === 120 ? "single" : "double");
  }

  if (environment === "interior" && exposure === "exposed") {
    const spec = CABLE_SPECS["CON-001"]; // EMT ¾" as commercial default
    return buildResult(spec, cableLength, voltage, amperage, voltage === 120 ? "single" : "double");
  }

  // Fallback: NM-B 12/2 for anything unmatched
  const spec = CABLE_SPECS["WIR-002"];
  return buildResult(spec, cableLength, voltage, amperage, voltage === 120 ? "single" : "double");
}

function buildResult(
  spec: CableSpec,
  cableLength: number,
  voltage: 120 | 240,
  amperage: number,
  poleType: "single" | "double"
): ResolveCableResult {
  const cableLaborHrs = parseFloat((spec.laborHrPerLF * cableLength).toFixed(4));
  const cableLaborCost = parseFloat((cableLaborHrs * CABLE_LABOR_RATE).toFixed(2));
  const cableMaterialCost = parseFloat((spec.materialCostPerLF * cableLength).toFixed(2));
  const breakerCost = BREAKER_COST[amperage]?.[poleType] ?? BREAKER_COST[20][poleType];

  return {
    wiringMethod: spec.label,
    cableCode: spec.code,
    cableLaborHrs,
    cableLaborCost,
    cableMaterialCost,
    breakerMaterialCost: breakerCost,
  };
}

// ─── Convenience: resolve from EstimateItem fields ───────────────────────────

export type ItemResolverInput = {
  occupancyType: "residential" | "commercial";
  environment: string | null;
  exposure: string | null;
  circuitVoltage: number | null;
  circuitAmperage: number | null;
  cableLength: number | null;
  resolverGroupId: string | null;
  needsThreeWire: boolean | null;
};

export type ItemResolverResult = ResolveCableResult | null;

export function resolveItemCable(input: ItemResolverInput): ItemResolverResult {
  const { occupancyType, environment, exposure, circuitVoltage, circuitAmperage, cableLength, resolverGroupId, needsThreeWire } = input;

  if (!circuitVoltage || !circuitAmperage || !cableLength) return null;
  if (!environment || !exposure) return null;

  const voltage = (circuitVoltage === 240 ? 240 : 120) as 120 | 240;
  const envTyped = (["interior", "exterior", "underground"].includes(environment)
    ? environment
    : "interior") as "interior" | "exterior" | "underground";
  const expTyped = (["concealed", "exposed"].includes(exposure)
    ? exposure
    : "concealed") as "concealed" | "exposed";

  return resolveWiringMethod({
    occupancyType: occupancyType === "commercial" ? "commercial" : "residential",
    environment: envTyped,
    exposure: expTyped,
    voltage,
    amperage: circuitAmperage,
    cableLength,
    needsThreeWire: needsThreeWire ?? undefined,
    resolverGroup: resolverGroupId ?? undefined,
  });
}
