import express from "express";
import { z, ZodError } from "zod";
import { prisma } from "../lib/prisma";

// ─── HELPERS ────────────────────────────────────────────────────────────────────

const asyncHandler = (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const readParam = (req: express.Request, key: string): string => {
  const raw = req.params[key];
  return Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
};

// ─── FULL VISIT INCLUDE (matches app.ts GET /visits/:visitId) ───────────────

const FULL_VISIT_INCLUDE = {
  property: { include: { systemSnapshot: true, customer: true } },
  customer: true,
  customerRequest: true,
  observations: { orderBy: { createdAt: "desc" as const } },
  findings: { orderBy: { createdAt: "desc" as const } },
  limitations: { orderBy: { createdAt: "desc" as const } },
  recommendations: { orderBy: { createdAt: "desc" as const } },
  estimates: {
    include: { options: true, acceptance: true },
    orderBy: { createdAt: "desc" as const },
  },
} as const;

// ─── AUDIT LOG ──────────────────────────────────────────────────────────────────

function logAgent(action: string, details: {
  visitId?: string;
  entityType?: string;
  entityId?: string;
  payload?: unknown;
}): void {
  prisma.agentAuditLog.create({
    data: {
      action,
      visitId: details.visitId,
      entityType: details.entityType,
      entityId: details.entityId,
      payloadJson: details.payload ? JSON.stringify(details.payload) : null,
    },
  }).catch((err) => console.error("[AgentAudit] log failed:", err));
}

// ─── ACTIVE VISIT STATE ─────────────────────────────────────────────────────────

let activeVisit: { visitId: string; setAt: number } | null = null;
const ACTIVE_VISIT_TTL_MS = 24 * 60 * 60 * 1000;

function getActiveVisitId(): string | null {
  if (!activeVisit) return null;
  if (Date.now() - activeVisit.setAt > ACTIVE_VISIT_TTL_MS) {
    activeVisit = null;
    return null;
  }
  return activeVisit.visitId;
}

// ─── ROUTER ─────────────────────────────────────────────────────────────────────

export const agentRouter = express.Router();

// Bearer token auth
const agentAuth: express.RequestHandler = (req, res, next) => {
  const AGENT_API_TOKEN = process.env.AGENT_API_TOKEN;
  if (!AGENT_API_TOKEN) {
    res.status(503).json({ error: "Agent API not configured" });
    return;
  }
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${AGENT_API_TOKEN}`) {
    res.status(401).json({ error: "Invalid or missing agent token" });
    return;
  }
  next();
};

agentRouter.use(agentAuth);

// Resolve :id = "active" to actual visitId
agentRouter.param("id", (_req, res, next, val) => {
  if (val === "active") {
    const visitId = getActiveVisitId();
    if (!visitId) {
      res.status(404).json({ error: "No active visit" });
      return;
    }
    _req.params.id = visitId;
  }
  next();
});

// Zod error handler
agentRouter.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof ZodError) {
    res.status(422).json({ error: "Validation failed", issues: err.issues });
    return;
  }
  next(err);
});

// ─── ACTIVE VISIT ENDPOINTS ─────────────────────────────────────────────────────

agentRouter.get("/active-visit", asyncHandler(async (_req, res) => {
  const visitId = getActiveVisitId();
  if (!visitId) {
    res.status(404).json({ error: "No active visit" });
    return;
  }
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: FULL_VISIT_INCLUDE,
  });
  if (!visit) {
    activeVisit = null;
    res.status(404).json({ error: "Active visit no longer exists" });
    return;
  }
  res.json(visit);
}));

agentRouter.post("/active-visit", asyncHandler(async (req, res) => {
  const body = z.union([
    z.object({ visitId: z.string().min(1) }),
    z.object({ address: z.string().min(3) }),
  ]).parse(req.body);

  let visitId: string;

  if ("visitId" in body) {
    const exists = await prisma.visit.findUnique({ where: { id: body.visitId }, select: { id: true } });
    if (!exists) {
      res.status(404).json({ error: "Visit not found" });
      return;
    }
    visitId = body.visitId;
  } else {
    // Fuzzy match by address
    const searchTerm = body.address.toLowerCase();
    const properties = await prisma.property.findMany({
      where: { addressLine1: { contains: searchTerm } },
      select: { id: true, addressLine1: true },
    });

    if (properties.length === 0) {
      res.status(404).json({ error: "No property found matching that address" });
      return;
    }

    // Find most recent visit for matched property
    const latestVisit = await prisma.visit.findFirst({
      where: { propertyId: { in: properties.map((p) => p.id) } },
      orderBy: { visitDate: "desc" },
      select: { id: true },
    });

    if (!latestVisit) {
      res.status(404).json({ error: "No visits found for matched property" });
      return;
    }
    visitId = latestVisit.id;
  }

  activeVisit = { visitId, setAt: Date.now() };
  logAgent("set_active_visit", { visitId });

  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: FULL_VISIT_INCLUDE,
  });
  res.json(visit);
}));

// ─── VISIT READ ─────────────────────────────────────────────────────────────────

agentRouter.get("/visits/:id", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const visit = await prisma.visit.findUnique({
    where: { id },
    include: FULL_VISIT_INCLUDE,
  });
  if (!visit) {
    res.status(404).json({ error: "Visit not found" });
    return;
  }
  res.json(visit);
}));

// ─── CUSTOMER REQUEST ───────────────────────────────────────────────────────────

agentRouter.patch("/visits/:id/customer-request", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "id");
  const body = z.object({
    requestText: z.string().min(1),
    urgency: z.string().optional(),
  }).parse(req.body);

  const result = await prisma.customerRequest.upsert({
    where: { visitId },
    update: body,
    create: { visitId, ...body },
  });

  logAgent("upsert_customer_request", { visitId, entityType: "CustomerRequest", entityId: result.id, payload: body });
  res.json(result);
}));

// ─── OBSERVATIONS ───────────────────────────────────────────────────────────────

agentRouter.post("/visits/:id/observations", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "id");
  const body = z.object({
    observationText: z.string().min(1),
    location: z.string().optional(),
  }).parse(req.body);

  const created = await prisma.observation.create({ data: { visitId, ...body } });
  logAgent("create_observation", { visitId, entityType: "Observation", entityId: created.id, payload: body });
  res.status(201).json(created);
}));

// ─── SYSTEM SNAPSHOT ────────────────────────────────────────────────────────────

agentRouter.patch("/visits/:id/system-snapshot", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "id");
  const body = z.object({
    serviceSummary: z.string().optional(),
    panelSummary: z.string().optional(),
    groundingSummary: z.string().optional(),
    wiringMethodSummary: z.string().optional(),
  }).parse(req.body);

  // Look up propertyId through the visit
  const visit = await prisma.visit.findUnique({ where: { id: visitId }, select: { propertyId: true } });
  if (!visit) {
    res.status(404).json({ error: "Visit not found" });
    return;
  }

  // Upsert the snapshot
  const result = await prisma.systemSnapshot.upsert({
    where: { propertyId: visit.propertyId },
    update: body,
    create: {
      propertyId: visit.propertyId,
      ...body,
      deficienciesJson: JSON.stringify([]),
      changeLogJson: JSON.stringify([]),
    },
  });

  logAgent("update_system_snapshot", { visitId, entityType: "SystemSnapshot", entityId: result.id, payload: body });
  res.json(result);
}));

// ─── DEFICIENCIES (append to JSON array on SystemSnapshot) ──────────────────────

agentRouter.post("/visits/:id/deficiencies", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "id");
  const body = z.object({ deficiency: z.string().min(1) }).parse(req.body);

  const visit = await prisma.visit.findUnique({ where: { id: visitId }, select: { propertyId: true } });
  if (!visit) {
    res.status(404).json({ error: "Visit not found" });
    return;
  }

  // Get or create snapshot
  let snapshot = await prisma.systemSnapshot.findUnique({ where: { propertyId: visit.propertyId } });
  if (!snapshot) {
    snapshot = await prisma.systemSnapshot.create({
      data: {
        propertyId: visit.propertyId,
        deficienciesJson: JSON.stringify([]),
        changeLogJson: JSON.stringify([]),
      },
    });
  }

  const deficiencies: string[] = snapshot.deficienciesJson ? JSON.parse(snapshot.deficienciesJson) : [];
  deficiencies.push(body.deficiency);

  const updated = await prisma.systemSnapshot.update({
    where: { propertyId: visit.propertyId },
    data: { deficienciesJson: JSON.stringify(deficiencies) },
  });

  logAgent("add_deficiency", { visitId, entityType: "SystemSnapshot", entityId: updated.id, payload: body });
  res.status(201).json({ deficiencies });
}));

// ─── FINDINGS ───────────────────────────────────────────────────────────────────

agentRouter.post("/visits/:id/findings", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "id");
  const body = z.object({
    findingText: z.string().min(1),
    confidence: z.enum(["high", "medium", "low"]).optional(),
  }).parse(req.body);

  const created = await prisma.finding.create({ data: { visitId, ...body } });
  logAgent("create_finding", { visitId, entityType: "Finding", entityId: created.id, payload: body });
  res.status(201).json(created);
}));

// ─── LIMITATIONS ────────────────────────────────────────────────────────────────

agentRouter.post("/visits/:id/limitations", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "id");
  const body = z.object({ limitationText: z.string().min(1) }).parse(req.body);

  const created = await prisma.limitation.create({ data: { visitId, ...body } });
  logAgent("create_limitation", { visitId, entityType: "Limitation", entityId: created.id, payload: body });
  res.status(201).json(created);
}));

// ─── RECOMMENDATIONS ────────────────────────────────────────────────────────────

agentRouter.post("/visits/:id/recommendations", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "id");
  const body = z.object({
    recommendationText: z.string().min(1),
    priority: z.enum(["high", "medium", "low"]).optional(),
  }).parse(req.body);

  const created = await prisma.recommendation.create({ data: { visitId, ...body } });
  logAgent("create_recommendation", { visitId, entityType: "Recommendation", entityId: created.id, payload: body });
  res.status(201).json(created);
}));

// ─── BULK ASSESSMENT ────────────────────────────────────────────────────────────

agentRouter.post("/visits/:id/assessment/bulk", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "id");

  // Verify visit exists
  const visit = await prisma.visit.findUnique({ where: { id: visitId }, select: { id: true, propertyId: true } });
  if (!visit) {
    res.status(404).json({ error: "Visit not found" });
    return;
  }

  const body = z.object({
    customerRequest: z.object({ requestText: z.string().min(1), urgency: z.string().optional() }).optional(),
    observations: z.array(z.object({ observationText: z.string().min(1), location: z.string().optional() })).optional(),
    deficiencies: z.array(z.string().min(1)).optional(),
    findings: z.array(z.object({ findingText: z.string().min(1), confidence: z.enum(["high", "medium", "low"]).optional() })).optional(),
    limitations: z.array(z.object({ limitationText: z.string().min(1) })).optional(),
    recommendations: z.array(z.object({ recommendationText: z.string().min(1), priority: z.enum(["high", "medium", "low"]).optional() })).optional(),
  }).parse(req.body);

  const result: Record<string, unknown> = {};

  await prisma.$transaction(async (tx) => {
    if (body.customerRequest) {
      result.customerRequest = await tx.customerRequest.upsert({
        where: { visitId },
        update: body.customerRequest,
        create: { visitId, ...body.customerRequest },
      });
    }

    if (body.observations?.length) {
      result.observations = await Promise.all(
        body.observations.map((o) => tx.observation.create({ data: { visitId, ...o } }))
      );
    }

    if (body.deficiencies?.length) {
      let snapshot = await tx.systemSnapshot.findUnique({ where: { propertyId: visit.propertyId } });
      if (!snapshot) {
        snapshot = await tx.systemSnapshot.create({
          data: { propertyId: visit.propertyId, deficienciesJson: JSON.stringify([]), changeLogJson: JSON.stringify([]) },
        });
      }
      const existing: string[] = snapshot.deficienciesJson ? JSON.parse(snapshot.deficienciesJson) : [];
      existing.push(...body.deficiencies);
      await tx.systemSnapshot.update({
        where: { propertyId: visit.propertyId },
        data: { deficienciesJson: JSON.stringify(existing) },
      });
      result.deficiencies = existing;
    }

    if (body.findings?.length) {
      result.findings = await Promise.all(
        body.findings.map((f) => tx.finding.create({ data: { visitId, ...f } }))
      );
    }

    if (body.limitations?.length) {
      result.limitations = await Promise.all(
        body.limitations.map((l) => tx.limitation.create({ data: { visitId, ...l } }))
      );
    }

    if (body.recommendations?.length) {
      result.recommendations = await Promise.all(
        body.recommendations.map((r) => tx.recommendation.create({ data: { visitId, ...r } }))
      );
    }
  });

  logAgent("bulk_assessment", { visitId, payload: body });
  res.status(201).json(result);
}));

// ─── AI ESTIMATE TRIGGER ────────────────────────────────────────────────────────

agentRouter.post("/visits/:id/ai-estimate/run", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "id");

  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    select: { id: true, propertyId: true, mode: true },
  });
  if (!visit) {
    res.status(404).json({ error: "Visit not found" });
    return;
  }

  const estimate = await prisma.estimate.create({
    data: {
      visitId,
      propertyId: visit.propertyId,
      title: `Agent Estimate — ${new Date().toLocaleDateString("en-US")}`,
    },
  });

  // Create a default option
  await prisma.estimateOption.create({
    data: {
      estimateId: estimate.id,
      optionLabel: "Option A",
      sortOrder: 0,
    },
  });

  const full = await prisma.estimate.findUnique({
    where: { id: estimate.id },
    include: { options: true },
  });

  logAgent("create_estimate", { visitId, entityType: "Estimate", entityId: estimate.id });
  res.status(201).json(full);
}));

// ─── OPENAPI SPEC ───────────────────────────────────────────────────────────────

agentRouter.get("/openapi.json", (_req, res) => {
  res.json({
    openapi: "3.0.3",
    info: {
      title: "Red Cedar Agent API",
      description: "REST API for Jerry — the voice/SMS field assistant for job walks",
      version: "1.0.0",
    },
    servers: [{ url: "https://rceestimator-production.up.railway.app/api/agent" }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "AGENT_API_TOKEN" },
      },
    },
    paths: {
      "/active-visit": {
        get: {
          summary: "Get the currently active visit",
          responses: { "200": { description: "Full visit object" }, "404": { description: "No active visit" } },
        },
        post: {
          summary: "Set the active visit by ID or address search",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    { type: "object", properties: { visitId: { type: "string" } }, required: ["visitId"] },
                    { type: "object", properties: { address: { type: "string", minLength: 3 } }, required: ["address"] },
                  ],
                },
              },
            },
          },
          responses: { "200": { description: "Full visit object" }, "404": { description: "No match found" } },
        },
      },
      "/visits/{id}": {
        get: {
          summary: "Get full visit state",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" }, description: "Visit ID or 'active'" }],
          responses: { "200": { description: "Full visit object" }, "404": { description: "Not found" } },
        },
      },
      "/visits/{id}/customer-request": {
        patch: {
          summary: "Upsert customer request",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { requestText: { type: "string" }, urgency: { type: "string" } }, required: ["requestText"] } } },
          },
          responses: { "200": { description: "Updated customer request" } },
        },
      },
      "/visits/{id}/observations": {
        post: {
          summary: "Add an observation",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { observationText: { type: "string" }, location: { type: "string" } }, required: ["observationText"] } } },
          },
          responses: { "201": { description: "Created observation" } },
        },
      },
      "/visits/{id}/system-snapshot": {
        patch: {
          summary: "Update system snapshot (service, panel, grounding, wiring)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    serviceSummary: { type: "string" },
                    panelSummary: { type: "string" },
                    groundingSummary: { type: "string" },
                    wiringMethodSummary: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "Updated snapshot" } },
        },
      },
      "/visits/{id}/deficiencies": {
        post: {
          summary: "Append a deficiency",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { deficiency: { type: "string" } }, required: ["deficiency"] } } },
          },
          responses: { "201": { description: "Updated deficiencies array" } },
        },
      },
      "/visits/{id}/findings": {
        post: {
          summary: "Add a finding",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { findingText: { type: "string" }, confidence: { type: "string", enum: ["high", "medium", "low"] } },
                  required: ["findingText"],
                },
              },
            },
          },
          responses: { "201": { description: "Created finding" } },
        },
      },
      "/visits/{id}/limitations": {
        post: {
          summary: "Add a limitation",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { limitationText: { type: "string" } }, required: ["limitationText"] } } },
          },
          responses: { "201": { description: "Created limitation" } },
        },
      },
      "/visits/{id}/recommendations": {
        post: {
          summary: "Add a recommendation",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { recommendationText: { type: "string" }, priority: { type: "string", enum: ["high", "medium", "low"] } },
                  required: ["recommendationText"],
                },
              },
            },
          },
          responses: { "201": { description: "Created recommendation" } },
        },
      },
      "/visits/{id}/assessment/bulk": {
        post: {
          summary: "Bulk update assessment — append multiple items at once",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    customerRequest: { type: "object", properties: { requestText: { type: "string" }, urgency: { type: "string" } } },
                    observations: { type: "array", items: { type: "object", properties: { observationText: { type: "string" }, location: { type: "string" } } } },
                    deficiencies: { type: "array", items: { type: "string" } },
                    findings: { type: "array", items: { type: "object", properties: { findingText: { type: "string" }, confidence: { type: "string", enum: ["high", "medium", "low"] } } } },
                    limitations: { type: "array", items: { type: "object", properties: { limitationText: { type: "string" } } } },
                    recommendations: { type: "array", items: { type: "object", properties: { recommendationText: { type: "string" }, priority: { type: "string", enum: ["high", "medium", "low"] } } } },
                  },
                },
              },
            },
          },
          responses: { "201": { description: "Created records" } },
        },
      },
      "/visits/{id}/ai-estimate/run": {
        post: {
          summary: "Create a new estimate for this visit",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "201": { description: "Created estimate with default option" } },
        },
      },
    },
  });
});
