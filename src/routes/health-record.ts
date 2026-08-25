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
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, readParam } from "./agent-helpers";
import { generateInspectionRenewalLeads } from "../services/inspectionRetention";
import {
  generateCureCertificate,
  generateFindingDeclination,
  generateHealthReport,
  generateUpgradeRecord,
} from "../services/pdfGenerator";
import { notifyTechnicianOfAssignment } from "../services/visitConfirmations";
import { sendHealthReportEmail } from "../services/healthReportEmail";
import { paymentSummary } from "../services/stripePayments";
import { resolveJurisdictions } from "../services/jurisdictionResolver";
import { technicianAuth, zodErrorHandler, type TechRequest } from "./technicianAuth";
import { recordInspectionLoadCalc } from "../services/capacityCheckStore";
import { probeTechCalendar } from "../services/techCalendars";
import { v2PayloadSchema, validateV2Payload, persistV2, V2IngestError } from "../services/protocolV2Ingest";
import { COMPANY_GROUNDING_METHOD } from "../services/reportLanguage";
import {
  declineFinding,
  findingCitations,
  logFindingEvent,
  reconcileInspection,
  reopenFinding,
  resolveFinding,
  scheduleFinding,
} from "../services/findingLedger";

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

  const properties = assignments.map((a) => a.visit.property);
  const propertyIds = [...new Set(properties.map((p) => p.id))];
  const [jurisdictions, lastInspections, openFindings] = await Promise.all([
    resolveJurisdictions(properties),
    // Most recent inspection per property, so the tech can see whether this
    // address has been assessed before without opening the CRM.
    propertyIds.length
      ? prisma.healthInspection.findMany({
        where: { propertyId: { in: propertyIds } },
        select: { propertyId: true, inspectionDate: true },
        orderBy: { inspectionDate: "desc" },
      })
      : Promise.resolve([]),
    // What's already known at each address. Batched into this fan-out rather
    // than fetched per-card, so the queue stays one round trip on a phone.
    propertyIds.length
      ? prisma.propertyFinding.groupBy({
        by: ["propertyId", "status"],
        where: { propertyId: { in: propertyIds }, status: { in: ["open", "scheduled", "declined"] } },
        _count: { _all: true },
      })
      : Promise.resolve([]),
  ]);

  const findingCounts = new Map<string, { open: number; declined: number }>();
  for (const row of openFindings) {
    const counts = findingCounts.get(row.propertyId) ?? { open: 0, declined: 0 };
    if (row.status === "declined") counts.declined += row._count._all;
    else counts.open += row._count._all;
    findingCounts.set(row.propertyId, counts);
  }

  const lastInspectionByProperty = new Map<string, Date>();
  for (const inspection of lastInspections) {
    if (!lastInspectionByProperty.has(inspection.propertyId)) {
      lastInspectionByProperty.set(inspection.propertyId, inspection.inspectionDate);
    }
  }

  const data = assignments.map((a) => {
    const property = a.visit.property;
    const jurisdiction = jurisdictions.get(property)!;
    return {
      assignmentId: a.id,
      assignmentStatus: a.status,
      role: a.role,
      visitId: a.visit.id,
      visitStatus: a.visit.status,
      jobType: a.visit.jobType,
      purpose: a.visit.purpose ?? "Electrical health inspection",
      scheduledStart: a.visit.scheduledStart?.toISOString() ?? null,
      scheduledEnd: a.visit.scheduledEnd?.toISOString() ?? null,
      estimatedDurationDays: a.visit.estimatedDurationDays,
      customerId: a.visit.customer.id,
      customerName: a.visit.customer.name,
      customerPhone: a.visit.customer.phone,
      propertyId: property.id,
      propertyName: property.name,
      address: {
        line1: property.addressLine1,
        line2: property.addressLine2,
        city: property.city,
        state: property.state,
        postalCode: property.postalCode,
        formatted: [property.addressLine1, property.addressLine2, property.city, property.state, property.postalCode]
          .filter(Boolean)
          .join(", "),
      },
      // Resolved by the office, never guessed on the phone. `source: "default"`
      // means nobody has actually set this — the PWA surfaces that rather than
      // silently applying a code edition.
      jurisdictionId: jurisdiction.jurisdictionId,
      jurisdictionSource: jurisdiction.source,
      lastInspectionDate: lastInspectionByProperty.get(property.id)?.toISOString() ?? null,
      // Declined is counted separately and deliberately shown: a tech who
      // re-pitches work the customer already refused loses the customer.
      openFindingCount: findingCounts.get(property.id)?.open ?? 0,
      declinedFindingCount: findingCounts.get(property.id)?.declined ?? 0,
    };
  });

  res.json({ success: true, data });
}));

/**
 * Accepts both the v1 (scored) and v2 (findings-led) payload shapes.
 *
 * That tolerance isn't optional: the PWA is service-worker cached, so a
 * technician can be running an arbitrarily old bundle. Rejecting v1 would mean
 * silently losing completed inspections queued on their phone.
 */
const inspectionPushSchema = z.object({
  inspectionId: z.string().min(1), // PWA-generated UUID — idempotency key
  visitId: z.string().min(1),
  jurisdictionId: z.string().min(1),
  inspectionDate: z.string().min(1),
  score: z.number().int().nullable().optional(), // v1 only
  schemaVersion: z.enum(["v1", "v2"]).default("v1"),
  scope: z.enum(["full", "phase1"]).default("full"),
  itemsAssessed: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative().default(0),
  monitorCount: z.number().int().nonnegative().default(0),
  passCount: z.number().int().nonnegative().default(0),
  belowStandardCount: z.number().int().nonnegative().default(0),
  naCount: z.number().int().nonnegative().default(0),
  criticalFindings: z.array(z.string()),
  contractorReviewed: z.boolean(),
  /**
   * §3.3: which grounding instrument produced this record's readings. Older
   * PWA bundles omit it; the company instrument (EXTECH 3-point
   * fall-of-potential kit) is the default because it is the only meter in the
   * field kit — an explicit different value from a future bundle wins.
   */
  groundingTestMethod: z.enum(["fall_of_potential_3point", "clamp_on_loop", "bonding_continuity"]).optional(),
  items: z.array(z.unknown()),
  loadCalc: z.unknown().optional(),
  appVersion: z.string().optional(),
  /**
   * Per-section technician notes (Kyle, 2026-08-24). Optional for the same
   * service-worker-cache reason as `findings` — old bundles must keep syncing.
   * `includeOnReport` is the promotion toggle: internal by default, and only a
   * promoted note ever reaches the customer's document.
   */
  sectionNotes: z
    .array(
      z.object({
        group: z.string().min(1).max(100),
        note: z.string().trim().min(1).max(4000),
        includeOnReport: z.boolean().default(false),
      }),
    )
    .optional(),
  /**
   * On-site customer acknowledgment — the digital version of the paper form's
   * signature box. Either the signature arrives or skippedReason says why not;
   * both absent just means an older PWA bundle.
   */
  acknowledgment: z
    .object({
      signerName: z.string().trim().min(1).max(200),
      signatureImage: z.string().max(400_000), // data-URL PNG, same cap as estimate signing
      acknowledgedAt: z.string().min(1),
    })
    .optional(),
  ackSkippedReason: z.string().trim().min(1).max(500).optional(),
  /**
   * Self-describing findings for the ledger — the title and citations travel
   * with the push because the server has no copy of the checklist.
   *
   * Optional, and that is load-bearing: the PWA is service-worker cached, so a
   * technician can be running a bundle older than this field. Requiring it would
   * start rejecting completed inspections queued on somebody's phone. Records
   * that arrive without it are reconciled later by the backfill script.
   */
  findings: z
    .array(
      z.object({
        itemId: z.string().min(1),
        locationKey: z.string().optional(),
        result: z.enum(["FAIL", "MONITOR", "BELOW_STANDARD"]),
        track: z.enum(["defect", "upgrade"]).optional(),
        gradedState: z.string().nullable().optional(),
        title: z.string().optional(),
        section: z.string().nullable().optional(),
        citations: z.array(z.string()).optional(),
        critical: z.boolean().optional(),
        findingText: z.string().optional(),
        note: z.string().nullable().optional(),
        resolutionNote: z.string().nullable().optional(),
        expectedEolYear: z.number().int().nullable().optional(),
      }),
    )
    .optional(),
  /**
   * Protocol v2 structured capture (enclosures, items, measurements, GFCI
   * coverage, sampling). Optional for the same reason `findings` is — the
   * PWA is service-worker cached and older bundles must keep syncing. When
   * present, the v2 hard rules run BEFORE anything persists: a violating
   * payload is rejected whole (422) and stays in the offline queue.
   */
  v2: v2PayloadSchema.optional(),
});

/**
 * Item ids the technician recorded at a given result.
 *
 * `items` is `unknown[]` because its shape is the PWA's and has changed twice
 * already. Reading two fields defensively beats versioning a schema the server
 * has no other use for.
 */
function itemIdsWithResult(items: unknown[], result: string): string[] {
  return items
    .filter((item): item is { itemId: string; result: string } => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      return typeof record.itemId === "string" && record.result === result;
    })
    .map((item) => item.itemId);
}

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

  // v2 hard rules run BEFORE anything is written — a violating inspection
  // must not exist in any partial form (§12.3). The 422 carries the rule code
  // so the PWA can tell the tech exactly what to fix.
  let validatedV2: Awaited<ReturnType<typeof validateV2Payload>> | null = null;
  if (body.v2) {
    try {
      validatedV2 = await validateV2Payload(visit.propertyId, body.v2);
    } catch (err) {
      if (err instanceof V2IngestError) {
        res.status(422).json({ success: false, error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  }

  const data = {
    visitId: visit.id,
    propertyId: visit.propertyId,
    customerId: visit.customerId,
    technicianId: req.technician!.id,
    jurisdictionId: body.jurisdictionId,
    inspectionDate: new Date(body.inspectionDate),
    score: body.score ?? null,
    schemaVersion: body.schemaVersion,
    scope: body.scope,
    itemsAssessed: body.itemsAssessed,
    failCount: body.failCount,
    monitorCount: body.monitorCount,
    passCount: body.passCount,
    belowStandardCount: body.belowStandardCount,
    naCount: body.naCount,
    criticalFindingsJson: JSON.stringify(body.criticalFindings),
    groundingTestMethod: body.groundingTestMethod ?? COMPANY_GROUNDING_METHOD,
    contractorReviewed: body.contractorReviewed,
    itemsJson: JSON.stringify(body.items),
    loadCalcJson: body.loadCalc !== undefined ? JSON.stringify(body.loadCalc) : null,
    sectionNotesJson: body.sectionNotes !== undefined ? JSON.stringify(body.sectionNotes) : null,
    customerSignerName: body.acknowledgment?.signerName ?? null,
    customerSignatureImage: body.acknowledgment?.signatureImage ?? null,
    acknowledgedAt: body.acknowledgment ? new Date(body.acknowledgment.acknowledgedAt) : null,
    ackSkippedReason: body.acknowledgment ? null : body.ackSkippedReason ?? null,
    appVersion: body.appVersion ?? null,
  };

  const inspection = await prisma.healthInspection.upsert({
    where: { id: body.inspectionId },
    create: { id: body.inspectionId, ...data },
    update: data,
  });

  // Structured v2 rows — already validated above; replace-on-repush inside a
  // transaction so the offline queue can retry the whole inspection safely.
  let v2Summary: { enclosures: number; items: number; measurements: number; monitorsTracked: number } | null = null;
  if (validatedV2) {
    v2Summary = await persistV2(inspection.id, visit.propertyId, validatedV2);
  }

  // Close out the technician's assignment for this visit (if one exists).
  await prisma.visitAssignment.updateMany({
    where: { visitId: visit.id, technicianId: req.technician!.id, status: { not: "completed" } },
    data: { status: "completed", completedAt: new Date() },
  });

  // The A2 calculation joins the address's one capacity-check history, so an
  // assessment and a phone quote read from the same list instead of two.
  await recordInspectionLoadCalc({
    inspectionId: inspection.id,
    visitId: visit.id,
    propertyId: visit.propertyId,
    customerId: visit.customerId,
    technicianId: req.technician!.id,
    loadCalc: body.loadCalc,
  });

  // Fold this record into the finding ledger — what's known at this address and
  // whether it was ever fixed. A record from a bundle older than the `findings`
  // field still reconciles its PASS/NA observations, so an existing ledger row
  // is closed out or superseded correctly; only the opening of new rows waits
  // for the backfill.
  const ledger = await reconcileInspection(
    {
      inspectionId: inspection.id,
      visitId: visit.id,
      propertyId: visit.propertyId,
      customerId: visit.customerId,
      jurisdictionId: body.jurisdictionId,
      inspectionDate: new Date(body.inspectionDate),
      technicianId: req.technician!.id,
      technicianName: req.technician!.name,
      passedItemIds: itemIdsWithResult(body.items, "PASS"),
      naItemIds: itemIdsWithResult(body.items, "NA"),
    },
    body.findings ?? [],
  );

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
          findingText: `${tag} Critical finding(s): ${body.criticalFindings.join(", ")} — contractor review required before delivery`,
          confidence: "high",
        },
      });
    }
  }

  res.status(201).json({
    success: true,
    data: { id: inspection.id, syncedAt: inspection.syncedAt.toISOString(), ledger, v2: v2Summary },
  });
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

/**
 * POST /health-record/inspections/:id/email — the assigned technician emails
 * the finished report to the customer from the field (Kyle, 2026-08-24: the
 * tech can send from the PWA). Same gate and same delivery log as the CRM
 * door — sendHealthReportEmail refuses an unreviewed critical report either
 * way. A tech can only send a record they made or one on a visit they were
 * assigned to; the address is always the account's, never typed in the field.
 */
healthRecordTechRouter.post("/inspections/:id/email", asyncHandler(async (req: TechRequest, res) => {
  const inspectionId = readParam(req, "id");
  const inspection = await prisma.healthInspection.findUnique({
    where: { id: inspectionId },
    select: { id: true, visitId: true, technicianId: true },
  });
  if (!inspection) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Inspection not found" } });
    return;
  }
  const isTheirs =
    inspection.technicianId === req.technician!.id ||
    Boolean(await prisma.visitAssignment.findFirst({
      where: { visitId: inspection.visitId, technicianId: req.technician!.id },
      select: { id: true },
    }));
  if (!isTheirs) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This inspection is not on one of your visits" } });
    return;
  }

  const result = await sendHealthReportEmail(inspectionId, {
    sentBy: `tech:${req.technician!.id}`,
  });
  if (!result.sent) {
    res.status(409).json({ success: false, error: { code: "not_sent", message: result.reason } });
    return;
  }
  res.json({ success: true, data: { sentTo: result.sentTo, documentId: result.documentId } });
}));

/**
 * GET /health-record/visits/:visitId/payment-info — where the money stands on
 * the tech's assigned visit (Kyle, 2026-08-25: "no way of charging a card on
 * either the admin side or field tech side"). The tech shows the QR / opens
 * the link; the customer pays on their own phone through Stripe Checkout. The
 * tech can never type a card number or change an amount — the link and its
 * amounts are computed server-side off the signed estimate.
 */
healthRecordTechRouter.get("/visits/:visitId/payment-info", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId, technicianId: req.technician!.id },
    select: { id: true },
  });
  if (!assigned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return;
  }
  const est = await prisma.issuedEstimate.findFirst({
    where: {
      signedAt: { not: null },
      status: { not: "void" },
      OR: [{ jobVisitId: visitId }, { visitId }],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!est) { res.json({ success: true, data: null }); return; }
  const origin = `${req.protocol}://${req.get("host")}`;
  const summary = await paymentSummary(prisma, est.id, origin);
  res.json({
    success: true,
    data: summary
      ? {
        number: summary.number,
        billedTotal: summary.billedTotal,
        depositDue: summary.depositDue,
        depositPaid: summary.depositPaid,
        totalPaid: summary.totalPaid,
        balance: summary.balance,
        depositSatisfied: summary.depositSatisfied,
        paidInFull: summary.paidInFull,
        payUrl: summary.payUrl,
        depositPayUrl: summary.depositPayUrl,
        qrUrl: `${summary.payUrl}/qr.svg`,
        depositQrUrl: `${summary.payUrl}/qr.svg?type=deposit`,
      }
      : null,
  });
}));

/**
 * PUT /health-record/visits/:visitId/photos/:photoId — job-site photo upload
 * from the tech PWA. Idempotent (client UUID is the primary key); raw image
 * body; optional caption via the x-photo-caption header.
 */
healthRecordTechRouter.put(
  "/visits/:visitId/photos/:photoId",
  express.raw({ type: "image/*", limit: "15mb" }),
  asyncHandler(async (req: TechRequest, res) => {
    const visitId = readParam(req, "visitId");
    const photoId = readParam(req, "photoId");
    const body = req.body as Buffer;

    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ success: false, error: { code: "bad_request", message: "Raw image body required (Content-Type: image/*)" } });
      return;
    }

    const visit = await prisma.visit.findUnique({ where: { id: visitId }, select: { id: true } });
    if (!visit) {
      res.status(404).json({ success: false, error: { code: "not_found", message: `Visit ${visitId} not found` } });
      return;
    }

    const rawCaption = typeof req.headers["x-photo-caption"] === "string" ? (req.headers["x-photo-caption"] as string) : null;
    // Captions are URI-encoded by the PWA (HTTP headers are latin-1 only)
    let caption: string | null = null;
    if (rawCaption) {
      try {
        caption = decodeURIComponent(rawCaption).slice(0, 500);
      } catch {
        caption = rawCaption.slice(0, 500);
      }
    }
    const data = {
      visitId,
      technicianId: req.technician!.id,
      mimeType: req.headers["content-type"] ?? "image/jpeg",
      sizeBytes: body.length,
      data: body,
    };
    await prisma.visitPhoto.upsert({
      where: { id: photoId },
      create: { id: photoId, ...data, caption },
      // Retries without the caption header must not wipe an existing caption
      update: { ...data, ...(caption != null ? { caption } : {}) },
    });
    res.status(201).json({ success: true, data: { id: photoId, sizeBytes: body.length } });
  }),
);

/**
 * PUT /health-record/receipts/:receiptId — receipt photo upload from the tech
 * PWA. Idempotent (client UUID id). Raw image body; metadata via query params
 * (jobId, category, vendor, amount). Missing amount/vendor are extracted from
 * the image via OpenAI Vision; unparseable receipts land in pending_review.
 */
healthRecordTechRouter.put(
  "/receipts/:receiptId",
  express.raw({ type: "image/*", limit: "15mb" }),
  asyncHandler(async (req: TechRequest, res) => {
    const receiptId = readParam(req, "receiptId");
    const body = req.body as Buffer;

    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ success: false, error: { code: "bad_request", message: "Raw image body required (Content-Type: image/*)" } });
      return;
    }

    const query = z.object({
      jobId: z.string().optional(),
      category: z.enum(["materials", "gas", "maintenance", "overhead"]).optional(),
      vendor: z.string().optional(),
      amount: z.coerce.number().positive().optional(),
    }).parse(req.query);

    if (query.jobId) {
      const visit = await prisma.visit.findUnique({ where: { id: query.jobId }, select: { id: true } });
      if (!visit) {
        res.status(404).json({ success: false, error: { code: "not_found", message: `Visit ${query.jobId} not found` } });
        return;
      }
    }

    // Vision-parse when the tech didn't key in the details manually
    const { parseReceiptImage } = await import("../services/receiptVision");
    const mimeType = (req.headers["content-type"] as string | undefined) ?? "image/jpeg";
    const parsed = query.amount == null || !query.vendor ? await parseReceiptImage(body, mimeType) : null;

    const amount = query.amount ?? parsed?.total ?? 0;
    const data = {
      jobId: query.jobId ?? null,
      category: query.category ?? parsed?.category ?? "materials",
      vendor: query.vendor ?? parsed?.vendor ?? null,
      amount,
      lineItems: parsed && parsed.lineItems.length > 0 ? JSON.stringify(parsed.lineItems) : null,
      source: "tech_pwa",
      status: "pending_review",
      technicianId: req.technician!.id,
      imageData: body,
      imageMime: mimeType,
      ...(parsed?.purchaseDate ? { receivedAt: new Date(`${parsed.purchaseDate}T12:00:00Z`) } : {}),
    };
    const receipt = await prisma.receipt.upsert({
      where: { id: receiptId },
      create: { id: receiptId, ...data },
      update: data,
    });

    res.status(201).json({
      success: true,
      data: {
        id: receipt.id,
        amount: receipt.amount,
        vendor: receipt.vendor,
        category: receipt.category,
        status: receipt.status,
        parsed: parsed != null,
      },
    });
  }),
);

// ─── FINDING LEDGER (technician) ───────────────────────────────────────────────

/** Shape a ledger row for either client. Citations come from the snapshot. */
function serializeFinding(finding: {
  id: string; itemId: string; locationKey: string; cycle: number; track: string;
  title: string; section: string | null; citationsJson: string; jurisdictionId: string;
  severity: string; gradedState: string | null; critical: boolean; findingText: string;
  resolutionNote: string | null; expectedEolYear: number | null; status: string;
  openedAt: Date; openedInspectionId: string; openedVisitId: string;
  lastObservedAt: Date | null; observedCount: number; verifiedPassAt: Date | null;
  scheduledVisitId: string | null; scheduledAt: Date | null;
  resolvedAt: Date | null; resolutionMethod: string | null; resolvedByParty: string | null;
  resolvedByPartyName: string | null; resolutionDetail: string | null; certificateDocId: string | null;
  declinedAt: Date | null; declinedByName: string | null; declinedByRelation: string | null;
  declinedVerbatim: string | null; propertyId: string; customerId: string;
}) {
  const citations = findingCitations(finding);
  return {
    id: finding.id,
    propertyId: finding.propertyId,
    customerId: finding.customerId,
    itemId: finding.itemId,
    locationKey: finding.locationKey,
    cycle: finding.cycle,
    track: finding.track,
    title: finding.title,
    section: finding.section,
    citations,
    // The CRM says "citations unavailable — pre-ledger record" rather than
    // rendering an empty block that reads as though there were none to cite.
    citationsAvailable: citations.length > 0,
    jurisdictionId: finding.jurisdictionId,
    severity: finding.severity,
    gradedState: finding.gradedState,
    critical: finding.critical,
    findingText: finding.findingText,
    resolutionNote: finding.resolutionNote,
    expectedEolYear: finding.expectedEolYear,
    status: finding.status,
    openedAt: finding.openedAt.toISOString(),
    openedInspectionId: finding.openedInspectionId,
    openedVisitId: finding.openedVisitId,
    lastObservedAt: finding.lastObservedAt?.toISOString() ?? null,
    observedCount: finding.observedCount,
    verifiedPassAt: finding.verifiedPassAt?.toISOString() ?? null,
    scheduledVisitId: finding.scheduledVisitId,
    scheduledAt: finding.scheduledAt?.toISOString() ?? null,
    resolvedAt: finding.resolvedAt?.toISOString() ?? null,
    resolutionMethod: finding.resolutionMethod,
    resolvedByParty: finding.resolvedByParty,
    resolvedByPartyName: finding.resolvedByPartyName,
    resolutionDetail: finding.resolutionDetail,
    certificateDocId: finding.certificateDocId,
    declinedAt: finding.declinedAt?.toISOString() ?? null,
    declinedByName: finding.declinedByName,
    declinedByRelation: finding.declinedByRelation,
    declinedVerbatim: finding.declinedVerbatim,
  };
}

/**
 * GET /health-record/properties/:propertyId/findings — what we already know
 * about this house, before the technician opens a single cover.
 *
 * Declined findings matter most here: without them a tech re-sells work the
 * customer already refused, which is the fastest way to lose one.
 */
healthRecordTechRouter.get("/properties/:propertyId/findings", asyncHandler(async (req: TechRequest, res) => {
  const propertyId = readParam(req, "propertyId");
  // Scoped to the technician's own assignments — the field app has no business
  // enumerating findings at an address nobody sent this person to.
  const assigned = await prisma.visitAssignment.findFirst({
    where: {
      technicianId: req.technician!.id,
      visit: { propertyId },
    },
    select: { id: true },
  });
  if (!assigned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not assigned to this property" } });
    return;
  }

  const findings = await prisma.propertyFinding.findMany({
    where: { propertyId, status: { in: ["open", "scheduled", "declined"] } },
    orderBy: [{ critical: "desc" }, { openedAt: "desc" }],
  });
  res.json({ success: true, data: findings.map(serializeFinding) });
}));

/**
 * POST /health-record/findings/:id/cure-claim — the technician fixed it on a
 * service call.
 *
 * The common cure isn't a re-inspection; it's this. The claim does NOT set a
 * terminal status: it drafts the close-out and queues it for the licence holder,
 * mirroring the contractorReviewed gate. Field asserts, contractor countersigns.
 */
healthRecordTechRouter.post("/findings/:id/cure-claim", asyncHandler(async (req: TechRequest, res) => {
  const body = z.object({
    claimId: z.string().min(1), // client UUID — makes the offline retry idempotent
    workPerformed: z.string().min(1),
    performedAt: z.string().min(1),
    visitId: z.string().optional(),
    photoIds: z.array(z.string()).default([]),
  }).parse(req.body);

  const id = readParam(req, "id");
  const finding = await prisma.propertyFinding.findUnique({ where: { id } });
  if (!finding) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Finding not found" } });
    return;
  }

  const existing = await prisma.propertyFindingEvent.findFirst({
    where: { findingId: id, toStatus: "cure_claimed", note: { contains: body.claimId } },
  });
  if (!existing) {
    await logFindingEvent(prisma, {
      findingId: id,
      fromStatus: finding.status,
      toStatus: "cure_claimed",
      actorType: "technician",
      actorId: req.technician!.id,
      actorName: req.technician!.name,
      visitId: body.visitId ?? null,
      note: `[claim ${body.claimId}] ${body.workPerformed} (performed ${body.performedAt}; ${body.photoIds.length} photo(s))`,
    });
  }

  res.status(201).json({
    success: true,
    data: { findingId: id, status: finding.status, awaitingContractorCloseout: true },
  });
}));

/**
 * POST /health-record/findings/:id/declination — capture a refusal at the door,
 * in the customer's own words, while the technician is still standing there.
 */
healthRecordTechRouter.post("/findings/:id/declination", asyncHandler(async (req: TechRequest, res) => {
  const body = z.object({
    declinedByName: z.string().min(1),
    declinedByRelation: z.enum(["owner", "tenant", "property_manager"]),
    declinedVerbatim: z.string().min(1),
    declinedChannel: z.enum(["in_person", "phone", "email", "sms"]).default("in_person"),
  }).parse(req.body);

  const id = readParam(req, "id");
  const exists = await prisma.propertyFinding.findUnique({ where: { id }, select: { id: true } });
  if (!exists) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Finding not found" } });
    return;
  }

  const finding = await declineFinding({
    findingId: id,
    ...body,
    actorType: "technician",
    actorId: req.technician!.id,
    actorName: req.technician!.name,
  });
  res.json({ success: true, data: serializeFinding(finding) });
}));

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
      // Changing the email invalidates whatever access was verified for the
      // old address — force a fresh probe.
      ...(fields.email !== undefined ? { calendarShared: false } : {}),
      ...(rotateToken ? { accessToken: crypto.randomBytes(24).toString("base64url") } : {}),
    },
  });
  res.json(technician);
}));

/**
 * Probe whether the tech's Google Calendar is readable by the app's account.
 * Google's freebusy API silently omits unshared calendars, so this is the only
 * way to distinguish "free all day" from "we can't see their calendar at all".
 * Persists the result to Technician.calendarShared.
 */
healthRecordAdminRouter.post("/technicians/:id/verify-calendar", asyncHandler(async (req, res) => {
  const outcome = await probeTechCalendar(readParam(req, "id"));
  res.json(outcome);
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

  // Dual-channel job notification to the tech (fire-and-forget)
  notifyTechnicianOfAssignment(body.technicianId, visitId, "assigned")
    .catch((err) => console.error("[assign] Tech notify failed:", err));

  res.status(201).json(assignment);
}));

healthRecordAdminRouter.get("/visits/:visitId/assignments", asyncHandler(async (req, res) => {
  const assignments = await prisma.visitAssignment.findMany({
    where: { visitId: readParam(req, "visitId") },
    include: { technician: { select: { id: true, name: true, role: true, isActive: true, employeeNumber: true } } },
    orderBy: { assignedAt: "asc" },
  });
  res.json(assignments);
}));

healthRecordAdminRouter.delete("/assignments/:id", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const assignment = await prisma.visitAssignment.findUnique({ where: { id }, select: { technicianId: true, visitId: true } });
  await prisma.visitAssignment.delete({ where: { id } });
  if (assignment) {
    notifyTechnicianOfAssignment(assignment.technicianId, assignment.visitId, "cancelled")
      .catch((err) => console.error("[unassign] Tech notify failed:", err));
  }
  res.status(204).end();
}));

// HealthInspectionSummary (client/src/lib/api.ts) declares schemaVersion, scope
// and all five counts as required, and HealthRecordPanel renders them. Omitting
// them here made every one of those undefined on the Visit workspace while the
// account summary, which selects them properly, showed the same record fine.
const inspectionSummary = {
  id: true,
  visitId: true,
  propertyId: true,
  customerId: true,
  jurisdictionId: true,
  inspectionDate: true,
  score: true,
  schemaVersion: true,
  scope: true,
  itemsAssessed: true,
  failCount: true,
  monitorCount: true,
  passCount: true,
  belowStandardCount: true,
  naCount: true,
  criticalFindingsJson: true,
  contractorReviewed: true,
  reviewedBy: true,
  syncedAt: true,
  technician: { select: { id: true, name: true, employeeNumber: true } },
  // ── For the account page's Health Records section (Kyle, 2026-08-24) ──
  // Which address the record is for, whether the customer acknowledged it on
  // site, and every time the report was actually emailed (delivery proof).
  acknowledgedAt: true,
  customerSignerName: true,
  ackSkippedReason: true,
  property: { select: { id: true, addressLine1: true, city: true, state: true } },
  deliveries: {
    orderBy: { sentAt: "desc" as const },
    select: { id: true, sentTo: true, sentBy: true, sentAt: true },
  },
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

/**
 * Structured protocol-v2 capture for an inspection — enclosures, items with
 * measurements and bus visuals, GFCI coverage by location, and the sampling
 * disclosure. This is what the v2 report template reads.
 */
healthRecordAdminRouter.get("/inspections/:id/v2", asyncHandler(async (req, res) => {
  const inspectionId = readParam(req, "id");
  const inspection = await prisma.healthInspection.findUnique({
    where: { id: inspectionId },
    select: { id: true, propertyId: true },
  });
  if (!inspection) {
    res.status(404).json({ error: "Inspection not found" });
    return;
  }

  const [items, gfciCoverage, samplingRecords, enclosures] = await Promise.all([
    prisma.inspectionItem.findMany({
      where: { inspectionId },
      include: { measurements: true, busVisual: true, enclosure: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.gfciCoverage.findMany({ where: { inspectionId }, orderBy: { locationDescriptor: "asc" } }),
    prisma.samplingRecord.findMany({ where: { inspectionId } }),
    prisma.enclosure.findMany({ where: { propertyId: inspection.propertyId, retiredAt: null } }),
  ]);

  res.json({ inspectionId, items, gfciCoverage, samplingRecords, enclosures });
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

/**
 * POST /health-record-admin/inspections/:id/email — email the report to the
 * customer from the CRM. Body may carry `to` to override the account address
 * (the tech door can't — only the office overrides). Renders fresh, refuses an
 * unreviewed critical report, and logs the delivery.
 */
healthRecordAdminRouter.post("/inspections/:id/email", asyncHandler(async (req, res) => {
  const body = z.object({ to: z.string().email().optional() }).parse(req.body ?? {});
  const result = await sendHealthReportEmail(readParam(req, "id"), {
    to: body.to ?? null,
    sentBy: "owner:crm",
  });
  if (!result.sent) {
    res.status(409).json({ sent: false, error: result.reason });
    return;
  }
  res.json({ sent: true, sentTo: result.sentTo, documentId: result.documentId });
}));

// The account page's Health Records feed rides the EXISTING
// GET /customers/:customerId/inspections route above — its shared
// inspectionSummary select was extended (property address, acknowledgment,
// deliveries) rather than adding a second route at the same path, which
// Express would never reach.

// ─── FINDING LEDGER (owner) ────────────────────────────────────────────────────

/**
 * GET /health-record-admin/findings — the ledger, filterable.
 *
 * `needsCloseout=true` is the queue that matters: findings whose item passed on a
 * later assessment and are waiting for someone with a licence to say what was
 * actually done about them.
 */
healthRecordAdminRouter.get("/findings", asyncHandler(async (req, res) => {
  const query = z.object({
    propertyId: z.string().optional(),
    customerId: z.string().optional(),
    track: z.enum(["defect", "upgrade"]).optional(),
    status: z.string().optional(),
    needsCloseout: z.enum(["true", "false"]).optional(),
  }).parse(req.query);

  const findings = await prisma.propertyFinding.findMany({
    where: {
      ...(query.propertyId ? { propertyId: query.propertyId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.track ? { track: query.track } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.needsCloseout === "true"
        ? { verifiedPassAt: { not: null }, status: { in: ["open", "scheduled"] } }
        : {}),
    },
    orderBy: [{ critical: "desc" }, { openedAt: "desc" }],
    take: 500,
  });
  res.json(findings.map(serializeFinding));
}));

healthRecordAdminRouter.get("/findings/:id", asyncHandler(async (req, res) => {
  const finding = await prisma.propertyFinding.findUnique({
    where: { id: readParam(req, "id") },
    include: { events: { orderBy: { createdAt: "asc" } } },
  });
  if (!finding) {
    res.status(404).json({ error: "Finding not found" });
    return;
  }
  res.json({
    ...serializeFinding(finding),
    events: finding.events.map((event) => ({
      ...event,
      createdAt: event.createdAt.toISOString(),
    })),
  });
}));

/**
 * PATCH /health-record-admin/findings/:id — the owner's transitions.
 *
 * Resolving is here and nowhere else. A technician can claim a cure; only the
 * licence holder signs one.
 */
healthRecordAdminRouter.patch("/findings/:id", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const body = z.discriminatedUnion("toStatus", [
    z.object({
      toStatus: z.literal("resolved"),
      resolutionMethod: z.enum(["corrected", "replaced", "upgraded", "equipment_removed", "verified_prior_repair"]),
      resolvedByParty: z.enum(["red_cedar", "owner_self", "third_party"]),
      resolvedByPartyName: z.string().nullable().optional(),
      resolvedByVisitId: z.string().nullable().optional(),
      resolvedByTechnicianId: z.string().nullable().optional(),
      resolutionDetail: z.string().min(1),
      resolvedAt: z.string().optional(),
      attestedBy: z.string().min(1),
    }),
    z.object({
      toStatus: z.literal("scheduled"),
      visitId: z.string().min(1),
      scheduledAt: z.string().nullable().optional(),
      actorName: z.string().min(1),
    }),
    z.object({
      toStatus: z.literal("declined"),
      declinedByName: z.string().min(1),
      declinedByRelation: z.enum(["owner", "tenant", "property_manager"]),
      declinedVerbatim: z.string().min(1),
      declinedChannel: z.enum(["in_person", "phone", "email", "sms"]).default("phone"),
      actorName: z.string().min(1),
    }),
    z.object({
      toStatus: z.literal("open"),
      actorName: z.string().min(1),
      note: z.string().optional(),
    }),
    z.object({
      toStatus: z.literal("superseded"),
      actorName: z.string().min(1),
      // A superseded finding is one that stopped applying — the equipment went
      // away, the item was never relevant. Saying why is not optional, because
      // "superseded" with no reason is indistinguishable from a quiet deletion.
      note: z.string().min(1),
    }),
  ]).parse(req.body);

  const existing = await prisma.propertyFinding.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!existing) {
    res.status(404).json({ error: "Finding not found" });
    return;
  }

  try {
    if (body.toStatus === "resolved") {
      const finding = await resolveFinding({
        findingId: id,
        resolutionMethod: body.resolutionMethod,
        resolvedByParty: body.resolvedByParty,
        resolvedByPartyName: body.resolvedByPartyName,
        resolvedByVisitId: body.resolvedByVisitId,
        resolvedByTechnicianId: body.resolvedByTechnicianId,
        resolutionDetail: body.resolutionDetail,
        resolvedAt: body.resolvedAt ? new Date(body.resolvedAt) : undefined,
        attestedBy: body.attestedBy,
      });
      res.json(serializeFinding(finding));
      return;
    }
    if (body.toStatus === "scheduled") {
      const finding = await scheduleFinding(
        id,
        body.visitId,
        body.scheduledAt ? new Date(body.scheduledAt) : null,
        body.actorName,
      );
      res.json(serializeFinding(finding));
      return;
    }
    if (body.toStatus === "declined") {
      const finding = await declineFinding({
        findingId: id,
        declinedByName: body.declinedByName,
        declinedByRelation: body.declinedByRelation,
        declinedVerbatim: body.declinedVerbatim,
        declinedChannel: body.declinedChannel,
        actorType: "owner",
        actorName: body.actorName,
      });
      res.json(serializeFinding(finding));
      return;
    }
    if (body.toStatus === "open") {
      const finding = await reopenFinding(id, body.actorName, body.note);
      res.json(serializeFinding(finding));
      return;
    }

    const finding = await prisma.propertyFinding.update({
      where: { id },
      data: { status: "superseded", followUpAt: null },
    });
    await logFindingEvent(prisma, {
      findingId: id,
      fromStatus: existing.status,
      toStatus: "superseded",
      actorType: "owner",
      actorName: body.actorName,
      note: body.note,
    });
    res.json(serializeFinding(finding));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

/**
 * POST /health-record-admin/findings/certificate — issue the close-out document.
 *
 * The generator refuses to certify anything that isn't already at its track's
 * terminal status, so this cannot be used to declare work done. It documents
 * work that the ledger already records as done.
 */
healthRecordAdminRouter.post("/findings/certificate", asyncHandler(async (req, res) => {
  const body = z.object({
    propertyId: z.string().min(1),
    findingIds: z.array(z.string().min(1)).min(1),
    track: z.enum(["defect", "upgrade"]),
    attestedBy: z.string().min(1),
    visitId: z.string().nullable().optional(),
  }).parse(req.body);

  try {
    const result = body.track === "defect"
      ? await generateCureCertificate(body)
      : await generateUpgradeRecord(body);
    res.status(201).json(result);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

/** The customer-signed side: a written record that work was offered and refused. */
healthRecordAdminRouter.post("/findings/declination-letter", asyncHandler(async (req, res) => {
  const body = z.object({
    propertyId: z.string().min(1),
    findingIds: z.array(z.string().min(1)).min(1),
    preparedBy: z.string().min(1),
  }).parse(req.body);

  try {
    const result = await generateFindingDeclination(body);
    res.status(201).json(result);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

// ─── JOB-SITE PHOTOS (CRM views) ────────────────────────────────────────────────

healthRecordAdminRouter.get("/visits/:visitId/photos", asyncHandler(async (req, res) => {
  const photos = await prisma.visitPhoto.findMany({
    where: { visitId: readParam(req, "visitId") },
    select: { id: true, mimeType: true, sizeBytes: true, caption: true, uploadedAt: true, technician: { select: { id: true, name: true } } },
    orderBy: { uploadedAt: "asc" },
  });
  res.json(photos);
}));

healthRecordAdminRouter.get("/visit-photos/:photoId", asyncHandler(async (req, res) => {
  const photo = await prisma.visitPhoto.findUnique({ where: { id: readParam(req, "photoId") } });
  if (!photo) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }
  res.setHeader("Content-Type", photo.mimeType);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.send(Buffer.from(photo.data));
}));

// ─── RECEIPT REVIEW QUEUE (CRM) ────────────────────────────────────────────────
// Receipts captured via tech PWA / MMS land in pending_review; the office
// confirms (possibly correcting vendor/amount/job) before they hit job costs.

healthRecordAdminRouter.get("/receipts", asyncHandler(async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const receipts = await prisma.receipt.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true, jobId: true, category: true, vendor: true, amount: true, lineItems: true,
      source: true, status: true, technicianId: true, imageMime: true, receivedAt: true, createdAt: true,
    },
  });
  // Attach tech names without dragging image bytes along
  const techIds = [...new Set(receipts.map((r) => r.technicianId).filter((id): id is string => id != null))];
  const techs = techIds.length > 0 ? await prisma.technician.findMany({ where: { id: { in: techIds } }, select: { id: true, name: true } }) : [];
  const techMap = new Map(techs.map((t) => [t.id, t.name]));
  res.json(receipts.map((r) => ({ ...r, technicianName: r.technicianId ? techMap.get(r.technicianId) ?? null : null })));
}));

healthRecordAdminRouter.get("/receipts/:id/image", asyncHandler(async (req, res) => {
  const receipt = await prisma.receipt.findUnique({
    where: { id: readParam(req, "id") },
    select: { imageData: true, imageMime: true },
  });
  if (!receipt || !receipt.imageData) {
    res.status(404).json({ error: "Receipt image not found" });
    return;
  }
  res.setHeader("Content-Type", receipt.imageMime ?? "image/jpeg");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.send(Buffer.from(receipt.imageData));
}));

healthRecordAdminRouter.patch("/receipts/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    jobId: z.string().nullable().optional(),
    category: z.enum(["materials", "gas", "maintenance", "overhead"]).optional(),
    vendor: z.string().nullable().optional(),
    amount: z.number().nonnegative().optional(),
    lineItems: z.unknown().optional(),
    status: z.enum(["pending_review", "confirmed"]).optional(),
  }).parse(req.body);

  const id = readParam(req, "id");
  const existing = await prisma.receipt.findUnique({ where: { id }, select: { id: true, jobId: true } });
  if (!existing) {
    res.status(404).json({ error: "Receipt not found" });
    return;
  }

  const receipt = await prisma.receipt.update({
    where: { id },
    data: {
      ...(body.jobId !== undefined ? { jobId: body.jobId } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.vendor !== undefined ? { vendor: body.vendor } : {}),
      ...(body.amount !== undefined ? { amount: body.amount } : {}),
      ...(body.lineItems !== undefined ? { lineItems: body.lineItems ? JSON.stringify(body.lineItems) : null } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    },
    select: { id: true, jobId: true, category: true, vendor: true, amount: true, status: true },
  });

  // Re-roll material cost for any job the receipt touched (old and new)
  const jobsToRoll = [...new Set([existing.jobId, receipt.jobId].filter((j): j is string => j != null))];
  for (const jobId of jobsToRoll) {
    const jobReceipts = await prisma.receipt.findMany({ where: { jobId, category: "materials", status: "confirmed" }, select: { amount: true } });
    const totalMaterials = jobReceipts.reduce((sum, r) => sum + r.amount, 0);
    await prisma.visit.update({ where: { id: jobId }, data: { actualMaterialCost: totalMaterials } }).catch(() => {});
  }

  res.json(receipt);
}));

healthRecordAdminRouter.use(zodErrorHandler);
