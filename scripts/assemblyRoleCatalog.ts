import {
  PACKAGE_SUPPORT_ASSEMBLIES,
  PHASE_1_TARGETED_ASSEMBLIES,
} from "./assemblyPricingCatalog";

export type AssemblyRole = "parent" | "child" | "customizer" | "support_adder";

export type ChildSelectionType = "required_base" | "optional_scope" | "support_adder";

export type ChildSelectionStandard = {
  assemblyNumber: number;
  selectionType: ChildSelectionType;
  required: boolean;
  quantity?: number;
  qtyParameterRef?: string;
  notes?: string;
};

export type ParentChildStandard = {
  parentAssemblyNumber: number;
  optionPresetStrategy: "single_scope" | "good_better_best";
  childSelections: ChildSelectionStandard[];
  mutuallyExclusiveWith?: number[];
  notes?: string;
};

export type AssemblyRoleProfile = {
  assemblyNumber: number;
  family:
    | "diagnostic"
    | "devices"
    | "lighting_controls"
    | "circuits"
    | "panels"
    | "service_entrance"
    | "grounding_bonding"
    | "detached_exterior"
    | "appliance_equipment"
    | "shop_garage"
    | "generator_backup"
    | "specialty"
    | "pool_spa"
    | "support"
    | "room_package"
    | "extended";
  roles: AssemblyRole[];
  notes: string;
};

const ALL_PHASE_1_ASSEMBLIES = [...new Set([...PHASE_1_TARGETED_ASSEMBLIES, ...PACKAGE_SUPPORT_ASSEMBLIES])].sort((a, b) => a - b);

const CHILD_OR_ADDER_ONLY_NUMBERS = new Set([66, 67, 68, 69, 71, 72, 73, 74]);

const SUPPORT_ADDER_NUMBERS = new Set([66, 67, 68, 69, 71, 72, 73, 74, 81, 82, 83]);

const CHILD_CAPABLE_NUMBERS = new Set([
  14, 15, 17, 18, 21, 23, 24, 27, 28, 29, 30, 33, 35, 36, 37, 40, 43, 44, 45, 46, 47, 50,
  71, 72, 77, 78, 80, 81, 82, 83, 89, 90, 91, 92,
]);

function inferFamily(assemblyNumber: number): AssemblyRoleProfile["family"] {
  if (assemblyNumber >= 1 && assemblyNumber <= 3) return "diagnostic";
  if (assemblyNumber >= 4 && assemblyNumber <= 8) return "devices";
  if (assemblyNumber >= 9 && assemblyNumber <= 16) return "lighting_controls";
  if (assemblyNumber >= 17 && assemblyNumber <= 21) return "circuits";
  if (assemblyNumber >= 22 && assemblyNumber <= 27) return "panels";
  if (assemblyNumber >= 28 && assemblyNumber <= 32) return "service_entrance";
  if (assemblyNumber >= 33 && assemblyNumber <= 37) return "grounding_bonding";
  if (assemblyNumber >= 38 && assemblyNumber <= 42) return "detached_exterior";
  if (assemblyNumber >= 43 && assemblyNumber <= 49) return "appliance_equipment";
  if (assemblyNumber >= 50 && assemblyNumber <= 54) return "shop_garage";
  if (assemblyNumber >= 55 && assemblyNumber <= 58) return "generator_backup";
  if (assemblyNumber >= 59 && assemblyNumber <= 62) return "specialty";
  if (assemblyNumber >= 63 && assemblyNumber <= 65) return "pool_spa";
  if (assemblyNumber >= 66 && assemblyNumber <= 94) return "support";
  if (assemblyNumber >= 95 && assemblyNumber <= 99) return "room_package";
  return "extended";
}

function inferBaseRoles(assemblyNumber: number): AssemblyRole[] {
  const roles: AssemblyRole[] = ["customizer"];

  if (!CHILD_OR_ADDER_ONLY_NUMBERS.has(assemblyNumber)) {
    roles.push("parent");
  }

  if (CHILD_CAPABLE_NUMBERS.has(assemblyNumber)) {
    roles.push("child");
  }

  if (SUPPORT_ADDER_NUMBERS.has(assemblyNumber)) {
    roles.push("support_adder");
  }

  return roles;
}

export const PARENT_CHILD_SELECTION_STANDARDS: Record<number, ParentChildStandard> = {
  25: {
    parentAssemblyNumber: 25,
    optionPresetStrategy: "good_better_best",
    mutuallyExclusiveWith: [70],
    notes: "Panel cleanup can drive good/better/best presets with surge/AFCI-GFCI scope.",
    childSelections: [
      { assemblyNumber: 68, selectionType: "optional_scope", required: false, notes: "Demo/cleanup when panel condition requires it." },
      { assemblyNumber: 70, selectionType: "optional_scope", required: false, notes: "Conductor rework for targeted circuit remediation." },
      { assemblyNumber: 37, selectionType: "optional_scope", required: false, notes: "Whole-home surge add-on." },
      { assemblyNumber: 24, selectionType: "optional_scope", required: false, notes: "AFCI/GFCI protective upgrades by selected/all circuits." },
      { assemblyNumber: 72, selectionType: "support_adder", required: false, notes: "Permit allowance when AHJ requires permit pull." },
    ],
  },
  26: {
    parentAssemblyNumber: 26,
    optionPresetStrategy: "good_better_best",
    notes: "Subpanel replacement can be offered as direct swap, surge add, or surge + AFCI/GFCI upgrades.",
    childSelections: [
      { assemblyNumber: 70, selectionType: "optional_scope", required: false, notes: "Conductor rework at subpanel termination points." },
      { assemblyNumber: 37, selectionType: "optional_scope", required: false, notes: "Surge protection option." },
      { assemblyNumber: 24, selectionType: "optional_scope", required: false, notes: "AFCI/GFCI by selected/all branch circuits." },
      { assemblyNumber: 72, selectionType: "support_adder", required: false },
    ],
  },
  27: {
    parentAssemblyNumber: 27,
    optionPresetStrategy: "good_better_best",
    notes: "Main panel replacement supports direct replacement and tiered protection upgrades.",
    childSelections: [
      { assemblyNumber: 68, selectionType: "optional_scope", required: false },
      { assemblyNumber: 70, selectionType: "optional_scope", required: false },
      { assemblyNumber: 37, selectionType: "optional_scope", required: false },
      { assemblyNumber: 24, selectionType: "optional_scope", required: false },
      { assemblyNumber: 81, selectionType: "support_adder", required: false },
      { assemblyNumber: 82, selectionType: "support_adder", required: false },
      { assemblyNumber: 72, selectionType: "support_adder", required: false },
    ],
  },
  32: {
    parentAssemblyNumber: 32,
    optionPresetStrategy: "good_better_best",
    notes: "Service upgrade package parent. Must remain parent-first with guided children and customizer quantities.",
    childSelections: [
      { assemblyNumber: 27, selectionType: "required_base", required: true, quantity: 1 },
      { assemblyNumber: 28, selectionType: "required_base", required: true, quantity: 1 },
      { assemblyNumber: 29, selectionType: "required_base", required: true, quantity: 1 },
      { assemblyNumber: 30, selectionType: "required_base", required: true, quantity: 1 },
      { assemblyNumber: 33, selectionType: "required_base", required: true, quantity: 1 },
      { assemblyNumber: 35, selectionType: "optional_scope", required: false, qtyParameterRef: "gec_upgrade_qty" },
      { assemblyNumber: 36, selectionType: "optional_scope", required: false, qtyParameterRef: "bonding_correction_qty" },
      { assemblyNumber: 37, selectionType: "optional_scope", required: false, qtyParameterRef: "surge_protection_qty" },
      { assemblyNumber: 81, selectionType: "support_adder", required: true, quantity: 1 },
      { assemblyNumber: 82, selectionType: "support_adder", required: true, quantity: 1 },
      { assemblyNumber: 72, selectionType: "support_adder", required: false, qtyParameterRef: "permit_allowance_qty" },
    ],
  },
  38: {
    parentAssemblyNumber: 38,
    optionPresetStrategy: "single_scope",
    notes: "Detached garage package should remain parent container with feeder and trenching options.",
    childSelections: [
      { assemblyNumber: 21, selectionType: "required_base", required: true, quantity: 1 },
      { assemblyNumber: 89, selectionType: "required_base", required: true, quantity: 1 },
      { assemblyNumber: 40, selectionType: "optional_scope", required: false, quantity: 0 },
      { assemblyNumber: 33, selectionType: "optional_scope", required: false, quantity: 1 },
      { assemblyNumber: 83, selectionType: "support_adder", required: false, quantity: 1 },
    ],
  },
  41: {
    parentAssemblyNumber: 41,
    optionPresetStrategy: "single_scope",
    notes: "Outbuilding package parent with feeder/subpanel and optional branch points.",
    childSelections: [
      { assemblyNumber: 21, selectionType: "required_base", required: true, quantity: 1 },
      { assemblyNumber: 89, selectionType: "required_base", required: true, quantity: 1 },
      { assemblyNumber: 17, selectionType: "optional_scope", required: false, quantity: 1 },
      { assemblyNumber: 18, selectionType: "optional_scope", required: false, quantity: 0 },
      { assemblyNumber: 90, selectionType: "optional_scope", required: false, quantity: 2 },
      { assemblyNumber: 92, selectionType: "optional_scope", required: false, quantity: 1 },
      { assemblyNumber: 83, selectionType: "support_adder", required: false, quantity: 1 },
    ],
  },
  58: {
    parentAssemblyNumber: 58,
    optionPresetStrategy: "single_scope",
    notes: "Standby generator package parent for transfer/disconnect/service coordination child scopes.",
    childSelections: [
      { assemblyNumber: 56, selectionType: "optional_scope", required: false },
      { assemblyNumber: 57, selectionType: "optional_scope", required: false },
      { assemblyNumber: 81, selectionType: "support_adder", required: false },
      { assemblyNumber: 82, selectionType: "support_adder", required: false },
    ],
  },
  63: {
    parentAssemblyNumber: 63,
    optionPresetStrategy: "single_scope",
    notes: "Pool/spa feed parent with bonding/disconnect/trenching children.",
    childSelections: [
      { assemblyNumber: 83, selectionType: "support_adder", required: false },
      { assemblyNumber: 36, selectionType: "optional_scope", required: false },
    ],
  },
  64: {
    parentAssemblyNumber: 64,
    optionPresetStrategy: "single_scope",
    childSelections: [
      { assemblyNumber: 83, selectionType: "support_adder", required: false },
      { assemblyNumber: 36, selectionType: "optional_scope", required: false },
    ],
  },
  65: {
    parentAssemblyNumber: 65,
    optionPresetStrategy: "single_scope",
    notes: "Spa full package parent; include trenching/bonding/disconnect decisions in option build.",
    childSelections: [
      { assemblyNumber: 83, selectionType: "support_adder", required: false },
      { assemblyNumber: 36, selectionType: "optional_scope", required: false },
    ],
  },
  79: {
    parentAssemblyNumber: 79,
    optionPresetStrategy: "single_scope",
    childSelections: [
      { assemblyNumber: 77, selectionType: "required_base", required: false, qtyParameterRef: "replace_detector_qty" },
      { assemblyNumber: 78, selectionType: "required_base", required: false, qtyParameterRef: "new_detector_qty" },
      { assemblyNumber: 71, selectionType: "support_adder", required: false, qtyParameterRef: "access_difficulty_qty" },
    ],
  },
  89: {
    parentAssemblyNumber: 89,
    optionPresetStrategy: "good_better_best",
    notes: "Subpanel install parent supports feeder/protection tiering presets.",
    childSelections: [
      { assemblyNumber: 20, selectionType: "required_base", required: false },
      { assemblyNumber: 23, selectionType: "optional_scope", required: false },
      { assemblyNumber: 81, selectionType: "support_adder", required: false },
      { assemblyNumber: 37, selectionType: "optional_scope", required: false },
      { assemblyNumber: 24, selectionType: "optional_scope", required: false },
    ],
  },
  95: {
    parentAssemblyNumber: 95,
    optionPresetStrategy: "single_scope",
    childSelections: [
      { assemblyNumber: 90, selectionType: "required_base", required: true, qtyParameterRef: "receptacle_qty" },
      { assemblyNumber: 91, selectionType: "required_base", required: true, qtyParameterRef: "switch_qty" },
      { assemblyNumber: 92, selectionType: "required_base", required: true, qtyParameterRef: "light_qty" },
      { assemblyNumber: 78, selectionType: "optional_scope", required: false, qtyParameterRef: "smoke_co_qty" },
      { assemblyNumber: 92, selectionType: "optional_scope", required: false, qtyParameterRef: "closet_light_qty" },
      { assemblyNumber: 15, selectionType: "optional_scope", required: false, qtyParameterRef: "ceiling_fan_qty" },
    ],
  },
  96: {
    parentAssemblyNumber: 96,
    optionPresetStrategy: "single_scope",
    childSelections: [
      { assemblyNumber: 90, selectionType: "required_base", required: true, qtyParameterRef: "gfci_receptacle_qty" },
      { assemblyNumber: 91, selectionType: "required_base", required: true, qtyParameterRef: "switch_qty" },
      { assemblyNumber: 92, selectionType: "required_base", required: true, qtyParameterRef: "light_qty" },
      { assemblyNumber: 80, selectionType: "optional_scope", required: false, qtyParameterRef: "exhaust_fan_qty" },
      { assemblyNumber: 17, selectionType: "required_base", required: true, qtyParameterRef: "dedicated_20a_circuit_qty" },
    ],
  },
  97: {
    parentAssemblyNumber: 97,
    optionPresetStrategy: "single_scope",
    childSelections: [
      { assemblyNumber: 17, selectionType: "required_base", required: true, qtyParameterRef: "small_appliance_circuit_count" },
      { assemblyNumber: 90, selectionType: "required_base", required: true, qtyParameterRef: "countertop_gfci_qty" },
      { assemblyNumber: 91, selectionType: "required_base", required: true, qtyParameterRef: "switch_qty" },
      { assemblyNumber: 92, selectionType: "required_base", required: true, qtyParameterRef: "light_qty" },
      { assemblyNumber: 14, selectionType: "optional_scope", required: false, qtyParameterRef: "recessed_light_qty" },
      { assemblyNumber: 46, selectionType: "optional_scope", required: false, qtyParameterRef: "dishwasher_disposal_qty" },
      { assemblyNumber: 47, selectionType: "optional_scope", required: false, qtyParameterRef: "microwave_hood_qty" },
      { assemblyNumber: 44, selectionType: "optional_scope", required: false, qtyParameterRef: "range_circuit_qty" },
    ],
  },
  98: {
    parentAssemblyNumber: 98,
    optionPresetStrategy: "single_scope",
    childSelections: [
      { assemblyNumber: 17, selectionType: "required_base", required: true, qtyParameterRef: "laundry_circuit_qty" },
      { assemblyNumber: 90, selectionType: "required_base", required: true, qtyParameterRef: "receptacle_qty" },
      { assemblyNumber: 91, selectionType: "required_base", required: true, qtyParameterRef: "switch_qty" },
      { assemblyNumber: 92, selectionType: "required_base", required: true, qtyParameterRef: "light_qty" },
      { assemblyNumber: 45, selectionType: "optional_scope", required: false, qtyParameterRef: "dryer_circuit_qty" },
      { assemblyNumber: 43, selectionType: "optional_scope", required: false, qtyParameterRef: "water_heater_circuit_qty" },
    ],
  },
  99: {
    parentAssemblyNumber: 99,
    optionPresetStrategy: "single_scope",
    childSelections: [
      { assemblyNumber: 90, selectionType: "required_base", required: true, qtyParameterRef: "gfci_receptacle_qty" },
      { assemblyNumber: 91, selectionType: "required_base", required: true, qtyParameterRef: "switch_qty" },
      { assemblyNumber: 92, selectionType: "required_base", required: true, qtyParameterRef: "light_qty" },
      { assemblyNumber: 17, selectionType: "optional_scope", required: false, qtyParameterRef: "garage_door_opener_qty" },
      { assemblyNumber: 50, selectionType: "optional_scope", required: false, qtyParameterRef: "shop_equipment_circuit_qty" },
    ],
  },
};

const PARENT_STANDARD_NUMBERS = new Set(Object.keys(PARENT_CHILD_SELECTION_STANDARDS).map(Number));

function buildNotes(assemblyNumber: number, roles: AssemblyRole[]): string {
  if (PARENT_STANDARD_NUMBERS.has(assemblyNumber)) {
    return "Parent-first option build. Apply customizers before finalizing option output.";
  }

  if (roles.includes("support_adder") && !roles.includes("parent")) {
    return "Child/support adder. Prefer inclusion from parent workflow rather than standalone option entry.";
  }

  if (roles.includes("parent") && roles.includes("child")) {
    return "Can be sold standalone as parent or selected as child in larger package scopes.";
  }

  return "Standalone parent scope with job-specific customizer inputs.";
}

export const ASSEMBLY_ROLE_CATALOG: Record<number, AssemblyRoleProfile> = Object.fromEntries(
  ALL_PHASE_1_ASSEMBLIES.map((assemblyNumber) => {
    const roles = inferBaseRoles(assemblyNumber);
    if (PARENT_STANDARD_NUMBERS.has(assemblyNumber) && !roles.includes("parent")) {
      roles.push("parent");
    }

    return [
      assemblyNumber,
      {
        assemblyNumber,
        family: inferFamily(assemblyNumber),
        roles,
        notes: buildNotes(assemblyNumber, roles),
      } satisfies AssemblyRoleProfile,
    ];
  }),
);

export const PANEL_TIER_CUSTOMIZER_KEYS = {
  base: [
    "panel_amp_rating",
    "panel_location_type",
    "overhead_or_underground",
    "branch_circuit_count",
  ],
  protection: [
    "surge_protection_qty",
    "afci_gfci_scope",
    "afci_gfci_upgrade_count",
    "breaker_pole_config",
    "breaker_family",
  ],
  compatibility: [
    "panel_make",
    "panel_series",
    "space_count",
    "circuit_count",
    "tandem_compatibility",
  ],
} as const;

export function getAssemblyRoleCatalogCoverage(): {
  totalAssemblies: number;
  withParentRole: number;
  withChildRole: number;
  withCustomizerRole: number;
  withSupportAdderRole: number;
  uncoveredNumbers: number[];
} {
  const entries = Object.values(ASSEMBLY_ROLE_CATALOG);
  const catalogNumbers = new Set(entries.map((entry) => entry.assemblyNumber));
  const uncoveredNumbers = ALL_PHASE_1_ASSEMBLIES.filter((assemblyNumber) => !catalogNumbers.has(assemblyNumber));

  return {
    totalAssemblies: ALL_PHASE_1_ASSEMBLIES.length,
    withParentRole: entries.filter((entry) => entry.roles.includes("parent")).length,
    withChildRole: entries.filter((entry) => entry.roles.includes("child")).length,
    withCustomizerRole: entries.filter((entry) => entry.roles.includes("customizer")).length,
    withSupportAdderRole: entries.filter((entry) => entry.roles.includes("support_adder")).length,
    uncoveredNumbers,
  };
}
