/**
 * Signing in person - ONE function for both doors that put a device in the customer's hand.
 *
 * Phase 3 unit C (2026-10-08, one-estimating-system plan). Kyle, 2026-09-24 (two apps, two
 * places): taking a signature with the customer standing there is a FIELD action; the office
 * desk's twin is "Record acceptance" (officeAcceptance.ts), a different record that never forges
 * a signature. Until now the only in-person signing screen was the CRM's (SigningModePage), so the
 * route lived inside app.ts with its three side effects inline. The technician's phone now has the
 * same screen, which would have meant a second copy of the sequence below - so it moved here, and
 * both routes are thin wrappers around `signInPerson`:
 *
 *   POST /issued-estimates/:id/sign-in-person              (src/app.ts, the office's device)
 *   POST /health-record/issued-estimates/:id/sign-in-person (routes/health-record.ts, the tech's phone,
 *                                                            behind visit assignment)
 *
 * What the sequence is, in order:
 *   1. signEstimateInPerson - the signature itself, channel "in_person". Every rule that decides
 *      whether a signature is acceptable (sign-once, void, lost, expired, superseded, the options
 *      chosen, one-or-the-other, the drawn mark) is in applySignature, not here and not in a route.
 *   2. notifyOwnerSigned - tells Kyle a signature landed (nothing is auto-sent to the customer).
 *   3. createJobFromSignedEstimate - the signed quote becomes a job at once (Kyle, 2026-08-24).
 *      Idempotent; a failure is logged and never undoes the signature.
 *   4. archiveCompetingEstimates - the options not chosen are put away (Kyle, 2026-10-01).
 *
 * Steps 2-4 run only after the signature is durably written and none can fail it.
 *
 * The request body is `inPersonSignBodySchema`, shared by both routes so the limits cannot drift
 * (signerName 1-200, signatureImage <= 400000 characters, selectedOptions at most MAX_OPTIONS).
 */

import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { MAX_OPTIONS } from "../../shared/estimateOptions";
import { createJobFromSignedEstimate } from "./accountSpine";
import { archiveCompetingEstimates, type ArchiveSweepResult } from "./estimateArchive";
import { signEstimateInPerson } from "./issuedEstimateService";
import { notifyOwnerSigned } from "./issuedEstimateSend";
import { billedTotalOf } from "./stripePayments";

export const inPersonSignBodySchema = z.object({
  signerName: z.string().trim().min(1).max(200),
  // The drawn mark. Validated in applySignature, which is the single write path for every door.
  signatureImage: z.string().max(400_000).optional(),
  // Which options the customer took. Optional, and the service tells absent from empty: absent
  // means the client never offered a choice, empty means everything was declined and is refused.
  // Capped at the option limit (8), not three.
  selectedOptions: z.array(z.string().trim().max(4)).max(MAX_OPTIONS).optional(),
});

export type InPersonSignBody = z.infer<typeof inPersonSignBodySchema>;

/** The caller's address and browser, as both routes record them next to the signature. */
export function signerContextOf(req: {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
}): { ip: string; userAgent: string } {
  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0]) ?? req.socket.remoteAddress ?? "unknown";
  return { ip: ip.trim(), userAgent: String(req.headers["user-agent"] ?? "").slice(0, 500) };
}

export type SignInPersonResult =
  | {
      ok: true;
      estimateId: string;
      number: string;
      /** The signed job's visit, or null when job creation failed or was refused (logged). */
      jobVisitId: string | null;
      /** A change order that joined the CURRENT job: nothing new to schedule. */
      jobJoined: boolean;
      /** The other estimates at this address that were put away. */
      archived: ArchiveSweepResult["archived"];
      /** The options the customer took, as recorded. */
      selectedOptions: string[];
      /** What the signed document bills (the figure on the invoice), frozen at signing. */
      signedTotal: number;
    }
  | { ok: false; reason: string };

export async function signInPerson(
  prisma: PrismaClient,
  estimateId: string,
  body: InPersonSignBody,
  ctx: {
    ip: string;
    userAgent: string;
    /**
     * Who is recording it: "system:sign-in-person" for the office's device, "tech:<id>" for a
     * technician's phone. Written on the job-creation and archive events; the signature's own
     * actor stays the customer's.
     */
    actor: string;
    /** The person whose device it was, for the signed event's detail (the field passes "tech:<id>"). */
    recordedBy?: string | null;
  },
): Promise<SignInPersonResult> {
  const result = await signEstimateInPerson(prisma, estimateId, {
    signerName: body.signerName,
    signatureImage: body.signatureImage ?? null,
    // The customer ticks the options on the operator's device in front of him, so this door carries
    // the same choice the emailed link does. Null when the client did not send one - see SignInput.
    selectedOptions: Array.isArray(body.selectedOptions) ? body.selectedOptions.map(String) : null,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    recordedBy: ctx.recordedBy ?? null,
  });
  if (!result.ok) return { ok: false, reason: result.reason };

  // Internal, and it must never be able to fail the customer's signature - which is already
  // durably recorded by this point.
  notifyOwnerSigned(prisma, result.estimateId).catch((err) =>
    console.error("[IssuedEstimate] owner notification failed:", err),
  );

  // The signed quote becomes a job right here (Kyle, 2026-08-24: "It gets signed and there is no
  // scheduling proceedings. It should immediately go to the calendar view to schedule."). In-person
  // door ONLY - an emailed signature lands while Kyle is elsewhere, and he kept that door manual
  // (his ruling, same date). Idempotent, and never able to fail the signature: if job creation
  // breaks, the client just falls back to the old Done button. On the tech's phone, "Complete work
  // now" then folds this job onto the visit the tech is standing on (sameDayJob.completeWorkNow).
  let jobVisitId: string | null = null;
  // A change order that joined the CURRENT job (Kyle, 2026-09-20) - the signed screen then has
  // nothing new to schedule and says so instead of offering the calendar.
  let jobJoined = false;
  try {
    const job = await createJobFromSignedEstimate(prisma, result.estimateId, { actor: ctx.actor });
    if (job.ok) { jobVisitId = job.visitId; jobJoined = Boolean(job.joined); }
    else console.error("[IssuedEstimate] job creation after in-person sign refused:", job.reason);
  } catch (err) {
    console.error("[IssuedEstimate] job creation after in-person sign failed:", err);
  }

  // The options not chosen are put away (Kyle, 2026-10-01) - the other presented, unsigned
  // estimates at this address. services/estimateArchive.ts owns the rule; every signature door runs
  // it; it can never fail the signature. Returned so the signed screen can say what moved.
  const { archived } = await archiveCompetingEstimates(prisma, result.estimateId, ctx.actor);

  /*
    NO AUTO-SEND (Kyle, 2026-10-01): "I do not want auto send, manual review and send." - "No auto
    send across the board." This door once fired the invoice email and a ten-minute delayed
    deposit-request email the moment the signature landed. Both are gone; the customer gets the
    invoice when Kyle presses "Email the signed copy..." on the invoice drawer, and the deposit ask
    when he presses "Email deposit request" on the payment panel. notifyOwnerSigned (above) is what
    makes a manual send possible rather than forgotten.
  */

  // What was signed, read back from the frozen row: the figure the signed screen shows is the
  // server's, never added up on the phone.
  const signed = await prisma.issuedEstimate.findUnique({
    where: { id: result.estimateId },
    select: {
      number: true,
      total: true,
      tripCharge: true,
      selectedOptions: true,
      comboCapJson: true,
      discountJson: true,
      warrantyJson: true,
      options: { select: { option: true, subtotal: true } },
    },
  });
  return {
    ok: true,
    estimateId: result.estimateId,
    number: signed?.number ?? "",
    jobVisitId,
    jobJoined,
    archived,
    selectedOptions: (signed?.selectedOptions ?? []).map(String),
    signedTotal: signed
      ? billedTotalOf({
          total: signed.total,
          tripCharge: signed.tripCharge,
          selectedOptions: signed.selectedOptions.map(String),
          comboCapJson: signed.comboCapJson,
          discountJson: signed.discountJson,
          warrantyJson: signed.warrantyJson,
          optionsSubtotals: signed.options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
        })
      : 0,
  };
}
