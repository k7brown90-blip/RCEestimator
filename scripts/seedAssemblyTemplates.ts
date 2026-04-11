import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  DEFAULT_LABOR_RATE,
  PACKAGE_SUPPORT_ASSEMBLIES,
  PHASE_1_PRICING,
  PHASE_1_TARGETED_ASSEMBLIES,
  PRICING_EFFECTIVE_DATE,
  PRICING_VERSION,
} from "./assemblyPricingCatalog";
import {
  PHASE_1_PARAMETER_DEFINITIONS,
  PHASE_1_VARIANTS,
  type AssemblyParameterDefinitionSeed,
  type AssemblyVariantSeed,
} from "./assemblyParameterCatalog";

const prisma = new PrismaClient();

const PHASE_1_IDS: Set<number> = new Set([
  ...PHASE_1_TARGETED_ASSEMBLIES,
  ...PACKAGE_SUPPORT_ASSEMBLIES,
]);

const PACKAGE_CHILD_LINKS: Record<number, Array<{
  child: number;
  quantity?: number;
  qtyParameterRef?: string;
  required: boolean;
}>> = {
  32: [
    { child: 27, quantity: 1, required: true },
    { child: 28, quantity: 1, required: true },
    { child: 29, quantity: 1, required: true },
    { child: 30, quantity: 1, required: true },
    { child: 33, quantity: 1, required: true },
    { child: 35, qtyParameterRef: "gec_upgrade_qty", required: false },
    { child: 36, qtyParameterRef: "bonding_correction_qty", required: false },
    { child: 37, qtyParameterRef: "surge_protection_qty", required: false },
    { child: 81, quantity: 1, required: true },
    { child: 82, quantity: 1, required: true },
    { child: 72, qtyParameterRef: "permit_allowance_qty", required: false },
  ],
  38: [
    { child: 21, quantity: 1, required: true },
    { child: 89, quantity: 1, required: true },
    { child: 40, quantity: 0, required: false },
    { child: 33, quantity: 1, required: false },
    { child: 83, quantity: 1, required: false },
  ],
  41: [
    { child: 21, quantity: 1, required: true },
    { child: 89, quantity: 1, required: true },
    { child: 17, quantity: 1, required: false },
    { child: 18, quantity: 0, required: false },
    { child: 90, quantity: 2, required: false },
    { child: 92, quantity: 1, required: false },
    { child: 83, quantity: 1, required: false },
  ],
  79: [
    { child: 77, qtyParameterRef: "replace_detector_qty", required: false },
    { child: 78, qtyParameterRef: "new_detector_qty", required: false },
    { child: 71, qtyParameterRef: "access_difficulty_qty", required: false },
  ],
  95: [
    { child: 90, qtyParameterRef: "receptacle_qty", required: true },
    { child: 91, qtyParameterRef: "switch_qty", required: true },
    { child: 92, qtyParameterRef: "light_qty", required: true },
    { child: 78, qtyParameterRef: "smoke_co_qty", required: false },
    { child: 92, qtyParameterRef: "closet_light_qty", required: false },
    { child: 15, qtyParameterRef: "ceiling_fan_qty", required: false },
  ],
  96: [
    { child: 90, qtyParameterRef: "gfci_receptacle_qty", required: true },
    { child: 91, qtyParameterRef: "switch_qty", required: true },
    { child: 92, qtyParameterRef: "light_qty", required: true },
    { child: 80, qtyParameterRef: "exhaust_fan_qty", required: false },
    { child: 17, qtyParameterRef: "dedicated_20a_circuit_qty", required: true },
  ],
  97: [
    { child: 17, qtyParameterRef: "small_appliance_circuit_count", required: true },
    { child: 90, qtyParameterRef: "countertop_gfci_qty", required: true },
    { child: 91, qtyParameterRef: "switch_qty", required: true },
    { child: 92, qtyParameterRef: "light_qty", required: true },
    { child: 14, qtyParameterRef: "recessed_light_qty", required: false },
    { child: 46, qtyParameterRef: "dishwasher_disposal_qty", required: false },
    { child: 47, qtyParameterRef: "microwave_hood_qty", required: false },
    { child: 44, qtyParameterRef: "range_circuit_qty", required: false },
  ],
  98: [
    { child: 17, qtyParameterRef: "laundry_circuit_qty", required: true },
    { child: 90, qtyParameterRef: "receptacle_qty", required: true },
    { child: 91, qtyParameterRef: "switch_qty", required: true },
    { child: 92, qtyParameterRef: "light_qty", required: true },
    { child: 45, qtyParameterRef: "dryer_circuit_qty", required: false },
    { child: 43, qtyParameterRef: "water_heater_circuit_qty", required: false },
  ],
  99: [
    { child: 90, qtyParameterRef: "gfci_receptacle_qty", required: true },
    { child: 91, qtyParameterRef: "switch_qty", required: true },
    { child: 92, qtyParameterRef: "light_qty", required: true },
    { child: 17, qtyParameterRef: "garage_door_opener_qty", required: false },
    { child: 50, qtyParameterRef: "shop_equipment_circuit_qty", required: false },
  ],
};

const REMOVED_ASSEMBLY_NUMBERS = [39, 61, 62, 88] as const;

type ParsedAssembly = {
  assemblyNumber: number;
  name: string;
  tier: "atomic" | "package" | "support";
  category: string;
  laborClass?: string;
};

type SeedComponent = {
  componentType: "material" | "labor" | "other";
  code: string;
  description: string;
  quantity: number;
  quantityExpr?: string;
  unit?: string;
  unitCost: number;
  laborHours: number;
  laborRate: number;
};

function inferCategory(sectionNumber: string): string {
  const map: Record<string, string> = {
    "5.1": "diagnostic",
    "5.2": "devices",
    "5.3": "lighting_controls",
    "5.4": "circuits",
    "5.5": "panels",
    "5.6": "service_entrance",
    "5.7": "grounding_bonding",
    "5.8": "detached_exterior",
    "5.9": "appliance_equipment",
    "5.10": "shop_garage",
    "5.11": "generator_backup",
    "5.12": "specialty",
    "5.13": "pool_spa",
    "5.14": "support",
    "5.15": "package",
  };

  return map[sectionNumber] ?? "support";
}

function parseBlueprint(filePath: string): ParsedAssembly[] {
  const text = fs.readFileSync(filePath, "utf8");
  const sectionRegex = /## 5\.(\d+) ([^\n]+)([\s\S]*?)(?=\n## 5\.|\n## 6\.|$)/g;
  const assemblies: ParsedAssembly[] = [];

  let sectionMatch: RegExpExecArray | null;
  while ((sectionMatch = sectionRegex.exec(text)) !== null) {
    const sectionNum = `5.${sectionMatch[1]}`;
    const sectionBody = sectionMatch[3];
    const category = inferCategory(sectionNum);

    const headingRegex = /###\s+(\d+)\.\s+([^\n]+)([\s\S]*?)(?=\n###\s+\d+\.|$)/g;
    let headingMatch: RegExpExecArray | null;
    while ((headingMatch = headingRegex.exec(sectionBody)) !== null) {
      const assemblyNumber = Number(headingMatch[1]);
      if (!PHASE_1_IDS.has(assemblyNumber)) {
        continue;
      }

      const name = headingMatch[2].trim();
      const block = headingMatch[3];
      const tierMatch = block.match(/Tier:\s+`(atomic|package|support)`/);
      const tier = (tierMatch?.[1] as ParsedAssembly["tier"] | undefined) ?? "atomic";
      const laborClassMatch = block.match(/Labor class:\s+`([^`]+)`/i);
      const laborClass = laborClassMatch?.[1];

      assemblies.push({
        assemblyNumber,
        name,
        tier,
        category,
        laborClass,
      });
    }
  }

  return assemblies;
}

function resolveAssemblyBlueprintPath(): string {
  const candidates = [
    path.resolve(process.cwd(), "..", "ASSEMBLY-BLUEPRINT.md"),
    path.resolve(process.cwd(), "ASSEMBLY-BLUEPRINT.md"),
    path.resolve(__dirname, "..", "..", "ASSEMBLY-BLUEPRINT.md"),
    path.resolve(__dirname, "..", "..", "..", "ASSEMBLY-BLUEPRINT.md"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to locate ASSEMBLY-BLUEPRINT.md. Checked: ${candidates.join(", ")}`);
}

function buildComponents(assemblyNumber: number, tier: ParsedAssembly["tier"], name: string): SeedComponent[] {
  const pricing = PHASE_1_PRICING[assemblyNumber];
  if (pricing) {
    return pricing.components.map((component) => ({
      componentType: component.componentType,
      code: component.code,
      description: component.description,
      quantity: component.quantity,
      quantityExpr: component.quantityExpr,
      unit: component.unit,
      unitCost: component.unitCost ?? 0,
      laborHours: component.laborHours ?? 0,
      laborRate: component.laborRate ?? 0,
    }));
  }

  if (tier === "package") {
    return [];
  }

  if (tier === "support") {
    return [
      {
        componentType: "labor",
        code: `LAB-${assemblyNumber}`,
        description: `${name} support labor allowance`,
        quantity: 1,
        unit: "ea",
        unitCost: 0,
        laborHours: 1,
        laborRate: DEFAULT_LABOR_RATE,
      },
    ];
  }

  return [
    {
      componentType: "material",
      code: `MAT-${assemblyNumber}`,
      description: `${name} material allowance`,
      quantity: 1,
      unit: "ea",
      unitCost: 65,
      laborHours: 0,
      laborRate: 0,
    },
    {
      componentType: "labor",
      code: `LAB-${assemblyNumber}`,
      description: `${name} labor allowance`,
      quantity: 1,
      unit: "ea",
      unitCost: 0,
      laborHours: 1.5,
      laborRate: DEFAULT_LABOR_RATE,
    },
  ];
}

async function replaceTemplateComponents(client: PrismaClient, templateId: string, components: SeedComponent[]): Promise<void> {
  await client.assemblyTemplateComponent.deleteMany({ where: { templateId } });
  if (components.length === 0) {
    return;
  }

  await client.assemblyTemplateComponent.createMany({
    data: components.map((component) => ({
      templateId,
      componentType: component.componentType,
      code: component.code,
      description: component.description,
      quantity: component.quantity,
      quantityExpr: component.quantityExpr ?? null,
      unit: component.unit,
      unitCost: component.unitCost,
      laborHours: component.laborHours,
      laborRate: component.laborRate,
    })),
  });
}

async function replaceParameterDefinitions(
  client: PrismaClient,
  templateId: string,
  definitions: AssemblyParameterDefinitionSeed[],
): Promise<void> {
  await client.assemblyParameterDefinition.deleteMany({ where: { templateId } });
  if (definitions.length === 0) {
    return;
  }

  await client.assemblyParameterDefinition.createMany({
    data: definitions.map((def, index) => ({
      templateId,
      key: def.key,
      label: def.label,
      valueType: def.valueType,
      required: def.required ?? false,
      defaultValueJson: def.defaultValue !== undefined ? JSON.stringify(def.defaultValue) : undefined,
      enumOptionsJson: def.enumOptions ? JSON.stringify(def.enumOptions) : undefined,
      unit: def.unit,
      helpText: def.helpText,
      estimatorFacing: def.estimatorFacing ?? true,
      sortOrder: def.sortOrder ?? index,
      minValue: def.minValue,
      maxValue: def.maxValue,
    })),
  });
}

async function replaceTemplateVariants(
  client: PrismaClient,
  templateId: string,
  variants: AssemblyVariantSeed[],
): Promise<void> {
  await client.assemblyTemplateVariant.deleteMany({ where: { templateId } });
  if (variants.length === 0) {
    return;
  }

  await client.assemblyTemplateVariant.createMany({
    data: variants.map((variant) => ({
      templateId,
      variantKey: variant.variantKey,
      variantValue: variant.variantValue,
      notes: variant.notes,
    })),
  });
}

function inferFallbackParameterDefinitions(assembly: ParsedAssembly): AssemblyParameterDefinitionSeed[] {
  if (assembly.tier === "package") {
    return [
      {
        key: "scope_units",
        label: "Scope Units",
        valueType: "integer",
        required: true,
        minValue: 1,
        maxValue: 20,
        defaultValue: 1,
        helpText: "Base quantity of package scope represented by this line item.",
      },
      {
        key: "difficulty_tier",
        label: "Difficulty Tier",
        valueType: "enum",
        required: true,
        enumOptions: ["easy", "standard", "difficult"],
        defaultValue: "standard",
      },
    ];
  }

  if (assembly.category === "circuits" || assembly.category === "appliance_equipment" || assembly.category === "detached_exterior") {
    return [
      {
        key: "run_length",
        label: "Run Length",
        valueType: "number",
        required: true,
        unit: "ft",
        minValue: 5,
        maxValue: 300,
        defaultValue: 25,
      },
      {
        key: "route_access",
        label: "Route Access",
        valueType: "enum",
        required: true,
        enumOptions: ["open", "finished_wall", "attic_accessible", "crawlspace"],
        defaultValue: "finished_wall",
      },
    ];
  }

  if (assembly.category === "service_entrance" || assembly.category === "panels" || assembly.category === "grounding_bonding") {
    return [
      {
        key: "ampacity",
        label: "Ampacity",
        valueType: "integer",
        required: true,
        unit: "A",
        minValue: 60,
        maxValue: 400,
        defaultValue: 200,
      },
      {
        key: "difficulty_tier",
        label: "Difficulty Tier",
        valueType: "enum",
        required: true,
        enumOptions: ["easy", "standard", "difficult"],
        defaultValue: "standard",
      },
    ];
  }

  if (assembly.category === "diagnostic" || assembly.category === "support") {
    return [
      {
        key: "quantity",
        label: "Quantity",
        valueType: "integer",
        required: true,
        minValue: 1,
        maxValue: 20,
        defaultValue: 1,
      },
      {
        key: "difficulty_tier",
        label: "Difficulty Tier",
        valueType: "enum",
        required: true,
        enumOptions: ["easy", "standard", "difficult"],
        defaultValue: "standard",
      },
    ];
  }

  return [
    {
      key: "quantity",
      label: "Quantity",
      valueType: "integer",
      required: true,
      minValue: 1,
      maxValue: 50,
      defaultValue: 1,
    },
    {
      key: "location_type",
      label: "Location Type",
      valueType: "enum",
      required: true,
      enumOptions: ["interior", "garage", "exterior"],
      defaultValue: "interior",
    },
  ];
}

function inferFallbackVariants(assembly: ParsedAssembly): AssemblyVariantSeed[] {
  if (assembly.category === "diagnostic" || assembly.category === "support") {
    return [
      { variantKey: "project_mode", variantValue: "service_diagnostic" },
      { variantKey: "project_mode", variantValue: "maintenance" },
    ];
  }

  return [
    { variantKey: "project_mode", variantValue: "remodel" },
    { variantKey: "project_mode", variantValue: "new_construction" },
  ];
}

function resolveParameterDefinitions(assembly: ParsedAssembly): AssemblyParameterDefinitionSeed[] {
  const explicit = PHASE_1_PARAMETER_DEFINITIONS[assembly.assemblyNumber];
  return explicit && explicit.length > 0
    ? explicit
    : inferFallbackParameterDefinitions(assembly);
}

function resolveVariants(assembly: ParsedAssembly): AssemblyVariantSeed[] {
  const explicit = PHASE_1_VARIANTS[assembly.assemblyNumber];
  return explicit && explicit.length > 0
    ? explicit
    : inferFallbackVariants(assembly);
}

export async function seedAssemblyTemplates(client: PrismaClient = prisma): Promise<void> {
  const assemblyBlueprintPath = resolveAssemblyBlueprintPath();
  const parsed = parseBlueprint(assemblyBlueprintPath);
  const parsedByAssembly = new Map<number, ParsedAssembly>(parsed.map((entry) => [entry.assemblyNumber, entry]));

  for (const a of parsed) {
    const templateId = `asm-${String(a.assemblyNumber).padStart(3, "0")}-v1`;
    const pricing = PHASE_1_PRICING[a.assemblyNumber];
    const parameterDefinitions = resolveParameterDefinitions(a);
    const variants = resolveVariants(a);
    const descriptionSuffix = pricing
      ? ` [Pricing ${PRICING_VERSION} ${PRICING_EFFECTIVE_DATE}; ${pricing.pricingType}]`
      : "";
    await client.assemblyTemplate.upsert({
      where: { id: templateId },
      update: {
        assemblyNumber: a.assemblyNumber,
        name: a.name,
        tier: a.tier,
        category: a.category,
        laborClass: pricing?.laborClass ?? a.laborClass,
        description: pricing
          ? `${pricing.notes}${descriptionSuffix}`
          : undefined,
        applicableModesJson: JSON.stringify(["new_construction", "remodel", "service_diagnostic", "maintenance"]),
      },
      create: {
        id: templateId,
        assemblyNumber: a.assemblyNumber,
        name: a.name,
        tier: a.tier,
        category: a.category,
        laborClass: pricing?.laborClass ?? a.laborClass,
        description: pricing
          ? `${pricing.notes}${descriptionSuffix}`
          : undefined,
        applicableModesJson: JSON.stringify(["new_construction", "remodel", "service_diagnostic", "maintenance"]),
      },
    });

    await replaceTemplateComponents(client, templateId, buildComponents(a.assemblyNumber, a.tier, a.name));
    await replaceParameterDefinitions(client, templateId, parameterDefinitions);
    await replaceTemplateVariants(client, templateId, variants);
  }

  for (const [parent, links] of Object.entries(PACKAGE_CHILD_LINKS)) {
    const parentId = `asm-${String(Number(parent)).padStart(3, "0")}-v1`;
    const parentExists = await client.assemblyTemplate.findUnique({ where: { id: parentId } });
    if (!parentExists) {
      await client.assemblyTemplate.create({
        data: {
          id: parentId,
          assemblyNumber: Number(parent),
          name: `Assembly #${parent}`,
          tier: "package",
          category: "package",
        },
      });
    }

    for (const link of links) {
      const child = link.child;
      const childId = `asm-${String(child).padStart(3, "0")}-v1`;
      const parsedChild = parsedByAssembly.get(child) ?? {
        assemblyNumber: child,
        name: `Assembly #${child}`,
        tier: "atomic" as const,
        category: "support",
      };
      const childExists = await client.assemblyTemplate.findUnique({ where: { id: childId } });
      if (!childExists) {
        const childPricing = PHASE_1_PRICING[child];
        await client.assemblyTemplate.create({
          data: {
            id: childId,
            assemblyNumber: child,
            name: parsedChild.name,
            tier: parsedChild.tier,
            category: parsedChild.category,
            laborClass: childPricing?.laborClass,
            description: childPricing
              ? `${childPricing.notes} [Pricing ${PRICING_VERSION} ${PRICING_EFFECTIVE_DATE}; ${childPricing.pricingType}]`
              : undefined,
          },
        });
      }

      await replaceTemplateComponents(client, childId, buildComponents(child, parsedChild.tier, parsedChild.name));
      await replaceParameterDefinitions(client, childId, resolveParameterDefinitions(parsedChild));
      await replaceTemplateVariants(client, childId, resolveVariants(parsedChild));
    }

    await client.assemblyTemplateChild.deleteMany({ where: { parentTemplateId: parentId } });
    await client.assemblyTemplateChild.createMany({
      data: links.map((link) => ({
        parentTemplateId: parentId,
        childTemplateId: `asm-${String(link.child).padStart(3, "0")}-v1`,
        quantity: link.quantity,
        qtyParameterRef: link.qtyParameterRef,
        required: link.required,
      })),
    });
  }

  await client.assemblyTemplateChild.deleteMany({
    where: {
      OR: [
        { parentTemplate: { assemblyNumber: { in: REMOVED_ASSEMBLY_NUMBERS as unknown as number[] } } },
        { childTemplate: { assemblyNumber: { in: REMOVED_ASSEMBLY_NUMBERS as unknown as number[] } } },
      ],
    },
  });

  await client.assemblyTemplate.deleteMany({
    where: {
      assemblyNumber: { in: REMOVED_ASSEMBLY_NUMBERS as unknown as number[] },
      estimateAssemblies: { none: {} },
    },
  });

  // eslint-disable-next-line no-console
  console.log(`Seeded Phase 1 assembly templates: ${parsed.length} (${PRICING_VERSION})`);
}

if (require.main === module) {
  seedAssemblyTemplates()
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
