/**
 * THE BALLPARK ON A LEAD — server rules (Kyle, 2026-11-15, plan lead-intake-fixes F4;
 * shared/leadBallpark.ts has the ruling and the wording).
 *
 * Not a second estimating tool: the ballpark is an ordinary PriceBookDraftEstimate built in the
 * existing Estimate Intake, created by the existing POST /price-book/drafts with a `leadId`. This
 * file holds the four things that are different about a draft while it sits on a lead:
 *
 *   1. `ballparkLockReason` (atomicEstimateService.ts, beside draftDeleteReason and draftCopyReason)
 *      — it cannot be issued, sent or emailed: read by `finalizeDraft`, which every issue and
 *      revise path passes through, and by the review payload that greys the builder's send controls.
 *   2. `leadBallparks`       — what the lead drawer and the lead page show: title, total, updated.
 *   3. `moveBallparkToVisit` — conversion hands it to the new consultation visit, so the tech's
 *      Quote screen (workingDraftForVisit, which finds a draft ONLY by visitId) opens that draft.
 *   4. `deleteLeadBallparks` — deleting a lead deletes its unsent ballpark (Kyle's default,
 *      2026-11-15), so no draft is left with a dangling link and nothing to reach it by.
 *
 * Savannah gets none of this: she is not part of the estimating system (CLAUDE.md, 2026-10-08).
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import type { LeadBallpark } from "../../shared/leadBallpark";
import { DraftError, computeDraft, deleteDraft } from "./atomicEstimateService";
import { logSystemEvent } from "./systemEvents";

/** The lead's ballpark(s), newest first — a lead holds one, but a list is never wrong about a copy. */
export async function leadBallparks(prisma: PrismaClient, leadId: string): Promise<LeadBallpark[]> {
  const rows = await prisma.priceBookDraftEstimate.findMany({
    where: { leadId, changeOrderForId: null },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true, title: true, status: true, updatedAt: true, visitId: true, exclusiveOptions: true,
      _count: { select: { lines: true } },
    },
  });
  const out: LeadBallpark[] = [];
  for (const row of rows) {
    let total: number | null = null;
    // A total means one number only when the options ADD (the default). One-or-the-other options
    // are alternatives, so there is no single total to show; an empty draft has none either.
    if (row._count.lines > 0 && !row.exclusiveOptions) {
      try {
        total = (await computeDraft(prisma, row.id)).computed.total;
      } catch {
        total = null;
      }
    }
    out.push({
      id: row.id,
      title: row.title,
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
      visitId: row.visitId,
      total,
      lineCount: row._count.lines,
    });
  }
  return out;
}

/**
 * Conversion: the lead's unsent ballpark becomes the new consultation visit's quote. Called from
 * `convertLeadToOpportunity` INSIDE its transaction (all three doors — convert, mark won, confirm
 * booking — pass through it), with the transaction client.
 *
 * Only a plain working draft moves: not a change order (the visit's quote filter excludes those and
 * must never be widened), and not one that already has a visit. `customerId` moves with it so the
 * draft's spine matches the visit's. `leadId` is kept, so the lead still shows its ballpark.
 */
export async function moveBallparkToVisit(
  tx: Prisma.TransactionClient,
  input: { leadId: string; customerId: string; visitId: string },
): Promise<number> {
  const moved = await tx.priceBookDraftEstimate.updateMany({
    where: { leadId: input.leadId, visitId: null, changeOrderForId: null, status: "draft" },
    data: { customerId: input.customerId, visitId: input.visitId },
  });
  return moved.count;
}

/**
 * Deleting a lead deletes its unsent ballpark first (the confirm on screen says so). Uses the same
 * `deleteDraft` the builder's "Delete draft" button uses, so a draft something was issued from is
 * refused and left alone (it SetNull-unlinks when the lead goes — it is an estimate, not a ballpark).
 */
export async function deleteLeadBallparks(prisma: PrismaClient, leadId: string): Promise<number> {
  const drafts = await prisma.priceBookDraftEstimate.findMany({
    where: { leadId, visitId: null, changeOrderForId: null },
    select: { id: true },
  });
  let deleted = 0;
  for (const d of drafts) {
    try {
      await deleteDraft(prisma, d.id);
      deleted += 1;
    } catch (err) {
      if (!(err instanceof DraftError)) throw err;
      logSystemEvent("warn", "leads", "A lead was deleted but one of its drafts could not be (something was issued from it)", {
        leadId, draftId: d.id, reason: err.message,
      });
    }
  }
  return deleted;
}
