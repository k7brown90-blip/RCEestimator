import express from "express";
import { z, ZodError } from "zod";
import { prisma } from "../lib/prisma";
import { sendSms, KYLE_PHONE } from "../services/twilio";

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

// ─── STRING HELPERS ─────────────────────────────────────────────────────────────

function truncate(s: unknown, max: number): string {
  const text = typeof s === "string" ? s : String(s ?? "");
  return text.length <= max ? text : text.slice(0, max) + "…";
}

// ─── AUDIT LOG ──────────────────────────────────────────────────────────────────

function logAgent(action: string, details: {
  visitId?: string;
  entityType?: string;
  entityId?: string;
  payload?: unknown;
  endpoint?: string;
  responseStatus?: number;
  durationMs?: number;
  clientRequestId?: string;
}): void {
  prisma.agentAuditLog.create({
    data: {
      action,
      visitId: details.visitId,
      entityType: details.entityType,
      entityId: details.entityId,
      payloadJson: details.payload ? JSON.stringify(details.payload) : null,
      endpoint: details.endpoint,
      responseStatus: details.responseStatus,
      durationMs: details.durationMs,
      clientRequestId: details.clientRequestId,
    },
  }).catch((err) => console.error("[AgentAudit] log failed:", err));
}

// ─── IDEMPOTENCY ────────────────────────────────────────────────────────────────

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function checkIdempotency(
  clientRequestId: string | undefined,
  endpoint: string,
): Promise<object | null> {
  if (!clientRequestId) return null;

  // Fire-and-forget cleanup of expired records
  prisma.agentIdempotency.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - IDEMPOTENCY_TTL_MS) } },
  }).catch(() => {});

  const existing = await prisma.agentIdempotency.findUnique({
    where: { clientRequestId_endpoint: { clientRequestId, endpoint } },
  });

  if (!existing) return null;

  if (Date.now() - existing.createdAt.getTime() > IDEMPOTENCY_TTL_MS) {
    await prisma.agentIdempotency.delete({ where: { id: existing.id } }).catch(() => {});
    return null;
  }

  return JSON.parse(existing.responseJson);
}

async function saveIdempotency(
  clientRequestId: string | undefined,
  endpoint: string,
  visitId: string | undefined,
  responseBody: object,
): Promise<void> {
  if (!clientRequestId) return;
  await prisma.agentIdempotency.create({
    data: {
      clientRequestId,
      endpoint,
      visitId,
      responseJson: JSON.stringify(responseBody),
    },
  }).catch(() => {}); // ignore duplicate key errors on race
}

// ─── SPOKEN CONFIRMATION ────────────────────────────────────────────────────────

function spokenConfirmation(action: string, details: Record<string, unknown>): string {
  switch (action) {
    case "create_observation":
      return `Got it — ${truncate(details.observationText, 60)}${details.location ? `, ${details.location}` : ""}. Added to observations.`;
    case "create_finding":
      return `Logged: ${truncate(details.findingText, 60)}${details.confidence ? `, ${details.confidence} confidence` : ""}.`;
    case "add_deficiency":
      return `Added deficiency: ${truncate(details.deficiency, 60)}.`;
    case "create_limitation":
      return `Noted limitation: ${truncate(details.limitationText, 60)}.`;
    case "create_recommendation":
      return `Recommendation added: ${truncate(details.recommendationText, 60)}${details.priority ? `, ${details.priority} priority` : ""}.`;
    case "upsert_customer_request":
      return `Customer request updated: ${truncate(details.requestText, 60)}.`;
    case "update_system_snapshot": {
      const fields = Object.keys(details).filter(k => details[k]).join(", ");
      return `System snapshot updated: ${fields}.`;
    }
    case "bulk_assessment": {
      const counts = Object.entries(details)
        .filter(([, v]) => v)
        .map(([k, v]) => Array.isArray(v) ? `${(v as unknown[]).length} ${k}` : k);
      return `Bulk update: added ${counts.join(", ")}.`;
    }
    case "create_estimate":
      return "Estimate created with a default option. Ready for line items.";
    default:
      return "Done.";
  }
}

// ─── AGENT ERROR HELPERS ────────────────────────────────────────────────────────

function agentZodError(err: ZodError): { code: string; message: string; spoken_fallback: string } {
  const issue = err.issues[0];
  let spoken_fallback: string;
  let message: string;
  const path = issue.path.join(".");

  switch (issue.code) {
    case "invalid_value": {
      const vals = "values" in issue ? (issue.values as string[]).join(", ") : "";
      message = `${path || "value"} must be one of: ${vals}`;
      spoken_fallback = `That wasn't one of the options — pick from ${vals}.`;
      break;
    }
    case "too_small":
      message = `${path || "value"} is required`;
      spoken_fallback = "I didn't catch that — could you say it again?";
      break;
    case "invalid_type": {
      const expected = "expected" in issue ? String(issue.expected) : "valid input";
      message = `${path || "value"} must be a ${expected}`;
      spoken_fallback = `I need a ${expected} there.`;
      break;
    }
    default:
      message = issue.message;
      spoken_fallback = "Something wasn't right with that input. Try again?";
  }

  return { code: "VALIDATION_FAILED", message, spoken_fallback };
}

function visitNotFoundError(): { error: { code: string; message: string; spoken_fallback: string } } {
  return { error: { code: "NOT_FOUND", message: "Visit not found", spoken_fallback: "I couldn't find that visit. Try setting the active visit first." } };
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

// Zod error handler — agent-friendly
agentRouter.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof ZodError) {
    res.status(422).json({ error: agentZodError(err) });
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
  const body = z.object({ query: z.string().min(1) }).parse(req.body);
  const query = body.query.trim();

  type Candidate = { visitId: string; label: string };
  const candidates: Candidate[] = [];

  // 1. Direct ID — looks like a cuid (cl... or 25+ chars)
  if (/^cl[a-z0-9]{20,}$/i.test(query) || query.length >= 25) {
    const visit = await prisma.visit.findUnique({
      where: { id: query },
      include: { customer: { select: { name: true } }, property: { select: { addressLine1: true } } },
    });
    if (visit) {
      candidates.push({ visitId: visit.id, label: `${visit.customer.name} — ${visit.property.addressLine1}` });
    }
  }

  // 2. "current" / "the one I'm at" — most recently updated visit in last 4 hours
  if (candidates.length === 0 && /^(current|the one i'?m at|this one|latest)$/i.test(query)) {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const recent = await prisma.visit.findFirst({
      where: { visitDate: { gte: fourHoursAgo } },
      orderBy: { visitDate: "desc" },
      include: { customer: { select: { name: true } }, property: { select: { addressLine1: true } } },
    });
    if (recent) {
      candidates.push({ visitId: recent.id, label: `${recent.customer.name} — ${recent.property.addressLine1}` });
    }
  }

  // 3. Customer name
  if (candidates.length === 0) {
    const customers = await prisma.customer.findMany({
      where: { name: { contains: query } },
      select: { id: true, name: true },
      take: 5,
    });
    if (customers.length > 0) {
      const visits = await prisma.visit.findMany({
        where: { customerId: { in: customers.map(c => c.id) } },
        orderBy: { visitDate: "desc" },
        take: 5,
        include: { customer: { select: { name: true } }, property: { select: { addressLine1: true } } },
      });
      for (const v of visits) {
        const date = v.visitDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        candidates.push({ visitId: v.id, label: `${v.customer.name} — ${v.property.addressLine1} (${date})` });
      }
    }
  }

  // 4. Address
  if (candidates.length === 0) {
    const properties = await prisma.property.findMany({
      where: { addressLine1: { contains: query } },
      select: { id: true, addressLine1: true },
      take: 5,
    });
    if (properties.length > 0) {
      const visits = await prisma.visit.findMany({
        where: { propertyId: { in: properties.map(p => p.id) } },
        orderBy: { visitDate: "desc" },
        take: 5,
        include: { customer: { select: { name: true } }, property: { select: { addressLine1: true } } },
      });
      for (const v of visits) {
        const date = v.visitDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        candidates.push({ visitId: v.id, label: `${v.customer.name} — ${v.property.addressLine1} (${date})` });
      }
    }
  }

  // 5. Lead/job type — search purpose and customer request text
  if (candidates.length === 0) {
    const visits = await prisma.visit.findMany({
      where: {
        OR: [
          { purpose: { contains: query } },
          { customerRequest: { requestText: { contains: query } } },
        ],
      },
      orderBy: { visitDate: "desc" },
      take: 5,
      include: { customer: { select: { name: true } }, property: { select: { addressLine1: true } } },
    });
    for (const v of visits) {
      const date = v.visitDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      candidates.push({ visitId: v.id, label: `${v.customer.name} — ${v.property.addressLine1} (${date})` });
    }
  }

  // No matches at all
  if (candidates.length === 0) {
    res.status(404).json({
      error: { code: "NOT_FOUND", message: "No visits matched that query", spoken_fallback: "I couldn't find a visit matching that. Try a customer name or address." },
    });
    return;
  }

  // Disambiguation — multiple matches
  if (candidates.length > 1) {
    res.json({ disambiguation: candidates.slice(0, 3) });
    return;
  }

  // Exactly 1 match — set active
  const visitId = candidates[0].visitId;
  activeVisit = { visitId, setAt: Date.now() };
  logAgent("set_active_visit", { visitId, endpoint: "/active-visit" });

  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: FULL_VISIT_INCLUDE,
  });
  res.json({ ...visit, spoken_confirmation: `Active visit set to ${candidates[0].label}.` });
}));

// ─── CLEAR ACTIVE VISIT ─────────────────────────────────────────────────────────

agentRouter.post("/active-visit/clear", asyncHandler(async (_req, res) => {
  activeVisit = null;
  logAgent("clear_active_visit", { endpoint: "/active-visit/clear" });
  res.json({ cleared: true, spoken_confirmation: "Active visit cleared. Ready for the next job." });
}));

// ─── VISIT READ ─────────────────────────────────────────────────────────────────

agentRouter.get("/visits/:id", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const visit = await prisma.visit.findUnique({
    where: { id },
    include: FULL_VISIT_INCLUDE,
  });
  if (!visit) {
    res.status(404).json(visitNotFoundError());
    return;
  }
  res.json(visit);
}));

// ─── CUSTOMER REQUEST ───────────────────────────────────────────────────────────

agentRouter.patch("/visits/:id/customer-request", asyncHandler(async (req, res) => {
  const start = Date.now();
  const visitId = readParam(req, "id");
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/visits/:id/customer-request";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    requestText: z.string().min(1),
    urgency: z.string().optional(),
  }).parse(req.body);

  const result = await prisma.customerRequest.upsert({
    where: { visitId },
    update: body,
    create: { visitId, ...body },
  });

  const confirmation = spokenConfirmation("upsert_customer_request", body);
  const responseBody = { ...result, spoken_confirmation: confirmation };

  await saveIdempotency(clientRequestId, endpoint, visitId, responseBody);
  logAgent("upsert_customer_request", { visitId, entityType: "CustomerRequest", entityId: result.id, payload: body, endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
  res.json(responseBody);
}));

// ─── OBSERVATIONS ───────────────────────────────────────────────────────────────

agentRouter.post("/visits/:id/observations", asyncHandler(async (req, res) => {
  const start = Date.now();
  const visitId = readParam(req, "id");
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/visits/:id/observations";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    observationText: z.string().min(1),
    location: z.string().optional(),
  }).parse(req.body);

  const created = await prisma.observation.create({ data: { visitId, ...body } });
  const confirmation = spokenConfirmation("create_observation", body);
  const responseBody = { ...created, spoken_confirmation: confirmation };

  await saveIdempotency(clientRequestId, endpoint, visitId, responseBody);
  logAgent("create_observation", { visitId, entityType: "Observation", entityId: created.id, payload: body, endpoint, responseStatus: 201, durationMs: Date.now() - start, clientRequestId });
  res.status(201).json(responseBody);
}));

// ─── SYSTEM SNAPSHOT ────────────────────────────────────────────────────────────

agentRouter.patch("/visits/:id/system-snapshot", asyncHandler(async (req, res) => {
  const start = Date.now();
  const visitId = readParam(req, "id");
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/visits/:id/system-snapshot";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    serviceSummary: z.string().optional(),
    panelSummary: z.string().optional(),
    groundingSummary: z.string().optional(),
    wiringMethodSummary: z.string().optional(),
  }).parse(req.body);

  // Look up propertyId through the visit
  const visit = await prisma.visit.findUnique({ where: { id: visitId }, select: { propertyId: true } });
  if (!visit) {
    res.status(404).json(visitNotFoundError());
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

  const confirmation = spokenConfirmation("update_system_snapshot", body);
  const responseBody = { ...result, spoken_confirmation: confirmation };

  await saveIdempotency(clientRequestId, endpoint, visitId, responseBody);
  logAgent("update_system_snapshot", { visitId, entityType: "SystemSnapshot", entityId: result.id, payload: body, endpoint, responseStatus: 200, durationMs: Date.now() - start, clientRequestId });
  res.json(responseBody);
}));

// ─── DEFICIENCIES (append to JSON array on SystemSnapshot) ──────────────────────

agentRouter.post("/visits/:id/deficiencies", asyncHandler(async (req, res) => {
  const start = Date.now();
  const visitId = readParam(req, "id");
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/visits/:id/deficiencies";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({ deficiency: z.string().min(1) }).parse(req.body);

  const visit = await prisma.visit.findUnique({ where: { id: visitId }, select: { propertyId: true } });
  if (!visit) {
    res.status(404).json(visitNotFoundError());
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

  const confirmation = spokenConfirmation("add_deficiency", body);
  const responseBody = { deficiencies, spoken_confirmation: confirmation };

  await saveIdempotency(clientRequestId, endpoint, visitId, responseBody);
  logAgent("add_deficiency", { visitId, entityType: "SystemSnapshot", entityId: updated.id, payload: body, endpoint, responseStatus: 201, durationMs: Date.now() - start, clientRequestId });
  res.status(201).json(responseBody);
}));

// ─── FINDINGS ───────────────────────────────────────────────────────────────────

agentRouter.post("/visits/:id/findings", asyncHandler(async (req, res) => {
  const start = Date.now();
  const visitId = readParam(req, "id");
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/visits/:id/findings";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    findingText: z.string().min(1),
    confidence: z.enum(["high", "medium", "low"]).optional(),
  }).parse(req.body);

  const created = await prisma.finding.create({ data: { visitId, ...body } });
  const confirmation = spokenConfirmation("create_finding", body);
  const responseBody = { ...created, spoken_confirmation: confirmation };

  await saveIdempotency(clientRequestId, endpoint, visitId, responseBody);
  logAgent("create_finding", { visitId, entityType: "Finding", entityId: created.id, payload: body, endpoint, responseStatus: 201, durationMs: Date.now() - start, clientRequestId });
  res.status(201).json(responseBody);
}));

// ─── LIMITATIONS ────────────────────────────────────────────────────────────────

agentRouter.post("/visits/:id/limitations", asyncHandler(async (req, res) => {
  const start = Date.now();
  const visitId = readParam(req, "id");
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/visits/:id/limitations";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({ limitationText: z.string().min(1) }).parse(req.body);

  const created = await prisma.limitation.create({ data: { visitId, ...body } });
  const confirmation = spokenConfirmation("create_limitation", body);
  const responseBody = { ...created, spoken_confirmation: confirmation };

  await saveIdempotency(clientRequestId, endpoint, visitId, responseBody);
  logAgent("create_limitation", { visitId, entityType: "Limitation", entityId: created.id, payload: body, endpoint, responseStatus: 201, durationMs: Date.now() - start, clientRequestId });
  res.status(201).json(responseBody);
}));

// ─── RECOMMENDATIONS ────────────────────────────────────────────────────────────

agentRouter.post("/visits/:id/recommendations", asyncHandler(async (req, res) => {
  const start = Date.now();
  const visitId = readParam(req, "id");
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/visits/:id/recommendations";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    recommendationText: z.string().min(1),
    priority: z.enum(["high", "medium", "low"]).optional(),
  }).parse(req.body);

  const created = await prisma.recommendation.create({ data: { visitId, ...body } });
  const confirmation = spokenConfirmation("create_recommendation", body);
  const responseBody = { ...created, spoken_confirmation: confirmation };

  await saveIdempotency(clientRequestId, endpoint, visitId, responseBody);
  logAgent("create_recommendation", { visitId, entityType: "Recommendation", entityId: created.id, payload: body, endpoint, responseStatus: 201, durationMs: Date.now() - start, clientRequestId });
  res.status(201).json(responseBody);
}));

// ─── BULK ASSESSMENT ────────────────────────────────────────────────────────────

agentRouter.post("/visits/:id/assessment/bulk", asyncHandler(async (req, res) => {
  const start = Date.now();
  const visitId = readParam(req, "id");
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/visits/:id/assessment/bulk";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  // Verify visit exists
  const visit = await prisma.visit.findUnique({ where: { id: visitId }, select: { id: true, propertyId: true } });
  if (!visit) {
    res.status(404).json(visitNotFoundError());
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

  logAgent("bulk_assessment", { visitId, payload: body, endpoint, responseStatus: 201, durationMs: Date.now() - start, clientRequestId });

  const confirmation = spokenConfirmation("bulk_assessment", body);
  const responseBody = { ...result, spoken_confirmation: confirmation };

  await saveIdempotency(clientRequestId, endpoint, visitId, responseBody);
  res.status(201).json(responseBody);
}));

// ─── AI ESTIMATE TRIGGER ────────────────────────────────────────────────────────

agentRouter.post("/visits/:id/ai-estimate/run", asyncHandler(async (req, res) => {
  const start = Date.now();
  const visitId = readParam(req, "id");
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/visits/:id/ai-estimate/run";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    select: { id: true, propertyId: true, mode: true },
  });
  if (!visit) {
    res.status(404).json(visitNotFoundError());
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

  logAgent("create_estimate", { visitId, entityType: "Estimate", entityId: estimate.id, endpoint, responseStatus: 201, durationMs: Date.now() - start, clientRequestId });

  const confirmation = spokenConfirmation("create_estimate", {});
  const responseBody = { ...full, spoken_confirmation: confirmation };

  await saveIdempotency(clientRequestId, endpoint, visitId, responseBody);
  res.status(201).json(responseBody);
}));

// ─── WALK SUMMARY ──────────────────────────────────────────────────────────────

agentRouter.get("/visits/:id/walk-summary", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "id");
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: {
      observations: true,
      findings: true,
      limitations: true,
      recommendations: true,
      property: { include: { systemSnapshot: true } },
    },
  });

  if (!visit) {
    res.status(404).json(visitNotFoundError());
    return;
  }

  const deficiencies: string[] = visit.property.systemSnapshot?.deficienciesJson
    ? JSON.parse(visit.property.systemSnapshot.deficienciesJson)
    : [];

  const counts = {
    observations: visit.observations.length,
    findings: visit.findings.length,
    deficiencies: deficiencies.length,
    limitations: visit.limitations.length,
    recommendations: visit.recommendations.length,
  };

  // Build highlights from high-confidence findings and deficiencies
  const highFindings = visit.findings.filter(f => f.confidence === "high");
  const highlightParts: string[] = [];
  if (highFindings.length > 0) {
    const names = highFindings.slice(0, 3).map(f => truncate(f.findingText, 40));
    highlightParts.push(`${highFindings.length} high-confidence finding${highFindings.length > 1 ? "s" : ""} including ${names.join(" and ")}`);
  }
  if (deficiencies.length > 0) {
    highlightParts.push(`${deficiencies.length} code deficienc${deficiencies.length > 1 ? "ies" : "y"} flagged`);
  }
  const highlights = highlightParts.length > 0 ? highlightParts.join(". ") + "." : "No high-priority items flagged.";

  // Build spoken summary
  const parts: string[] = [];
  if (counts.observations > 0) parts.push(`${counts.observations} observation${counts.observations > 1 ? "s" : ""}`);
  if (counts.findings > 0) parts.push(`${counts.findings} finding${counts.findings > 1 ? "s" : ""}`);
  if (counts.deficiencies > 0) parts.push(`${counts.deficiencies} deficienc${counts.deficiencies > 1 ? "ies" : "y"}`);
  if (counts.limitations > 0) parts.push(`${counts.limitations} limitation${counts.limitations > 1 ? "s" : ""}`);
  if (counts.recommendations > 0) parts.push(`${counts.recommendations} recommendation${counts.recommendations > 1 ? "s" : ""}`);

  let spoken_summary = `Walk complete. ${parts.join(", ")} captured.`;
  if (highFindings.length > 0) {
    const topConcerns = highFindings.slice(0, 2).map(f => truncate(f.findingText, 40)).join(" and ");
    spoken_summary += ` Top concern${highFindings.length > 1 ? "s" : ""}: ${topConcerns}, ${highFindings.length > 1 ? "both" : ""} high confidence.`;
  }

  res.json({ counts, highlights, spoken_summary });
}));

// ─── SAVANNAH — OWNER QUESTION ─────────────────────────────────────────────────

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

agentRouter.post("/savannah/owner-question", asyncHandler(async (req, res) => {
  const start = Date.now();
  const clientRequestId = req.headers["x-client-request-id"] as string | undefined;
  const endpoint = "/savannah/owner-question";

  const cached = await checkIdempotency(clientRequestId, endpoint);
  if (cached) { res.json(cached); return; }

  const body = z.object({
    customer_name: z.string().min(1),
    callback_phone: z.string().min(7),
    question: z.string().min(1),
    context: z.string().optional(),
  }).parse(req.body);

  const phone = normalizePhone(body.callback_phone);

  // Upsert customer by phone
  let customer = await prisma.customer.findFirst({ where: { phone } });
  if (!customer) {
    customer = await prisma.customer.create({
      data: { name: body.customer_name, phone },
    });
  }

  // Create lead
  const lead = await prisma.lead.create({
    data: {
      name: body.customer_name,
      phone,
      source: "savannah_text",
      status: "new",
      leadStatus: "new",
      notes: body.question,
      customerId: customer.id,
    },
  });

  // Build SMS
  let smsBody = `\u{1F4DE} Question from ${body.customer_name} (${phone}):\n\n"${body.question}"`;
  if (body.context) smsBody += `\n\n${body.context}`;
  smsBody += "\n\nReply directly to them.";

  const smsResult = await sendSms(KYLE_PHONE, smsBody);

  if (!smsResult) {
    res.status(502).json({
      error: {
        code: "SMS_FAILED",
        message: "Failed to send SMS to owner",
        spoken_fallback: "I wasn't able to text Kyle right now. Would you like to leave a voicemail or try calling back later?",
      },
    });
    return;
  }

  const responseBody = {
    success: true,
    leadId: lead.id,
    spoken_confirmation: "Got it \u2014 texted Kyle. He'll reach out when he can.",
  };

  await saveIdempotency(clientRequestId, endpoint, undefined, responseBody);
  logAgent("savannah_owner_question", {
    entityType: "Lead",
    entityId: lead.id,
    payload: { customer_name: body.customer_name, phone, question: body.question },
    endpoint,
    responseStatus: 200,
    durationMs: Date.now() - start,
    clientRequestId,
  });

  res.json(responseBody);
}));

// ─── OPENAPI SPEC ───────────────────────────────────────────────────────────────

agentRouter.get("/openapi.json", (_req, res) => {
  const idempotencyHeader = { name: "x-client-request-id", in: "header", required: false, schema: { type: "string" }, description: "Optional — prevents duplicate writes on retry" };
  const idParam = { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Visit ID or 'active'" };
  const spokenConfirmField = { type: "string", description: "Short natural-language confirmation for voice readback" };
  const agentErrorSchema = {
    type: "object",
    properties: {
      error: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          spoken_fallback: { type: "string" },
        },
      },
    },
  };

  res.json({
    openapi: "3.0.3",
    info: {
      title: "Red Cedar Agent API",
      description: "REST API for Jerry and Savannah — voice/SMS agents for Red Cedar Electric",
      version: "2.1.0",
    },
    servers: [{ url: "https://rceestimator-production.up.railway.app/api/agent" }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "AGENT_API_TOKEN" },
      },
      schemas: {
        AgentError: agentErrorSchema,
      },
    },
    paths: {
      "/active-visit": {
        get: {
          summary: "Get the currently active visit",
          responses: { "200": { description: "Full visit object" }, "404": { description: "No active visit" } },
        },
        post: {
          summary: "Set active visit by natural-language query (name, address, 'current', or visit ID)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { query: { type: "string", minLength: 1, description: "Customer name, address, visit ID, or 'current'" } },
                  required: ["query"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Full visit object with spoken_confirmation, or disambiguation array" },
            "404": { description: "No match found" },
            "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/AgentError" } } } },
          },
        },
      },
      "/active-visit/clear": {
        post: {
          summary: "Clear the active visit",
          responses: { "200": { description: "{ cleared: true, spoken_confirmation }" } },
        },
      },
      "/visits/{id}": {
        get: {
          summary: "Get full visit state",
          parameters: [idParam],
          responses: { "200": { description: "Full visit object" }, "404": { description: "Not found" } },
        },
      },
      "/visits/{id}/walk-summary": {
        get: {
          summary: "Get walk summary with counts, highlights, and spoken summary",
          parameters: [idParam],
          responses: {
            "200": {
              description: "Walk summary",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      counts: { type: "object", properties: { observations: { type: "integer" }, findings: { type: "integer" }, deficiencies: { type: "integer" }, limitations: { type: "integer" }, recommendations: { type: "integer" } } },
                      highlights: { type: "string" },
                      spoken_summary: { type: "string" },
                    },
                  },
                },
              },
            },
            "404": { description: "Not found" },
          },
        },
      },
      "/visits/{id}/customer-request": {
        patch: {
          summary: "Upsert customer request",
          parameters: [idParam, idempotencyHeader],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { requestText: { type: "string" }, urgency: { type: "string" } }, required: ["requestText"] } } },
          },
          responses: { "200": { description: "Updated customer request with spoken_confirmation" } },
        },
      },
      "/visits/{id}/observations": {
        post: {
          summary: "Add an observation",
          parameters: [idParam, idempotencyHeader],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { observationText: { type: "string" }, location: { type: "string" } }, required: ["observationText"] } } },
          },
          responses: { "201": { description: "Created observation with spoken_confirmation" } },
        },
      },
      "/visits/{id}/system-snapshot": {
        patch: {
          summary: "Update system snapshot (service, panel, grounding, wiring)",
          parameters: [idParam, idempotencyHeader],
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
          responses: { "200": { description: "Updated snapshot with spoken_confirmation" } },
        },
      },
      "/visits/{id}/deficiencies": {
        post: {
          summary: "Append a deficiency",
          parameters: [idParam, idempotencyHeader],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { deficiency: { type: "string" } }, required: ["deficiency"] } } },
          },
          responses: { "201": { description: "Updated deficiencies array with spoken_confirmation" } },
        },
      },
      "/visits/{id}/findings": {
        post: {
          summary: "Add a finding",
          parameters: [idParam, idempotencyHeader],
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
          responses: { "201": { description: "Created finding with spoken_confirmation" } },
        },
      },
      "/visits/{id}/limitations": {
        post: {
          summary: "Add a limitation",
          parameters: [idParam, idempotencyHeader],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { limitationText: { type: "string" } }, required: ["limitationText"] } } },
          },
          responses: { "201": { description: "Created limitation with spoken_confirmation" } },
        },
      },
      "/visits/{id}/recommendations": {
        post: {
          summary: "Add a recommendation",
          parameters: [idParam, idempotencyHeader],
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
          responses: { "201": { description: "Created recommendation with spoken_confirmation" } },
        },
      },
      "/visits/{id}/assessment/bulk": {
        post: {
          summary: "Bulk update assessment — append multiple items at once",
          parameters: [idParam, idempotencyHeader],
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
          responses: { "201": { description: "Created records with spoken_confirmation" } },
        },
      },
      "/visits/{id}/ai-estimate/run": {
        post: {
          summary: "Create a new estimate for this visit",
          parameters: [idParam, idempotencyHeader],
          responses: { "201": { description: "Created estimate with default option and spoken_confirmation" } },
        },
      },
      "/savannah/owner-question": {
        post: {
          summary: "Text Kyle a customer question via SMS — used by Savannah phone agent",
          parameters: [idempotencyHeader],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    customer_name: { type: "string", description: "Caller's name" },
                    callback_phone: { type: "string", description: "Caller's phone number" },
                    question: { type: "string", description: "The question to relay to Kyle" },
                    context: { type: "string", description: "Optional extra context from the call" },
                  },
                  required: ["customer_name", "callback_phone", "question"],
                },
              },
            },
          },
          responses: {
            "200": { description: "{ success, leadId, spoken_confirmation }" },
            "502": { description: "SMS delivery failed", content: { "application/json": { schema: { $ref: "#/components/schemas/AgentError" } } } },
            "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/AgentError" } } } },
          },
        },
      },
    },
  });
});
