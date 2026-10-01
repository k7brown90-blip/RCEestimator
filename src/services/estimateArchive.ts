/**
 * Archive the estimates that were not chosen (Kyle, 2026-10-01).
 *
 * "A list of drafts already compiles and there are already ones stacking from multiple estimates
 *  sent. … once a job is sold the other ones that are not chosen should be archived. (Arlene is a
 *  good example, she signed the new estimate for $4004.01 which was an adjustment after we
 *  reviewed the initial options together.) The first one totaling over $14,000 is now irrelevent
 *  and can be archived."
 *
 * The live case: 2026-1096 (sent 9/28, never signed) and 2026-1101 (signed 9/30), both Arlene
 * Williamson's, same address, SEPARATE estimates — 1101 is not a revision of 1096, so
 * `supersededBy` is null and nothing hid 1096 from the Sent card. None of the existing exits fit:
 * "lost" says the customer went elsewhere and feeds the win rate (she bought); "void" cancels a
 * signed document; "superseded" only happens through Revise.
 *
 * ── NOT A STATUS. ORTHOGONAL TO STATUS. ──────────────────────────────────────────────────────
 * `IssuedEstimate.status` is the allow-list every money and reporting surface reads
 * ("SIGNED IS AN ALLOW-LIST EVERYWHERE", constants.md). Archiving writes two columns of its own,
 * `archivedAt` + `archivedReason`, and the row keeps whatever status it had. Nothing that reads
 * `LIVE_SIGNED`, `/invoices`, the P&L or the job card can see an archived row differently,
 * because an archived row is never signed: the three signature doors clear both columns in the
 * same update that writes `signedAt` (applySignature, acceptEstimateFromOffice), so "archived ⇒
 * unsigned ⇒ no invoice, no payment, no job" holds by construction, not by convention.
 *
 * ── THE PREDICATE, and what it deliberately leaves alone ─────────────────────────────────────
 * When an estimate is signed, archive every other estimate that is ALL of:
 *   - the same account AND the same service address — "two genuine jobs at one account" live at
 *     different addresses and are never touched;
 *   - PRESENTED and UNSIGNED: status sent / viewed / expired (LOSABLE_STATUSES — the same set
 *     that can be marked lost). A DRAFT was never in front of the customer, so it is not an
 *     "option not chosen"; it is Kyle's own working document and is already behind the toggle;
 *   - the LATEST revision of its number (`supersededBy` null) — a document is judged at its
 *     latest revision, as the funnel judges it; an older revision is already hidden as superseded;
 *   - not a change order (`changeOrderForId` null) — a change order belongs to an invoice, it is
 *     not a competing quote;
 *   - with no job of its own (`jobVisitId` null) — an unsigned row never has one today, but the
 *     guard costs nothing and protects against a path this file does not know about;
 *   - not already archived;
 *   - never UNARCHIVED BY A PERSON. The one case an address-wide rule gets wrong is two genuinely
 *     different jobs quoted at one address at the same time (the panel and, separately, the EV
 *     charger). The first signature archives the other one; Kyle unarchives it from the drawer;
 *     and then a REVISION of the first is signed a week later — without this guard the second
 *     pass would archive it again. An `unarchived` event with a human actor on the trail says
 *     "a person decided this one stays", and the automatic pass never overrides a person.
 * And the pass does not run at all when the SIGNED estimate is a change order: more work agreed on
 * a running job says nothing about a separate quote waiting at the same address.
 *
 * It never touches a SIGNED row (someone's agreement), a VOID or LOST row (already has its exit),
 * or the estimate being signed itself. Those are excluded by the predicate AND pinned by
 * tests/archiveNotChosen.test.ts, which breaks the predicate on purpose to prove the test sees it.
 *
 * ── ADDRESS-WIDE, AND WHY THAT IS ACCEPTED ───────────────────────────────────────────────────
 * Nothing on the row says "this is an alternative to that one" — a second set of options is a
 * separate estimate with its own number, built from a fresh draft or a copy, and Kyle does not
 * record which. Same address + presented + unsigned is the best signal the data carries, and the
 * cost of a wrong archive is small and reversible: the row moves behind the Sent card's toggle
 * with its reason printed on it, the drawer offers Unarchive, and nothing about the document, its
 * customer link, its status or its money changes. Archiving does NOT block the customer's link —
 * the link reads and signs exactly as before, and a signature on an archived row un-archives it.
 *
 * ── NEVER ABLE TO FAIL A SIGNATURE ───────────────────────────────────────────────────────────
 * `archiveCompetingEstimates` runs AFTER the signature is committed, catches everything, and
 * reports its own failure. The signature is the durable fact; this is bookkeeping.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { logSystemEvent } from "./systemEvents";
import { LOSABLE_STATUSES } from "../../shared/estimateStatus";

/** Statuses the automatic pass may archive: presented to the customer, unsigned. */
export const ARCHIVABLE_ON_SIGNATURE = LOSABLE_STATUSES;

export type ArchivedRow = { id: string; number: string; revision: number; total: number; status: string };

export type ArchiveSweepResult = { archived: ArchivedRow[]; skipped?: string };

/** The reason written on every row the automatic pass archives — the row says why, wherever it is shown. */
export function competitorReason(signedNumber: string): string {
  return `another estimate was signed at this address (${signedNumber})`;
}

/**
 * The predicate as a Prisma `where`, exported so the test can prove the exclusions and so no second
 * copy of the rule can drift from this one.
 */
export function competingEstimatesWhere(signed: {
  id: string;
  customerId: string;
  serviceAddressId: string;
}): Prisma.IssuedEstimateWhereInput {
  return {
    id: { not: signed.id },
    customerId: signed.customerId,
    serviceAddressId: signed.serviceAddressId,
    status: { in: [...ARCHIVABLE_ON_SIGNATURE] },
    signedAt: null,
    voidedAt: null,
    lostAt: null,
    changeOrderForId: null,
    jobVisitId: null,
    supersededBy: null,
    archivedAt: null,
    // A person took this one back out of the archive — the automatic pass never overrides a person.
    events: { none: { type: "unarchived", actor: { startsWith: "human" } } },
  };
}

/**
 * After a signature: archive the other presented, unsigned estimates at the same address.
 * Returns what it archived; never throws.
 */
export async function archiveCompetingEstimates(
  prisma: PrismaClient,
  signedEstimateId: string,
  actor: string,
): Promise<ArchiveSweepResult> {
  try {
    const signed = await prisma.issuedEstimate.findUnique({
      where: { id: signedEstimateId },
      select: { id: true, number: true, revision: true, customerId: true, serviceAddressId: true, signedAt: true, changeOrderForId: true },
    });
    if (!signed) return { archived: [], skipped: "estimate not found" };
    if (!signed.signedAt) return { archived: [], skipped: "not signed" };
    if (signed.changeOrderForId) return { archived: [], skipped: "a change order does not compete with a separate quote" };

    const competitors = await prisma.issuedEstimate.findMany({
      where: competingEstimatesWhere(signed),
      select: { id: true, number: true, revision: true, total: true, status: true },
    });
    if (competitors.length === 0) return { archived: [] };

    const reason = competitorReason(signed.number);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      // Conditional on `archivedAt: null` and `signedAt: null` again inside the transaction, so a
      // row signed or archived between the read and the write is left exactly as it is.
      for (const c of competitors) {
        const r = await tx.issuedEstimate.updateMany({
          where: { id: c.id, archivedAt: null, signedAt: null },
          data: { archivedAt: now, archivedReason: reason },
        });
        if (r.count === 0) continue;
        await tx.issuedEstimateEvent.create({
          data: {
            estimateId: c.id,
            type: "archived",
            actor,
            detail: `Archived: ${reason} — rev ${signed.revision} of ${signed.number} was signed. Unarchive from the estimate drawer if this is a separate job.`,
          },
        });
      }
    });

    logSystemEvent("info", "issued-estimate", `Estimate ${signed.number} signed — archived ${competitors.length} other estimate(s) at the same address: ${competitors.map((c) => c.number).join(", ")}`, {
      estimateId: signed.id,
      archivedEstimateIds: competitors.map((c) => c.id),
      archivedNumbers: competitors.map((c) => c.number),
      actor,
    });
    return { archived: competitors };
  } catch (err) {
    // Bookkeeping, never the signature. Logged where readSystemEvents can find it.
    console.error("[estimateArchive] archiving the competing estimates failed:", err);
    logSystemEvent("error", "issued-estimate", "Archiving the other estimates at the address failed after a signature", {
      estimateId: signedEstimateId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { archived: [], skipped: "failed" };
  }
}

export type ArchiveByHandResult =
  | { ok: true; archivedAt: Date; reason: string | null }
  | { ok: false; status: 404 | 409; reason: string };

/**
 * Archive by hand, from the estimate drawer. Refuses a signed row (that is a sale — Void is its
 * door), a void row (dead already), a lost row (the Lost card is its home and the win rate reads
 * it — reopen first if archive is what was meant), a superseded revision (archive the latest), and
 * a row already archived. A DRAFT may be archived by hand: Delete is permanent and archive is not.
 */
export async function archiveEstimateByHand(
  prisma: PrismaClient,
  estimateId: string,
  input: { reason: string | null; actor: string },
): Promise<ArchiveByHandResult> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: {
      id: true, number: true, revision: true, status: true, signedAt: true, voidedAt: true, lostAt: true, archivedAt: true,
      supersededBy: { select: { revision: true } },
    },
  });
  if (!est) return { ok: false, status: 404, reason: "Estimate not found." };
  if (est.archivedAt) return { ok: false, status: 409, reason: "This estimate is already archived." };
  if (est.signedAt || est.status === "signed") {
    return { ok: false, status: 409, reason: "This estimate is signed — it is a sale, not something to put away. Void it if the job is off." };
  }
  if (est.status === "void" || est.voidedAt) return { ok: false, status: 409, reason: "This estimate is void — a void document is already off the books." };
  if (est.status === "lost" || est.lostAt) {
    return { ok: false, status: 409, reason: "This estimate is marked lost — that is its exit and the win rate reads it. Reopen it first if you meant to archive it instead." };
  }
  if (est.supersededBy) {
    return { ok: false, status: 409, reason: `This revision was replaced by rev ${est.supersededBy.revision} — archive that one.` };
  }
  const reason = input.reason?.trim() || null;
  const archivedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.issuedEstimate.update({ where: { id: est.id }, data: { archivedAt, archivedReason: reason } });
    await tx.issuedEstimateEvent.create({
      data: { estimateId: est.id, type: "archived", actor: input.actor, detail: `Archived by hand${reason ? `: ${reason}` : ""} (was ${est.status})` },
    });
  });
  logSystemEvent("info", "issued-estimate", `Estimate ${est.number} rev ${est.revision} archived by hand${reason ? `: ${reason}` : ""}`, {
    estimateId: est.id, reason, from: est.status, actor: input.actor,
  });
  return { ok: true, archivedAt, reason };
}

export type UnarchiveResult =
  | { ok: true; status: string }
  | { ok: false; status: 404 | 409; reason: string };

/**
 * The way back out (standing rule: nothing the app makes is one-way). Clears both columns; the
 * status was never touched, so the row returns to exactly the card it was in. The `unarchived`
 * event with a human actor is also what stops the automatic pass from archiving it again.
 */
export async function unarchiveEstimate(
  prisma: PrismaClient,
  estimateId: string,
  input: { actor: string },
): Promise<UnarchiveResult> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: { id: true, number: true, revision: true, status: true, archivedAt: true, archivedReason: true },
  });
  if (!est) return { ok: false, status: 404, reason: "Estimate not found." };
  if (!est.archivedAt) return { ok: false, status: 409, reason: "This estimate is not archived — nothing to unarchive." };
  await prisma.$transaction(async (tx) => {
    await tx.issuedEstimate.update({ where: { id: est.id }, data: { archivedAt: null, archivedReason: null } });
    await tx.issuedEstimateEvent.create({
      data: {
        estimateId: est.id,
        type: "unarchived",
        actor: input.actor,
        detail: `Unarchived — back on the ${est.status} list${est.archivedReason ? ` (had been archived: ${est.archivedReason})` : ""}`,
      },
    });
  });
  logSystemEvent("info", "issued-estimate", `Estimate ${est.number} rev ${est.revision} unarchived — still ${est.status}`, {
    estimateId: est.id, status: est.status, actor: input.actor,
  });
  return { ok: true, status: est.status };
}
