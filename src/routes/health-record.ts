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
import { summarizeOptions } from "../services/atomicEstimateEngine";
import { ALL_OPTIONS, isEstimateOption } from "../../shared/estimateOptions";
import { SameDayError, completeWorkNow, fieldChoicePending, pauseJobForLater, scheduleForLater } from "../services/sameDayJob";
import { getDraftLifecycle, issueDraft, issueExtrasBodySchema, raiseChangeOrderForVisit } from "../services/issuedEstimateService";
import { fileSignatureEvent, inPersonSignBodySchema, signInPerson, signatureEventBodySchema, signerContextOf } from "../services/inPersonSigning";
import { PhotoError, jobPhotoPreview, listJobPhotos, removeOwnVisitPhoto } from "../services/estimatePhotos";
import { jobChainOfVisits } from "../services/jobCosting";
import { MAX_ESTIMATE_PHOTOS } from "../../shared/estimatePhotos";
import { DraftError, addLine, addOption, browseFieldCatalog, browseSections, computeDraft, confirmLineBodySchema, confirmProposedLine, copyOptionBodySchema, copyOptionLines, deleteDraft, draftDetailsBodySchema, draftDiscountBodySchema, duplicateDraft, editLine, editLineExpectedSchema, expectedLinesSchema, fieldCatalogSnapshot, getDraftOptionSet, getDraftSuggestions, lineCustomNameSchema, lineOrderBodySchema, lineQuantitySchema, openOrCreateWorkingDraft, optionMetaBodySchema, optionsModeBodySchema, rejectProposedLine, removeLine, removeOption, resolveQuestion, resolveQuestionBodySchema, saveLineOrder, setDraftDetails, setDraftDiscount, setOptionMeta, setOptionsMode, workingDraftForVisit } from "../services/atomicEstimateService";
import { proposeWalkthroughForDraft, walkthroughTextBodySchema } from "../services/aiProposer";
import { resolveWalkthroughRows, walkthroughRowsBodySchema } from "../services/walkthroughMatch";
import { frozenStyleSubtotal, getQuoteMoney } from "../services/quoteMoney";
import { buildPhonePriceSheet } from "../services/fieldPriceSheet";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import {
  PO_LIST_INCLUDE, PO_PURPOSES, addPurchaseOrderLine, attachReceiptToPurchaseOrder, createPurchaseOrder, detachReceiptFromPurchaseOrder,
  serializePurchaseOrder, transitionPurchaseOrder, truckIdForTechnician,
} from "../services/purchaseOrders";
import {
  WAREHOUSE_KEY, createStockRequest, landPurchaseOrder, landingDefaults, listTools, moveTool, searchItems, serializeLevel, supplierReturnStock, truckLocationKey,
} from "../services/inventory";
import { closeOutMaterialWarning, consumeForJob, jobMaterials, returnForJob } from "../services/jobMaterials";
import { createMaterial, listMaterials } from "../services/materials";
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
import { COVERAGE_VALUES, DEVICE_TYPES, DIFFICULTY_TIERS } from "../../shared/diagnostics";
import {
  DiagnosticError,
  REPORT_INCLUDE,
  buildResolutionsChangeOrder,
  deleteDiagnosticReport,
  diagnosticQuoteContext,
  loadDiagnosticReport,
  pushDiagnosticReport,
  serializeDiagnosticReport,
  voidDiagnosticReport,
} from "../services/diagnosticReport";
import { sendDiagnosticReportEmail } from "../services/diagnosticReportEmail";
import { paymentSummary } from "../services/stripePayments";
import { FINANCING_IN_PROGRESS, financingBlockedReason, financingInProgress } from "../services/financingFee";
import { LIVE_SIGNED_CHANGE_ORDER, signedRootForJob } from "../services/invoiceGroup";
import { logSystemEvent } from "../services/systemEvents";
import { sendKyleNotificationEmail } from "../services/confirmationEmail";
import { resolveJurisdictions } from "../services/jurisdictionResolver";
import { technicianAuth, zodErrorHandler, type TechRequest } from "./technicianAuth";
// Two clocks, kept separate (Kyle, 2026-09-11): shift = payroll, job = job time.
import {
  TimeError, arrive, completeJob, confirmEntry, endShift, flaggedFor, openJobSession, openShift, pauseJob, startShift,
} from "../services/timeTracking";
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
      // A closed consultation leaves visit.status = "estimate" on purpose
      // (Kyle: consultations are archived, not "completed jobs"), so
      // completedAt is the only signal that the visit is actually done and
      // should drop off the tech's list (2026-09-24: two Eric Ward cards
      // stayed stuck on the field app because this filter never checked it).
      visit: { status: { notIn: ["cancelled", "completed"] }, completedAt: null },
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
        where: { propertyId: { in: propertyIds }, supersededById: null },
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

  /*
    THE ASSESSMENT NO LONGER ENDS THE JOB (Kyle, 2026-09-05: "Once I complete
    an assessment it ends the job with no ability to create an estimate and
    there is no way to go back to the job ... It should ... be manually marked
    completed before becoming inaccessible and logged to the office.")
    This used to complete the tech's assignment right here, which vanished the
    visit from the Today list mid-day. The assessment is one module of the
    visit; the visit stays open — quote, P.O., receipts, payment — until the
    tech closes it out from the job screen, which is what notifies the office.
  */

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

/* ─── CIRCUIT DIAGNOSTICS (Kyle, 2026-09-20) ───────────────────────────────────

   "The tech quotes 3 normal outlets at $25, 2 ceiling outlets at $35, and 1 hard
   to reach outlet at $50 ... The quote gets signed and then in the field app he
   pulls up the diagnostics or run diagnostics, and can click and add outlet
   button. This adds an outlet systematically as he is doing the diagnostics,
   does the measurements at the outlet, takes the pictures, notes if anything was
   fixed, and moves onto the next one."

   THE RCE STANDARD is the scope rule: breaker to last outlet, every box, always.
   The quoted count sizes the circuit; the examined count is what it held. The
   rules live in services/diagnosticReport.ts and shared/diagnostics.ts — these
   routes are the doors, and the only thing they add is WHO may open them.

   Auth model, same as every other tech route: a technician may touch a
   diagnostic on a visit assigned to them, or one they made themselves.
   ──────────────────────────────────────────────────────────────────────────── */

const outletPushSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  locationLabel: z.string().trim().min(1).max(200),
  deviceType: z.enum(DEVICE_TYPES),
  deviceLabel: z.string().trim().max(120).nullable().default(null),
  enclosure: z.string().trim().max(120).nullable().default(null),
  gangs: z.number().int().min(0).max(20).nullable().default(null),
  circuitNumber: z.string().trim().max(40).nullable().default(null),
  difficulty: z.enum(DIFFICULTY_TIERS).default("NORMAL"),
  vPhaseGround: z.number().nullable().default(null),
  vPhaseNeutral: z.number().nullable().default(null),
  vPhasePhase: z.number().nullable().default(null),
  terminationsTightened: z.boolean().default(false),
  corrosion: z.boolean().default(false),
  corrosionNote: z.string().trim().max(500).nullable().default(null),
  findings: z.string().trim().max(2000).nullable().default(null),
  fixed: z.string().trim().max(2000).nullable().default(null),
  equipmentDefective: z.boolean().default(false),
  defectDescription: z.string().trim().max(2000).nullable().default(null),
  photoIds: z.array(z.string().min(1)).default([]),
});

const diagnosticPushSchema = z.object({
  reportId: z.string().min(1),
  visitId: z.string().min(1),
  reportDate: z.string().min(1),
  complaint: z.string().trim().min(1).max(1000),
  circuitLabel: z.string().trim().min(1).max(200),
  circuitNumber: z.string().trim().max(40).nullable().default(null),
  panelLocation: z.string().trim().max(200).nullable().default(null),
  breakerRating: z.string().trim().max(40).nullable().default(null),
  breakerInspected: z.boolean().default(false),
  coverage: z.enum(COVERAGE_VALUES),
  coverageNote: z.string().trim().max(1000).nullable().default(null),
  summary: z.string().trim().max(5000).nullable().default(null),
  diagnosticItemId: z.string().nullable().default(null),
  quotedNormal: z.number().int().min(0).default(0),
  quotedDifficult: z.number().int().min(0).default(0),
  quotedVeryDifficult: z.number().int().min(0).default(0),
  status: z.enum(["in_progress", "complete"]).default("in_progress"),
  outlets: z.array(outletPushSchema).default([]),
  appVersion: z.string().max(120).optional(),
});

/** Map a diagnostic refusal onto the PWA's error envelope, unchanged. */
function sendDiagnosticError(res: express.Response, err: unknown): boolean {
  if (err instanceof DiagnosticError) {
    res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
    return true;
  }
  return false;
}

/** The report, if this technician is allowed to touch it. Null means no. */
async function diagnosticForTech(reportId: string, technicianId: string) {
  const report = await loadDiagnosticReport(prisma, reportId);
  if (!report) return null;
  if (report.technicianId === technicianId) return report;
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId: report.visitId, technicianId },
    select: { id: true },
  });
  return assigned ? report : null;
}

/**
 * What the signed estimate bought, per access tier — the PRE-FILL for a new
 * diagnostic, never the authority. The technician confirms or corrects the three
 * counts before the first outlet and the report freezes what he confirmed,
 * because `IssuedEstimateLine` does not carry `difficulty` and the derivation
 * behind these numbers can come up empty without anyone noticing on a phone.
 */
healthRecordTechRouter.get("/visits/:visitId/diagnostic-context", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  if (!(await requireAssigned(req, res, visitId))) return;
  const context = await diagnosticQuoteContext(prisma, visitId);
  res.json({ success: true, data: context });
}));

/** Every diagnostic on this visit — so a tech resumes one instead of starting a second. */
healthRecordTechRouter.get("/visits/:visitId/diagnostic-reports", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  if (!(await requireAssigned(req, res, visitId))) return;
  const rows = await prisma.diagnosticReport.findMany({
    where: { visitId },
    orderBy: { reportDate: "desc" },
    include: REPORT_INCLUDE,
  });
  res.json({ success: true, data: { reports: rows.map(serializeDiagnosticReport) } });
}));

/**
 * The push. Idempotent on the PWA's own report id, and its outlets sync by their
 * own ids — a retry off the durable queue lands on the same rows, and an outlet
 * deleted on the phone disappears here. Sent repeatedly as the walk progresses,
 * which is the whole point: a diagnostic half-done in a basement with no signal
 * is already on the phone and flushes whole when the bars come back.
 */
healthRecordTechRouter.post("/diagnostic-reports", asyncHandler(async (req: TechRequest, res) => {
  const body = diagnosticPushSchema.parse(req.body);
  const visit = await prisma.visit.findUnique({
    where: { id: body.visitId },
    select: { id: true, propertyId: true, customerId: true },
  });
  if (!visit) {
    res.status(404).json({ success: false, error: { code: "not_found", message: `Visit ${body.visitId} not found` } });
    return;
  }
  if (!(await requireAssigned(req, res, visit.id))) return;

  try {
    const report = await pushDiagnosticReport(prisma, body, {
      visitId: visit.id,
      propertyId: visit.propertyId,
      customerId: visit.customerId,
      technicianId: req.technician!.id,
    });
    res.status(201).json({ success: true, data: serializeDiagnosticReport(report) });
  } catch (err) {
    if (sendDiagnosticError(res, err)) return;
    throw err;
  }
}));

/**
 * Photo evidence, raw bytes, idempotent on the phone's own photo UUID — the same
 * contract as inspection photos, and for the same reason (2026-09-11: four
 * receipt photos taken and lost because nothing wrote them down first). The
 * phone queues the bytes in IndexedDB BEFORE it ever calls this.
 */
healthRecordTechRouter.put(
  "/diagnostic-reports/:reportId/photos/:photoId",
  express.raw({ type: "image/*", limit: "15mb" }),
  asyncHandler(async (req: TechRequest, res) => {
    const reportId = readParam(req, "reportId");
    const photoId = readParam(req, "photoId");
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ success: false, error: { code: "bad_request", message: "Raw image body required (Content-Type: image/*)" } });
      return;
    }
    const report = await diagnosticForTech(reportId, req.technician!.id);
    if (!report) {
      res.status(404).json({
        success: false,
        error: { code: "not_found", message: `Diagnostic ${reportId} not found — push the report before its photos` },
      });
      return;
    }
    const data = {
      reportId,
      mimeType: req.headers["content-type"] ?? "image/jpeg",
      sizeBytes: body.length,
      data: body,
    };
    await prisma.diagnosticPhoto.upsert({ where: { id: photoId }, create: { id: photoId, ...data }, update: data });
    res.status(201).json({ success: true, data: { id: photoId, sizeBytes: body.length } });
  }),
);

/** A photo's exit, from the surface that shows it (Kyle's standing rule). */
healthRecordTechRouter.delete("/diagnostic-reports/:reportId/photos/:photoId", asyncHandler(async (req: TechRequest, res) => {
  const report = await diagnosticForTech(readParam(req, "reportId"), req.technician!.id);
  if (!report) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Diagnostic not found" } });
    return;
  }
  await prisma.diagnosticPhoto.deleteMany({ where: { id: readParam(req, "photoId"), reportId: report.id } });
  res.json({ success: true, data: { deleted: true } });
}));

/** The report's exit while it is still ours: void with a reason. */
healthRecordTechRouter.post("/diagnostic-reports/:id/void", asyncHandler(async (req: TechRequest, res) => {
  const reportId = readParam(req, "id");
  if (!(await diagnosticForTech(reportId, req.technician!.id))) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Diagnostic not found" } });
    return;
  }
  const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body ?? {});
  try {
    const voided = await voidDiagnosticReport(prisma, reportId, body.reason);
    res.json({ success: true, data: serializeDiagnosticReport(voided) });
  } catch (err) {
    if (sendDiagnosticError(res, err)) return;
    throw err;
  }
}));

/** And the harder exit: delete one the homeowner never received. */
healthRecordTechRouter.delete("/diagnostic-reports/:id", asyncHandler(async (req: TechRequest, res) => {
  const reportId = readParam(req, "id");
  if (!(await diagnosticForTech(reportId, req.technician!.id))) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Diagnostic not found" } });
    return;
  }
  try {
    await deleteDiagnosticReport(prisma, reportId);
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    if (sendDiagnosticError(res, err)) return;
    throw err;
  }
}));

/** Hand the homeowner the report, from the driveway. Same gate as the CRM door. */
healthRecordTechRouter.post("/diagnostic-reports/:id/email", asyncHandler(async (req: TechRequest, res) => {
  const reportId = readParam(req, "id");
  if (!(await diagnosticForTech(reportId, req.technician!.id))) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Diagnostic not found" } });
    return;
  }
  const result = await sendDiagnosticReportEmail(reportId, { sentBy: `tech:${req.technician!.id}` });
  if (!result.sent) {
    res.status(409).json({ success: false, error: { code: "not_sent", message: result.reason } });
    return;
  }
  res.json({ success: true, data: { sentTo: result.sentTo, documentId: result.documentId } });
}));

/**
 * The resolutions estimate — "which will always be a change order from a
 * diagnostics" (Kyle). Seeds the diagnostic overage at each tier's own price and
 * writes every defective device into the draft's scope for a human to price;
 * wiring fixes made during the diagnostic appear nowhere on it, because they
 * were already paid for.
 */
healthRecordTechRouter.post("/diagnostic-reports/:id/resolutions", asyncHandler(async (req: TechRequest, res) => {
  const reportId = readParam(req, "id");
  if (!(await diagnosticForTech(reportId, req.technician!.id))) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Diagnostic not found" } });
    return;
  }
  try {
    const result = await buildResolutionsChangeOrder(prisma, reportId, `tech:${req.technician!.id}`);
    res.status(result.resumed ? 200 : 201).json({ success: true, data: result });
  } catch (err) {
    if (sendDiagnosticError(res, err)) return;
    throw err;
  }
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
    // Allow-list, not `not: "void"` (2026-09-20) — see jobMaterials.ts signedEstimateForJob.
    where: { signedAt: { not: null }, status: "signed", OR: [{ jobVisitId: visitId }, { visitId }] },
    orderBy: { createdAt: "desc" },
    select: { id: true, customerEmail: true },
  });
  if (!est) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "No signed estimate on this visit yet — nothing to bill." } });
    return;
  }
  const { publicBaseUrl } = await import("../services/issuedEstimateSend");
  if (body.kind === "balance") {
    /*
      THE ONE INVOICE EMAIL (Kyle, 2026-10-27, "one tool for one task"): the field's "email the bill"
      sends the same email the CRM's "Email the customer" panel does - sendInvoiceEmail: the itemized
      invoice PDF, the balance, the pay link, due upon receipt - to the customer on file. It used to
      call a separate bill (sendBalanceRequestEmail) with no PDF. One balance, one bill: the ROOT
      invoice, as the old bill resolved it. The door and its { ok, to, amount } answer are unchanged.
    */
    const { sendInvoiceEmail } = await import("../services/issuedEstimateSend");
    const { invoiceRootId } = await import("../services/invoiceGroup");
    const { paymentSummary } = await import("../services/stripePayments");
    const rootId = await invoiceRootId(prisma, est.id);
    const before = await paymentSummary(prisma, rootId, publicBaseUrl());
    if (before?.paidInFull) {
      res.status(400).json({ success: false, error: { code: "not_sent", message: "This invoice is already paid in full." } });
      return;
    }
    const result = await sendInvoiceEmail(prisma, rootId, { sentBy: `tech:${req.technician!.id}` });
    if (!result.ok) {
      res.status(400).json({ success: false, error: { code: "not_sent", message: result.reason } });
      return;
    }
    res.json({ success: true, data: { ok: true, to: result.to, amount: result.amount } });
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
  // FINANCING IN PROGRESS (review finding, 2026-10-09): a fee is on and the deposit is not in
  // (voided after the fee went on). The deposit pay link is closed, so the email would send the
  // customer to a dead end — refused here in the server's words, not only greyed on the screen.
  if (financingInProgress(summary)) {
    res.status(409).json({ success: false, error: { code: "financing_in_progress", message: `${FINANCING_IN_PROGRESS} — the deposit pay link is closed. The office removes the financing fee (with a reason) to collect the deposit again.` } });
    return;
  }
  const { sendDepositRequestEmail } = await import("../services/paymentReceipts");
  await sendDepositRequestEmail(prisma, est.id, publicBaseUrl());
  res.json({ success: true, data: { ok: true, to: est.customerEmail, amount: Math.round((summary.depositDue - summary.depositPaid) * 100) / 100 } });
}));

/**
 * POST /health-record/visits/:visitId/email-review-request — the Google review ask, on its own,
 * pressed by the technician (Kyle, 2026-10-01: "a google review request to email on its own" /
 * "manual send both from the field app and from the CRM"). Same assignment gate as
 * /visits/:visitId/email-payment-request directly above — fail-closed: no assignment row means
 * 403, whether the visit exists or not.
 *
 * Bypasses the automation gate exactly like the CRM's sibling route
 * (`POST /jobs/:jobId/email-review-request`, app.ts) — a human pressed it, same precedent as
 * `/issued-estimates/:id/payment-reminder`. Every OTHER correctness check inside
 * sendReviewRequestEmail (job must be completed, no duplicate ask on this job, no repeat ask on
 * this customer within 90 days, customer must have an email on file) still applies unchanged —
 * see services/reviewRequest.ts's header for the full guard order.
 */
healthRecordTechRouter.post("/visits/:visitId/email-review-request", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId, technicianId: req.technician!.id },
    select: { id: true },
  });
  if (!assigned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return;
  }
  const { sendReviewRequestEmail } = await import("../services/reviewRequest");
  const result = await sendReviewRequestEmail(prisma, visitId, { manual: true });
  if (!result.ok) {
    res.status(409).json({ success: false, error: { code: "not_sent", message: result.reason } });
    return;
  }
  res.json({ success: true, data: { to: result.to } });
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
    select: { id: true, visitId: true, status: true, customerId: true, changeOrderForId: true },
  });
  if (!draft || !draft.visitId) return null;
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId: draft.visitId, technicianId },
    select: { id: true },
  });
  return assigned ? draft : null;
}

/*
  A DraftError (a rule refusing) is answered with the status the CRM answers the same refusal with;
  anything else — a database failure — is re-thrown into asyncHandler for the global handler, so
  the phone is never told an outage is a bad request (Phase 7, 2026-10-09: an offline queue treats
  a 4xx as a refusal and stops replaying, a 5xx as "try again later"). `details` — `existingDraftId`
  on "the office already started a quote for this visit" — ride beside the code and message.
*/
const quoteRuleError = (res: express.Response, err: unknown): void => {
  if (!(err instanceof DraftError)) throw err;
  const code = err.status === 404 ? "not_found" : err.status === 409 ? "conflict" : "bad_request";
  res.status(err.status).json({ success: false, error: { code, message: err.message, ...(err.details ?? {}) } });
};

/** This visit must be assigned to the technician asking. */
async function visitAssignedTo(visitId: string, technicianId: string): Promise<boolean> {
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId, technicianId },
    select: { id: true },
  });
  return Boolean(assigned);
}

/** The ids a phone mints with no signal (constants.md idempotency convention) must be UUIDs. */
const clientIdSchema = z.string().uuid();

/**
 * Find-or-create the working draft for a visit — one quote per visit, resumable.
 *
 * WHICH DRAFT IS THE VISIT'S QUOTE is the service's rule — `workingDraftForVisit`
 * (atomicEstimateService.ts), 2026-10-08. It keeps the 2026-09-21 filter that
 * is load-bearing, not tidiness: a change order raised on this job is ALSO a
 * draft on this visit, and resuming it would put new-work lines on a document
 * that only describes the change (never widen that back). It also skips a
 * diagnostic's resolutions draft, and — the fix the audit asked for (§1.3) — it
 * RESUMES AN ISSUED DRAFT: this used to match `status: "draft"` only, and
 * issuing marks the draft finalized, so a tech's edit after issue started a
 * NEW draft and a NEW estimate number. The phone now gets the issued draft
 * back (the quote payload's `lifecycle` says so) and "Save changes to the
 * estimate" revises it, exactly as the office does.
 *
 * The title and supplier of a new draft are `openOrCreateWorkingDraft`'s (Phase 7, 2026-10-09),
 * shared with the replay-safe PUT below; with no client id its behaviour is this route's as it was.
 */
healthRecordTechRouter.post("/visits/:visitId/quote", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  if (!(await visitAssignedTo(visitId, req.technician!.id))) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return;
  }
  try {
    const opened = await openOrCreateWorkingDraft(prisma, visitId);
    res.status(opened.resumed ? 200 : 201).json({ success: true, data: opened });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

/*
  ── A QUOTE STARTED WITH NO SIGNAL (Phase 7, offline estimating, 2026-10-09) ──────────────────────

  The phone mints the draft's id at capture time and PUTs it when signal returns; a replay after a
  lost answer lands on the same row (200, resumed), and a visit whose quote the office started
  meanwhile answers 409 with `existingDraftId` so the phone can offer to add its lines to that one.
  The rule is `openOrCreateWorkingDraft`; this is the same assignment check as the POST above.

  GET /visits/:visitId/quote is READ-ONLY — the phone caches every assigned visit's quote at
  assignment sync, and a cache pass must never start a quote on a visit nobody has quoted.
*/
healthRecordTechRouter.put("/visits/:visitId/quote/:draftId", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  const draftId = clientIdSchema.parse(readParam(req, "draftId"));
  if (!(await visitAssignedTo(visitId, req.technician!.id))) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return;
  }
  try {
    const opened = await openOrCreateWorkingDraft(prisma, visitId, draftId);
    res.status(opened.resumed ? 200 : 201).json({ success: true, data: opened });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

healthRecordTechRouter.get("/visits/:visitId/quote", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  if (!(await visitAssignedTo(visitId, req.technician!.id))) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return;
  }
  const existing = await workingDraftForVisit(prisma, visitId);
  if (!existing) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "This visit has no quote yet" } });
    return;
  }
  res.json({ success: true, data: { draftId: existing.id } });
}));

/*
  The picker's catalog (2026-10-08, one estimating system): search AND browse by section, assemblies
  included — the SAME services the CRM's Estimate Intake uses (browseAtomics behind
  browseFieldCatalog; browseSections). The one difference is on purpose: browseFieldCatalog takes the
  workbook's labour hours, the labour unit basis and Red Cedar's supplier cost OFF every row, leaving
  words and yes/no gap badges. This route used to hand the phone the CRM's rows whole, hours and cost
  included, to a screen the technician then hands to the customer (constants.md "Field app").
*/
healthRecordTechRouter.get("/quote-catalog", asyncHandler(async (req: TechRequest, res) => {
  const result = await browseFieldCatalog(prisma, {
    search: typeof req.query.search === "string" ? req.query.search : null,
    category: typeof req.query.category === "string" ? req.query.category : null,
  });
  res.json({ success: true, data: result });
}));

/** The section cards the picker browses by — the CRM's own `GET /price-book/sections`. */
healthRecordTechRouter.get("/quote-catalog/sections", asyncHandler(async (_req: TechRequest, res) => {
  res.json({ success: true, data: { sections: await browseSections(prisma) } });
}));

/*
  The whole live price book, for the phone to keep (2026-10-09, one estimating system, Phase 7 unit
  U2). With no signal the picker searches and browses this saved copy instead of calling the two
  routes above. Same rows as the picker — fieldCatalogSnapshot runs them through toFieldCatalogRow,
  so words and yes/no badges only, no labour hours, unit basis, cost or price — but every live item,
  not a 60-row page. `?version=` is the stamp the phone already holds; when it still matches, the
  answer is `{ unchanged: true }` and no rows are sent.
*/
healthRecordTechRouter.get("/quote-catalog/snapshot", asyncHandler(async (req: TechRequest, res) => {
  const have = typeof req.query.version === "string" && req.query.version.length <= 100 ? req.query.version : null;
  res.json({ success: true, data: await fieldCatalogSnapshot(prisma, have) });
}));

/*
  The customer-price sheet for a labelled Preview with no signal (2026-10-09, one estimating system,
  Phase 7 unit U3; Kyle's ruling 8: Normal difficulty only). One customer price per live item, built
  by the SAME engine the office prices through, one item at a time at quantity 1 at the active
  supplier (services/fieldPriceSheet.ts). No labour hours or dollars, no unit basis, no cost, no
  per-unit sell figure, no tiers, no bands, no rate rides on a row — pinned by the key-set test in
  tests/fieldPriceSheet.test.ts. Thin wrapper, like the snapshot above: `?version=` is the stamp the
  phone holds, and an unchanged sheet answers `{ unchanged: true }`.
*/
healthRecordTechRouter.get("/quote-price-sheet", asyncHandler(async (req: TechRequest, res) => {
  const have = typeof req.query.version === "string" && req.query.version.length <= 100 ? req.query.version : null;
  res.json({ success: true, data: await buildPhonePriceSheet(prisma, have) });
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
    // `state` rides along so the phone can tell an AI-proposed line (not yet confirmed, not
    // priced, not draggable) from a confirmed one — the CRM keeps them in separate lists too.
    // `atomic.retiredAt` becomes the line's `retired` flag below and is never sent itself.
    select: { id: true, itemId: true, quantity: true, quantitySource: true, difficulty: true, option: true, note: true, location: true, customName: true, state: true, atomic: { select: { retiredAt: true } } },
  });
  const priced = new Map(computed.lines.map((l) => [l.id, l]));
  const details = await prisma.priceBookDraftEstimate.findUniqueOrThrow({
    where: { id: draft.id },
    select: { title: true, jobDescription: true, supplierId: true },
  });
  // Issued or not, changed since, deletable — the SAME object the CRM's review payload carries
  // (getDraftLifecycle). The customer page link for the issued estimate is added HERE, built with
  // estimateLink and never the raw token (PUNCHLIST B5; the issue route and job-brief do the same).
  // door "field": a SIGNED estimate's reviseReason is Kyle's sentence (changing it is office only).
  const lifecycle = await getDraftLifecycle(prisma, draft.id, "field");
  // The AI-suggested lines and open questions waiting on the tech — the same two lists the CRM's
  // review payload carries, shaped for the phone (getDraftSuggestions). No hours, no cost, no usage.
  const suggestions = await getDraftSuggestions(prisma, draft.id);
  if (lifecycle.issued) {
    const { estimateLink } = await import("../services/issuedEstimateSend");
    const row = await prisma.issuedEstimate.findUnique({ where: { id: lifecycle.issued.estimateId }, select: { token: true } });
    lifecycle.issued.customerUrl = row ? estimateLink(row.token) : null;
  }
  res.json({
    success: true,
    data: {
      draftId: draft.id,
      // The title and the scope of work the customer reads — editable on this screen now (Phase 2).
      title: details.title,
      jobDescription: details.jobDescription,
      // The supplier the draft prices against (Phase 7, 2026-10-09): the phone's cached price book
      // is built at ONE supplier, and a quote at another cannot be previewed from it. The id only —
      // no supplier prices, no markup.
      supplierId: details.supplierId,
      lifecycle,
      // "AI proposals" and "Open questions": each is confirmed / rejected / resolved on this screen
      // (POST /quote-lines/:id/confirm|reject, POST /quote-questions/:id/resolve), and the draft
      // cannot be issued while either list has anything in it.
      suggestedLines: suggestions.suggestedLines,
      openQuestions: suggestions.openQuestions,
      // Change orders are the one place a negative quantity is legal
      // (assertQuantityAllowed, atomicEstimateService.ts) — the phone needs
      // to know which draft this is before it decides whether to let a
      // negative quantity through the UI.
      isChangeOrder: Boolean(draft.changeOrderForId),
      // The invoice number a change order is against ("Change order to 2026-1012"), so the screen can
      // say which document this is. A number only; null for an ordinary quote.
      changeOrderFor: draft.changeOrderForId
        ? (await prisma.issuedEstimate.findUnique({ where: { id: draft.changeOrderForId }, select: { number: true } }))?.number ?? null
        : null,
      // The options this draft has (A, B, C plus any added) and the letter "Add option" would
      // create next — the SAME function that builds the CRM review payload's optionSet. Names and
      // line counts only: no hours, no rates.
      optionSet: await getDraftOptionSet(prisma, draft.id),
      // The discount programme AND its computed dollars, and the one-or-the-other mode with the
      // range it shows — worked out HERE (services/quoteMoney.ts, from discounts.ts), so the phone
      // renders finished figures and does no money arithmetic of its own (2026-09-24 Unit A trap 2).
      // Customer prices only: no hours, no labour dollars, no rates.
      money: await getQuoteMoney(prisma, draft.id, computed, lifecycle),
      lines: rows.map(({ atomic, ...l }) => {
        const c = priced.get(l.id);
        return {
          ...l,
          description: c?.description ?? l.itemId,
          lineTotal: c ? Math.round(((c.laborDollars ?? 0) + (c.materialSell ?? 0)) * 100) / 100 : null,
          gaps: c?.gaps.map((g) => g.message) ?? [],
          // "No longer offered in the price book" (Phase 7, 2026-10-09). Retire means "do not
          // offer", not "do not price" (loadCatalogAtSupplier), so the line still prices above;
          // the phone says so after a sync rather than refusing the add.
          retired: atomic.retiredAt !== null,
        };
      }),
      // Hours (and the labor dollars they price out to) never leave the office — the same
      // standing rule the job-brief route already applies (~1280). BUILT FROM NAMED FIELDS, not by
      // stripping two (2026-10-08 review): summarizeOptions defines subtotal = laborDollars +
      // materialSell, so sending subtotal AND materialSell lets anyone subtract one from the other
      // and get the labour dollars to the cent. The customer's page never splits labour from
      // material (issuedEstimateRender), so neither does this payload: the subtotal alone.
      options: summarizeOptions(computed).map((o) => ({
        option: o.option,
        lineCount: o.lineCount,
        // Per-line-rounded, like the frozen estimate and `money` (frozenStyleSubtotal), so the phone's
        // option totals add up to its own line totals and to the figure the customer signs.
        subtotal: frozenStyleSubtotal(computed, o),
        complete: o.complete,
      })),
      total: computed.total,
      rateProvisional: rate.provisional,
    },
  });
}));

// The quantity schema is `lineQuantitySchema` (atomicEstimateService.ts) — the SAME one the CRM's
// line routes use (2026-10-08). Non-zero, either sign reaches the service, and
// `assertQuantityAllowed` there is the only place that decides a negative is legal (change
// orders only). This file used to define its own copy while the CRM said `.positive()`.

// The body of an added line — the POST (the phone online, id picked by the database) and the PUT
// (the phone replaying an add it made with no signal, id minted on the phone) read the same one.
const addLineBodySchema = z.object({
  itemId: z.string().min(1),
  quantity: lineQuantitySchema,
  // No quantitySource: the service derives it from the item (Kyle, 2026-10-08).
  difficulty: z.enum(["NORMAL", "DIFFICULT", "VERY_DIFFICULT"]).default("NORMAL"),
  option: z.enum(ALL_OPTIONS).default("A"),
  note: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
});

// A refusal (quantity, item not in the catalog, signed quote) is a DraftError answered with its
// status; a database failure goes to the global handler as a 5xx (quoteRuleError). This route used
// to answer EVERY error 400, so an outage mid-replay would have read as a refusal (Phase 7, 2026-10-09).
healthRecordTechRouter.post("/quotes/:draftId/lines", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const body = addLineBodySchema.parse(req.body ?? {});
  try {
    const line = await addLine(prisma, draft.id, { ...body, confirmedBy: `tech:${req.technician!.id}` });
    res.status(201).json({ success: true, data: { lineId: line.id } });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

// A line added with no signal, replayed: the same add under the id the phone minted. The same id
// on this quote already → 200 and nothing written; on another quote → 409 (addLine's rule).
healthRecordTechRouter.put("/quotes/:draftId/lines/:lineId", asyncHandler(async (req: TechRequest, res) => {
  const lineId = clientIdSchema.parse(readParam(req, "lineId"));
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const body = addLineBodySchema.parse(req.body ?? {});
  try {
    const line = await addLine(prisma, draft.id, { ...body, id: lineId, confirmedBy: `tech:${req.technician!.id}` });
    res.json({ success: true, data: { lineId: line.id } });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

/*
  ── OPTIONS D-H AND LINE ORDER FROM THE FIELD (Kyle, 2026-10-08, "one estimating system") ────────

  Each route is a wrapper over the SAME service function the CRM's route calls (addOption,
  removeOption, saveLineOrder in atomicEstimateService.ts): which letter is next, the cap of eight,
  the signed-draft refusal and every check on a saved order live there, not here. A rule that
  existed in only one of the two route files would be the bug. Behind quoteDraftForTech, so a
  technician reaches only a quote on a visit assigned to them.

  A DraftError (a rule refusing) is answered with the status the CRM answers the same refusal with
  (quoteRuleError, above); anything else — a database failure — is re-thrown for the global handler.
*/

// `{ option }` (optional, Phase 7): the letter the phone showed it was adding, so a replay cannot
// add a second one — already present answers 200 with nothing written; only `nextOption` is created.
healthRecordTechRouter.post("/quotes/:draftId/options", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const body = z.object({ option: z.string().trim().toUpperCase().max(4).optional() }).parse(req.body ?? {});
  try {
    const added = await addOption(prisma, draft.id, body.option);
    res.status(added.created ? 201 : 200).json({ success: true, data: added });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

healthRecordTechRouter.delete("/quotes/:draftId/options/:option", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  // `?expectedLines=N`: the count the confirm showed; if the office has put lines in the option
  // since, nothing is deleted (409) — same as the CRM's route.
  const expectedLines = expectedLinesSchema.parse(req.query.expectedLines);
  try {
    res.json({ success: true, data: await removeOption(prisma, draft.id, readParam(req, "option").toUpperCase(), expectedLines) });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

healthRecordTechRouter.put("/quotes/:draftId/line-order", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  // The body schema is the service's (lineOrderBodySchema) — the CRM's route reads the same one.
  const body = lineOrderBodySchema.parse(req.body ?? {});
  try {
    res.json({ success: true, data: await saveLineOrder(prisma, draft.id, body.order) });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

/*
  ── DISCOUNT, OPTION NAMES, ONE-OR-THE-OTHER MODE AND COPY-AN-OPTION FROM THE FIELD ──────────────
  (Kyle, 2026-10-08, "one estimating system"; the discount is the gap he named on 2026-09-24.)

  Thin wrappers over the SAME service functions the CRM's routes call (setDraftDiscount,
  setOptionMeta, setOptionsMode, copyOptionLines) and the SAME body schemas — what each accepts,
  the signed-draft rule, the 0 < percent <= 50 bound and the wording of every refusal live there,
  not here. Behind quoteDraftForTech, so a technician reaches only a quote on a visit assigned to
  them. A DraftError is answered with the status the CRM answers it with (quoteRuleError).

  Void and mark-lost stay CRM-only (Kyle, 2026-09-22, Q8); nothing here touches them.
*/
healthRecordTechRouter.put("/quotes/:draftId/discount", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const body = draftDiscountBodySchema.parse(req.body ?? {});
  try {
    res.json({ success: true, data: await setDraftDiscount(prisma, draft.id, body) });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

healthRecordTechRouter.put("/quotes/:draftId/options-mode", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const body = optionsModeBodySchema.parse(req.body ?? {});
  try {
    res.json({ success: true, data: await setOptionsMode(prisma, draft.id, body.exclusive, { expected: body.expected }) });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

// "Copy lines": declared before the :option route below only for reading order — a POST and a PUT
// never collide in Express. Appends to the target, never replaces (copyOptionLines).
healthRecordTechRouter.post("/quotes/:draftId/options/copy", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const body = copyOptionBodySchema.parse(req.body ?? {});
  try {
    res.status(201).json({ success: true, data: await copyOptionLines(prisma, draft.id, body.from, body.to) });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

/*
  ── TITLE & SCOPE, DELETE, COPY TO A NEW QUOTE (2026-10-08, Phase 2 unit B) ───────────────────────

  Same shape as the routes above: each wraps the ONE service function the CRM's route calls
  (setDraftDetails, deleteDraft, duplicateDraft) behind quoteDraftForTech; a DraftError answers with
  the CRM's status and words (quoteRuleError). The copy stays on the same visit, so it is the tech's
  quote too, and — being the newest draft on the visit — it is what "Build the quote" resumes next.
*/
healthRecordTechRouter.put("/quotes/:draftId/details", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const body = draftDetailsBodySchema.parse(req.body ?? {});
  try {
    res.json({ success: true, data: await setDraftDetails(prisma, draft.id, body) });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

healthRecordTechRouter.delete("/quotes/:draftId", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  try {
    res.json({ success: true, data: await deleteDraft(prisma, draft.id) });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

healthRecordTechRouter.post("/quotes/:draftId/duplicate", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  try {
    const copy = await duplicateDraft(prisma, draft.id);
    res.status(201).json({ success: true, data: { draftId: copy.id, title: copy.title } });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

// Name an option and give it a short description — what the customer reads on the tick boxes.
healthRecordTechRouter.put("/quotes/:draftId/options/:option", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const option = readParam(req, "option").toUpperCase();
  if (!isEstimateOption(option)) {
    res.status(400).json({ success: false, error: { code: "bad_request", message: `Unknown option "${option}".` } });
    return;
  }
  const body = optionMetaBodySchema.parse(req.body ?? {});
  try {
    res.json({ success: true, data: await setOptionMeta(prisma, draft.id, option, body) });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

healthRecordTechRouter.patch("/quote-lines/:lineId", asyncHandler(async (req: TechRequest, res) => {
  const row = await prisma.priceBookDraftLine.findUnique({ where: { id: readParam(req, "lineId") }, select: { draftId: true } });
  // "The office removed this line": a row that does not exist is `line_gone` (404), the same answer
  // the remove below gives, so a phone replaying an edit can say why it was refused (Phase 7,
  // 2026-10-09). A line that exists on somebody else's quote stays 403.
  if (!row) {
    res.status(404).json({ success: false, error: { code: "line_gone", message: "That line is no longer on any quote — the office may have removed it." } });
    return;
  }
  const draft = await quoteDraftForTech(row.draftId, req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  // `expected` (optional, Phase 7): what the phone's screen showed for each field it changes —
  // the replay rule is editLine's (assertExpected), refused 409 naming the field and both values.
  const { expected, ...body } = z.object({
    quantity: lineQuantitySchema.optional(),
    difficulty: z.enum(["NORMAL", "DIFFICULT", "VERY_DIFFICULT"]).optional(),
    option: z.enum(ALL_OPTIONS).optional(),
    note: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    // The name the customer reads for this line (Kyle, 2026-10-27) - the CRM's schema, and the same
    // rule in editLine. Empty or null puts the price-book name back.
    customName: lineCustomNameSchema,
    expected: editLineExpectedSchema,
  }).parse(req.body ?? {});
  // A refusal is a DraftError with its status; a database failure is a 5xx (quoteRuleError), no
  // longer a 400 carrying Prisma's wording (Phase 7, 2026-10-09).
  try {
    await editLine(prisma, readParam(req, "lineId"), body, expected);
    res.json({ success: true });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

healthRecordTechRouter.delete("/quote-lines/:lineId", asyncHandler(async (req: TechRequest, res) => {
  const row = await prisma.priceBookDraftLine.findUnique({ where: { id: readParam(req, "lineId") }, select: { draftId: true } });
  // A line that does not exist is `line_gone` (404), and ONLY then (Phase 7, 2026-10-09): a phone
  // replaying a remove it made with no signal treats that as done, so it must never be told 404 for
  // a line that is still there on somebody else's quote — that stays 403, exactly as before.
  if (!row) {
    res.status(404).json({ success: false, error: { code: "line_gone", message: "That line is no longer on any quote." } });
    return;
  }
  const draft = await quoteDraftForTech(row.draftId, req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  // A signed quote's refusal ("raise a change order") is a DraftError: a 400 with the reason, not
  // a 500 that hides it. Anything else — a database failure — goes to the global handler to be
  // logged rather than being told to the phone as a bad request with Prisma's wording
  // (2026-10-08 review; the add and edit routes moved onto the same handler on 2026-10-09).
  try {
    await removeLine(prisma, readParam(req, "lineId"));
    res.json({ success: true });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

/*
  ── AI-SUGGESTED LINES, OPEN QUESTIONS AND THE WALKTHROUGH LIST FROM THE FIELD ─────────────────────
  (Kyle, 2026-10-08, "one estimating system" — Phase 2 unit D. NOT Savannah: these are the
  Walkthrough tab's "Build the draft (AI)" and basic match.)

  Each route wraps the SAME service function the CRM's route calls — confirmProposedLine,
  rejectProposedLine, resolveQuestion, proposeWalkthroughForDraft, resolveWalkthroughRows — and
  reads the SAME body schema. The signed-draft refusal, the change-order quantity rule and the
  degrade-to-basic answer live there, not here. A suggestion or a question is reached only through
  its draft, and the draft only through quoteDraftForTech, so a technician touches nothing on a
  visit that is not assigned to them. A DraftError is answered with the status the CRM answers it
  with (quoteRuleError).

  A line the tech confirms is entered by a human, so it is confirmed by tech:<id> — the same actor
  addLine records for a line the tech types.
*/
async function quoteDraftForLine(lineId: string, technicianId: string) {
  const row = await prisma.priceBookDraftLine.findUnique({ where: { id: lineId }, select: { draftId: true } });
  return row ? quoteDraftForTech(row.draftId, technicianId) : null;
}

healthRecordTechRouter.post("/quote-lines/:lineId/confirm", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForLine(readParam(req, "lineId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const body = confirmLineBodySchema.parse(req.body ?? {});
  try {
    const line = await confirmProposedLine(prisma, readParam(req, "lineId"), `tech:${req.technician!.id}`, body);
    res.json({ success: true, data: { lineId: line.id } });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

healthRecordTechRouter.post("/quote-lines/:lineId/reject", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForLine(readParam(req, "lineId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  try {
    await rejectProposedLine(prisma, readParam(req, "lineId"));
    res.json({ success: true });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

healthRecordTechRouter.post("/quote-questions/:questionId/resolve", asyncHandler(async (req: TechRequest, res) => {
  const row = await prisma.priceBookDraftQuestion.findUnique({ where: { id: readParam(req, "questionId") }, select: { draftId: true } });
  const draft = row ? await quoteDraftForTech(row.draftId, req.technician!.id) : null;
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const body = resolveQuestionBodySchema.parse(req.body ?? {});
  try {
    await resolveQuestion(prisma, readParam(req, "questionId"), `tech:${req.technician!.id}`, body.resolutionNote);
    res.json({ success: true });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

// "Build the draft (AI)". The answer carries which brain ran ("ai" wrote suggestions onto the
// draft; "basic" means the model was unavailable and nothing was written) and, for "basic", why.
// `usage` (the model name and token counts the CRM's route also returns) is left OFF: it is Red
// Cedar's cost, and this screen is handed to the customer.
//
// `degradedReason` is REPLACED with a fixed sentence (2026-10-08 review): the CRM's reason is the
// upstream error text (ProposerUnavailable wraps the OpenAI SDK message, which can carry a masked
// key and quota/organisation detail), and the badge it ends up in is shown on the phone the tech
// hands to the customer. The raw text stays in the server log (aiProposer.ts console.warn) and in
// the office's answer; the truck gets only "unavailable right now".
const TECH_AI_UNAVAILABLE = "The AI helper is unavailable right now.";
healthRecordTechRouter.post("/quotes/:draftId/walkthrough/propose", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const body = walkthroughTextBodySchema.parse(req.body ?? {});
  try {
    const { usage: _usage, ...answer } = await proposeWalkthroughForDraft(prisma, draft.id, body.text);
    res.json({
      success: true,
      data: answer.degradedReason === undefined ? answer : { ...answer, degradedReason: TECH_AI_UNAVAILABLE },
    });
  } catch (err) {
    quoteRuleError(res, err);
  }
}));

// "Basic match only" — the CRM's POST /price-book/resolve-walkthrough. Candidates only: nothing is
// added until the tech taps "+ Add to quote" (an ordinary add-line). The catalog is not a draft's,
// so there is no draft to check; the technician's token is.
healthRecordTechRouter.post("/quote-catalog/resolve-walkthrough", asyncHandler(async (req: TechRequest, res) => {
  const body = walkthroughRowsBodySchema.parse(req.body ?? {});
  res.json({ success: true, data: { rows: await resolveWalkthroughRows(prisma, body.rows) } });
}));

/*
  ── PHOTOS ON THE ESTIMATE (Phase 2 unit E, 2026-10-08) ─────────────────────────────────────────
  A photo taken while building a quote is a job photo - a VisitPhoto on the visit - uploaded by the
  field's existing PUT /visits/:visitId/photos/:photoId (the Job site screen's "Job photos" path);
  there is no second upload path. These three routes let the Quote screen LIST the photos that can
  ride the estimate email, show a small preview of each, and take back one this technician added.
  All behind quoteDraftForTech. The email itself is POST /issued-estimates/:id/email below, which
  takes the ticked ids.

  SCOPE (Kyle, 2026-10-09, ruling 2): THIS JOB's photos - the quote's visit and its job chain
  (estimatePhotos.ts / jobCosting.jobChainOfVisits) - not the whole customer account. The list, the
  preview (403 outside the job) and the email below enforce the same chain. The CRM's email picker
  keeps the account-wide scope (Kyle, 2026-10-01); that is the office, choosing second-hand.
*/
async function photoContextFor(draftId: string, technicianId: string) {
  const draft = await quoteDraftForTech(draftId, technicianId);
  if (!draft) return null;
  const visit = await prisma.visit.findUnique({ where: { id: draft.visitId! }, select: { id: true, customerId: true } });
  return visit ? { draft, visitId: visit.id, customerId: visit.customerId, technicianId } : null;
}

function sendPhotoError(res: express.Response, err: unknown): boolean {
  if (err instanceof PhotoError) {
    res.status(err.statusCode).json({ success: false, error: { code: err.statusCode === 404 ? "not_found" : "forbidden", message: err.message } });
    return true;
  }
  return false;
}

healthRecordTechRouter.get("/quotes/:draftId/photos", asyncHandler(async (req: TechRequest, res) => {
  const ctx = await photoContextFor(readParam(req, "draftId"), req.technician!.id);
  if (!ctx) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  const { photos, total } = await listJobPhotos(prisma, ctx);
  res.json({
    success: true,
    // visitId: the job a photo added from this screen is filed on - the quote's own visit. total:
    // how many photos this JOB has, so the screen can say when it shows only the newest.
    data: { photos, total, max: MAX_ESTIMATE_PHOTOS, visitId: ctx.visitId },
  });
}));

/** A small JPEG preview (the Bearer token rides a fetch; an <img> tag cannot send it). Job-scoped: 403 outside this job. */
healthRecordTechRouter.get("/quotes/:draftId/photos/:photoId/preview", asyncHandler(async (req: TechRequest, res) => {
  const ctx = await photoContextFor(readParam(req, "draftId"), req.technician!.id);
  if (!ctx) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  try {
    const { mimeType, bytes } = await jobPhotoPreview(prisma, readParam(req, "photoId"), ctx);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.send(bytes);
  } catch (err) {
    if (!sendPhotoError(res, err)) throw err;
  }
}));

healthRecordTechRouter.delete("/quotes/:draftId/photos/:photoId", asyncHandler(async (req: TechRequest, res) => {
  const ctx = await photoContextFor(readParam(req, "draftId"), req.technician!.id);
  if (!ctx) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  try {
    await removeOwnVisitPhoto(prisma, readParam(req, "photoId"), ctx);
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    if (!sendPhotoError(res, err)) throw err;
  }
}));

/**
 * "Raise a change order" from the job in the field (Phase 2 unit E, 2026-10-08; the office's twin
 * is POST /issued-estimates/:id/change-order). Both call the same rules - createChangeOrderDraft
 * (signed only; never void or lost; resolves to the ROOT invoice) - through raiseChangeOrderForVisit,
 * which finds the job's signed estimate from the VISIT (the phone is never handed an estimate id)
 * and files the draft on the visit the technician is on. An open change order for the same invoice
 * is resumed, not duplicated (see the service).
 * Void and mark-lost stay the office's (Kyle Q8); this route cannot do either.
 */
healthRecordTechRouter.post("/visits/:visitId/change-order", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  if (!(await requireAssigned(req, res, visitId))) return;
  const result = await raiseChangeOrderForVisit(prisma, visitId, req.technician!.id);
  if (!result.ok) {
    res.status(result.status).json({ success: false, error: { code: result.status === 404 ? "not_found" : "conflict", message: result.error } });
    return;
  }
  res.status(result.resumed ? 200 : 201).json({
    success: true,
    data: { draftId: result.draftId, changeOrderFor: result.changeOrderFor, resumed: result.resumed },
  });
}));

/**
 * Issue from the driveway. Same graduation gate as the CRM (finalizeDraft —
 * unconfirmed lines, gaps and provisional rates all refuse with their real
 * reasons); account and address come from the visit, which is exactly "the
 * address that we are working at". Returns the customer-page link so the
 * customer signs on their own phone or the tech's, and payment follows.
 *
 * RE-ISSUE IS A REVISION, NOT A SECOND ESTIMATE — the SAME function as the
 * CRM's POST /price-book/drafts/:draftId/issue: issueDraft in
 * services/issuedEstimateService.ts (2026-10-08). Editing a quote in the
 * driveway reopens the draft (reopenForEditIfUnsigned); pressing Issue again
 * revises the live estimate rather than minting a second number, and a SIGNED
 * or LOST live estimate is refused with the same reason the office sees. This
 * route used to carry its own copy of that decision; it must not grow one back.
 */
healthRecordTechRouter.post("/quotes/:draftId/issue", asyncHandler(async (req: TechRequest, res) => {
  const draft = await quoteDraftForTech(readParam(req, "draftId"), req.technician!.id);
  if (!draft) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your quote" } });
    return;
  }
  // The deposit is the EXISTING optional checkbox, at the tech's discretion (Kyle, 2026-09-21) —
  // same `depositRequired` the CRM's issue route passes; absent = the service's default (ON for
  // an estimate, OFF for a change order). First issue only, like the CRM: a re-issue revises and
  // carries the previous document's flag; the office's PATCH /terms is the override after that.
  // The same three checkboxes the CRM's issue step carries (Phase 2 unit E): `issueExtrasBodySchema`
  // is the one definition - deposit, "attach the generator sizing recommendation" (refused with
  // "No generator sizing recommendation is on file ..." by graduateDraft when the address has none)
  // and, on a change order, "add to the current job".
  const body = issueExtrasBodySchema.parse(req.body ?? {});
  const visit = await prisma.visit.findUnique({
    where: { id: draft.visitId! },
    select: { customerId: true, propertyId: true },
  });
  // ONE decision, both doors (2026-10-08): issueDraft holds the graduate-vs-revise rule and
  // refuses a signed or lost live estimate with the same reason the CRM's issue route gives.
  const result = await issueDraft(prisma, {
    draftId: draft.id,
    accountId: visit!.customerId,
    serviceAddressId: visit!.propertyId,
    depositRequired: body.depositRequired,
    includeGenerator: body.includeGenerator,
    addToCurrentJob: body.addToCurrentJob,
    actor: `tech:${req.technician!.id}`,
    // Unchanged from before the move: a field revision has always recorded the tech's name.
    reviseActor: `tech:${req.technician!.name}`,
    // Ruling 1 (Kyle, 2026-10-09): changing a SIGNED estimate is office only - the truck is refused
    // with FIELD_SIGNED_REVISE_REASON. There is deliberately NO field route to reviseEstimate.
    door: "field",
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

/**
 * Is this technician assigned to a visit this estimate belongs to? Checked against BOTH `visitId`
 * (set when the draft is issued from a visit, which is every field quote) and `jobVisitId` (set once
 * the estimate becomes a job's root) - an allow-list of the estimate's non-null visit ids, fail-closed
 * when it carries neither. ONE definition for every tech route that takes an issued-estimate id
 * (email, email-financing, sign-in-person): a technician must not reach an estimate on a job that is
 * not theirs, and a copy of this that drifts is a hole.
 */
async function techAssignedToEstimate(
  technicianId: string,
  est: { visitId: string | null; jobVisitId: string | null },
): Promise<boolean> {
  const visitIds = [est.visitId, est.jobVisitId].filter((id): id is string => Boolean(id));
  if (visitIds.length === 0) return false;
  return Boolean(await prisma.visitAssignment.findFirst({
    where: { visitId: { in: visitIds }, technicianId },
    select: { id: true },
  }));
}

/**
 * POST /health-record/issued-estimates/:id/email — email the just-issued estimate to the
 * customer, from the driveway.
 *
 * WHY THIS EXISTS (2026-10-01): Kyle — "On the field app the text option for signiture needs
 * chaged to email since we do not have text yet." The third choice on the post-issue screen used
 * to be `navigator.share(...)`, labelled "Share the link to their phone" — on a phone, the OS
 * share sheet's realistic use is texting the link. Red Cedar has no SMS capability: Kyle's
 * 2026-08-16 ruling is *"There will be NO automated texting ONLY emails ... My personal number is
 * what I will use to text clients,"* and `automationGate.ts` silences outbound Twilio for every
 * automated send class. So "share via text" is replaced with an email, the same way the field
 * already hands the customer the assessment report and the diagnostic report, and the way the CRM
 * itself sends this very estimate (`POST /issued-estimates/:id/send`). If a future reader is
 * tempted to bring the share button back thinking it was lost by accident: it wasn't — there was
 * never a text channel behind it, and "Open the customer's estimate to review & sign" (handing the
 * phone over) still covers the customer standing right there.
 *
 * ONE SEND, ONE PLACE IT IS COMPOSED: delegates to `sendEstimateEmail`, the SAME function the CRM
 * route calls. No second email body, no second template.
 *
 * Guard: the technician must be assigned to the visit this estimate came from — checked against
 * BOTH `visitId` (set when the draft is issued from a visit, which is every field quote) and
 * `jobVisitId` (set once the estimate becomes a job's root), the same OR shape
 * `/visits/:visitId/email-payment-request` above uses. A technician must not be able to email an
 * estimate on a job that is not theirs.
 *
 * The field posts the estimate's id in the path and the send choices in the body (shared/
 * estimateEmail.ts: address override, note, reports, financing line, photos). The server resolves
 * the customer's address when none is given and sends —
 * `sendEstimateEmail` returns `{ ok, to }`, never the token, and nothing here puts it on the wire
 * (PUNCHLIST B4; see tests/fieldContract.test.ts for the pinned contract on the issue response).
 */
healthRecordTechRouter.post("/issued-estimates/:id/email", asyncHandler(async (req: TechRequest, res) => {
  const estimateId = readParam(req, "id");
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: { id: true, visitId: true, jobVisitId: true },
  });
  if (!est) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Estimate not found" } });
    return;
  }
  if (!(await techAssignedToEstimate(req.technician!.id, est))) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This estimate is not on one of your visits" } });
    return;
  }
  // The body - photos, the address override, the note, the two reports, the financing line - is
  // parsed and sent by the SAME function the CRM's POST /issued-estimates/:id/send calls (Phase 4,
  // 2026-10-08: the phone used to take photo ids only). Photos keep the office picker's semantics:
  // ids of photos, at most ten, nothing attached unless ticked. THE TRUCK'S SCOPE IS THIS JOB (Kyle,
  // 2026-10-09, ruling 2): the estimate's visit(s) and their job chain, passed as photoVisitIds so
  // an id from another job - or another customer - is refused in the service, not trusted here. The
  // CRM's door passes no scope and keeps the account-wide picker (Kyle, 2026-10-01).
  const { sendEstimateEmailFromBody } = await import("../services/issuedEstimateSend");
  const photoVisitIds = await jobChainOfVisits([est.visitId, est.jobVisitId]);
  const result = await sendEstimateEmailFromBody(prisma, est.id, req.body, `tech:${req.technician!.id}`, { photoVisitIds });
  if (!result.ok) {
    res.status(409).json({ success: false, error: { code: "not_sent", message: result.reason } });
    return;
  }
  res.json({ success: true, data: { to: result.to } });
}));

/**
 * POST /health-record/issued-estimates/:id/email-financing — the Synchrony financing link, on
 * its own, from the driveway (Kyle, 2026-10-01: "a manual send both from the field app and from
 * the CRM"). Same guard as /email directly above: an allow-list of the estimate's non-null visit
 * ids, 403 unless the technician is assigned to one of them, fail-closed when the estimate
 * carries neither `visitId` nor `jobVisitId`. See services/financingEmail.ts for the
 * no-credit-terms rule — this is a link and an invitation to apply, nothing about rates or terms.
 */
healthRecordTechRouter.post("/issued-estimates/:id/email-financing", asyncHandler(async (req: TechRequest, res) => {
  const estimateId = readParam(req, "id");
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: { id: true, visitId: true, jobVisitId: true },
  });
  if (!est) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Estimate not found" } });
    return;
  }
  if (!(await techAssignedToEstimate(req.technician!.id, est))) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This estimate is not on one of your visits" } });
    return;
  }
  const { sendFinancingEmail } = await import("../services/financingEmail");
  const result = await sendFinancingEmail(prisma, est.id);
  if (!result.ok) {
    res.status(409).json({ success: false, error: { code: "not_sent", message: result.reason } });
    return;
  }
  res.json({ success: true, data: { to: result.to } });
}));

/**
 * POST /health-record/issued-estimates/:id/sign-in-person - the customer signs on the TECHNICIAN'S
 * PHONE (Phase 3 unit C, 2026-10-08).
 *
 * Kyle, 2026-09-24: "The field app is for the techs on site." A signature taken with the customer
 * standing there is a field action; the office's version is "Record acceptance" and stays a
 * different record. The worked example in CLAUDE.md is exactly this gap: the CRM carried a full
 * in-person signing screen and the field's quote flow stopped at issue.
 *
 * A THIN WRAPPER around `signInPerson` (services/inPersonSigning.ts) - the SAME function the
 * office's POST /issued-estimates/:id/sign-in-person calls, with the SAME body schema
 * (`inPersonSignBodySchema`: signerName 1-200, signatureImage <= 400000, selectedOptions <= 8).
 * Every rule - sign-once, void, lost, expired, superseded, the options chosen, one-or-the-other, the
 * drawn mark - is in applySignature, so none is restated here. After the signature the same three
 * side effects run once (notify Kyle, make the job, put away the options not chosen).
 *
 * The signature is recorded as channel "in_person" (never "email"); the technician whose phone it
 * was drawn on is recorded as the actor on the job and archive events and in the signed event's
 * detail. IP and user agent are captured the way the office's route captures them.
 *
 * Guard: the technician must be assigned to a visit this estimate belongs to (techAssignedToEstimate,
 * the same guard as the estimate email above). A stranger tech gets 403 and nothing is signed.
 * A refused signature answers 400 like the office route (`reason` is readable, customer-safe text).
 *
 * SIGNED WITH NO SIGNAL (Phase 7 unit U7, 2026-10-10): the body may also carry the phone's capture
 * id, its clock, the revision, the figures' fingerprint (lifecycle.issued.figuresKey on GET
 * /quotes/:draftId), its send-time clock (`sentAt`, D2) and the consent sentence shown - all judged
 * in applySignature. A resend with the same id after a lost answer gets this same 201 back and runs
 * no side effect twice; a 400 on a send the phone HELD (`heldOnPhone`: taken with no signal, or sent
 * again) also emails Kyle and writes a "field-signature" SystemEvent (inPersonSigning.ts, D1). The
 * phone treats 400 as refused and keeps the row for the technician's red card; a dead network or a
 * 5xx is "not recorded yet" and is sent again.
 *
 * The response carries the figures the signed screen shows - the number, the options taken and the
 * total the signed document bills - so the phone adds nothing up. It never carries the token, hours,
 * costs or margins.
 */
healthRecordTechRouter.post("/issued-estimates/:id/sign-in-person", asyncHandler(async (req: TechRequest, res) => {
  const estimateId = readParam(req, "id");
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: { id: true, visitId: true, jobVisitId: true },
  });
  if (!est) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Estimate not found" } });
    return;
  }
  if (!(await techAssignedToEstimate(req.technician!.id, est))) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This estimate is not on one of your visits" } });
    return;
  }
  const body = inPersonSignBodySchema.parse(req.body ?? {});
  const result = await signInPerson(prisma, est.id, body, {
    ...signerContextOf(req),
    actor: `tech:${req.technician!.id}`,
    recordedBy: `tech:${req.technician!.id}`,
  });
  if (!result.ok) {
    res.status(400).json({ success: false, error: { code: "not_signed", message: result.reason } });
    return;
  }
  res.status(201).json({
    success: true,
    data: {
      signed: true,
      estimateId: result.estimateId,
      number: result.number,
      selectedOptions: result.selectedOptions,
      total: result.signedTotal,
      jobVisitId: result.jobVisitId,
      jobJoined: result.jobJoined,
      archivedNumbers: result.archived.map((a) => a.number),
    },
  });
}));

/**
 * POST /health-record/issued-estimates/:id/signature-events - what became of a signature the
 * phone held and never delivered (Phase 7 unit U8, 2026-10-10): cancelled by the technician before
 * it was recorded, or a refused one dismissed after the customer was called. A thin wrapper around
 * `fileSignatureEvent` (services/inPersonSigning.ts): it writes a "field-signature" SystemEvent and
 * nothing else - no signature, no change to the estimate, no email. Behind the same assignment
 * guard as the signature itself (techAssignedToEstimate); a stranger tech gets 403 and nothing is
 * filed. Idempotent on (signatureId, event): the phone sends it on the next sync and may send it
 * twice after a lost answer.
 */
healthRecordTechRouter.post("/issued-estimates/:id/signature-events", asyncHandler(async (req: TechRequest, res) => {
  const estimateId = readParam(req, "id");
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: { id: true, visitId: true, jobVisitId: true },
  });
  if (!est) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Estimate not found" } });
    return;
  }
  if (!(await techAssignedToEstimate(req.technician!.id, est))) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This estimate is not on one of your visits" } });
    return;
  }
  const body = signatureEventBodySchema.parse(req.body ?? {});
  const result = await fileSignatureEvent(prisma, est.id, body, { actor: `tech:${req.technician!.id}`, ip: signerContextOf(req).ip });
  if (!result.filed) {
    // The office has this signature on the estimate: it was recorded, so it cannot be "cancelled".
    res.status(409).json({ success: false, error: { code: "already_recorded", message: result.reason } });
    return;
  }
  res.json({ success: true, data: result });
}));


// ─── SELF-SERVE VISITS FROM THE FIELD (Kyle, 2026-09-01, phase 5) ────────────
//
// The ratified My-accounts option: the tech can START a service call at an
// address they service, without waiting for the office to create the visit.
// The office is notified of every self-created visit — self-serve, not silent.
// (Phase 5's "schedule for a later date" booking from the field was removed
// 2026-09-21 — scheduling is admin-only; see the same-day routes below.)

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

/*
  ── AFTER THE SIGNATURE: TWO CHOICES, AND THE WAY BACK (Kyle, 2026-09-21) ────
  "The field app should only have a 'complete work now' option that ties the
  accepted estimate to the consultation ... Bigger projects that cannot be done
  same day would be labeled schedule for later and that would then go back to
  the admin side." SCHEDULING IS ADMIN-ONLY: the field's own booking
  (POST /visits/:visitId/schedule, phase 5) and its availability read are GONE,
  not gated. services/sameDayJob.ts owns the three verbs; these are the
  technician-authorised doors, assignment-scoped like every other tech route.
*/

function sendSameDayError(res: express.Response, err: unknown): boolean {
  if (err instanceof SameDayError) {
    res.status(err.status).json({ success: false, error: { code: err.status === 404 ? "not_found" : "conflict", message: err.message } });
    return true;
  }
  return false;
}

/** Complete work now — the consultation becomes the job; nothing is booked, the customer hears nothing. */
healthRecordTechRouter.post("/visits/:visitId/complete-work-now", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  if (!(await requireAssigned(req, res, visitId))) return;
  try {
    const result = await completeWorkNow(prisma, { visitId, actor: `tech:${req.technician!.name}`, technicianName: req.technician!.name });
    res.json({ success: true, data: { jobVisitId: result.jobVisitId, removedVisitId: result.removedVisitId, alreadyDone: result.alreadyDone } });
  } catch (err) {
    if (!sendSameDayError(res, err)) throw err;
  }
}));

/** Schedule for later — closes the consultation; the contracted job waits for the office. Books nothing. */
healthRecordTechRouter.post("/visits/:visitId/schedule-for-later", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  if (!(await requireAssigned(req, res, visitId))) return;
  const { publicBaseUrl } = await import("../services/issuedEstimateSend");
  try {
    const result = await scheduleForLater(prisma, {
      visitId,
      actor: `tech:${req.technician!.name}`,
      technicianId: req.technician!.id,
      technicianName: req.technician!.name,
      payBaseUrl: publicBaseUrl(),
    });
    res.json({ success: true, data: { jobVisitId: result.jobVisitId, depositRequestReleased: result.depositRequestReleased } });
  } catch (err) {
    if (!sendSameDayError(res, err)) throw err;
  }
}));

/**
 * Pause JOB — back to the office to be scheduled again, keeping everything on it. Not the
 * clock's pause (POST /visits/:visitId/pause below), which only closes a time session.
 */
healthRecordTechRouter.post("/visits/:visitId/pause-job", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  if (!(await requireAssigned(req, res, visitId))) return;
  const body = z.object({ reason: z.string().trim().max(300).nullable().optional() }).parse(req.body ?? {});
  try {
    const result = await pauseJobForLater(prisma, {
      visitId,
      actor: `tech:${req.technician!.name}`,
      reason: body.reason ?? null,
      technicianName: req.technician!.name,
    });
    res.json({ success: true, data: { paused: true, sessionsClosed: result.sessionsClosed, laborHours: result.laborHours } });
  } catch (err) {
    if (!sendSameDayError(res, err)) throw err;
  }
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
  // The ROOT invoice (2026-09-20) — its summary rolls the signed change orders in.
  const est = await signedRootForJob(prisma, visitId);
  if (!est) { res.json({ success: true, data: null }); return; }
  const origin = `${req.protocol}://${req.get("host")}`;
  const summary = await paymentSummary(prisma, est.id, origin);
  res.json({
    success: true,
    data: summary
      ? {
        /*
          THE ESTIMATE'S ID (2026-10-01). The route already resolved `est` via signedRootForJob
          to build this summary and was dropping the id on the floor — which left the field app's
          "Email the financing link" button permanently disabled, because that send is keyed by
          the estimate. A capability that exists only in the server is not shipped (CLAUDE.md,
          build it as if you had to click it). Additive, so an older PWA build ignores it.
        */
        estimateId: est.id,
        number: summary.number,
        /*
          WHAT THE INVOICE IS MADE OF (2026-09-29). The tech is standing next to the customer
          when they ask "what am I paying for?" — and the answer on a job with a diagnostic plus
          its resolutions change order is two documents, not one. The summary already knows;
          this route was dropping it on the floor. Additive, so an older PWA build ignores it.
        */
        documents: summary.documents.map((d) => ({
          number: d.number,
          title: d.title,
          kind: d.kind,
          billedTotal: d.billedTotal,
        })),
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
        /*
          FINANCING IN PROGRESS (Kyle, 2026-10-08; Phase 6 Unit 6A, services/financingFee.ts).
          Read-only for the tech: the fee as its own line and the fact that the balance (fee
          included) is being paid through Synchrony. The QR / pay link above are CLOSED server-side
          while this is set (chargeableAmount refuses), and the screen hides them with the reason.
          No plan rate, no fee base — dollars only. The field never records a Synchrony payment:
          that is the office's, on the CRM payment panel. Additive, so an older PWA build ignores it.
          Only while the fee is NOT YET PAID (financingInProgress): once the Synchrony payment is
          recorded, anything still owed is plain invoice money and the QR reopens for it
          (review finding, 2026-10-09).
        */
        financing: financingInProgress(summary)
          ? { planNumber: summary.financingFee!.planNumber, planDescription: summary.financingFee!.planDescription, fee: summary.financingFee!.fee, reason: FINANCING_IN_PROGRESS }
          : null,
        /*
          WHY FINANCING CANNOT START YET (Kyle, 2026-10-08, decision 8; Phase 6 Unit 6C). The 1/3
          deposit is required on a financed job and must be in first — the CRM panel's greyed
          "Pay balance with Synchrony" says it, and the tech standing next to a customer who asks
          "can I finance this?" reads the SAME sentence here (financingBlockedReason is the one
          source). Null when financing is open, when a fee is already on (the `financing` block
          above takes over) and when the invoice is paid. Additive, so an older PWA build ignores it.
        */
        financingBlocked: summary.financingFee || summary.paidInFull ? null : financingBlockedReason(summary),
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

  /*
    THE BRIEF IS THE WHOLE INVOICE (2026-09-20). The root signed estimate is the job; every
    signed, live change order on it is scope the tech must see too — a change order that joined
    the job ("add to current job") is exactly the extra work he is standing there to do. A tech
    working from the root alone works from a stale brief.
  */
  const root = await signedRootForJob(prisma, visitId);
  /*
    ISSUED, NOT SIGNED YET (2026-10-08; 2026-09-24 closing-out plan, Unit 4). The brief used to be
    filled from the signed root ONLY, so `estimate` was either null or signed — and the field's
    "Estimate N issued — not signed yet" panel (JobSiteScreen.tsx), with its "Open the customer's
    estimate to review & sign" link and the two greyed choices, could never render: two builds put
    work into a block nobody could reach. With no signed root, the newest LIVE unsigned root on the
    visit stands in: not void, not lost, not expired, not archived, not superseded, never a change
    order. `fieldChoicePending` refuses an unsigned estimate, so `choicePending` stays false and
    "Complete work now" stays signature-gated (the routes refuse too: consultationWithSignedRoot).
  */
  const pending = root
    ? null
    : await prisma.issuedEstimate.findFirst({
      where: {
        OR: [{ visitId }, { jobVisitId: visitId }],
        signedAt: null,
        voidedAt: null,
        supersededBy: null,
        archivedAt: null,
        changeOrderForId: null,
        status: { notIn: ["void", "lost", "expired"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
  const estId = root?.id ?? pending?.id ?? null;
  const est = estId
    ? await prisma.issuedEstimate.findUnique({
      where: { id: estId },
      include: { lines: { orderBy: { sortOrder: "asc" } } },
    })
    : null;
  const changeOrders = est
    ? await prisma.issuedEstimate.findMany({
      where: { changeOrderForId: est.id, ...LIVE_SIGNED_CHANGE_ORDER },
      orderBy: { signedAt: "asc" },
      include: { lines: { orderBy: { sortOrder: "asc" } } },
    })
    : [];
  const linesOf = (doc: { selectedOptions: string[]; lines: { description: string; quantity: number; option: string }[] }) => {
    const chosen = new Set(doc.selectedOptions ?? []);
    // Taken options only, when a choice was made — the tech works what was bought.
    return doc.lines
      .filter((l) => chosen.size === 0 || chosen.has(l.option))
      .map((l) => ({ description: l.description, quantity: l.quantity, option: l.option }));
  };
  // The JOB clock (Kyle, 2026-09-11): hours already on this job, plus the open
  // arrive-to-leave session if one is running. A flagged session has stopped
  // accruing and is excluded until the tech confirms the real end time.
  const [openEntry, closedSum] = await Promise.all([
    prisma.timeEntry.findFirst({
      where: { visitId, technicianId: req.technician!.id, endedAt: null, flaggedAt: null },
      orderBy: { startedAt: "desc" },
    }),
    prisma.timeEntry.aggregate({
      where: { visitId, endedAt: { not: null }, OR: [{ flaggedAt: null }, { confirmedAt: { not: null } }] },
      _sum: { minutes: true },
    }),
  ]);
  // The signature landed and the technician has not yet chosen Complete work now / Schedule for
  // later (2026-09-21): the screen offers exactly those two, and nothing else closes the visit.
  const choicePending = est ? await fieldChoicePending(prisma, est) : false;
  // The tokenized customer page, so the field app can reopen "review & sign" after the tech
  // navigates away from the just-issued panel (2026-09-24, "the field app cannot get back to the
  // signing page"). Built with the SAME helper the issue route uses (estimateLink,
  // issuedEstimateSend.ts) — never hand-assembled here, and the raw `token` itself never leaves
  // this object (PUNCHLIST B5, same rule GET /issued-estimates/:id follows at app.ts ~3182).
  const { estimateLink } = est ? await import("../services/issuedEstimateSend") : { estimateLink: null };
  res.json({
    success: true,
    data: {
      laborMinutes: Math.round(closedSum._sum.minutes ?? 0),
      clockedInAt: openEntry?.startedAt.toISOString() ?? null,
      visitId: visit.id,
      status: visit.status,
      choicePending,
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
          // The estimate's id, so the Job site screen's "awaiting signature" panel can email it
          // (POST /issued-estimates/:id/email) the way the Quote screen's issued panel does. The id is
          // not a secret (the quote payload's lifecycle already carries it); the token never is sent.
          id: est.id,
          number: est.number,
          title: est.title,
          scopeText: est.scopeText,
          signedAt: est.signedAt?.toISOString() ?? null,
          customerUrl: estimateLink!(est.token),
          lines: linesOf(est),
          // Signed change orders that joined this invoice (2026-09-20) — added scope, same job.
          changeOrders: changeOrders.map((co) => ({
            number: co.number,
            title: co.title,
            scopeText: co.scopeText,
            signedAt: co.signedAt?.toISOString() ?? null,
            lines: linesOf(co),
          })),
        }
        : null,
    },
  });
}));

/*
  ── TWO CLOCKS, KEPT SEPARATE (Kyle, 2026-09-11) ─────────────────────────────

  The SHIFT clock is payroll and lives on the field app's MAIN screen: it works
  whether or not a job is assigned, and payroll hours are clocked-in to
  clocked-out. The JOB clock is job time: Arrive → Complete, or Pause on a
  multi-day job.

  Job time sits INSIDE the shift. Arriving while clocked out starts the shift
  too (and the response says so); clocking out while a job clock runs pauses
  that job first (and the response says so). Shift minus job is unbilled
  company overhead — reported, never charged to a customer.

  The old /clock-in and /clock-out remain as ALIASES for arrive and pause, in
  the old response shape, so a phone that has not taken the new build keeps
  working exactly as it did.
*/

/** Map a service refusal onto the PWA's error envelope. */
function sendTimeError(res: express.Response, err: unknown): boolean {
  if (err instanceof TimeError) {
    res.status(err.statusCode).json({
      success: false,
      error: { code: err.statusCode === 409 ? "conflict" : "invalid", message: err.message },
    });
    return true;
  }
  return false;
}

async function requireAssigned(req: TechRequest, res: express.Response, visitId: string): Promise<boolean> {
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId, technicianId: req.technician!.id },
    select: { id: true },
  });
  if (!assigned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return false;
  }
  return true;
}

/** Today's clock, for the main screen's persistent bar. */
healthRecordTechRouter.get("/shift", asyncHandler(async (req: TechRequest, res) => {
  const technicianId = req.technician!.id;
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const [shift, session, shiftToday, jobToday, flagged] = await Promise.all([
    openShift(technicianId),
    openJobSession(technicianId),
    prisma.shiftEntry.aggregate({
      where: {
        technicianId, startedAt: { gte: dayStart }, endedAt: { not: null },
        OR: [{ flaggedAt: null }, { confirmedAt: { not: null } }],
      },
      _sum: { minutes: true },
    }),
    prisma.timeEntry.aggregate({
      where: {
        technicianId, startedAt: { gte: dayStart }, endedAt: { not: null },
        OR: [{ flaggedAt: null }, { confirmedAt: { not: null } }],
      },
      _sum: { minutes: true },
    }),
    flaggedFor(technicianId),
  ]);
  res.json({
    success: true,
    data: {
      shiftId: shift?.id ?? null,
      // A flagged shift is NOT running — it stopped accruing and is waiting on an answer.
      clockedInAt: shift && !shift.flaggedAt ? shift.startedAt.toISOString() : null,
      openJob: session && !session.flaggedAt
        ? { visitId: session.visitId, startedAt: session.startedAt.toISOString() }
        : null,
      todayShiftMinutes: Math.round(shiftToday._sum.minutes ?? 0),
      todayJobMinutes: Math.round(jobToday._sum.minutes ?? 0),
      // Rule 5: "a clock still running after 12 hours is flagged, stops
      // accruing, and the technician gets a notice asking for the real end time."
      flagged,
    },
  });
}));

healthRecordTechRouter.post("/shift/start", asyncHandler(async (req: TechRequest, res) => {
  try {
    const shift = await startShift(req.technician!.id, { source: "field" });
    res.status(201).json({ success: true, data: { shiftId: shift.id, clockedInAt: shift.startedAt.toISOString() } });
  } catch (err) {
    if (!sendTimeError(res, err)) throw err;
  }
}));

healthRecordTechRouter.post("/shift/end", asyncHandler(async (req: TechRequest, res) => {
  try {
    const result = await endShift(req.technician!.id);
    res.json({
      success: true,
      data: {
        minutes: result.shift.minutes ?? 0,
        endedAt: result.shift.endedAt?.toISOString() ?? null,
        // Rule 1 — the screen has to SAY the job clock was paused for them.
        pausedJob: result.pausedJob,
        rateSet: result.rateSet,
      },
    });
  } catch (err) {
    if (!sendTimeError(res, err)) throw err;
  }
}));

/** Rule 5's answer, from the phone: "confirm when it really ended." */
healthRecordTechRouter.post("/shift/confirm", asyncHandler(async (req: TechRequest, res) => {
  const body = z.object({
    kind: z.enum(["shift", "job"]),
    id: z.string().min(1),
    endedAt: z.string().min(1),
    reason: z.string().trim().max(300).optional(),
  }).parse(req.body);
  const endedAt = new Date(body.endedAt);
  if (Number.isNaN(endedAt.getTime())) {
    res.status(400).json({ success: false, error: { code: "invalid", message: "That end time could not be read." } });
    return;
  }
  // The entry has to belong to the technician answering for it.
  const owned = body.kind === "shift"
    ? await prisma.shiftEntry.findFirst({ where: { id: body.id, technicianId: req.technician!.id }, select: { id: true } })
    : await prisma.timeEntry.findFirst({ where: { id: body.id, technicianId: req.technician!.id }, select: { id: true } });
  if (!owned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "That entry is not yours." } });
    return;
  }
  try {
    await confirmEntry(body.kind, body.id, {
      endedAt,
      actor: `tech:${req.technician!.name}`,
      reason: body.reason?.trim() || "Confirmed the real end time on the field app",
    });
    res.json({ success: true, data: { confirmed: true } });
  } catch (err) {
    if (!sendTimeError(res, err)) throw err;
  }
}));

/** Arrive on site — starts the shift too when the tech is clocked out (rule 1). */
healthRecordTechRouter.post("/visits/:visitId/arrive", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  if (!(await requireAssigned(req, res, visitId))) return;
  try {
    const result = await arrive(visitId, req.technician!.id);
    res.status(201).json({
      success: true,
      data: {
        clockedInAt: result.entry.startedAt.toISOString(),
        startedShift: result.startedShift,
        pausedOther: result.pausedOther,
      },
    });
  } catch (err) {
    if (!sendTimeError(res, err)) throw err;
  }
}));

healthRecordTechRouter.post("/visits/:visitId/pause", asyncHandler(async (req: TechRequest, res) => {
  try {
    const result = await pauseJob(readParam(req, "visitId"), req.technician!.id);
    res.json({ success: true, data: { minutes: result.minutes, laborMinutes: result.laborMinutes, laborHours: result.laborHours } });
  } catch (err) {
    if (!sendTimeError(res, err)) throw err;
  }
}));

healthRecordTechRouter.post("/visits/:visitId/complete-time", asyncHandler(async (req: TechRequest, res) => {
  try {
    const result = await completeJob(readParam(req, "visitId"), req.technician!.id);
    res.json({ success: true, data: { minutes: result.minutes, laborMinutes: result.laborMinutes, laborHours: result.laborHours } });
  } catch (err) {
    if (!sendTimeError(res, err)) throw err;
  }
}));

/** LEGACY ALIAS — clock-in is arrive. Same response shape as before. */
healthRecordTechRouter.post("/visits/:visitId/clock-in", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  if (!(await requireAssigned(req, res, visitId))) return;
  try {
    const result = await arrive(visitId, req.technician!.id);
    res.status(201).json({ success: true, data: { clockedInAt: result.entry.startedAt.toISOString() } });
  } catch (err) {
    if (!sendTimeError(res, err)) throw err;
  }
}));

/** LEGACY ALIAS — clock-out is pause. Same response shape as before. */
healthRecordTechRouter.post("/visits/:visitId/clock-out", asyncHandler(async (req: TechRequest, res) => {
  try {
    const result = await pauseJob(readParam(req, "visitId"), req.technician!.id);
    res.json({ success: true, data: { minutes: result.minutes, laborMinutes: result.laborMinutes, laborHours: result.laborHours } });
  } catch (err) {
    if (!sendTimeError(res, err)) throw err;
  }
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
      purchaseOrders: { where: { status: { not: "cancelled" } }, select: { id: true } },
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
    /*
      A SIGNED estimate is waiting for the technician's choice (2026-09-21): closing the
      consultation without choosing IS "Schedule for later" — the non-destructive choice, the
      one that leaves the contracted job for the office and releases the held deposit request.
      Never the old "quote follow-up" wording, which described an unsigned estimate.
    */
    const signedRoot = await signedRootForJob(prisma, visitId);
    if (signedRoot?.signedAt && signedRoot.visitId === visitId && signedRoot.jobVisitId !== visitId) {
      const { publicBaseUrl } = await import("../services/issuedEstimateSend");
      try {
        const result = await scheduleForLater(prisma, {
          visitId,
          actor: `tech:${req.technician!.name}`,
          technicianId: req.technician!.id,
          technicianName: req.technician!.name,
          payBaseUrl: publicBaseUrl(),
        });
        res.json({ success: true, data: { completed: true, warnings: [], scheduledForLater: true, jobVisitId: result.jobVisitId } });
      } catch (err) {
        if (!sendSameDayError(res, err)) throw err;
      }
      return;
    }
    // Manual close for an estimate visit (Kyle, 2026-09-05): assessment done,
    // report sent, maybe a quote issued — the TECH says when the visit is
    // over, and the office hears about it. Mirrors the CRM's
    // complete-consultation door: completedAt + archived, status untouched.
    const now = new Date();
    await prisma.visit.update({
      where: { id: visitId },
      data: { completedAt: now, nextStep: "archived", nextStepAt: now },
    });
    await prisma.visitAssignment.updateMany({
      where: { visitId, technicianId: req.technician!.id, status: { not: "completed" } },
      data: { status: "completed", completedAt: now },
    });
    const consultLabel = `${visit.customer.name} — ${visit.property.addressLine1}, ${visit.property.city}`;
    logSystemEvent("info", "jobs", `Consultation closed from the field: ${consultLabel}`, {
      visitId,
      technician: req.technician!.name,
    });
    sendKyleNotificationEmail(
      `Consultation closed from the field: ${visit.customer.name}`,
      [
        consultLabel,
        `Closed by: ${req.technician!.name}`,
        "",
        "Assessment/estimate visit wrapped up. Next steps (quote follow-up, scheduling) run from the CRM.",
      ].join("\n"),
    ).catch(() => {});
    res.json({ success: true, data: { completed: true, warnings: [] } });
    return;
  }

  const receiptRows = await prisma.receipt.findMany({ where: { jobId: visitId }, select: { category: true, purchaseOrderId: true } });
  const receipts = receiptRows.length;
  const warnings: string[] = [];
  if (visit.purchaseOrders.length > 0 && receipts === 0) {
    warnings.push(`${visit.purchaseOrders.length} purchase order(s) and no receipts on this job yet.`);
  }
  // Kyle, 2026-09-09: purchasing starts with a PO. A warning, never a wall.
  const receiptsWithoutPo = receiptRows.filter((r) => r.category === "materials" && !r.purchaseOrderId).length;
  if (receiptsWithoutPo > 0) {
    warnings.push(`${receiptsWithoutPo} materials receipt(s) on this job have no PO.`);
  }
  // Build 4 (Kyle, 2026-09-09): material lines sold, nothing consumed off the
  // truck — a warning, never a wall; the P&L falls back to receipts/estimate.
  const materialWarning = await closeOutMaterialWarning(visitId);
  if (materialWarning) warnings.push(materialWarning);

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
  // The review ask rides completion (Kyle, 2026-09-02) — fire-and-forget.
  {
    const { sendReviewRequestEmail } = await import("../services/reviewRequest");
    sendReviewRequestEmail(prisma, visitId).catch((err) =>
      console.error("[jobs] review request failed:", err));
  }
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
 * Purchase orders from the field (Kyle, 2026-09-05: the job screen should
 * "allow a P.O. to be made"; 2026-09-09: "Purchasing needs to start with a
 * P.O. number then the purchase and photo verification of the receipt").
 * A real numbered PO (services/purchaseOrders.ts). Purpose is chosen — truck
 * stock by default; the job is where the tech was, never where material lands.
 */
const fieldPoBodySchema = z.object({
  supplier: z.string().trim().min(1).max(200),
  purpose: z.enum(PO_PURPOSES).default("truck_stock"),
  notes: z.string().trim().max(1000).nullable().optional(),
  items: z.array(z.object({
    name: z.string().trim().min(1).max(300),
    qty: z.number().positive(),
    unit: z.string().trim().max(20).nullable().optional(),
    partNumber: z.string().trim().max(100).nullable().optional(),
    // Barcode/materials plan Unit 3 (2026-09-12): a scanned line pre-fills these from the
    // resolved Material — its linked price-book item and its last-seen pack price — so a
    // known code costs the tech zero typing. Both optional; an unscanned free-text line
    // (the pre-existing path) simply omits them, same as before.
    // 200, not 40 — see app.ts poLineSchema for why (Unit P, 2026-09-17).
    itemId: z.string().trim().max(200).nullable().optional(),
    unitCost: z.number().nonnegative().nullable().optional(),
  })).optional(),
});

/** The shape the PWA lists — number first, because that's what gets read at the counter. */
function fieldPoView(po: Parameters<typeof serializePurchaseOrder>[0]) {
  const v = serializePurchaseOrder(po);
  return {
    id: v.id, number: v.number, purpose: v.purpose, status: v.status, supplier: v.supplier,
    jobId: v.jobId, jobLabel: v.jobLabel, truckName: v.truckName, receiptCount: v.receiptCount,
    // THE MONEY and the proof (Kyle, 2026-09-19) — what the phone prompts for.
    proofCount: v.proofCount, cardTotal: v.cardTotal, offCardAmount: v.offCardAmount, moneyTotal: v.moneyTotal,
    items: v.lines.map((l) => ({
      name: l.name, qty: l.qty, unit: l.unit ?? undefined, partNumber: l.partNumber ?? undefined,
      itemId: l.itemId ?? undefined, unitCost: l.unitCost ?? undefined,
    })),
    sentAt: v.sentAt?.toISOString() ?? null,
    openedAt: v.openedAt.toISOString(),
    createdAt: v.createdAt.toISOString(),
  };
}

/** Service refusals (409 chain, 404) in the PWA's envelope, so the phone shows the reason. */
function techServiceError(res: express.Response, err: unknown): boolean {
  if (typeof err === "object" && err !== null && "statusCode" in err && typeof (err as { statusCode: unknown }).statusCode === "number") {
    const statusCode = (err as { statusCode: number }).statusCode;
    res.status(statusCode).json({
      success: false,
      error: { code: statusCode === 404 ? "not_found" : statusCode === 409 ? "conflict" : "error", message: err instanceof Error ? err.message : "Request failed" },
    });
    return true;
  }
  return false;
}

async function createFieldPo(req: TechRequest, body: z.infer<typeof fieldPoBodySchema>, jobId: string | null) {
  const tech = req.technician!;
  const po = await createPurchaseOrder({
    supplier: body.supplier,
    purpose: body.purpose,
    truckId: await truckIdForTechnician(tech.id),
    jobId,
    notes: body.notes ?? null,
    lines: body.items ?? [],
    openedBy: "tech",
    openedByTechnicianId: tech.id,
    actor: `tech:${tech.name}`,
  });
  logSystemEvent("info", "jobs", `${po.number} opened from the field — ${body.supplier} (${body.purpose})`, {
    visitId: jobId ?? undefined,
    technician: tech.name,
    purchaseOrderId: po.id,
  });
  return po;
}

healthRecordTechRouter.post("/visits/:visitId/purchase-orders", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId, technicianId: req.technician!.id },
    select: { id: true },
  });
  if (!assigned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return;
  }
  const body = fieldPoBodySchema.parse(req.body);
  const po = await createFieldPo(req, body, visitId);
  res.status(201).json({ success: true, data: { id: po.id, number: po.number, purpose: po.purpose, status: po.status, supplier: po.supplier, createdAt: po.createdAt } });
}));

healthRecordTechRouter.get("/visits/:visitId/purchase-orders", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  const assigned = await prisma.visitAssignment.findFirst({
    where: { visitId, technicianId: req.technician!.id },
    select: { id: true },
  });
  if (!assigned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return;
  }
  const orders = await prisma.purchaseOrder.findMany({
    where: { jobId: visitId },
    orderBy: { createdAt: "desc" },
    include: PO_LIST_INCLUDE,
  });
  res.json({ success: true, data: { orders: orders.map(fieldPoView) } });
}));

/**
 * The tech's live purchases — open and purchased, newest first. Includes POs
 * the office opened (openedByTechnicianId null): Kyle opens one at the desk and
 * reads it at the counter from the phone. Other techs' POs stay theirs.
 */
healthRecordTechRouter.get("/purchase-orders", asyncHandler(async (req: TechRequest, res) => {
  const techId = req.technician!.id;
  const orders = await prisma.purchaseOrder.findMany({
    where: {
      status: { in: ["open", "purchased"] },
      OR: [{ openedByTechnicianId: techId }, { openedByTechnicianId: null }, { truck: { technicianId: techId } }],
    },
    orderBy: { openedAt: "desc" },
    take: 100,
    include: PO_LIST_INCLUDE,
  });
  res.json({ success: true, data: { orders: orders.map(fieldPoView) } });
}));

/** Start a purchase with no job — truck stock, warehouse, or a tool run. */
healthRecordTechRouter.post("/purchase-orders", asyncHandler(async (req: TechRequest, res) => {
  const body = fieldPoBodySchema.parse(req.body);
  const po = await createFieldPo(req, body, null);
  res.status(201).json({ success: true, data: { id: po.id, number: po.number, purpose: po.purpose, status: po.status, supplier: po.supplier, createdAt: po.createdAt } });
}));

/**
 * Same ownership rule the tech's PO list uses (GET /purchase-orders above):
 * a PO this tech opened, one the office opened (openedByTechnicianId null —
 * Kyle at the desk), or one on this tech's own truck.
 */
async function poForTech(poId: string, technicianId: string) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    select: { id: true, openedByTechnicianId: true, truck: { select: { technicianId: true } } },
  });
  if (!po) return null;
  const owned = po.openedByTechnicianId === technicianId || po.openedByTechnicianId === null || po.truck?.technicianId === technicianId;
  return owned ? po : null;
}

/**
 * Purchased at the counter / verified / cancelled — the transitions a tech
 * makes. Cancelling requires a reason, the same rule as the CRM route
 * (app.ts POST /purchase-orders/:id/status) — a PO's status never moves
 * money (THE P.O. IS THE MONEY), so cancelling changes no cost figure, only
 * takes the PO off the live list.
 */
healthRecordTechRouter.post("/purchase-orders/:id/status", asyncHandler(async (req: TechRequest, res) => {
  const body = z.object({
    to: z.enum(["purchased", "verified", "cancelled"]),
    reason: z.string().trim().min(1).max(300).optional(),
  }).parse(req.body);
  if (body.to === "cancelled" && !body.reason) {
    res.status(400).json({ success: false, error: { code: "bad_request", message: "A reason is required to cancel a PO." } });
    return;
  }
  const poId = readParam(req, "id");
  const owned = await poForTech(poId, req.technician!.id);
  if (!owned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your purchase order" } });
    return;
  }
  try {
    const po = await transitionPurchaseOrder(poId, body.to, { actor: `tech:${req.technician!.name}`, reason: body.reason ?? null });
    res.json({ success: true, data: { id: po.id, number: po.number, status: po.status } });
  } catch (err) {
    if (!techServiceError(res, err)) throw err;
  }
}));

/**
 * A receipt line that is not on the PO becomes a PO line from the landing
 * panel (Kyle, 2026-09-10: "the pricing on the P.O.'s does not seem to be
 * applied correctly from the receipts") — the same shape the office route
 * takes, so the new line lands at the receipt's own price.
 */
healthRecordTechRouter.post("/purchase-orders/:id/lines", asyncHandler(async (req: TechRequest, res) => {
  const body = z.object({
    // 200, not 40 — see app.ts poLineSchema for why (Unit P, 2026-09-17).
    itemId: z.string().trim().max(200).nullable().optional(),
    name: z.string().trim().min(1).max(300),
    qty: z.number().positive(),
    unit: z.string().trim().max(20).nullable().optional(),
    partNumber: z.string().trim().max(100).nullable().optional(),
    unitCost: z.number().nonnegative().nullable().optional(),
    reason: z.string().trim().max(300).optional(),
  }).parse(req.body);
  const { reason, ...line } = body;
  try {
    const created = await addPurchaseOrderLine(readParam(req, "id"), line, { actor: `tech:${req.technician!.name}`, reason: reason ?? "added from the receipt at landing" });
    res.status(201).json({ success: true, data: { id: created.id, name: created.name, qty: created.qty, unit: created.unit, unitCost: created.unitCost } });
  } catch (err) {
    if (!techServiceError(res, err)) throw err;
  }
}));

// ─── Barcode / SKU materials lookup (2026-09-12, barcode/materials plan Unit 3) ─────────
//
// Kyle: "We can't have this turn into a complicated process ... I am in the middle of
// projects while adding these items in for the job that needs done same day." A known
// code must resolve with zero typing; an unknown one must never block the purchase — it
// still resolves, to a brand-new UNASSIGNED Material carrying the code, so Kyle finishes
// the labor-unit assignment later at a desk (services/materials.ts handles both cases).
//
// Deliberately NOT part of materialsRouter (Unit 2) — that router sits behind
// pinAuthMiddleware (the CRM operator session), which the field PWA can never reach; it
// authenticates with a per-technician bearer token instead (technicianAuth.ts). These two
// tech endpoints are the entire server-side surface Unit 3 needs: one to seed/refresh the
// IndexedDB cache the app scans against offline, one to resolve (or create) a single code.

interface FieldMaterialView {
  id: string;
  upc: string | null;
  sku: string | null;
  supplier: string | null;
  description: string | null;
  packQty: number | null;
  packUnit: string | null;
  lastCost: number | null;
  itemId: string | null;
}

function fieldMaterialView(m: {
  id: string; upc: string | null; sku: string | null; supplier: string | null; description: string | null;
  packQty: number | null; packUnit: string | null; lastCost: number | null; itemId: string | null;
}): FieldMaterialView {
  return {
    id: m.id, upc: m.upc, sku: m.sku, supplier: m.supplier, description: m.description,
    packQty: m.packQty, packUnit: m.packUnit, lastCost: m.lastCost, itemId: m.itemId,
  };
}

/**
 * The full barcode/SKU→material table. Cached in IndexedDB by the field app and refreshed
 * alongside assignment sync (lib/crmSync.ts syncMaterials) — the same degrade-to-cache
 * contract the assignment queue and finding ledger already use, because Kyle scans in the
 * aisle, where signal is worst.
 */
healthRecordTechRouter.get("/materials", asyncHandler(async (_req: TechRequest, res) => {
  const rows = await listMaterials(prisma);
  res.json({ success: true, data: { materials: rows.map((r) => fieldMaterialView(r.material)) } });
}));

const materialScanSchema = z.object({
  code: z.string().trim().min(1).max(64),
  // How the code was captured — Material.symbology's schema comment says "Unit 3 defines
  // the values it actually writes": "upc" for a scanned package barcode, "sku" for a typed
  // SKU, "manual" for free text with no known code family.
  source: z.enum(["upc", "sku", "manual"]).default("manual"),
  // The pack price, when the tech has it to hand. Optional — a missing price never blocks
  // the purchase; it just leaves the new material's cost for Kyle to fill in at the desk.
  price: z.number().nonnegative().nullable().optional(),
});

/**
 * Resolve a scanned/typed code against the material database, creating an UNASSIGNED
 * material when the code has never been seen. Never blocks the purchase: a brand-new code
 * still returns 201 with a usable (if incomplete) material rather than a 404.
 */
healthRecordTechRouter.post("/materials/scan", asyncHandler(async (req: TechRequest, res) => {
  const body = materialScanSchema.parse(req.body);
  const existing = await prisma.material.findFirst({ where: { OR: [{ upc: body.code }, { sku: body.code }] } });
  if (existing) {
    res.json({ success: true, data: { found: true, material: fieldMaterialView(existing) } });
    return;
  }
  const created = await createMaterial(prisma, {
    upc: body.source === "upc" ? body.code : null,
    sku: body.source !== "upc" ? body.code : null,
    lastCost: body.price ?? null,
    symbology: body.source,
  });
  if (!created.ok) {
    // Lost a create race against another request for the same code (two techs scanning the
    // same brand-new item at once) — the row exists now; hand back the winner instead of a
    // conflict the tech at the counter can do nothing about.
    const winner = await prisma.material.findFirst({ where: { OR: [{ upc: body.code }, { sku: body.code }] } });
    if (winner) {
      res.json({ success: true, data: { found: true, material: fieldMaterialView(winner) } });
      return;
    }
    res.status(409).json({ success: false, error: { code: "conflict", message: created.reason } });
    return;
  }
  res.status(201).json({ success: true, data: { found: false, material: fieldMaterialView(created.material) } });
}));

// ─── Materials used at close-out (Kyle, 2026-09-09, Build 4) ─────────────────
//
// "Anything in a truck can be assigned to a job." The tech confirms what came
// off the truck — pre-filled from the signed estimate, on-hand beside each line
// — and the job is charged at the truck's moving average. Online only: a
// consume that replayed later could double-charge. No negative override from
// the field; that is Kyle's, from the CRM, with a reason.

const fieldConsumeLineSchema = z.object({
  itemId: z.string().trim().max(80).optional().default(""),
  name: z.string().trim().max(300).nullable().optional(),
  qty: z.number().positive(),
  unit: z.string().trim().max(20).nullable().optional(),
});

async function assertAssigned(req: TechRequest, res: express.Response, visitId: string): Promise<boolean> {
  const assigned = await prisma.visitAssignment.findFirst({ where: { visitId, technicianId: req.technician!.id }, select: { id: true } });
  if (!assigned) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "This visit is not assigned to you" } });
    return false;
  }
  return true;
}

healthRecordTechRouter.get("/visits/:visitId/materials", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  if (!(await assertAssigned(req, res, visitId))) return;
  try {
    const view = await jobMaterials(visitId, await truckIdForTechnician(req.technician!.id));
    res.json({ success: true, data: view });
  } catch (err) {
    if (!techServiceError(res, err)) throw err;
  }
}));

healthRecordTechRouter.post("/visits/:visitId/consume", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  if (!(await assertAssigned(req, res, visitId))) return;
  const body = z.object({
    truckId: z.string().trim().nullable().optional(),
    lines: z.array(fieldConsumeLineSchema).min(1),
    reason: z.string().trim().max(300).nullable().optional(),
  }).parse(req.body);
  try {
    const tech = req.technician!;
    const movements = await consumeForJob({
      jobId: visitId, truckId: body.truckId ?? (await truckIdForTechnician(tech.id)), lines: body.lines,
      reason: body.reason ?? null, actor: `tech:${tech.name}`,
    });
    res.status(201).json({ success: true, data: movements });
  } catch (err) {
    if (!techServiceError(res, err)) throw err;
  }
}));

healthRecordTechRouter.post("/visits/:visitId/return", asyncHandler(async (req: TechRequest, res) => {
  const visitId = readParam(req, "visitId");
  if (!(await assertAssigned(req, res, visitId))) return;
  const body = z.object({
    truckId: z.string().trim().nullable().optional(),
    lines: z.array(fieldConsumeLineSchema).min(1),
    reason: z.string().trim().max(300).nullable().optional(),
  }).parse(req.body);
  try {
    const tech = req.technician!;
    const movements = await returnForJob({
      jobId: visitId, truckId: body.truckId ?? (await truckIdForTechnician(tech.id)), lines: body.lines,
      reason: body.reason ?? null, actor: `tech:${tech.name}`,
    });
    res.status(201).json({ success: true, data: movements });
  } catch (err) {
    if (!techServiceError(res, err)) throw err;
  }
}));

// ─── My truck: stock, tools, restock, landing (Kyle, 2026-09-09, Build 3) ────
//
// "tracks what is on the truck and what is at the warehouse ... When they are
// used and stored the stock will be updated as to where the tool is currently
// at." Online only — the ledger is the office's; nothing here rides the queue.

/** This tech's truck: its stock levels, the tools on it, its open restock requests, and POs waiting to land. */
healthRecordTechRouter.get("/my-truck", asyncHandler(async (req: TechRequest, res) => {
  const tech = req.technician!;
  const truckId = await truckIdForTechnician(tech.id);
  const key = truckLocationKey(truckId);
  const [truck, levels, tools, requests, trucks, orders, landedOrders] = await Promise.all([
    prisma.truck.findUniqueOrThrow({ where: { id: truckId }, select: { id: true, name: true } }),
    prisma.stockLevel.findMany({ where: { locationKey: key }, orderBy: { name: "asc" } }),
    listTools({ locationKey: key }),
    prisma.stockRequest.findMany({ where: { truckId, status: "open" }, orderBy: { createdAt: "desc" } }),
    prisma.truck.findMany({ where: { isActive: true }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } }),
    prisma.purchaseOrder.findMany({
      where: { truckId, status: { in: ["purchased", "verified"] }, landedAt: null },
      orderBy: { openedAt: "desc" },
      take: 50,
      include: PO_LIST_INCLUDE,
    }),
    // Returns-desk picker (2026-09-22 defect fix): stock on this truck got there by LANDING,
    // not by being unlanded — so the "Returned to store" P.O. dropdown needs THIS list, never
    // unlandedPos. Scoped to this tech's own truck, same as unlandedPos above.
    prisma.purchaseOrder.findMany({
      where: { truckId, landedAt: { not: null } },
      orderBy: { landedAt: "desc" },
      take: 20,
      include: PO_LIST_INCLUDE,
    }),
  ]);
  res.json({
    success: true,
    data: {
      truck,
      locationKey: key,
      levels: levels.map(serializeLevel),
      tools,
      openRequests: requests.map((r) => ({ id: r.id, itemId: r.itemId, name: r.name, qty: r.qty, unit: r.unit, note: r.note, createdAt: r.createdAt })),
      // Where a tool can go from here: the warehouse, or any other active truck.
      locations: [{ key: WAREHOUSE_KEY, label: "Warehouse (home)" }, ...trucks.filter((t) => t.id !== truckId).map((t) => ({ key: truckLocationKey(t.id), label: t.name }))],
      unlandedPos: orders.map(fieldPoView),
      recentLandedPos: landedOrders.map(fieldPoView),
    },
  });
}));

/**
 * POST /my-truck/supplier-return — material going back to the store, off THIS
 * tech's own truck only (resolved server-side from truckIdForTechnician, never
 * named by the body — a tech cannot return against another truck or the
 * warehouse). Online only, like the rest of My Truck (health-record.ts, Build
 * 3) — it does not ride the offline queue. Reason required; priced at the
 * truck's own moving average.
 */
healthRecordTechRouter.post("/my-truck/supplier-return", asyncHandler(async (req: TechRequest, res) => {
  const body = z.object({
    itemId: z.string().trim().min(1),
    qty: z.number().positive(),
    purchaseOrderId: z.string().trim().min(1).nullable().optional(),
    reason: z.string().trim().min(1).max(300),
  }).parse(req.body);
  const tech = req.technician!;
  try {
    const truckId = await truckIdForTechnician(tech.id);
    const movement = await supplierReturnStock({
      itemId: body.itemId, qty: body.qty, fromLocationKey: truckLocationKey(truckId),
      purchaseOrderId: body.purchaseOrderId ?? null, reason: body.reason, actor: `tech:${tech.name}`,
    });
    res.status(201).json({ success: true, data: movement });
  } catch (err) {
    if (!techServiceError(res, err)) throw err;
  }
}));

/** The book, picker-shaped, for the restock form. */
healthRecordTechRouter.get("/inventory/items", asyncHandler(async (req: TechRequest, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  res.json({ success: true, data: await searchItems(q, 25) });
}));

/** "Request restock" — item from the book or free text; the office fulfills from the warehouse. */
healthRecordTechRouter.post("/stock-requests", asyncHandler(async (req: TechRequest, res) => {
  const body = z.object({
    itemId: z.string().trim().max(80).nullable().optional(),
    name: z.string().trim().min(1).max(300),
    qty: z.number().positive(),
    unit: z.string().trim().max(20).nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  }).parse(req.body);
  const tech = req.technician!;
  try {
    const row = await createStockRequest({ ...body, truckId: await truckIdForTechnician(tech.id), requestedByTechnicianId: tech.id });
    res.status(201).json({ success: true, data: row });
  } catch (err) {
    if (!techServiceError(res, err)) throw err;
  }
}));

/** A tech moves a tool between their truck, the warehouse, or another truck. */
healthRecordTechRouter.post("/tools/:id/move", asyncHandler(async (req: TechRequest, res) => {
  const body = z.object({ toLocationKey: z.string().trim().min(1).max(80), reason: z.string().trim().max(300).nullable().optional() }).parse(req.body);
  try {
    const result = await moveTool(readParam(req, "id"), body.toLocationKey, { actor: `tech:${req.technician!.name}`, reason: body.reason ?? null });
    res.json({ success: true, data: result });
  } catch (err) {
    if (!techServiceError(res, err)) throw err;
  }
}));

healthRecordTechRouter.get("/purchase-orders/:id/landing", asyncHandler(async (req: TechRequest, res) => {
  try {
    res.json({ success: true, data: await landingDefaults(readParam(req, "id")) });
  } catch (err) {
    if (!techServiceError(res, err)) throw err;
  }
}));

healthRecordTechRouter.post("/purchase-orders/:id/land", asyncHandler(async (req: TechRequest, res) => {
  const body = z.object({
    lines: z.array(z.object({ lineId: z.string().trim().min(1), qtyLanded: z.number().nonnegative(), unitCost: z.number().nonnegative() })),
    reason: z.string().trim().max(300).nullable().optional(),
    // Kyle, 2026-09-23: landing no longer gates on the receipt total, so an
    // "override" reason has nothing left to override — accepted and ignored so an
    // older field build that still sends one does not 400.
    override: z.object({ reason: z.string() }).optional(),
  }).parse(req.body);
  try {
    const result = await landPurchaseOrder(readParam(req, "id"), body.lines, `tech:${req.technician!.name}`, body.reason ?? null);
    res.json({ success: true, data: { id: result.purchaseOrder.id, number: result.purchaseOrder.number, status: result.purchaseOrder.status, landedAt: result.purchaseOrder.landedAt, destination: result.destination } });
  } catch (err) {
    if (!techServiceError(res, err)) throw err;
  }
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
    // Only a technician on this visit may file a photo on it, and a client-chosen photo id may never
    // reach an existing photo that is not this technician's on this visit (2026-10-08 security
    // review). Before this the route checked only that the visit existed and upserted by the id the
    // phone sent — and the Quote screen's photo list (GET /quotes/:draftId/photos) now hands out
    // the ids of every photo on the customer's account, so a tech could PUT over another tech's
    // photo, take ownership of it (the upsert rewrites visitId and technicianId), and then pass the
    // "your own photo, from the job it was filed on" check to delete it.
    if (!(await requireAssigned(req, res, visitId))) return;
    const existingPhoto = await prisma.visitPhoto.findUnique({
      where: { id: photoId },
      select: { visitId: true, technicianId: true },
    });
    if (existingPhoto && (existingPhoto.visitId !== visitId || existingPhoto.technicianId !== req.technician!.id)) {
      res.status(403).json({ success: false, error: { code: "forbidden", message: "That photo belongs to another job or technician" } });
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
 * Run the OpenAI Vision parse for an already-persisted receipt and patch in
 * whatever it finds — vendor, amount, lineItems, and the parsed purchase date
 * — but only into fields still empty; a value the tech or office already
 * keyed in is never overwritten. Re-rolls the job's material cost and re-runs
 * the card-spend matcher afterward, same as the old inline path did.
 *
 * Unit 2 (Kyle, 2026-09-12): the photo's safety must never depend on this
 * completing. Called fire-and-forget after the 201 response, and again by the
 * operator "re-parse" route below. Never throws — a Vision failure (thrown or
 * a null/degraded result) leaves the row exactly as it was, still
 * pending_review, photo bytes untouched.
 */
async function applyVisionParse(receiptId: string): Promise<{ parsed: boolean }> {
  const receipt = await prisma.receipt.findUnique({
    where: { id: receiptId },
    select: { id: true, imageData: true, imageMime: true, amount: true, vendor: true, lineItems: true, jobId: true },
  });
  if (!receipt || !receipt.imageData) return { parsed: false };
  // 2026-09-18 (Unit 1, "receipts must be read, not guessed"): PDFs are read by
  // parseReceiptImage exactly like photos now — the old application/pdf early
  // return that skipped the (paid) call is gone.

  const { parseReceiptImage } = await import("../services/receiptVision");
  let parsed;
  try {
    parsed = await parseReceiptImage(Buffer.from(receipt.imageData), receipt.imageMime ?? "image/jpeg");
  } catch (err) {
    console.error(`[receipts] vision parse threw for ${receiptId}; row stays pending_review:`, err);
    return { parsed: false };
  }
  if (!parsed) return { parsed: false };

  const patch: { vendor?: string; amount?: number; lineItems?: string; receivedAt?: Date; reconciliationNote?: string | null } = {};
  if (!receipt.vendor && parsed.vendor) patch.vendor = parsed.vendor;
  if (receipt.amount <= 0 && parsed.total != null) patch.amount = parsed.total;
  if (!receipt.lineItems && parsed.lineItems.length > 0) patch.lineItems = JSON.stringify(parsed.lineItems);
  if (parsed.purchaseDate) patch.receivedAt = new Date(`${parsed.purchaseDate}T12:00:00Z`);
  // Unit 2 (2026-09-18): record WHAT didn't reconcile — or clear a stale note when
  // a re-parse (the operator "reparse" route below) now reconciles cleanly.
  if (parsed.lineItems.length > 0) patch.reconciliationNote = parsed.reconciliationNote;

  if (Object.keys(patch).length > 0) {
    await prisma.receipt.update({ where: { id: receiptId }, data: patch });
  }
  return { parsed: true };
}

/**
 * PUT /health-record/receipts/:receiptId — receipt photo upload from the tech
 * PWA. Idempotent (client UUID id). Raw image body; metadata via query params
 * (jobId, category, vendor, amount).
 *
 * Unit 2 (Kyle, 2026-09-12): the row is persisted and the response returned
 * BEFORE any OpenAI Vision call — the photo's safety must not depend on an
 * external API completing. When amount/vendor are missing, Vision runs after
 * the response via applyVisionParse() and patches the row in place;
 * pending_review is the normal state either way until the office confirms.
 */
healthRecordTechRouter.put(
  "/receipts/:receiptId",
  // Unit R (2026-09-17): PDFs accepted alongside images — a saved Home Depot
  // online-order PDF is a real receipt. Widened from "image/*" only.
  express.raw({ type: ["image/*", "application/pdf"], limit: "15mb" }),
  asyncHandler(async (req: TechRequest, res) => {
    const receiptId = readParam(req, "receiptId");
    const body = req.body as Buffer;

    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ success: false, error: { code: "bad_request", message: "Raw image or PDF body required (Content-Type: image/* or application/pdf)" } });
      return;
    }

    const query = z.object({
      jobId: z.string().optional(),
      category: z.enum(["materials", "gas", "maintenance", "overhead", "permit", "inspection"]).optional(),
      vendor: z.string().optional(),
      amount: z.coerce.number().positive().optional(),
      // Kyle, 2026-09-09: the receipt photo verifies a PO. When present the
      // receipt is attached, inherits the PO's job if it has none, and an open
      // PO moves to purchased.
      purchaseOrderId: z.string().optional(),
    }).parse(req.query);

    if (query.jobId) {
      const visit = await prisma.visit.findUnique({ where: { id: query.jobId }, select: { id: true } });
      if (!visit) {
        res.status(404).json({ success: false, error: { code: "not_found", message: `Visit ${query.jobId} not found` } });
        return;
      }
    }
    if (query.purchaseOrderId) {
      const po = await prisma.purchaseOrder.findUnique({ where: { id: query.purchaseOrderId }, select: { id: true, status: true, number: true } });
      if (!po) {
        res.status(404).json({ success: false, error: { code: "not_found", message: "Purchase order not found" } });
        return;
      }
      if (po.status === "closed" || po.status === "cancelled") {
        res.status(409).json({ success: false, error: { code: "conflict", message: `${po.number} is ${po.status} — start a new PO for this receipt.` } });
        return;
      }
    }

    const mimeType = (req.headers["content-type"] as string | undefined) ?? "image/jpeg";
    // 2026-09-18 (Unit 1, "receipts must be read, not guessed"): PDFs are read by
    // Vision the same as photos now — no more "type the amount" refusal.
    const needsVision = query.amount == null || !query.vendor;

    const data = {
      jobId: query.jobId ?? null,
      category: query.category ?? "materials",
      vendor: query.vendor ?? null,
      amount: query.amount ?? 0,
      lineItems: null as string | null,
      source: "tech_pwa",
      status: "pending_review",
      technicianId: req.technician!.id,
      imageData: body,
      imageMime: mimeType,
    };
    const receipt = await prisma.receipt.upsert({
      where: { id: receiptId },
      create: { id: receiptId, ...data },
      update: data,
    });
    // The receipt is proof, never money (Kyle, 2026-09-19): nothing to re-roll.
    // On a PO it proves the PO's charges and can verify it.
    let purchaseOrderNumber: string | null = null;
    if (query.purchaseOrderId) {
      await attachReceiptToPurchaseOrder(receipt.id, query.purchaseOrderId, `tech:${req.technician!.name}`);
      purchaseOrderNumber = (await prisma.purchaseOrder.findUnique({ where: { id: query.purchaseOrderId }, select: { number: true } }))?.number ?? null;
    }

    res.status(201).json({
      success: true,
      data: {
        id: receipt.id,
        amount: receipt.amount,
        vendor: receipt.vendor,
        category: receipt.category,
        status: receipt.status,
        parsed: false,
        purchaseOrderId: query.purchaseOrderId ?? null,
        purchaseOrderNumber,
      },
    });

    // Vision runs AFTER the response — never awaited, never on the request path.
    if (needsVision) {
      void applyVisionParse(receipt.id).catch((err) => {
        console.error(`[receipts] async vision parse failed for ${receipt.id}, row stays pending_review:`, err);
      });
    }
  }),
);

/**
 * Is this receipt the tech's to touch — uploaded by them, on a PO they own
 * (poForTech, above), or tied to a visit assigned to them. Mirrors "scoped to
 * receipts on the tech's own P.O.s/visits" rather than uploader identity
 * alone, so a receipt someone else on the same truck/PO filed is still
 * reachable.
 */
async function receiptOwnedByTech(receiptId: string, technicianId: string) {
  const r = await prisma.receipt.findUnique({
    where: { id: receiptId },
    select: { id: true, technicianId: true, jobId: true, purchaseOrderId: true },
  });
  if (!r) return null;
  if (r.technicianId === technicianId) return r;
  if (r.purchaseOrderId && (await poForTech(r.purchaseOrderId, technicianId))) return r;
  if (r.jobId) {
    const assigned = await prisma.visitAssignment.findFirst({ where: { visitId: r.jobId, technicianId }, select: { id: true } });
    if (assigned) return r;
  }
  return null;
}

/**
 * The receipts on a PO, for the field P.O. panel's edit/remove controls
 * (standing rule: nothing this app creates is permanent without an exit from
 * where it's shown). Amount/vendor only — the office's fuller receipt drawer
 * stays at /health-record-admin/receipts/:id.
 */
healthRecordTechRouter.get("/purchase-orders/:id/receipts", asyncHandler(async (req: TechRequest, res) => {
  const poId = readParam(req, "id");
  if (!(await poForTech(poId, req.technician!.id))) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your purchase order" } });
    return;
  }
  const receipts = await prisma.receipt.findMany({
    where: { purchaseOrderId: poId },
    orderBy: { createdAt: "desc" },
    select: { id: true, vendor: true, amount: true, category: true, imageMime: true, createdAt: true },
  });
  res.json({
    success: true,
    data: receipts.map((r) => ({
      id: r.id,
      vendor: r.vendor,
      amount: r.amount,
      category: r.category,
      hasImage: Boolean(r.imageMime),
      createdAt: r.createdAt.toISOString(),
    })),
  });
}));

/**
 * Edit a receipt from the field — same write as the office's
 * PATCH /health-record-admin/receipts/:id (applyReceiptEdit, below), scoped
 * to a receipt on the tech's own P.O. or visit. Narrower than the office
 * door on purpose: no job reassignment, no "confirmed" bookkeeping status, no
 * back-dating — those stay office moves. A receipt is proof, never money
 * (2026-09-19): none of these fields move a cost figure.
 */
healthRecordTechRouter.patch("/receipts/:id", asyncHandler(async (req: TechRequest, res) => {
  const id = readParam(req, "id");
  if (!(await receiptOwnedByTech(id, req.technician!.id))) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your receipt" } });
    return;
  }
  const body = z.object({
    vendor: z.string().nullable().optional(),
    amount: z.number().nonnegative().optional(),
    category: z.enum(["materials", "gas", "maintenance", "overhead", "permit", "inspection"]).optional(),
    purchaseOrderId: z.string().nullable().optional(),
  }).parse(req.body ?? {});
  const updated = await applyReceiptEdit(id, body, `tech:${req.technician!.name}`);
  if (!updated) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Receipt not found" } });
    return;
  }
  res.json({ success: true, data: updated });
}));

/**
 * Remove a receipt from the field — same write as the office's
 * DELETE /health-record-admin/receipts/:id (removeReceiptRecord, below). A
 * receipt is proof, never money (2026-09-19): removing one changes no cost
 * figure; it can un-verify its PO under the existing RECEIPT_HAS_FILE gate,
 * since proofCount is derived live, never stored.
 */
healthRecordTechRouter.delete("/receipts/:id", asyncHandler(async (req: TechRequest, res) => {
  const id = readParam(req, "id");
  if (!(await receiptOwnedByTech(id, req.technician!.id))) {
    res.status(403).json({ success: false, error: { code: "forbidden", message: "Not your receipt" } });
    return;
  }
  const removed = await removeReceiptRecord(id);
  if (!removed) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Receipt not found" } });
    return;
  }
  res.status(204).end();
}));

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
      where: { propertyId: { in: ids }, supersededById: null },
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
      // Overwrite ruling: the field's history shows only what stands. The
      // superseded rows remain in the database; the Revise verb always lands
      // on the record that is currently true.
      where: { propertyId, supersededById: null },
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
    // Pay (Kyle, 2026-09-11): "rates are typed by Kyle, never defaulted."
    // Null clears it back to "rate not set" — which is an honest state, not a zero.
    hourlyRate: z.number().min(0).max(1000).nullable().optional(),
    commissionPercent: z.number().min(0).max(100).nullable().optional(),
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
    // Overwrite ruling (2026-09-01): a superseded record is history, not a card.
    where: { customerId: readParam(req, "customerId"), supersededById: null },
    select: inspectionSummary,
    orderBy: { inspectionDate: "desc" },
  });
  res.json(summarizeInspections(inspections));
}));

healthRecordAdminRouter.get("/properties/:propertyId/inspections", asyncHandler(async (req, res) => {
  const inspections = await prisma.healthInspection.findMany({
    where: { propertyId: readParam(req, "propertyId"), supersededById: null },
    select: inspectionSummary,
    orderBy: { inspectionDate: "desc" },
  });
  res.json(summarizeInspections(inspections));
}));

healthRecordAdminRouter.get("/visits/:visitId/inspections", asyncHandler(async (req, res) => {
  const inspections = await prisma.healthInspection.findMany({
    where: { visitId: readParam(req, "visitId"), supersededById: null },
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

/* ── Circuit diagnostics, from the office (2026-09-20) ────────────────────────
   The field app is where a diagnostic is made and where its exits live, but the
   office has to be able to read one, re-send it and void one — a record only
   the phone can reach is a record Kyle cannot answer a phone call about. Same
   service, same gates; the only difference is who is asking. */

healthRecordAdminRouter.get("/visits/:visitId/diagnostic-reports", asyncHandler(async (req, res) => {
  const rows = await prisma.diagnosticReport.findMany({
    where: { visitId: readParam(req, "visitId") },
    orderBy: { reportDate: "desc" },
    include: REPORT_INCLUDE,
  });
  res.json({ reports: rows.map(serializeDiagnosticReport) });
}));

/**
 * Every diagnostic report ever run at an address, across every visit — the
 * property page's health record (plan item C, 2026-10-02) aggregates this the
 * same way it already aggregates inspections and findings per-property rather
 * than per-visit, so a 30-day-old estimate rebuilt from a new consultation
 * still shows the diagnostic history that justified it.
 */
healthRecordAdminRouter.get("/properties/:propertyId/diagnostic-reports", asyncHandler(async (req, res) => {
  const rows = await prisma.diagnosticReport.findMany({
    where: { propertyId: readParam(req, "propertyId") },
    orderBy: { reportDate: "desc" },
    include: REPORT_INCLUDE,
  });
  res.json({ reports: rows.map(serializeDiagnosticReport) });
}));

healthRecordAdminRouter.get("/diagnostic-reports/:id", asyncHandler(async (req, res) => {
  const report = await loadDiagnosticReport(prisma, readParam(req, "id"));
  if (!report) {
    res.status(404).json({ error: "Diagnostic report not found" });
    return;
  }
  res.json(serializeDiagnosticReport(report));
}));

/**
 * POST /health-record-admin/diagnostic-reports/:id/report — render the diagnostic
 * PDF fresh so the office can LOOK at it (Kyle, 2026-10-11: "I don't see anywhere to
 * view the diagnostic report pdf that is generated and emailed"). Same gate as the
 * email (src/services/diagnosticReportEmail.ts) — a voided or unfinished diagnostic
 * has no report to show — but it sends nothing and writes no delivery row. generated/
 * is wiped on every deploy, so there is no stored copy to open; it is rendered on
 * request, like the Health Record's "View report".
 */
healthRecordAdminRouter.post("/diagnostic-reports/:id/report", asyncHandler(async (req, res) => {
  const report = await loadDiagnosticReport(prisma, readParam(req, "id"));
  if (!report) {
    res.status(404).json({ error: "Diagnostic report not found" });
    return;
  }
  if (report.status === "void") {
    res.status(409).json({ error: "That diagnostic is void. A voided report is never sent to a customer." });
    return;
  }
  if (report.status !== "complete") {
    res.status(409).json({
      error: "This diagnostic is still in progress. The report exists once the tech finishes the circuit — breaker to last outlet — and marks it complete.",
    });
    return;
  }
  if (report.outlets.length === 0) {
    res.status(409).json({ error: "No outlets were recorded, so there is no diagnostic report to show." });
    return;
  }
  const { generateDiagnosticReport } = await import("../services/pdfGenerator");
  const { documentId } = await generateDiagnosticReport(report.id);
  res.status(201).json({ documentId });
}));

healthRecordAdminRouter.get("/diagnostic-photos/:photoId", asyncHandler(async (req, res) => {
  const photo = await prisma.diagnosticPhoto.findUnique({ where: { id: readParam(req, "photoId") } });
  if (!photo) {
    res.status(404).json({ error: "Photo not found" });
    return;
  }
  res.setHeader("Content-Type", photo.mimeType);
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.send(Buffer.from(photo.data));
}));

healthRecordAdminRouter.post("/diagnostic-reports/:id/email", asyncHandler(async (req, res) => {
  const body = z.object({ to: z.string().email().optional() }).parse(req.body ?? {});
  const result = await sendDiagnosticReportEmail(readParam(req, "id"), { to: body.to ?? null, sentBy: "owner:crm" });
  if (!result.sent) {
    res.status(409).json({ error: result.reason });
    return;
  }
  res.json({ sentTo: result.sentTo, documentId: result.documentId });
}));

healthRecordAdminRouter.post("/diagnostic-reports/:id/void", asyncHandler(async (req, res) => {
  const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body ?? {});
  try {
    const voided = await voidDiagnosticReport(prisma, readParam(req, "id"), body.reason);
    res.json(serializeDiagnosticReport(voided));
  } catch (err) {
    if (err instanceof DiagnosticError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    throw err;
  }
}));

healthRecordAdminRouter.delete("/diagnostic-reports/:id", asyncHandler(async (req, res) => {
  try {
    await deleteDiagnosticReport(prisma, readParam(req, "id"));
    res.json({ deleted: true });
  } catch (err) {
    if (err instanceof DiagnosticError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    throw err;
  }
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
  // includeGenerator (2026-09-01): the CRM send carries the Load Calc &
  // Generator Sizing sheet exactly like the field's — one email, all of it.
  const body = z.object({ to: z.string().email().optional(), includeGenerator: z.boolean().optional() }).parse(req.body ?? {});
  const result = await sendHealthReportEmail(readParam(req, "id"), {
    to: body.to ?? null,
    sentBy: "owner:crm",
    includeGenerator: body.includeGenerator ?? false,
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
      reconciliationNote: true,
    },
  });
  // Attach tech names without dragging image bytes along
  const techIds = [...new Set(receipts.map((r) => r.technicianId).filter((id): id is string => id != null))];
  const techs = techIds.length > 0 ? await prisma.technician.findMany({ where: { id: { in: techIds } }, select: { id: true, name: true } }) : [];
  const techMap = new Map(techs.map((t) => [t.id, t.name]));
  res.json(receipts.map((r) => ({ ...r, technicianName: r.technicianId ? techMap.get(r.technicianId) ?? null : null })));
}));

/**
 * Operator-triggered re-parse for a single receipt stuck in pending_review
 * (Unit 2, Kyle 2026-09-12 — the binding condition on making pending_review
 * the normal intermediate state: a stuck receipt must be visible AND
 * retryable). Reuses applyVisionParse, so it only fills fields still empty
 * and is safe to call repeatedly — it upserts nothing and can never create a
 * second row. A Vision failure leaves the receipt exactly as it was.
 */
healthRecordAdminRouter.post("/receipts/:id/reparse", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const existing = await prisma.receipt.findUnique({ where: { id }, select: { id: true, imageData: true } });
  if (!existing) {
    res.status(404).json({ success: false, error: { code: "not_found", message: "Receipt not found" } });
    return;
  }
  if (!existing.imageData) {
    res.status(409).json({ success: false, error: { code: "conflict", message: "No photo bytes on this receipt to parse." } });
    return;
  }
  const result = await applyVisionParse(id);
  const after = await prisma.receipt.findUniqueOrThrow({
    where: { id },
    select: { id: true, amount: true, vendor: true, category: true, status: true, lineItems: true, purchaseOrderId: true, jobId: true, reconciliationNote: true },
  });
  res.json({ success: true, parsed: result.parsed, data: after });
}));

/**
 * One receipt, for the receipt DRAWER (2026-09-20, drawers plan Phase 1: "the record carries
 * its own actions"). Every other receipt read is a list (the review queue, the needs-a-PO queue,
 * a job's receipts); a drawer keyed by `?receipt=<id>` needs the one row. Never the image bytes —
 * `hasImage` says whether to offer the viewer, and the bytes come from /receipts/:id/image on
 * demand, same as the job list does. Same account/job label as the review queue so the drawer
 * reads like the row that opened it.
 */
healthRecordAdminRouter.get("/receipts/:id", asyncHandler(async (req, res) => {
  const r = await prisma.receipt.findUnique({
    where: { id: readParam(req, "id") },
    select: {
      id: true, jobId: true, category: true, vendor: true, amount: true, lineItems: true, source: true, status: true,
      technicianId: true, imageMime: true, receivedAt: true, createdAt: true,
      purchaseOrderId: true, purchaseOrder: { select: { number: true, status: true } },
      poWaivedAt: true, poWaivedReason: true, reconciliationNote: true,
    },
  });
  if (!r) {
    res.status(404).json({ error: "Receipt not found" });
    return;
  }
  const job = r.jobId
    ? await prisma.visit.findUnique({
        where: { id: r.jobId },
        select: {
          id: true, jobType: true, purpose: true,
          customer: { select: { id: true, name: true } },
          property: { select: { addressLine1: true, city: true } },
        },
      })
    : null;
  res.json({
    id: r.id,
    jobId: r.jobId,
    category: r.category,
    vendor: r.vendor,
    amount: r.amount,
    lineItems: (() => { try { return r.lineItems ? JSON.parse(r.lineItems) : []; } catch { return []; } })(),
    source: r.source,
    status: r.status,
    technicianId: r.technicianId,
    receivedAt: r.receivedAt,
    createdAt: r.createdAt,
    hasImage: Boolean(r.imageMime),
    imageMime: r.imageMime,
    purchaseOrderId: r.purchaseOrderId,
    purchaseOrderNumber: r.purchaseOrder?.number ?? null,
    purchaseOrderStatus: r.purchaseOrder?.status ?? null,
    poWaivedAt: r.poWaivedAt,
    poWaivedReason: r.poWaivedReason,
    reconciliationNote: r.reconciliationNote,
    accountId: job?.customer.id ?? null,
    accountName: job?.customer.name ?? null,
    jobLabel: job
      ? `${job.jobType || job.purpose || "Job"} — ${job.property.addressLine1}, ${job.property.city}`
      : "Not tied to a job",
    // Kyle, 2026-09-09: purchasing starts with a PO; a materials receipt without one is flagged.
    needsPo: r.category === "materials" && !r.purchaseOrderId && !r.poWaivedAt,
  });
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

/**
 * The write behind PATCH /receipts/:id, shared by the office door
 * (healthRecordAdminRouter, below) and the tech twin
 * (healthRecordTechRouter.patch("/receipts/:id"), above) — one place that
 * moves the PO link, so the two doors can never disagree about what
 * attaching/detaching does. A receipt is proof, never money (2026-09-19):
 * none of these fields move a cost figure anywhere. Returns null when the
 * receipt does not exist.
 */
async function applyReceiptEdit(
  id: string,
  patch: {
    jobId?: string | null;
    category?: "materials" | "gas" | "maintenance" | "overhead" | "permit" | "inspection";
    vendor?: string | null;
    amount?: number;
    lineItems?: unknown;
    status?: "pending_review" | "confirmed";
    reconciliationNote?: string | null;
    purchaseOrderId?: string | null;
    receivedAt?: Date;
  },
  actor: string,
) {
  const existing = await prisma.receipt.findUnique({ where: { id }, select: { id: true, jobId: true, purchaseOrderId: true } });
  if (!existing) return null;

  const receipt = await prisma.receipt.update({
    where: { id },
    data: {
      ...(patch.jobId !== undefined ? { jobId: patch.jobId } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.vendor !== undefined ? { vendor: patch.vendor } : {}),
      ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
      ...(patch.lineItems !== undefined ? { lineItems: patch.lineItems ? JSON.stringify(patch.lineItems) : null } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.receivedAt !== undefined ? { receivedAt: patch.receivedAt } : {}),
      ...(patch.reconciliationNote !== undefined ? { reconciliationNote: patch.reconciliationNote } : {}),
    },
    select: { id: true, jobId: true, category: true, vendor: true, amount: true, status: true },
  });

  if (patch.purchaseOrderId !== undefined && patch.purchaseOrderId !== existing.purchaseOrderId) {
    if (patch.purchaseOrderId) await attachReceiptToPurchaseOrder(id, patch.purchaseOrderId, actor);
    else await detachReceiptFromPurchaseOrder(id, actor);
  }
  const after = await prisma.receipt.findUniqueOrThrow({ where: { id }, select: { purchaseOrderId: true, jobId: true } });
  return { ...receipt, jobId: after.jobId, purchaseOrderId: after.purchaseOrderId };
}

/**
 * The write behind DELETE /receipts/:id, shared the same way as
 * applyReceiptEdit above. Since 2026-09-19 a receipt is proof, never money,
 * so removing one changes no cost figure. Returns false when the receipt
 * does not exist.
 */
async function removeReceiptRecord(id: string): Promise<boolean> {
  const existing = await prisma.receipt.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return false;
  await prisma.receipt.delete({ where: { id } });
  return true;
}

healthRecordAdminRouter.patch("/receipts/:id", asyncHandler(async (req, res) => {
  const body = z.object({
    jobId: z.string().nullable().optional(),
    category: z.enum(["materials", "gas", "maintenance", "overhead", "permit", "inspection"]).optional(),
    vendor: z.string().nullable().optional(),
    amount: z.number().nonnegative().optional(),
    lineItems: z.unknown().optional(),
    status: z.enum(["pending_review", "confirmed"]).optional(),
    // 2026-09-18 (Unit 2): the office's exit from a reconciliation flag — clear it
    // (null) once they've checked the receipt by hand, or edit the text. Standing
    // rule: nothing this app creates is permanent without a way out from where
    // it's shown, and this queue is where the note is shown.
    reconciliationNote: z.string().nullable().optional(),
    // Kyle, 2026-09-09: attach (string) or detach (null) the PO this receipt verifies.
    purchaseOrderId: z.string().nullable().optional(),
    // 2026-09-14 (legacy purchase close-out, Unit 4): the only correction path for a
    // Vision year mis-parse (e.g. 2022 instead of 2026) — see receiptVision.ts's
    // PLAUSIBLE_PURCHASE_DATE_WINDOW.
    //
    // A calendar day arrives as "YYYY-MM-DD" and is anchored at NOON UTC, the
    // convention every other date door here uses (app.ts:5544,
    // health-record.ts:1921, inboundSms.ts:122, receiptVision.ts:77,
    // agent-shared.ts:76 "Noon UTC to avoid date boundary issues"). Fixed
    // 2026-09-15: z.coerce.date() read a bare date as MIDNIGHT UTC, which is
    // 7pm the PREVIOUS day in America/Chicago — Kyle typed 2026-09-08 and the
    // receipt filed itself under 9/7. Mid-month that is only cosmetic; on the
    // 1st it moves the receipt into the previous month of the P&L, because
    // yearLedger buckets by receivedAt (routes/financials.ts:367-368).
    // A full timestamp is passed through untouched.
    receivedAt: z
      .union([z.string(), z.date()])
      .optional()
      .transform((v) => {
        if (v === undefined) return undefined;
        if (v instanceof Date) return v;
        const day = /^\d{4}-\d{2}-\d{2}$/.exec(v.trim());
        return day ? new Date(`${v.trim()}T12:00:00Z`) : new Date(v);
      })
      .refine((v) => v === undefined || !Number.isNaN(v.getTime()), "receivedAt is not a date"),
  }).parse(req.body);

  const updated = await applyReceiptEdit(readParam(req, "id"), body, "owner");
  if (!updated) {
    res.status(404).json({ error: "Receipt not found" });
    return;
  }
  res.json(updated);
}));

/**
 * Remove a receipt (Kyle, 2026-09-08 — the account page confirms and removes
 * receipts in place). Since 2026-09-19 a receipt is proof, never money, so
 * removing one changes no cost figure.
 */
healthRecordAdminRouter.delete("/receipts/:id", asyncHandler(async (req, res) => {
  const removed = await removeReceiptRecord(readParam(req, "id"));
  if (!removed) {
    res.status(404).json({ error: "Receipt not found" });
    return;
  }
  res.status(204).end();
}));

healthRecordAdminRouter.use(zodErrorHandler);
