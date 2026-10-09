/**
 * The photos a quote can send with its estimate email - the contract between the server and the
 * field Quote screen (Phase 2 unit E, 2026-10-08, one estimating system).
 *
 * Same meaning as the office's picker (PhotoAttachPicker in PriceBookIntakePage) - ticked per send,
 * at most ten, nothing attached unless ticked - with ONE difference of scope. The office offers ANY
 * job photo on the customer's account (Kyle, 2026-10-01: "Having the photos linked to the job is
 * necessary but that should not eleminate them from being selected ... sending the photos as
 * evidence is our standard"). The FIELD offers THIS JOB's photos only - the quote's visit and its job
 * chain (Kyle, 2026-10-09, ruling 2); the server enforces the same chain on the list, the preview and
 * the email.
 * Metadata only - bytes come one at a time. No hours, no costs.
 */

/** One email carries at most this many photos (the office picker's cap, and the server's). */
export const MAX_ESTIMATE_PHOTOS = 10;

export interface EstimatePhoto {
  id: string;
  caption: string | null;
  uploadedAt: string;
  /** The job (visit) the photo is filed on. */
  visitId: string;
  visitDate: string;
  /** "Panel upgrade", "Service call" - the job's type or purpose, in words. */
  jobLabel: string;
  /** The address of that job, one line. */
  address: string;
  /** Filed on the visit this quote is being built on (the photos "of this job"). */
  onThisVisit: boolean;
  /** This technician took it on this visit, so this technician may remove it from here. */
  canRemove: boolean;
}

export const PHOTO_REMOVE_REFUSAL =
  "Only the technician who took a photo can remove it, and only from the job it was filed on. Ask the office to remove this one.";
