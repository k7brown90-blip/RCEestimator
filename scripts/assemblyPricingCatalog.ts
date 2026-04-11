type ComponentType = "material" | "labor" | "other";

type PricingComponent = {
  componentType: ComponentType;
  code: string;
  description: string;
  quantity: number;
  quantityExpr?: string;
  unit?: string;
  unitCost?: number;
  laborHours?: number;
  laborRate?: number;
};

export type AssemblyPricingEntry = {
  laborClass?: string;
  pricingType: "neca_informed" | "allowance_based" | "provisional";
  notes: string;
  components: PricingComponent[];
};

export const PRICING_VERSION = "phase2-a2-v1";
export const PRICING_EFFECTIVE_DATE = "2026-03-16";
export const DEFAULT_LABOR_RATE = 115;

// Phase 1 field-test pricing baseline: labor hours are NECA-informed first-pass values,
// material and allowance lines are practical residential allowances pending supplier pricing.
export const PHASE_1_PRICING: Record<number, AssemblyPricingEntry> = {
  1: {
    laborClass: "troubleshoot_diagnostic",
    pricingType: "allowance_based",
    notes: "Service-call minimum with truck/consumable allowance.",
    components: [
      { componentType: "labor", code: "LAB-1-DIAG", description: "Diagnostic troubleshooting labor", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "other", code: "OTH-1-TRAVEL", description: "Travel and consumables allowance", quantity: 1, unit: "ea", unitCost: 35 },
    ],
  },
  2: {
    laborClass: "troubleshoot_diagnostic",
    pricingType: "neca_informed",
    notes: "Additional diagnostic time block.",
    components: [
      { componentType: "labor", code: "LAB-2-ADDHR", description: "Additional diagnostic labor", quantity: 1, unit: "ea", laborHours: 1, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  3: {
    laborClass: "make_safe",
    pricingType: "allowance_based",
    notes: "Temporary make-safe actions with limited materials.",
    components: [
      { componentType: "material", code: "MAT-3-MSAF", description: "Temporary repair material allowance", quantity: 1, unit: "ea", unitCost: 35 },
      { componentType: "labor", code: "LAB-3-MSAF", description: "Make-safe labor", quantity: 1, unit: "ea", laborHours: 1.25, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  4: {
    laborClass: "remove_and_replace",
    pricingType: "neca_informed",
    notes: "Standard receptacle replacement.",
    components: [
      { componentType: "material", code: "MAT-4-REC", description: "Receptacle and plate", quantity: 1, unit: "ea", unitCost: 8 },
      { componentType: "labor", code: "LAB-4-REC", description: "Replace receptacle labor", quantity: 1, unit: "ea", laborHours: 0.35, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  5: {
    laborClass: "remove_and_replace",
    pricingType: "neca_informed",
    notes: "GFCI replacement device-level scope.",
    components: [
      { componentType: "material", code: "MAT-5-GFCI", description: "GFCI device and labels", quantity: 1, unit: "ea", unitCost: 28 },
      { componentType: "labor", code: "LAB-5-GFCI", description: "Replace GFCI labor", quantity: 1, unit: "ea", laborHours: 0.45, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  6: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Add receptacle from nearby source with explicit trim-out materials and selectable 15A/20A device rating.",
    components: [
      { componentType: "material", code: "MAT-6-BOX", description: "Single-gang old-work box", quantity: 1, unit: "ea", unitCost: 4 },
      { componentType: "material", code: "MAT-6-REC15", description: "15A duplex receptacle", quantity: 1, unit: "ea", unitCost: 2.5, quantityExpr: "device_15a_qty" },
      { componentType: "material", code: "MAT-6-REC20", description: "20A duplex receptacle", quantity: 1, unit: "ea", unitCost: 4, quantityExpr: "device_20a_qty" },
      { componentType: "material", code: "MAT-6-PLATE", description: "Faceplate", quantity: 1, unit: "ea", unitCost: 1.5 },
      { componentType: "material", code: "MAT-6-WNUT", description: "Wire connector set (3 wirenuts)", quantity: 1, unit: "set", unitCost: 1.5 },
      { componentType: "material", code: "MAT-6-FIT", description: "Cable fittings and fastening hardware", quantity: 1, unit: "ea", unitCost: 4 },
      { componentType: "material", code: "MAT-6-CABLE14", description: "14/2 NM-B cable", quantity: 1, unit: "lf", unitCost: 0.55, quantityExpr: "run_length_14_2" },
      { componentType: "material", code: "MAT-6-CABLE12", description: "12/2 NM-B cable", quantity: 1, unit: "lf", unitCost: 0.65, quantityExpr: "run_length_12_2" },
      { componentType: "labor", code: "LAB-6-BOX", description: "Cut-in box and rough-in", quantity: 1, unit: "ea", laborHours: 0.30, laborRate: 90 },
      { componentType: "labor", code: "LAB-6-ROUTE", description: "Cable route and fish labor", quantity: 1, unit: "lf", laborHours: 0.05, laborRate: 90, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-6-DEVICE", description: "Terminate receptacle, install plate, and test", quantity: 1, unit: "ea", laborHours: 0.25, laborRate: 90 },
    ],
  },
  7: {
    laborClass: "extend_from_existing",
    pricingType: "neca_informed",
    notes: "Relocate receptacle with explicit trim-out materials and selectable 15A/20A device rating.",
    components: [
      { componentType: "material", code: "MAT-7-BOX", description: "Single-gang old-work box", quantity: 1, unit: "ea", unitCost: 4 },
      { componentType: "material", code: "MAT-7-REC15", description: "15A duplex receptacle", quantity: 1, unit: "ea", unitCost: 2.5, quantityExpr: "device_15a_qty" },
      { componentType: "material", code: "MAT-7-REC20", description: "20A duplex receptacle", quantity: 1, unit: "ea", unitCost: 4, quantityExpr: "device_20a_qty" },
      { componentType: "material", code: "MAT-7-PLATE", description: "Faceplate", quantity: 1, unit: "ea", unitCost: 1.5 },
      { componentType: "material", code: "MAT-7-WNUT", description: "Wire connector set (3 wirenuts)", quantity: 1, unit: "set", unitCost: 1.5 },
      { componentType: "material", code: "MAT-7-FIT", description: "Cable fittings and fastening hardware", quantity: 1, unit: "ea", unitCost: 4 },
      { componentType: "material", code: "MAT-7-CABLE14", description: "14/2 NM-B cable", quantity: 1, unit: "lf", unitCost: 0.55, quantityExpr: "run_length_14_2" },
      { componentType: "material", code: "MAT-7-CABLE12", description: "12/2 NM-B cable", quantity: 1, unit: "lf", unitCost: 0.65, quantityExpr: "run_length_12_2" },
      { componentType: "labor", code: "LAB-7-DISCONNECT", description: "Disconnect existing device and prep relocation", quantity: 1, unit: "ea", laborHours: 0.25, laborRate: 90 },
      { componentType: "labor", code: "LAB-7-ROUTE", description: "Cable route and fish labor", quantity: 1, unit: "lf", laborHours: 0.05, laborRate: 90, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-7-BOX", description: "Cut-in relocated box and secure", quantity: 1, unit: "ea", laborHours: 0.30, laborRate: 90 },
      { componentType: "labor", code: "LAB-7-DEVICE", description: "Reconnect receptacle, install plate, and test", quantity: 1, unit: "ea", laborHours: 0.25, laborRate: 90 },
    ],
  },
  9: {
    laborClass: "remove_and_replace",
    pricingType: "neca_informed",
    notes: "Single-pole switch replacement.",
    components: [
      { componentType: "material", code: "MAT-9-SW", description: "Switch and plate", quantity: 1, unit: "ea", unitCost: 9 },
      { componentType: "labor", code: "LAB-9-SW", description: "Replace switch labor", quantity: 1, unit: "ea", laborHours: 0.35, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  10: {
    laborClass: "remove_and_replace",
    pricingType: "neca_informed",
    notes: "Three-way switch replacement.",
    components: [
      { componentType: "material", code: "MAT-10-3WAY", description: "3-way switch and trim", quantity: 1, unit: "ea", unitCost: 16 },
      { componentType: "labor", code: "LAB-10-3WAY", description: "Replace 3-way switch labor", quantity: 1, unit: "ea", laborHours: 0.50, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  11: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "New switch location with typical routing.",
    components: [
      { componentType: "material", code: "MAT-11-ADDSW", description: "Switch, box, cable and trim", quantity: 1, unit: "ea", unitCost: 65 },
      { componentType: "labor", code: "LAB-11-ADDSW", description: "Add switch labor", quantity: 1, unit: "ea", laborHours: 1.25, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  12: {
    laborClass: "remove_and_replace",
    pricingType: "allowance_based",
    notes: "Fixture replacement labor plus small hardware allowance.",
    components: [
      { componentType: "material", code: "MAT-12-FIXRPL", description: "Hardware/consumables allowance", quantity: 1, unit: "ea", unitCost: 18 },
      { componentType: "labor", code: "LAB-12-FIXRPL", description: "Replace fixture labor", quantity: 1, unit: "ea", laborHours: 0.9, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  13: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "New fixture rough/trim path on existing structure.",
    components: [
      { componentType: "material", code: "MAT-13-ADDLGT", description: "Box, cable, connectors and trim", quantity: 1, unit: "ea", unitCost: 95 },
      { componentType: "labor", code: "LAB-13-ADDLGT", description: "Add light fixture labor", quantity: 1, unit: "ea", laborHours: 1.75, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  14: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Single recessed can install in finished residential space.",
    components: [
      { componentType: "material", code: "MAT-14-RECLED", description: "Recessed housing and trim allowance", quantity: 1, unit: "ea", unitCost: 115 },
      { componentType: "labor", code: "LAB-14-RECLED", description: "Install recessed light labor", quantity: 1, unit: "ea", laborHours: 1.75, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  16: {
    laborClass: "remove_and_replace",
    pricingType: "allowance_based",
    notes: "Exterior fixture replacement with weatherproof consumables.",
    components: [
      { componentType: "material", code: "MAT-16-EXTLGT", description: "Exterior hardware and sealant allowance", quantity: 1, unit: "ea", unitCost: 45 },
      { componentType: "labor", code: "LAB-16-EXTLGT", description: "Replace exterior light labor", quantity: 1, unit: "ea", laborHours: 0.75, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  17: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Dedicated 20A 120V branch with explicit device trim-out; cable and fishing labor scale with run_length parameter.",
    components: [
      { componentType: "material", code: "MAT-17-BREAKER", description: "20A single-pole breaker", quantity: 1, unit: "ea", unitCost: 22 },
      { componentType: "material", code: "MAT-17-BOX", description: "Single-gang old-work box", quantity: 1, unit: "ea", unitCost: 4 },
      { componentType: "material", code: "MAT-17-REC", description: "20A duplex receptacle", quantity: 1, unit: "ea", unitCost: 4 },
      { componentType: "material", code: "MAT-17-PLATE", description: "Faceplate", quantity: 1, unit: "ea", unitCost: 1.5 },
      { componentType: "material", code: "MAT-17-WNUT", description: "Wire connector set (3 wirenuts)", quantity: 1, unit: "set", unitCost: 1.5 },
      { componentType: "material", code: "MAT-17-FIT", description: "Cable fittings and fastening hardware (connector, staple, bushing)", quantity: 1, unit: "ea", unitCost: 6 },
      { componentType: "material", code: "MAT-17-CABLE", description: "12/2 NM-B cable", quantity: 1, unit: "lf", unitCost: 0.65, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-17-BREAKER", description: "Install 20A breaker and terminate at panel", quantity: 1, unit: "ea", laborHours: 0.9, laborRate: 90 },
      { componentType: "labor", code: "LAB-17-ROUTE", description: "Fish cable in finished walls/ceilings", quantity: 1, unit: "lf", laborHours: 0.05, laborRate: 90, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-17-BOX", description: "Cut-in single-gang box and secure", quantity: 1, unit: "ea", laborHours: 0.5, laborRate: 90 },
      { componentType: "labor", code: "LAB-17-DEVICE", description: "Install receptacle, make device terminations, and final test", quantity: 1, unit: "ea", laborHours: 0.35, laborRate: 90 },
    ],
  },
  18: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Dedicated 240V branch with selectable 14-50, 6-50, or hardwired endpoint and explicit trim-out materials.",
    components: [
      { componentType: "material", code: "MAT-18-BREAKER", description: "2-pole breaker", quantity: 1, unit: "ea", unitCost: 65 },
      { componentType: "material", code: "MAT-18-14-50", description: "NEMA 14-50 receptacle, box, cover, and fittings", quantity: 1, unit: "ea", unitCost: 65, quantityExpr: "endpoint_14_50_qty" },
      { componentType: "material", code: "MAT-18-6-50", description: "NEMA 6-50 receptacle, box, cover, and fittings", quantity: 1, unit: "ea", unitCost: 48, quantityExpr: "endpoint_6_50_qty" },
      { componentType: "material", code: "MAT-18-HARDWIRE", description: "Hardwire termination kit, flex, and fittings", quantity: 1, unit: "ea", unitCost: 28, quantityExpr: "endpoint_hardwire_qty" },
      { componentType: "material", code: "MAT-18-CABLE63", description: "6/3 NM-B cable", quantity: 1, unit: "lf", unitCost: 2.00, quantityExpr: "run_length_6_3" },
      { componentType: "material", code: "MAT-18-CABLE62", description: "6/2 NM-B cable", quantity: 1, unit: "lf", unitCost: 1.70, quantityExpr: "run_length_6_2" },
      { componentType: "labor", code: "LAB-18-BREAKER", description: "Install breaker and terminate at panel", quantity: 1, unit: "ea", laborHours: 1.0, laborRate: 90 },
      { componentType: "labor", code: "LAB-18-ROUTE", description: "Heavy cable route and pull labor", quantity: 1, unit: "lf", laborHours: 0.065, laborRate: 90, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-18-END", description: "Install endpoint device or hardwire terminations and test", quantity: 1, unit: "ea", laborHours: 0.9, laborRate: 90 },
    ],
  },
  // Wave 4: Feeder Assemblies (19-21)
  19: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Multiwire branch circuit (MWBC) or common-handle multi-load appliance circuit; 12/3 cable and pull labor scale with run_length.",
    components: [
      { componentType: "material", code: "MAT-19-BREAKER", description: "2-pole common-trip 20A breaker and fittings", quantity: 1, unit: "ea", unitCost: 95 },
      { componentType: "material", code: "MAT-19-CABLE", description: "12/3 NM-B cable (shared neutral)", quantity: 1, unit: "lf", unitCost: 1.15, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-19-BASE", description: "Panel terminations and shared-neutral circuit testing", quantity: 1, unit: "ea", laborHours: 2.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-19-ROUTE", description: "Cable route and pull labor", quantity: 1, unit: "lf", laborHours: 0.065, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "run_length" },
    ],
  },
  20: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Feeder conductor run from main panel to same-building subpanel; conductors and pull labor scale with run_length.",
    components: [
      { componentType: "material", code: "MAT-20-BREAKER", description: "2-pole feeder breaker and fittings", quantity: 1, unit: "ea", unitCost: 130 },
      { componentType: "material", code: "MAT-20-FEEDER", description: "Feeder conductors (SER cable or THHN in conduit)", quantity: 1, unit: "lf", unitCost: 3.00, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-20-BASE", description: "Breaker install and panel terminations at both ends", quantity: 1, unit: "ea", laborHours: 3.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-20-ROUTE", description: "Feeder route and pull labor", quantity: 1, unit: "lf", laborHours: 0.08, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "run_length" },
    ],
  },
  21: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Detached structure feeder; underground or aerial routing — conductors and pull labor scale with run_length.",
    components: [
      { componentType: "material", code: "MAT-21-BREAKER", description: "2-pole feeder breaker, weatherhead and entrance fittings", quantity: 1, unit: "ea", unitCost: 150 },
      { componentType: "material", code: "MAT-21-FEEDER", description: "Underground feeder conductors (USE-2 / direct burial)", quantity: 1, unit: "lf", unitCost: 3.75, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-21-BASE", description: "Breaker install, entrance fittings and terminations at both ends", quantity: 1, unit: "ea", laborHours: 4.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-21-ROUTE", description: "Underground or exterior feeder route and pull labor", quantity: 1, unit: "lf", laborHours: 0.10, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "run_length" },
    ],
  },
  22: {
    laborClass: "remove_and_replace",
    pricingType: "neca_informed",
    notes: "Standard breaker replacement under de-energized assumptions.",
    components: [
      { componentType: "material", code: "MAT-22-BKR", description: "Breaker allowance", quantity: 1, unit: "ea", unitCost: 35 },
      { componentType: "labor", code: "LAB-22-BKR", description: "Replace breaker labor", quantity: 1, unit: "ea", laborHours: 0.7, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  23: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Add breaker plus termination time.",
    components: [
      { componentType: "material", code: "MAT-23-ADDBKR", description: "Breaker and terminations allowance", quantity: 1, unit: "ea", unitCost: 65 },
      { componentType: "labor", code: "LAB-23-ADDBKR", description: "Add breaker labor", quantity: 1, unit: "ea", laborHours: 1.2, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  24: {
    laborClass: "remove_and_replace",
    pricingType: "allowance_based",
    notes: "AFCI/GFCI protective device upgrade.",
    components: [
      { componentType: "material", code: "MAT-24-PROT", description: "Protective device allowance", quantity: 1, unit: "ea", unitCost: 85 },
      { componentType: "labor", code: "LAB-24-PROT", description: "Install protective device labor", quantity: 1, unit: "ea", laborHours: 1, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  27: {
    laborClass: "remove_and_replace",
    pricingType: "allowance_based",
    notes: "Main panel replacement first-pass allowance.",
    components: [
      { componentType: "material", code: "MAT-27-PANEL", description: "Panel, breakers and fittings allowance", quantity: 1, unit: "ea", unitCost: 1650 },
      { componentType: "labor", code: "LAB-27-PANEL", description: "Replace main panel labor", quantity: 1, unit: "ea", laborHours: 16, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  28: {
    laborClass: "remove_and_replace",
    pricingType: "allowance_based",
    notes: "Service entrance cable replacement allowance.",
    components: [
      { componentType: "material", code: "MAT-28-SEC", description: "Service entrance conductors and fittings", quantity: 1, unit: "ea", unitCost: 420 },
      { componentType: "labor", code: "LAB-28-SEC", description: "Replace service entrance cable labor", quantity: 1, unit: "ea", laborHours: 6, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  29: {
    laborClass: "remove_and_replace",
    pricingType: "allowance_based",
    notes: "Meter base replacement allowance.",
    components: [
      { componentType: "material", code: "MAT-29-METER", description: "Meter base and fittings allowance", quantity: 1, unit: "ea", unitCost: 340 },
      { componentType: "labor", code: "LAB-29-METER", description: "Replace meter base labor", quantity: 1, unit: "ea", laborHours: 4, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  30: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Exterior disconnect install allowance.",
    components: [
      { componentType: "material", code: "MAT-30-DISCO", description: "Disconnect, fittings and labels", quantity: 1, unit: "ea", unitCost: 210 },
      { componentType: "labor", code: "LAB-30-DISCO", description: "Install disconnect labor", quantity: 1, unit: "ea", laborHours: 3, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  33: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Grounding electrode system correction or install.",
    components: [
      { componentType: "material", code: "MAT-33-GES", description: "Ground rods, clamps, conductor allowance", quantity: 1, unit: "ea", unitCost: 185 },
      { componentType: "labor", code: "LAB-33-GES", description: "Install/upgrade grounding system labor", quantity: 1, unit: "ea", laborHours: 4.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  35: {
    laborClass: "repair_existing",
    pricingType: "allowance_based",
    notes: "Grounding electrode conductor correction.",
    components: [
      { componentType: "material", code: "MAT-35-GEC", description: "Conductor and connection allowance", quantity: 1, unit: "ea", unitCost: 65 },
      { componentType: "labor", code: "LAB-35-GEC", description: "Upgrade conductor labor", quantity: 1, unit: "ea", laborHours: 2, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  36: {
    laborClass: "repair_existing",
    pricingType: "allowance_based",
    notes: "Bonding correction scope.",
    components: [
      { componentType: "material", code: "MAT-36-BOND", description: "Bonding hardware allowance", quantity: 1, unit: "ea", unitCost: 55 },
      { componentType: "labor", code: "LAB-36-BOND", description: "Bonding correction labor", quantity: 1, unit: "ea", laborHours: 2, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  37: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Whole-home surge protective device install.",
    components: [
      { componentType: "material", code: "MAT-37-SPD", description: "SPD hardware allowance", quantity: 1, unit: "ea", unitCost: 220 },
      { componentType: "labor", code: "LAB-37-SPD", description: "Install SPD labor", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  43: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Water heater circuit (240V/30A) with required local disconnect and explicit hardwire or receptacle endpoint materials.",
    components: [
      { componentType: "material", code: "MAT-43-BREAKER", description: "30A 2-pole breaker", quantity: 1, unit: "ea", unitCost: 38 },
      { componentType: "material", code: "MAT-43-DISCONNECT", description: "30-60A A/C disconnect (local service disconnect)", quantity: 1, unit: "ea", unitCost: 42 },
      { componentType: "material", code: "MAT-43-14-30", description: "NEMA 14-30 receptacle, box, cover, and fittings", quantity: 1, unit: "ea", unitCost: 42, quantityExpr: "endpoint_14_30_qty" },
      { componentType: "material", code: "MAT-43-HARDWIRE", description: "Hardwire whip, disconnect fittings, and terminations", quantity: 1, unit: "ea", unitCost: 24, quantityExpr: "endpoint_hardwire_qty" },
      { componentType: "material", code: "MAT-43-CABLE103", description: "10/3 NM-B cable", quantity: 1, unit: "lf", unitCost: 1.10, quantityExpr: "run_length_10_3" },
      { componentType: "material", code: "MAT-43-CABLE102", description: "10/2 NM-B cable", quantity: 1, unit: "lf", unitCost: 0.90, quantityExpr: "run_length_10_2" },
      { componentType: "labor", code: "LAB-43-BREAKER", description: "Install breaker and terminate at panel", quantity: 1, unit: "ea", laborHours: 0.8, laborRate: 90 },
      { componentType: "labor", code: "LAB-43-DISCONNECT", description: "Install local disconnect and label", quantity: 1, unit: "ea", laborHours: 0.6, laborRate: 90 },
      { componentType: "labor", code: "LAB-43-ROUTE", description: "Cable route and pull labor", quantity: 1, unit: "lf", laborHours: 0.05, laborRate: 90, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-43-END", description: "Complete water heater endpoint terminations and test", quantity: 1, unit: "ea", laborHours: 0.7, laborRate: 90 },
    ],
  },
  44: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Range circuit (240V/50A) with explicit 14-50 or hardwired endpoint materials.",
    components: [
      { componentType: "material", code: "MAT-44-BREAKER", description: "50A 2-pole breaker", quantity: 1, unit: "ea", unitCost: 65 },
      { componentType: "material", code: "MAT-44-14-50", description: "NEMA 14-50 receptacle, box, cover, and fittings", quantity: 1, unit: "ea", unitCost: 65, quantityExpr: "endpoint_14_50_qty" },
      { componentType: "material", code: "MAT-44-HARDWIRE", description: "Hardwire termination kit and fittings", quantity: 1, unit: "ea", unitCost: 28, quantityExpr: "endpoint_hardwire_qty" },
      { componentType: "material", code: "MAT-44-CABLE63", description: "6/3 NM-B cable", quantity: 1, unit: "lf", unitCost: 2.00, quantityExpr: "run_length_6_3" },
      { componentType: "material", code: "MAT-44-CABLE62", description: "6/2 NM-B cable", quantity: 1, unit: "lf", unitCost: 1.70, quantityExpr: "run_length_6_2" },
      { componentType: "labor", code: "LAB-44-BREAKER", description: "Install breaker and terminate at panel", quantity: 1, unit: "ea", laborHours: 0.9, laborRate: 90 },
      { componentType: "labor", code: "LAB-44-ROUTE", description: "Heavy cable route and pull labor", quantity: 1, unit: "lf", laborHours: 0.07, laborRate: 90, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-44-END", description: "Install range endpoint hardware and test", quantity: 1, unit: "ea", laborHours: 0.85, laborRate: 90 },
    ],
  },
  45: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Dryer circuit (240V) plug-and-cord only with 14-30 or 14-50 endpoint materials.",
    components: [
      { componentType: "material", code: "MAT-45-BREAKER", description: "30A 2-pole breaker", quantity: 1, unit: "ea", unitCost: 38 },
      { componentType: "material", code: "MAT-45-14-30", description: "NEMA 14-30 receptacle, box, cover, and fittings", quantity: 1, unit: "ea", unitCost: 42, quantityExpr: "endpoint_14_30_qty" },
      { componentType: "material", code: "MAT-45-14-50", description: "NEMA 14-50 receptacle, box, cover, and fittings", quantity: 1, unit: "ea", unitCost: 65, quantityExpr: "endpoint_14_50_qty" },
      { componentType: "material", code: "MAT-45-CABLE103", description: "10/3 NM-B cable", quantity: 1, unit: "lf", unitCost: 1.10, quantityExpr: "run_length_10_3" },
      { componentType: "material", code: "MAT-45-CABLE63", description: "6/3 NM-B cable", quantity: 1, unit: "lf", unitCost: 2.00, quantityExpr: "run_length_6_3" },
      { componentType: "labor", code: "LAB-45-BREAKER", description: "Install breaker and terminate at panel", quantity: 1, unit: "ea", laborHours: 0.8, laborRate: 90 },
      { componentType: "labor", code: "LAB-45-ROUTE", description: "Cable route and pull labor", quantity: 1, unit: "lf", laborHours: 0.05, laborRate: 90, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-45-END", description: "Install dryer endpoint hardware and test", quantity: 1, unit: "ea", laborHours: 0.75, laborRate: 90 },
    ],
  },
  71: {
    laborClass: "extend_from_existing",
    pricingType: "allowance_based",
    notes: "Access/fishing difficulty add-on.",
    components: [
      { componentType: "labor", code: "LAB-71-ACCESS", description: "Difficulty add-on labor", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  72: {
    laborClass: "allowance",
    pricingType: "allowance_based",
    notes: "Permit allowance support line item.",
    components: [
      { componentType: "other", code: "OTH-72-PERMIT", description: "Permit allowance", quantity: 1, unit: "ea", unitCost: 350 },
    ],
  },
  75: {
    laborClass: "remove_and_replace",
    pricingType: "allowance_based",
    notes: "Ceiling fan install with customer-supplied fan assumption.",
    components: [
      { componentType: "material", code: "MAT-75-FAN", description: "Fan hardware/consumables allowance", quantity: 1, unit: "ea", unitCost: 55 },
      { componentType: "labor", code: "LAB-75-FAN", description: "Install fan labor", quantity: 1, unit: "ea", laborHours: 1.50, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  76: {
    laborClass: "remove_and_replace",
    pricingType: "neca_informed",
    notes: "Upgrade existing receptacle location to GFCI.",
    components: [
      { componentType: "material", code: "MAT-76-UPGFCI", description: "GFCI and label allowance", quantity: 1, unit: "ea", unitCost: 25 },
      { componentType: "labor", code: "LAB-76-UPGFCI", description: "Upgrade receptacle labor", quantity: 1, unit: "ea", laborHours: 0.45, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  77: {
    laborClass: "remove_and_replace",
    pricingType: "allowance_based",
    notes: "Single smoke/CO device replacement.",
    components: [
      { componentType: "material", code: "MAT-77-SMOKE", description: "Smoke/CO detector allowance", quantity: 1, unit: "ea", unitCost: 48 },
      { componentType: "labor", code: "LAB-77-SMOKE", description: "Replace detector labor", quantity: 1, unit: "ea", laborHours: 0.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  78: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Add hardwired interconnected detector; interconnect cable scales with run_length parameter.",
    components: [
      { componentType: "material", code: "MAT-78-UNIT", description: "Smoke/CO detector unit and box", quantity: 1, unit: "ea", unitCost: 75 },
      { componentType: "material", code: "MAT-78-CABLE", description: "14/3 NM-B interconnect cable", quantity: 1, unit: "lf", unitCost: 0.70, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-78-BASE", description: "Mount, wire and test detector", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-78-ROUTE", description: "Interconnect cable route labor", quantity: 1, unit: "lf", laborHours: 0.04, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "run_length" },
    ],
  },
  80: {
    laborClass: "remove_and_replace",
    pricingType: "allowance_based",
    notes: "Bathroom exhaust fan install/replace baseline.",
    components: [
      { componentType: "material", code: "MAT-80-BATHFAN", description: "Fan hardware/duct allowance", quantity: 1, unit: "ea", unitCost: 140 },
      { componentType: "labor", code: "LAB-80-BATHFAN", description: "Install/replace bath fan labor", quantity: 1, unit: "ea", laborHours: 2.25, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  81: {
    laborClass: "test_verify",
    pricingType: "allowance_based",
    notes: "Load calculation and panel schedule review.",
    components: [
      { componentType: "labor", code: "LAB-81-LOADCALC", description: "Technical review labor", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  82: {
    laborClass: "test_verify",
    pricingType: "allowance_based",
    notes: "Utility coordination support labor.",
    components: [
      { componentType: "labor", code: "LAB-82-UTIL", description: "Utility coordination labor", quantity: 1, unit: "ea", laborHours: 2, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  83: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Trench/underground route; conduit and excavation labor scale with trench_length parameter.",
    components: [
      { componentType: "material", code: "MAT-83-BASE", description: "Conduit end fittings and markers", quantity: 1, unit: "ea", unitCost: 40 },
      { componentType: "material", code: "MAT-83-COND", description: "1\" PVC conduit or UF cable", quantity: 1, unit: "lf", unitCost: 0.50, quantityExpr: "trench_length" },
      { componentType: "labor", code: "LAB-83-BASE", description: "Setup, backfill and compaction", quantity: 1, unit: "ea", laborHours: 3.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-83-TRENCH", description: "Excavation and conduit laying", quantity: 1, unit: "lf", laborHours: 0.08, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "trench_length" },
      { componentType: "other", code: "OTH-83-RESTORE", description: "Restoration/boring allowance", quantity: 1, unit: "ea", unitCost: 450 },
    ],
  },
  85: {
    laborClass: "remove_and_replace",
    pricingType: "allowance_based",
    notes: "Dimmer/smart switch upgrade.",
    components: [
      { componentType: "material", code: "MAT-85-DIMMER", description: "Device allowance", quantity: 1, unit: "ea", unitCost: 55 },
      { componentType: "labor", code: "LAB-85-DIMMER", description: "Install dimmer/smart switch labor", quantity: 1, unit: "ea", laborHours: 0.50, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  89: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Subpanel install; feeder conductors and pull labor scale with feeder_run_length parameter.",
    components: [
      { componentType: "material", code: "MAT-89-PANEL", description: "100A subpanel, breakers and fittings", quantity: 1, unit: "ea", unitCost: 500 },
      { componentType: "material", code: "MAT-89-FEEDER", description: "2/0 SER feeder cable", quantity: 1, unit: "lf", unitCost: 2.80, quantityExpr: "feeder_run_length" },
      { componentType: "labor", code: "LAB-89-PANEL", description: "Panel mount, bus work and main connections", quantity: 1, unit: "ea", laborHours: 5.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-89-FEEDER", description: "Feeder route and pull labor", quantity: 1, unit: "lf", laborHours: 0.08, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "feeder_run_length" },
    ],
  },
  // Wave 1: Appliance/Equipment Circuits (46-65)
  46: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Dishwasher or disposal circuit; 20A 120V or 240V variant.",
    components: [
      { componentType: "material", code: "MAT-46-BREAKER", description: "20A breaker", quantity: 1, unit: "ea", unitCost: 45 },
      { componentType: "material", code: "MAT-46-WIRE", description: "12 AWG THHN/THW wire", quantity: 1, unit: "lf", unitCost: 0.35, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-46-CONDUIT", description: "PVC/EMT conduit", quantity: 1, unit: "lf", unitCost: 0.45, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-46-CONN", description: "Connectors, splice kits, hardware", quantity: 1, unit: "ea", unitCost: 25 },
      { componentType: "labor", code: "LAB-46-ROUTE", description: "Route conduit and pull wire", quantity: 1, unit: "ea", laborHours: 2.2, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-46-PANEL", description: "Connect breaker and load connections", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  47: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Microwave or range hood circuit; 20A 240V.",
    components: [
      { componentType: "material", code: "MAT-47-BREAKER", description: "20A 240V breaker", quantity: 1, unit: "ea", unitCost: 45 },
      { componentType: "material", code: "MAT-47-WIRE", description: "12 AWG 240V wire", quantity: 1, unit: "lf", unitCost: 0.50, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-47-CONDUIT", description: "PVC/EMT conduit", quantity: 1, unit: "lf", unitCost: 0.45, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-47-CONN", description: "Connectors and hardware", quantity: 1, unit: "ea", unitCost: 30 },
      { componentType: "labor", code: "LAB-47-ROUTE", description: "Route conduit and pull wire", quantity: 1, unit: "ea", laborHours: 2.3, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-47-CONNECT", description: "Panel and load connections", quantity: 1, unit: "ea", laborHours: 1.6, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  48: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "HVAC condenser circuit; 30A 240V.",
    components: [
      { componentType: "material", code: "MAT-48-BREAKER", description: "30A 240V breaker", quantity: 1, unit: "ea", unitCost: 48 },
      { componentType: "material", code: "MAT-48-WIRE", description: "10 AWG THHN/THW wire", quantity: 1, unit: "lf", unitCost: 0.60, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-48-CONDUIT", description: "PVC/EMT conduit", quantity: 1, unit: "lf", unitCost: 0.50, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-48-DISCONNECT", description: "Outdoor disconnect hardware", quantity: 1, unit: "ea", unitCost: 95 },
      { componentType: "labor", code: "LAB-48-ROUTE", description: "Route to exterior and pull wire", quantity: 1, unit: "ea", laborHours: 2.8, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-48-INSTALL", description: "Install disconnect and connections", quantity: 1, unit: "ea", laborHours: 2.0, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  49: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Furnace/air handler control circuit; 15A 120V.",
    components: [
      { componentType: "material", code: "MAT-49-BREAKER", description: "15A breaker", quantity: 1, unit: "ea", unitCost: 40 },
      { componentType: "material", code: "MAT-49-WIRE", description: "14 AWG THHN/THW wire", quantity: 1, unit: "lf", unitCost: 0.25, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-49-CONDUIT", description: "PVC/EMT conduit", quantity: 1, unit: "lf", unitCost: 0.35, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-49-CONNECTORS", description: "Connectors and hardware", quantity: 1, unit: "ea", unitCost: 20 },
      { componentType: "labor", code: "LAB-49-ROUTE", description: "Route and pull wire", quantity: 1, unit: "ea", laborHours: 1.8, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-49-CONNECT", description: "Breaker and equipment connections", quantity: 1, unit: "ea", laborHours: 1.2, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  50: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Generic garage/shop equipment circuit; variable amperage based on equipment.",
    components: [
      { componentType: "material", code: "MAT-50-BREAKER", description: "Equipment breaker", quantity: 1, unit: "ea", unitCost: 55 },
      { componentType: "material", code: "MAT-50-WIRE", description: "THHN/THW wire for equipment", quantity: 1, unit: "lf", unitCost: 0.70, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-50-CONDUIT", description: "Rigid/PVC conduit", quantity: 1, unit: "lf", unitCost: 0.55, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-50-RECEPTACLE", description: "Heavy-duty equipment receptacle", quantity: 1, unit: "ea", unitCost: 75 },
      { componentType: "labor", code: "LAB-50-ROUTE", description: "Route and pull", quantity: 1, unit: "ea", laborHours: 2.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-50-CONNECT", description: "Receptacle and panel connections", quantity: 1, unit: "ea", laborHours: 1.8, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  51: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Welder receptacle and circuit; 50A 240V dedicated.",
    components: [
      { componentType: "material", code: "MAT-51-BREAKER", description: "50A 240V breaker", quantity: 1, unit: "ea", unitCost: 65 },
      { componentType: "material", code: "MAT-51-WIRE", description: "6 AWG THHN/THW wire", quantity: 1, unit: "lf", unitCost: 1.20, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-51-CONDUIT", description: "Rigid conduit", quantity: 1, unit: "lf", unitCost: 0.75, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-51-RECEPTACLE", description: "50A welder receptacle", quantity: 1, unit: "ea", unitCost: 120 },
      { componentType: "labor", code: "LAB-51-ROUTE", description: "Heavy route and pull", quantity: 1, unit: "ea", laborHours: 3.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-51-CONNECT", description: "Receptacle termination and panel work", quantity: 1, unit: "ea", laborHours: 2.0, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  52: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Air compressor or stationary tool circuit with disconnect; 30A 240V.",
    components: [
      { componentType: "material", code: "MAT-52-BREAKER", description: "30A 240V breaker", quantity: 1, unit: "ea", unitCost: 48 },
      { componentType: "material", code: "MAT-52-WIRE", description: "10 AWG THHN/THW wire", quantity: 1, unit: "lf", unitCost: 0.60, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-52-CONDUIT", description: "PVC/EMT conduit", quantity: 1, unit: "lf", unitCost: 0.50, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-52-DISCONNECT", description: "250V disconnect switch", quantity: 1, unit: "ea", unitCost: 85 },
      { componentType: "labor", code: "LAB-52-ROUTE", description: "Route and pull wire", quantity: 1, unit: "ea", laborHours: 2.6, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-52-INSTALL", description: "Disconnect and equipment connection", quantity: 1, unit: "ea", laborHours: 1.9, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  53: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Stationary tool or motor equipment circuit; 30A 240V.",
    components: [
      { componentType: "material", code: "MAT-53-BREAKER", description: "30A 240V breaker", quantity: 1, unit: "ea", unitCost: 48 },
      { componentType: "material", code: "MAT-53-WIRE", description: "10 AWG THHN/THW wire", quantity: 1, unit: "lf", unitCost: 0.60, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-53-CONDUIT", description: "Rigid/PVC conduit", quantity: 1, unit: "lf", unitCost: 0.50, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-53-RECEPTACLE", description: "Heavy-duty receptacle", quantity: 1, unit: "ea", unitCost: 65 },
      { componentType: "labor", code: "LAB-53-ROUTE", description: "Route and pull", quantity: 1, unit: "ea", laborHours: 2.4, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-53-CONNECT", description: "Receptacle and panel connections", quantity: 1, unit: "ea", laborHours: 1.7, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  54: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Single-phase motor equipment connection; 30A 240V dedicated.",
    components: [
      { componentType: "material", code: "MAT-54-BREAKER", description: "30A 240V breaker", quantity: 1, unit: "ea", unitCost: 48 },
      { componentType: "material", code: "MAT-54-WIRE", description: "10 AWG THHN/THW wire", quantity: 1, unit: "lf", unitCost: 0.60, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-54-CONDUIT", description: "Rigid conduit", quantity: 1, unit: "lf", unitCost: 0.55, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-54-DISCONNECT", description: "Motor disconnect switch", quantity: 1, unit: "ea", unitCost: 95 },
      { componentType: "labor", code: "LAB-54-ROUTE", description: "Route and pull wire", quantity: 1, unit: "ea", laborHours: 2.7, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-54-CONNECT", description: "Motor and disconnect setup", quantity: 1, unit: "ea", laborHours: 2.0, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  55: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Portable generator inlet installation; allows generator plug-in.",
    components: [
      { componentType: "material", code: "MAT-55-INLET", description: "Power inlet box with disconnect", quantity: 1, unit: "ea", unitCost: 180 },
      { componentType: "material", code: "MAT-55-WIRE", description: "8 AWG THHN/THW wire", quantity: 1, unit: "lf", unitCost: 0.95, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-55-CONDUIT", description: "Rigid conduit", quantity: 1, unit: "lf", unitCost: 0.60, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-55-MOUNT", description: "Inlet mount and wire routing", quantity: 1, unit: "ea", laborHours: 2.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-55-CONNECT", description: "Panel connection and testing", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  56: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Interlock kit installation for main breaker and generator.",
    components: [
      { componentType: "material", code: "MAT-56-INTERLOCK", description: "Mechanical interlock kit", quantity: 1, unit: "ea", unitCost: 150 },
      { componentType: "labor", code: "LAB-56-INSTALL", description: "Interlock kit installation and adjustment", quantity: 1, unit: "ea", laborHours: 2.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  57: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Manual transfer switch installation for selectable loads.",
    components: [
      { componentType: "material", code: "MAT-57-SWITCH", description: "Manual transfer switch (sub-main)", quantity: 1, unit: "ea", unitCost: 400 },
      { componentType: "material", code: "MAT-57-WIRE", description: "Feeder wire for transfer switch", quantity: 1, unit: "lf", unitCost: 0.80, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-57-CONDUIT", description: "Rigid conduit", quantity: 1, unit: "lf", unitCost: 0.60, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-57-MOUNT", description: "Switch mounting and wire routing", quantity: 1, unit: "ea", laborHours: 3.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-57-TERMINATE", description: "Breaker and load termination", quantity: 1, unit: "ea", laborHours: 2.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  58: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Package: Standby generator installation; includes transfer switch or interlock.",
    components: [
      { componentType: "other", code: "OTH-58-TRANSFER", description: "Manual transfer switch package allowance", quantity: 1, unit: "ea", unitCost: 800 },
      { componentType: "labor", code: "LAB-58-INSTALL", description: "Generator installation and connection labor", quantity: 1, unit: "ea", laborHours: 6.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-58-ELECTRICAL", description: "Electrical integration and testing", quantity: 1, unit: "ea", laborHours: 3.0, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  59: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "EV charger circuit only; 40A 240V dedicated.",
    components: [
      { componentType: "material", code: "MAT-59-BREAKER", description: "40A 240V breaker", quantity: 1, unit: "ea", unitCost: 52 },
      { componentType: "material", code: "MAT-59-WIRE", description: "8 AWG THHN/THW wire", quantity: 1, unit: "lf", unitCost: 0.95, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-59-CONDUIT", description: "Rigid/PVC conduit", quantity: 1, unit: "lf", unitCost: 0.60, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-59-JB", description: "Junction box and fittings", quantity: 1, unit: "ea", unitCost: 45 },
      { componentType: "labor", code: "LAB-59-ROUTE", description: "Route to garage and pull wire", quantity: 1, unit: "ea", laborHours: 3.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-59-TERMINATE", description: "Breaker and termination work", quantity: 1, unit: "ea", laborHours: 1.8, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  60: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "EV charger installation with customer-supplied charger hardware; branch-circuit materials still tracked.",
    components: [
      { componentType: "material", code: "MAT-60-BREAKER", description: "EV breaker sized to selected rating", quantity: 1, unit: "ea", unitCost: 52 },
      { componentType: "material", code: "MAT-60-WIRE", description: "EV branch conductor set", quantity: 1, unit: "lf", unitCost: 0.95, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-60-CONDUIT", description: "Raceway and fittings", quantity: 1, unit: "lf", unitCost: 0.60, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-60-INSTALL", description: "Charger mounting and electrical connection", quantity: 1, unit: "ea", laborHours: 3.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "other", code: "OTH-60-MISC", description: "Fasteners, conduit fittings, and hardware", quantity: 1, unit: "ea", unitCost: 35 },
    ],
  },
  63: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Hot tub disconnect and feeder; 50A 240V dedicated.",
    components: [
      { componentType: "material", code: "MAT-63-DISCONNECT", description: "Hot tub disconnect switch", quantity: 1, unit: "ea", unitCost: 150 },
      { componentType: "material", code: "MAT-63-WIRE", description: "6 AWG THHN/THW wire", quantity: 1, unit: "lf", unitCost: 1.20, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-63-CONDUIT", description: "Rigid/PVC conduit", quantity: 1, unit: "lf", unitCost: 0.60, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-63-BREAKER", description: "50A breaker", quantity: 1, unit: "ea", unitCost: 65 },
      { componentType: "labor", code: "LAB-63-ROUTE", description: "Route feeder to hot tub location", quantity: 1, unit: "ea", laborHours: 3.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-63-INSTALL", description: "Disconnect and equipment connection", quantity: 1, unit: "ea", laborHours: 2.0, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  64: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Pool equipment feeder; 60A 240V dedicated with disconnect.",
    components: [
      { componentType: "material", code: "MAT-64-DISCONNECT", description: "Pool equipment disconnect", quantity: 1, unit: "ea", unitCost: 160 },
      { componentType: "material", code: "MAT-64-WIRE", description: "6 AWG THHN/THW wire", quantity: 1, unit: "lf", unitCost: 1.20, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-64-CONDUIT", description: "Rigid conduit", quantity: 1, unit: "lf", unitCost: 0.65, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-64-BREAKER", description: "60A breaker", quantity: 1, unit: "ea", unitCost: 70 },
      { componentType: "labor", code: "LAB-64-ROUTE", description: "Route to pool equipment location", quantity: 1, unit: "ea", laborHours: 3.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-64-INSTALL", description: "Disconnect and equipment bonding", quantity: 1, unit: "ea", laborHours: 2.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  65: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Package: Full spa/hot tub electrical package; includes disconnect, feeder, and bonding.",
    components: [
      { componentType: "material", code: "MAT-65-DISCONNECT", description: "Spa disconnect enclosure", quantity: 1, unit: "ea", unitCost: 180 },
      { componentType: "material", code: "MAT-65-FEEDER", description: "6 AWG THHN/THW feeder wire", quantity: 1, unit: "lf", unitCost: 1.20, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-65-CONDUIT", description: "Rigid conduit and fittings", quantity: 1, unit: "lf", unitCost: 0.65, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-65-BONDING", description: "Bonding hardware and jumpers", quantity: 1, unit: "ea", unitCost: 95 },
      { componentType: "labor", code: "LAB-65-FEEDER", description: "Feeder installation and pull", quantity: 1, unit: "ea", laborHours: 3.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-65-DISCONNECT", description: "Disconnect installation and bonding setup", quantity: 1, unit: "ea", laborHours: 2.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-65-TESTING", description: "Final inspection and equipment testing", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  8: {
    laborClass: "remove_and_replace",
    pricingType: "neca_informed",
    notes: "Replace device plate or trim only; minimal scope.",
    components: [
      { componentType: "material", code: "MAT-8-PLATE", description: "Device plate/trim allowance", quantity: 1, unit: "ea", unitCost: 8 },
      { componentType: "labor", code: "LAB-8-PLATE", description: "Replace plate labor", quantity: 1, unit: "ea", laborHours: 0.15, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  15: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Add ceiling fan rated box and support bracket; typically ceiling rough-in.",
    components: [
      { componentType: "material", code: "MAT-15-BOX", description: "Ceiling fan box and bracket", quantity: 1, unit: "ea", unitCost: 65 },
      { componentType: "material", code: "MAT-15-CABLE", description: "14/2 NM-B cable", quantity: 1, unit: "lf", unitCost: 0.35, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-15-MOUNT", description: "Mount box and frame in ceiling", quantity: 1, unit: "ea", laborHours: 1.75, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-15-CABLE", description: "Cable run and connections", quantity: 1, unit: "lf", laborHours: 0.04, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "run_length" },
    ],
  },
  25: {
    laborClass: "repair_existing",
    pricingType: "allowance_based",
    notes: "Panel circuit rework and cleanup; re-route, re-terminate, or organize existing wiring.",
    components: [
      { componentType: "labor", code: "LAB-25-REWORK", description: "Panel conductor rework and re-termination", quantity: 1, unit: "ea", laborHours: 4.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-25-ORGANIZE", description: "Labeling and organization", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "material", code: "MAT-25-HARDWARE", description: "Labels, ties, hardware allowance", quantity: 1, unit: "ea", unitCost: 35 },
    ],
  },
  26: {
    laborClass: "remove_and_replace",
    pricingType: "allowance_based",
    notes: "Replace existing subpanel with same or upgraded capacity; assumes same mounting location.",
    components: [
      { componentType: "material", code: "MAT-26-PANEL", description: "Replacement subpanel and breakers", quantity: 1, unit: "ea", unitCost: 600 },
      { componentType: "material", code: "MAT-26-HARDWARE", description: "Mounting hardware and fittings", quantity: 1, unit: "ea", unitCost: 75 },
      { componentType: "labor", code: "LAB-26-REMOVE", description: "Remove old panel and disconnect feeder", quantity: 1, unit: "ea", laborHours: 3.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-26-INSTALL", description: "Install new panel and terminate feeder", quantity: 1, unit: "ea", laborHours: 4.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-26-TEST", description: "Testing and final verification", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  31: {
    laborClass: "repair_existing",
    pricingType: "allowance_based",
    notes: "Repair or replace service mast, weatherhead, or entrance fittings for overhead service.",
    components: [
      { componentType: "material", code: "MAT-31-MAST", description: "Mast or weatherhead assembly", quantity: 1, unit: "ea", unitCost: 185 },
      { componentType: "material", code: "MAT-31-HARDWARE", description: "Mounting hardware and sealant", quantity: 1, unit: "ea", unitCost: 45 },
      { componentType: "labor", code: "LAB-31-REMOVE", description: "Remove old fitting and prepare", quantity: 1, unit: "ea", laborHours: 2.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-31-INSTALL", description: "Install new mast/weatherhead", quantity: 1, unit: "ea", laborHours: 3.0, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  34: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Add or replace ground rods and clamp installations.",
    components: [
      { componentType: "material", code: "MAT-34-ROD", description: "Copper ground rod (8-10 ft)", quantity: 1, unit: "ea", unitCost: 55, quantityExpr: "rod_qty" },
      { componentType: "material", code: "MAT-34-CLAMP", description: "Ground rod clamp and hardware", quantity: 1, unit: "ea", unitCost: 18, quantityExpr: "rod_qty" },
      { componentType: "labor", code: "LAB-34-DRIVE", description: "Drive ground rod labor", quantity: 1, unit: "ea", laborHours: 1.2, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "rod_qty" },
      { componentType: "labor", code: "LAB-34-CLAMP", description: "Install clamp and verify connections", quantity: 1, unit: "ea", laborHours: 0.5, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "rod_qty" },
    ],
  },
  66: {
    laborClass: "remove_only",
    pricingType: "allowance_based",
    notes: "Remove existing device or fixture; disposal of removed items.",
    components: [
      { componentType: "labor", code: "LAB-66-REMOVE", description: "Remove device/fixture labor", quantity: 1, unit: "ea", laborHours: 0.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-66-DISPOSAL", description: "Disposal and cleanup labor", quantity: 1, unit: "ea", laborHours: 0.25, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  67: {
    laborClass: "remove_only",
    pricingType: "allowance_based",
    notes: "Remove or abandon existing circuit segment; cable removal and patching.",
    components: [
      { componentType: "labor", code: "LAB-67-REMOVE", description: "Circuit removal labor", quantity: 1, unit: "lf", laborHours: 0.08, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-67-PATCH", description: "Patch and cleanup labor", quantity: 1, unit: "ea", laborHours: 0.75, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  68: {
    laborClass: "remove_only",
    pricingType: "allowance_based",
    notes: "Demolition and site prep for panel replacement; removal and cleanup.",
    components: [
      { componentType: "labor", code: "LAB-68-DEMO", description: "Panel demo and disconnection labor", quantity: 1, unit: "ea", laborHours: 3.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-68-CLEANUP", description: "Site cleanup and disposal", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  69: {
    laborClass: "repair_existing",
    pricingType: "allowance_based",
    notes: "Repair failed or non-compliant splice or termination in place.",
    components: [
      { componentType: "material", code: "MAT-69-SPLICE", description: "Splice kit or termination hardware", quantity: 1, unit: "ea", unitCost: 28 },
      { componentType: "labor", code: "LAB-69-REPAIR", description: "Open, splice, and re-secure labor", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  70: {
    laborClass: "repair_existing",
    pricingType: "allowance_based",
    notes: "Support assembly: Rework existing panel conductors; re-route, re-terminate, organize.",
    components: [
      { componentType: "labor", code: "LAB-70-REWORK", description: "Panel conductor rework labor", quantity: 1, unit: "ea", laborHours: 3.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  73: {
    laborClass: "allowance",
    pricingType: "allowance_based",
    notes: "Wall repair and patch allowance for drywall, paint, or surface restoration.",
    components: [
      { componentType: "material", code: "MAT-73-PATCH", description: "Drywall, patch compound, paint allowance", quantity: 1, unit: "ea", unitCost: 85, quantityExpr: "patch_count" },
      { componentType: "labor", code: "LAB-73-PATCH", description: "Patch and finish labor", quantity: 1, unit: "ea", laborHours: 1.25, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "patch_count" },
    ],
  },
  74: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Add or replace junction/splice box; installation and connections.",
    components: [
      { componentType: "material", code: "MAT-74-BOX", description: "Junction/splice box and cover", quantity: 1, unit: "ea", unitCost: 28 },
      { componentType: "material", code: "MAT-74-HARDWARE", description: "Clamps and mounting hardware", quantity: 1, unit: "ea", unitCost: 12 },
      { componentType: "labor", code: "LAB-74-MOUNT", description: "Mount and hang box", quantity: 1, unit: "ea", laborHours: 0.75, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-74-CONNECT", description: "Make connections and verify", quantity: 1, unit: "ea", laborHours: 0.5, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  38: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Package: Detached garage/shop subpanel package; includes feeder, disconnect, and basic circuit infrastructure.",
    components: [
      { componentType: "material", code: "MAT-38-SUBPANEL", description: "60-100A subpanel with breakers", quantity: 1, unit: "ea", unitCost: 480 },
      { componentType: "material", code: "MAT-38-FEEDER", description: "SER feeder cable sized to amp rating", quantity: 1, unit: "lf", unitCost: 2.50, quantityExpr: "feeder_run_length" },
      { componentType: "material", code: "MAT-38-DISCONNECT", description: "Exterior disconnect enclosure", quantity: 1, unit: "ea", unitCost: 125 },
      { componentType: "labor", code: "LAB-38-FEEDER", description: "Feeder route and install labor", quantity: 1, unit: "ea", laborHours: 4.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-38-PANEL", description: "Subpanel mount and termination", quantity: 1, unit: "ea", laborHours: 3.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-38-DISCONNECT", description: "Disconnect installation", quantity: 1, unit: "ea", laborHours: 2.0, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  40: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Dedicated equipment circuit to exterior location; pool, spa, or specialty equipment.",
    components: [
      { componentType: "material", code: "MAT-40-BREAKER", description: "Breaker sized to equipment", quantity: 1, unit: "ea", unitCost: 55 },
      { componentType: "material", code: "MAT-40-WIRE", description: "THHN/THW wire per equipment rating", quantity: 1, unit: "lf", unitCost: 0.80, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-40-CONDUIT", description: "Rigid conduit and fittings", quantity: 1, unit: "lf", unitCost: 0.65, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-40-PANEL", description: "Panel breaker termination", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-40-ROUTE", description: "Route to equipment location", quantity: 1, unit: "lf", laborHours: 0.06, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "run_length" },
    ],
  },
  41: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Package: Shed/outbuilding power package; includes feeder, disconnect, and basic receptacle infrastructure.",
    components: [
      { componentType: "material", code: "MAT-41-DISCONNECT", description: "Exterior disconnect/disconnect-switch enclosure", quantity: 1, unit: "ea", unitCost: 145 },
      { componentType: "material", code: "MAT-41-FEEDER", description: "SER feeder cable to shed location", quantity: 1, unit: "lf", unitCost: 2.00, quantityExpr: "feeder_run_length" },
      { componentType: "material", code: "MAT-41-RECEPTACLE", description: "Weatherproof 15A receptacle", quantity: 1, unit: "ea", unitCost: 35 },
      { componentType: "labor", code: "LAB-41-FEEDER", description: "Feeder route and pull labor", quantity: 1, unit: "ea", laborHours: 3.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-41-DISCONNECT", description: "Disconnect installation", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-41-RECEPTACLE", description: "Install receptacle and test", quantity: 1, unit: "ea", laborHours: 1.0, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  42: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Gate or exterior device feed; small-load exterior power for gates, controllers, etc.",
    components: [
      { componentType: "material", code: "MAT-42-BREAKER", description: "Small breaker (15-20A)", quantity: 1, unit: "ea", unitCost: 40 },
      { componentType: "material", code: "MAT-42-WIRE", description: "14 AWG THHN/THW wire", quantity: 1, unit: "lf", unitCost: 0.30, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-42-CONDUIT", description: "Conduit and fittings", quantity: 1, unit: "lf", unitCost: 0.50, quantityExpr: "run_length" },
      { componentType: "labor", code: "LAB-42-PANEL", description: "Panel breaker termination", quantity: 1, unit: "ea", laborHours: 1.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-42-ROUTE", description: "Route to exterior device location", quantity: 1, unit: "lf", laborHours: 0.05, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "run_length" },
    ],
  },
  84: {
    laborClass: "remove_and_replace",
    pricingType: "allowance_based",
    notes: "Doorbell/chime transformer repair or replacement.",
    components: [
      { componentType: "material", code: "MAT-84-TRANSFORMER", description: "Doorbell transformer 24V", quantity: 1, unit: "ea", unitCost: 45 },
      { componentType: "material", code: "MAT-84-CHIME", description: "Chime unit allowance", quantity: 1, unit: "ea", unitCost: 65 },
      { componentType: "labor", code: "LAB-84-INSTALL", description: "Install transformer and chime", quantity: 1, unit: "ea", laborHours: 1.00, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  90: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "New-construction receptacle point; rough box + trim device.",
    components: [
      { componentType: "material", code: "MAT-90-BOX", description: "New-work box", quantity: 1, unit: "ea", unitCost: 4 },
      { componentType: "material", code: "MAT-90-DEVICE", description: "15A duplex receptacle", quantity: 1, unit: "ea", unitCost: 2.5 },
      { componentType: "material", code: "MAT-90-PLATE", description: "Faceplate", quantity: 1, unit: "ea", unitCost: 1.5 },
      { componentType: "material", code: "MAT-90-WNUT", description: "Wire connector set (3 wirenuts)", quantity: 1, unit: "set", unitCost: 1.5 },
      { componentType: "material", code: "MAT-90-FIT", description: "Cable fittings and fastening hardware", quantity: 1, unit: "ea", unitCost: 2.5 },
      { componentType: "material", code: "MAT-90-CABLE", description: "14/2 NM-B cable", quantity: 1, unit: "lf", unitCost: 0.35, quantityExpr: "branch_circuit_cable_length" },
      { componentType: "labor", code: "LAB-90-ROUGH", description: "Rough-in box placement and cable", quantity: 1, unit: "ea", laborHours: 0.18, laborRate: 90 },
      { componentType: "labor", code: "LAB-90-TRIM", description: "Trim device and plate installation", quantity: 1, unit: "ea", laborHours: 0.12, laborRate: 90 },
    ],
  },
  91: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "New-construction switch point; rough box + trim switch.",
    components: [
      { componentType: "material", code: "MAT-91-BOX", description: "New-work box", quantity: 1, unit: "ea", unitCost: 4 },
      { componentType: "material", code: "MAT-91-DEVICE", description: "Single-pole switch", quantity: 1, unit: "ea", unitCost: 3 },
      { componentType: "material", code: "MAT-91-PLATE", description: "Faceplate", quantity: 1, unit: "ea", unitCost: 1.5 },
      { componentType: "material", code: "MAT-91-WNUT", description: "Wire connector set (3 wirenuts)", quantity: 1, unit: "set", unitCost: 1.5 },
      { componentType: "material", code: "MAT-91-FIT", description: "Cable fittings and fastening hardware", quantity: 1, unit: "ea", unitCost: 2.5 },
      { componentType: "material", code: "MAT-91-CABLE", description: "14/2 NM-B cable", quantity: 1, unit: "lf", unitCost: 0.35, quantityExpr: "branch_circuit_cable_length" },
      { componentType: "labor", code: "LAB-91-ROUGH", description: "Rough-in box placement and cable", quantity: 1, unit: "ea", laborHours: 0.15, laborRate: 90 },
      { componentType: "labor", code: "LAB-91-TRIM", description: "Trim switch and plate installation", quantity: 1, unit: "ea", laborHours: 0.10, laborRate: 90 },
    ],
  },
  92: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "New-construction ceiling light point; rough box + trim fixture.",
    components: [
      { componentType: "material", code: "MAT-92-BOX", description: "Ceiling box and hanger", quantity: 1, unit: "ea", unitCost: 18 },
      { componentType: "material", code: "MAT-92-FIXTURE", description: "Basic ceiling light fixture", quantity: 1, unit: "ea", unitCost: 35 },
      { componentType: "material", code: "MAT-92-CABLE", description: "14/2 NM-B cable", quantity: 1, unit: "lf", unitCost: 0.35, quantityExpr: "branch_circuit_cable_length" },
      { componentType: "labor", code: "LAB-92-ROUGH", description: "Rough-in box placement and cable", quantity: 1, unit: "ea", laborHours: 0.20, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-92-TRIM", description: "Trim fixture installation", quantity: 1, unit: "ea", laborHours: 0.15, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  93: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "New-construction rough-in only point; box and cable, no trim.",
    components: [
      { componentType: "material", code: "MAT-93-BOX", description: "Box and fittings per point type", quantity: 1, unit: "ea", unitCost: 15 },
      { componentType: "material", code: "MAT-93-CABLE", description: "NM-B cable per point type", quantity: 1, unit: "lf", unitCost: 0.35, quantityExpr: "branch_circuit_cable_length" },
      { componentType: "labor", code: "LAB-93-ROUGH", description: "Rough box placement and cable labor", quantity: 1, unit: "ea", laborHours: 0.18, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  94: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "New-construction trim-out only point; device/fixture on pre-roughed box.",
    components: [
      { componentType: "material", code: "MAT-94-DEVICE", description: "Device/fixture per point type", quantity: 1, unit: "ea", unitCost: 20 },
      { componentType: "labor", code: "LAB-94-TRIM", description: "Trim device/fixture installation", quantity: 1, unit: "ea", laborHours: 0.12, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  95: {
    pricingType: "allowance_based",
    notes: "Package: Bedroom room package; complete electrical scope per NEC 210.52(A), 210.70(A), 210.12.",
    components: [],
  },
  96: {
    pricingType: "allowance_based",
    notes: "Package: Bathroom room package; complete electrical scope per NEC 210.11(C)(3), 210.8(A)(1), 210.70.",
    components: [],
  },
  97: {
    pricingType: "allowance_based",
    notes: "Package: Kitchen room package; complete electrical scope per NEC 210.11(C)(1), 210.52(B)/(C), 210.8(A)(6), 210.12.",
    components: [],
  },
  98: {
    pricingType: "allowance_based",
    notes: "Package: Laundry room package; complete electrical scope per NEC 210.11(C)(2), 210.52(F), 210.12.",
    components: [],
  },
  99: {
    pricingType: "allowance_based",
    notes: "Package: Garage room package; complete electrical scope per NEC 210.52(G), 210.8(A)(2), 210.70(A)(2).",
    components: [],
  },
  86: {
    laborClass: "remove_and_replace",
    pricingType: "allowance_based",
    notes: "Specialty switch installation; timer, occupancy sensor, decorator switch, etc.",
    components: [
      { componentType: "material", code: "MAT-86-SWITCH", description: "Specialty switch device", quantity: 1, unit: "ea", unitCost: 65 },
      { componentType: "labor", code: "LAB-86-INSTALL", description: "Switch replacement and testing", quantity: 1, unit: "ea", laborHours: 0.65, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  87: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Baseboard heater circuit; 20A 240V dedicated.",
    components: [
      { componentType: "material", code: "MAT-87-BREAKER", description: "20A 240V breaker", quantity: 1, unit: "ea", unitCost: 45 },
      { componentType: "material", code: "MAT-87-WIRE", description: "12 AWG THHN/THW wire", quantity: 1, unit: "lf", unitCost: 0.50, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-87-CONDUIT", description: "PVC/EMT conduit", quantity: 1, unit: "lf", unitCost: 0.45, quantityExpr: "run_length" },
      { componentType: "material", code: "MAT-87-THERMOSTAT", description: "Line-voltage thermostat", quantity: 1, unit: "ea", unitCost: 75 },
      { componentType: "labor", code: "LAB-87-ROUTE", description: "Route and pull wire to heater", quantity: 1, unit: "ea", laborHours: 2.1, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-87-INSTALL", description: "Heater and thermostat installation", quantity: 1, unit: "ea", laborHours: 1.8, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  100: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Service entrance upgrade; main conductors and service head labor scale with service_height parameter.",
    components: [
      { componentType: "material", code: "MAT-100-BASE", description: "Service entrance hardware and fittings", quantity: 1, unit: "ea", unitCost: 320 },
      { componentType: "material", code: "MAT-100-MAIN", description: "Service entrance conductors (SER cable)", quantity: 1, unit: "lf", unitCost: 3.20, quantityExpr: "service_height" },
      { componentType: "labor", code: "LAB-100-ROUGH", description: "Service head and entrance installation", quantity: 1, unit: "ea", laborHours: 6.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-100-HEIGHT", description: "Elevated service entry labor", quantity: 1, unit: "ft", laborHours: 0.15, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "service_height" },
    ],
  },
  101: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Outlet circuit extension; wire and pull labor scale with circuit_length parameter.",
    components: [
      { componentType: "material", code: "MAT-101-BREAKER", description: "Breaker rated to amp_rating", quantity: 1, unit: "ea", unitCost: 45, quantityExpr: "breaker_qty" },
      { componentType: "material", code: "MAT-101-WIRE", description: "12 AWG THHN/THW wire per amp rating", quantity: 1, unit: "lf", unitCost: 0.40, quantityExpr: "circuit_length" },
      { componentType: "material", code: "MAT-101-CONDUIT", description: "PVC/EMT conduit", quantity: 1, unit: "lf", unitCost: 0.45, quantityExpr: "circuit_length" },
      { componentType: "material", code: "MAT-101-BOX", description: "Outlet box, device and plate", quantity: 1, unit: "ea", unitCost: 20 },
      { componentType: "labor", code: "LAB-101-ROUTE", description: "Route conduit and pull wire", quantity: 1, unit: "ea", laborHours: 1.8, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-101-PULL", description: "Pull wire and make connections", quantity: 1, unit: "lf", laborHours: 0.04, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "circuit_length" },
    ],
  },
  102: {
    laborClass: "new_install",
    pricingType: "neca_informed",
    notes: "Light circuit extension; wire, conduit and fixture labor scale with circuit_length parameter and fixture_count.",
    components: [
      { componentType: "material", code: "MAT-102-BREAKER", description: "15A breaker for lighting", quantity: 1, unit: "ea", unitCost: 35, quantityExpr: "breaker_qty" },
      { componentType: "material", code: "MAT-102-WIRE", description: "14 AWG THHN/THW wire", quantity: 1, unit: "lf", unitCost: 0.30, quantityExpr: "circuit_length" },
      { componentType: "material", code: "MAT-102-CONDUIT", description: "PVC/EMT conduit", quantity: 1, unit: "lf", unitCost: 0.40, quantityExpr: "circuit_length" },
      { componentType: "material", code: "MAT-102-FIXTURES", description: "Light fixture(s) allowance per unit", quantity: 1, unit: "ea", unitCost: 65, quantityExpr: "fixture_count" },
      { componentType: "labor", code: "LAB-102-ROUTE", description: "Route conduit and install boxes", quantity: 1, unit: "ea", laborHours: 1.5, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-102-PULL", description: "Pull wire and make connections", quantity: 1, unit: "lf", laborHours: 0.03, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "circuit_length" },
      { componentType: "labor", code: "LAB-102-FIXTURE", description: "Install light fixtures", quantity: 1, unit: "ea", laborHours: 1.25, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "fixture_count" },
    ],
  },
  103: {
    laborClass: "test_verify",
    pricingType: "allowance_based",
    notes: "Load calculation assessment and panel capacity review.",
    components: [
      { componentType: "labor", code: "LAB-103-CALC", description: "Load calculation and panel review", quantity: 1, unit: "ea", laborHours: 2.0, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-103-REPORT", description: "Findings report and recommendations", quantity: 1, unit: "ea", laborHours: 1.0, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
  104: {
    laborClass: "new_install",
    pricingType: "allowance_based",
    notes: "Install dimmers in a new multi-gang cut-in box; gang_count scales dimmer quantity and wire-nut sets, cable_length scales 12/2 NM-B material and routing labor.",
    components: [
      { componentType: "material", code: "MAT-104-BOX", description: "Old-work cut-in box (1–4 gang)", quantity: 1, unit: "ea", unitCost: 12 },
      { componentType: "material", code: "MAT-104-DIMMER", description: "Decora dimmer switch", quantity: 1, unit: "ea", unitCost: 45, quantityExpr: "gang_count" },
      { componentType: "material", code: "MAT-104-PLATE", description: "Decora cover plate (1–4 gang)", quantity: 1, unit: "ea", unitCost: 10 },
      { componentType: "material", code: "MAT-104-CABLE", description: "12/2 NM-B cable", quantity: 1, unit: "lf", unitCost: 0.75, quantityExpr: "cable_length" },
      { componentType: "material", code: "MAT-104-WNUT", description: "Wire connector set (3 wirenuts)", quantity: 1, unit: "set", unitCost: 1.5, quantityExpr: "gang_count" },
      { componentType: "material", code: "MAT-104-FIT", description: "Hardware and fittings", quantity: 1, unit: "ea", unitCost: 8 },
      { componentType: "labor", code: "LAB-104-CUTIN", description: "Cut-in box and route cable labor", quantity: 1, unit: "ea", laborHours: 0.75, laborRate: DEFAULT_LABOR_RATE },
      { componentType: "labor", code: "LAB-104-DEVICE", description: "Device install and terminate per gang", quantity: 1, unit: "ea", laborHours: 0.40, laborRate: DEFAULT_LABOR_RATE, quantityExpr: "gang_count" },
    ],
  },
  105: {
    laborClass: "repair_existing",
    pricingType: "allowance_based",
    notes: "Splice-through at device box; blank_plate removes switch and installs blank cover, constant_power_outlet re-wires switch leg as always-on outlet.",
    components: [
      { componentType: "material", code: "MAT-105-ALLOW", description: "Wire connectors and blank plate or outlet allowance", quantity: 1, unit: "ea", unitCost: 5 },
      { componentType: "labor", code: "LAB-105-SPLICE", description: "Open box, splice-through, and install cover labor", quantity: 1, unit: "ea", laborHours: 0.75, laborRate: DEFAULT_LABOR_RATE },
    ],
  },
};

export const PHASE_1_TARGETED_ASSEMBLIES = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 22, 23, 24, 25, 26, 27, 31, 32, 33, 34, 37, 43, 44, 45,
  // Wave 1: Appliance/Equipment Circuits
  46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 63, 64, 65, 86, 87,
  // Wave 1: Service and Circuit Additions (renumbered 100-103 to preserve 90-99 for room packages)
  100, 101, 102, 103, 104, 105,
  // Wave 2: Service Cleanup, Repairs, and Support
  66, 67, 68, 69, 70, 73, 74,
  // Wave 3: Specialty Packages and Detached Structures
  38, 40, 41, 42, 84,
  // Wave 3: New Construction Point Atoms and Room Packages
  90, 91, 92, 93, 94, 95, 96, 97, 98, 99,
  // Wave 4: Feeder Assemblies (#21 required child of #38 and #41; #20 companion to #89; #19 MWBC scope)
  19, 20, 21,
  // Existing Phase 1
  75, 76, 77, 78, 79, 80, 81, 82, 83, 85, 89,
] as const;

export const PACKAGE_SUPPORT_ASSEMBLIES = [28, 29, 30, 35, 36, 71, 72] as const;
