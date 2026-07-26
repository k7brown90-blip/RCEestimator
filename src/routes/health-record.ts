/**
 * Health Record (field inspection PWA) integration routes.
 *
 * Two routers with different auth models:
 * - healthRecordTechRouter — used by the offline-first PWA in the field.
 *   Auth: per-technician bearer token (Technician.accessToken). Mounted BEFORE
 *   pinAuthMiddleware in app.ts (same pattern as the agent routers).
 * - healthRecordAdminRouter — used by the CRM client (admin). Mounted AFTER
 *   pinAuthMiddleware, so it rides the existing owner PIN/JWT session.
 */

import express from "express";
import crypto from "node:crypto";
import { z, ZodError } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, readParam } from "./agent-helpers";
import { generateInspectionRenewalLeads } from "../services/inspectionRetention";
import { generateHealthReport } from "../services/pdfGenerator";

// ─── TECHNICIAN AUTH ────────────────────────────────────────────────────────────

interface TechRequest extends express.Request {
  technician?: { id: string; name: string; role: string };
}

const technicianAuth: express.RequestHandler = (req: TechRequest, res, next) => {
  void (async () => {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) {
      res.status(401).json({ success: false, error: { code: "unauthorized", message: "Technician token required" } });
      return;
    }
    const technician = await prisma.technician.findUnique({ where: { accessToken: token } });
    if (!technician || !technician.isActive) {
      res.status(401).json({ success: false, error: { code: "unauthorized", message: "Invalid or inactive technician token" } });
      return;
    }
    req.technician = { id: technician.id, name: technician.name, role: technician.role };
    next();
  })().catch(next);
};

const zodErrorHandler: express.ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof ZodError) {
    res.status(422).json({ success: false, error: { code: "validation", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } });
    return;
  }
  next(err);
};

// ─── TECH ROUTER (PWA-facing) ───────────────────────────────────────────────────

export const healthRecordTechRouter = express.Router();
healthRecordTechRouter.use(technicianAuth);

/** Who am I — lets the PWA confirm a token and greet the technician. */
healthRecordTechRouter.get("/me", (req: TechRequest, res) => {
  res.json({ success: true, data: req.technician });
});

/**
 * GET /health-record/assignments — visits assigned to the authenticated
 * technician that still need an inspection, with the property/customer context
 * the PWA needs to pre-fill the job.
 */
healthRecordTechRouter.get("/assignments", asyncHandler(async (req: TechRequest, res) => {
  const assignments = await prisma.visitAssignment.findMany({
    where: {
      technicianId: req.technician!.id,
      status: { in: ["assigned", "in_progress"] },
      visit: { status: { notIn: ["cancelled", "completed"] } },
    },
    include: {
      visit: {
        include: {
          property: true,
          customer: { select: { id: true, name: true, phone: true } },
        },
      },
    },
    orderBy: { assignedAt: "asc" },
  });

  const data = assignments.map((a) => ({
    assignmentId: a.id,
    assignmentStatus: a.status,
    visitId: a.visit.id,
    customerId: a.visit.customer.id,
    customerName: a.visit.customer.name,
    propertyId: a.visit.property.id,
    address: [a.visit.property.addressLine1, a.visit.property.addressLine2, a.visit.property.city, a.visit.property.state, a.visit.property.postalCode]
      .filter(Boolean)
      .join(", "),
    city: a.visit.property.city,
    state: a.visit.property.state,
    scheduledStart: a.visit.scheduledStart?.toISOString() ?? null,
    purpose: a.visit.purpose ?? "Electrical health inspection",
  }));

  res.json({ success: true, data });
}));

const inspectionPushSchema = z.object({
  inspectionId: z.string().min(1), // PWA-generated UUID — idempotency key
  visitId: z.string().min(1),
  jurisdictionId: z.string().min(1),
  inspectionDate: z.string().min(1),
  score: z.number().int(),
  itemsAssessed: z.number().int().nonnegative(),
  criticalFindings: z.array(z.string()),
  contractorReviewed: z.boolean(),
  items: z.array(z.unknown()),
  loadCalc: z.unknown().optional(),
  appVersion: z.string().optional(),
});

/**
 * POST /health-record/inspections — push a completed inspection from the PWA.
 * Idempotent: the PWA inspection UUID is the primary key, so an offline queue
 * can safely retry. Writes to the customer's established account via the
 * Visit → Property → Customer chain, and closes out the assignment.
 */
healthRecordTechRouter.post("/inspections", asyncHandler(async (req: TechRequest, res) => {
  const body = inspectionPushSchema.parse(req.body);

  const visit = await prisma.visit.findUnique({
    where: { id: body.visitId },
    select: { id: true, propertyId: true, customerId: true },
  });
  if (!visit) {
    res.status(404).json({ success: false, error: { code: "not_found", message: `Visit ${body.visitId} not found` } });
    return;
  }

  const data = {
    visitId: visit.id,
    propertyId: visit.propertyId,
    customerId: visit.customerId,
    technicianId: req.technician!.id,
    jurisdictionId: body.jurisdictionId,
    inspectionDate: new Date(body.inspectionDate),
    score: body.score,
    itemsAssessed: body.itemsAssessed,
    criticalFindingsJson: JSON.stringify(body.criticalFindings),
    contractorReviewed: body.contractorReviewed,
    itemsJson: JSON.stringify(body.items),
    loadCalcJson: body.loadCalc !== undefined ? JSON.stringify(body.loadCalc) : null,
    appVersion: body.appVersion ?? null,
  };

  const inspection = await prisma.healthInspection.upsert({
    where: { id: body.inspectionId },
    create: { id: body.inspectionId, ...data },
    update: data,
  });

  // Close out the technician's assignment for this visit (if one exists).
  await prisma.visitAssignment.updateMany({
    where: { visitId: visit.id, technicianId: req.technician!.id, status: { not: "completed" } },
    data: { status: "completed", completedAt: new Date() },
  });

  // Surface critical findings into the visit's Finding chain so they appear in
  // the existing CRM history views. Tagged so re-syncs don't duplicate.
  if (body.criticalFindings.length > 0) {
    const tag = `[HealthRecord ${body.inspectionId}]`;
    const existing = await prisma.finding.findFirst({
      where: { visitId: visit.id, findingText: { contains: tag } },
    });
    if (!existing) {
      await prisma.finding.create({
        data: {
          visitId: visit.id,
          findingText: `${tag} Critical finding(s): ${body.criticalFindings.join(", ")} — health score ${body.score} (capped ≤69 until resolved)`,
          confidence: "high",
        },
      });
    }
  }

  res.status(201).json({ success: true, data: { id: inspection.id, syncedAt: inspection.syncedAt.toISOString() } });
}));

/**
 * PUT /health-record/inspections/:inspectionId/photos/:photoId — upload photo
 * evidence from the PWA. Idempotent (photo UUID is the primary key); raw image
 * body. Stored in Postgres so evidence rides the managed database backups.
 */
healthRecordTechRouter.put(
  "/inspections/:inspectionId/photos/:photoId",
  express.raw({ type: "image/*", limit: "15mb" }),
  asyncHandler(async (req: TechRequest, res) => {
    const inspectionId = readParam(req, "inspectionId");
    const photoId = readParam(req, "photoId");
    const body = req.body as Buffer;

    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ success: false, error: { code: "bad_request", message: "Raw image body required (Content-Type: image/*)" } });
      return;
    }

    const inspection = await prisma.healthInspection.findUnique({
      where: { id: inspectionId },
      select: { id: true },
    });
    if (!inspection) {
      res.status(404).json({ success: false, error: { code: "not_found", message: `Inspection ${inspectionId} not found — push the inspection before its photos` } });
      return;
    }

    const data = {
      inspectionId,
      mimeType: req.headers["content-type"] ?? "image/jpeg",
      sizeBytes: body.length,
      data: body,
    };
    await prisma.inspectionPhoto.upsert({
      where: { id: photoId },
      create: { id: photoId, ...data },
      update: data,
    });
    res.status(201).json({ success: true, data: { id: photoId, sizeBytes: body.length } });
  }),
);

healthRecordTechRouter.use(zodErrorHandler);

// ─── ADMIN ROUTER (CRM client, PIN/JWT session) ────────────────────────────────

export const healthRecordAdminRouter = express.Router();

/** List technicians (tokens included — owner-only surface). */
healthRecordAdminRouter.get("/technicians", asyncHandler(async (_req, res) => {
  const technicians = await prisma.technician.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { assignments: true, healthInspections: true } } },
  });
  res.json(technicians);
}));

healthRecordAdminRouter.post("/technicians", asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(1),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    employeeNumber: z.string().min(1).optional(),
    role: z.enum(["technician", "supervisor", "admin"]).optional(),
  }).parse(req.body);

  const technician = await prisma.technician.create({
    data: { ...body, accessToken: crypto.randomBytes(24).toString("base64url") },
  });
  res.status(201).json(technician);
}));

healthRecordAdminRouter.patch("/technicians/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(1).optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().nullable().optional(),
    employeeNumber: z.string().min(1).nullable().optional(),
    role: z.enum(["technician", "supervisor", "admin"]).optional(),
    isActive: z.boolean().optional(),
    rotateToken: z.boolean().optional(),
  }).parse(req.body);

  const { rotateToken, ...fields } = body;
  const technician = await prisma.technician.update({
    where: { id: readParam(req, "id") },
    data: {
      ...fields,
      ...(rotateToken ? { accessToken: crypto.randomBytes(24).toString("base64url") } : {}),
    },
  });
  res.json(technician);
}));

/** Assign a visit's inspection to a technician. */
healthRecordAdminRouter.post("/visits/:visitId/assign", asyncHandler(async (req, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({
    technicianId: z.string().min(1),
    role: z.enum(["primary", "helper"]).optional(),
  }).parse(req.body);

  const assignment = await prisma.visitAssignment.upsert({
    where: { visitId_technicianId: { visitId, technicianId: body.technicianId } },
    create: { visitId, technicianId: body.technicianId, role: body.role ?? "primary" },
    update: { role: body.role ?? "primary", status: "assigned", completedAt: null },
    include: { technician: true },
  });
  res.status(201).json(assignment);
}));

healthRecordAdminRouter.get("/visits/:visitId/assignments", asyncHandler(async (req, res) => {
  const assignments = await prisma.visitAssignment.findMany({
    where: { visitId: readParam(req, "visitId") },
    include: { technician: { select: { id: true, name: true, role: true, isActive: true } } },
    orderBy: { assignedAt: "asc" },
  });
  res.json(assignments);
}));

healthRecordAdminRouter.delete("/assignments/:id", asyncHandler(async (req, res) => {
  await prisma.visitAssignment.delete({ where: { id: readParam(req, "id") } });
  res.status(204).end();
}));

const inspectionSummary = {
  id: true,
  visitId: true,
  propertyId: true,
  customerId: true,
  jurisdictionId: true,
  inspectionDate: true,
  score: true,
  itemsAssessed: true,
  criticalFindingsJson: true,
  contractorReviewed: true,
  syncedAt: true,
  technician: { select: { id: true, name: true } },
} as const;

/** Inspection history for a customer (newest first) — the retention record. */
healthRecordAdminRouter.get("/customers/:customerId/inspections", asyncHandler(async (req, res) => {
  const inspections = await prisma.healthInspection.findMany({
    where: { customerId: readParam(req, "customerId") },
    select: inspectionSummary,
    orderBy: { inspectionDate: "desc" },
  });
  res.json(inspections);
}));

healthRecordAdminRouter.get("/properties/:propertyId/inspections", asyncHandler(async (req, res) => {
  const inspections = await prisma.healthInspection.findMany({
    where: { propertyId: readParam(req, "propertyId") },
    select: inspectionSummary,
    orderBy: { inspectionDate: "desc" },
  });
  res.json(inspections);
}));

healthRecordAdminRouter.get("/visits/:visitId/inspections", asyncHandler(async (req, res) => {
  const inspections = await prisma.healthInspection.findMany({
    where: { visitId: readParam(req, "visitId") },
    select: inspectionSummary,
    orderBy: { inspectionDate: "desc" },
  });
  res.json(inspections);
}));

/** Full inspection payload (items + load calc) for the detail view. */
healthRecordAdminRouter.get("/inspections/:id", asyncHandler(async (req, res) => {
  const inspection = await prisma.healthInspection.findUnique({
    where: { id: readParam(req, "id") },
    include: {
      technician: { select: { id: true, name: true } },
      photos: { select: { id: true, mimeType: true, sizeBytes: true, uploadedAt: true } },
    },
  });
  if (!inspection) {
    res.status(404).json({ error: "Inspection not found" });
    return;
  }
  res.json(inspection);
}));

/** Photo evidence bytes for the CRM detail view. */
healthRecordAdminRouter.get("/photos/:photoId", asyncHandler(async (req, res) => {
  const photo = await prisma.inspectionPhoto.findUnique({
    where: { id: readParam(req, "photoId") },
  });
  if (!photo) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }
  res.setHeader("Content-Type", photo.mimeType);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.send(Buffer.from(photo.data));
}));

/**
 * POST /health-record-admin/inspections/:id/review — the contractor's
 * acknowledgment of a report (required before a critical-finding report is
 * customer-facing). Records who reviewed and when.
 */
healthRecordAdminRouter.post("/inspections/:id/review", asyncHandler(async (req, res) => {
  const body = z.object({ reviewedBy: z.string().min(1) }).parse(req.body);
  const id = readParam(req, "id");
  const existing = await prisma.healthInspection.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    res.status(404).json({ error: "Inspection not found" });
    return;
  }
  const inspection = await prisma.healthInspection.update({
    where: { id },
    data: { contractorReviewed: true, reviewedAt: new Date(), reviewedBy: body.reviewedBy },
    select: { id: true, contractorReviewed: true, reviewedAt: true, reviewedBy: true },
  });
  res.json(inspection);
}));

/** Manual trigger for the annual-inspection retention sweep (also runs on cron). */
healthRecordAdminRouter.post("/retention/run", asyncHandler(async (_req, res) => {
  const result = await generateInspectionRenewalLeads();
  res.json(result);
}));

/**
 * POST /health-record-admin/inspections/:id/report — render the inspection
 * into the customer's document chain (same delivery path as contracts).
 */
healthRecordAdminRouter.post("/inspections/:id/report", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const exists = await prisma.healthInspection.findUnique({ where: { id }, select: { id: true } });
  if (!exists) {
    res.status(404).json({ error: "Inspection not found" });
    return;
  }
  const result = await generateHealthReport(id);
  res.status(201).json(result);
}));

healthRecordAdminRouter.use(zodErrorHandler);
