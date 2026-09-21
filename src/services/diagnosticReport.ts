/**
 * THE CIRCUIT DIAGNOSTIC REPORT — the server half.
 *
 * Kyle, 2026-09-20: "I need the field app to have its own diagnostics report. I
 * am going to charge $25 - $50 for each outlet that is reviewed rather than a
 * flat fee. Price depends on difficulty of access." And: "the tech ... can click
 * and add outlet button. This adds an outlet systematically as he is doing the
 * diagnostics, does the measurements at the outlet, takes the pictures, notes if
 * anything was fixed, and moves onto the next one."
 *
 * This is a new report TYPE in the field-inspection machinery, not a new
 * machine: PWA-minted ids (so a queued retry is idempotent), photo bytes in
 * Postgres beside InspectionPhoto, the same pdfkit generator and the same
 * branded-email delivery log.
 *
 * Everything about WHY the shapes are what they are lives in
 * `shared/diagnostics.ts` — the contract both sides import. Read that first.
 *
 * THREE RULES THIS FILE ENFORCES, none of them cosmetic:
 *
 * 1. SCOPE IS THE CIRCUIT. `coverage` prints on the face of the document, and
 *    `partial` is refused without a note saying where the walk stopped. The
 *    report may never imply coverage it does not carry — that sentence is the
 *    warranty defence on a callback.
 *
 * 2. AN OUTLET WITH NO PHOTO IS A CLAIM, NOT A RECORD. The push refuses an
 *    outlet with an empty `photoIds`. The phone refuses it first; this is the
 *    door that makes it true.
 *
 * 3. THE LINE BETWEEN INCLUDED AND BILLABLE. `fixed` is wiring work done during
 *    the diagnostic and is INCLUDED in the diagnostic price. `equipmentDefective`
 *    is faulty or damaged equipment and is NOT — it becomes the resolutions
 *    change order, seeded here from the recorded data.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  DEVICE_TYPES,
  DIFFICULTY_TIERS,
  ZERO_TIERS,
  coverageStatement,
  countByTier,
  moneySummary,
  type DiagnosticDeviceType,
  type DiagnosticDifficulty,
  type DiagnosticOutletPayload,
  type DiagnosticQuoteContext,
  type DiagnosticReportPush,
  type DiagnosticReportView,
  type TierCounts,
} from "../../shared/diagnostics";
import { LIVE_SIGNED_CHANGE_ORDER, signedRootForJob } from "./invoiceGroup";

export class DiagnosticError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "DiagnosticError";
  }
}

const DEVICE_SET = new Set<string>(DEVICE_TYPES);
const TIER_SET = new Set<string>(DIFFICULTY_TIERS);

/** Rows shaped exactly as prisma returns them, with the outlets included. */
type ReportWithOutlets = Prisma.DiagnosticReportGetPayload<{
  include: { outlets: true; technician: { select: { name: true } }; _count: { select: { deliveries: true } } };
}>;

export const REPORT_INCLUDE = {
  outlets: { orderBy: { sequence: "asc" } },
  technician: { select: { name: true } },
  _count: { select: { deliveries: true } },
} as const;

// ─── The quoted side ─────────────────────────────────────────────────────────

/**
 * What the signed estimate bought, per difficulty tier.
 *
 * NO NEW PRICING CONCEPT (the plan's own instruction): three tiers are three
 * lines of ONE price-book item, and `PriceBookDifficulty` already exists.
 *
 * ── THE FINDING THAT SHAPED THIS FUNCTION ────────────────────────────────────
 * `IssuedEstimateLine` DOES NOT CARRY `difficulty`. It freezes itemId,
 * description, quantity, unitPrice, option, laborHours, materialSell/Cost — the
 * tier is dropped at graduation. So the per-tier counts cannot be read off the
 * signed document at all, which the plan assumed they could.
 *
 * They are read off the DRAFT the document graduated from instead
 * (`IssuedEstimate.draftId`, `onDelete: Restrict` — "a draft that has been
 * issued to a customer is not deletable", so it is always there), whose lines
 * DO carry `difficulty`. Confirmed lines only, taken options only — the same
 * population that graduated.
 *
 * And because that derivation has a failure mode nobody would notice on a
 * phone, these numbers are only a PRE-FILL: the technician confirms or corrects
 * them before the first outlet, and the report freezes what he confirmed.
 */
export async function diagnosticQuoteContext(
  prisma: PrismaClient,
  visitId: string,
): Promise<DiagnosticQuoteContext & { candidates: { itemId: string; description: string; quantity: number }[] }> {
  const empty = {
    diagnosticItemId: null,
    source: "none" as const,
    quoted: { ...ZERO_TIERS },
    estimateNumber: null,
    candidates: [] as { itemId: string; description: string; quantity: number }[],
  };

  const root = await signedRootForJob(prisma, visitId);
  if (!root) return empty;

  const docs = await prisma.issuedEstimate.findMany({
    where: { OR: [{ id: root.id }, { changeOrderForId: root.id, ...LIVE_SIGNED_CHANGE_ORDER }] },
    select: {
      id: true,
      number: true,
      draftId: true,
      selectedOptions: true,
      lines: { select: { itemId: true, description: true, quantity: true, option: true } },
    },
  });
  if (docs.length === 0) return empty;

  // Distinct items actually on the signed documents, taken options only. This is
  // the picker the phone shows when the item cannot be resolved automatically —
  // a short, real list, never the whole catalog.
  const candidates = new Map<string, { itemId: string; description: string; quantity: number }>();
  for (const doc of docs) {
    const chosen = new Set(doc.selectedOptions ?? []);
    for (const line of doc.lines) {
      if (chosen.size > 0 && !chosen.has(line.option)) continue;
      const prev = candidates.get(line.itemId);
      if (prev) prev.quantity += line.quantity;
      else candidates.set(line.itemId, { itemId: line.itemId, description: line.description, quantity: line.quantity });
    }
  }

  // 1. An explicit configuration wins, when Kyle has set one. Read-only here —
  //    nothing in this build writes Rate Config.
  const configured = await prisma.priceBookRateConfig.findUnique({ where: { key: "diagnosticItemId" } });
  let itemId: string | null = null;
  let source: DiagnosticQuoteContext["source"] = "none";
  if (configured?.textValue && candidates.has(configured.textValue)) {
    itemId = configured.textValue;
    source = "config";
  } else {
    // 2. Otherwise: exactly one item on the signed work that reads as a
    //    diagnostic. Two matches is ambiguous and resolves to none rather than
    //    guessing — the phone then asks the technician which one.
    const matched = [...candidates.values()].filter((c) => /diagnos/i.test(c.description) || /diagnos/i.test(c.itemId));
    if (matched.length === 1) {
      itemId = matched[0].itemId;
      source = "matched";
    }
  }

  const quoted = itemId ? await quotedTiersForItem(prisma, docs, itemId) : { ...ZERO_TIERS };
  return {
    diagnosticItemId: itemId,
    source,
    quoted,
    estimateNumber: docs.find((d) => d.id === root.id)?.number ?? docs[0].number,
    candidates: [...candidates.values()],
  };
}

async function quotedTiersForItem(
  prisma: PrismaClient,
  docs: { draftId: string; selectedOptions: string[] }[],
  itemId: string,
): Promise<TierCounts> {
  const counts: TierCounts = { ...ZERO_TIERS };
  const lines = await prisma.priceBookDraftLine.findMany({
    where: { draftId: { in: docs.map((d) => d.draftId) }, itemId, state: "CONFIRMED" },
    select: { draftId: true, quantity: true, difficulty: true, option: true },
  });
  const optionsByDraft = new Map(docs.map((d) => [d.draftId, new Set(d.selectedOptions ?? [])]));
  for (const line of lines) {
    const chosen = optionsByDraft.get(line.draftId);
    if (chosen && chosen.size > 0 && !chosen.has(line.option)) continue;
    counts[line.difficulty as DiagnosticDifficulty] += line.quantity;
  }
  return {
    NORMAL: Math.round(counts.NORMAL),
    DIFFICULT: Math.round(counts.DIFFICULT),
    VERY_DIFFICULT: Math.round(counts.VERY_DIFFICULT),
  };
}

// ─── The push ────────────────────────────────────────────────────────────────

/** Every hard rule runs BEFORE anything is written — a violating report must not exist in part. */
export function validatePush(push: DiagnosticReportPush): void {
  if (push.coverage === "partial" && !(push.coverageNote ?? "").trim()) {
    throw new DiagnosticError(
      422,
      "coverage_note_required",
      "A partial walk has to say where it stopped and why. The report never implies coverage it does not carry.",
    );
  }
  const seen = new Set<string>();
  for (const outlet of push.outlets) {
    if (seen.has(outlet.id)) {
      throw new DiagnosticError(422, "duplicate_outlet", `Outlet ${outlet.id} appears twice in this push.`);
    }
    seen.add(outlet.id);
    if (!DEVICE_SET.has(outlet.deviceType)) {
      throw new DiagnosticError(422, "bad_device_type", `"${outlet.deviceType}" is not a device type this report knows.`);
    }
    if (!TIER_SET.has(outlet.difficulty)) {
      throw new DiagnosticError(422, "bad_difficulty", `"${outlet.difficulty}" is not a difficulty tier.`);
    }
    if (!(outlet.locationLabel ?? "").trim()) {
      throw new DiagnosticError(422, "outlet_needs_location", "Every outlet needs a location — the report has to say where it was.");
    }
    if (outlet.photoIds.length === 0) {
      throw new DiagnosticError(
        422,
        "outlet_needs_photo",
        `${outlet.locationLabel}: an outlet with no photo is a claim, not a record. Take one before moving on.`,
      );
    }
    if (outlet.equipmentDefective && !(outlet.defectDescription ?? "").trim()) {
      throw new DiagnosticError(
        422,
        "defect_needs_description",
        `${outlet.locationLabel}: damaged or defective equipment is what the resolutions change order quotes — say what is wrong with it.`,
      );
    }
  }
}

/**
 * Upsert the report and SYNC its outlets.
 *
 * Sync, not replace: rows in the push are upserted by the phone's own id, rows
 * absent from it are deleted. A queued retry therefore lands on the same rows
 * (createdAt survives), and an outlet the technician deleted on the phone
 * actually disappears here. Photos are keyed to the REPORT, never to an outlet,
 * so nothing in this path can cascade evidence away.
 */
export async function pushDiagnosticReport(
  prisma: PrismaClient,
  push: DiagnosticReportPush,
  ctx: { visitId: string; propertyId: string; customerId: string; technicianId: string },
): Promise<ReportWithOutlets> {
  validatePush(push);

  const existing = await prisma.diagnosticReport.findUnique({
    where: { id: push.reportId },
    select: { status: true },
  });
  if (existing?.status === "void") {
    throw new DiagnosticError(
      409,
      "report_void",
      "That diagnostic was voided. Start a new one — a voided report is kept as it was, never edited back to life.",
    );
  }

  const head = {
    visitId: ctx.visitId,
    propertyId: ctx.propertyId,
    customerId: ctx.customerId,
    technicianId: ctx.technicianId,
    reportDate: new Date(push.reportDate),
    complaint: push.complaint,
    circuitLabel: push.circuitLabel,
    circuitNumber: push.circuitNumber,
    panelLocation: push.panelLocation,
    breakerRating: push.breakerRating,
    breakerInspected: push.breakerInspected,
    coverage: push.coverage,
    coverageNote: push.coverageNote,
    summary: push.summary,
    diagnosticItemId: push.diagnosticItemId,
    quotedNormal: push.quotedNormal,
    quotedDifficult: push.quotedDifficult,
    quotedVeryDifficult: push.quotedVeryDifficult,
    status: push.status,
    completedAt: push.status === "complete" ? new Date() : null,
    appVersion: push.appVersion ?? null,
    syncedAt: new Date(),
  };

  // The diagnostic item link is a FK. A phone carrying an item id the catalog no
  // longer has must not fail the whole push — the counts are the money record.
  if (head.diagnosticItemId) {
    const atomic = await prisma.priceBookAtomic.findUnique({
      where: { itemId: head.diagnosticItemId },
      select: { itemId: true },
    });
    if (!atomic) head.diagnosticItemId = null;
  }

  return prisma.$transaction(async (tx) => {
    const report = await tx.diagnosticReport.upsert({
      where: { id: push.reportId },
      create: { id: push.reportId, ...head },
      // completedAt is only ever SET, never cleared back to null by a later
      // in-progress retry arriving out of order.
      update: { ...head, ...(head.completedAt ? {} : { completedAt: undefined }) },
    });

    const keep = push.outlets.map((o) => o.id);
    await tx.diagnosticOutlet.deleteMany({
      where: { reportId: report.id, ...(keep.length > 0 ? { id: { notIn: keep } } : {}) },
    });
    for (const outlet of push.outlets) {
      const row = {
        reportId: report.id,
        sequence: outlet.sequence,
        locationLabel: outlet.locationLabel,
        deviceType: outlet.deviceType,
        deviceLabel: outlet.deviceLabel,
        enclosure: outlet.enclosure,
        gangs: outlet.gangs,
        circuitNumber: outlet.circuitNumber,
        difficulty: outlet.difficulty,
        vPhaseGround: outlet.vPhaseGround,
        vPhaseNeutral: outlet.vPhaseNeutral,
        vPhasePhase: outlet.vPhasePhase,
        terminationsTightened: outlet.terminationsTightened,
        corrosion: outlet.corrosion,
        corrosionNote: outlet.corrosionNote,
        findings: outlet.findings,
        fixed: outlet.fixed,
        equipmentDefective: outlet.equipmentDefective,
        defectDescription: outlet.defectDescription,
        photoIds: outlet.photoIds,
      };
      await tx.diagnosticOutlet.upsert({
        where: { id: outlet.id },
        create: { id: outlet.id, ...row },
        update: row,
      });
    }

    return tx.diagnosticReport.findUniqueOrThrow({ where: { id: report.id }, include: REPORT_INCLUDE });
  });
}

// ─── Reading it back ─────────────────────────────────────────────────────────

export function serializeDiagnosticReport(report: ReportWithOutlets): DiagnosticReportView {
  const outlets: DiagnosticOutletPayload[] = report.outlets.map((o) => ({
    id: o.id,
    sequence: o.sequence,
    locationLabel: o.locationLabel,
    deviceType: o.deviceType as DiagnosticDeviceType,
    deviceLabel: o.deviceLabel,
    enclosure: o.enclosure,
    gangs: o.gangs,
    circuitNumber: o.circuitNumber,
    difficulty: o.difficulty as DiagnosticDifficulty,
    vPhaseGround: o.vPhaseGround,
    vPhaseNeutral: o.vPhaseNeutral,
    vPhasePhase: o.vPhasePhase,
    terminationsTightened: o.terminationsTightened,
    corrosion: o.corrosion,
    corrosionNote: o.corrosionNote,
    findings: o.findings,
    fixed: o.fixed,
    equipmentDefective: o.equipmentDefective,
    defectDescription: o.defectDescription,
    photoIds: o.photoIds,
  }));
  const money = moneySummary(
    { NORMAL: report.quotedNormal, DIFFICULT: report.quotedDifficult, VERY_DIFFICULT: report.quotedVeryDifficult },
    countByTier(outlets),
  );
  return {
    id: report.id,
    visitId: report.visitId,
    propertyId: report.propertyId,
    customerId: report.customerId,
    technicianName: report.technician?.name ?? null,
    reportDate: report.reportDate.toISOString(),
    complaint: report.complaint,
    circuitLabel: report.circuitLabel,
    circuitNumber: report.circuitNumber,
    panelLocation: report.panelLocation,
    breakerRating: report.breakerRating,
    breakerInspected: report.breakerInspected,
    coverage: report.coverage as DiagnosticReportView["coverage"],
    coverageNote: report.coverageNote,
    coverageStatement: coverageStatement({
      coverage: report.coverage as DiagnosticReportView["coverage"],
      coverageNote: report.coverageNote,
      circuitLabel: report.circuitLabel,
      breakerInspected: report.breakerInspected,
      examinedTotal: money.examinedTotal,
    }),
    summary: report.summary,
    diagnosticItemId: report.diagnosticItemId,
    status: report.status as DiagnosticReportView["status"],
    completedAt: report.completedAt?.toISOString() ?? null,
    voidedAt: report.voidedAt?.toISOString() ?? null,
    voidReason: report.voidReason,
    changeOrderDraftId: report.changeOrderDraftId,
    money,
    defectCount: outlets.filter((o) => o.equipmentDefective).length,
    fixedCount: outlets.filter((o) => (o.fixed ?? "").trim().length > 0).length,
    deliveryCount: report._count.deliveries,
    outlets,
    updatedAt: report.updatedAt.toISOString(),
  };
}

export async function loadDiagnosticReport(prisma: PrismaClient, id: string): Promise<ReportWithOutlets | null> {
  return prisma.diagnosticReport.findUnique({ where: { id }, include: REPORT_INCLUDE });
}

// ─── The exits (Kyle's standing rule: nothing the app creates is permanent) ───

/**
 * VOID is the exit for a report that has been delivered; DELETE is the exit for
 * one that never left the building.
 *
 * A diagnostic the homeowner already holds is evidence in a warranty argument —
 * it is voided with a reason and kept exactly as it was. One that was never
 * emailed has no counterparty and is deleted outright, photos and all. Same
 * distinction the health-record revision path already makes ("the original was
 * never emailed — nothing stale to replace").
 */
export async function voidDiagnosticReport(
  prisma: PrismaClient,
  id: string,
  reason: string,
): Promise<ReportWithOutlets> {
  if (!reason.trim()) {
    throw new DiagnosticError(400, "reason_required", "Voiding a report takes a reason — the record has to say why.");
  }
  const existing = await prisma.diagnosticReport.findUnique({ where: { id }, select: { status: true } });
  if (!existing) throw new DiagnosticError(404, "not_found", "Diagnostic report not found.");
  if (existing.status === "void") {
    throw new DiagnosticError(409, "already_void", "That report is already void.");
  }
  await prisma.diagnosticReport.update({
    where: { id },
    data: { status: "void", voidedAt: new Date(), voidReason: reason.trim() },
  });
  return prisma.diagnosticReport.findUniqueOrThrow({ where: { id }, include: REPORT_INCLUDE });
}

export async function deleteDiagnosticReport(prisma: PrismaClient, id: string): Promise<void> {
  const report = await prisma.diagnosticReport.findUnique({
    where: { id },
    select: { id: true, _count: { select: { deliveries: true } } },
  });
  if (!report) throw new DiagnosticError(404, "not_found", "Diagnostic report not found.");
  if (report._count.deliveries > 0) {
    throw new DiagnosticError(
      409,
      "already_delivered",
      "The homeowner already has this report. Void it with a reason instead — a delivered document is never silently deleted.",
    );
  }
  // Outlets, photos and deliveries all cascade off the report.
  await prisma.diagnosticReport.delete({ where: { id } });
}

// ─── The resolutions change order ────────────────────────────────────────────

export interface ResolutionsResult {
  draftId: string;
  resumed: boolean;
  /** True when this is a change order on the signed invoice; false when nothing was signed. */
  isChangeOrder: boolean;
  changeOrderFor: string | null;
  /** Diagnostic overage lines actually seeded, per tier. */
  seeded: { difficulty: DiagnosticDifficulty; quantity: number; itemId: string }[];
  /** Defective equipment, written into the draft's scope for pricing. */
  defects: { locationLabel: string; defectDescription: string }[];
  note: string | null;
}

/**
 * Turn the recorded diagnostic into the quote for the fix.
 *
 * Kyle: "If a device, fixture, or equipment is found damaged or defective its
 * noted and the tech can use this report to build the resolutions estimate which
 * will always be a change order from a diagnostics."
 *
 * TWO THINGS GO ON IT, AND ONLY TWO:
 *
 *  · THE DIAGNOSTIC OVERAGE — outlets the circuit turned out to hold beyond the
 *    quoted count, each at its OWN difficulty tier, as quantity on the SAME
 *    price-book item that was quoted. That is arithmetic off recorded data, so
 *    it is seeded as real priced lines.
 *
 *  · THE DEFECTIVE EQUIPMENT — written into the draft's scope text, location by
 *    location, for a human to price. It is NOT auto-priced and must not be: the
 *    app does not invent catalog rows, and "a bad receptacle in the kitchen" is
 *    not a price-book item until somebody says which one. The photos are already
 *    behind every line of it.
 *
 * Wiring fixes made during the diagnostic appear NOWHERE here. They were paid
 * for by the diagnostic and they belong on the report, not on a second bill.
 */
export async function buildResolutionsChangeOrder(
  prisma: PrismaClient,
  reportId: string,
  actor: string,
): Promise<ResolutionsResult> {
  const { addLine } = await import("./atomicEstimateService");
  const report = await loadDiagnosticReport(prisma, reportId);
  if (!report) throw new DiagnosticError(404, "not_found", "Diagnostic report not found.");
  if (report.status === "void") {
    throw new DiagnosticError(409, "report_void", "That diagnostic is void — a voided record does not raise new work.");
  }

  const view = serializeDiagnosticReport(report);
  const defects = report.outlets
    .filter((o) => o.equipmentDefective)
    .map((o) => ({ locationLabel: o.locationLabel, defectDescription: (o.defectDescription ?? "").trim() }));
  const seeded: ResolutionsResult["seeded"] = [];

  // Already raised once — resume it. A second tap must never produce a second
  // draft the customer could be asked to sign twice.
  if (report.changeOrderDraftId) {
    const existing = await prisma.priceBookDraftEstimate.findUnique({
      where: { id: report.changeOrderDraftId },
      select: { id: true, status: true, changeOrderForId: true, changeOrderFor: { select: { number: true } } },
    });
    if (existing) {
      return {
        draftId: existing.id,
        resumed: true,
        isChangeOrder: Boolean(existing.changeOrderForId),
        changeOrderFor: existing.changeOrderFor?.number ?? null,
        seeded,
        defects,
        note: null,
      };
    }
  }

  const root = await signedRootForJob(prisma, report.visitId);
  const supplierId =
    (await prisma.priceBookRateConfig.findUnique({ where: { key: "activeSupplier" } }))?.textValue ?? "HD";

  const scopeLines = [
    `Resolutions from the ${report.circuitLabel} diagnostic of ${report.reportDate.toLocaleDateString("en-US", { timeZone: "America/Chicago" })}.`,
    view.coverageStatement,
  ];
  if (view.money.overageTotal > 0) {
    scopeLines.push(
      `${view.money.examinedTotal} outlets examined against ${view.money.quotedTotal} quoted — ` +
        `${view.money.overageTotal} beyond the quote, each at its own access tier.`,
    );
  }
  if (defects.length > 0) {
    scopeLines.push("Damaged or defective equipment found (photographed, on the diagnostic report):");
    for (const d of defects) scopeLines.push(`· ${d.locationLabel} — ${d.defectDescription}`);
  } else {
    scopeLines.push("No damaged or defective equipment was recorded on this diagnostic.");
  }

  const draft = await prisma.priceBookDraftEstimate.create({
    data: {
      title: root ? `Resolutions — ${report.circuitLabel} (change order on ${root.number})` : `Resolutions — ${report.circuitLabel}`,
      ...(root ? { changeOrderForId: root.id } : {}),
      customerId: report.customerId,
      visitId: report.visitId,
      supplierId,
      jobDescription: scopeLines.join("\n"),
    },
  });

  // The overage, at each tier's own price. Skipped entirely when the diagnostic
  // was not quoted per outlet — the report still stands, the math just has no
  // item to hang on.
  let note: string | null = null;
  if (report.diagnosticItemId) {
    for (const tier of DIFFICULTY_TIERS) {
      const qty = view.money.overage[tier];
      if (qty <= 0) continue;
      try {
        await addLine(prisma, draft.id, {
          itemId: report.diagnosticItemId,
          quantity: qty,
          quantitySource: "COUNT",
          difficulty: tier,
          option: "A",
          note: "Outlets found beyond the quoted count — the circuit decides the count, not the quote (RCE standard).",
          confirmedBy: actor,
        });
        seeded.push({ difficulty: tier, quantity: qty, itemId: report.diagnosticItemId });
      } catch (err) {
        // A catalog row that has since been retired must not sink the change
        // order — the defects are the reason it exists. Say so instead.
        note = `The diagnostic item could not be priced onto this change order: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } else if (view.money.examinedTotal > 0) {
    note = "This diagnostic was not quoted per outlet, so there is no overage to bill — price the resolutions only.";
  }

  await prisma.diagnosticReport.update({ where: { id: reportId }, data: { changeOrderDraftId: draft.id } });

  return {
    draftId: draft.id,
    resumed: false,
    isChangeOrder: Boolean(root),
    changeOrderFor: root?.number ?? null,
    seeded,
    defects,
    note:
      note ??
      (root
        ? null
        : "Nothing is signed on this job yet, so this is an ordinary estimate rather than a change order. Sign it and it becomes the job."),
  };
}
