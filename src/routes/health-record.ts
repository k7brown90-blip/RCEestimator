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
import { techAvailabilityForDate } from "../services/techCalendars";
import { scheduleJob } from "../services/scheduling";
import { summarizeOptions } from "../services/atomicEstimateEngine";
import { graduateDraft } from "../services/issuedEstimateService";
import { addLine, browseAtomics, computeDraft, createDraft, editLine, loadRateContext, removeLine } from "../services/atomicEstimateService";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, readParam } from "./agent-helpers";
import { generateInspectionRenewalLeads } from "../services/inspectionRetention";
import {
  generateCureCertificate,
  generateFindingDeclination,
  generateGeneratorReport,
  generateHealthReport,
  generateUpgradeRecord,
} from "../services/pdfGenerator";
import { notifyTechnicianOfAssignment } from "../services/visitConfirmations";
import { sendHealthReportEmail } from "../services/healthReportEmail";
import { paymentSummary } from "../services/stripePayments";
import { logSystemEvent } from "../services/systemEvents";
import { sendKyleNotificationEmail } from "../services/confirmationEmail";
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
  // v3 = the consolidated nine-row walk (2026-08-26); the PDF renders the
  // glance per row instead of per fixed section group.
  schemaVersion: z.enum(["v1", "v2", "v3"]).default("v1"),
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
  /**
   * Revision (Kyle, 2026-09-01): the id of the inspection this push corrects.
   * The old row is marked superseded and the corrected report is automatically
   * re-sent to the customer if the original was ever delivered — "the customer
   * isn't left holding an inaccurate calculation."
   */
  revises: z.string().optional(),
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
    // The license holder's inspection IS the review (Kyle, 2026-08-25) — his
    // own records never sit in a false "pending" state. A tech without the
    // flag still needs the explicit review before a critical report ships.
    contractorReviewed: body.contractorReviewed || req.technician!.licenseHolder,
    ...(!body.contractorReviewed && req.technician!.licenseHolder
      ? { reviewedAt: new Date(), reviewedBy: req.technician!.name }
      : {}),
    itemsJson: JSON.stringify(body.items),
    loadCalcJson: body.loadCalc !== undefined ? JSON.stringify(body.loadCalc) : null,
    sectionNotesJson: body.sectionNotes !== undefined ? JSON.stringify(body.sectionNotes) : null,
    customerSignerName: body.acknowledgment?.signerName ?? null,
    customerSignatureImage: body.acknowledgment?.signatureImage ?? null,
    acknowledgedAt: body.acknowledgment ? new Date(body.acknowledgment.acknowledgedAt) : null,
    ackSkippedReason: body.acknowledgment ? null : body.ackSkippedReason ?? null,
    appVersion: body.appVersion ?? null,
  };

  // ── Revision guard: what this claims to revise must exist, at this address,
  // and not already be superseded by a DIFFERENT revision.
  let revised: { id: string; inspectionDate: Date; supersededById: string | null; deliveries: number } | null = null;
  if (body.revises) {
    const original = await prisma.healthInspection.findUnique({
      where: { id: body.revises },
      select: { id: true, propertyId: true, inspectionDate: true, supersededById: true, _count: { select: { deliveries: true } } },
    });
    if (!original || original.propertyId !== visit.propertyId) {
      res.status(422).json({ success: false, error: { code: "bad_revision", message: "The record this revises does not exist at this address." } });
      return;
    }
    if (original.supersededById && original.supersededById !== body.inspectionId) {
      res.status(409).json({ success: false, error: { code: "already_revised", message: "That record was already corrected by a newer revision — revise the latest instead." } });
      return;
    }
    revised = { id: original.id, inspectionDate: original.inspectionDate, supersededById: original.supersededById, deliveries: original._count.deliveries };
  }

  const inspection = await prisma.healthInspection.upsert({
    where: { id: body.inspectionId },
    create: { id: body.inspectionId, ...data, revisesId: body.revises ?? null },
    update: { ...data, revisesId: body.revises ?? null },
  });
  if (revised) {
    await prisma.healthInspection.update({ where: { id: revised.id }, data: { supersededById: inspection.id } });
  }

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

  /*
    THE CORRECTION GOES OUT (Kyle, 2026-09-01: "any change needs to be sent out and overwrite the
    original... the customer isn't left holding an inaccurate calculation"). If the record this
    revises was ever delivered, the corrected report — with the load-calc & generator sheet when
    the revision carries a calc — is emailed now, marked as replacing the dated original. A
    refusal (unreviewed critical, no address on file) is NOT silent: it rides the response and is
    logged as a warning, so the held report is a visible fact, never a quiet gap.
  */
  let resend: { sent: boolean; to?: string; reason?: string; skipped?: string } | null = null;
  if (revised) {
    if (revised.deliveries === 0) {
      resend = { sent: false, skipped: "The original was never emailed - nothing stale to replace. Send from the report screen when ready." };
    } else {
      const replacesDate = revised.inspectionDate.toLocaleDateString("en-US", { timeZone: "America/Chicago" });
      const sendResult = await sendHealthReportEmail(inspection.id, {
        sentBy: `tech:${req.technician!.id}`,
        includeGenerator: Boolean(body.loadCalc),
        corrected: { replacesDate },
      });
      resend = sendResult.sent
        ? { sent: true, to: sendResult.sentTo }
        : { sent: false, reason: sendResult.reason };
      if (!sendResult.sent) {
        logSystemEvent("warn", "health-record", `Corrected report ${inspection.id} was NOT re-sent: ${sendResult.reason}`, {
          inspectionId: inspection.id,
          revises: revised.id,
        });
      }
    }
  }

  res.status(201).json({
    success: true,
    data: { id: inspection.id, syncedAt: inspection.syncedAt.toISOString(), ledger, v2: v2Summary, resend },
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

  const emailBody = z.object({ includeGenerator: z.boolean().optional() }).parse(req.body ?? {});
  const result = await sendHealthReportEmail(inspectionId, {
    sentBy: `tech:${req.technician!.id}`,
    includeGenerator: emailBody.includeGenerator ?? false,
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
/*
  Bill in writing from the field (Kyle, 2026-09-01) — the same two emails the
  CRM's Take-payment panel sends: the deposit request and the final bill, each
  carrying the customer's durable pay link. Assignment-gated like every tech
  route; the tech can put the bill in the customer's inbox from the driveway
  without ever opening the customer's payment portal.
*/
healthRecordTechRouter.post("/visits/:visitId/email-payment-request", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({ kind: z.enum(["deposit", "balance"]) }).parse(req.body ?? {});
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId, technicianId: req.technician!.id },
    select: { id: true },
  });
  if (!assigned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return;
  }
  const est = await prisma.issuedEstimate.findFirst({
    where: { signedAt: { not: null }, status: { not: "void" }, OR: [{ jobVisitId: visitId }, { visitId }] },
    orderBy: { createdAt: "desc" },
    select: { id: true, customerEmail: true },
  });
  if (!est) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "No signed estimate on this visit yet — nothing to bill." } });
    return;
  }
  const { publicBaseUrl } = await import("../services/issuedEstimateSend");
  if (body.kind === "balance") {
    const { sendBalanceRequestEmail } = await import("../services/paymentReceipts");
    const result = await sendBalanceRequestEmail(prisma, est.id, publicBaseUrl());
    if (!result.ok) {
      res.status(400).json({ success: false, error: { code: "not_sent", message: result.reason } });
      return;
    }
    res.json({ success: true, data: result });
    return;
  }
  if (!est.customerEmail) {
    res.status(400).json({ success: false, error: { code: "not_sent", message: "No customer email on file — the office can add one to the account." } });
    return;
  }
  const { paymentSummary } = await import("../services/stripePayments");
  const summary = await paymentSummary(prisma, est.id, publicBaseUrl());
  if (!summary || summary.depositSatisfied || summary.paidInFull) {
    res.status(400).json({ success: false, error: { code: "not_sent", message: "The deposit on this job is already in." } });
    return;
  }
  const { sendDepositRequestEmail } = await import("../services/paymentReceipts");
  await sendDepositRequestEmail(prisma, est.id, publicBaseUrl());
  res.json({ success: true, data: { ok: true, to: est.customerEmail, amount: Math.round((summary.depositDue - summary.depositPaid) * 100) / 100 } });
}));


// ─── QUOTE IN THE FIELD (Kyle, 2026-09-01, ratified Option A) ────────────────
//
// "Step four build the quote for the service call and any issues found during
//  the electrical assessment." The tech builds on the SAME price book, engine
//  and gates as the CRM — these routes wrap the same services, never a second
//  pricing path. Every route is assignment-gated; lines added here are entered
//  by a human technician, so they are born CONFIRMED (confirmedBy tech:<id>),
//  exactly like Kyle's direct entry in the CRM.

/** The draft's visit must be assigned to this technician. */
async function quoteDraftForTech(draftId: string, technicianId: string) {
  const draft = await prisma.priceBookDraftEstimate.findUnique({
    where: { id: draftId },
    select: { id: true, visitId: true, status: true, customerId: true },
  });
  if (!draft || !draft.visitId) return null;
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId: draft.visitId, technicianId },
    select: { id: true },
  });
  return assigned ? draft : null;
}

/** Find-or-create the working draft for a visit — one quote per visit, resumable. */
healthRecordTechRouter.post("/visits/:visitId/quote", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId, technicianId: req.technician!.id },
    select: { id: true },
  });
  if (!assigned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return;
  }
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    select: { id: true, customerId: true, propertyId: true, customer: { select: { name: true } }, property: { select: { addressLine1: true } } },
  });
  if (!visit) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Visit not found" } });
    return;
  }
  const existing = await prisma.priceBookDraftEstimate.findFirst({
    where: { visitId, status: "draft" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (existing) {
    res.json({ success: true, data: { draftId: existing.id, resumed: true } });
    return;
  }
  const { rc } = await loadRateContext(prisma);
  const draft = await createDraft(prisma, {
    title: `${visit.customer.name} — ${visit.property.addressLine1}`,
    supplierId: rc.activeSupplier ?? "HD",
    visitId,
    jobDescription: null,
  });
  res.status(201).json({ success: true, data: { draftId: draft.id, resumed: false } });
}));

/** Catalog search for the picker — same browse the CRM uses, capped for a phone. */
healthRecordTechRouter.get("/quote-catalog", asyncHandler(async (req: TechRequest, res) => {
  const result = await browseAtomics(prisma, {
    search: typeof req.query.search === "string" ? req.query.search : null,
    category: typeof req.query.category === "string" ? req.query.category : null,
    limit: 30,
  });
  res.json({ success: true, data: result });
}));

/** The working quote: lines with live prices, per-option totals, gaps. */
healthRecordTechRouter.get("/quotes/:draftId", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const { computed, rate } = await computeDraft(prisma, draft.id);
  const rows = await prisma.priceBookDraftLine.findMany({
    where: { draftId: draft.id },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, itemId: true, quantity: true, quantitySource: true, difficulty: true, option: true, note: true, location: true },
  });
  const priced = new Map(computed.lines.map((l) => [l.id, l]));
  res.json({
    success: true,
    data: {
      draftId: draft.id,
      lines: rows.map((l) => {
        const c = priced.get(l.id);
        return {
          ...l,
          description: c?.description ?? l.itemId,
          laborHours: c?.laborHours ?? null,
          lineTotal: c ? Math.round(((c.laborDollars ?? 0) + (c.materialSell ?? 0)) * 100) / 100 : null,
          gaps: c?.gaps.map((g) => g.message) ?? [],
        };
      }),
      options: summarizeOptions(computed),
      total: computed.total,
      rateProvisional: rate.provisional,
    },
  });
}));

healthRecordTechRouter.post("/quotes/:draftId/lines", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const body = z.object({
    itemId: z.string().min(1),
    quantity: z.number().positive(),
    quantitySource: z.enum(["COUNT", "MEASURED_LENGTH", "TERMINATION_COUNT", "MANUAL"]).default("COUNT"),
    difficulty: z.enum(["NORMAL", "DIFFICULT", "VERY_DIFFICULT"]).default("NORMAL"),
    option: z.enum(["A", "B", "C"]).default("A"),
    note: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
  }).parse(req.body ?? {});
  const line = await addLine(prisma, draft.id, { ...body, confirmedBy: `tech:${req.technician!.id}` });
  res.status(201).json({ success: true, data: { lineId: line.id } });
}));

healthRecordTechRouter.patch("/quote-lines/:lineId", asyncHandler(async (req: TechRequest, res) => {
  const row = await prisma.priceBookDraftLine.findUnique({ where: { id: readParam(req, "lineId") }, select: { draftId: true } });
  const draft = row ? await quoteDraftForTech(row.draftId, req.technician!.id) : null;
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const body = z.object({
    quantity: z.number().positive().optional(),
    quantitySource: z.enum(["COUNT", "MEASURED_LENGTH", "TERMINATION_COUNT", "MANUAL"]).optional(),
    difficulty: z.enum(["NORMAL", "DIFFICULT", "VERY_DIFFICULT"]).optional(),
    option: z.enum(["A", "B", "C"]).optional(),
    note: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
  }).parse(req.body ?? {});
  try {
    await editLine(prisma, readParam(req, "lineId"), body);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: { code: "bad_request", message: err instanceof Error ? err.message : String(err) } });
  }
}));

healthRecordTechRouter.delete("/quote-lines/:lineId", asyncHandler(async (req: TechRequest, res) => {
  const row = await prisma.priceBookDraftLine.findUnique({ where: { id: readParam(req, "lineId") }, select: { draftId: true } });
  const draft = row ? await quoteDraftForTech(row.draftId, req.technician!.id) : null;
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  await removeLine(prisma, readParam(req, "lineId"));
  res.json({ success: true });
}));

/**
 * Issue from the driveway. Same graduation gate as the CRM (finalizeDraft —
 * unconfirmed lines, gaps and provisional rates all refuse with their real
 * reasons); account and address come from the visit, which is exactly "the
 * address that we are working at". Returns the customer-page link so the
 * customer signs on their own phone or the tech's, and payment follows.
 */
healthRecordTechRouter.post("/quotes/:draftId/issue", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const visit = await prisma.visit.findUnique({
    where: { id: draft.visitId! },
    select: { customerId: true, propertyId: true },
  });
  const result = await graduateDraft(prisma, {
    draftId: draft.id,
    accountId: visit!.customerId,
    serviceAddressId: visit!.propertyId,
    createdBy: `tech:${req.technician!.id}`,
  });
  if (!result.ok) {
    res.status(409).json({ success: false, error: { code: "not_ready", message: result.reasons.join(" ") }, reasons: result.reasons });
    return;
  }
  const est = await prisma.issuedEstimate.findUnique({ where: { id: result.estimateId }, select: { token: true } });
  const { publicBaseUrl } = await import("../services/issuedEstimateSend");
  res.status(201).json({
    success: true,
    data: {
      estimateId: result.estimateId,
      number: result.number,
      unpriced: result.unpriced ?? [],
      customerUrl: `${publicBaseUrl()}/e/${est!.token}`,
    },
  });
}));


// ─── SELF-SERVE VISITS & SCHEDULING FROM THE FIELD (Kyle, 2026-09-01, phase 5) ─
//
// "If scheduled for a later date. The job shows up on the techs schedule and is
//  available to clock into on that date/time (this needs to be flexible)." And
//  the ratified My-accounts option: the tech can START a service call at an
//  address they service, without waiting for the office to create the visit.
//  The office is notified of every self-created visit — self-serve, not silent.

healthRecordTechRouter.post("/properties/:propertyId/service-call", asyncHandler(async (req: TechRequest, res) => {
  const propertyId = readParam(req, "propertyId");
  const body = z.object({ purpose: z.string().trim().min(3).max(200) }).parse(req.body ?? {});
  if (!(await techServicedProperty(req.technician!.id, propertyId))) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "You have not serviced this property" } });
    return;
  }
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, customerId: true, addressLine1: true, city: true, customer: { select: { name: true } } },
  });
  if (!property) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Property not found" } });
    return;
  }
  const visit = await prisma.$transaction(async (tx) => {
    const created = await tx.visit.create({
      data: {
        customerId: property.customerId,
        propertyId: property.id,
        mode: "onsite",
        purpose: body.purpose,
        status: "estimate",
      },
    });
    await tx.visitAssignment.create({
      data: { visitId: created.id, technicianId: req.technician!.id, role: "lead", status: "assigned" },
    });
    return created;
  });
  logSystemEvent("info", "health-record", `Field-created service call at ${property.addressLine1} (${property.customer.name}) by ${req.technician!.name}: ${body.purpose}`, {
    visitId: visit.id, propertyId, technicianId: req.technician!.id,
  });
  sendKyleNotificationEmail(
    `Field service call: ${property.customer.name}`,
    `${req.technician!.name} opened a service call from the field.\n\nAccount: ${property.customer.name}\nAddress: ${property.addressLine1}, ${property.city}\nPurpose: ${body.purpose}\n\nIt is on their assignment list now; schedule or adjust it in the CRM if needed.`,
  ).catch(() => {});
  res.status(201).json({ success: true, data: { visitId: visit.id } });
}));

/** The tech's own free/busy for a candidate slot — so scheduling from the driveway isn't blind. */
healthRecordTechRouter.get("/schedule-availability", asyncHandler(async (req: TechRequest, res) => {
  const date = typeof req.query.date === "string" ? req.query.date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ success: false, error: { code: "bad_request", message: "date must be YYYY-MM-DD" } });
    return;
  }
  const techs = await techAvailabilityForDate(date);
  const mine = techs.find((t) => (t as { technicianId?: string }).technicianId === req.technician!.id) ?? null;
  res.json({ success: true, data: { date, me: mine, techs } });
}));

/**
 * Schedule (or reschedule) a visit from the field. The SAME scheduleJob the
 * CRM uses — deposit gate, calendar event, confirmation machinery — with this
 * technician on the booking. Gate refusals (unpaid deposit) return their real
 * wording; the tech collects the deposit and taps again.
 */
healthRecordTechRouter.post("/visits/:visitId/schedule", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  const body = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  }).parse(req.body ?? {});
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId, technicianId: req.technician!.id },
    select: { id: true },
  });
  if (!assigned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return;
  }
  try {
    await scheduleJob(visitId, body.date, body.time ?? null, req.technician!.id);
  } catch (err) {
    res.status(409).json({ success: false, error: { code: "not_scheduled", message: err instanceof Error ? err.message : String(err) } });
    return;
  }
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    select: { scheduledStart: true, scheduledEnd: true, status: true },
  });
  res.json({
    success: true,
    data: {
      scheduledStart: visit?.scheduledStart?.toISOString() ?? null,
      scheduledEnd: visit?.scheduledEnd?.toISOString() ?? null,
      status: visit?.status ?? null,
    },
  });
}));

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
 * GET /health-record/visits/:visitId/job-brief — what the tech needs on site
 * (Phase 2, Kyle 2026-08-25: the field app is "specific to getting the job
 * done"). The scope comes from the signed estimate's own lines — descriptions
 * and quantities, the options the customer took, NO labor hours (his standing
 * rule: hours never leave the office).
 */
healthRecordTechRouter.get("/visits/:visitId/job-brief", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId, technicianId: req.technician!.id },
    select: { id: true },
  });
  if (!assigned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return;
  }
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: {
      customer: { select: { name: true, phone: true } },
      property: { select: { addressLine1: true, city: true, state: true } },
    },
  });
  if (!visit) { res.status(404).json({ success: false, error: { code: "not_found", message: "Visit not found" } }); return; }

  const est = await prisma.issuedEstimate.findFirst({
    where: {
      signedAt: { not: null },
      status: { not: "void" },
      OR: [{ jobVisitId: visitId }, { visitId }],
    },
    orderBy: { createdAt: "desc" },
    include: { lines: { orderBy: { sortOrder: "asc" } } },
  });

  const taken = new Set(est?.selectedOptions ?? []);
  // The clock (Phase 5): total minutes banked plus the open punch, if any.
  const [openEntry, closedSum] = await Promise.all([
    prisma.timeEntry.findFirst({
      where: { visitId, technicianId: req.technician!.id, endedAt: null },
      orderBy: { startedAt: "desc" },
    }),
    prisma.timeEntry.aggregate({ where: { visitId, endedAt: { not: null } }, _sum: { minutes: true } }),
  ]);
  res.json({
    success: true,
    data: {
      laborMinutes: Math.round(closedSum._sum.minutes ?? 0),
      clockedInAt: openEntry?.startedAt.toISOString() ?? null,
      visitId: visit.id,
      status: visit.status,
      jobType: visit.jobType,
      purpose: visit.purpose,
      notes: visit.notes,
      scheduledStart: visit.scheduledStart?.toISOString() ?? null,
      scheduledEnd: visit.scheduledEnd?.toISOString() ?? null,
      completedAt: visit.completedAt?.toISOString() ?? null,
      customerName: visit.customer.name,
      customerPhone: visit.customer.phone,
      address: `${visit.property.addressLine1}, ${visit.property.city}, ${visit.property.state}`,
      estimate: est
        ? {
          number: est.number,
          title: est.title,
          scopeText: est.scopeText,
          // Taken options only, when a choice was made — the tech works what was bought.
          lines: est.lines
            .filter((l) => taken.size === 0 || taken.has(l.option))
            .map((l) => ({ description: l.description, quantity: l.quantity, option: l.option })),
        }
        : null,
    },
  });
}));

/**
 * The time clock (Phase 5). Kyle: "we need to have a time stamp for labor
 * tracking with a clock in button too." One open punch per tech per visit;
 * clock-out closes it and rolls the visit's total into Visit.laborHours —
 * which is exactly what job profitability's labor line reads.
 */
healthRecordTechRouter.post("/visits/:visitId/clock-in", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId, technicianId: req.technician!.id },
    select: { id: true },
  });
  if (!assigned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return;
  }
  const open = await prisma.timeEntry.findFirst({
    where: { visitId, technicianId: req.technician!.id, endedAt: null },
  });
  if (open) {
    res.status(409).json({ success: false, error: { code: "conflict", message: `Already clocked in since ${open.startedAt.toISOString()}` } });
    return;
  }
  const entry = await prisma.timeEntry.create({
    data: { visitId, technicianId: req.technician!.id },
  });
  res.status(201).json({ success: true, data: { clockedInAt: entry.startedAt.toISOString() } });
}));

healthRecordTechRouter.post("/visits/:visitId/clock-out", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  const open = await prisma.timeEntry.findFirst({
    where: { visitId, technicianId: req.technician!.id, endedAt: null },
    orderBy: { startedAt: "desc" },
  });
  if (!open) {
    res.status(409).json({ success: false, error: { code: "conflict", message: "Not clocked in on this visit." } });
    return;
  }
  const endedAt = new Date();
  const minutes = Math.max(1, Math.round((endedAt.getTime() - open.startedAt.getTime()) / 60_000));
  await prisma.timeEntry.update({ where: { id: open.id }, data: { endedAt, minutes } });
  const total = await prisma.timeEntry.aggregate({
    where: { visitId, endedAt: { not: null } },
    _sum: { minutes: true },
  });
  const laborHours = Math.round(((total._sum.minutes ?? 0) / 60) * 100) / 100;
  await prisma.visit.update({ where: { id: visitId }, data: { laborHours } });
  res.json({ success: true, data: { minutes, laborMinutes: Math.round(total._sum.minutes ?? 0), laborHours } });
}));

/**
 * POST /health-record/visits/:visitId/complete — the driveway close-out
 * (Phase 2). No gate, warnings only (Kyle: "We do not want to lock ourselves
 * out of closing a job"). The office is notified — closing is what tells the
 * admin side to schedule whatever comes next.
 */
healthRecordTechRouter.post("/visits/:visitId/complete", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId, technicianId: req.technician!.id },
    select: { id: true },
  });
  if (!assigned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return;
  }
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: {
      materialOrders: { select: { id: true } },
      customer: { select: { name: true } },
      property: { select: { addressLine1: true, city: true } },
    },
  });
  if (!visit) { res.status(404).json({ success: false, error: { code: "not_found", message: "Visit not found" } }); return; }
  if (visit.status === "cancelled") {
    res.status(409).json({ success: false, error: { code: "conflict", message: "This job was cancelled." } });
    return;
  }
  if (visit.status === "estimate") {
    res.status(409).json({
      success: false,
      error: { code: "conflict", message: "This is an estimate visit — it wraps up by submitting the assessment, not by closing a job." },
    });
    return;
  }

  const receipts = await prisma.receipt.count({ where: { jobId: visitId } });
  const warnings: string[] = [];
  if (visit.materialOrders.length > 0 && receipts === 0) {
    warnings.push(`${visit.materialOrders.length} purchase order(s) and no receipts on this job yet.`);
  }

  await prisma.visit.update({
    where: { id: visitId },
    data: { status: "completed", completedAt: new Date() },
  });
  await prisma.visitAssignment.updateMany({
    where: { visitId, technicianId: req.technician!.id, status: { not: "completed" } },
    data: { status: "completed", completedAt: new Date() },
  });

  const label = `${visit.customer.name} — ${visit.property.addressLine1}, ${visit.property.city}`;
  logSystemEvent("info", "jobs", `Job closed from the field: ${label}`, {
    visitId,
    technician: req.technician!.name,
    warnings,
  });
  // The handoff (Kyle: "admin then schedules an estimate or install once that
  // job is closed out") — the office hears about it the moment it happens.
  sendKyleNotificationEmail(
    `Job closed from the field: ${visit.customer.name}`,
    [
      `${label}`,
      `Closed by: ${req.technician!.name}`,
      `Job: ${visit.jobType ?? visit.purpose ?? "service work"}`,
      ...(warnings.length > 0 ? ["", "Heads up:", ...warnings.map((w) => `- ${w}`)] : []),
      "",
      "Schedule the next step (install / follow-up estimate) from the CRM.",
    ].join("\n"),
  ).catch(() => {});

  res.json({ success: true, data: { completed: true, warnings } });
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
/** True when this technician has a real history at the address — an assignment or an inspection. */
async function techServicedProperty(technicianId: string, propertyId: string): Promise<boolean> {
  const assigned = await prisma.visitAssignment.findFirst({
    where: { technicianId, visit: { propertyId } },
    select: { id: true },
  });
  if (assigned) return true;
  const inspected = await prisma.healthInspection.findFirst({
    where: { technicianId, propertyId },
    select: { id: true },
  });
  return Boolean(inspected);
}

/**
 * GET /health-record/my-properties — the accounts this technician services
 * (Kyle, 2026-09-01: "The tech needs to assess accounts that they service").
 * Sourced from the tech's OWN assignments and inspections — never a directory
 * of every customer. Newest activity first.
 */
healthRecordTechRouter.get("/my-properties", asyncHandler(async (req: TechRequest, res) => {
  const techId = req.technician!.id;
  const [assignments, inspections] = await Promise.all([
    prisma.visitAssignment.findMany({
      where: { technicianId: techId },
      select: { visit: { select: { propertyId: true, visitDate: true, scheduledStart: true } } },
    }),
    prisma.healthInspection.findMany({
      where: { technicianId: techId },
      select: { propertyId: true, inspectionDate: true },
    }),
  ]);
  const lastSeen = new Map<string, number>();
  const note = (propertyId: string, at: Date | null) => {
    const t = at ? at.getTime() : 0;
    if (t > (lastSeen.get(propertyId) ?? 0)) lastSeen.set(propertyId, t);
  };
  for (const a of assignments) note(a.visit.propertyId, a.visit.scheduledStart ?? a.visit.visitDate);
  for (const i of inspections) note(i.propertyId, i.inspectionDate);
  const ids = [...lastSeen.keys()];
  if (ids.length === 0) { res.json({ success: true, data: [] }); return; }

  const [properties, findingCounts, latestInspections] = await Promise.all([
    prisma.property.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, name: true, addressLine1: true, city: true, state: true, postalCode: true,
        customer: { select: { id: true, name: true } },
      },
    }),
    prisma.propertyFinding.groupBy({
      by: ["propertyId"],
      where: { propertyId: { in: ids }, status: { in: ["open", "scheduled"] } },
      _count: { _all: true },
    }),
    prisma.healthInspection.findMany({
      where: { propertyId: { in: ids } },
      orderBy: { inspectionDate: "desc" },
      select: { id: true, propertyId: true, inspectionDate: true, score: true, loadCalcJson: true },
    }),
  ]);
  const openByProperty = new Map(findingCounts.map((f) => [f.propertyId, f._count._all]));
  const latestByProperty = new Map<string, (typeof latestInspections)[number]>();
  for (const insp of latestInspections) if (!latestByProperty.has(insp.propertyId)) latestByProperty.set(insp.propertyId, insp);

  const rows = properties
    .map((p) => {
      const latest = latestByProperty.get(p.id) ?? null;
      return {
        propertyId: p.id,
        name: p.name,
        customerName: p.customer.name,
        address: { line1: p.addressLine1, city: p.city, state: p.state, postalCode: p.postalCode },
        lastServicedAt: lastSeen.get(p.id) ? new Date(lastSeen.get(p.id)!).toISOString() : null,
        openFindingCount: openByProperty.get(p.id) ?? 0,
        latestInspection: latest
          ? { id: latest.id, date: latest.inspectionDate.toISOString(), score: latest.score, hasLoadCalc: Boolean(latest.loadCalcJson) }
          : null,
      };
    })
    .sort((a, b) => (b.lastServicedAt ?? "").localeCompare(a.lastServicedAt ?? ""));
  res.json({ success: true, data: rows });
}));

/**
 * GET /health-record/properties/:propertyId/history — one serviced address in
 * full: every assessment (newest first) with its counts and whether it carries
 * a load calc, so the tech standing at a repeat address knows what was said
 * before. Findings ride the existing findings route.
 */
healthRecordTechRouter.get("/properties/:propertyId/history", asyncHandler(async (req: TechRequest, res) => {
  const propertyId = readParam(req, "propertyId");
  if (!(await techServicedProperty(req.technician!.id, propertyId))) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "You have not serviced this property" } });
    return;
  }
  const [property, inspections] = await Promise.all([
    prisma.property.findUnique({
      where: { id: propertyId },
      select: {
        id: true, name: true, addressLine1: true, city: true, state: true, postalCode: true, jurisdictionId: true,
        customer: { select: { id: true, name: true, email: true, phone: true } },
      },
    }),
    prisma.healthInspection.findMany({
      where: { propertyId },
      orderBy: { inspectionDate: "desc" },
      select: {
        id: true, inspectionDate: true, score: true, scope: true, schemaVersion: true,
        itemsAssessed: true, failCount: true, monitorCount: true, passCount: true,
        contractorReviewed: true, loadCalcJson: true, technicianId: true,
        revisesId: true, supersededById: true,
        technician: { select: { name: true } },
      },
    }),
  ]);
  if (!property) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Property not found" } });
    return;
  }
  res.json({
    success: true,
    data: {
      property: {
        id: property.id, name: property.name,
        address: { line1: property.addressLine1, city: property.city, state: property.state, postalCode: property.postalCode },
        jurisdictionId: property.jurisdictionId,
        customer: property.customer,
      },
      inspections: inspections.map((i) => ({
        id: i.id,
        date: i.inspectionDate.toISOString(),
        score: i.score,
        scope: i.scope,
        schemaVersion: i.schemaVersion,
        itemsAssessed: i.itemsAssessed,
        failCount: i.failCount,
        monitorCount: i.monitorCount,
        passCount: i.passCount,
        contractorReviewed: i.contractorReviewed,
        hasLoadCalc: Boolean(i.loadCalcJson),
        technicianName: i.technician?.name ?? null,
        mine: i.technicianId === req.technician!.id,
        revisesId: i.revisesId,
        supersededById: i.supersededById,
      })),
    },
  });
}));

/**
 * GET /health-record/inspections/:id/full — everything the field app needs to
 * REOPEN an assessment pre-filled (the revision flow, Kyle 2026-09-01). Gated
 * to techs who serviced the address, like the rest of My accounts.
 */
healthRecordTechRouter.get("/inspections/:id/full", asyncHandler(async (req: TechRequest, res) => {
  const id = readParam(req, "id");
  const inspection = await prisma.healthInspection.findUnique({
    where: { id },
    select: {
      id: true, visitId: true, propertyId: true, customerId: true, jurisdictionId: true,
      inspectionDate: true, scope: true, itemsJson: true, loadCalcJson: true,
      sectionNotesJson: true, supersededById: true,
      customer: { select: { name: true } },
      property: { select: { addressLine1: true, city: true, state: true, postalCode: true } },
    },
  });
  if (!inspection) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Inspection not found" } });
    return;
  }
  if (!(await techServicedProperty(req.technician!.id, inspection.propertyId))) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "You have not serviced this property" } });
    return;
  }
  const parse = (v: string | null) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
  res.json({
    success: true,
    data: {
      id: inspection.id,
      visitId: inspection.visitId,
      propertyId: inspection.propertyId,
      customerId: inspection.customerId,
      customerName: inspection.customer.name,
      jurisdictionId: inspection.jurisdictionId,
      date: inspection.inspectionDate.toISOString(),
      scope: inspection.scope,
      address: `${inspection.property.addressLine1}, ${inspection.property.city}, ${inspection.property.state} ${inspection.property.postalCode}`,
      items: parse(inspection.itemsJson) ?? [],
      loadCalc: parse(inspection.loadCalcJson),
      sectionNotes: parse(inspection.sectionNotesJson) ?? [],
      supersededById: inspection.supersededById,
    },
  });
}));

healthRecordTechRouter.get("/properties/:propertyId/findings", asyncHandler(async (req: TechRequest, res) => {
  const propertyId = readParam(req, "propertyId");
  // Scoped to the technician's own history — the field app has no business
  // enumerating findings at an address nobody sent this person to. Serviced =
  // assigned there, or inspected it (My accounts, 2026-09-01).
  if (!(await techServicedProperty(req.technician!.id, propertyId))) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "You have not serviced this property" } });
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
  // Swapped for a `hasLoadCalc` boolean by summarizeInspections before any
  // response — the generator-sizing button unlocks on it (Kyle, 2026-08-28).
  loadCalcJson: true,
  property: { select: { id: true, addressLine1: true, city: true, state: true } },
  deliveries: {
    orderBy: { sentAt: "desc" as const },
    select: { id: true, sentTo: true, sentBy: true, sentAt: true },
  },
} as const;

/**
 * The summary rows carry `hasLoadCalc`, not the calculation itself — the CRM
 * lists only need to know whether the generator-sizing button unlocks (Kyle,
 * 2026-08-28), and shipping every list row a 10 KB JSON blob to answer a
 * boolean would be waste.
 */
const summarizeInspections = (
  rows: Array<{ loadCalcJson: string | null } & Record<string, unknown>>,
) => rows.map(({ loadCalcJson, ...rest }) => ({ ...rest, hasLoadCalc: loadCalcJson != null }));

/** Inspection history for a customer (newest first) — the retention record. */
healthRecordAdminRouter.get("/customers/:customerId/inspections", asyncHandler(async (req, res) => {
  const inspections = await prisma.healthInspection.findMany({
    where: { customerId: readParam(req, "customerId") },
    select: inspectionSummary,
    orderBy: { inspectionDate: "desc" },
  });
  res.json(summarizeInspections(inspections));
}));

healthRecordAdminRouter.get("/properties/:propertyId/inspections", asyncHandler(async (req, res) => {
  const inspections = await prisma.healthInspection.findMany({
    where: { propertyId: readParam(req, "propertyId") },
    select: inspectionSummary,
    orderBy: { inspectionDate: "desc" },
  });
  res.json(summarizeInspections(inspections));
}));

healthRecordAdminRouter.get("/visits/:visitId/inspections", asyncHandler(async (req, res) => {
  const inspections = await prisma.healthInspection.findMany({
    where: { visitId: readParam(req, "visitId") },
    select: inspectionSummary,
    orderBy: { inspectionDate: "desc" },
  });
  res.json(summarizeInspections(inspections));
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
 * GET /health-record-admin/inspections/:id/load-calc — the stored A2 load
 * calculation + generator design, for the CRM's generator designer (Kyle,
 * 2026-08-31: "bring up past reports to edit or review to design the
 * generator system").
 */
healthRecordAdminRouter.get("/inspections/:id/load-calc", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const inspection = await prisma.healthInspection.findUnique({
    where: { id },
    select: { id: true, loadCalcJson: true },
  });
  if (!inspection) {
    res.status(404).json({ error: "Inspection not found" });
    return;
  }
  if (!inspection.loadCalcJson) {
    res.status(409).json({ error: "This inspection has no load calculation — run the A2 load calc first." });
    return;
  }
  const stored = JSON.parse(inspection.loadCalcJson) as { input: unknown; result: unknown; generator?: unknown };
  res.json({ input: stored.input, result: stored.result, generator: stored.generator ?? null });
}));

/**
 * PUT /health-record-admin/inspections/:id/generator — save a generator design
 * from the CRM designer. The recommendation is recomputed SERVER-SIDE from the
 * stored calculation with the submitted settings — one engine, no drift; the
 * client never writes the numbers the data sheet will print. Mirrors to the
 * capacityCheck row exactly as the PDF path does, so the estimate attachment
 * stays in step.
 */

/**
 * PUT /health-record-admin/inspections/:id/load-calc — correct the A2 inputs
 * from the office (Kyle, 2026-09-01: fix an appliance or nameplate typo with
 * no truck roll). The result is recomputed by the SAME shared engine, the
 * stored generator design (if any) is recomputed against the corrected calc,
 * and Kyle's overwrite ruling applies: this creates a REVISION inspection,
 * supersedes the original, and re-sends the corrected report when the
 * original was ever delivered. History is never rewritten.
 */
healthRecordAdminRouter.put("/inspections/:id/load-calc", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const body = z.object({
    serviceAmps: z.number().positive(),
    floorAreaSqFt: z.number().nonnegative(),
    // The load list rides as-is: the shared engine's resolveVA is the authority
    // on each item's fields, and re-validating its union here would just drift.
    loads: z.array(z.record(z.string(), z.unknown())),
  }).parse(req.body ?? {});

  const original = await prisma.healthInspection.findUnique({ where: { id } });
  if (!original) { res.status(404).json({ error: "Inspection not found" }); return; }
  if (!original.loadCalcJson) {
    res.status(409).json({ error: "This inspection has no load calculation — run the A2 load calc first." });
    return;
  }
  if (original.supersededById) {
    res.status(409).json({ error: "This record was already corrected by a newer revision — edit the latest instead." });
    return;
  }

  const { calculateLoad } = await import("../../shared/loadcalc/loadcalc");
  const { recommendGenerator } = await import("../../shared/loadcalc/generator");
  const stored = JSON.parse(original.loadCalcJson) as {
    input: import("../../shared/loadcalc/loadcalc").LoadCalcInput;
    result: import("../../shared/loadcalc/loadcalc").LoadCalcResult;
    generator?: {
      fuel: import("../../shared/loadcalc/generator").GeneratorFuel;
      softStart: boolean; altitudeSteps: number; includeInEstimate: boolean;
      shedSelection?: string[];
    };
  };
  const correctedInput: import("../../shared/loadcalc/loadcalc").LoadCalcInput = {
    ...stored.input,
    serviceAmps: body.serviceAmps,
    floorAreaSqFt: body.floorAreaSqFt,
    loads: body.loads as unknown as import("../../shared/loadcalc/loadcalc").LoadCalcInput["loads"],
  };
  let correctedResult: import("../../shared/loadcalc/loadcalc").LoadCalcResult;
  try {
    correctedResult = calculateLoad(correctedInput);
  } catch (err) {
    res.status(422).json({ error: `The corrected inputs do not compute: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  const correctedLoadCalc: Record<string, unknown> = { ...stored, input: correctedInput, result: correctedResult };
  if (stored.generator) {
    correctedLoadCalc["generator"] = {
      ...stored.generator,
      recommendation: recommendGenerator({
        calcInput: correctedInput,
        calcResult: correctedResult,
        fuel: stored.generator.fuel,
        softStart: stored.generator.softStart,
        site: { altitudeSteps: stored.generator.altitudeSteps },
        shedSelection: stored.generator.shedSelection,
      }),
    };
  }

  // The revision row: the original inspection with the corrected calc. Same
  // linkage the field's Revise flow writes, so every surface reads one chain.
  const revisionId = randomUUID();
  const deliveries = await prisma.healthReportDelivery.count({ where: { inspectionId: id } });
  await prisma.$transaction(async (tx) => {
    const src = original as unknown as Record<string, unknown>;
    const clone: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) {
      if (["id", "syncedAt", "revisesId", "supersededById"].includes(k)) continue;
      clone[k] = v;
    }
    await tx.healthInspection.create({
      data: { ...(clone as object), id: revisionId, revisesId: id, loadCalcJson: JSON.stringify(correctedLoadCalc) } as never,
    });
    await tx.healthInspection.update({ where: { id }, data: { supersededById: revisionId } });
  });
  await recordInspectionLoadCalc({
    inspectionId: revisionId,
    visitId: original.visitId,
    propertyId: original.propertyId,
    customerId: original.customerId,
    technicianId: original.technicianId,
    loadCalc: correctedLoadCalc,
  });
  logSystemEvent("info", "health-record", `Load calc corrected from the CRM — revision ${revisionId} supersedes ${id}`, {
    inspectionId: revisionId, revises: id,
  });

  // Kyle's overwrite ruling: the correction goes OUT. Held sends are visible.
  let resend: { sent: boolean; to?: string; reason?: string; skipped?: string };
  if (deliveries === 0) {
    resend = { sent: false, skipped: "The original was never emailed - nothing stale to replace." };
  } else {
    const replacesDate = original.inspectionDate.toLocaleDateString("en-US", { timeZone: "America/Chicago" });
    const sendResult = await sendHealthReportEmail(revisionId, {
      sentBy: "owner:crm",
      includeGenerator: true,
      corrected: { replacesDate },
    });
    resend = sendResult.sent ? { sent: true, to: sendResult.sentTo } : { sent: false, reason: sendResult.reason };
    if (!sendResult.sent) {
      logSystemEvent("warn", "health-record", `Corrected report ${revisionId} was NOT re-sent: ${sendResult.reason}`, {
        inspectionId: revisionId, revises: id,
      });
    }
  }
  res.json({ inspectionId: revisionId, resend });
}));

healthRecordAdminRouter.put("/inspections/:id/generator", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const body = z.object({
    fuel: z.enum(["NG", "LP"]),
    softStart: z.boolean(),
    altitudeSteps: z.number().nonnegative(),
    includeInEstimate: z.boolean(),
    shedSelection: z.array(z.string()).optional(),
  }).parse(req.body ?? {});
  const inspection = await prisma.healthInspection.findUnique({
    where: { id },
    select: { id: true, loadCalcJson: true },
  });
  if (!inspection) {
    res.status(404).json({ error: "Inspection not found" });
    return;
  }
  if (!inspection.loadCalcJson) {
    res.status(409).json({ error: "This inspection has no load calculation — run the A2 load calc first." });
    return;
  }
  const { recommendGenerator } = await import("../../shared/loadcalc/generator");
  const stored = JSON.parse(inspection.loadCalcJson) as {
    input: import("../../shared/loadcalc/loadcalc").LoadCalcInput;
    result: import("../../shared/loadcalc/loadcalc").LoadCalcResult;
  };
  const generator = {
    recommendation: recommendGenerator({
      calcInput: stored.input,
      calcResult: stored.result,
      fuel: body.fuel,
      softStart: body.softStart,
      site: { altitudeSteps: body.altitudeSteps },
      shedSelection: body.shedSelection,
    }),
    fuel: body.fuel,
    softStart: body.softStart,
    altitudeSteps: body.altitudeSteps,
    includeInEstimate: body.includeInEstimate,
    shedSelection: body.shedSelection,
  };
  await prisma.healthInspection.update({
    where: { id },
    data: { loadCalcJson: JSON.stringify({ ...stored, generator }) },
  });
  await prisma.capacityCheck.updateMany({
    where: { sourceInspectionId: id },
    data: { generatorJson: JSON.stringify(generator) },
  });
  res.json({ ok: true });
}));

/**
 * POST /health-record-admin/inspections/:id/generator-report — the P031
 * generator sizing document off this inspection's load calculation (Kyle,
 * 2026-08-28: "a button... that becomes available after the load calcs are
 * done"). Refuses plainly when no calculation is stored.
 */
healthRecordAdminRouter.post("/inspections/:id/generator-report", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const inspection = await prisma.healthInspection.findUnique({
    where: { id },
    select: { id: true, loadCalcJson: true },
  });
  if (!inspection) {
    res.status(404).json({ error: "Inspection not found" });
    return;
  }
  if (!inspection.loadCalcJson) {
    res.status(409).json({ error: "This inspection has no load calculation — run the A2 load calc first." });
    return;
  }
  const result = await generateGeneratorReport(id);
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

// ─── JOB-SITE PHOTOS (CRM views + gallery, Kyle 2026-08-28) ────────────────────
// The photo gallery replaced the legacy estimate tabs on the visit page:
// before/after job photos, assessment photos, and the historical record at an
// address — and photos can ride the estimate and invoice emails.

const PHOTO_TAGS = ["before", "after", "assessment", "reference"] as const;

healthRecordAdminRouter.get("/visits/:visitId/photos", asyncHandler(async (req, res) => {
  const photos = await prisma.visitPhoto.findMany({
    where: { visitId: readParam(req, "visitId") },
    select: { id: true, mimeType: true, sizeBytes: true, caption: true, tag: true, uploadedAt: true, technician: { select: { id: true, name: true } } },
    orderBy: { uploadedAt: "asc" },
  });
  res.json(photos);
}));

// Upload from the CRM. Same dataUrl convention as the price-book walkthrough
// photos; bytes live in the DB and go nowhere else.
healthRecordAdminRouter.post("/visits/:visitId/photos", asyncHandler(async (req, res) => {
  const body = z.object({
    dataUrl: z.string().min(1),
    caption: z.string().trim().max(500).nullable().optional(),
    tag: z.enum(PHOTO_TAGS).nullable().optional(),
  }).parse(req.body ?? {});
  const visitId = readParam(req, "visitId");
  const visit = await prisma.visit.findUnique({ where: { id: visitId }, select: { id: true } });
  if (!visit) {
    res.status(404).json({ error: "Visit not found" });
    return;
  }
  const match = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(body.dataUrl);
  if (!match) {
    res.status(400).json({ error: "Expected a base64 image data URL." });
    return;
  }
  const data = Buffer.from(match[2], "base64");
  if (data.length > 10 * 1024 * 1024) {
    res.status(413).json({ error: "Photo exceeds the 10 MB limit." });
    return;
  }
  const photo = await prisma.visitPhoto.create({
    data: {
      id: crypto.randomUUID(),
      visitId,
      technicianId: null, // CRM upload — not a field sync
      mimeType: match[1],
      sizeBytes: data.length,
      caption: body.caption ?? null,
      tag: body.tag ?? null,
      data,
    },
    select: { id: true, mimeType: true, sizeBytes: true, caption: true, tag: true, uploadedAt: true },
  });
  res.status(201).json(photo);
}));

healthRecordAdminRouter.patch("/visit-photos/:photoId", asyncHandler(async (req, res) => {
  const body = z.object({
    caption: z.string().trim().max(500).nullable().optional(),
    tag: z.enum(PHOTO_TAGS).nullable().optional(),
  }).parse(req.body ?? {});
  const photo = await prisma.visitPhoto.update({
    where: { id: readParam(req, "photoId") },
    data: {
      ...(body.caption !== undefined ? { caption: body.caption } : {}),
      ...(body.tag !== undefined ? { tag: body.tag } : {}),
    },
    select: { id: true, caption: true, tag: true },
  });
  res.json(photo);
}));

healthRecordAdminRouter.delete("/visit-photos/:photoId", asyncHandler(async (req, res) => {
  await prisma.visitPhoto.delete({ where: { id: readParam(req, "photoId") } });
  res.json({ deleted: true });
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

/**
 * Every photo ever taken at an address — job photos across all visits plus the
 * assessment photos on its Health Records. The historical reference Kyle asked
 * for: metadata only; bytes come one at a time through the byte routes.
 */
healthRecordAdminRouter.get("/properties/:propertyId/photos", asyncHandler(async (req, res) => {
  const propertyId = readParam(req, "propertyId");
  const [visitPhotos, inspectionPhotos] = await Promise.all([
    prisma.visitPhoto.findMany({
      where: { visit: { propertyId } },
      select: {
        id: true, mimeType: true, sizeBytes: true, caption: true, tag: true, uploadedAt: true,
        visit: { select: { id: true, visitDate: true, purpose: true, jobType: true } },
      },
      orderBy: { uploadedAt: "desc" },
    }),
    prisma.inspectionPhoto.findMany({
      where: { inspection: { propertyId } },
      select: {
        id: true, mimeType: true, sizeBytes: true, uploadedAt: true,
        inspection: { select: { id: true, inspectionDate: true, visitId: true } },
      },
      orderBy: { uploadedAt: "desc" },
    }),
  ]);
  res.json({
    jobPhotos: visitPhotos.map((p) => ({
      id: p.id, mimeType: p.mimeType, sizeBytes: p.sizeBytes, caption: p.caption, tag: p.tag,
      uploadedAt: p.uploadedAt, visitId: p.visit.id, visitDate: p.visit.visitDate,
      purpose: p.visit.purpose, jobType: p.visit.jobType,
    })),
    assessmentPhotos: inspectionPhotos.map((p) => ({
      id: p.id, mimeType: p.mimeType, sizeBytes: p.sizeBytes, uploadedAt: p.uploadedAt,
      inspectionId: p.inspection.id, inspectionDate: p.inspection.inspectionDate,
      visitId: p.inspection.visitId,
    })),
  });
}));

healthRecordAdminRouter.get("/inspection-photos/:photoId", asyncHandler(async (req, res) => {
  const photo = await prisma.inspectionPhoto.findUnique({ where: { id: readParam(req, "photoId") } });
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
