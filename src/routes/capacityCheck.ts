/**
 * NEC Article 220 capacity checks.
 *
 * The decision rule this encodes, in the owner's words:
 *
 *   Run 220.83 first. If it clears the existing service, quote the addition. If
 *   it doesn't clear, quote a service upgrade — don't burn a customer's time on
 *   a 30-day 220.87 study unless they've explicitly said they want to avoid the
 *   upgrade cost.
 *
 * So the failure path's primary action is "quote the upgrade". The 220.87 study
 * sits behind an explicit acknowledgement AND a server-side gate, because hiding
 * a button is not a guardrail — the check has to hold whoever calls the API.
 *
 * Two routers, mirroring health-record.ts: technicians run checks in the field
 * on a bearer token; ordering a priced study is the owner's.
 */

import express from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { asyncHandler, readParam } from "./agent-helpers";
import { technicianAuth, zodErrorHandler, type TechRequest } from "./technicianAuth";
import { parseJsonObject } from "../lib/json";
import {
  capacityCheck220_83,
  existingDemandAmps,
  type DemandRecord,
  type LoadCalcInput,
  type LoadItem,
} from "../../shared/loadcalc/loadcalc";
import { scheduleJob } from "../services/scheduling";

const loadItemSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  label: z.string().min(1),
  nameplateVA: z.number().nonnegative().optional(),
  nameplateKW: z.number().nonnegative().optional(),
  amps: z.number().nonnegative().optional(),
  volts: z.number().positive().optional(),
  continuous: z.boolean().optional(),
  nameplateRead: z.boolean().optional(),
  onLaundryCircuit: z.boolean().optional(),
  heatPump: z.object({
    compressorVA: z.number().nonnegative(),
    supplementalVA: z.number().nonnegative(),
    lockout: z.boolean(),
  }).optional(),
}).passthrough();

const createSchema = z.object({
  // Client UUID — the offline queue retries, and a duplicated calculation on a
  // customer's record is a duplicated conversation.
  id: z.string().min(1),
  visitId: z.string().nullable().optional(),
  propertyId: z.string().min(1),
  serviceAmps: z.number().positive(),
  serviceVoltage: z.literal(240).default(240),
  floorAreaSqFt: z.number().nonnegative(),
  loads: z.array(loadItemSchema),
  newLoads: z.array(loadItemSchema).default([]),
  newLoadLabel: z.string().nullable().optional(),
  supersedesId: z.string().nullable().optional(),
});

/**
 * Run 220.83 and persist it.
 *
 * The calculation runs HERE, on the server, from the raw inputs — never trusting
 * a `fits` the client computed. The 220.87 gate reads this row, so a client that
 * could write its own verdict could unlock the study by asserting failure.
 */
async function runCapacityCheck(
  body: z.infer<typeof createSchema>,
  technicianId: string | null,
) {
  const property = await prisma.property.findUnique({
    where: { id: body.propertyId },
    select: { id: true, customerId: true },
  });
  if (!property) return { error: `Property ${body.propertyId} not found` as const };

  const input: LoadCalcInput = {
    mode: "tech",
    occupancy: "dwellingSingleFamily",
    serviceAmps: body.serviceAmps,
    serviceVoltage: 240,
    floorAreaSqFt: body.floorAreaSqFt,
    loads: body.loads as unknown as LoadItem[],
  };
  const result = capacityCheck220_83(input, body.newLoads as unknown as LoadItem[]);

  const data = {
    visitId: body.visitId ?? null,
    propertyId: property.id,
    customerId: property.customerId,
    technicianId,
    method: "220.83",
    serviceAmps: Math.round(body.serviceAmps),
    serviceVoltage: 240,
    floorAreaSqFt: Math.round(body.floorAreaSqFt),
    variant: result.variant,
    newLoadLabel: body.newLoadLabel ?? (body.newLoads.map((l) => l.label).join(", ") || null),
    calculatedAmps: result.amps,
    loadPct: result.loadPct,
    fits: result.fits,
    qualifies: true,
    inputJson: JSON.stringify({ input, newLoads: body.newLoads }),
    resultJson: JSON.stringify(result),
    supersedesId: body.supersedesId ?? null,
  };

  const record = await prisma.capacityCheck.upsert({
    where: { id: body.id },
    create: { id: body.id, ...data },
    update: data,
  });
  return { record, result };
}

// ─── TECH ROUTER ───────────────────────────────────────────────────────────────

export const capacityCheckTechRouter = express.Router();
capacityCheckTechRouter.use(technicianAuth);

capacityCheckTechRouter.post("/", asyncHandler(async (req: TechRequest, res) => {
  const body = createSchema.parse(req.body);
  const outcome = await runCapacityCheck(body, req.technician!.id);
  if ("error" in outcome) {
    res.status(404).json({ success: false, error: { code: "not_found", message: outcome.error } });
    return;
  }
  res.status(201).json({
    success: true,
    data: {
      id: outcome.record.id,
      ...outcome.result,
      // The next step, decided by the calculation rather than by whoever is
      // holding the phone.
      nextStep: outcome.result.fits
        ? "quote_addition"
        : "quote_service_upgrade",
    },
  });
}));

capacityCheckTechRouter.get("/property/:propertyId", asyncHandler(async (req: TechRequest, res) => {
  const checks = await prisma.capacityCheck.findMany({
    where: { propertyId: readParam(req, "propertyId") },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  res.json({ success: true, data: checks });
}));

capacityCheckTechRouter.use(zodErrorHandler);

// ─── ADMIN ROUTER ──────────────────────────────────────────────────────────────

export const capacityCheckAdminRouter = express.Router();

capacityCheckAdminRouter.post("/", asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  const outcome = await runCapacityCheck(body, null);
  if ("error" in outcome) {
    res.status(404).json({ error: outcome.error });
    return;
  }
  res.status(201).json({
    id: outcome.record.id,
    ...outcome.result,
    nextStep: outcome.result.fits ? "quote_addition" : "quote_service_upgrade",
  });
}));

capacityCheckAdminRouter.get("/", asyncHandler(async (req, res) => {
  const query = z.object({
    propertyId: z.string().optional(),
    visitId: z.string().optional(),
  }).parse(req.query);

  const checks = await prisma.capacityCheck.findMany({
    where: {
      ...(query.propertyId ? { propertyId: query.propertyId } : {}),
      ...(query.visitId ? { visitId: query.visitId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json(checks);
}));

const orderStudySchema = z.object({
  /**
   * The customer has been told the service does not calculate and has said they
   * want to try to avoid the upgrade. Without this the study is not offered.
   */
  customerDeclinedUpgrade: z.literal(true),
  /** What they actually said, for the record. */
  customerStatement: z.string().min(1),
  startDate: z.string().min(1), // YYYY-MM-DD for the recorder install
  source: z.enum(["utility_12mo", "recorded_30day"]).default("recorded_30day"),
});

/** 30 days of recording, plus a day, so the removal visit is never early. */
export const DEMAND_STUDY_DAYS = 31;

/**
 * POST /capacity-checks/:id/order-demand-study
 *
 * Three conditions, all enforced here rather than in a form:
 *   1. the referenced check is a 220.83, and
 *   2. it did NOT clear the existing service, and
 *   3. the customer has explicitly said they want to avoid the upgrade.
 *
 * Ordering creates two scheduled, priced visits — install and removal, 31 days
 * apart. Two trips is the honest shape of this service, and putting the delay on
 * the calendar is the point: everybody can see what a study actually costs in
 * time before agreeing to one.
 */
capacityCheckAdminRouter.post("/:id/order-demand-study", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const body = orderStudySchema.parse(req.body);

  const check = await prisma.capacityCheck.findUnique({ where: { id } });
  if (!check) {
    res.status(404).json({ error: "Capacity check not found" });
    return;
  }
  if (check.method !== "220.83") {
    res.status(409).json({
      error: "A demand study can only follow a 220.83 check — run that first.",
    });
    return;
  }
  if (check.fits) {
    res.status(409).json({
      error:
        "This service already calculates for the added load under 220.83. Quote the addition — " +
        "a 30-day metered demand study would cost the customer time and money to confirm what is already known.",
    });
    return;
  }
  if (check.studyOrderedAt) {
    res.status(409).json({ error: "A demand study has already been ordered for this check." });
    return;
  }

  const property = await prisma.property.findUnique({
    where: { id: check.propertyId },
    select: { id: true, customerId: true },
  });
  if (!property) {
    res.status(404).json({ error: "Property not found" });
    return;
  }

  const start = new Date(`${body.startDate}T12:00:00Z`);
  const removal = new Date(start);
  removal.setDate(removal.getDate() + DEMAND_STUDY_DAYS);
  const removalDate = removal.toISOString().slice(0, 10);

  const note =
    `220.87 metered demand study ordered after a 220.83 check showed ${check.calculatedAmps} A ` +
    `on a ${check.serviceAmps} A service. Customer elected to pursue the study rather than a ` +
    `service upgrade: "${body.customerStatement}"\n\n` +
    "This study measures the property as it was actually used during the recording window. " +
    "A change in occupancy or usage changes the answer. If the study does not clear the service, " +
    "the upgrade is still required and the study fee is spent.";

  const install = await prisma.visit.create({
    data: {
      propertyId: property.id,
      customerId: property.customerId,
      mode: "service",
      status: "contracted",
      jobType: "220.87 metered demand study — recorder install",
      purpose: "Install recording ammeter for a 30-day metered demand study (NEC 220.87)",
      estimatedJobLength: 1.5,
      notes: note,
    },
  });
  const removalVisit = await prisma.visit.create({
    data: {
      propertyId: property.id,
      customerId: property.customerId,
      mode: "service",
      status: "contracted",
      jobType: "220.87 metered demand study — removal & calculation",
      purpose: "Remove the recorder and complete the 220.87 calculation",
      estimatedJobLength: 1.5,
      notes: `${note}\n\nRecording window opened ${body.startDate}.`,
    },
  });

  // scheduleJob owns the Google event, the SlotHold, the confirmation and the
  // tech notification, and rolls the calendar back if an SMS fails. Writing
  // scheduledStart directly would skip all of it.
  const scheduled: { visitId: string; date: string; error?: string }[] = [];
  for (const [visit, date] of [[install, body.startDate], [removalVisit, removalDate]] as const) {
    try {
      await scheduleJob(visit.id, date);
      scheduled.push({ visitId: visit.id, date });
    } catch (error) {
      // The visits exist and are contracted; only the calendar failed. Report it
      // rather than rolling back work the office can finish by hand.
      scheduled.push({
        visitId: visit.id,
        date,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const updated = await prisma.capacityCheck.update({
    where: { id },
    data: {
      studyInstallVisitId: install.id,
      studyRemovalVisitId: removalVisit.id,
      studyOrderedAt: new Date(),
    },
  });

  res.status(201).json({
    capacityCheckId: updated.id,
    source: body.source,
    installVisitId: install.id,
    removalVisitId: removalVisit.id,
    recordingWindow: { start: body.startDate, end: removalDate, days: DEMAND_STUDY_DAYS },
    scheduled,
  });
}));

const completeStudySchema = z.object({
  /** Client UUID for the resulting 220.87 record. */
  id: z.string().min(1),
  measuredMaxDemandVA: z.number().nonnegative(),
  source: z.enum(["utility_12mo", "recorded_30day"]),
  monthsOfData: z.number().int().nonnegative().optional(),
  recordedDays: z.number().int().nonnegative().optional(),
  intervalMinutes: z.number().int().positive().default(15),
  windowStart: z.string().optional(),
  windowEnd: z.string().optional(),
});

/**
 * Complete the study: the recorder came off, here is the maximum demand.
 *
 * Writes a NEW record rather than editing the 220.83 one — they are different
 * calculations under different code sections, and both were issued.
 */
capacityCheckAdminRouter.post("/:id/complete-demand-study", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const body = completeStudySchema.parse(req.body);

  const check = await prisma.capacityCheck.findUnique({ where: { id } });
  if (!check) {
    res.status(404).json({ error: "Capacity check not found" });
    return;
  }
  if (!check.studyOrderedAt) {
    res.status(409).json({ error: "No demand study was ordered for this check." });
    return;
  }

  const stored = parseJsonObject<{ newLoads?: LoadItem[] }>(check.inputJson);
  const newLoads = stored?.newLoads ?? [];
  const record: DemandRecord = {
    source: body.source,
    measuredMaxDemandVA: body.measuredMaxDemandVA,
    monthsOfData: body.monthsOfData,
    recordedDays: body.recordedDays,
    intervalMinutes: body.intervalMinutes,
    windowStart: body.windowStart,
    windowEnd: body.windowEnd,
  };
  const result = existingDemandAmps(record, newLoads, check.serviceAmps, check.serviceVoltage);

  const data = {
    visitId: check.studyRemovalVisitId,
    propertyId: check.propertyId,
    customerId: check.customerId,
    technicianId: null,
    method: "220.87",
    serviceAmps: check.serviceAmps,
    serviceVoltage: check.serviceVoltage,
    floorAreaSqFt: check.floorAreaSqFt,
    variant: null,
    newLoadLabel: check.newLoadLabel,
    calculatedAmps: result.amps,
    loadPct: result.loadPct,
    fits: result.fits,
    qualifies: result.qualifies,
    inputJson: JSON.stringify({ record, newLoads }),
    resultJson: JSON.stringify(result),
    supersedesId: check.id,
  };

  const created = await prisma.capacityCheck.upsert({
    where: { id: body.id },
    create: { id: body.id, ...data },
    update: data,
  });

  res.status(201).json({
    id: created.id,
    ...result,
    // Even a passing study doesn't end the conversation: if it failed to
    // qualify, or the window missed the peak season, the number is not
    // defensible and saying so here is cheaper than saying it in a deposition.
    nextStep: !result.qualifies
      ? "data_insufficient"
      : result.fits
        ? "quote_addition"
        : "quote_service_upgrade",
  });
}));

capacityCheckAdminRouter.use(zodErrorHandler);
