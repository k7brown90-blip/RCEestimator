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
 *   - cableCode:         atomic unit code ('RI-012', 'RI-024', 'RI-044', 'LINE-042', etc.)
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
  code: string;       // RI-011, RI-012, etc. (new_work catalog codes)
  laborHrPerLF: number;
  materialCostPerLF: number;
  label: string;
};

const CABLE_SPECS: Record<string, CableSpec> = {
  // NM-B (Romex) — new work, interior concealed
  "RI-011": { code: "RI-011", laborHrPerLF: 0.005, materialCostPerLF: 0.40, label: "NM-B 14/2" },
  "RI-012": { code: "RI-012", laborHrPerLF: 0.006, materialCostPerLF: 0.50, label: "NM-B 12/2" },
  "RI-013": { code: "RI-013", laborHrPerLF: 0.006, materialCostPerLF: 0.65, label: "NM-B 14/3" },
  "RI-014": { code: "RI-014", laborHrPerLF: 0.007, materialCostPerLF: 0.75, label: "NM-B 12/3" },
  "RI-015": { code: "RI-015", laborHrPerLF: 0.007, materialCostPerLF: 0.80, label: "NM-B 10/2" },
  "RI-016": { code: "RI-016", laborHrPerLF: 0.008, materialCostPerLF: 1.00, label: "NM-B 10/3" },
  "RI-017": { code: "RI-017", laborHrPerLF: 0.008, materialCostPerLF: 1.20, label: "NM-B 8/2" },
  "RI-018": { code: "RI-018", laborHrPerLF: 0.009, materialCostPerLF: 1.50, label: "NM-B 8/3" },
  "RI-019": { code: "RI-019", laborHrPerLF: 0.010, materialCostPerLF: 1.60, label: "NM-B 6/2" },
  "RI-020": { code: "RI-020", laborHrPerLF: 0.011, materialCostPerLF: 1.90, label: "NM-B 6/3" },
  // MC Cable — exposed interior
  "RI-023": { code: "RI-023", laborHrPerLF: 0.007, materialCostPerLF: 0.70, label: "MC 14/2" },
  "RI-024": { code: "RI-024", laborHrPerLF: 0.008, materialCostPerLF: 0.85, label: "MC 12/2" },
  "RI-025": { code: "RI-025", laborHrPerLF: 0.009, materialCostPerLF: 1.30, label: "MC 12/3" },
  "RI-026": { code: "RI-026", laborHrPerLF: 0.009, materialCostPerLF: 1.00, label: "MC 10/2" },
  "RI-027": { code: "RI-027", laborHrPerLF: 0.010, materialCostPerLF: 1.50, label: "MC 10/3" },
  // UF-B — exterior / direct burial
  "RI-028": { code: "RI-028", laborHrPerLF: 0.012, materialCostPerLF: 0.85, label: "UF-B 12/2" },
  "RI-029": { code: "RI-029", laborHrPerLF: 0.013, materialCostPerLF: 1.20, label: "UF-B 10/2" },
  // Low-voltage
  "RI-030": { code: "RI-030", laborHrPerLF: 0.003, materialCostPerLF: 0.12, label: "Low-Voltage 18/2" },
  // SER / SEU cable (LINE section)
  "LINE-041": { code: "LINE-041", laborHrPerLF: 0.025, materialCostPerLF: 7.00, label: "SER 4/0" },
  "LINE-042": { code: "LINE-042", laborHrPerLF: 0.022, materialCostPerLF: 4.50, label: "SER 2/0" },
  "LINE-043": { code: "LINE-043", laborHrPerLF: 0.020, materialCostPerLF: 3.50, label: "SER 1/0" },
  // EMT Conduit — 1/2" through 4"
  "RI-043": { code: "RI-043", laborHrPerLF: 0.020, materialCostPerLF: 0.75, label: "EMT ½\"" },
  "RI-044": { code: "RI-044", laborHrPerLF: 0.025, materialCostPerLF: 1.00, label: "EMT ¾\"" },
  "RI-045": { code: "RI-045", laborHrPerLF: 0.030, materialCostPerLF: 1.45, label: "EMT 1\"" },
  "RI-046": { code: "RI-046", laborHrPerLF: 0.035, materialCostPerLF: 1.80, label: "EMT 1-1/4\"" },
  "RI-047": { code: "RI-047", laborHrPerLF: 0.040, materialCostPerLF: 2.25, label: "EMT 1-1/2\"" },
  "RI-048": { code: "RI-048", laborHrPerLF: 0.045, materialCostPerLF: 3.00, label: "EMT 2\"" },
  "RI-069": { code: "RI-069", laborHrPerLF: 0.055, materialCostPerLF: 4.50, label: "EMT 2-1/2\"" },
  "RI-070": { code: "RI-070", laborHrPerLF: 0.065, materialCostPerLF: 6.00, label: "EMT 3\"" },
  "RI-071": { code: "RI-071", laborHrPerLF: 0.075, materialCostPerLF: 7.75, label: "EMT 3-1/2\"" },
  "RI-072": { code: "RI-072", laborHrPerLF: 0.085, materialCostPerLF: 9.50, label: "EMT 4\"" },
  // PVC Conduit — 1/2" through 4"
  "RI-049": { code: "RI-049", laborHrPerLF: 0.018, materialCostPerLF: 0.55, label: "PVC ½\"" },
  "RI-050": { code: "RI-050", laborHrPerLF: 0.022, materialCostPerLF: 0.75, label: "PVC ¾\"" },
  "RI-051": { code: "RI-051", laborHrPerLF: 0.025, materialCostPerLF: 1.00, label: "PVC 1\"" },
  "RI-052": { code: "RI-052", laborHrPerLF: 0.030, materialCostPerLF: 1.20, label: "PVC 1-1/4\"" },
  "RI-053": { code: "RI-053", laborHrPerLF: 0.035, materialCostPerLF: 1.60, label: "PVC 1-1/2\"" },
  "RI-054": { code: "RI-054", laborHrPerLF: 0.040, materialCostPerLF: 2.15, label: "PVC 2\"" },
  "RI-073": { code: "RI-073", laborHrPerLF: 0.048, materialCostPerLF: 3.25, label: "PVC 2-1/2\"" },
  "RI-074": { code: "RI-074", laborHrPerLF: 0.055, materialCostPerLF: 4.50, label: "PVC 3\"" },
  "RI-075": { code: "RI-075", laborHrPerLF: 0.065, materialCostPerLF: 5.75, label: "PVC 3-1/2\"" },
  "RI-076": { code: "RI-076", laborHrPerLF: 0.075, materialCostPerLF: 7.00, label: "PVC 4\"" },
  // RMC Rigid Steel — 1/2" through 4"
  "RI-077": { code: "RI-077", laborHrPerLF: 0.035, materialCostPerLF: 2.00, label: "RMC ½\"" },
  "RI-055": { code: "RI-055", laborHrPerLF: 0.040, materialCostPerLF: 2.50, label: "RMC ¾\"" },
  "RI-056": { code: "RI-056", laborHrPerLF: 0.045, materialCostPerLF: 3.25, label: "RMC 1\"" },
  "RI-078": { code: "RI-078", laborHrPerLF: 0.050, materialCostPerLF: 4.25, label: "RMC 1-1/4\"" },
  "RI-079": { code: "RI-079", laborHrPerLF: 0.060, materialCostPerLF: 5.50, label: "RMC 1-1/2\"" },
  "RI-080": { code: "RI-080", laborHrPerLF: 0.070, materialCostPerLF: 7.00, label: "RMC 2\"" },
  "RI-081": { code: "RI-081", laborHrPerLF: 0.085, materialCostPerLF: 9.50, label: "RMC 2-1/2\"" },
  "RI-082": { code: "RI-082", laborHrPerLF: 0.100, materialCostPerLF: 12.50, label: "RMC 3\"" },
  "RI-083": { code: "RI-083", laborHrPerLF: 0.115, materialCostPerLF: 15.00, label: "RMC 3-1/2\"" },
  "RI-084": { code: "RI-084", laborHrPerLF: 0.130, materialCostPerLF: 18.00, label: "RMC 4\"" },
  // FMC Flex Steel — 1/2" through 2"
  "RI-057": { code: "RI-057", laborHrPerLF: 0.015, materialCostPerLF: 0.60, label: "FMC ½\"" },
  "RI-058": { code: "RI-058", laborHrPerLF: 0.018, materialCostPerLF: 0.85, label: "FMC ¾\"" },
  "RI-085": { code: "RI-085", laborHrPerLF: 0.022, materialCostPerLF: 1.20, label: "FMC 1\"" },
  "RI-086": { code: "RI-086", laborHrPerLF: 0.028, materialCostPerLF: 1.60, label: "FMC 1-1/4\"" },
  "RI-087": { code: "RI-087", laborHrPerLF: 0.032, materialCostPerLF: 2.00, label: "FMC 1-1/2\"" },
  "RI-088": { code: "RI-088", laborHrPerLF: 0.038, materialCostPerLF: 2.75, label: "FMC 2\"" },
  // LFMC Liquidtight — 1/2" through 2"
  "RI-059": { code: "RI-059", laborHrPerLF: 0.018, materialCostPerLF: 0.80, label: "LFMC ½\"" },
  "RI-060": { code: "RI-060", laborHrPerLF: 0.022, materialCostPerLF: 1.00, label: "LFMC ¾\"" },
  "RI-061": { code: "RI-061", laborHrPerLF: 0.025, materialCostPerLF: 1.40, label: "LFMC 1\"" },
  "RI-089": { code: "RI-089", laborHrPerLF: 0.030, materialCostPerLF: 1.80, label: "LFMC 1-1/4\"" },
  "RI-090": { code: "RI-090", laborHrPerLF: 0.035, materialCostPerLF: 2.25, label: "LFMC 1-1/2\"" },
  "RI-091": { code: "RI-091", laborHrPerLF: 0.042, materialCostPerLF: 3.00, label: "LFMC 2\"" },
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
    if (amperage <= 15) return "RI-011"; // 14/2
    return "RI-012";                     // 12/2 (20A)
  }
  // 240V
  if (amperage <= 20) return "RI-012";   // 12/2
  if (amperage <= 30)  return needsThreeWire ? "RI-016" : "RI-015"; // 10/3 or 10/2
  if (amperage <= 40)  return needsThreeWire ? "RI-018" : "RI-017"; // 8/3 or 8/2
  if (amperage <= 50)  return needsThreeWire ? "RI-020" : "RI-019"; // 6/3 or 6/2
  return "LINE-042"; // SER 2/0 for larger feeders
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
    const spec = isUnderground ? CABLE_SPECS["RI-028"] : CABLE_SPECS["LINE-042"];
    return buildResult(spec, cableLength, voltage, amperage, "double");
  }

  // ── Branch circuit: underground ──────────────────────────────────────────
  if (environment === "underground") {
    const spec = CABLE_SPECS["RI-028"]; // UF-B 12/2
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
      const spec = CABLE_SPECS["RI-024"]; // MC 12/2
      return buildResult(spec, cableLength, voltage, amperage, voltage === 120 ? "single" : "double");
    }

    if (environment === "exterior") {
      // UF-B for exterior / direct-burial capable
      const spec = CABLE_SPECS["RI-028"]; // UF-B 12/2
      return buildResult(spec, cableLength, voltage, amperage, voltage === 120 ? "single" : "double");
    }
  }

  // ── Commercial (Phase 1 fallback — uses residential until Phase 2) ────────
  if (environment === "interior" && exposure === "concealed") {
    const cableCode = resolveNMBGauge(voltage, amperage, needsThreeWire);
    const spec = CABLE_SPECS[cableCode];
    return buildResult(spec, cableLength, voltage, amperage, voltage === 120 ? "single" : "double");
  }

  if (environment === "interior" && exposure === "exposed") {
    const spec = CABLE_SPECS["RI-044"]; // EMT ¾" as commercial default
    return buildResult(spec, cableLength, voltage, amperage, voltage === 120 ? "single" : "double");
  }

  // Fallback: NM-B 12/2 for anything unmatched
  const spec = CABLE_SPECS["RI-012"];
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
