import {
  PrismaClient,
} from "@prisma/client";
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { deserializeParams, expandTemplate, serializeParams, summarizeComponents } from "./assemblyEngine";
import type { JsonMap } from "../types";

type EstimateStatus = "draft" | "review" | "sent" | "accepted" | "declined" | "expired" | "revised";
type ParameterValueType = "string" | "integer" | "number" | "boolean" | "enum";

type CompanionSuggestion = {
  assemblyNumber: number;
  templateId: string;
  name: string;
  reason: string;
  required: boolean;
};

class ServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

class NotFoundError extends ServiceError {
  constructor(message: string) {
    super(message, 404);
  }
}

class ConflictError extends ServiceError {
  constructor(message: string) {
    super(message, 409);
  }
}

class BadRequestError extends ServiceError {
  constructor(message: string) {
    super(message, 400);
  }
}

const STATE_TRANSITIONS: Record<EstimateStatus, EstimateStatus[]> = {
  draft: ["review"],
  review: ["draft", "sent"],
  sent: ["accepted", "declined", "expired", "revised"],
  accepted: [],
  declined: ["revised"],
  expired: ["revised"],
  revised: ["draft"],
};

const REMOVED_ASSEMBLY_NUMBERS = new Set<number>([39, 61, 62, 88]);

export class EstimateService {
  constructor(private readonly prisma: PrismaClient) {}

  private readonly MUTUALLY_EXCLUSIVE_ASSEMBLY_PAIRS: Array<[number, number]> = [
    [25, 70],
  ];

  private readonly DEPENDENCY_SUGGESTION_RULES: Record<number, Array<{ assemblyNumber: number; reason: string; required: boolean }>> = {
    17: [
      { assemblyNumber: 23, reason: "Panel space/capacity review for new branch circuit.", required: false },
      { assemblyNumber: 81, reason: "Load calculation/panel schedule review for added branch load.", required: false },
    ],
    18: [
      { assemblyNumber: 23, reason: "Panel space/capacity review for new branch circuit.", required: false },
      { assemblyNumber: 81, reason: "Load calculation/panel schedule review for added branch load.", required: false },
    ],
    27: [
      { assemblyNumber: 33, reason: "Grounding review commonly accompanies panel replacement.", required: false },
      { assemblyNumber: 36, reason: "Bonding correction review commonly accompanies panel replacement.", required: false },
      { assemblyNumber: 82, reason: "Utility coordination often required for panel/service cutover.", required: false },
    ],
    32: [
      { assemblyNumber: 33, reason: "Grounding review commonly accompanies full service upgrade.", required: false },
      { assemblyNumber: 36, reason: "Bonding correction review commonly accompanies full service upgrade.", required: false },
      { assemblyNumber: 82, reason: "Utility coordination often required for service cutover.", required: false },
    ],
    38: [
      { assemblyNumber: 83, reason: "Detached/exterior package should review trenching and underground route scope.", required: false },
    ],
    41: [
      { assemblyNumber: 83, reason: "Detached/exterior package should review trenching and underground route scope.", required: false },
    ],
    59: [
      { assemblyNumber: 81, reason: "EV load should trigger load calculation/panel schedule review.", required: false },
      { assemblyNumber: 23, reason: "EV load should trigger breaker/panel capacity review.", required: false },
    ],
    60: [
      { assemblyNumber: 81, reason: "EV load should trigger load calculation/panel schedule review.", required: false },
      { assemblyNumber: 23, reason: "EV load should trigger breaker/panel capacity review.", required: false },
    ],
    63: [
      { assemblyNumber: 83, reason: "Pool/spa equipment scope should review trenching and route complexity.", required: false },
      { assemblyNumber: 36, reason: "Pool/spa equipment scope should review bonding requirements.", required: false },
    ],
    64: [
      { assemblyNumber: 83, reason: "Pool/spa equipment scope should review trenching and route complexity.", required: false },
      { assemblyNumber: 36, reason: "Pool/spa equipment scope should review bonding requirements.", required: false },
    ],
    65: [
      { assemblyNumber: 83, reason: "Pool/spa equipment scope should review trenching and route complexity.", required: false },
      { assemblyNumber: 36, reason: "Pool/spa equipment scope should review bonding requirements.", required: false },
    ],
    75: [
      { assemblyNumber: 15, reason: "Ceiling fan scope should verify fan-rated box support.", required: false },
    ],
    87: [
      { assemblyNumber: 23, reason: "Panel space/capacity review for new branch circuit.", required: false },
      { assemblyNumber: 81, reason: "Load calculation/panel schedule review for added branch load.", required: false },
    ],
    89: [
      { assemblyNumber: 23, reason: "Panel space/capacity review for subpanel feeder source.", required: false },
      { assemblyNumber: 81, reason: "Load calculation/panel schedule review for added distribution load.", required: false },
    ],
  };

  private parseJson(input: string | null | undefined): unknown {
    if (!input) {
      return undefined;
    }

    try {
      return JSON.parse(input);
    } catch {
      return undefined;
    }
  }

  private validateParameterByType(
    key: string,
    valueType: string,
    value: unknown,
    enumOptionsJson: string | null,
  ): string | number | boolean {
    const normalizedType = valueType as ParameterValueType;
    if (normalizedType === "string") {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new BadRequestError(`Parameter '${key}' must be a non-empty string`);
      }
      return value;
    }

    if (normalizedType === "boolean") {
      if (typeof value !== "boolean") {
        throw new BadRequestError(`Parameter '${key}' must be a boolean`);
      }
      return value;
    }

    if (normalizedType === "integer") {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new BadRequestError(`Parameter '${key}' must be an integer`);
      }
      return value;
    }

    if (normalizedType === "number") {
      if (typeof value !== "number" || Number.isNaN(value)) {
        throw new BadRequestError(`Parameter '${key}' must be a number`);
      }
      return value;
    }

    if (normalizedType === "enum") {
      if (typeof value !== "string") {
        throw new BadRequestError(`Parameter '${key}' must be one of the allowed values`);
      }

      const parsed = this.parseJson(enumOptionsJson);
      const allowed = Array.isArray(parsed)
        ? parsed.filter((option): option is string => typeof option === "string")
        : [];

      if (allowed.length > 0 && !allowed.includes(value)) {
        throw new BadRequestError(`Parameter '${key}' has invalid value '${value}'`);
      }
      return value;
    }

    throw new BadRequestError(`Parameter '${key}' has unsupported type '${valueType}'`);
  }

  private validateAndNormalizeParameters(
    definitions: Array<{
      key: string;
      valueType: string;
      required: boolean;
      defaultValueJson: string | null;
      enumOptionsJson: string | null;
      minValue: number | null;
      maxValue: number | null;
    }>,
    incoming: JsonMap,
  ): JsonMap {
    const normalizedInput = this.normalizeParameterAliases(definitions, incoming);

    if (definitions.length === 0) {
      return normalizedInput;
    }

    const unknownKeys = Object.keys(normalizedInput).filter((key) => !definitions.some((def) => def.key === key));
    if (unknownKeys.length > 0) {
      throw new BadRequestError(`Unknown parameters: ${unknownKeys.join(", ")}`);
    }

    const missingRequired: string[] = [];
    const normalized: JsonMap = {};

    for (const definition of definitions) {
      const hasInput = Object.prototype.hasOwnProperty.call(normalizedInput, definition.key);
      let value: unknown = hasInput ? normalizedInput[definition.key] : undefined;

      if (!hasInput) {
        value = this.parseJson(definition.defaultValueJson);
      }

      if (value === undefined) {
        if (definition.required) {
          missingRequired.push(definition.key);
        }
        continue;
      }

      const typedValue = this.validateParameterByType(
        definition.key,
        definition.valueType,
        value,
        definition.enumOptionsJson,
      );

      if (typeof typedValue === "number") {
        if (definition.minValue !== null && typedValue < definition.minValue) {
          throw new BadRequestError(`Parameter '${definition.key}' must be >= ${definition.minValue}`);
        }
        if (definition.maxValue !== null && typedValue > definition.maxValue) {
          throw new BadRequestError(`Parameter '${definition.key}' must be <= ${definition.maxValue}`);
        }
      }

      normalized[definition.key] = typedValue;
    }

    if (missingRequired.length > 0) {
      throw new BadRequestError(`Missing required parameters: ${missingRequired.join(", ")}`);
    }

    return normalized;
  }

  private normalizeParameterAliases(
    definitions: Array<{ key: string; valueType: string }>,
    incoming: JsonMap,
  ): JsonMap {
    const normalized: JsonMap = { ...incoming };
    const definitionKeys = new Set(definitions.map((def) => def.key));
    const assignBinaryFlag = (key: string, enabled: boolean) => {
      if (definitionKeys.has(key)) {
        normalized[key] = enabled ? 1 : 0;
      }
    };
    const assignRunLength = (key: string, enabled: boolean) => {
      if (!definitionKeys.has(key)) {
        return;
      }
      const runLength = normalized.run_length;
      normalized[key] = enabled && typeof runLength === "number" ? runLength : 0;
    };

    const runLengthAliases = ["distance", "cable_run_length", "feeder_length"];
    const hasRunLength = definitionKeys.has("run_length");
    const hasFeederRunLength = definitionKeys.has("feeder_run_length");

    for (const alias of runLengthAliases) {
      if (!Object.prototype.hasOwnProperty.call(normalized, alias)) {
        continue;
      }
      const aliasValue = normalized[alias];
      if (hasRunLength && !Object.prototype.hasOwnProperty.call(normalized, "run_length")) {
        normalized.run_length = aliasValue;
      }
      if (!hasRunLength && hasFeederRunLength && !Object.prototype.hasOwnProperty.call(normalized, "feeder_run_length")) {
        normalized.feeder_run_length = aliasValue;
      }
      delete normalized[alias];
    }

    if (Object.prototype.hasOwnProperty.call(normalized, "run_length") && hasFeederRunLength && !hasRunLength) {
      normalized.feeder_run_length = normalized.run_length;
      delete normalized.run_length;
    }

    const racewayAliases = ["wiring_type", "wiring_method"];
    const hasRacewayType = definitionKeys.has("raceway_type");
    for (const alias of racewayAliases) {
      if (!Object.prototype.hasOwnProperty.call(normalized, alias)) {
        continue;
      }
      if (hasRacewayType && !Object.prototype.hasOwnProperty.call(normalized, "raceway_type")) {
        normalized.raceway_type = normalized[alias];
      }
      delete normalized[alias];
    }

    if (
      Object.prototype.hasOwnProperty.call(normalized, "pole_count")
      && !Object.prototype.hasOwnProperty.call(normalized, "breaker_pole_config")
      && definitionKeys.has("breaker_pole_config")
    ) {
      const raw = normalized.pole_count;
      if (raw === 1 || raw === "1") {
        normalized.breaker_pole_config = "1_pole";
      } else if (raw === 2 || raw === "2") {
        normalized.breaker_pole_config = "2_pole";
      } else if (typeof raw === "string" && /^\d+_pole$/.test(raw.trim())) {
        normalized.breaker_pole_config = raw.trim();
      }
      delete normalized.pole_count;
    }

    if (typeof normalized.device_rating === "string") {
      const is20Amp = normalized.device_rating === "20a";
      assignBinaryFlag("device_15a_qty", !is20Amp);
      assignBinaryFlag("device_20a_qty", is20Amp);
      assignRunLength("run_length_14_2", !is20Amp);
      assignRunLength("run_length_12_2", is20Amp);
    }

    if (typeof normalized.endpoint_device === "string") {
      const endpoint = normalized.endpoint_device;
      assignBinaryFlag("endpoint_14_50_qty", endpoint === "nema_14_50");
      assignBinaryFlag("endpoint_6_50_qty", endpoint === "nema_6_50");
      assignBinaryFlag("endpoint_14_30_qty", endpoint === "nema_14_30");
      assignBinaryFlag("endpoint_hardwire_qty", endpoint === "hardwired");
      assignRunLength("run_length_6_3", endpoint === "nema_14_50");
      assignRunLength("run_length_6_2", endpoint === "nema_6_50" || endpoint === "hardwired");
      assignRunLength("run_length_10_3", endpoint === "nema_14_30");
      assignRunLength("run_length_10_2", endpoint === "hardwired");
    }

    if (typeof normalized.breaker_size === "string") {
      const parsedBreakerSize = Number.parseInt(normalized.breaker_size, 10);
      if (Number.isFinite(parsedBreakerSize) && definitionKeys.has("ampacity")) {
        normalized.ampacity = parsedBreakerSize;
      }
    }

    if (typeof normalized.source_circuit_mode === "string") {
      const needsNewBreaker = normalized.source_circuit_mode === "new_breaker";
      assignBinaryFlag("breaker_qty", needsNewBreaker);
    }

    if (typeof normalized.ev_connection_method === "string") {
      const isCordAndPlug = normalized.ev_connection_method === "cord_and_plug";
      if (definitionKeys.has("breaker_family") && isCordAndPlug) {
        normalized.breaker_family = "gfci";
      }
    }

    return normalized;
  }

  private async assertNoMutualExclusionConflict(
    optionId: string,
    incomingAssemblyNumber: number,
    ignoreAssemblyId?: string,
  ): Promise<void> {
    const existing = await this.prisma.estimateAssembly.findMany({
      where: { optionId },
      include: {
        assemblyTemplate: {
          select: {
            assemblyNumber: true,
            name: true,
          },
        },
      },
    });

    for (const [a, b] of this.MUTUALLY_EXCLUSIVE_ASSEMBLY_PAIRS) {
      let expectedConflictingNumber: number | null = null;
      if (incomingAssemblyNumber === a) {
        expectedConflictingNumber = b;
      } else if (incomingAssemblyNumber === b) {
        expectedConflictingNumber = a;
      }

      if (expectedConflictingNumber === null) {
        continue;
      }

      const conflicting = existing.find((item) => (
        item.id !== ignoreAssemblyId
        && item.assemblyTemplate.assemblyNumber === expectedConflictingNumber
      ));

      if (conflicting) {
        throw new ConflictError(
          `Assemblies #${a} and #${b} are mutually exclusive on the same option. Remove '${conflicting.assemblyTemplate.name}' before adding this scope.`,
        );
      }
    }
  }

  private async buildCompanionSuggestions(optionId: string, assemblyNumber: number): Promise<CompanionSuggestion[]> {
    const rules = this.DEPENDENCY_SUGGESTION_RULES[assemblyNumber] ?? [];
    const existingAssemblies = await this.prisma.estimateAssembly.findMany({
      where: { optionId },
      include: {
        assemblyTemplate: {
          select: { assemblyNumber: true },
        },
      },
    });
    const existingNumbers = new Set(existingAssemblies.map((item) => item.assemblyTemplate.assemblyNumber));

    const contextualRules: Array<{ assemblyNumber: number; reason: string; required: boolean }> = [];
    if ([95, 96, 97, 98, 99].includes(assemblyNumber)) {
      const option = await this.prisma.estimateOption.findUnique({
        where: { id: optionId },
        include: {
          estimate: {
            select: {
              visitId: true,
            },
          },
        },
      });

      if (option?.estimate?.visitId) {
        const visit = await this.prisma.visit.findUnique({
          where: { id: option.estimate.visitId },
          select: { mode: true },
        });

        if (visit && (visit.mode === "remodel" || visit.mode === "new_construction")) {
          contextualRules.push({
            assemblyNumber: 79,
            reason: "Remodel/addition room scope should review smoke/CO coverage package requirements.",
            required: false,
          });
        }
      }
    }

    const combinedRules = [...rules, ...contextualRules];
    if (combinedRules.length === 0) {
      return [];
    }

    const filteredRules = combinedRules
      .filter((rule) => !existingNumbers.has(rule.assemblyNumber))
      .filter((rule, index, arr) => arr.findIndex((candidate) => candidate.assemblyNumber === rule.assemblyNumber) === index);
    if (filteredRules.length === 0) {
      return [];
    }

    const templates = await this.prisma.assemblyTemplate.findMany({
      where: { assemblyNumber: { in: filteredRules.map((rule) => rule.assemblyNumber) } },
      select: {
        id: true,
        assemblyNumber: true,
        name: true,
      },
    });
    const templateByNumber = new Map(templates.map((template) => [template.assemblyNumber, template]));

    return filteredRules
      .map((rule) => {
        const template = templateByNumber.get(rule.assemblyNumber);
        if (!template) {
          return null;
        }
        return {
          assemblyNumber: template.assemblyNumber,
          templateId: template.id,
          name: template.name,
          reason: rule.reason,
          required: rule.required,
        } satisfies CompanionSuggestion;
      })
      .filter((item): item is CompanionSuggestion => item !== null);
  }

  async getAssemblyCompanionSuggestions(input: {
    optionId: string;
    assemblyTemplateId?: string;
    assemblyNumber?: number;
  }): Promise<CompanionSuggestion[]> {
    const option = await this.prisma.estimateOption.findUnique({ where: { id: input.optionId } });
    if (!option) {
      throw new NotFoundError("Estimate option not found");
    }

    let assemblyNumber = input.assemblyNumber;
    if (assemblyNumber === undefined) {
      if (!input.assemblyTemplateId) {
        throw new BadRequestError("assemblyTemplateId or assemblyNumber is required");
      }
      const template = await this.prisma.assemblyTemplate.findUnique({
        where: { id: input.assemblyTemplateId },
        select: { assemblyNumber: true },
      });
      if (!template) {
        throw new NotFoundError("Assembly template not found");
      }
      assemblyNumber = template.assemblyNumber;
    }

    return this.buildCompanionSuggestions(input.optionId, assemblyNumber);
  }

  private readonly CHANGE_ORDER_REASON_TYPES = new Set([
    "customer_request",
    "hidden_condition",
    "utility_requirement",
    "ahj_requirement",
    "damage_discovered",
    "scope_revision",
  ] as const);

  async assertUnlockedEstimate(estimateId: string): Promise<void> {
    const estimate = await this.prisma.estimate.findUnique({ where: { id: estimateId } });
    if (!estimate) {
      throw new NotFoundError("Estimate not found");
    }
    if (estimate.status === "accepted" || estimate.lockedAt) {
      throw new ConflictError("Estimate is locked; use change orders for scope changes");
    }
  }

  async createEstimate(input: { visitId: string; propertyId: string; title: string; notes?: string }) {
    return this.prisma.estimate.create({
      data: {
        visitId: input.visitId,
        propertyId: input.propertyId,
        title: input.title,
        notes: input.notes,
      },
    });
  }

  async deleteEstimate(estimateId: string): Promise<void> {
    const estimate = await this.prisma.estimate.findUnique({ where: { id: estimateId } });
    if (!estimate) {
      throw new NotFoundError("Estimate not found");
    }
    if (estimate.status === "accepted" || estimate.lockedAt) {
      const optionCount = await this.prisma.estimateOption.count({ where: { estimateId } });
      if (optionCount > 0) {
        throw new ConflictError("Accepted estimates cannot be deleted");
      }
    }

    await this.prisma.estimate.delete({ where: { id: estimateId } });
  }

  async addOption(estimateId: string, optionLabel: string, description?: string) {
    await this.assertUnlockedEstimate(estimateId);
    const count = await this.prisma.estimateOption.count({ where: { estimateId } });
    return this.prisma.estimateOption.create({
      data: {
        estimateId,
        optionLabel,
        description,
        sortOrder: count,
      },
    });
  }

  async updateOption(input: {
    optionId: string;
    optionLabel?: string;
    description?: string | null;
  }) {
    const option = await this.prisma.estimateOption.findUnique({
      where: { id: input.optionId },
      include: { estimate: true },
    });
    if (!option) {
      throw new NotFoundError("Estimate option not found");
    }

    await this.assertUnlockedEstimate(option.estimateId);

    return this.prisma.estimateOption.update({
      where: { id: input.optionId },
      data: {
        optionLabel: input.optionLabel,
        description: input.description,
      },
    });
  }

  async getMaterialList(optionId: string): Promise<{
    optionLabel: string;
    items: Array<{ code: string; description: string; quantity: number; unit: string; unitCost: number }>;
  }> {
    const option = await this.prisma.estimateOption.findUnique({
      where: { id: optionId },
      include: {
        assemblies: {
          include: {
            components: {
              where: { componentType: "material" },
            },
          },
        },
      },
    });
    if (!option) throw new NotFoundError("Option not found");

    const map = new Map<string, { description: string; quantity: number; unit: string; unitCost: number }>();
    for (const assembly of option.assemblies) {
      for (const comp of assembly.components) {
        if (map.has(comp.code)) {
          map.get(comp.code)!.quantity += comp.quantity;
        } else {
          map.set(comp.code, {
            description: comp.description,
            quantity: comp.quantity,
            unit: comp.unit ?? "",
            unitCost: comp.unitCost,
          });
        }
      }
    }

    const items = Array.from(map.entries())
      .map(([code, data]) => ({ code, ...data }))
      .sort((a, b) => a.description.localeCompare(b.description));

    return { optionLabel: option.optionLabel, items };
  }

  async deleteOption(optionId: string) {
    const option = await this.prisma.estimateOption.findUnique({
      where: { id: optionId },
      include: { estimate: true },
    });
    if (!option) {
      throw new NotFoundError("Estimate option not found");
    }

    await this.assertUnlockedEstimate(option.estimateId);

    return this.prisma.estimateOption.delete({ where: { id: optionId } });
  }

  async addAssemblyToOption(input: {
    optionId: string;
    assemblyTemplateId: string;
    location?: string;
    quantity?: number;
    parameters?: JsonMap;
    modifiers?: string[];
    manualLaborOverride?: number;
    manualMaterialOverride?: number;
    assemblyNotes?: string;
  }) {
    const option = await this.prisma.estimateOption.findUnique({
      where: { id: input.optionId },
      include: { estimate: true },
    });
    if (!option) {
      throw new NotFoundError("Estimate option not found");
    }

    await this.assertUnlockedEstimate(option.estimateId);

    const template = await this.prisma.assemblyTemplate.findUnique({
      where: { id: input.assemblyTemplateId },
      include: {
        parameterDefinitions: {
          orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
        },
      },
    });
    if (!template) {
      throw new NotFoundError("Assembly template not found");
    }

    if (REMOVED_ASSEMBLY_NUMBERS.has(template.assemblyNumber)) {
      throw new NotFoundError("Assembly template not found");
    }

    await this.assertNoMutualExclusionConflict(input.optionId, template.assemblyNumber);

    const params = this.validateAndNormalizeParameters(
      template.parameterDefinitions,
      input.parameters ?? {},
    );
    const quantity = input.quantity ?? 1;
    const expanded = await expandTemplate(this.prisma, input.assemblyTemplateId, params, quantity);
    const totals = summarizeComponents(expanded);

    let laborCost = totals.labor;
    let materialCost = totals.material;
    if (typeof input.manualLaborOverride === "number") {
      laborCost = input.manualLaborOverride;
    }
    if (typeof input.manualMaterialOverride === "number") {
      materialCost = input.manualMaterialOverride;
    }
    const otherCost = totals.other;

    const estimateAssembly = await this.prisma.estimateAssembly.create({
      data: {
        optionId: input.optionId,
        assemblyTemplateId: input.assemblyTemplateId,
        location: input.location,
        quantity,
        parametersJson: serializeParams(params),
        modifiersJson: JSON.stringify(input.modifiers ?? []),
        manualLaborOverride: input.manualLaborOverride,
        manualMaterialOverride: input.manualMaterialOverride,
        assemblyNotes: input.assemblyNotes,
        laborCost,
        materialCost,
        otherCost,
        totalCost: laborCost + materialCost + otherCost,
      },
    });

    if (expanded.length > 0) {
      await this.prisma.assemblyComponent.createMany({
        data: expanded.map((c) => ({
          estimateAssemblyId: estimateAssembly.id,
          componentType: c.componentType,
          code: c.code,
          description: c.description,
          quantity: c.quantity,
          unit: c.unit,
          unitCost: c.unitCost,
          laborHours: c.laborHours,
          laborRate: c.laborRate,
          extendedCost: c.extendedCost,
        })),
      });
    }

    await this.recalculateOption(input.optionId);

    const created = await this.prisma.estimateAssembly.findUnique({
      where: { id: estimateAssembly.id },
      include: { components: true, assemblyTemplate: true },
    });
    if (!created) {
      return null;
    }

    const companionSuggestions = await this.buildCompanionSuggestions(input.optionId, template.assemblyNumber);
    return {
      ...created,
      companionSuggestions,
    };
  }

  async recalculateOption(optionId: string) {
    const option = await this.prisma.estimateOption.findUnique({
      where: { id: optionId },
      include: { estimate: { select: { id: true, materialMarkupPct: true, laborMarkupPct: true } } },
    });
    if (!option) return;

    const assemblies = await this.prisma.estimateAssembly.findMany({
      where: { optionId },
    });

    const items = await this.prisma.estimateItem.findMany({
      where: { estimateOptionId: optionId },
    });

    const asmLabor = assemblies.reduce((acc, a) => acc + a.laborCost, 0);
    const asmMaterial = assemblies.reduce((acc, a) => acc + a.materialCost, 0);
    const asmOther = assemblies.reduce((acc, a) => acc + a.otherCost, 0);

    const itemLabor = items.reduce((acc, i) => acc + i.laborCost, 0);
    const itemMaterial = items.reduce((acc, i) => acc + i.materialCost, 0);

    let subtotalLabor = asmLabor + itemLabor;
    let subtotalMaterial = asmMaterial + itemMaterial;
    const subtotalOther = asmOther;

    // Apply estimate-level modifiers (OCCUPANCY, SCHEDULE)
    const estModifiers = await this.prisma.estimateModifier.findMany({
      where: { estimateId: option.estimate.id },
    });
    for (const mod of estModifiers) {
      subtotalLabor *= mod.laborMultiplier;
      subtotalMaterial *= mod.materialMult;
    }

    const { materialMarkupPct, laborMarkupPct } = option.estimate;
    const totalCost =
      subtotalLabor * (1 + laborMarkupPct / 100) +
      subtotalMaterial * (1 + materialMarkupPct / 100) +
      subtotalOther;

    return this.prisma.estimateOption.update({
      where: { id: optionId },
      data: { subtotalLabor, subtotalMaterial, subtotalOther, totalCost },
    });
  }

  async updateEstimateMarkup(estimateId: string, input: { materialMarkupPct?: number; laborMarkupPct?: number }) {
    await this.assertUnlockedEstimate(estimateId);

    const estimate = await this.prisma.estimate.update({
      where: { id: estimateId },
      data: {
        ...(typeof input.materialMarkupPct === "number" && { materialMarkupPct: input.materialMarkupPct }),
        ...(typeof input.laborMarkupPct === "number" && { laborMarkupPct: input.laborMarkupPct }),
      },
      include: { options: { select: { id: true } } },
    });

    for (const option of estimate.options) {
      await this.recalculateOption(option.id);
    }

    return this.getEstimateById(estimateId);
  }

  async updateAssembly(input: {
    assemblyId: string;
    location?: string | null;
    quantity?: number;
    parameters?: JsonMap;
  }) {
    const assembly = await this.prisma.estimateAssembly.findUnique({
      where: { id: input.assemblyId },
      include: {
        option: {
          include: {
            estimate: true,
          },
        },
      },
    });
    if (!assembly) {
      throw new NotFoundError("Estimate assembly not found");
    }

    await this.assertUnlockedEstimate(assembly.option.estimateId);

    const template = await this.prisma.assemblyTemplate.findUnique({
      where: { id: assembly.assemblyTemplateId },
      include: {
        parameterDefinitions: {
          orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
        },
      },
    });
    if (!template) {
      throw new NotFoundError("Assembly template not found");
    }

    await this.assertNoMutualExclusionConflict(assembly.optionId, template.assemblyNumber, assembly.id);

    const quantity = input.quantity ?? assembly.quantity;
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new BadRequestError("Quantity must be an integer >= 1");
    }

    const previousParameters = deserializeParams(assembly.parametersJson);
    const params = this.validateAndNormalizeParameters(
      template.parameterDefinitions,
      input.parameters ?? previousParameters,
    );

    const expanded = await expandTemplate(this.prisma, assembly.assemblyTemplateId, params, quantity);
    const totals = summarizeComponents(expanded);

    let laborCost = totals.labor;
    let materialCost = totals.material;
    if (typeof assembly.manualLaborOverride === "number") {
      laborCost = assembly.manualLaborOverride;
    }
    if (typeof assembly.manualMaterialOverride === "number") {
      materialCost = assembly.manualMaterialOverride;
    }
    const otherCost = totals.other;

    const estimateMarkup = await this.prisma.estimate.findUnique({
      where: { id: assembly.option.estimateId },
      select: { materialMarkupPct: true, laborMarkupPct: true },
    });
    const materialMarkupPct = estimateMarkup?.materialMarkupPct ?? 0;
    const laborMarkupPct = estimateMarkup?.laborMarkupPct ?? 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.estimateAssembly.update({
        where: { id: input.assemblyId },
        data: {
          location: input.location === undefined ? assembly.location : input.location,
          quantity,
          parametersJson: serializeParams(params),
          laborCost,
          materialCost,
          otherCost,
          totalCost: laborCost + materialCost + otherCost,
        },
      });

      await tx.assemblyComponent.deleteMany({ where: { estimateAssemblyId: input.assemblyId } });

      if (expanded.length > 0) {
        await tx.assemblyComponent.createMany({
          data: expanded.map((c) => ({
            estimateAssemblyId: input.assemblyId,
            componentType: c.componentType,
            code: c.code,
            description: c.description,
            quantity: c.quantity,
            unit: c.unit,
            unitCost: c.unitCost,
            laborHours: c.laborHours,
            laborRate: c.laborRate,
            extendedCost: c.extendedCost,
          })),
        });
      }

      const assemblies = await tx.estimateAssembly.findMany({ where: { optionId: assembly.optionId } });
      const subtotalLabor = assemblies.reduce((acc, item) => acc + item.laborCost, 0);
      const subtotalMaterial = assemblies.reduce((acc, item) => acc + item.materialCost, 0);
      const subtotalOther = assemblies.reduce((acc, item) => acc + item.otherCost, 0);
      const totalCost =
        subtotalLabor * (1 + laborMarkupPct / 100) +
        subtotalMaterial * (1 + materialMarkupPct / 100) +
        subtotalOther;

      await tx.estimateOption.update({
        where: { id: assembly.optionId },
        data: {
          subtotalLabor,
          subtotalMaterial,
          subtotalOther,
          totalCost,
        },
      });
    });

    const updated = await this.prisma.estimateAssembly.findUnique({
      where: { id: input.assemblyId },
      include: { components: true, assemblyTemplate: true },
    });
    if (!updated) {
      return null;
    }

    const companionSuggestions = await this.buildCompanionSuggestions(assembly.optionId, template.assemblyNumber);
    return {
      ...updated,
      companionSuggestions,
    };
  }

  async deleteAssembly(assemblyId: string) {
    const assembly = await this.prisma.estimateAssembly.findUnique({
      where: { id: assemblyId },
      include: {
        option: {
          include: {
            estimate: true,
          },
        },
      },
    });
    if (!assembly) {
      throw new NotFoundError("Estimate assembly not found");
    }

    await this.assertUnlockedEstimate(assembly.option.estimateId);

    await this.prisma.estimateAssembly.delete({ where: { id: assemblyId } });
    await this.recalculateOption(assembly.optionId);

    return { id: assemblyId };
  }

  async changeEstimateStatus(estimateId: string, nextStatus: EstimateStatus) {
    const estimate = await this.prisma.estimate.findUnique({ where: { id: estimateId } });
    if (!estimate) {
      throw new NotFoundError("Estimate not found");
    }

    if (nextStatus === "accepted") {
      throw new ConflictError("Use proposal acceptance flow to mark estimate accepted");
    }

    const allowed = STATE_TRANSITIONS[estimate.status as EstimateStatus] ?? [];
    if (!allowed.includes(nextStatus)) {
      throw new ConflictError(`Invalid transition ${estimate.status} -> ${nextStatus}`);
    }

    if (nextStatus === "sent") {
      const scopedOptionCount = await this.prisma.estimateOption.count({
        where: {
          estimateId,
          OR: [
            { assemblies: { some: {} } },
            { items: { some: {} } },
          ],
        },
      });
      if (scopedOptionCount <= 0) {
        throw new ConflictError("Cannot send estimate without at least one scoped option");
      }
    }

    const shouldIncrementRevision = nextStatus === "revised";

    return this.prisma.estimate.update({
      where: { id: estimateId },
      data: {
        status: nextStatus,
        revision: shouldIncrementRevision ? { increment: 1 } : undefined,
      },
    });
  }

  async upsertPermitStatus(estimateId: string, input: {
    required: boolean;
    permitType?: string;
    status: "not_required" | "not_filed" | "filed" | "issued" | "expired";
    permitNumber?: string;
    cost?: number;
  }) {
    await this.assertUnlockedEstimate(estimateId);

    return this.prisma.permitStatus.upsert({
      where: { estimateId },
      update: {
        required: input.required,
        permitType: input.permitType,
        status: input.status,
        permitNumber: input.permitNumber,
        cost: input.cost ?? 0,
      },
      create: {
        estimateId,
        required: input.required,
        permitType: input.permitType,
        status: input.status,
        permitNumber: input.permitNumber,
        cost: input.cost ?? 0,
      },
    });
  }

  async upsertInspectionStatus(estimateId: string, input: {
    inspectionType: "rough_in" | "underground" | "final" | "re_inspection" | "service_release" | "temporary_power";
    status: "not_scheduled" | "scheduled" | "passed" | "failed" | "corrections_required";
    notes?: string;
    corrections?: string[];
  }) {
    await this.assertUnlockedEstimate(estimateId);
    const existing = await this.prisma.inspectionStatus.findFirst({
      where: { estimateId, inspectionType: input.inspectionType },
    });

    if (existing) {
      return this.prisma.inspectionStatus.update({
        where: { id: existing.id },
        data: {
          status: input.status,
          notes: input.notes,
          correctionsJson: JSON.stringify(input.corrections ?? []),
        },
      });
    }

    return this.prisma.inspectionStatus.create({
      data: {
        estimateId,
        inspectionType: input.inspectionType,
        status: input.status,
        notes: input.notes,
        correctionsJson: JSON.stringify(input.corrections ?? []),
      },
    });
  }

  async generateProposalPdf(estimateId: string): Promise<{ filePath: string; deliveryId: string }> {
    const estimate = await this.prisma.estimate.findUnique({
      where: { id: estimateId },
      include: {
        property: { include: { customer: true } },
        options: {
          include: {
            assemblies: { include: { assemblyTemplate: true, components: true } },
            items: { include: { atomicUnit: true } },
          },
        },
      },
    });
    if (!estimate) {
      throw new NotFoundError("Estimate not found");
    }

    const outputDir = path.join(process.cwd(), "generated", "proposals");
    fs.mkdirSync(outputDir, { recursive: true });
    const filePath = path.join(outputDir, `${estimate.id}-r${estimate.revision}.pdf`);

    await new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument({ margin: 36 });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      doc.fontSize(18).text("Red Cedar Electric LLC - Proposal", { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(11).text(`Estimate: ${estimate.title}`);
      doc.text(`Revision: ${estimate.revision}`);
      doc.text(`Date: ${new Date().toLocaleDateString()}`);
      doc.text(`Customer: ${estimate.property.customer?.name ?? "N/A"}`);
      doc.text(`Property: ${estimate.property.addressLine1}, ${estimate.property.city}, ${estimate.property.state} ${estimate.property.postalCode}`);
      doc.text(`Markup: Labor ${estimate.laborMarkupPct.toFixed(1)}% | Material ${estimate.materialMarkupPct.toFixed(1)}%`);
      doc.moveDown();

      for (const option of estimate.options) {
        const laborHours = option.assemblies.reduce(
          (acc, asm) =>
            acc + asm.components.filter((c) => c.componentType === "labor").reduce((sum, c) => sum + c.laborHours * c.quantity, 0),
          0,
        );

        doc.fontSize(13).text(`Option: ${option.optionLabel}`);
        doc.fontSize(10).text(option.description ?? "");
        for (const asm of option.assemblies) {
          doc.text(`- ${asm.assemblyTemplate.name} (${asm.location ?? "unspecified"}) - $${asm.totalCost.toFixed(2)}`);
          for (const component of asm.components) {
            doc.text(
              `   * ${component.description}: ${component.quantity}${component.unit ? ` ${component.unit}` : ""} @ $${component.extendedCost.toFixed(2)}`,
            );
          }
        }
        // Atomic items
        for (const item of option.items) {
          const cableInfo = item.resolvedCableCode ? ` + ${item.resolvedCableCode} ${item.cableLength ?? 0} LF` : "";
          doc.text(`- ${item.atomicUnit.code}: ${item.atomicUnit.name} × ${item.quantity} (${item.location ?? "unspecified"}) - $${item.totalCost.toFixed(2)}${cableInfo}`);
        }
        doc.text(`Labor Subtotal: $${option.subtotalLabor.toFixed(2)}`);
        doc.text(`Material Subtotal: $${option.subtotalMaterial.toFixed(2)}`);
        doc.text(`Other Subtotal: $${option.subtotalOther.toFixed(2)}`);
        doc.text(`Estimated Labor Hours: ${laborHours.toFixed(2)}`);
        doc.text(`Option Total: $${option.totalCost.toFixed(2)}`);
        doc.moveDown(0.5);
      }

      doc.moveDown();
      doc.fontSize(9).text(
        "This estimate references NEC 2017 for estimating purposes only. It is not a substitute for adopted code, AHJ requirements, utility requirements, or licensed professional judgment.",
      );
      doc.end();

      stream.on("finish", () => resolve());
      stream.on("error", (err) => reject(err));
    });

    const delivery = await this.prisma.proposalDelivery.create({
      data: {
        estimateId,
        estimateRevision: estimate.revision,
        method: "download",
        pdfPath: filePath,
      },
    });

    return { filePath, deliveryId: delivery.id };
  }

  async recordSignature(input: {
    estimateId: string;
    signerName: string;
    signerEmail?: string;
    signatureData: string;
    consentText: string;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const estimate = await this.prisma.estimate.findUnique({ where: { id: input.estimateId } });
    if (!estimate) {
      throw new NotFoundError("Estimate not found");
    }

    return this.prisma.signatureRecord.create({
      data: {
        estimateId: input.estimateId,
        estimateRevision: estimate.revision,
        signerName: input.signerName,
        signerEmail: input.signerEmail,
        signatureData: input.signatureData,
        consentText: input.consentText,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
    });
  }

  async acceptProposal(input: {
    estimateId: string;
    optionId: string;
    signatureId?: string;
    notes?: string;
    status?: "accepted" | "declined";
  }) {
    const estimate = await this.prisma.estimate.findUnique({
      where: { id: input.estimateId },
      include: { options: true },
    });
    if (!estimate) {
      throw new NotFoundError("Estimate not found");
    }
    if (estimate.status === "accepted") {
      throw new ConflictError("Estimate already accepted");
    }
    if (estimate.status !== "sent") {
      throw new ConflictError("Estimate must be in 'sent' status before acceptance or decline");
    }

    const option = estimate.options.find((o) => o.id === input.optionId);
    if (!option) {
      throw new NotFoundError("Option not found on estimate");
    }

    const status = input.status ?? "accepted";

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.estimateOption.updateMany({
        where: { estimateId: input.estimateId },
        data: { accepted: false },
      });

      await tx.estimateOption.update({
        where: { id: input.optionId },
        data: { accepted: status === "accepted" },
      });

      const acceptance = await tx.proposalAcceptance.upsert({
        where: { estimateId: input.estimateId },
        update: {
          estimateRevision: estimate.revision,
          optionId: input.optionId,
          status,
          signatureId: input.signatureId,
          notes: input.notes,
        },
        create: {
          estimateId: input.estimateId,
          estimateRevision: estimate.revision,
          optionId: input.optionId,
          status,
          signatureId: input.signatureId,
          notes: input.notes,
        },
      });

      const nextStatus: EstimateStatus = status === "accepted" ? "accepted" : "declined";
      const updatedEstimate = await tx.estimate.update({
        where: { id: input.estimateId },
        data: {
          status: nextStatus,
          lockedAt: status === "accepted" ? new Date() : null,
        },
      });

      return { acceptance, updatedEstimate };
    });

    return result;
  }

  async createChangeOrder(input: {
    estimateId: string;
    parentOptionId: string;
    title: string;
    reason?: string;
    reasonType?: "customer_request" | "hidden_condition" | "utility_requirement" | "ahj_requirement" | "damage_discovered" | "scope_revision";
    assembliesAdded?: unknown[];
    assembliesRemoved?: unknown[];
    assembliesModified?: unknown[];
    deltaLabor?: number;
    deltaMaterial?: number;
    deltaOther?: number;
  }) {
    const estimate = await this.prisma.estimate.findUnique({ where: { id: input.estimateId } });
    if (!estimate) {
      throw new NotFoundError("Estimate not found");
    }

    const option = await this.prisma.estimateOption.findUnique({ where: { id: input.parentOptionId } });
    if (!option || option.estimateId !== input.estimateId) {
      throw new NotFoundError("Parent option not found on estimate");
    }

    if (input.reasonType && !this.CHANGE_ORDER_REASON_TYPES.has(input.reasonType)) {
      throw new BadRequestError("Invalid change order reasonType");
    }

    const latest = await this.prisma.changeOrder.findFirst({
      where: { estimateId: input.estimateId },
      orderBy: { sequenceNumber: "desc" },
    });

    const sequenceNumber = latest ? latest.sequenceNumber + 1 : 1;
    const deltaLabor = input.deltaLabor ?? 0;
    const deltaMaterial = input.deltaMaterial ?? 0;
    const deltaOther = input.deltaOther ?? 0;

    return this.prisma.changeOrder.create({
      data: {
        estimateId: input.estimateId,
        parentOptionId: input.parentOptionId,
        sequenceNumber,
        title: input.title,
        reason: input.reason,
        reasonType: input.reasonType,
        estimateRevision: estimate.revision,
        assembliesAddedJson: JSON.stringify(input.assembliesAdded ?? []),
        assembliesRemovedJson: JSON.stringify(input.assembliesRemoved ?? []),
        assembliesModifiedJson: JSON.stringify(input.assembliesModified ?? []),
        deltaLabor,
        deltaMaterial,
        deltaOther,
        deltaTotal: deltaLabor + deltaMaterial + deltaOther,
      },
    });
  }

  async setEstimateModifiers(
    estimateId: string,
    modifiers: Array<{ modifierType: string; modifierValue: string; laborMultiplier: number; materialMult: number }>,
  ) {
    await this.assertUnlockedEstimate(estimateId);

    // Delete existing estimate-level modifiers
    await this.prisma.estimateModifier.deleteMany({ where: { estimateId } });

    // Create new ones
    for (const mod of modifiers) {
      await this.prisma.estimateModifier.create({
        data: {
          estimateId,
          modifierType: mod.modifierType,
          modifierValue: mod.modifierValue,
          laborMultiplier: mod.laborMultiplier,
          materialMult: mod.materialMult,
        },
      });
    }

    // Recalculate all options
    const options = await this.prisma.estimateOption.findMany({
      where: { estimateId },
      select: { id: true },
    });
    for (const option of options) {
      await this.recalculateOption(option.id);
    }

    return this.getEstimateById(estimateId);
  }

  async getEstimateById(estimateId: string) {
    const estimate = await this.prisma.estimate.findUnique({
      where: { id: estimateId },
      include: {
        options: {
          include: {
            assemblies: {
              include: {
                assemblyTemplate: {
                  include: {
                    parameterDefinitions: {
                      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
                    },
                  },
                },
                components: true,
              },
            },
            items: {
              include: {
                atomicUnit: true,
                modifiers: true,
              },
            },
          },
        },
        permitStatus: true,
        inspections: true,
        proposalDeliveries: true,
        signatures: true,
        acceptance: true,
        changeOrders: true,
        estimateModifiers: true,
      },
    });

    if (!estimate) {
      return null;
    }

    return {
      ...estimate,
      options: estimate.options.map((o) => ({
        ...o,
        assemblies: o.assemblies.map((a) => ({
          ...a,
          parameters: deserializeParams(a.parametersJson),
        })),
      })),
    };
  }

  // Utility for tests and manual workflows.
  async createSignaturePlaceholder(estimateId: string) {
    return this.recordSignature({
      estimateId,
      signerName: "Test Signer",
      signatureData: `sig-${uuidv4()}`,
      consentText: "I authorize Red Cedar Electric to proceed with the selected option.",
    });
  }
}
