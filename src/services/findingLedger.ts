/**
 * The finding ledger — what is known at an address, and whether it was ever fixed.
 *
 * Before this, a Health Record could only show what was *known*. That is half a
 * document: a written, code-cited defect report is legal notice against the
 * person who paid for it, and without a matching record of the cure it is only
 * ever evidence against them. It is also a business gap — a MONITOR nobody
 * follows up on is a sale that never happens.
 *
 * Two tracks share one table:
 *
 *   defect  (FAIL)                    → open → scheduled → corrected
 *   upgrade (MONITOR, BELOW_STANDARD) → open → scheduled → upgraded
 *
 * One is about correcting code violations and hazards; the other is about
 * planned repairs and premium installations. Both stay documented whether or not
 * the work is ever done.
 *
 * The one rule this module will not bend: **a later PASS never cures a finding.**
 * It records that the item passed, and queues the row for the licence holder to
 * close out. Only a person with a licence to lose signs a cure.
 */

import { prisma } from "../lib/prisma";
import { parseJsonStringArray } from "../lib/json";

export type FindingTrack = "defect" | "upgrade";
export type FindingSeverity = "FAIL" | "MONITOR" | "BELOW_STANDARD";

export const LIVE_STATUSES = ["open", "scheduled"] as const;
export const DEFECT_TERMINAL = ["corrected", "declined", "superseded"] as const;
export const UPGRADE_TERMINAL = ["upgraded", "declined", "superseded"] as const;

export function trackFor(severity: FindingSeverity): FindingTrack {
  return severity === "FAIL" ? "defect" : "upgrade";
}

/** The terminal state that counts as "the work got done" for a given track. */
export function resolvedStatusFor(track: FindingTrack): "corrected" | "upgraded" {
  return track === "defect" ? "corrected" : "upgraded";
}

/**
 * One finding as the PWA describes it. Self-describing by necessity: the server
 * has no copy of the checklist, so title and citations have to arrive with the
 * push. See field/src/domain/ledgerFindings.ts.
 */
export interface IncomingFinding {
  itemId: string;
  locationKey?: string;
  result: FindingSeverity;
  track?: FindingTrack;
  gradedState?: string | null;
  title?: string;
  section?: string | null;
  citations?: string[];
  critical?: boolean;
  findingText?: string;
  note?: string | null;
  resolutionNote?: string | null;
  expectedEolYear?: number | null;
}

export interface ReconcileContext {
  inspectionId: string;
  visitId: string;
  propertyId: string;
  customerId: string;
  jurisdictionId: string;
  inspectionDate: Date;
  technicianId?: string | null;
  technicianName?: string;
  /** Item ids the technician recorded as PASS on this record. */
  passedItemIds?: string[];
  /** Item ids recorded as N/A — the equipment is gone or never applied. */
  naItemIds?: string[];
}

export interface ReconcileResult {
  opened: number;
  reobserved: number;
  passObserved: number;
  superseded: number;
  /** Findings whose item passed this time and now await owner close-out. */
  awaitingCloseout: string[];
  /** Item ids we could not name, so the record says so instead of inventing one. */
  undescribed: string[];
}

const UNKNOWN_TITLE_PREFIX = "Unidentified checklist item";

/**
 * Degrade honestly. A finding we cannot name gets the id as its title and an
 * empty citation list, and the CRM labels it "citations unavailable — pre-ledger
 * record". An empty citation block that *looks* authoritative is worse than an
 * admitted gap: somebody would put it on a certificate.
 */
function describe(finding: IncomingFinding): {
  title: string;
  section: string | null;
  citationsJson: string;
  findingText: string;
  described: boolean;
} {
  const described = Boolean(finding.title && finding.title.trim().length > 0);
  return {
    title: described ? finding.title!.trim() : `${UNKNOWN_TITLE_PREFIX} ${finding.itemId}`,
    section: finding.section ?? null,
    citationsJson: JSON.stringify(finding.citations ?? []),
    findingText: finding.findingText?.trim() || `${finding.itemId} recorded ${finding.result}.`,
    described,
  };
}

/** Dec 31 of the expiry year — the follow-up sweep leads it by its own window. */
function followUpFor(expectedEolYear: number | null | undefined): Date | null {
  if (expectedEolYear == null || !Number.isFinite(expectedEolYear)) return null;
  return new Date(Date.UTC(expectedEolYear, 11, 31));
}

/**
 * Log a transition. Idempotent on (finding, inspection, toStatus), so replaying
 * the same push — which the offline queue does routinely — leaves one event.
 * A null inspectionId means a manual action, which is never deduplicated: two
 * separate manual notes on the same row are two real events.
 */
async function logEvent(
  tx: Pick<typeof prisma, "propertyFindingEvent">,
  input: {
    findingId: string;
    fromStatus?: string | null;
    toStatus: string;
    actorType: "technician" | "owner" | "system";
    actorId?: string | null;
    actorName: string;
    visitId?: string | null;
    inspectionId?: string | null;
    documentId?: string | null;
    note?: string | null;
  },
): Promise<void> {
  const data = {
    findingId: input.findingId,
    fromStatus: input.fromStatus ?? null,
    toStatus: input.toStatus,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    actorName: input.actorName,
    visitId: input.visitId ?? null,
    inspectionId: input.inspectionId ?? null,
    documentId: input.documentId ?? null,
    note: input.note ?? null,
  };
  if (!input.inspectionId) {
    await tx.propertyFindingEvent.create({ data });
    return;
  }
  await tx.propertyFindingEvent.upsert({
    where: {
      findingId_inspectionId_toStatus: {
        findingId: input.findingId,
        inspectionId: input.inspectionId,
        toStatus: input.toStatus,
      },
    },
    create: data,
    update: {},
  });
}

export { logEvent as logFindingEvent };

/** The live row for a key, if there is one. */
function liveWhere(ctx: { propertyId: string }, itemId: string, locationKey: string) {
  return {
    propertyId: ctx.propertyId,
    itemId,
    locationKey,
    status: { in: [...LIVE_STATUSES] },
  };
}

/**
 * Fold one completed record into the ledger.
 *
 * Called from the inspection push, the admin routes, and the backfill script —
 * one implementation, so replayed history and live syncs can never diverge.
 */
export async function reconcileInspection(
  ctx: ReconcileContext,
  findings: IncomingFinding[],
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    opened: 0,
    reobserved: 0,
    passObserved: 0,
    superseded: 0,
    awaitingCloseout: [],
    undescribed: [],
  };
  const actorName = ctx.technicianName ?? "Field technician";

  for (const finding of findings) {
    const locationKey = finding.locationKey?.trim() || "_default";
    const track = finding.track ?? trackFor(finding.result);
    const described = describe(finding);
    if (!described.described) result.undescribed.push(finding.itemId);

    const existing = await prisma.propertyFinding.findFirst({
      where: liveWhere(ctx, finding.itemId, locationKey),
    });

    if (existing) {
      // Re-observed. The severity on the row is the notice that was given; it is
      // never rewritten. A change is recorded on the event instead.
      const severityChanged = existing.severity !== finding.result;
      await prisma.propertyFinding.update({
        where: { id: existing.id },
        data: {
          lastObservedInspectionId: ctx.inspectionId,
          lastObservedAt: ctx.inspectionDate,
          observedCount: { increment: 1 },
          // A finding seen again is not a finding that passed.
          verifiedPassInspectionId: null,
          verifiedPassAt: null,
        },
      });
      await logEvent(prisma, {
        findingId: existing.id,
        fromStatus: existing.status,
        toStatus: "observed",
        actorType: "technician",
        actorId: ctx.technicianId,
        actorName,
        visitId: ctx.visitId,
        inspectionId: ctx.inspectionId,
        note: severityChanged
          ? `Observed again as ${finding.result} (originally documented ${existing.severity}).`
          : null,
      });
      result.reobserved += 1;
      continue;
    }

    // No live row. If this key has been documented before, this is a recurrence
    // after a resolution — a new cycle, never a mutation of the closed row.
    const priorCycle = await prisma.propertyFinding.findFirst({
      where: { propertyId: ctx.propertyId, itemId: finding.itemId, locationKey },
      orderBy: { cycle: "desc" },
      select: { cycle: true },
    });

    const opened = await prisma.propertyFinding.create({
      data: {
        propertyId: ctx.propertyId,
        customerId: ctx.customerId,
        itemId: finding.itemId,
        locationKey,
        cycle: (priorCycle?.cycle ?? 0) + 1,
        track,
        title: described.title,
        section: described.section,
        citationsJson: described.citationsJson,
        jurisdictionId: ctx.jurisdictionId,
        severity: finding.result,
        gradedState: finding.gradedState ?? null,
        critical: finding.critical ?? false,
        findingText: described.findingText,
        resolutionNote: finding.resolutionNote ?? null,
        expectedEolYear: track === "upgrade" ? finding.expectedEolYear ?? null : null,
        followUpAt: track === "upgrade" ? followUpFor(finding.expectedEolYear) : null,
        status: "open",
        openedInspectionId: ctx.inspectionId,
        openedVisitId: ctx.visitId,
        openedAt: ctx.inspectionDate,
        openedByTechnicianId: ctx.technicianId ?? null,
        lastObservedInspectionId: ctx.inspectionId,
        lastObservedAt: ctx.inspectionDate,
        observedCount: 1,
      },
    });
    await logEvent(prisma, {
      findingId: opened.id,
      toStatus: "open",
      actorType: "technician",
      actorId: ctx.technicianId,
      actorName,
      visitId: ctx.visitId,
      inspectionId: ctx.inspectionId,
      note: opened.cycle > 1 ? `Recurrence — cycle ${opened.cycle} at this location.` : null,
    });
    result.opened += 1;
  }

  // ── An item that passed this time ────────────────────────────────────────
  // Evidence, not a cure. The row stays open and joins the close-out queue,
  // where the licence holder decides what it means.
  for (const itemId of ctx.passedItemIds ?? []) {
    const live = await prisma.propertyFinding.findMany({
      where: liveWhere(ctx, itemId, "_default"),
    });
    // Findings recorded at a named location pass too, so widen past _default.
    const all = live.length
      ? live
      : await prisma.propertyFinding.findMany({
        where: { propertyId: ctx.propertyId, itemId, status: { in: [...LIVE_STATUSES] } },
      });

    for (const finding of all) {
      await prisma.propertyFinding.update({
        where: { id: finding.id },
        data: {
          verifiedPassInspectionId: ctx.inspectionId,
          verifiedPassAt: ctx.inspectionDate,
          lastObservedInspectionId: ctx.inspectionId,
          lastObservedAt: ctx.inspectionDate,
        },
      });
      await logEvent(prisma, {
        findingId: finding.id,
        fromStatus: finding.status,
        toStatus: "pass_observed",
        actorType: "technician",
        actorId: ctx.technicianId,
        actorName,
        visitId: ctx.visitId,
        inspectionId: ctx.inspectionId,
        note: "Item passed on a later assessment. Awaiting contractor close-out — a pass is evidence, not a cure.",
      });
      result.passObserved += 1;
      result.awaitingCloseout.push(finding.id);
    }
  }

  // ── An item recorded N/A ─────────────────────────────────────────────────
  // The equipment is gone or never applied here. Supersede rather than resolve:
  // nobody corrected anything, and the distinction matters on a certificate.
  for (const itemId of ctx.naItemIds ?? []) {
    const live = await prisma.propertyFinding.findMany({
      where: { propertyId: ctx.propertyId, itemId, status: { in: [...LIVE_STATUSES] } },
    });
    for (const finding of live) {
      await prisma.propertyFinding.update({
        where: { id: finding.id },
        data: { status: "superseded" },
      });
      await logEvent(prisma, {
        findingId: finding.id,
        fromStatus: finding.status,
        toStatus: "superseded",
        actorType: "technician",
        actorId: ctx.technicianId,
        actorName,
        visitId: ctx.visitId,
        inspectionId: ctx.inspectionId,
        note: "Recorded not applicable on a later assessment — the equipment is no longer here.",
      });
      result.superseded += 1;
    }
  }

  return result;
}

// ─── Owner transitions ──────────────────────────────────────────────────────

export interface ResolveInput {
  findingId: string;
  resolutionMethod: "corrected" | "replaced" | "upgraded" | "equipment_removed" | "verified_prior_repair";
  resolvedByParty: "red_cedar" | "owner_self" | "third_party";
  resolvedByPartyName?: string | null;
  resolvedByVisitId?: string | null;
  resolvedByTechnicianId?: string | null;
  resolutionDetail: string;
  resolvedAt?: Date;
  attestedBy: string;
}

/**
 * Close a finding out. Owner-only — the tech router has no path to this.
 *
 * The terminal status follows the track, so a defect ends *corrected* and an
 * upgrade ends *upgraded*. They are not synonyms: one says a violation was
 * remedied, the other says better equipment was installed, and only the first
 * belongs on a cure certificate.
 */
export async function resolveFinding(input: ResolveInput) {
  const finding = await prisma.propertyFinding.findUnique({ where: { id: input.findingId } });
  if (!finding) throw new Error(`Finding ${input.findingId} not found`);
  if (!LIVE_STATUSES.includes(finding.status as (typeof LIVE_STATUSES)[number])) {
    throw new Error(`Finding ${input.findingId} is ${finding.status}, not open`);
  }

  const toStatus = resolvedStatusFor(finding.track as FindingTrack);
  const updated = await prisma.propertyFinding.update({
    where: { id: finding.id },
    data: {
      status: toStatus,
      resolvedAt: input.resolvedAt ?? new Date(),
      resolutionMethod: input.resolutionMethod,
      resolvedByParty: input.resolvedByParty,
      resolvedByPartyName: input.resolvedByPartyName ?? null,
      resolvedByVisitId: input.resolvedByVisitId ?? null,
      resolvedByTechnicianId: input.resolvedByTechnicianId ?? null,
      resolutionDetail: input.resolutionDetail,
      followUpAt: null,
    },
  });
  await logEvent(prisma, {
    findingId: finding.id,
    fromStatus: finding.status,
    toStatus,
    actorType: "owner",
    actorName: input.attestedBy,
    visitId: input.resolvedByVisitId,
    note: input.resolutionDetail,
  });
  return updated;
}

export interface DeclineInput {
  findingId: string;
  declinedByName: string;
  /** owner | tenant | property_manager — a tenant cannot decline for an owner. */
  declinedByRelation: "owner" | "tenant" | "property_manager";
  declinedVerbatim: string;
  declinedChannel: "in_person" | "phone" | "email" | "sms";
  actorType: "technician" | "owner";
  actorId?: string | null;
  actorName: string;
}

/**
 * Record a refusal, in the customer's own words.
 *
 * Techs can do this — the refusal happens at the door, and capturing it there is
 * the only time anyone will get it verbatim. `declinedByRelation` is legally
 * load-bearing: a tenant declining a repair is not the owner declining it, and a
 * record that blurs the two protects nobody.
 */
export async function declineFinding(input: DeclineInput) {
  const finding = await prisma.propertyFinding.findUnique({ where: { id: input.findingId } });
  if (!finding) throw new Error(`Finding ${input.findingId} not found`);

  const updated = await prisma.propertyFinding.update({
    where: { id: finding.id },
    data: {
      status: "declined",
      declinedAt: new Date(),
      declinedByName: input.declinedByName,
      declinedByRelation: input.declinedByRelation,
      declinedVerbatim: input.declinedVerbatim,
      declinedChannel: input.declinedChannel,
    },
  });
  await logEvent(prisma, {
    findingId: finding.id,
    fromStatus: finding.status,
    toStatus: "declined",
    actorType: input.actorType,
    actorId: input.actorId,
    actorName: input.actorName,
    note: `${input.declinedByName} (${input.declinedByRelation}, ${input.declinedChannel}): "${input.declinedVerbatim}"`,
  });
  return updated;
}

/** Put a declined finding back in play — a customer who changes their mind. */
export async function reopenFinding(findingId: string, actorName: string, note?: string) {
  const finding = await prisma.propertyFinding.findUnique({ where: { id: findingId } });
  if (!finding) throw new Error(`Finding ${findingId} not found`);

  // A resolved row is history and stays that way. Reopening one is a recurrence,
  // which is a new cycle — that is the reconciler's job, not this function's.
  if (finding.status !== "declined") {
    throw new Error(`Only a declined finding can be reopened directly (this one is ${finding.status})`);
  }
  const updated = await prisma.propertyFinding.update({
    where: { id: findingId },
    data: { status: "open", declinedAt: null },
  });
  await logEvent(prisma, {
    findingId,
    fromStatus: finding.status,
    toStatus: "open",
    actorType: "owner",
    actorName,
    note: note ?? "Reopened after a previous declination.",
  });
  return updated;
}

/** Attach a scheduled visit — also called automatically when one is booked. */
export async function scheduleFinding(
  findingId: string,
  visitId: string,
  scheduledAt: Date | null,
  actorName: string,
) {
  const finding = await prisma.propertyFinding.findUnique({ where: { id: findingId } });
  if (!finding) throw new Error(`Finding ${findingId} not found`);

  const updated = await prisma.propertyFinding.update({
    where: { id: findingId },
    data: { status: "scheduled", scheduledVisitId: visitId, scheduledAt },
  });
  await logEvent(prisma, {
    findingId,
    fromStatus: finding.status,
    toStatus: "scheduled",
    actorType: "owner",
    actorName,
    visitId,
  });
  return updated;
}

/** Citations as stored, never re-derived from today's checklist. */
export function findingCitations(finding: { citationsJson: string }): string[] {
  return parseJsonStringArray(finding.citationsJson);
}
