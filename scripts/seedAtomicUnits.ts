/**
 * Seed: Atomic Units (CSV-driven), Modifier Definitions, NEC Rules, Presets, Job Types
 *
 * System B Migration — loads ~442 atomic units from three CSV catalog files
 * instead of the previous 79 hardcoded System A units.
 *
 * Architecture (locked decisions):
 * - System B codes: LINE (panels/service/breakers/grounding), RI (rough-in boxes/cable),
 *   TRIM (devices/fixtures/specialty), DM (demo), PNL (panel ops), AC (access),
 *   CM (circuit mods), SF (surface), DIAG/TR/INS (service catalog)
 * - Three CSV catalogs: new_work_catalog.csv, old_work_catalog.csv, service_catalog.csv
 * - Catalog field values: "shared" (LINE & TRIM — identical in both new/old work),
 *   "new_work" (RI items for open-framing), "old_work" (RI items for finished-space,
 *   plus DEMO/PANEL/ACCESS/CIRCUIT-MOD/SURFACE), "service" (DIAG/TROUBLE/INSPECT)
 * - Tier 1: user-facing units (panels, breakers, devices, fixtures, boxes, etc.)
 * - Tier 2: conditional units (service equipment LINE-011–013, grounding LINE-014–018)
 * - Tier 3: system-only (cable/conduit runs per LF — hidden, resolved by system)
 * - $90/hr for LF cable/conduit items in RI and LINE sections
 * - $115/hr for all other labor
 * - Condition modifier: open (0.85x), retrofit (1.00x default), obstructed (1.20x)
 * - Occupancy/Schedule at estimate level; Access/Height/Condition at item level
 */

import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import path from "path";

const prisma = new PrismaClient();

// ─── TYPES ──────────────────────────────────────────────────────────────────────

type CsvRow = {
  section: string;
  code: string;
  name: string;
  unit: string;
  laborHrs: string;
  materialCost: string;
  description: string;
  source: "new_work" | "old_work" | "service";
  rowIndex: number;
};

type AtomicUnitInput = {
  code: string;
  catalog: string;
  category: string;
  name: string;
  description: string;
  unitType: string;
  visibilityTier: number;
  baseLaborHrs: number;
  baseLaborRate: number;
  baseMaterialCost: number;
  requiresCableLength: boolean;
  sortOrder: number;
};

// ─── CSV PARSER ─────────────────────────────────────────────────────────────────

/** Parse a single CSV line, handling quoted fields that may contain commas. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        // Escaped quote ("") inside quoted field
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

/** Read and parse a CSV catalog file. Skips the header row and NOTES rows (Code = "---"). */
function parseCsv(
  filePath: string,
  source: "new_work" | "old_work" | "service"
): CsvRow[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows: CsvRow[] = [];

  // Skip header row (index 0)
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 6) continue;

    const section = (fields[0] || "").trim();
    const code = (fields[1] || "").trim();
    const name = (fields[2] || "").trim();
    const unit = (fields[3] || "").trim();
    const laborHrs = (fields[4] || "").trim();
    const materialCost = (fields[5] || "").trim();
    const description = (fields[6] || "").trim();

    // Skip NOTES rows
    if (code === "---") continue;

    rows.push({
      section,
      code,
      name,
      unit,
      laborHrs,
      materialCost,
      description,
      source,
      rowIndex: i - 1,
    });
  }

  return rows;
}

// ─── CATALOG & CLASSIFICATION HELPERS ───────────────────────────────────────────

const SHARED_SECTIONS = new Set(["LINE", "TRIM"]);
const OLD_WORK_SECTIONS = new Set([
  "DEMO",
  "PANEL",
  "ACCESS",
  "CIRCUIT-MOD",
  "SURFACE",
]);
const SERVICE_SECTIONS = new Set(["DIAG", "TROUBLE", "INSPECT"]);

/** Determine catalog value for a given CSV section and source file. */
function getCatalog(
  section: string,
  source: "new_work" | "old_work" | "service"
): string {
  if (SHARED_SECTIONS.has(section)) return "shared";
  if (OLD_WORK_SECTIONS.has(section)) return "old_work";
  if (SERVICE_SECTIONS.has(section)) return "service";
  // ROUGH-IN items differ between new_work and old_work
  if (section === "ROUGH-IN") return source;
  return source;
}

/** Normalize CSV Section column to category enum: ROUGH-IN → ROUGH_IN, CIRCUIT-MOD → CIRCUIT_MOD */
function normalizeCategory(section: string): string {
  return section.replace(/-/g, "_");
}

/** LINE codes that are Tier 2: service equipment (011-013) and grounding (014-018). */
const TIER_2_LINE_CODES = new Set([
  "LINE-011",
  "LINE-012",
  "LINE-013",
  "LINE-014",
  "LINE-015",
  "LINE-016",
  "LINE-017",
  "LINE-018",
]);

/**
 * Determine visibility tier:
 * - Tier 2: LINE service equipment (011-013) and grounding (014-018)
 * - Tier 3: RI cable/conduit runs (LF items), LINE conductors (LF items)
 * - Tier 1: everything else (panels, breakers, devices, fixtures, boxes, etc.)
 */
function getVisibilityTier(
  code: string,
  section: string,
  unitType: string
): number {
  // Tier 2 check first — LINE-016 is LF but belongs to grounding (Tier 2, not Tier 3)
  if (TIER_2_LINE_CODES.has(code)) return 2;

  // Tier 3: LF items in ROUGH-IN and LINE sections (cable runs, conduit, conductors)
  if (unitType === "LF" && (section === "ROUGH-IN" || section === "LINE"))
    return 3;

  // Tier 1: everything else
  return 1;
}

/**
 * Base labor rate:
 * - $90/hr for cable/conduit LF items in RI and LINE sections
 * - $115/hr for all other labor
 */
function getBaseLaborRate(section: string, unitType: string): number {
  if (unitType === "LF" && (section === "ROUGH-IN" || section === "LINE"))
    return 90;
  return 115;
}

/** Parse material cost, treating "---" or empty as 0. */
function parseMaterialCost(val: string): number {
  if (!val || val === "---" || val === "") return 0;
  const parsed = parseFloat(val);
  return isNaN(parsed) ? 0 : parsed;
}

/** Build an AtomicUnitInput from a parsed CSV row. */
function buildAtomicUnit(row: CsvRow, catalog: string): AtomicUnitInput {
  const unitType = row.unit;
  return {
    code: row.code,
    catalog,
    category: normalizeCategory(row.section),
    name: row.name,
    description: row.description,
    unitType,
    baseLaborHrs: parseFloat(row.laborHrs) || 0,
    baseLaborRate: getBaseLaborRate(row.section, unitType),
    baseMaterialCost: parseMaterialCost(row.materialCost),
    visibilityTier: getVisibilityTier(row.code, row.section, unitType),
    requiresCableLength: unitType === "LF",
    sortOrder: row.rowIndex,
  };
}

// ─── LOAD ATOMIC UNITS FROM CSV FILES ───────────────────────────────────────────

function loadAtomicUnits(): AtomicUnitInput[] {
  // CSV files are at the workspace root (parent of app/)
  const csvDir = path.resolve(__dirname, "../..");
  const newWorkPath = path.join(csvDir, "new_work_catalog.csv");
  const oldWorkPath = path.join(csvDir, "old_work_catalog.csv");
  const servicePath = path.join(csvDir, "service_catalog.csv");

  const newWorkRows = parseCsv(newWorkPath, "new_work");
  const oldWorkRows = parseCsv(oldWorkPath, "old_work");
  const serviceRows = parseCsv(servicePath, "service");

  console.log(
    `  CSV rows parsed — new_work: ${newWorkRows.length}, old_work: ${oldWorkRows.length}, service: ${serviceRows.length}`
  );

  // Build unified map keyed by "${catalog}:${code}".
  // Process new_work first, then old_work (overwrites shared items with old_work's
  // more generic names — e.g. TRIM-ASD items without "(New Work)" qualifier),
  // then service.
  // For RI items, new_work and old_work produce different catalog keys
  // (new_work:RI-xxx vs old_work:RI-xxx), so both are kept.
  const itemMap = new Map<string, AtomicUnitInput>();

  for (const row of newWorkRows) {
    const catalog = getCatalog(row.section, row.source);
    const key = `${catalog}:${row.code}`;
    itemMap.set(key, buildAtomicUnit(row, catalog));
  }

  for (const row of oldWorkRows) {
    const catalog = getCatalog(row.section, row.source);
    const key = `${catalog}:${row.code}`;
    // Shared items: overwrite with old_work data (more generic names)
    // Old_work-only sections (DEMO, PANEL, ACCESS, CIRCUIT-MOD, SURFACE): add new
    // RI items: different key from new_work RI items, so both kept
    itemMap.set(key, buildAtomicUnit(row, catalog));
  }

  for (const row of serviceRows) {
    const catalog = getCatalog(row.section, row.source);
    const key = `${catalog}:${row.code}`;
    itemMap.set(key, buildAtomicUnit(row, catalog));
  }

  return Array.from(itemMap.values());
}

// ─── MODIFIER DEFINITIONS ───────────────────────────────────────────────────────
// Unchanged from System A

type ModifierInput = {
  modifierType: string;
  value: string;
  label: string;
  laborMultiplier: number;
  materialMult: number;
  appliesTo: string; // ITEM | ESTIMATE
  sortOrder: number;
  isDefault: boolean;
};

const MODIFIER_DEFS: ModifierInput[] = [
  // ACCESS (per item)
  { modifierType: "ACCESS", value: "NORMAL", label: "Normal Access", laborMultiplier: 1.00, materialMult: 1.00, appliesTo: "ITEM", sortOrder: 1, isDefault: true },
  { modifierType: "ACCESS", value: "DIFFICULT", label: "Difficult Access", laborMultiplier: 1.25, materialMult: 1.00, appliesTo: "ITEM", sortOrder: 2, isDefault: false },
  { modifierType: "ACCESS", value: "VERY_DIFFICULT", label: "Very Difficult Access", laborMultiplier: 1.50, materialMult: 1.00, appliesTo: "ITEM", sortOrder: 3, isDefault: false },

  // HEIGHT (per item)
  { modifierType: "HEIGHT", value: "STANDARD", label: "Standard Height (≤10 ft)", laborMultiplier: 1.00, materialMult: 1.00, appliesTo: "ITEM", sortOrder: 1, isDefault: true },
  { modifierType: "HEIGHT", value: "LADDER", label: "Ladder Work (10–14 ft)", laborMultiplier: 1.10, materialMult: 1.00, appliesTo: "ITEM", sortOrder: 2, isDefault: false },
  { modifierType: "HEIGHT", value: "HIGH_WORK", label: "High Work (>14 ft)", laborMultiplier: 1.25, materialMult: 1.00, appliesTo: "ITEM", sortOrder: 3, isDefault: false },

  // CONDITION (per item)
  { modifierType: "CONDITION", value: "OPEN", label: "Open (new construction / open framing)", laborMultiplier: 0.85, materialMult: 1.00, appliesTo: "ITEM", sortOrder: 1, isDefault: false },
  { modifierType: "CONDITION", value: "RETROFIT", label: "Retrofit (finished space — baseline)", laborMultiplier: 1.00, materialMult: 1.00, appliesTo: "ITEM", sortOrder: 2, isDefault: true },
  { modifierType: "CONDITION", value: "OBSTRUCTED", label: "Obstructed (attic, crawl, tight chase)", laborMultiplier: 1.20, materialMult: 1.00, appliesTo: "ITEM", sortOrder: 3, isDefault: false },

  // OCCUPANCY (estimate-level)
  { modifierType: "OCCUPANCY", value: "VACANT", label: "Vacant", laborMultiplier: 1.00, materialMult: 1.00, appliesTo: "ESTIMATE", sortOrder: 1, isDefault: false },
  { modifierType: "OCCUPANCY", value: "OCCUPIED", label: "Occupied", laborMultiplier: 1.15, materialMult: 1.00, appliesTo: "ESTIMATE", sortOrder: 2, isDefault: true },

  // SCHEDULE (estimate-level)
  { modifierType: "SCHEDULE", value: "NORMAL", label: "Normal Hours", laborMultiplier: 1.00, materialMult: 1.00, appliesTo: "ESTIMATE", sortOrder: 1, isDefault: true },
  { modifierType: "SCHEDULE", value: "AFTER_HOURS", label: "After-Hours", laborMultiplier: 1.50, materialMult: 1.00, appliesTo: "ESTIMATE", sortOrder: 2, isDefault: false },
  { modifierType: "SCHEDULE", value: "EMERGENCY", label: "Emergency Call", laborMultiplier: 2.00, materialMult: 1.00, appliesTo: "ESTIMATE", sortOrder: 3, isDefault: false },
];

// ─── NEC RULES ──────────────────────────────────────────────────────────────────
// Updated to System B codes

type NECRuleInput = {
  ruleCode: string;
  necArticle: string;
  triggerCondition: string; // JSON string
  promptText: string;
  severity: string; // REQUIRED | RECOMMENDED | ADVISORY
  sortOrder: number;
};

const NEC_RULES: NECRuleInput[] = [
  {
    ruleCode: "NEC-210.8-A",
    necArticle: "210.8(A)",
    triggerCondition: JSON.stringify({
      location_contains: ["kitchen", "bath", "garage", "outdoor", "exterior"],
    }),
    promptText:
      "GFCI protection required for receptacles in this location. " +
      "Add GFCI receptacle (TRIM-D03/D04 or TRIM-T03/T04) or GFCI breaker (LINE-023/024).",
    severity: "REQUIRED",
    sortOrder: 10,
  },
  {
    ruleCode: "NEC-210.11-C1",
    necArticle: "210.11(C)(1)",
    triggerCondition: JSON.stringify({
      location_contains: ["kitchen"],
    }),
    promptText:
      "Minimum 2 small-appliance branch circuits required in kitchen. Verify circuit count.",
    severity: "REQUIRED",
    sortOrder: 20,
  },
  {
    ruleCode: "NEC-210.11-C2",
    necArticle: "210.11(C)(2)",
    triggerCondition: JSON.stringify({
      location_contains: ["laundry", "washer"],
    }),
    promptText:
      "Dedicated laundry circuit required. Verify 20A circuit is on estimate.",
    severity: "REQUIRED",
    sortOrder: 30,
  },
  {
    ruleCode: "NEC-210.12",
    necArticle: "210.12(A)",
    triggerCondition: JSON.stringify({
      location_contains: ["bedroom"],
    }),
    promptText:
      "AFCI protection required for bedroom circuits. " +
      "Add AFCI breaker (LINE-021/022) or dual-function breaker (LINE-025/026).",
    severity: "REQUIRED",
    sortOrder: 40,
  },
  {
    ruleCode: "NEC-230.71",
    necArticle: "230.71",
    triggerCondition: JSON.stringify({
      units_present: [
        "LINE-001", "LINE-001A",
        "LINE-002", "LINE-002A", "LINE-002B",
        "LINE-006", "LINE-011",
      ],
    }),
    promptText:
      "Service entrance work detected. Verify exterior disconnect (LINE-012) is included if required.",
    severity: "RECOMMENDED",
    sortOrder: 50,
  },
  {
    ruleCode: "NEC-250.50",
    necArticle: "250.50",
    triggerCondition: JSON.stringify({
      units_present: [
        "LINE-001", "LINE-001A",
        "LINE-002", "LINE-002A", "LINE-002B",
        "LINE-003", "LINE-003A", "LINE-003B",
        "LINE-004", "LINE-004A",
        "LINE-005", "LINE-005A",
        "LINE-006",
      ],
    }),
    promptText:
      "Panel or service work detected. Grounding electrode system required — " +
      "add ground rod (LINE-014), clamp (LINE-015), and conductor (LINE-016) if not existing.",
    severity: "REQUIRED",
    sortOrder: 60,
  },
  {
    ruleCode: "NEC-250.104",
    necArticle: "250.104",
    triggerCondition: JSON.stringify({
      location_contains: ["water heater", "gas"],
    }),
    promptText:
      "Bonding of metal water piping required. Verify water pipe bond clamp (LINE-017) is on estimate.",
    severity: "REQUIRED",
    sortOrder: 70,
  },
  {
    ruleCode: "NEC-285.1",
    necArticle: "285",
    triggerCondition: JSON.stringify({
      units_present: [
        "LINE-001", "LINE-001A",
        "LINE-002", "LINE-002A", "LINE-002B",
      ],
    }),
    promptText:
      "Panel replacement / new service — SPD recommended (required per 2020 NEC). Add LINE-034 (SPD)?",
    severity: "RECOMMENDED",
    sortOrder: 80,
  },
  {
    ruleCode: "NEC-406.12",
    necArticle: "406.12",
    triggerCondition: JSON.stringify({
      units_present: ["TRIM-D01", "TRIM-D02", "TRIM-T01", "TRIM-T02"],
    }),
    promptText:
      "Tamper-resistant receptacles required in dwelling units per 406.12.",
    severity: "ADVISORY",
    sortOrder: 90,
  },
  {
    ruleCode: "NEC-680.21",
    necArticle: "680.21",
    triggerCondition: JSON.stringify({
      units_present: ["TRIM-038"],
    }),
    promptText:
      "GFCI protection required for pool/spa circuits. Verify GFCI disconnect (TRIM-038) is in scope.",
    severity: "REQUIRED",
    sortOrder: 100,
  },
  {
    ruleCode: "NEC-680.26",
    necArticle: "680.26",
    triggerCondition: JSON.stringify({
      units_present: ["TRIM-038"],
    }),
    promptText:
      "Equipotential bonding required for pool/spa. Verify bonding clamp (LINE-017) is on estimate.",
    severity: "REQUIRED",
    sortOrder: 110,
  },
];

// ─── PRESETS ────────────────────────────────────────────────────────────────────
// Updated to System B codes

type PresetItem = {
  unitCode: string;
  quantity: number;
  notes?: string;
};

type PresetInput = {
  name: string;
  description?: string;
  category?: string;
  items: PresetItem[];
  sortOrder: number;
};

const PRESETS: PresetInput[] = [
  {
    name: "Service Upgrade — Standard",
    description:
      "Full residential service upgrade: 200A panel, meter base, grounding, SPD.",
    category: "service",
    items: [
      { unitCode: "LINE-002", quantity: 1, notes: "200A main breaker panel mount" },
      { unitCode: "LINE-006", quantity: 1, notes: "200A meter base mount" },
      { unitCode: "LINE-014", quantity: 2, notes: "Ground rods (2 required)" },
      { unitCode: "LINE-015", quantity: 2, notes: "Ground rod clamps" },
      { unitCode: "LINE-016", quantity: 15, notes: "Ground rod conductor (bare Cu) — 15 LF" },
      { unitCode: "LINE-034", quantity: 1, notes: "Surge protective device (SPD)" },
    ],
    sortOrder: 10,
  },
  {
    name: "EV Charger Install",
    description: "Level 2 EV charger: 50A breaker + EVSE mount. Cable run priced separately.",
    category: "equipment",
    items: [
      { unitCode: "LINE-030", quantity: 1, notes: "50A 240V 2-pole breaker" },
      { unitCode: "TRIM-029", quantity: 1, notes: "EV charger (EVSE) mount + connect" },
    ],
    sortOrder: 20,
  },
  {
    name: "Subpanel — New Detached Structure",
    description:
      "Power for garage or outbuilding: subpanel + grounding. Feeder cable priced separately.",
    category: "service",
    items: [
      { unitCode: "LINE-009", quantity: 1, notes: "100A subpanel mount" },
      { unitCode: "LINE-014", quantity: 2, notes: "Ground rods (2 required)" },
      { unitCode: "LINE-015", quantity: 2, notes: "Ground rod clamps" },
      { unitCode: "LINE-016", quantity: 15, notes: "Ground rod conductor (bare Cu) — 15 LF" },
    ],
    sortOrder: 30,
  },
  {
    name: "Bathroom Remodel",
    description:
      "Typical bathroom: GFCI receptacle + vanity light + exhaust fan.",
    category: "remodel",
    items: [
      { unitCode: "TRIM-D03", quantity: 1, notes: "15A GFCI Decora receptacle" },
      { unitCode: "TRIM-ASD25", quantity: 1, notes: "ASD 18 in vanity light" },
      { unitCode: "TRIM-025", quantity: 1, notes: "Bathroom exhaust fan (client-supplied)" },
    ],
    sortOrder: 40,
  },
  {
    name: "Kitchen Remodel",
    description:
      "Kitchen update: GFCI receptacles + under-cabinet lighting. Circuit breakers priced separately.",
    category: "remodel",
    items: [
      { unitCode: "TRIM-D03", quantity: 4, notes: "GFCI receptacles (countertop)" },
      { unitCode: "TRIM-ASD29", quantity: 1, notes: "ASD 18 in under-cabinet LED" },
    ],
    sortOrder: 50,
  },
  {
    name: "Portable Generator Backup",
    description: "Generator inlet box + panel interlock kit.",
    category: "equipment",
    items: [
      { unitCode: "TRIM-035", quantity: 1, notes: "Generator inlet box" },
      { unitCode: "TRIM-036", quantity: 1, notes: "Interlock kit" },
    ],
    sortOrder: 60,
  },
];

// ─── JOB TYPES ──────────────────────────────────────────────────────────────────
// Unchanged from System A

type JobTypeInput = {
  name: string;
  description?: string;
  occupancyDefault: string;
  environmentDefault: string;
  exposureDefault: string;
  resolverProfileJson?: string;
  sortOrder: number;
};

const JOB_TYPES: JobTypeInput[] = [
  {
    name: "Residential Service / Repair",
    description: "Standard residential repair and service call.",
    occupancyDefault: "residential",
    environmentDefault: "interior",
    exposureDefault: "concealed",
    sortOrder: 10,
  },
  {
    name: "Residential Remodel",
    description: "Finished-space retrofit in occupied residential property.",
    occupancyDefault: "residential",
    environmentDefault: "interior",
    exposureDefault: "concealed",
    resolverProfileJson: JSON.stringify({ conditionDefault: "RETROFIT" }),
    sortOrder: 20,
  },
  {
    name: "Residential New Construction",
    description: "Open-framing new construction phase work.",
    occupancyDefault: "residential",
    environmentDefault: "interior",
    exposureDefault: "concealed",
    resolverProfileJson: JSON.stringify({ conditionDefault: "OPEN" }),
    sortOrder: 30,
  },
  {
    name: "Exterior / Detached Structure",
    description: "Outdoor, exterior-mounted, or detached structure work.",
    occupancyDefault: "residential",
    environmentDefault: "exterior",
    exposureDefault: "exposed",
    sortOrder: 40,
  },
  {
    name: "Commercial (Future)",
    description:
      "Commercial occupancy — resolver interface built, residential-only Phase 1.",
    occupancyDefault: "commercial",
    environmentDefault: "interior",
    exposureDefault: "concealed",
    resolverProfileJson: JSON.stringify({
      phase: "future",
      note: "Commercial resolver not yet implemented",
    }),
    sortOrder: 50,
  },
];

// ─── SEED FUNCTION ──────────────────────────────────────────────────────────────

async function seed() {
  console.log("Seeding atomic units from CSV catalogs...\n");

  // ── 1. Load atomic units from CSVs ──────────────────────────────────────────
  const atomicUnits = loadAtomicUnits();

  const tier1 = atomicUnits.filter((u) => u.visibilityTier === 1).length;
  const tier2 = atomicUnits.filter((u) => u.visibilityTier === 2).length;
  const tier3 = atomicUnits.filter((u) => u.visibilityTier === 3).length;
  const catalogs: Record<string, number> = {};
  for (const u of atomicUnits) {
    catalogs[u.catalog] = (catalogs[u.catalog] || 0) + 1;
  }
  console.log(
    `  Loaded ${atomicUnits.length} atomic units ` +
      `(Tier 1: ${tier1}, Tier 2: ${tier2}, Tier 3: ${tier3})`
  );
  console.log(
    `  Catalogs: ${Object.entries(catalogs)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`
  );

  // ── 2. Deactivate all existing AtomicUnit records ───────────────────────────
  // Preserves FK references from existing EstimateItems
  const deactivated = await prisma.atomicUnit.updateMany({
    data: { isActive: false },
  });
  console.log(`  Deactivated ${deactivated.count} existing atomic units`);

  // ── 3. Upsert each atomic unit ──────────────────────────────────────────────
  let upsertedUnits = 0;
  for (const unit of atomicUnits) {
    await prisma.atomicUnit.upsert({
      where: {
        catalog_code: { catalog: unit.catalog, code: unit.code },
      },
      update: {
        category: unit.category,
        name: unit.name,
        description: unit.description || null,
        unitType: unit.unitType,
        visibilityTier: unit.visibilityTier,
        baseLaborHrs: unit.baseLaborHrs,
        baseLaborRate: unit.baseLaborRate,
        baseMaterialCost: unit.baseMaterialCost,
        necRefsJson: null,
        necaSectionRef: null,
        requiresCableLength: unit.requiresCableLength,
        requiresEndpoint: false,
        resolverGroupId: null,
        sortOrder: unit.sortOrder,
        isActive: true,
      },
      create: {
        code: unit.code,
        catalog: unit.catalog,
        category: unit.category,
        name: unit.name,
        description: unit.description || null,
        unitType: unit.unitType,
        visibilityTier: unit.visibilityTier,
        baseLaborHrs: unit.baseLaborHrs,
        baseLaborRate: unit.baseLaborRate,
        baseMaterialCost: unit.baseMaterialCost,
        necRefsJson: null,
        necaSectionRef: null,
        requiresCableLength: unit.requiresCableLength,
        requiresEndpoint: false,
        resolverGroupId: null,
        sortOrder: unit.sortOrder,
        isActive: true,
      },
    });
    upsertedUnits++;
  }
  console.log(`  ✓ ${upsertedUnits} atomic units upserted`);

  // ── 4. Modifier definitions ─────────────────────────────────────────────────
  for (const mod of MODIFIER_DEFS) {
    await prisma.modifierDef.upsert({
      where: {
        modifierType_value: {
          modifierType: mod.modifierType,
          value: mod.value,
        },
      },
      update: {
        label: mod.label,
        laborMultiplier: mod.laborMultiplier,
        materialMult: mod.materialMult,
        appliesTo: mod.appliesTo,
        sortOrder: mod.sortOrder,
        isDefault: mod.isDefault,
      },
      create: {
        modifierType: mod.modifierType,
        value: mod.value,
        label: mod.label,
        laborMultiplier: mod.laborMultiplier,
        materialMult: mod.materialMult,
        appliesTo: mod.appliesTo,
        sortOrder: mod.sortOrder,
        isDefault: mod.isDefault,
      },
    });
  }
  console.log(`  ✓ ${MODIFIER_DEFS.length} modifier definitions`);

  // ── 5. NEC rules ────────────────────────────────────────────────────────────
  for (const rule of NEC_RULES) {
    await prisma.nECRule.upsert({
      where: { ruleCode: rule.ruleCode },
      update: {
        necArticle: rule.necArticle,
        triggerCondition: rule.triggerCondition,
        promptText: rule.promptText,
        severity: rule.severity,
        sortOrder: rule.sortOrder,
        isActive: true,
      },
      create: {
        ruleCode: rule.ruleCode,
        necArticle: rule.necArticle,
        triggerCondition: rule.triggerCondition,
        promptText: rule.promptText,
        severity: rule.severity,
        sortOrder: rule.sortOrder,
        isActive: true,
      },
    });
  }
  console.log(`  ✓ ${NEC_RULES.length} NEC rules`);

  // ── 6. Presets ──────────────────────────────────────────────────────────────
  for (const preset of PRESETS) {
    const existing = await prisma.preset.findFirst({
      where: { name: preset.name },
    });
    if (existing) {
      await prisma.preset.update({
        where: { id: existing.id },
        data: {
          description: preset.description ?? null,
          category: preset.category ?? null,
          itemsJson: JSON.stringify(preset.items),
          sortOrder: preset.sortOrder,
          isActive: true,
        },
      });
    } else {
      await prisma.preset.create({
        data: {
          name: preset.name,
          description: preset.description ?? null,
          category: preset.category ?? null,
          itemsJson: JSON.stringify(preset.items),
          sortOrder: preset.sortOrder,
          isActive: true,
        },
      });
    }
  }
  console.log(`  ✓ ${PRESETS.length} presets`);

  // ── 7. Job types ────────────────────────────────────────────────────────────
  for (const jt of JOB_TYPES) {
    await prisma.jobType.upsert({
      where: { name: jt.name },
      update: {
        description: jt.description ?? null,
        occupancyDefault: jt.occupancyDefault,
        environmentDefault: jt.environmentDefault,
        exposureDefault: jt.exposureDefault,
        resolverProfileJson: jt.resolverProfileJson ?? null,
        sortOrder: jt.sortOrder,
        isActive: true,
      },
      create: {
        name: jt.name,
        description: jt.description ?? null,
        occupancyDefault: jt.occupancyDefault,
        environmentDefault: jt.environmentDefault,
        exposureDefault: jt.exposureDefault,
        resolverProfileJson: jt.resolverProfileJson ?? null,
        sortOrder: jt.sortOrder,
        isActive: true,
      },
    });
  }
  console.log(`  ✓ ${JOB_TYPES.length} job types`);

  console.log("\nAtomic seed complete.");
}

seed()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
