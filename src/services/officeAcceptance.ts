/**
 * The office records an acceptance it was told about. (2026-09-24, closing-out-an-estimate, Unit 1)
 *
 * Kyle, 2026-09-24: *"The customer accepted button would be good on the estimate drawer, no need
 * to do sign in person on the CRM because that is being developed for an admin/dispatcher
 * (someone who stays in the office). The field app is for the techs on site."*
 *
 * Until this existed the only thing that moved a quote out of Sent/Viewed was a customer's
 * signature; the drawer offered Delete, Void and Mark lost — three ways to say the sale did NOT
 * happen. A job done on a handshake could only be closed by lying about it.
 *
 * ── A SIBLING OF applySignature, NOT A CALLER OF IT ─────────────────────────────────────────
 *
 * `applySignature` (issuedEstimateService.ts) hard-requires a drawn PNG: `checkSignatureImage`
 * refuses null with "Please draw your signature before accepting", and that refusal is the point
 * of that path — it is the one place a customer's mark is written and it is audited money code.
 * This module does NOT weaken that check and does NOT fabricate a signature image. It writes the
 * same END STATE a signature writes — `status: "signed"`, `signedAt`, `signerName`, the frozen
 * selection / combination cap / programme discount, `adoptSupersededInvoice` in the same
 * transaction — with `signedChannel: "office"`, `signatureImage: null`, and `acceptedVia` saying
 * how the customer told us.
 *
 * The selection → combination cap → discount freezing below is DUPLICATED from applySignature on
 * purpose. Extracting it would mean refactoring the signature write path; the dispatch said to
 * take the duplication instead, and it is right: the two must agree on the arithmetic, and a
 * test pins that they do (tests/officeAcceptance.test.ts).
 *
 * ── WHY status "signed" AND NOT "accepted" ──────────────────────────────────────────────────
 *
 * Every money and reporting filter is an allow-list on the exact string "signed" —
 * `invoiceGroup.ts` LIVE_SIGNED, /invoices, GET /jobs, the P&L, the job card — and
 * scripts/readDataChecks.ts check #1 exists to police it. A new status would silently drop the
 * sale out of every one of them. The channel is what keeps the two records visibly different
 * (CLAUDE.md, two apps, two people, two places): every surface reads shared/acceptance.ts and
 * prints "accepted by phone, recorded by the office", never a bare "signed".
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { ACCEPTED_VIA, acceptedViaPhrase, type AcceptedVia } from "../../shared/acceptance";
import { isPastValidity } from "../../shared/estimateExpiry";
import { reopenedStatusOf } from "./estimateExpiry";
import { adoptSupersededInvoice, type AdoptedInvoice } from "./issuedEstimateService";
import { LIVE_SIGNED, LIVE_SIGNED_CHANGE_ORDER } from "./invoiceGroup";
import { selectionCap, type MarkupBand } from "./materialMarkupCap";
import { discountFor, programmeFor } from "./discounts";
import { logSystemEvent } from "./systemEvents";

export { ACCEPTED_VIA };

/**
 * What `consentText` says on an office acceptance. Deliberately NOT the e-signature consent
 * (CONSENT_TEXT, issuedEstimateService.ts): nobody typed a name and tapped Accept, so the record
 * must not claim they did. This is the wording the PDF prints in place of the drawn mark.
 */
export function officeAcceptanceText(via: AcceptedVia, acceptedBy: string): string {
  return (
    `Accepted ${acceptedViaPhrase(via)} by ${acceptedBy}, as told to and recorded by the Red Cedar Electric ` +
    "office. No signature was collected: this is the office's record of the customer's acceptance of " +
    "the scope and the price on this estimate, not an electronic signature."
  );
}

export interface AcceptInput {
  acceptedVia: AcceptedVia;
  /** Who said yes — defaults to the account name on the drawer, editable. */
  acceptedBy: string;
  /** Internal only. Never customer-facing. */
  note?: string | null;
  /**
   * Which options they took. Null/undefined = the whole estimate (the same reading the signature
   * path gives a client that never offered a choice). Validated against the options this estimate
   * really has; an explicit empty choice on an estimate with options is refused.
   */
  selectedOptions?: string[] | null;
  actor?: string;
}

export type AcceptResult =
  | { ok: true; estimateId: string; number: string; revision: number; adopted: AdoptedInvoice | null }
  | { ok: false; status: 400 | 404 | 409; reason: string };

const CHICAGO_DATE: Intl.DateTimeFormatOptions = { timeZone: "America/Chicago" };

/** The Copy-to-new sentence — Kyle's ruling, 2026-09-24: an expired quote is reissued, never accepted. */
export function expiredRefusal(est: { createdAt: Date; validDays: number }): string {
  const expiresAt = new Date(est.createdAt.getTime() + est.validDays * 86_400_000);
  return `This quote expired on ${expiresAt.toLocaleDateString("en-US", CHICAGO_DATE)}. Use Copy to new to reissue at today's pricing.`;
}

/**
 * Record the acceptance. Each refusal names the door (the /lost convention):
 *
 *   already signed      → "Already accepted / signed."
 *   void                → "This estimate is void."
 *   lost                → "Marked lost — reopen it first."
 *   draft (never sent)  → "Never sent to the customer."
 *   superseded          → "Replaced by rev N — accept that one."
 *   past validity       → "This quote expired on DATE. Use Copy to new to reissue at today's pricing."
 *
 * Expiry is the SAME date arithmetic applySignature uses (createdAt + validDays, via
 * shared/estimateExpiry.ts) — not the nightly sweep's label — so a quote that lapsed at 12:01 AM
 * is refused before the cron relabels it. Sign-once is a CONDITIONAL update on `signedAt: null`,
 * exactly as the signature path does it, so a phone acceptance racing the customer's own
 * emailed signature produces one record and one "already" answer.
 */
export async function acceptEstimateFromOffice(
  prisma: PrismaClient,
  estimateId: string,
  input: AcceptInput,
): Promise<AcceptResult> {
  const acceptedBy = input.acceptedBy.trim();
  if (acceptedBy.length < 2) return { ok: false, status: 400, reason: "Who accepted? Type their name." };
  if (!(ACCEPTED_VIA as readonly string[]).includes(input.acceptedVia)) {
    return { ok: false, status: 400, reason: "How did they tell us? Pick one." };
  }

  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: {
      id: true, number: true, revision: true, status: true, signedAt: true, voidedAt: true, lostAt: true,
      sentAt: true, createdAt: true, validDays: true, exclusiveOptions: true,
      jobBandsJson: true, discountType: true, discountPercent: true, tripCharge: true,
      supersededBy: { select: { revision: true } },
      options: { select: { option: true, subtotal: true } },
    },
  });
  if (!est) return { ok: false, status: 404, reason: "Estimate not found." };
  if (est.signedAt || est.status === "signed") return { ok: false, status: 409, reason: "Already accepted / signed." };
  if (est.status === "void" || est.voidedAt) return { ok: false, status: 409, reason: "This estimate is void." };
  if (est.status === "lost" || est.lostAt) return { ok: false, status: 409, reason: "Marked lost — reopen it first." };
  if (est.supersededBy) {
    return { ok: false, status: 409, reason: `Replaced by rev ${est.supersededBy.revision} — accept that one.` };
  }
  // Past validity is checked BEFORE the status allow-list so a row the sweep has already
  // relabelled "expired" gets the Copy-to-new sentence rather than a status complaint.
  if (est.status === "expired" || isPastValidity(est)) {
    return { ok: false, status: 409, reason: expiredRefusal(est) };
  }
  if (est.status !== "sent" && est.status !== "viewed") {
    // Only "draft" reaches here today; an allow-list so a future status is refused, not accepted.
    return { ok: false, status: 409, reason: "Never sent to the customer. Send it first, then record their acceptance." };
  }

  /*
    ── WHAT THEY ACTUALLY BOUGHT — the same reading applySignature gives ──────────────────────
    Null = the whole estimate. Anything that is not a real option on THIS estimate is discarded.
    An explicit empty choice on an estimate with options is refused: accepting no work is not a
    sale. One-or-the-other options (Kyle, 2026-08-25) accept exactly one.
  */
  const valid = new Set(est.options.map((o) => o.option as string));
  let bought: string[];
  if (input.selectedOptions == null) {
    bought = [...valid];
  } else {
    bought = input.selectedOptions.map((o) => o.trim().toUpperCase()).filter((o) => valid.has(o));
    if (valid.size > 0 && bought.length === 0) {
      return { ok: false, status: 400, reason: "Which option did they take? Pick at least one." };
    }
  }
  if (est.exclusiveOptions && valid.size > 1 && bought.length !== 1) {
    return { ok: false, status: 400, reason: "This estimate offers one-or-the-other options — pick exactly one." };
  }

  /*
    ── THE THIRD GATE AND THE PROGRAMME DISCOUNT, FROZEN NOW ───────────────────────────────────
    Duplicated from applySignature (see the file comment): the combination cap from the frozen
    lines of the options taken, priced with the band schedule frozen AT ISSUE; the discount as 5%
    of what they are actually paying, capped. Computed here and nowhere else at acceptance time.
  */
  const frozenLines = (await prisma.issuedEstimateLine.findMany({
    where: { estimateId },
    select: { option: true, materialCost: true, materialSell: true, inMaterialCap: true },
  })).map((l) => ({
    option: l.option,
    materialCost: l.inMaterialCap ? l.materialCost : null,
    materialSell: l.inMaterialCap ? l.materialSell : null,
  }));
  const frozenBands = est.jobBandsJson ? (JSON.parse(est.jobBandsJson) as MarkupBand[]) : undefined;
  const comboCap = selectionCap(frozenLines, new Set(bought), frozenBands);
  const boughtSubtotals = est.options
    .filter((o) => bought.includes(o.option))
    .reduce((n, o) => n + o.subtotal, 0);
  const discount = discountFor(
    programmeFor(est.discountType, est.discountPercent),
    boughtSubtotals + (est.tripCharge ?? 0) - (comboCap.applied ? comboCap.reduction : 0),
  );

  const note = input.note?.trim() || null;
  const actor = input.actor ?? "human:crm-session";
  const consent = officeAcceptanceText(input.acceptedVia, acceptedBy);

  /*
    The acceptance and the invoice it takes over are ONE transaction, exactly as the signature's
    are (PUNCHLIST A1): if this is the accepted revision of an estimate the customer had already
    signed, the old row's change orders, payments and job move here before anyone reads the
    acceptance, and the old row is voided with the reason written down.
  */
  const written = await prisma.$transaction(async (tx) => {
    const result = await tx.issuedEstimate.updateMany({
      where: { id: estimateId, signedAt: null },
      data: {
        selectedOptions: bought as never,
        comboCapJson: JSON.stringify(comboCap),
        discountJson: discount ? JSON.stringify(discount) : null,
        signedAt: new Date(),
        // NEVER a signature: no image, no IP, no user agent. The office is not the customer.
        signatureImage: null,
        signerIp: null,
        signerUserAgent: null,
        signerName: acceptedBy,
        consentText: consent,
        signedChannel: "office",
        acceptedVia: input.acceptedVia,
        acceptedNote: note,
        status: "signed",
        // Same as applySignature: a signed row is never an archived row (services/estimateArchive.ts).
        archivedAt: null,
        archivedReason: null,
      },
    });
    if (result.count === 0) return { written: false as const, adopted: null };
    const adopted = await adoptSupersededInvoice(tx, estimateId, actor);
    await tx.issuedEstimateEvent.create({
      data: {
        estimateId,
        type: "accepted",
        actor,
        detail:
          `Accepted ${acceptedViaPhrase(input.acceptedVia)} by "${acceptedBy}", recorded by the office (rev ${est.revision}, was ${est.status}). ` +
          `No signature.${bought.length > 0 ? ` Options: ${bought.join(", ")}.` : ""}${note ? ` Note: ${note}` : ""}`,
      },
    });
    return { written: true as const, adopted };
  });
  if (!written.written) return { ok: false, status: 409, reason: "Already accepted / signed." };

  if (written.adopted) {
    const a = written.adopted;
    logSystemEvent("info", "issued-estimate", `Estimate ${est.number} rev ${est.revision} accepted by the office — took over the invoice from rev ${a.replaced.map((r) => r.revision).join(", ")}: ${a.changeOrders} change order(s), ${a.payments} payment(s), ${a.jobVisitId ? "same job" : "no job to inherit"}`, {
      estimateId,
      replacedEstimateIds: a.replaced.map((r) => r.id),
      changeOrders: a.changeOrders,
      payments: a.payments,
      jobVisitId: a.jobVisitId,
    });
  }
  logSystemEvent("info", "issued-estimate", `Estimate ${est.number} rev ${est.revision} accepted ${acceptedViaPhrase(input.acceptedVia)} by ${acceptedBy} — recorded by the office, no signature`, {
    estimateId,
    revision: est.revision,
    channel: "office",
    acceptedVia: input.acceptedVia,
    from: est.status,
    actor,
  });

  return { ok: true, estimateId, number: est.number, revision: est.revision, adopted: written.adopted };
}

// ─── The undo (Kyle's standing rule: nothing the app creates is permanent) ──────────────────

export type UnacceptResult =
  | { ok: true; status: "sent" | "viewed" | "expired"; jobAction: "none" | "cancelled_unscheduled" | "left_open_other_estimates" }
  | { ok: false; status: 404 | 409; reason: string };

/**
 * Take an office acceptance back, while nothing has moved. The row returns to where it was —
 * viewed if the customer had opened it, sent if not, expired if the window has since closed
 * (reopenedStatusOf, the same arithmetic reopen uses) — and the job the acceptance minted is
 * cancelled if it is still unscheduled and nothing else lives on it.
 *
 * REFUSED, naming Void as the door, once:
 *   - the row carries a customer's SIGNATURE (signedChannel in_person / email) — Undo is only for
 *     what the office itself recorded; a signature is voided with a reason, never erased;
 *   - a payment has been recorded on it;
 *   - a signed change order belongs to it;
 *   - the acceptance took over an earlier signed revision's invoice (that row is void now and
 *     its money moved — not unwindable);
 *   - its job is past contracted (scheduled, in progress, completed) or has a purchase order.
 */
export async function undoOfficeAcceptance(
  prisma: PrismaClient,
  estimateId: string,
  opts: { actor?: string } = {},
): Promise<UnacceptResult> {
  const actor = opts.actor ?? "human:crm-session";
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: {
      id: true, number: true, revision: true, status: true, signedAt: true, voidedAt: true, signedChannel: true,
      acceptedVia: true, jobVisitId: true, changeOrderForId: true, total: true,
      firstViewedAt: true, createdAt: true, validDays: true,
    },
  });
  if (!est) return { ok: false, status: 404, reason: "Estimate not found." };
  if (est.status === "void" || est.voidedAt) return { ok: false, status: 409, reason: "This estimate is void." };
  if (!est.signedAt) return { ok: false, status: 409, reason: "This estimate has not been accepted — nothing to undo." };
  if (est.signedChannel !== "office") {
    return {
      ok: false, status: 409,
      reason: "This estimate carries the customer's own signature. Undo only takes back an acceptance the office recorded — to cancel a signed sale, void it with a reason.",
    };
  }

  const [payments, changeOrders, takeover, job, purchaseOrders] = await Promise.all([
    prisma.payment.count({ where: { estimateId: est.id, status: { not: "failed" } } }),
    prisma.issuedEstimate.findMany({
      where: { changeOrderForId: est.id, ...LIVE_SIGNED_CHANGE_ORDER },
      select: { number: true },
    }),
    prisma.issuedEstimateEvent.findFirst({
      where: { estimateId: est.id, type: "invoice_taken_over", at: { gte: est.signedAt } },
      select: { detail: true },
    }),
    est.jobVisitId
      ? prisma.visit.findUnique({ where: { id: est.jobVisitId }, select: { id: true, status: true, scheduledStart: true, estimatedCost: true } })
      : Promise.resolve(null),
    est.jobVisitId
      ? prisma.purchaseOrder.count({ where: { jobId: est.jobVisitId, status: { not: "cancelled" } } })
      : Promise.resolve(0),
  ]);
  if (payments > 0) {
    return { ok: false, status: 409, reason: `${payments} payment${payments > 1 ? "s have" : " has"} been recorded on this invoice — the acceptance cannot be undone. Void the estimate instead (refunds stay manual).` };
  }
  if (changeOrders.length > 0) {
    return { ok: false, status: 409, reason: `Signed change order${changeOrders.length > 1 ? "s" : ""} ${changeOrders.map((c) => c.number).join(", ")} belong${changeOrders.length > 1 ? "" : "s"} to this invoice — the acceptance cannot be undone. Void the change order${changeOrders.length > 1 ? "s" : ""} first, then this estimate.` };
  }
  if (takeover) {
    return { ok: false, status: 409, reason: "This acceptance took over the invoice from an earlier signed revision, which is void now — that cannot be unwound. Void this estimate instead." };
  }
  if (job && job.status !== "contracted" && job.status !== "cancelled") {
    return { ok: false, status: 409, reason: `The job is already ${job.status.replaceAll("_", " ")} — the acceptance cannot be undone. Void the estimate instead; that cancels the job.` };
  }
  if (job && job.scheduledStart) {
    return { ok: false, status: 409, reason: "The job is on the schedule — the acceptance cannot be undone. Void the estimate instead; that cancels the appointment." };
  }
  if (purchaseOrders > 0) {
    return { ok: false, status: 409, reason: `${purchaseOrders} purchase order${purchaseOrders > 1 ? "s are" : " is"} on this job — the acceptance cannot be undone. Void the estimate instead.` };
  }

  // Other live signed work on the same job (a change order that joined the current job, or the
  // parent this change order joined) keeps the job; only a job that exists for this row alone
  // is cancelled.
  const others = job
    ? await prisma.issuedEstimate.count({ where: { id: { not: est.id }, ...LIVE_SIGNED, OR: [{ jobVisitId: job.id }, { visitId: job.id }] } })
    : 0;

  const status = reopenedStatusOf(est);
  let jobAction: "none" | "cancelled_unscheduled" | "left_open_other_estimates" = "none";
  await prisma.$transaction(async (tx) => {
    await tx.issuedEstimate.update({
      where: { id: est.id },
      data: {
        status,
        signedAt: null,
        signerName: null,
        consentText: null,
        signedChannel: null,
        acceptedVia: null,
        acceptedNote: null,
        selectedOptions: [] as never,
        comboCapJson: null,
        discountJson: null,
        jobVisitId: null,
      } satisfies Prisma.IssuedEstimateUpdateInput,
    });
    if (job && job.status === "contracted") {
      if (others > 0) {
        // The job stays for the rest of its signed work; this row's share leaves its contracted figure.
        await tx.visit.update({
          where: { id: job.id },
          data: { estimatedCost: Math.round(((job.estimatedCost ?? 0) - est.total) * 100) / 100 },
        });
        jobAction = "left_open_other_estimates";
      } else {
        // Unscheduled and nobody else's: no calendar event, no customer notice — cancel the record.
        await tx.visit.update({ where: { id: job.id }, data: { status: "cancelled" } });
        jobAction = "cancelled_unscheduled";
      }
    }
    await tx.issuedEstimateEvent.create({
      data: {
        estimateId: est.id,
        type: "unaccepted",
        actor,
        detail: `Office acceptance undone — back to ${status}${est.acceptedVia ? ` (had been accepted ${acceptedViaPhrase(est.acceptedVia)})` : ""}${jobAction === "cancelled_unscheduled" ? "; the unscheduled job was cancelled" : jobAction === "left_open_other_estimates" ? "; the job stays for its other signed work" : ""}.`,
      },
    });
  });
  logSystemEvent("info", "issued-estimate", `Estimate ${est.number} rev ${est.revision} office acceptance undone — back to ${status}`, {
    estimateId: est.id, status, jobId: job?.id ?? null, jobAction, actor,
  });
  return { ok: true, status, jobAction };
}
