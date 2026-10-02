/**
 * Move the retired estimate-draft photos onto the JOB they belong to (plan A4, Kyle 2026-10-02).
 *
 * Kyle: "Draft photos don't make sense to me. … we would obviously want the photos added to the
 * estimates that are from an applied job, consultation, or diagnostics." and "The photos in
 * production will have to migrate to their estimate visits."
 *
 * Every photo belongs to a job. A consultation IS a job, created when it is scheduled, so a photo
 * added while building an estimate is a `VisitPhoto` on that consultation — and it OUTLIVES the
 * estimate: when the 30 days pass and the estimate is rebuilt, the photos are still on the job
 * and ride the new one. `DraftPhoto` tied the photo to a single draft, which is exactly where
 * they got lost (2026-10-01: the photos justifying a quote were the only ones that could not be
 * emailed with it). Nothing writes `DraftPhoto` any more; this moves what is already there.
 *
 * ── THE RULE FOR EVERY DRAFT PHOTO ─────────────────────────────────────────────────────────────
 *
 * The target visit is the first of these that names a visit which actually exists:
 *
 *   1. the draft's own `visitId` — the consultation the draft was created from;
 *   2. for every issued estimate graduated from the draft, newest first, its `visitId` — the
 *      quoted-on visit, auto-linked at issue when the draft carried none;
 *   3. failing that, the same estimates' `jobVisitId` — the job created when the customer signed.
 *
 * The estimate's STATUS IS IGNORED on purpose: sent, viewed, signed, expired, lost or void all
 * resolve. Kyle's point is that the photos belong to the consultation "even if they never sign
 * them or we loose that job". A voided or lost estimate still names the visit it was quoted on.
 *
 * A candidate is skipped (reported, not used) when:
 *   - the visit it names no longer exists — `visitId`/`jobVisitId` are plain columns, not
 *     foreign keys, so a dangling id is possible;
 *   - the visit belongs to a DIFFERENT customer than the estimate (or than the draft's own
 *     `customerId`, when set). A `VisitPhoto` is emailable by its visit's customer
 *     (`photoAttachments`, the security boundary), so filing one under another customer's job
 *     would be a leak, not a migration.
 *
 * ── WHAT CAN NEVER HAPPEN HERE ─────────────────────────────────────────────────────────────────
 *
 *   - NOTHING IS DELETED. Not a resolved photo, not an unresolved one. The `DraftPhoto` row stays
 *     exactly where it is in every branch; dropping the table is a separate, later step taken
 *     once Kyle has seen the unresolved count. These are photographs that cannot be retaken.
 *   - NOTHING IS DUPLICATED. The new `VisitPhoto` takes the `DraftPhoto`'s own id (`VisitPhoto.id`
 *     is a client-minted idempotency key, so any string is legal), which makes a second run find
 *     the copy and count it as already done rather than write it again.
 *   - NOTHING IS SILENT. Every photo ends in exactly one bucket — migrated, already done,
 *     unresolved (with its id, draft and the reason) or failed — and the caller gets the lists.
 *
 * `apply: false` (the script's default) does every lookup and decision and writes nothing.
 */

import type { PrismaClient } from "@prisma/client";

export type DraftPhotoResolution =
  | { ok: true; visitId: string; source: "draft.visitId" | "estimate.visitId" | "estimate.jobVisitId"; skipped: string[] }
  | { ok: false; reason: string };

export interface MigratedPhoto {
  id: string;
  draftId: string;
  draftTitle: string;
  visitId: string;
  source: "draft.visitId" | "estimate.visitId" | "estimate.jobVisitId";
}

export interface UnresolvedPhoto {
  id: string;
  draftId: string;
  draftTitle: string;
  sizeBytes: number;
  createdAt: Date;
  reason: string;
}

export interface DraftPhotoMigrationReport {
  apply: boolean;
  total: number;
  migrated: MigratedPhoto[];
  alreadyDone: MigratedPhoto[];
  unresolved: UnresolvedPhoto[];
  /** Resolved, attempted, and the write threw. The DraftPhoto row is untouched. */
  failed: Array<MigratedPhoto & { error: string }>;
}

/** Decide where ONE draft's photos go. Exported so the test can pin each rule by itself. */
export async function resolveDraftVisit(prisma: PrismaClient, draftId: string): Promise<DraftPhotoResolution> {
  const draft = await prisma.priceBookDraftEstimate.findUnique({
    where: { id: draftId },
    select: { id: true, visitId: true, customerId: true },
  });
  if (!draft) return { ok: false, reason: "draft row missing" };

  const estimates = await prisma.issuedEstimate.findMany({
    where: { draftId },
    orderBy: [{ revision: "desc" }, { createdAt: "desc" }],
    select: { id: true, number: true, revision: true, status: true, customerId: true, visitId: true, jobVisitId: true },
  });

  type Candidate = { visitId: string; source: MigratedPhoto["source"]; mustBelongTo: string | null; label: string };
  const candidates: Candidate[] = [];
  if (draft.visitId) {
    candidates.push({ visitId: draft.visitId, source: "draft.visitId", mustBelongTo: draft.customerId, label: "draft.visitId" });
  }
  for (const est of estimates) {
    if (est.visitId) {
      candidates.push({ visitId: est.visitId, source: "estimate.visitId", mustBelongTo: est.customerId, label: `estimate ${est.number} rev ${est.revision} (${est.status}).visitId` });
    }
  }
  for (const est of estimates) {
    if (est.jobVisitId) {
      candidates.push({ visitId: est.jobVisitId, source: "estimate.jobVisitId", mustBelongTo: est.customerId, label: `estimate ${est.number} rev ${est.revision} (${est.status}).jobVisitId` });
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: estimates.length === 0
        ? "draft has no visit and no issued estimate"
        : `draft has no visit; its ${estimates.length} issued estimate(s) carry neither visitId nor jobVisitId`,
    };
  }

  const skipped: string[] = [];
  for (const c of candidates) {
    const visit = await prisma.visit.findUnique({ where: { id: c.visitId }, select: { id: true, customerId: true } });
    if (!visit) {
      skipped.push(`${c.label} names visit ${c.visitId}, which no longer exists`);
      continue;
    }
    if (c.mustBelongTo && visit.customerId !== c.mustBelongTo) {
      skipped.push(`${c.label} names visit ${c.visitId} on customer ${visit.customerId}, not ${c.mustBelongTo}`);
      continue;
    }
    return { ok: true, visitId: visit.id, source: c.source, skipped };
  }
  return { ok: false, reason: `every candidate visit was rejected: ${skipped.join("; ")}` };
}

export async function migrateDraftPhotos(
  prisma: PrismaClient,
  opts: { apply: boolean },
): Promise<DraftPhotoMigrationReport> {
  const report: DraftPhotoMigrationReport = { apply: opts.apply, total: 0, migrated: [], alreadyDone: [], unresolved: [], failed: [] };

  // Metadata only — the bytes are read one photo at a time, at the moment of the write.
  const photos = await prisma.draftPhoto.findMany({
    select: { id: true, draftId: true, size: true, createdAt: true, draft: { select: { title: true } } },
    orderBy: { createdAt: "asc" },
  });
  report.total = photos.length;

  const resolutions = new Map<string, DraftPhotoResolution>();
  for (const photo of photos) {
    let resolution = resolutions.get(photo.draftId);
    if (!resolution) {
      resolution = await resolveDraftVisit(prisma, photo.draftId);
      resolutions.set(photo.draftId, resolution);
    }
    const base = { id: photo.id, draftId: photo.draftId, draftTitle: photo.draft.title };

    if (!resolution.ok) {
      // STAYS WHERE IT IS. Reported, never touched.
      report.unresolved.push({ ...base, sizeBytes: photo.size, createdAt: photo.createdAt, reason: resolution.reason });
      continue;
    }
    const target: MigratedPhoto = { ...base, visitId: resolution.visitId, source: resolution.source };

    const existing = await prisma.visitPhoto.findUnique({ where: { id: photo.id }, select: { id: true } });
    if (existing) {
      report.alreadyDone.push(target);
      continue;
    }
    if (!opts.apply) {
      report.migrated.push(target);
      continue;
    }
    try {
      const full = await prisma.draftPhoto.findUnique({ where: { id: photo.id } });
      if (!full) throw new Error("DraftPhoto row disappeared between listing and copy");
      await prisma.visitPhoto.create({
        data: {
          id: full.id,
          visitId: resolution.visitId,
          technicianId: null, // office upload, same as the CRM gallery
          mimeType: full.mime,
          sizeBytes: full.size,
          caption: full.note,
          tag: null,
          data: full.bytes,
          uploadedAt: full.createdAt, // when it was taken, not when it was moved
        },
      });
      report.migrated.push(target);
    } catch (err) {
      report.failed.push({ ...target, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}

/** Human-readable report — the script prints this; Kyle reads it before any irreversible step. */
export function formatDraftPhotoReport(report: DraftPhotoMigrationReport): string {
  const lines: string[] = [];
  lines.push(report.apply ? "APPLY — VisitPhoto rows were written. No DraftPhoto row was deleted." : "DRY RUN — nothing was written.");
  lines.push(`DraftPhoto rows: ${report.total}`);
  lines.push(`  ${report.apply ? "migrated" : "would migrate"}: ${report.migrated.length}`);
  lines.push(`  already done (VisitPhoto with the same id exists): ${report.alreadyDone.length}`);
  lines.push(`  unresolved (stay in DraftPhoto): ${report.unresolved.length}`);
  lines.push(`  failed (stay in DraftPhoto): ${report.failed.length}`);
  for (const p of report.migrated) lines.push(`  + ${p.id}  draft "${p.draftTitle}" (${p.draftId}) -> visit ${p.visitId} via ${p.source}`);
  for (const p of report.unresolved) {
    lines.push(`  ! ${p.id}  draft "${p.draftTitle}" (${p.draftId})  ${p.sizeBytes} bytes  ${p.createdAt.toISOString().slice(0, 10)}`);
    lines.push(`      ${p.reason}`);
  }
  for (const p of report.failed) lines.push(`  x ${p.id}  draft "${p.draftTitle}" -> visit ${p.visitId}: ${p.error}`);
  return lines.join("\n");
}
