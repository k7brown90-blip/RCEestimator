import express from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { prisma } from "./lib/prisma";
import { ensureAssemblyCatalogReady } from "./bootstrap/ensureAssemblyCatalog";
import { EstimateService } from "./services/estimateService";
import { resolveItemCable } from "./services/wiringMethodResolver";
import { handleMcpPost, handleMcpGet, handleMcpDelete } from "./mcp/server";
import { pinAuthMiddleware, handlePinLogin } from "./middleware/pinAuth";
import { AGENT_INSTRUCTIONS } from "./agentInstructions";

const service = new EstimateService(prisma);
const REMOVED_ASSEMBLY_NUMBERS = [39, 61, 62, 88] as const;

export const app = express();

// ─── SERVE CLIENT STATIC FILES (before auth, so login page loads) ────────────
// At runtime __dirname is dist/src/, so go up two levels to reach app root
const clientDist = path.join(__dirname, "..", "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));

  // SPA fallback: serve index.html for browser navigation requests (not API/file)
  app.use((req, res, next) => {
    const accepts = req.headers.accept || "";
    if (req.method === "GET" && accepts.includes("text/html") && !req.path.startsWith("/api")) {
      res.sendFile(path.join(clientDist, "index.html"));
      return;
    }
    next();
  });
}

app.use(express.json({ limit: "1mb" }));

// Strip /api prefix and mark as API request
app.use((req: express.Request & { _isApi?: boolean }, _res, next) => {
  if (req.path.startsWith("/api/") || req.path === "/api") {
    req._isApi = true;
    req.url = req.url.replace(/^\/api/, "") || "/";
  }
  next();
});

// ─── MCP ENDPOINT ────────────────────────────────────────────────────────────
const mcpBearerToken = process.env.MCP_BEARER_TOKEN;
const mcpAuth: express.RequestHandler = (req, res, next) => {
  if (mcpBearerToken) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${mcpBearerToken}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }
  next();
};
app.post("/mcp", mcpAuth, (req, res) => { handleMcpPost(req, res); });
app.get("/mcp", mcpAuth, (req, res) => { handleMcpGet(req, res); });
app.delete("/mcp", mcpAuth, (req, res) => { handleMcpDelete(req, res); });

const asyncHandler = (fn: express.RequestHandler): express.RequestHandler => {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};

const readParam = (req: express.Request, key: string): string => {
  const raw = req.params[key];
  if (Array.isArray(raw)) {
    return raw[0] ?? "";
  }
  return raw ?? "";
};

const readQuery = (req: express.Request, key: string): string | undefined => {
  const raw = req.query[key];
  if (Array.isArray(raw)) {
    const first = raw[0];
    return typeof first === "string" ? first : undefined;
  }
  return typeof raw === "string" ? raw : undefined;
};

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// ─── PIN AUTH ────────────────────────────────────────────────────────────────
app.post("/auth/pin", asyncHandler(async (req, res) => { await handlePinLogin(req, res); }));
app.use(pinAuthMiddleware);

app.get("/jobs", asyncHandler(async (_req, res) => {
  const visits = await prisma.visit.findMany({
    include: {
      property: true,
      customer: true,
      estimates: {
        orderBy: { createdAt: "desc" },
        include: {
          options: true,
          acceptance: true,
        },
      },
    },
    orderBy: { visitDate: "desc" },
  });

  const jobs = visits.map((visit: typeof visits[number]) => {
    const latestEstimate = visit.estimates[0] ?? null;
    const acceptedOption = latestEstimate?.options.find((o: typeof latestEstimate.options[number]) => o.accepted) ?? null;
    let highestOption: typeof latestEstimate.options[number] | null = null;
    for (const option of latestEstimate?.options ?? []) {
      if (!highestOption || option.totalCost > highestOption.totalCost) {
        highestOption = option;
      }
    }

    return {
      visitId: visit.id,
      visitDate: visit.visitDate,
      mode: visit.mode,
      purpose: visit.purpose,
      property: {
        id: visit.property.id,
        name: visit.property.name,
        addressLine1: visit.property.addressLine1,
        city: visit.property.city,
        state: visit.property.state,
      },
      customer: {
        id: visit.customer.id,
        name: visit.customer.name,
      },
      estimate: latestEstimate
        ? {
          id: latestEstimate.id,
          title: latestEstimate.title,
          status: latestEstimate.status,
          revision: latestEstimate.revision,
          totalCost: acceptedOption?.totalCost ?? highestOption?.totalCost ?? null,
          hasAcceptance: Boolean(latestEstimate.acceptance),
        }
        : null,
    };
  });

  res.json(jobs);
}));

app.get("/customers", asyncHandler(async (_req, res) => {
  const customers = await prisma.customer.findMany({
    include: {
      properties: {
        include: {
          visits: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(customers);
}));

app.get("/customers/:customerId", asyncHandler(async (req, res) => {
  const customerId = readParam(req, "customerId");
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: {
      properties: {
        include: {
          systemSnapshot: true,
          visits: {
            include: {
              estimates: {
                include: { options: true, acceptance: true },
                orderBy: { createdAt: "desc" },
              },
            },
            orderBy: { visitDate: "desc" },
          },
        },
      },
      visits: {
        include: {
          estimates: {
            include: { options: true, acceptance: true },
          },
        },
        orderBy: { visitDate: "desc" },
      },
    },
  });

  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }

  res.json(customer);
}));

app.patch("/customers/:customerId", asyncHandler(async (req, res) => {
  const customerId = readParam(req, "customerId");
  const body = z.object({
    name: z.string().min(1).optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().nullable().optional(),
  }).parse(req.body);
  const existing = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!existing) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const updated = await prisma.customer.update({ where: { id: customerId }, data: body });
  res.json(updated);
}));

app.delete("/customers/:customerId", asyncHandler(async (req, res) => {
  const customerId = readParam(req, "customerId");
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    include: { properties: { include: { visits: true } } },
  });
  if (!customer) {
    res.status(404).json({ error: "Customer not found" });
    return;
  }
  const hasVisits = customer.properties.some((p) => p.visits.length > 0);
  if (hasVisits) {
    res.status(409).json({ error: "Cannot delete a customer with existing job history." });
    return;
  }
  await prisma.customer.delete({ where: { id: customerId } });
  res.status(204).send();
}));

app.get("/properties", asyncHandler(async (_req, res) => {
  const properties = await prisma.property.findMany({
    include: {
      customer: true,
      systemSnapshot: true,
    },
    orderBy: { createdAt: "desc" },
  });

  res.json(properties);
}));

app.get("/properties/:propertyId", asyncHandler(async (req, res) => {
  const propertyId = readParam(req, "propertyId");
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: {
      customer: true,
      systemSnapshot: true,
      visits: {
        include: {
          estimates: {
            include: {
              options: true,
              acceptance: true,
            },
            orderBy: { createdAt: "desc" },
          },
        },
        orderBy: { visitDate: "desc" },
      },
      estimates: {
        include: {
          options: true,
          acceptance: true,
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!property) {
    res.status(404).json({ error: "Property not found" });
    return;
  }

  res.json(property);
}));

app.get("/visits", asyncHandler(async (_req, res) => {
  const visits = await prisma.visit.findMany({
    include: {
      property: true,
      customer: true,
      customerRequest: true,
      estimates: {
        orderBy: { createdAt: "desc" },
      },
    },
    orderBy: { visitDate: "desc" },
  });

  res.json(visits);
}));

app.get("/visits/:visitId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: {
      property: {
        include: {
          systemSnapshot: true,
          customer: true,
        },
      },
      customer: true,
      customerRequest: true,
      observations: { orderBy: { createdAt: "desc" } },
      findings: { orderBy: { createdAt: "desc" } },
      limitations: { orderBy: { createdAt: "desc" } },
      recommendations: { orderBy: { createdAt: "desc" } },
      estimates: {
        include: {
          options: true,
          acceptance: true,
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!visit) {
    res.status(404).json({ error: "Visit not found" });
    return;
  }

  res.json(visit);
}));

app.get("/assemblies", asyncHandler(async (req, res) => {
  const query = readQuery(req, "query");
  const category = readQuery(req, "category");
  const tier = readQuery(req, "tier");

  await ensureAssemblyCatalogReady();

  const templates = await prisma.assemblyTemplate.findMany({
    where: {
      assemblyNumber: { notIn: REMOVED_ASSEMBLY_NUMBERS as unknown as number[] },
      name: query ? { contains: query } : undefined,
      category: category ? { equals: category } : undefined,
      tier: tier ? { equals: tier } : undefined,
    },
    include: {
      components: true,
      parameterDefinitions: {
        orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
      },
      variants: {
        orderBy: [{ variantKey: "asc" }, { variantValue: "asc" }],
      },
      childLinks: {
        include: {
          childTemplate: true,
        },
      },
    },
    orderBy: [{ category: "asc" }, { assemblyNumber: "asc" }],
  });

  res.json(templates);
}));

app.get("/assemblies/:templateId", asyncHandler(async (req, res) => {
  const templateId = readParam(req, "templateId");
  const template = await prisma.assemblyTemplate.findUnique({
    where: { id: templateId },
    include: {
      components: true,
      parameterDefinitions: {
        orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
      },
      variants: {
        orderBy: [{ variantKey: "asc" }, { variantValue: "asc" }],
      },
      childLinks: {
        include: {
          childTemplate: true,
        },
      },
      parentLinks: {
        include: {
          parentTemplate: true,
        },
      },
    },
  });

  if (!template) {
    res.status(404).json({ error: "Assembly template not found" });
    return;
  }

  if ((REMOVED_ASSEMBLY_NUMBERS as unknown as number[]).includes(template.assemblyNumber)) {
    res.status(404).json({ error: "Assembly template not found" });
    return;
  }

  res.json(template);
}));

app.get("/proposals/:deliveryId/download", asyncHandler(async (req, res) => {
  const deliveryId = readParam(req, "deliveryId");
  const delivery = await prisma.proposalDelivery.findUnique({
    where: { id: deliveryId },
  });

  if (!delivery) {
    res.status(404).json({ error: "Proposal delivery not found" });
    return;
  }

  const resolvedPath = path.isAbsolute(delivery.pdfPath)
    ? delivery.pdfPath
    : path.resolve(process.cwd(), delivery.pdfPath);

  if (!fs.existsSync(resolvedPath)) {
    res.status(404).json({ error: "Proposal file not found" });
    return;
  }

  const safeName = path.basename(resolvedPath).replace(/"/g, "");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName || `proposal-${delivery.id}.pdf`}"`);

  const stream = fs.createReadStream(resolvedPath);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read proposal file" });
      return;
    }
    res.end();
  });
  stream.pipe(res);
}));

app.post("/customers", asyncHandler(async (req, res) => {
  const schema = z.object({
    name: z.string().min(1),
    email: z.string().email().optional(),
    phone: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const created = await prisma.customer.create({ data: body });
  res.status(201).json(created);
}));

app.post("/properties", asyncHandler(async (req, res) => {
  const schema = z.object({
    customerId: z.string().min(1),
    name: z.string().min(1),
    addressLine1: z.string().min(1),
    addressLine2: z.string().optional(),
    city: z.string().min(1),
    state: z.string().min(1),
    postalCode: z.string().min(1),
    notes: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const property = await prisma.property.create({ data: body });
  await prisma.systemSnapshot.create({
    data: {
      propertyId: property.id,
      deficienciesJson: JSON.stringify([]),
      changeLogJson: JSON.stringify([]),
    },
  });
  res.status(201).json(property);
}));

app.patch("/properties/:propertyId/snapshot", asyncHandler(async (req, res) => {
  const propertyId = readParam(req, "propertyId");
  const schema = z.object({
    serviceSummary: z.string().optional(),
    panelSummary: z.string().optional(),
    groundingSummary: z.string().optional(),
    wiringMethodSummary: z.string().optional(),
    deficiencies: z.array(z.string()).optional(),
  });
  const body = schema.parse(req.body);

  const updated = await prisma.systemSnapshot.update({
    where: { propertyId },
    data: {
      serviceSummary: body.serviceSummary,
      panelSummary: body.panelSummary,
      groundingSummary: body.groundingSummary,
      wiringMethodSummary: body.wiringMethodSummary,
      deficienciesJson: body.deficiencies ? JSON.stringify(body.deficiencies) : undefined,
    },
  });

  res.json(updated);
}));

app.post("/visits", asyncHandler(async (req, res) => {
  const schema = z.object({
    propertyId: z.string().min(1),
    customerId: z.string().min(1),
    mode: z.enum(["new_construction", "remodel", "service_diagnostic", "maintenance"]),
    purpose: z.string().optional(),
    notes: z.string().optional(),
  });
  const body = schema.parse(req.body);
  const visit = await prisma.visit.create({ data: body });
  res.status(201).json(visit);
}));

app.post("/visits/:visitId/customer-request", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({ requestText: z.string().min(1), urgency: z.string().optional() }).parse(req.body);
  const request = await prisma.customerRequest.upsert({
    where: { visitId },
    update: body,
    create: {
      visitId,
      ...body,
    },
  });
  res.status(201).json(request);
}));

app.patch("/visits/:visitId/customer-request", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({ requestText: z.string().min(1), urgency: z.string().optional() }).parse(req.body);

  const existing = await prisma.customerRequest.findUnique({ where: { visitId } });
  if (!existing) {
    res.status(404).json({ error: "Customer request not found" });
    return;
  }

  const updated = await prisma.customerRequest.update({
    where: { visitId },
    data: body,
  });
  res.json(updated);
}));

app.post("/visits/:visitId/observations", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({ observationText: z.string().min(1), location: z.string().optional() }).parse(req.body);
  const created = await prisma.observation.create({ data: { visitId, ...body } });
  res.status(201).json(created);
}));

app.patch("/visits/:visitId/observations/:observationId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const observationId = readParam(req, "observationId");
  const body = z.object({ observationText: z.string().min(1), location: z.string().optional() }).parse(req.body);

  const updated = await prisma.observation.updateMany({
    where: { id: observationId, visitId },
    data: body,
  });
  if (updated.count === 0) {
    res.status(404).json({ error: "Observation not found" });
    return;
  }

  const item = await prisma.observation.findUnique({ where: { id: observationId } });
  res.json(item);
}));

app.delete("/visits/:visitId/observations/:observationId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const observationId = readParam(req, "observationId");
  const deleted = await prisma.observation.deleteMany({ where: { id: observationId, visitId } });
  if (deleted.count === 0) {
    res.status(404).json({ error: "Observation not found" });
    return;
  }
  res.status(204).send();
}));

app.post("/visits/:visitId/findings", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({ findingText: z.string().min(1), confidence: z.string().optional() }).parse(req.body);
  const created = await prisma.finding.create({ data: { visitId, ...body } });
  res.status(201).json(created);
}));

app.patch("/visits/:visitId/findings/:findingId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const findingId = readParam(req, "findingId");
  const body = z.object({ findingText: z.string().min(1), confidence: z.string().optional() }).parse(req.body);

  const updated = await prisma.finding.updateMany({
    where: { id: findingId, visitId },
    data: body,
  });
  if (updated.count === 0) {
    res.status(404).json({ error: "Finding not found" });
    return;
  }

  const item = await prisma.finding.findUnique({ where: { id: findingId } });
  res.json(item);
}));

app.delete("/visits/:visitId/findings/:findingId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const findingId = readParam(req, "findingId");
  const deleted = await prisma.finding.deleteMany({ where: { id: findingId, visitId } });
  if (deleted.count === 0) {
    res.status(404).json({ error: "Finding not found" });
    return;
  }
  res.status(204).send();
}));

app.post("/visits/:visitId/limitations", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({ limitationText: z.string().min(1) }).parse(req.body);
  const created = await prisma.limitation.create({ data: { visitId, ...body } });
  res.status(201).json(created);
}));

app.patch("/visits/:visitId/limitations/:limitationId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const limitationId = readParam(req, "limitationId");
  const body = z.object({ limitationText: z.string().min(1) }).parse(req.body);

  const updated = await prisma.limitation.updateMany({
    where: { id: limitationId, visitId },
    data: body,
  });
  if (updated.count === 0) {
    res.status(404).json({ error: "Limitation not found" });
    return;
  }

  const item = await prisma.limitation.findUnique({ where: { id: limitationId } });
  res.json(item);
}));

app.delete("/visits/:visitId/limitations/:limitationId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const limitationId = readParam(req, "limitationId");
  const deleted = await prisma.limitation.deleteMany({ where: { id: limitationId, visitId } });
  if (deleted.count === 0) {
    res.status(404).json({ error: "Limitation not found" });
    return;
  }
  res.status(204).send();
}));

app.post("/visits/:visitId/recommendations", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({ recommendationText: z.string().min(1), priority: z.string().optional() }).parse(req.body);
  const created = await prisma.recommendation.create({ data: { visitId, ...body } });
  res.status(201).json(created);
}));

app.patch("/visits/:visitId/recommendations/:recommendationId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const recommendationId = readParam(req, "recommendationId");
  const body = z.object({ recommendationText: z.string().min(1), priority: z.string().optional() }).parse(req.body);

  const updated = await prisma.recommendation.updateMany({
    where: { id: recommendationId, visitId },
    data: body,
  });
  if (updated.count === 0) {
    res.status(404).json({ error: "Recommendation not found" });
    return;
  }

  const item = await prisma.recommendation.findUnique({ where: { id: recommendationId } });
  res.json(item);
}));

app.delete("/visits/:visitId/recommendations/:recommendationId", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const recommendationId = readParam(req, "recommendationId");
  const deleted = await prisma.recommendation.deleteMany({ where: { id: recommendationId, visitId } });
  if (deleted.count === 0) {
    res.status(404).json({ error: "Recommendation not found" });
    return;
  }
  res.status(204).send();
}));

app.post("/estimates", asyncHandler(async (req, res) => {
  const body = z.object({ visitId: z.string(), propertyId: z.string(), title: z.string(), notes: z.string().optional() }).parse(req.body);
  const estimate = await service.createEstimate(body);
  res.status(201).json(estimate);
}));

app.delete("/estimates/:estimateId", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  await service.deleteEstimate(estimateId);
  res.status(204).send();
}));

app.post("/estimates/:estimateId/options", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({ optionLabel: z.string(), description: z.string().optional() }).parse(req.body);
  const option = await service.addOption(estimateId, body.optionLabel, body.description);
  res.status(201).json(option);
}));

app.patch("/options/:optionId", asyncHandler(async (req, res) => {
  const optionId = readParam(req, "optionId");
  const body = z.object({
    optionLabel: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
  }).parse(req.body);

  const updated = await service.updateOption({
    optionId,
    optionLabel: body.optionLabel,
    description: body.description,
  });
  res.json(updated);
}));

app.delete("/options/:optionId", asyncHandler(async (req, res) => {
  const optionId = readParam(req, "optionId");
  await service.deleteOption(optionId);
  res.status(204).send();
}));

app.post("/options/:optionId/assemblies", asyncHandler(async (req, res) => {
  const optionId = readParam(req, "optionId");
  const body = z.object({
    assemblyTemplateId: z.string(),
    location: z.string().optional(),
    quantity: z.number().int().min(1).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    assemblyNotes: z.string().optional(),
    modifiers: z.array(z.string()).optional(),
    manualLaborOverride: z.number().nonnegative().optional(),
    manualMaterialOverride: z.number().nonnegative().optional(),
  }).parse(req.body);

  const created = await service.addAssemblyToOption({
    optionId,
    ...body,
  });

  res.status(201).json(created);
}));

app.get("/options/:optionId/assembly-suggestions", asyncHandler(async (req, res) => {
  const optionId = readParam(req, "optionId");
  const assemblyTemplateId = readQuery(req, "assemblyTemplateId");
  const assemblyNumberRaw = readQuery(req, "assemblyNumber");

  let assemblyNumber: number | undefined;
  if (assemblyNumberRaw !== undefined) {
    const parsed = Number(assemblyNumberRaw);
    if (Number.isNaN(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      res.status(400).json({ error: "assemblyNumber must be a positive integer" });
      return;
    }
    assemblyNumber = parsed;
  }

  if (!assemblyTemplateId && assemblyNumber === undefined) {
    res.status(400).json({ error: "assemblyTemplateId or assemblyNumber query parameter is required" });
    return;
  }

  const suggestions = await service.getAssemblyCompanionSuggestions({
    optionId,
    assemblyTemplateId: assemblyTemplateId || undefined,
    assemblyNumber,
  });

  res.json({ suggestions });
}));

app.patch("/assemblies/:assemblyId", asyncHandler(async (req, res) => {
  const assemblyId = readParam(req, "assemblyId");
  const body = z.object({
    location: z.string().optional().nullable(),
    quantity: z.number().int().min(1).optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }).parse(req.body);

  const updated = await service.updateAssembly({
    assemblyId,
    location: body.location,
    quantity: body.quantity,
    parameters: body.parameters,
  });

  res.json(updated);
}));

app.delete("/assemblies/:assemblyId", asyncHandler(async (req, res) => {
  const assemblyId = readParam(req, "assemblyId");
  await service.deleteAssembly(assemblyId);
  res.status(204).send();
}));

app.get("/options/:optionId/materials", asyncHandler(async (req, res) => {
  const optionId = readParam(req, "optionId");
  const result = await service.getMaterialList(optionId);
  res.json(result);
}));

app.patch("/estimates/:estimateId/markup", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({
    materialMarkupPct: z.number().min(0).max(200).optional(),
    laborMarkupPct: z.number().min(0).max(200).optional(),
  }).parse(req.body);
  const updated = await service.updateEstimateMarkup(estimateId, body);
  res.json(updated);
}));

app.post("/estimates/:estimateId/status", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({ status: z.enum(["draft", "review", "sent", "accepted", "declined", "expired", "revised"]) }).parse(req.body);
  const estimate = await service.changeEstimateStatus(estimateId, body.status);
  res.json(estimate);
}));

app.put("/estimates/:estimateId/permit-status", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({
    required: z.boolean(),
    permitType: z.string().optional(),
    status: z.enum(["not_required", "not_filed", "filed", "issued", "expired"]),
    permitNumber: z.string().optional(),
    cost: z.number().nonnegative().optional(),
  }).parse(req.body);
  const updated = await service.upsertPermitStatus(estimateId, body);
  res.json(updated);
}));

app.put("/estimates/:estimateId/inspection-status", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({
    inspectionType: z.enum(["rough_in", "underground", "final", "re_inspection", "service_release", "temporary_power"]),
    status: z.enum(["not_scheduled", "scheduled", "passed", "failed", "corrections_required"]),
    notes: z.string().optional(),
    corrections: z.array(z.string()).optional(),
  }).parse(req.body);
  const updated = await service.upsertInspectionStatus(estimateId, body);
  res.json(updated);
}));

app.post("/estimates/:estimateId/proposals", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const generated = await service.generateProposalPdf(estimateId);
  res.status(201).json(generated);
}));

app.post("/estimates/:estimateId/signatures", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({
    signerName: z.string(),
    signerEmail: z.string().email().optional(),
    signatureData: z.string().min(1),
    consentText: z.string().min(1),
    ipAddress: z.string().optional(),
    userAgent: z.string().optional(),
  }).parse(req.body);

  const signature = await service.recordSignature({
    estimateId,
    ...body,
  });

  res.status(201).json(signature);
}));

app.post("/estimates/:estimateId/acceptance", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({
    optionId: z.string(),
    signatureId: z.string().optional(),
    notes: z.string().optional(),
    status: z.enum(["accepted", "declined"]).optional(),
  }).parse(req.body);

  const result = await service.acceptProposal({
    estimateId,
    ...body,
  });

  res.status(201).json(result);
}));

app.post("/estimates/:estimateId/change-orders", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const body = z.object({
    parentOptionId: z.string().min(1),
    title: z.string(),
    reason: z.string().optional(),
    reasonType: z.enum([
      "customer_request",
      "hidden_condition",
      "utility_requirement",
      "ahj_requirement",
      "damage_discovered",
      "scope_revision",
    ]).optional(),
    assembliesAdded: z.array(z.unknown()).optional(),
    assembliesRemoved: z.array(z.unknown()).optional(),
    assembliesModified: z.array(z.unknown()).optional(),
    deltaLabor: z.number().optional(),
    deltaMaterial: z.number().optional(),
    deltaOther: z.number().optional(),
  }).parse(req.body);

  const changeOrder = await service.createChangeOrder({
    estimateId,
    ...body,
  });

  res.status(201).json(changeOrder);
}));

app.get("/estimates/:estimateId", asyncHandler(async (req, res) => {
  const estimateId = readParam(req, "estimateId");
  const estimate = await service.getEstimateById(estimateId);
  if (!estimate) {
    res.status(404).json({ error: "Estimate not found" });
    return;
  }
  res.json(estimate);
}));

// ─── ATOMIC MODEL ROUTES (Phase M2) ─────────────────────────────────────────

// GET /atomic-units — list units, optionally filter by category and/or tier
app.get("/atomic-units", asyncHandler(async (req, res) => {
  const category = readQuery(req, "category");
  const tierStr = readQuery(req, "tier");
  const tier = tierStr ? parseInt(tierStr, 10) : undefined;

  const where: Record<string, unknown> = { isActive: true };
  if (category) where["category"] = category;
  if (tier !== undefined && !isNaN(tier)) where["visibilityTier"] = tier;

  const units = await prisma.atomicUnit.findMany({
    where,
    orderBy: [{ category: "asc" }, { sortOrder: "asc" }],
  });

  res.json(units);
}));

// GET /atomic-units/:code — single unit detail
app.get("/atomic-units/:code", asyncHandler(async (req, res) => {
  const code = readParam(req, "code");
  const unit = await prisma.atomicUnit.findUnique({ where: { code } });
  if (!unit) {
    res.status(404).json({ error: "Atomic unit not found" });
    return;
  }
  res.json(unit);
}));

// GET /modifiers — all modifier definitions, optionally filter by appliesTo
app.get("/modifiers", asyncHandler(async (req, res) => {
  const appliesTo = readQuery(req, "appliesTo");
  const where: Record<string, unknown> = {};
  if (appliesTo) where["appliesTo"] = appliesTo;

  const mods = await prisma.modifierDef.findMany({
    where,
    orderBy: [{ modifierType: "asc" }, { sortOrder: "asc" }],
  });
  res.json(mods);
}));

// GET /presets — all active presets
app.get("/presets", asyncHandler(async (_req, res) => {
  const presets = await prisma.preset.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  res.json(presets);
}));

// GET /job-types — all active job types
app.get("/job-types", asyncHandler(async (_req, res) => {
  const jobTypes = await prisma.jobType.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  res.json(jobTypes);
}));

// GET /nec-rules — all active NEC rules
app.get("/nec-rules", asyncHandler(async (_req, res) => {
  const rules = await prisma.nECRule.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  res.json(rules);
}));

// ─── ESTIMATE ITEMS (atomic) ─────────────────────────────────────────────────

const itemModifierSchema = z.object({
  modifierType: z.enum(["ACCESS", "HEIGHT", "CONDITION"]),
  modifierValue: z.string().min(1),
  laborMultiplier: z.number().min(0.1).max(5),
  materialMult: z.number().min(0.1).max(5),
});

const createItemSchema = z.object({
  atomicUnitCode: z.string().min(1),
  quantity: z.number().positive(),
  location: z.string().optional(),
  notes: z.string().optional(),
  sortOrder: z.number().int().optional(),
  // Circuit-specific
  circuitVoltage: z.union([z.literal(120), z.literal(240)]).optional(),
  circuitAmperage: z.number().int().positive().optional(),
  environment: z.enum(["interior", "exterior", "underground"]).optional(),
  exposure: z.enum(["concealed", "exposed"]).optional(),
  cableLength: z.number().positive().optional(),
  needsThreeWire: z.boolean().optional(),
  // Modifiers (0–3 per item)
  modifiers: z.array(itemModifierSchema).max(3).optional(),
});

// POST /estimates/:estimateId/options/:optionId/items — create an EstimateItem
app.post(
  "/estimates/:estimateId/options/:optionId/items",
  asyncHandler(async (req, res) => {
    const optionId = readParam(req, "optionId");
    const estimateId = readParam(req, "estimateId");

    const body = createItemSchema.parse(req.body);

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
      res.status(404).json({ error: "Estimate option not found" });
      return;
    }

    // Fetch atomic unit
    const unit = await prisma.atomicUnit.findUnique({
      where: { code: body.atomicUnitCode },
    });
    if (!unit) {
      res.status(404).json({ error: `Atomic unit '${body.atomicUnitCode}' not found` });
      return;
    }

    // Validate cable length required for circuit units
    if (unit.requiresCableLength && !body.cableLength) {
      res.status(400).json({
        error: "Cable length is required for circuit/feeder units",
        field: "cableLength",
      });
      return;
    }

    // Resolve wiring method for circuit units
    const occupancyType =
      (option.estimate.property.occupancyType === "commercial" ? "commercial" : "residential") as
        | "residential"
        | "commercial";

    let resolvedCableCode: string | null = null;
    let resolvedWiringMethod: string | null = null;
    let resolvedCableLaborHrs: number | null = null;
    let resolvedCableLaborCost: number | null = null;
    let resolvedCableMaterialCost: number | null = null;
    let breakerMaterialCost = unit.baseMaterialCost; // default; overridden for circuits

    if (unit.requiresCableLength && body.cableLength) {
      const cableResult = resolveItemCable({
        occupancyType,
        environment: body.environment ?? null,
        exposure: body.exposure ?? null,
        circuitVoltage: body.circuitVoltage ?? null,
        circuitAmperage: body.circuitAmperage ?? null,
        cableLength: body.cableLength,
        resolverGroupId: unit.resolverGroupId ?? null,
        needsThreeWire: body.needsThreeWire ?? null,
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
    const modifiers = body.modifiers ?? [];
    let laborMult = 1.0;
    let materialMult = 1.0;
    for (const mod of modifiers) {
      laborMult *= mod.laborMultiplier;
      materialMult *= mod.materialMult;
    }

    // Compute costs (snapshot from catalog)
    const snapshotLaborHrs = unit.baseLaborHrs;
    const snapshotLaborRate = unit.baseLaborRate;
    const snapshotMaterialCost = breakerMaterialCost;

    const laborCost = parseFloat(
      (snapshotLaborHrs * body.quantity * laborMult * snapshotLaborRate +
        (resolvedCableLaborCost ?? 0)).toFixed(2)
    );
    const materialCost = parseFloat(
      (snapshotMaterialCost * body.quantity * materialMult +
        (resolvedCableMaterialCost ?? 0)).toFixed(2)
    );
    const totalCost = parseFloat((laborCost + materialCost).toFixed(2));

    // Insert EstimateItem + ItemModifiers
    const item = await prisma.estimateItem.create({
      data: {
        estimateOptionId: optionId,
        atomicUnitId: unit.id,
        location: body.location ?? null,
        quantity: body.quantity,
        sortOrder: body.sortOrder ?? 0,
        notes: body.notes ?? null,
        snapshotLaborHrs,
        snapshotLaborRate,
        snapshotMaterialCost,
        circuitVoltage: body.circuitVoltage ?? null,
        circuitAmperage: body.circuitAmperage ?? null,
        environment: body.environment ?? null,
        exposure: body.exposure ?? null,
        cableLength: body.cableLength ?? null,
        needsThreeWire: body.needsThreeWire ?? null,
        resolvedWiringMethod,
        resolvedCableCode,
        resolvedCableLaborHrs,
        resolvedCableLaborCost,
        resolvedCableMaterialCost,
        laborCost,
        materialCost,
        totalCost,
        modifiers: modifiers.length
          ? {
              create: modifiers.map((m) => ({
                modifierType: m.modifierType,
                modifierValue: m.modifierValue,
                laborMultiplier: m.laborMultiplier,
                materialMult: m.materialMult,
              })),
            }
          : undefined,
      },
      include: { atomicUnit: true, modifiers: true },
    });

    // Recalculate option totals after adding item
    await service.recalculateOption(optionId);

    // Suggest endpoint if unit requires it
    const suggestEndpoint = unit.requiresEndpoint;

    res.status(201).json({
      item,
      suggestEndpoint,
      resolvedWiringMethod: resolvedWiringMethod
        ? { method: resolvedWiringMethod, code: resolvedCableCode }
        : null,
    });
  })
);

// GET /estimates/:estimateId/options/:optionId/items — list items for an option
app.get(
  "/estimates/:estimateId/options/:optionId/items",
  asyncHandler(async (req, res) => {
    const optionId = readParam(req, "optionId");
    const estimateId = readParam(req, "estimateId");

    const option = await prisma.estimateOption.findFirst({
      where: { id: optionId, estimateId },
    });
    if (!option) {
      res.status(404).json({ error: "Estimate option not found" });
      return;
    }

    const items = await prisma.estimateItem.findMany({
      where: { estimateOptionId: optionId },
      include: { atomicUnit: true, modifiers: true },
      orderBy: { sortOrder: "asc" },
    });

    res.json(items);
  })
);

// DELETE /estimates/:estimateId/options/:optionId/items/:itemId
app.delete(
  "/estimates/:estimateId/options/:optionId/items/:itemId",
  asyncHandler(async (req, res) => {
    const itemId = readParam(req, "itemId");
    const optionId = readParam(req, "optionId");

    const item = await prisma.estimateItem.findFirst({
      where: { id: itemId, estimateOptionId: optionId },
    });
    if (!item) {
      res.status(404).json({ error: "Item not found" });
      return;
    }

    await prisma.estimateItem.delete({ where: { id: itemId } });
    await service.recalculateOption(optionId);
    res.status(204).send();
  })
);

// POST /estimates/:estimateId/nec-check — run NEC validation against estimate items
app.post(
  "/estimates/:estimateId/nec-check",
  asyncHandler(async (req, res) => {
    const estimateId = readParam(req, "estimateId");

    const estimate = await prisma.estimate.findUnique({
      where: { id: estimateId },
      include: {
        options: {
          include: {
            items: {
              include: { atomicUnit: true },
            },
          },
        },
      },
    });
    if (!estimate) {
      res.status(404).json({ error: "Estimate not found" });
      return;
    }

    // Collect all unit codes and locations across all options/items
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

    res.json({ estimateId, prompts });
  })
);

// POST /estimates/:estimateId/support-items — auto-generate support scope
app.post(
  "/estimates/:estimateId/support-items/generate",
  asyncHandler(async (req, res) => {
    const estimateId = readParam(req, "estimateId");

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
      res.status(404).json({ error: "Estimate not found" });
      return;
    }

    const allItems = estimate.options.flatMap((o) => o.items);
    const unitCodes = allItems.map((i) => i.atomicUnit.code);
    const newCircuitCount = unitCodes.filter((c) => c === "CIR-001" || c === "CIR-002").length;

    const laborRate = 115;
    const generated: Array<{
      supportType: string;
      description: string;
      laborHrs: number;
      otherCost: number;
      sourceRule: string;
    }> = [];

    // Mobilization — always
    generated.push({
      supportType: "MOBILIZATION",
      description: "Mobilization / Travel",
      laborHrs: 0,
      otherCost: 35,
      sourceRule: "ALWAYS",
    });

    // Permit — any new circuits, panel, or service work
    const triggerPermit = unitCodes.some((c) =>
      ["CIR-001", "CIR-002", "PNL-001", "PNL-002", "PNL-003", "SVC-001", "SVC-002"].includes(c)
    );
    if (triggerPermit) {
      generated.push({
        supportType: "PERMIT",
        description: "Permit Allowance",
        laborHrs: 0,
        otherCost: 350,
        sourceRule: "NEW_CIRCUIT_OR_SERVICE",
      });
    }

    // Load calculation — panel replacement or service upgrade
    const triggerLoadCalc = unitCodes.some((c) =>
      ["PNL-001", "PNL-002", "SVC-001", "SVC-002", "SVC-005"].includes(c)
    );
    if (triggerLoadCalc) {
      const loadCalcHrs = 1.5;
      generated.push({
        supportType: "LOAD_CALC",
        description: "Load Calculation Review",
        laborHrs: loadCalcHrs,
        otherCost: 0,
        sourceRule: "PANEL_OR_SERVICE",
      });
    }

    // Utility coordination — service entrance or meter work
    const triggerUtility = unitCodes.some((c) =>
      ["SVC-001", "SVC-002", "SVC-003"].includes(c)
    );
    if (triggerUtility) {
      generated.push({
        supportType: "UTILITY_COORD",
        description: "Utility Coordination",
        laborHrs: 2.0,
        otherCost: 0,
        sourceRule: "SERVICE_ENTRANCE",
      });
    }

    // Circuit testing — 0.25 hr per new circuit, min 0
    if (newCircuitCount > 0) {
      generated.push({
        supportType: "CIRCUIT_TESTING",
        description: `Circuit Testing / Checkout (${newCircuitCount} circuit${newCircuitCount > 1 ? "s" : ""})`,
        laborHrs: parseFloat((0.25 * newCircuitCount).toFixed(2)),
        otherCost: 0,
        sourceRule: "NEW_CIRCUITS",
      });
    }

    // Cleanup — 0.5 hr flat + 0.1 hr per item over 5
    const itemCount = allItems.length;
    const cleanupHrs = parseFloat((0.5 + Math.max(0, (itemCount - 5) * 0.1)).toFixed(2));
    generated.push({
      supportType: "CLEANUP",
      description: `Cleanup / Debris Removal (${itemCount} line item${itemCount !== 1 ? "s" : ""})`,
      laborHrs: cleanupHrs,
      otherCost: 0,
      sourceRule: "ALWAYS",
    });

    // Panel demo — PNL-001 or PNL-002
    const triggerPanelDemo = unitCodes.some((c) => ["PNL-001", "PNL-002"].includes(c));
    if (triggerPanelDemo) {
      generated.push({
        supportType: "PANEL_DEMO",
        description: "Panel Demo / Removal Prep",
        laborHrs: 5.0,
        otherCost: 0,
        sourceRule: "PANEL_REPLACE",
      });
    }

    // Delete non-overridden auto items and replace
    await prisma.supportItem.deleteMany({
      where: { estimateId, isOverridden: false },
    });

    const created = await Promise.all(
      generated.map((g) =>
        prisma.supportItem.create({
          data: {
            estimateId,
            supportType: g.supportType,
            description: g.description,
            laborHrs: g.laborHrs,
            laborRate,
            laborCost: parseFloat((g.laborHrs * laborRate).toFixed(2)),
            otherCost: g.otherCost,
            totalCost: parseFloat((g.laborHrs * laborRate + g.otherCost).toFixed(2)),
            sourceRule: g.sourceRule,
            isOverridden: false,
          },
        })
      )
    );

    res.json({ generated: created.length, supportItems: created });
  })
);

// GET /estimates/:estimateId/support-items — list support items
app.get(
  "/estimates/:estimateId/support-items",
  asyncHandler(async (req, res) => {
    const estimateId = readParam(req, "estimateId");
    const items = await prisma.supportItem.findMany({
      where: { estimateId },
      orderBy: { sortOrder: "asc" },
    });
    res.json(items);
  })
);

// PATCH /estimates/:estimateId/support-items/:itemId — override a support item
app.patch(
  "/estimates/:estimateId/support-items/:itemId",
  asyncHandler(async (req, res) => {
    const itemId = readParam(req, "itemId");
    const body = z
      .object({
        laborHrs: z.number().min(0).optional(),
        otherCost: z.number().min(0).optional(),
        description: z.string().optional(),
        isOverridden: z.boolean().optional(),
        overrideNote: z.string().optional(),
      })
      .parse(req.body);

    const existing = await prisma.supportItem.findUnique({ where: { id: itemId } });
    if (!existing) {
      res.status(404).json({ error: "Support item not found" });
      return;
    }

    const laborHrs = body.laborHrs ?? existing.laborHrs;
    const otherCost = body.otherCost ?? existing.otherCost;
    const updated = await prisma.supportItem.update({
      where: { id: itemId },
      data: {
        ...body,
        laborHrs,
        laborCost: parseFloat((laborHrs * existing.laborRate).toFixed(2)),
        totalCost: parseFloat((laborHrs * existing.laborRate + otherCost).toFixed(2)),
        isOverridden: body.isOverridden ?? true,
      },
    });

    res.json(updated);
  })
);

// DELETE /estimates/:estimateId/support-items/:itemId
app.delete(
  "/estimates/:estimateId/support-items/:itemId",
  asyncHandler(async (req, res) => {
    const itemId = readParam(req, "itemId");
    const existing = await prisma.supportItem.findUnique({ where: { id: itemId } });
    if (!existing) {
      res.status(404).json({ error: "Support item not found" });
      return;
    }
    await prisma.supportItem.delete({ where: { id: itemId } });
    res.status(204).send();
  })
);

// ─── CHATKIT SESSION ENDPOINT ────────────────────────────────────────────────
app.post("/chatkit/session", asyncHandler(async (_req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    res.status(500).json({ error: "Agent not configured: OPENAI_API_KEY missing" });
    return;
  }

  const sessionId = `ses_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  res.json({
    sessionId,
    agentId: "gpt-4.1",
  });
}));

// In-memory map of session -> last response ID for multi-turn conversation
const sessionResponseIds: Record<string, string> = {};

// ─── CHATKIT MESSAGE ENDPOINT ────────────────────────────────────────────────
app.post("/chatkit/message", asyncHandler(async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    res.status(500).json({ error: "Agent not configured: OPENAI_API_KEY missing" });
    return;
  }

  const { sessionId, message } = req.body as { sessionId: string; message: string; visitId?: string };
  if (!sessionId || !message) {
    res.status(400).json({ error: "sessionId and message required" });
    return;
  }

  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI({ apiKey, timeout: 120_000 });

  const previousResponseId = sessionResponseIds[sessionId] ?? undefined;

  // Build MCP tool config if the app's own MCP endpoint is available
  const mcpToken = process.env.MCP_BEARER_TOKEN;
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : "http://localhost:3000";
  const tools: Array<Record<string, unknown>> = [];
  if (mcpToken) {
    tools.push({
      type: "mcp",
      server_label: "rce_estimator",
      server_url: `${baseUrl}/mcp`,
      headers: { Authorization: `Bearer ${mcpToken}` },
      require_approval: "never",
    });
  }

  // Add NEC 2017 file search if vector store is configured
  const vectorStoreId = process.env.NEC_VECTOR_STORE_ID;
  if (vectorStoreId) {
    tools.push({
      type: "file_search",
      vector_store_ids: [vectorStoreId],
    });
  }

  try {
    const response = await openai.responses.create({
      model: "gpt-4.1",
      instructions: AGENT_INSTRUCTIONS,
      input: message,
      tools: tools.length > 0 ? tools : undefined,
      stream: false,
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    } as Parameters<typeof openai.responses.create>[0]);

    // Cast to non-streaming response type
    const resp = response as { id: string; output: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> };

    // Store response ID for conversation continuity
    sessionResponseIds[sessionId] = resp.id;

    // Extract text from response output
    const reply = resp.output
      ?.filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text ?? "")
      .join("\n") ?? "No response";

    res.json({ reply });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("OpenAI Responses API error:", errMsg);
    res.status(502).json({ error: `AI agent error: ${errMsg}` });
  }
}));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const includeDetails = process.env.NODE_ENV !== "production";

  if (err instanceof z.ZodError) {
    res.status(400).json({
      error: "Validation failed",
      details: includeDetails ? err.flatten() : undefined,
    });
    return;
  }

  if (
    typeof err === "object"
    && err !== null
    && "statusCode" in err
    && typeof (err as { statusCode?: unknown }).statusCode === "number"
  ) {
    const statusCode = (err as { statusCode: number }).statusCode;
    const message = err instanceof Error ? err.message : "Request failed";
    res.status(statusCode).json({ error: message });
    return;
  }

  const message = err instanceof Error ? err.message : "Unknown error";
  console.error("Unhandled error", err);
  res.status(500).json({
    error: "Internal server error",
    details: includeDetails ? message : undefined,
  });
});
