import { PrismaClient } from "@prisma/client";
import type { ExpandedComponent, JsonMap, Totals } from "../types";

const round2 = (n: number): number => Math.round(n * 100) / 100;

const BREAKER_BASE_COST_BY_AMP: Record<number, number> = {
  15: 9,
  20: 12,
  25: 16,
  30: 20,
  35: 25,
  40: 32,
  45: 40,
  50: 50,
  60: 62,
  70: 84,
  80: 96,
  90: 108,
  100: 122,
  110: 136,
  125: 158,
  150: 196,
  175: 245,
  200: 290,
  225: 345,
  250: 398,
  300: 510,
  350: 620,
  400: 740,
};

const BREAKER_FAMILY_MULTIPLIER: Record<string, number> = {
  standard: 1,
  gfci: 2.3,
  afci: 1.9,
  tandem: 1.25,
  dual_function_gfci_afci: 2.8,
};

const RACEWAY_WIRE_MULTIPLIER: Record<string, number> = {
  nm: 0.78,
  ac_mc: 1.12,
  emt: 1,
  pvc: 0.94,
  fmc: 1.18,
  lfmc: 1.3,
  imc: 1.22,
  rigid: 1.38,
  ser: 1.55,
};

const RACEWAY_CONDUIT_MULTIPLIER: Record<string, number> = {
  nm: 0,
  ac_mc: 0,
  ser: 0,
  emt: 1,
  pvc: 0.85,
  fmc: 1.25,
  lfmc: 1.4,
  imc: 1.35,
  rigid: 1.55,
};

const CONDUCTOR_TYPE_MULTIPLIER: Record<string, number> = {
  copper: 1,
  aluminum: 0.72,
};

function parseJsonMap(input: string | null): JsonMap {
  if (!input) return {};
  try {
    return JSON.parse(input) as JsonMap;
  } catch {
    return {};
  }
}

function evaluateExpression(expr: string, params: JsonMap): number {
  const cleaned = expr.replace(/parameters\./g, "").trim();
  const simpleParam = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cleaned);
  if (simpleParam) {
    const val = params[cleaned];
    return typeof val === "number" ? val : 0;
  }

  const match = cleaned.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*([*/])\s*(\d+(?:\.\d+)?)$/);
  if (!match) return 0;
  const left = params[match[1]];
  if (typeof left !== "number") return 0;
  const right = Number(match[3]);
  if (match[2] === "*") return left * right;
  return right === 0 ? 0 : left / right;
}

function calcComponentCost(componentType: string, quantity: number, unitCost: number, laborHours: number, laborRate: number): number {
  if (componentType === "labor") {
    return laborHours * laborRate * quantity;
  }
  return quantity * unitCost;
}

function parseNumberParam(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function nearestBreakerSize(amp: number): number | undefined {
  const sizes = Object.keys(BREAKER_BASE_COST_BY_AMP).map(Number).sort((a, b) => a - b);
  for (const size of sizes) {
    if (amp <= size) {
      return size;
    }
  }
  return sizes[sizes.length - 1];
}

function getRacewayType(params: JsonMap): string | undefined {
  const raceway = params.raceway_type;
  if (typeof raceway === "string") {
    return raceway;
  }

  const wiringType = params.wiring_type;
  if (typeof wiringType === "string") {
    return wiringType;
  }

  const wiringMethod = params.wiring_method;
  if (typeof wiringMethod === "string") {
    return wiringMethod;
  }

  return undefined;
}

function resolveDynamicUnitCost(
  componentType: string,
  code: string,
  description: string,
  baseUnitCost: number,
  params: JsonMap,
): number {
  if (componentType !== "material") {
    return baseUnitCost;
  }

  const isBreakerLine = /BREAKER|BKR|ADDBKR/i.test(code);
  if (!isBreakerLine) {
    const searchableText = `${code} ${description}`.toUpperCase();
    const racewayType = getRacewayType(params);
    const conductorType = typeof params.conductor_type === "string" ? params.conductor_type : undefined;

    const isConduitLine = /CONDUIT|RACEWAY|EMT|PVC|FMC|LFMC|IMC|RIGID/.test(searchableText);
    if (isConduitLine && racewayType) {
      const conduitMultiplier = RACEWAY_CONDUIT_MULTIPLIER[racewayType];
      if (conduitMultiplier !== undefined) {
        return round2(baseUnitCost * conduitMultiplier);
      }
    }

    const isAccessoryLine = /CONNECTOR|WNUT|SPLICE|TERMINATION|HARDWARE/.test(searchableText);
    const isWireLine = /WIRE|CABLE|FEEDER|THHN|THWN|NM-B|MC|SER/.test(searchableText);
    if (isWireLine && !isAccessoryLine) {
      let unitCost = baseUnitCost;
      if (racewayType) {
        const wireMultiplier = RACEWAY_WIRE_MULTIPLIER[racewayType];
        if (wireMultiplier !== undefined) {
          unitCost *= wireMultiplier;
        }
      }
      if (conductorType) {
        const conductorMultiplier = CONDUCTOR_TYPE_MULTIPLIER[conductorType];
        if (conductorMultiplier !== undefined) {
          unitCost *= conductorMultiplier;
        }
      }
      return round2(unitCost);
    }

    return baseUnitCost;
  }

  const requestedAmp = parseNumberParam(params.breaker_size) ?? parseNumberParam(params.ampacity);
  if (!requestedAmp || requestedAmp <= 0) {
    return baseUnitCost;
  }

  const size = nearestBreakerSize(requestedAmp);
  if (!size) {
    return baseUnitCost;
  }

  const breakerFamily = typeof params.breaker_family === "string" ? params.breaker_family : "standard";
  const familyMultiplier = BREAKER_FAMILY_MULTIPLIER[breakerFamily] ?? BREAKER_FAMILY_MULTIPLIER.standard;

  const poleConfig = typeof params.breaker_pole_config === "string" ? params.breaker_pole_config : "1_pole";
  const poleMultiplier = poleConfig.includes("2_pole") ? 1.75 : 1;

  return round2(BREAKER_BASE_COST_BY_AMP[size] * familyMultiplier * poleMultiplier);
}

async function expandAtomic(
  prisma: PrismaClient,
  templateId: string,
  parentParams: JsonMap,
  multiplier: number,
): Promise<ExpandedComponent[]> {
  const template = await prisma.assemblyTemplate.findUnique({
    where: { id: templateId },
    include: { components: true },
  });

  if (!template) {
    throw new Error(`Assembly template not found: ${templateId}`);
  }

  const components: ExpandedComponent[] = template.components.map((c) => {
    const qtyFromExpr = c.quantityExpr ? evaluateExpression(c.quantityExpr, parentParams) : c.quantity;
    const quantity = round2((qtyFromExpr || 0) * multiplier);
    const resolvedUnitCost = resolveDynamicUnitCost(c.componentType, c.code, c.description, c.unitCost, parentParams);
    const extendedCost = round2(calcComponentCost(c.componentType, quantity, resolvedUnitCost, c.laborHours, c.laborRate));
    return {
      componentType: c.componentType as ExpandedComponent["componentType"],
      code: c.code,
      description: c.description,
      quantity,
      unit: c.unit,
      unitCost: resolvedUnitCost,
      laborHours: c.laborHours,
      laborRate: c.laborRate,
      extendedCost,
    };
  });

  return components;
}

export async function expandTemplate(
  prisma: PrismaClient,
  templateId: string,
  params: JsonMap,
  quantity = 1,
): Promise<ExpandedComponent[]> {
  const template = await prisma.assemblyTemplate.findUnique({
    where: { id: templateId },
    include: {
      childLinks: true,
      components: true,
    },
  });

  if (!template) {
    throw new Error(`Assembly template not found: ${templateId}`);
  }

  if (template.tier !== "package") {
    return expandAtomic(prisma, template.id, params, quantity);
  }

  const expanded: ExpandedComponent[] = [];

  for (const child of template.childLinks) {
    let childQty = child.quantity ?? 1;
    if (child.qtyParameterRef) {
      const val = params[child.qtyParameterRef];
      childQty = typeof val === "number" ? val : 0;
    }
    if (!child.required && childQty <= 0) {
      continue;
    }
    if (childQty <= 0) {
      continue;
    }

    const childComponents = await expandTemplate(prisma, child.childTemplateId, params, childQty * quantity);
    expanded.push(...childComponents);
  }

  const packageDirect = await expandAtomic(prisma, template.id, params, quantity);
  expanded.push(...packageDirect);

  return expanded;
}

export function summarizeComponents(components: ExpandedComponent[]): Totals {
  let labor = 0;
  let material = 0;
  let other = 0;

  for (const c of components) {
    if (c.componentType === "labor") {
      labor += c.extendedCost;
    } else if (c.componentType === "material") {
      material += c.extendedCost;
    } else {
      other += c.extendedCost;
    }
  }

  return {
    labor: round2(labor),
    material: round2(material),
    other: round2(other),
    total: round2(labor + material + other),
  };
}

export function serializeParams(input: unknown): string {
  if (!input || typeof input !== "object") {
    return JSON.stringify({});
  }
  return JSON.stringify(input);
}

export function deserializeParams(input: string | null): JsonMap {
  return parseJsonMap(input);
}
