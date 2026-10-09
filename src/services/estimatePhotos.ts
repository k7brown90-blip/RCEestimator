/**
 * Job photos as the field Quote screen sees them (Phase 2 unit E, 2026-10-08; scope narrowed
 * 2026-10-09).
 *
 * ONE STORE, ONE UPLOAD PATH: a photo taken while building an estimate is a `VisitPhoto` on the
 * job, uploaded by the field's existing PUT /health-record/visits/:visitId/photos/:photoId (the
 * pipeline the Job site screen's "Job photos" already uses) - this module does not create photos.
 * It lists them, serves a small preview, and lets the technician who took one take it back.
 *
 * WHICH PHOTOS - Kyle, 2026-10-09 (ruling 2): the field Quote screen shows only THIS JOB's photos,
 * not every photo on the customer's account. "This job" is the quote's visit and its job chain
 * (`jobChainOfVisits`, built on the same `costChainVisitIds` that rolls hours, P.O.s and fees onto a
 * job). The listing, the preview route and the field's estimate email (`photoVisitIds` in
 * issuedEstimateSend.ts) all use that one chain, so the screen never offers a photo the send would
 * refuse. The OFFICE's email picker is deliberately different and unchanged: it offers any photo on
 * the account (Kyle, 2026-10-01 - "sending the photos as evidence is our standard"), because the
 * office is choosing second-hand from the whole history; the tech is standing in one job.
 */

import type { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { PHOTO_REMOVE_REFUSAL, type EstimatePhoto } from "../../shared/estimatePhotos";
import { jobChainOfVisits } from "./jobCosting";

/** The phone shows the newest this many; each is a separate preview request, and ten is the most one email carries. */
const LIST_LIMIT = 60;

/** Why a photo outside the job is refused - one sentence for the preview route and the email. */
export const PHOTO_OUTSIDE_JOB_REFUSAL =
  "That photo is not on this job. The field app sends only this job's photos; the office can attach photos from the customer's other jobs.";

export class PhotoError extends Error {
  constructor(message: string, readonly statusCode: 403 | 404) {
    super(message);
    this.name = "PhotoError";
  }
}

export async function listJobPhotos(
  prisma: PrismaClient,
  ctx: { visitId: string; customerId: string; technicianId: string },
): Promise<{ photos: EstimatePhoto[]; total: number }> {
  const chain = await jobChainOfVisits([ctx.visitId]);
  // customerId rides along as a second wall: the chain is one customer's by construction, and a
  // photo on another customer's visit is never listed even if a link were ever wrong.
  const where = { visitId: { in: chain }, visit: { customerId: ctx.customerId } };
  const total = await prisma.visitPhoto.count({ where });
  const rows = await prisma.visitPhoto.findMany({
    where,
    select: {
      id: true,
      caption: true,
      uploadedAt: true,
      technicianId: true,
      visitId: true,
      visit: {
        select: {
          visitDate: true,
          purpose: true,
          jobType: true,
          property: { select: { addressLine1: true, city: true } },
        },
      },
    },
    orderBy: [{ visit: { visitDate: "desc" } }, { uploadedAt: "desc" }],
    take: LIST_LIMIT,
  });
  const photos = rows.map((p) => ({
    id: p.id,
    caption: p.caption,
    uploadedAt: p.uploadedAt.toISOString(),
    visitId: p.visitId,
    visitDate: p.visit.visitDate.toISOString(),
    jobLabel: (p.visit.jobType || p.visit.purpose || "Job").trim() || "Job",
    address: `${p.visit.property.addressLine1}, ${p.visit.property.city}`,
    onThisVisit: p.visitId === ctx.visitId,
    canRemove: p.visitId === ctx.visitId && p.technicianId === ctx.technicianId,
  }));
  return { photos, total };
}

/**
 * Of these photo ids, the ones that are NOT on this job's chain (or do not exist). The field's
 * estimate email calls it before sending so a tick from another job is refused, not silently
 * dropped (the email would otherwise arrive thinner than the tech ticked).
 */
export async function photoIdsOutsideJob(
  prisma: PrismaClient,
  photoIds: string[],
  visitIds: string[],
): Promise<string[]> {
  const ids = [...new Set(photoIds)];
  if (ids.length === 0) return [];
  const inside = await prisma.visitPhoto.findMany({
    where: { id: { in: ids }, visitId: { in: visitIds } },
    select: { id: true },
  });
  const ok = new Set(inside.map((p) => p.id));
  return ids.filter((id) => !ok.has(id));
}

/**
 * A small JPEG preview for the phone's grid - the originals can be 15 MB. Job-scoped: a photo that
 * exists on the customer's account but not on THIS job answers 403 (ruling 2); a photo that does
 * not exist, or is another customer's, answers 404 exactly as before.
 */
export async function jobPhotoPreview(
  prisma: PrismaClient,
  photoId: string,
  ctx: { visitId: string; customerId: string },
): Promise<{ mimeType: string; bytes: Buffer }> {
  const photo = await prisma.visitPhoto.findFirst({
    where: { id: photoId, visit: { customerId: ctx.customerId } },
    select: { data: true, mimeType: true, visitId: true },
  });
  if (!photo) throw new PhotoError("Photo not found", 404);
  const chain = await jobChainOfVisits([ctx.visitId]);
  if (!chain.includes(photo.visitId)) throw new PhotoError(PHOTO_OUTSIDE_JOB_REFUSAL, 403);
  const original = Buffer.from(photo.data);
  try {
    const bytes = await sharp(original)
      .rotate()
      .resize({ width: 360, height: 360, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    return { mimeType: "image/jpeg", bytes };
  } catch {
    return { mimeType: photo.mimeType, bytes: original };
  }
}

/**
 * The exit for a photo added from the quote screen (standing rule: nothing the app creates is
 * permanent). Narrow on purpose: the photo must be on THIS quote's visit and taken by THIS
 * technician. Anything else is the office's to remove (admin DELETE /visit-photos/:id).
 */
export async function removeOwnVisitPhoto(
  prisma: PrismaClient,
  photoId: string,
  ctx: { visitId: string; technicianId: string },
): Promise<void> {
  const photo = await prisma.visitPhoto.findUnique({
    where: { id: photoId },
    select: { visitId: true, technicianId: true },
  });
  if (!photo) throw new PhotoError("Photo not found", 404);
  if (photo.visitId !== ctx.visitId || photo.technicianId !== ctx.technicianId) {
    throw new PhotoError(PHOTO_REMOVE_REFUSAL, 403);
  }
  await prisma.visitPhoto.delete({ where: { id: photoId } });
}
