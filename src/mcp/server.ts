import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { EstimateService } from "../services/estimateService";
import { resolveItemCable } from "../services/wiringMethodResolver";
import { generateSupportItems } from "../services/supportItemTriggers";
import { validateEstimate } from "../services/estimateValidator";

const service = new EstimateService(prisma);

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "red-cedar-estimating",
    version: "1.0.0",
  });

  // ─── READ TOOLS ──────────────────────────────────────────────────────────────

  server.registerTool(
    "query_atomic_units",
    {
      description:
        "Search the atomic unit catalog. Returns unit codes, names, categories, labor/material costs, and whether cable length is required. Use the catalog filter to narrow results to a specific work type.",
      inputSchema: {
        category: z.string().optional().describe("Filter by category (e.g. LINE, ROUGH_IN, TRIM, DEMO, PANEL, ACCESS, CIRCUIT_MOD, SURFACE, DIAG, TROUBLE, INSPECT)"),
        searchTerm: z.string().optional().describe("Free-text search against unit name or code"),
        catalog: z.string().optional().describe("Filter by catalog: 'new_work', 'old_work', 'service', or 'shared'. Omit to search all catalogs."),
      },
    },
    async ({ category, searchTerm, catalog }) => {
      const where: Record<string, unknown> = { isActive: true };
      if (category) where["category"] = category;
      if (catalog) where["catalog"] = catalog;

      let units = await prisma.atomicUnit.findMany({
        where,
        orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
      });

      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        units = units.filter(
          (u) =>
            u.code.toLowerCase().includes(term) ||
            u.name.toLowerCase().includes(term)
        );
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              units.map((u) => ({
                code: u.code,
                catalog: u.catalog,
                name: u.name,
                category: u.category,
                unitType: u.unitType,
                baseLaborHrs: u.baseLaborHrs,
                baseLaborRate: u.baseLaborRate,
                baseMaterialCost: u.baseMaterialCost,
                requiresCableLength: u.requiresCableLength,
                resolverGroupId: u.resolverGroupId,
              })),
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "query_modifiers",
    {
      description:
        "List available modifier definitions (ACCESS, HEIGHT, CONDITION, OCCUPANCY, SCHEDULE) with their multipliers.",
      inputSchema: {
        modifierType: z.string().optional().describe("Filter by type: ACCESS, HEIGHT, CONDITION, OCCUPANCY, SCHEDULE"),
      },
    },
    async ({ modifierType }) => {
      const where: Record<string, unknown> = {};
      if (modifierType) where["modifierType"] = modifierType;

      const mods = await prisma.modifierDef.findMany({
        where,
        orderBy: [{ modifierType: "asc" }, { sortOrder: "asc" }],
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(mods, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "query_nec_rules",
    {
      description:
        "List active NEC rules with trigger conditions, articles, and prompt text.",
      inputSchema: {},
    },
    async () => {
      const rules = await prisma.nECRule.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(rules, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "query_presets",
    {
      description:
        "List available preset templates for common job scopes.",
      inputSchema: {},
    },
    async () => {
      const presets = await prisma.preset.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(presets, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_property_context",
    {
      description:
        "Get property details including address, occupancy type, and electrical system snapshot (panel info, service amperage, grounding, etc.).",
      inputSchema: {
        propertyId: z.string().describe("The property ID"),
      },
    },
    async ({ propertyId }) => {
      const property = await prisma.property.findUnique({
        where: { id: propertyId },
        include: { systemSnapshot: true },
      });

      if (!property) {
        return {
          content: [{ type: "text" as const, text: "Property not found" }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(property, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_visit_context",
    {
      description:
        "Get visit details including customer request, observations, findings, limitations, and recommendations. Use this to understand the job scope before creating an estimate.",
      inputSchema: {
        visitId: z.string().describe("The visit ID"),
      },
    },
    async ({ visitId }) => {
      const visit = await prisma.visit.findUnique({
        where: { id: visitId },
        include: {
          customer: true,
          property: { include: { systemSnapshot: true } },
          customerRequest: true,
          observations: true,
          findings: true,
          limitations: true,
          recommendations: true,
          estimates: {
            include: { options: true },
            orderBy: { createdAt: "desc" },
          },
        },
      });

      if (!visit) {
        return {
          content: [{ type: "text" as const, text: "Visit not found" }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(visit, null, 2),
          },
        ],
      };
    }
  );

  // ─── WRITE TOOLS ─────────────────────────────────────────────────────────────

  server.registerTool(
    "create_estimate",
    {
      description:
        "Create a new estimate for a visit. Returns the estimate ID and the default option ID. You must create an estimate before adding items.",
      inputSchema: {
        visitId: z.string().describe("The visit ID"),
        propertyId: z.string().describe("The property ID"),
        title: z.string().describe("Estimate title (e.g. 'Kitchen Remodel Electrical')"),
      },
    },
    async ({ visitId, propertyId, title }) => {
      const estimate = await service.createEstimate({ visitId, propertyId, title });

      // Auto-create a default option so items can be added immediately
      const defaultOption = await service.addOption(estimate.id, "Default", "Primary estimate option");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                estimateId: estimate.id,
                optionId: defaultOption.id,
                title: estimate.title,
                status: estimate.status,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "add_estimate_items",
    {
      description:
        "Add one or more estimate items (atomic units) to an estimate option. Each item needs an atomic unit code and quantity. Circuit items also need cable length and environment/exposure for wiring method resolution. Returns created items with calculated costs.",
      inputSchema: {
        estimateId: z.string().describe("The estimate ID"),
        optionId: z.string().describe("The option ID"),
        items: z.array(
          z.object({
            atomicUnitCode: z.string().describe("Atomic unit code (e.g. LINE-002, TRIM-D01, RI-001)"),
            quantity: z.number().positive().describe("Quantity"),
            location: z.string().optional().describe("Location (e.g. 'kitchen', 'master bedroom')"),
            notes: z.string().optional().describe("Item notes"),
            circuitVoltage: z.union([z.literal(120), z.literal(240)]).optional().describe("Circuit voltage (120 or 240)"),
            circuitAmperage: z.number().int().positive().optional().describe("Circuit amperage (15, 20, 30, 40, 50)"),
            environment: z.enum(["interior", "exterior", "underground"]).optional().describe("Wiring environment"),
            exposure: z.enum(["concealed", "exposed"]).optional().describe("Wiring exposure"),
            cableLength: z.number().positive().optional().describe("Cable length in linear feet"),
            needsThreeWire: z.boolean().optional().describe("Whether circuit needs 3-wire (for 240V or multi-wire branch)"),
            modifiers: z
              .array(
                z.object({
                  modifierType: z.enum(["ACCESS", "HEIGHT", "CONDITION"]),
                  modifierValue: z.string(),
                  laborMultiplier: z.number(),
                  materialMult: z.number(),
                })
              )
              .optional()
              .describe("Item-level modifiers (access difficulty, height, condition)"),
          })
        ).describe("Array of items to add"),
      },
    },
    async ({ estimateId, optionId, items }) => {
      // Verify option belongs to estimate
      const option = await prisma.estimateOption.findFirst({
        where: { id: optionId, estimateId },
        include: {
          estimate: {
            include: {
              property: { select: { occupancyType: true } },
            },
          },
        },
      });

      if (!option) {
        return {
          content: [{ type: "text" as const, text: "Estimate option not found" }],
          isError: true,
        };
      }

      const occupancyType =
        (option.estimate.property.occupancyType === "commercial" ? "commercial" : "residential") as
          | "residential"
          | "commercial";

      const created = [];
      const errors = [];

      for (const item of items) {
        try {
          const unit = await prisma.atomicUnit.findFirst({
            where: { code: item.atomicUnitCode, isActive: true },
          });

          if (!unit) {
            errors.push(`Unit '${item.atomicUnitCode}' not found`);
            continue;
          }

          if (unit.requiresCableLength && !item.cableLength) {
            errors.push(`Unit '${item.atomicUnitCode}' requires cableLength`);
            continue;
          }

          // Resolve wiring method for circuit units
          let resolvedCableCode: string | null = null;
          let resolvedWiringMethod: string | null = null;
          let resolvedCableLaborHrs: number | null = null;
          let resolvedCableLaborCost: number | null = null;
          let resolvedCableMaterialCost: number | null = null;
          let breakerMaterialCost = unit.baseMaterialCost;

          if (unit.requiresCableLength && item.cableLength) {
            const cableResult = resolveItemCable({
              occupancyType,
              environment: item.environment ?? null,
              exposure: item.exposure ?? null,
              circuitVoltage: item.circuitVoltage ?? null,
              circuitAmperage: item.circuitAmperage ?? null,
              cableLength: item.cableLength,
              resolverGroupId: unit.resolverGroupId ?? null,
              needsThreeWire: item.needsThreeWire ?? null,
            });

            if (cableResult) {
              resolvedCableCode = cableResult.cableCode;
              resolvedWiringMethod = cableResult.wiringMethod;
              resolvedCableLaborHrs = cableResult.cableLaborHrs;
              resolvedCableLaborCost = cableResult.cableLaborCost;
              resolvedCableMaterialCost = cableResult.cableMaterialCost;
              breakerMaterialCost = cableResult.breakerMaterialCost;
            }
          }

          // Compute modifier multipliers
          const modifiers = item.modifiers ?? [];
          let laborMult = 1.0;
          let materialMult = 1.0;
          for (const mod of modifiers) {
            laborMult *= mod.laborMultiplier;
            materialMult *= mod.materialMult;
          }

          const snapshotLaborHrs = unit.baseLaborHrs;
          const snapshotLaborRate = unit.baseLaborRate;
          const snapshotMaterialCost = breakerMaterialCost;

          const laborCost = parseFloat(
            (snapshotLaborHrs * item.quantity * laborMult * snapshotLaborRate +
              (resolvedCableLaborCost ?? 0)).toFixed(2)
          );
          const materialCost = parseFloat(
            (snapshotMaterialCost * item.quantity * materialMult +
              (resolvedCableMaterialCost ?? 0)).toFixed(2)
          );
          const totalCost = parseFloat((laborCost + materialCost).toFixed(2));

          const createdItem = await prisma.estimateItem.create({
            data: {
              estimateOptionId: optionId,
              atomicUnitId: unit.id,
              location: item.location ?? null,
              quantity: item.quantity,
              sortOrder: 0,
              notes: item.notes ?? null,
              snapshotLaborHrs,
              snapshotLaborRate,
              snapshotMaterialCost,
              circuitVoltage: item.circuitVoltage ?? null,
              circuitAmperage: item.circuitAmperage ?? null,
              environment: item.environment ?? null,
              exposure: item.exposure ?? null,
              cableLength: item.cableLength ?? null,
              needsThreeWire: item.needsThreeWire ?? false,
              resolvedCableCode,
              resolvedWiringMethod,
              resolvedCableLaborHrs,
              resolvedCableLaborCost,
              resolvedCableMaterialCost,
              laborCost,
              materialCost,
              totalCost,
              modifiers: {
                create: modifiers.map((m) => ({
                  modifierType: m.modifierType,
                  modifierValue: m.modifierValue,
                  laborMultiplier: m.laborMultiplier,
                  materialMult: m.materialMult,
                })),
              },
            },
            include: { atomicUnit: true, modifiers: true },
          });

          created.push({
            id: createdItem.id,
            code: createdItem.atomicUnit.code,
            name: createdItem.atomicUnit.name,
            quantity: createdItem.quantity,
            location: createdItem.location,
            laborCost: createdItem.laborCost,
            materialCost: createdItem.materialCost,
            totalCost: createdItem.totalCost,
            resolvedWiringMethod: createdItem.resolvedWiringMethod,
            resolvedCableCode: createdItem.resolvedCableCode,
          });
        } catch (err) {
          errors.push(
            `Error adding '${item.atomicUnitCode}': ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Recalculate option totals
      await service.recalculateOption(optionId);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ created, errors }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "generate_support_items",
    {
      description:
        "Auto-generate support scope items (mobilization, permits, load calc, cleanup, panel labeling) based on the estimate's line items.",
      inputSchema: {
        estimateId: z.string().describe("The estimate ID"),
      },
    },
    async ({ estimateId }) => {
      const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: {
          supportItems: true,
          options: {
            include: {
              items: { include: { atomicUnit: true } },
            },
          },
        },
      });

      if (!estimate) {
        return {
          content: [{ type: "text" as const, text: "Estimate not found" }],
          isError: true,
        };
      }

      const allItems = estimate.options.flatMap((o) => o.items);
      const itemInfos = allItems.map((i) => ({
        code: i.atomicUnit.code,
        category: i.atomicUnit.category,
        name: i.atomicUnit.name,
      }));
      const laborRate = 115;

      const generated = generateSupportItems(itemInfos, laborRate);

      // Delete existing auto-generated support items, keep overridden
      const existingAutoIds = estimate.supportItems
        .filter((s) => !s.isOverridden)
        .map((s) => s.id);
      if (existingAutoIds.length > 0) {
        await prisma.supportItem.deleteMany({
          where: { id: { in: existingAutoIds } },
        });
      }

      // Create new support items
      const createdItems = [];
      for (const g of generated) {
        const laborCost = parseFloat((g.laborHrs * laborRate).toFixed(2));
        const totalCost = parseFloat((laborCost + g.otherCost).toFixed(2));

        const item = await prisma.supportItem.create({
          data: {
            estimateId,
            supportType: g.supportType,
            description: g.description,
            laborHrs: g.laborHrs,
            laborRate,
            laborCost,
            otherCost: g.otherCost,
            totalCost,
            sourceRule: g.sourceRule,
            isOverridden: false,
          },
        });
        createdItems.push(item);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                generated: createdItems.length,
                items: createdItems.map((i) => ({
                  type: i.supportType,
                  description: i.description,
                  totalCost: i.totalCost,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "run_nec_check",
    {
      description:
        "Run NEC 2017 compliance check against estimate items. Returns triggered rules with article references and prompt text.",
      inputSchema: {
        estimateId: z.string().describe("The estimate ID"),
      },
    },
    async ({ estimateId }) => {
      const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: {
          options: {
            include: {
              items: { include: { atomicUnit: true } },
            },
          },
        },
      });

      if (!estimate) {
        return {
          content: [{ type: "text" as const, text: "Estimate not found" }],
          isError: true,
        };
      }

      const allItems = estimate.options.flatMap((o) => o.items);
      const unitCodesPresent = [...new Set(allItems.map((i) => i.atomicUnit.code))];
      const locationsPresent = allItems.map((i) => (i.location ?? "").toLowerCase());

      const allRules = await prisma.nECRule.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
      });

      const prompts: Array<{
        ruleCode: string;
        necArticle: string;
        promptText: string;
        severity: string;
      }> = [];

      for (const rule of allRules) {
        let trigger: { units_present?: string[]; location_contains?: string[] };
        try {
          trigger = JSON.parse(rule.triggerCondition);
        } catch {
          continue;
        }

        let fired = false;
        if (trigger.units_present) {
          fired = trigger.units_present.some((code) => unitCodesPresent.includes(code));
        }
        if (!fired && trigger.location_contains) {
          fired = trigger.location_contains.some((kw) =>
            locationsPresent.some((loc) => loc.includes(kw))
          );
        }

        if (fired) {
          prompts.push({
            ruleCode: rule.ruleCode,
            necArticle: rule.necArticle,
            promptText: rule.promptText,
            severity: rule.severity,
          });
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ estimateId, prompts }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "get_estimate_summary",
    {
      description:
        "Get full estimate details including all options, items, support items, and totals.",
      inputSchema: {
        estimateId: z.string().describe("The estimate ID"),
      },
    },
    async ({ estimateId }) => {
      const estimate = await service.getEstimateById(estimateId);

      if (!estimate) {
        return {
          content: [{ type: "text" as const, text: "Estimate not found" }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(estimate, null, 2),
          },
        ],
      };
    }
  );

  // ─── NEW WRITE TOOLS ──────────────────────────────────────────────────────────

  server.registerTool(
    "delete_estimate_item",
    {
      description:
        "Delete an item from an estimate option. Use when the estimator wants to remove an incorrectly added atomic unit.",
      inputSchema: {
        estimateId: z.string().describe("The estimate ID"),
        optionId: z.string().describe("The option ID the item belongs to"),
        itemId: z.string().describe("The estimate item ID to delete"),
      },
    },
    async ({ estimateId, optionId, itemId }) => {
      try {
        const item = await prisma.estimateItem.findFirst({
          where: { id: itemId, estimateOptionId: optionId },
          include: { estimateOption: { select: { estimateId: true } } },
        });

        if (!item || item.estimateOption.estimateId !== estimateId) {
          return {
            content: [{ type: "text" as const, text: "Item not found on this estimate/option" }],
            isError: true,
          };
        }

        await service.assertUnlockedEstimate(estimateId);
        await prisma.estimateItem.delete({ where: { id: itemId } });
        await service.recalculateOption(optionId);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ deleted: itemId, optionId, estimateId }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "change_estimate_status",
    {
      description:
        "Change the status of an estimate. Valid transitions: draft→review, review→draft, review→sent, sent→declined, sent→expired, sent→revised, declined→revised, expired→revised, revised→draft. Use 'accepted' only via proposal flow.",
      inputSchema: {
        estimateId: z.string().describe("The estimate ID"),
        status: z.enum(["draft", "review", "sent", "declined", "expired", "revised"]).describe("Target status"),
      },
    },
    async ({ estimateId, status }) => {
      try {
        const updated = await service.changeEstimateStatus(estimateId, status);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { estimateId: updated.id, status: updated.status, revision: updated.revision },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "update_estimate_markup",
    {
      description:
        "Set material and/or labor markup percentages for the estimate. Recalculates all option totals.",
      inputSchema: {
        estimateId: z.string().describe("The estimate ID"),
        materialMarkupPct: z.number().min(0).max(200).optional().describe("Material markup percentage (0-200)"),
        laborMarkupPct: z.number().min(0).max(200).optional().describe("Labor markup percentage (0-200)"),
      },
    },
    async ({ estimateId, materialMarkupPct, laborMarkupPct }) => {
      try {
        const updated = await service.updateEstimateMarkup(estimateId, { materialMarkupPct, laborMarkupPct });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  estimateId: updated?.id,
                  materialMarkupPct: updated?.materialMarkupPct,
                  laborMarkupPct: updated?.laborMarkupPct,
                  options: updated?.options.map((o: { id: string; optionLabel: string; totalCost: number }) => ({
                    id: o.id,
                    label: o.optionLabel,
                    totalCost: o.totalCost,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "add_option",
    {
      description:
        "Add a new option (tier) to an estimate. Use for good/better/best pricing or alternative scopes.",
      inputSchema: {
        estimateId: z.string().describe("The estimate ID"),
        optionLabel: z.string().describe("Label for the option (e.g. 'Standard', 'Premium', 'Budget')"),
        description: z.string().optional().describe("Description of this option"),
      },
    },
    async ({ estimateId, optionLabel, description }) => {
      try {
        const option = await service.addOption(estimateId, optionLabel, description);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { optionId: option.id, estimateId, optionLabel: option.optionLabel },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "set_estimate_modifiers",
    {
      description:
        "Set estimate-level modifiers (OCCUPANCY, SCHEDULE). These multiply all labor and/or material costs across the entire estimate. Replaces any existing estimate modifiers.",
      inputSchema: {
        estimateId: z.string().describe("The estimate ID"),
        modifiers: z.array(
          z.object({
            modifierType: z.enum(["OCCUPANCY", "SCHEDULE"]).describe("Modifier type"),
            modifierValue: z.string().describe("Modifier value (e.g. OCCUPIED, AFTER_HOURS, EMERGENCY)"),
            laborMultiplier: z.number().positive().describe("Labor cost multiplier (e.g. 1.15 for occupied, 1.5 for after-hours)"),
            materialMult: z.number().positive().describe("Material cost multiplier (e.g. 1.1 for occupied)"),
          })
        ).describe("Array of estimate-level modifiers to apply"),
      },
    },
    async ({ estimateId, modifiers }) => {
      try {
        const updated = await service.setEstimateModifiers(estimateId, modifiers);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  estimateId,
                  modifiers,
                  options: updated?.options.map((o: { id: string; optionLabel: string; totalCost: number }) => ({
                    id: o.id,
                    label: o.optionLabel,
                    totalCost: o.totalCost,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "generate_proposal_pdf",
    {
      description:
        "Generate a customer-facing proposal PDF for the estimate. Returns the file path and delivery record ID.",
      inputSchema: {
        estimateId: z.string().describe("The estimate ID"),
      },
    },
    async ({ estimateId }) => {
      try {
        const result = await service.generateProposalPdf(estimateId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "delete_estimate",
    {
      description:
        "Delete a draft estimate. Cannot delete accepted/locked estimates.",
      inputSchema: {
        estimateId: z.string().describe("The estimate ID to delete"),
      },
    },
    async ({ estimateId }) => {
      try {
        await service.deleteEstimate(estimateId);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ deleted: estimateId }, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  // ─── VALIDATION TOOL ────────────────────────────────────────────────────────

  server.registerTool(
    "validate_estimate",
    {
      description:
        "Run reasonableness and material cost validation on a completed estimate. " +
        "Call this AFTER get_estimate_summary and BEFORE presenting the estimate to the estimator. " +
        "Returns a validation report with flags for: missing material costs, out-of-range pricing, " +
        "excessive labor hours, double-counted items, and support item imbalances. " +
        "If validation fails (has errors), DO NOT advance the estimate — fix the flagged issues first.",
      inputSchema: {
        estimateId: z.string().describe("The estimate ID to validate"),
      },
    },
    async ({ estimateId }) => {
      const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: {
          supportItems: true,
          options: {
            include: {
              items: { include: { atomicUnit: true } },
            },
          },
        },
      });

      if (!estimate) {
        return {
          content: [{ type: "text" as const, text: "Estimate not found" }],
          isError: true,
        };
      }

      // Validate each option independently
      const results: Record<string, unknown> = {};

      for (const option of estimate.options) {
        const itemsForValidation = option.items.map((item) => ({
          id: item.id,
          atomicUnitCode: item.atomicUnit.code,
          atomicUnitCategory: item.atomicUnit.category,
          atomicUnitName: item.atomicUnit.name,
          quantity: item.quantity,
          snapshotLaborHrs: item.snapshotLaborHrs,
          snapshotLaborRate: item.snapshotLaborRate,
          snapshotMaterialCost: item.snapshotMaterialCost,
          catalogMaterialCost: item.atomicUnit.baseMaterialCost,
          laborCost: item.laborCost,
          materialCost: item.materialCost,
        }));

        const supportForValidation = estimate.supportItems.map((s) => ({
          supportType: s.supportType,
          description: s.description,
          laborHrs: s.laborHrs,
          laborCost: s.laborCost,
          otherCost: s.otherCost,
          totalCost: s.totalCost,
        }));

        const result = validateEstimate({
          items: itemsForValidation,
          supportItems: supportForValidation,
          materialMarkupPct: estimate.materialMarkupPct,
        });

        results[option.optionLabel || option.id] = result;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

// ─── EXPRESS MOUNT ───────────────────────────────────────────────────────────

const transports: Record<string, StreamableHTTPServerTransport> = {};

export async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport;
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          delete transports[sid];
        }
      };

      // Create a fresh McpServer per session to avoid "already connected" errors
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

export async function handleMcpGet(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

export async function handleMcpDelete(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  try {
    await transports[sessionId].handleRequest(req, res);
  } catch (error) {
    console.error("MCP session termination error:", error);
    if (!res.headersSent) {
      res.status(500).send("Error terminating session");
    }
  }
}
