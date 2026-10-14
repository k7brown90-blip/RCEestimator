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
 *
 * SIGNED WITH NO SIGNAL (Phase 7 unit U7, 2026-10-10). The phone saves the signature first and
 * sends it when it can, so the body also carries the phone's capture id, its clock, the revision,
 * the figures' fingerprint and the consent sentence it showed. A resend after a lost answer gets the
 * original success and runs steps 2-4 NOT AGAIN; a refusal of a signature the phone HELD (taken
 * with no signal, or sent again — `heldOnPhone`) also writes a SystemEvent (source
 * "field-signature") and emails Kyle to call the customer, while a refusal of a capture's own first
 * try is simply shown to the customer standing there. The office's screen sends none of these
 * fields and is unchanged.
 *
 * A SIGNATURE THE PHONE NEVER DELIVERED (Phase 7 unit U8, 2026-10-10). A signature saved on the
 * phone can be cancelled by the technician before it is recorded ("Cancel this signature (not
 * recorded yet)", reason required), and a refused one dismissed after the customer has been called
 * ("I've called the customer — dismiss", reason required). Neither is a signature and neither
 * changes the estimate; each is filed as a SystemEvent through `fileSignatureEvent` so nothing the
 * phone held goes silently (standing rule: nothing is deleted without a trail). The CRM reads them
 * with scripts/readSystemEvents --source field-signature.
 */

import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { MAX_OPTIONS } from "../../shared/estimateOptions";
import { createJobFromSignedEstimate } from "./accountSpine";
import { escapeHtml, sendBrandedEmail } from "./confirmationEmail";
import { archiveCompetingEstimates, type ArchiveSweepResult } from "./estimateArchive";
import { signEstimateInPerson } from "./issuedEstimateService";
import { notifyOwnerSigned } from "./issuedEstimateSend";
import { billedTotalOf } from "./stripePayments";
import { logSystemEvent } from "./systemEvents";

export const inPersonSignBodySchema = z.object({
  signerName: z.string().trim().min(1).max(200),
  // The drawn mark. Validated in applySignature, which is the single write path for every door.
  signatureImage: z.string().max(400_000).optional(),
  // Which options the customer took. Optional, and the service tells absent from empty: absent
  // means the client never offered a choice, empty means everything was declined and is refused.
  // Capped at the option limit (8), not three.
  selectedOptions: z.array(z.string().trim().max(4)).max(MAX_OPTIONS).optional(),
  // ── Captured on the phone, possibly with no signal (Phase 7 unit U7, 2026-10-10) ──
  // All optional and all judged in applySignature (the one write path): the office's screen and the
  // emailed link send none of them. The phone sends every one on every capture, online or not.
  //   clientSignatureId - minted on the phone at capture; a resend after a lost answer gets the
  //                       original success, never "already signed"
  //   capturedAt        - the phone's clock at capture (ISO 8601 with offset); honoured inside the
  //                       30 days even when it arrives after day 30 (Kyle, 2026-10-09, ruling 10)
  //   sentAt            - the phone's clock at the send (D2, 2026-10-13): only the gap between the
  //                       two is trusted, so a phone whose clock is days wrong is judged exactly as
  //                       a correct one. applySignature refuses a capturedAt without it.
  //   heldOnPhone       - true when this send is NOT the capture's own first try: the signature was
  //                       taken with no signal, or an earlier try got no answer (D1, 2026-10-13).
  //                       A refusal of such a send means the customer may have left believing they
  //                       signed, so Kyle is emailed; a refusal of a first try is on the screen in
  //                       front of the customer and nobody is emailed.
  //   revision          - the revision the phone held
  //   figuresKey        - the server's fingerprint of the figures shown (lifecycle.issued.figuresKey)
  //   consentText       - the sentence the customer read, which must be CONSENT_TEXT exactly
  clientSignatureId: z.string().uuid().optional(),
  capturedAt: z.string().datetime({ offset: true }).optional(),
  sentAt: z.string().datetime({ offset: true }).optional(),
  heldOnPhone: z.boolean().optional(),
  revision: z.number().int().positive().optional(),
  figuresKey: z.string().min(1).max(128).optional(),
  consentText: z.string().max(2000).optional(),
});

export type InPersonSignBody = z.infer<typeof inPersonSignBodySchema>;

/**
 * What the phone files for a signature it held and never delivered (Phase 7 unit U8): which capture
 * (`signatureId`, the same id a delivery would have carried), what became of it, and the
 * technician's reason. `refusal` rides along on a dismissal so the event says what the office had
 * answered. No drawn mark: the image never leaves the phone for an event.
 */
export const signatureEventBodySchema = z.object({
  signatureId: z.string().uuid(),
  event: z.enum(["cancelled", "dismissed"]),
  reason: z.string().trim().min(1).max(500),
  signerName: z.string().trim().min(1).max(200),
  capturedAt: z.string().datetime({ offset: true }).optional(),
  refusal: z.string().max(1000).optional(),
});

export type SignatureEventBody = z.infer<typeof signatureEventBodySchema>;

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
    // The phone's capture (Phase 7 unit U7); every one absent on the office's door.
    clientSignatureId: body.clientSignatureId ?? null,
    capturedAt: body.capturedAt ?? null,
    sentAt: body.sentAt ?? null,
    revision: body.revision ?? null,
    figuresKey: body.figuresKey ?? null,
    consentText: body.consentText ?? null,
  });
  if (!result.ok) {
    // A signature the phone HELD (taken with no signal, or sent again after a try got no answer)
    // was refused: the customer may have left believing they signed. Kyle is told and a SystemEvent
    // is written (design §6). Only for such a send (`heldOnPhone`, D1 2026-10-13) - a refusal of
    // the capture's own first try is shown on the screen with the customer standing there, exactly
    // as the office's screen shows its refusal at the desk, and nobody is emailed about it. Never
    // awaited into the answer and never able to change it.
    if (body.clientSignatureId && body.heldOnPhone) {
      notifyOwnerSignatureRefused(prisma, estimateId, result.reason, body, ctx).catch((err) =>
        console.error("[IssuedEstimate] refused-signature notification failed:", err),
      );
    }
    return { ok: false, reason: result.reason };
  }

  // THE SAME CAPTURE, SENT AGAIN (Phase 7 unit U7): the phone lost the first answer. The signature
  // landed then, and so did Kyle's notification, the job and the archive sweep - none runs twice.
  // The answer is read back from the row exactly as the first one was built below.
  if (result.replayed) {
    const already = await prisma.issuedEstimate.findUnique({
      where: { id: result.estimateId },
      select: { jobVisitId: true, changeOrderForId: true, addToCurrentJob: true },
    });
    return {
      ...(await signedFigures(prisma, result.estimateId)),
      jobVisitId: already?.jobVisitId ?? null,
      jobJoined: Boolean(already?.changeOrderForId && already?.addToCurrentJob && already?.jobVisitId),
      archived: [],
    };
  }

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

  return { ...(await signedFigures(prisma, result.estimateId)), jobVisitId, jobJoined, archived };
}

/**
 * What was signed, read back from the frozen row: the figure the signed screen shows is the
 * server's, never added up on the phone. The same read answers a first delivery and a replay.
 */
async function signedFigures(
  prisma: PrismaClient,
  estimateId: string,
): Promise<{ ok: true; estimateId: string; number: string; selectedOptions: string[]; signedTotal: number }> {
  const signed = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
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
    estimateId,
    number: signed?.number ?? "",
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

/** The SystemEvent source a refused phone-captured signature is filed under (scripts/readSystemEvents --source). */
export const FIELD_SIGNATURE_EVENT_SOURCE = "field-signature";

/**
 * Tech-supplied text (a reason, the office's refusal, a signer's name) goes into a human message
 * line and the console mirror; a newline in it would forge a second log line. Control characters,
 * line and paragraph separators collapse to single spaces. The details JSON keeps the value as sent.
 */
export function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/** Details marker on the one event a refused held signature writes: the dedupe lookup matches it exactly. */
const REFUSED_KIND = "signature-refused";
/** Details marker on the single "notifications suppressed" event a technician over the hourly cap writes. */
const SUPPRESSED_KIND = "signature-refused-suppressed";
/** Refusal emails one technician can cause per hour; past it nothing more is emailed (security review M1, 2026-10-13). */
export const REFUSAL_EMAILS_PER_TECH_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;
/** Capture ids being judged right now, so two simultaneous sends of one capture cannot both pass the lookup. */
const refusalInFlight = new Set<string>();

/**
 * A signature the phone captured was refused when it reached the office (design §6, Phase 7 U7):
 * the estimate was revised, voided or marked lost meanwhile, it expired, another signer got there
 * first, the figures or the consent wording changed, or the phone's clock was wrong. The customer
 * may have driven off believing they signed — so Kyle gets an email naming them, and a SystemEvent
 * (source "field-signature") keeps it findable. Same internal address as notifyOwnerSigned
 * (SUMMARY_EMAIL, else GMAIL_USER), same branded sender. Nothing here can change the refusal.
 */
async function notifyOwnerSignatureRefused(
  prisma: PrismaClient,
  estimateId: string,
  reason: string,
  body: InPersonSignBody,
  ctx: { actor: string; ip: string },
): Promise<void> {
  // AT MOST ONE notice per capture, and a ceiling per technician (security review M1, 2026-10-13):
  // one tech token resending the same - or freshly minted - refused body must not be able to email
  // Kyle at will. The event is written AWAITED (not fire-and-forget) so the next lookup sees it.
  const captureId = body.clientSignatureId;
  if (!captureId || refusalInFlight.has(captureId)) return;
  refusalInFlight.add(captureId);
  try {
    const noticed = await prisma.systemEvent.findFirst({
      where: {
        source: FIELD_SIGNATURE_EVENT_SOURCE,
        AND: [
          { detailsJson: { contains: `"kind":"${REFUSED_KIND}"` } },
          { detailsJson: { contains: `"clientSignatureId":"${captureId}"` } },
        ],
      },
      select: { id: true },
    });
    if (noticed) return;

    const since = new Date(Date.now() - HOUR_MS);
    const recordedBy = `"recordedBy":${JSON.stringify(ctx.actor)}`;
    const sentThisHour = await prisma.systemEvent.count({
      where: {
        source: FIELD_SIGNATURE_EVENT_SOURCE,
        createdAt: { gte: since },
        AND: [{ detailsJson: { contains: `"kind":"${REFUSED_KIND}"` } }, { detailsJson: { contains: recordedBy } }],
      },
    });
    if (sentThisHour >= REFUSAL_EMAILS_PER_TECH_PER_HOUR) {
      const told = await prisma.systemEvent.findFirst({
        where: {
          source: FIELD_SIGNATURE_EVENT_SOURCE,
          createdAt: { gte: since },
          AND: [{ detailsJson: { contains: `"kind":"${SUPPRESSED_KIND}"` } }, { detailsJson: { contains: recordedBy } }],
        },
        select: { id: true },
      });
      if (!told) {
        const message = `Refused-signature emails from ${oneLine(ctx.actor)} are suppressed: ${REFUSAL_EMAILS_PER_TECH_PER_HOUR} already went in the last hour`;
        console.warn(`[${FIELD_SIGNATURE_EVENT_SOURCE}] ${message}`);
        await prisma.systemEvent.create({
          data: {
            level: "warn",
            source: FIELD_SIGNATURE_EVENT_SOURCE,
            message,
            detailsJson: JSON.stringify({ kind: SUPPRESSED_KIND, recordedBy: ctx.actor, ip: ctx.ip, limit: REFUSAL_EMAILS_PER_TECH_PER_HOUR }),
          },
        });
      }
      return;
    }
    await sendRefusalNotice(prisma, estimateId, reason, body, ctx);
  } finally {
    refusalInFlight.delete(captureId);
  }
}

async function sendRefusalNotice(
  prisma: PrismaClient,
  estimateId: string,
  reason: string,
  body: InPersonSignBody,
  ctx: { actor: string; ip: string },
): Promise<void> {
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: { number: true, revision: true, title: true, customerName: true, customerPhone: true, customerEmail: true, serviceAddress: true },
  });
  const number = est?.number ?? estimateId;
  const customer = est?.customerName ?? "the customer";
  const message = `An in-person signature taken offline was refused for estimate ${oneLine(number)}: ${oneLine(reason)} — contact ${oneLine(customer)}`;
  console.warn(`[${FIELD_SIGNATURE_EVENT_SOURCE}] ${message}`);
  await prisma.systemEvent.create({
    data: {
      level: "warn",
      source: FIELD_SIGNATURE_EVENT_SOURCE,
      message,
      detailsJson: JSON.stringify({
        kind: REFUSED_KIND,
        estimateId,
        revision: est?.revision ?? null,
        clientSignatureId: body.clientSignatureId ?? null,
        capturedAt: body.capturedAt ?? null,
        signerName: body.signerName,
        recordedBy: ctx.actor,
        ip: ctx.ip,
      }),
    },
  });
  if (!est) return;

  const to = (process.env.SUMMARY_EMAIL ?? process.env.GMAIL_USER ?? "").trim();
  if (!to) {
    console.warn("[IssuedEstimate] SUMMARY_EMAIL not set — refused-signature notification skipped.");
    return;
  }
  const cell = (label: string, value: string) =>
    `<tr><td style="padding:3px 12px 3px 0;color:#666;">${label}</td><td>${escapeHtml(value)}</td></tr>`;
  const capturedLine = body.capturedAt
    ? ` The phone says the customer signed at ${new Date(body.capturedAt).toLocaleString("en-US", { timeZone: "America/Chicago", timeZoneName: "short" })}.`
    : "";
  const bodyHtml = `
    <p style="font-size:16px;">An in-person signature taken offline was refused: <strong>${escapeHtml(reason)}</strong> — contact <strong>${escapeHtml(customer)}</strong>.</p>
    <p style="font-size:14px;">${escapeHtml(body.signerName)} signed estimate <strong>${escapeHtml(number)}</strong>${est.revision > 1 ? ` (rev ${est.revision})` : ""} on the technician's phone, and the office could not record it when the phone reconnected.${escapeHtml(capturedLine)} The customer may believe the work is agreed — call them.</p>
    <table style="font-size:14px;border-collapse:collapse;">
      ${cell("Customer", customer)}
      ${est.customerPhone ? cell("Phone", est.customerPhone) : ""}
      ${est.customerEmail ? cell("Email", est.customerEmail) : ""}
      ${cell("Job", est.title)}
      ${est.serviceAddress ? cell("Address", est.serviceAddress) : ""}
      ${cell("Refused because", reason)}
      ${cell("Phone held by", ctx.actor)}
    </table>`;
  await sendBrandedEmail({
    to,
    subject: `SIGNATURE REFUSED — ${number} — ${customer}`,
    headline: "An in-person signature could not be recorded",
    bodyHtml,
  });
}

/**
 * File what became of a signature the phone held and never delivered (Phase 7 unit U8,
 * 2026-10-10): CANCELLED by the technician before it was recorded, or a REFUSED one DISMISSED after
 * the customer was called. A record, not a signature: nothing on the estimate changes, no email
 * goes (a refusal already emailed Kyle when it happened), and the event is findable beside the
 * refusals under the same source. Idempotent on (signatureId, event): the phone files it on the
 * next sync and a lost answer makes it file again, so a second filing is answered as the first
 * and writes nothing. The SystemEvent write itself is fire-and-forget (systemEvents.ts), so the
 * duplicate check reads what earlier passes wrote.
 */
export async function fileSignatureEvent(
  prisma: PrismaClient,
  estimateId: string,
  body: SignatureEventBody,
  ctx: { actor: string; ip: string },
): Promise<{ filed: true; duplicate: boolean } | { filed: false; reason: string }> {
  // A cancellation says "this was never recorded". If the estimate's own signature IS this capture,
  // it WAS recorded (the answer got lost on the way back), and a "cancelled" record next to a real
  // signature would be false (security review L3, 2026-10-13). Refused, in plain words.
  if (body.event === "cancelled") {
    const recorded = await prisma.issuedEstimate.findUnique({ where: { id: estimateId }, select: { clientSignatureId: true } });
    if (recorded?.clientSignatureId === body.signatureId) {
      return { filed: false, reason: "That signature was recorded at the office — it can't be cancelled from the phone." };
    }
  }
  const already = await prisma.systemEvent.findFirst({
    where: {
      source: FIELD_SIGNATURE_EVENT_SOURCE,
      AND: [
        { detailsJson: { contains: `"signatureId":"${body.signatureId}"` } },
        { detailsJson: { contains: `"event":"${body.event}"` } },
      ],
    },
    select: { id: true },
  });
  if (already) return { filed: true, duplicate: true };
  const est = await prisma.issuedEstimate.findUnique({
    where: { id: estimateId },
    select: { number: true, revision: true, customerName: true },
  });
  const number = est?.number ?? estimateId;
  const what =
    body.event === "cancelled"
      ? `A signature saved on the phone for estimate ${number} was cancelled before it was recorded`
      : `A refused in-person signature for estimate ${number} was dismissed after the customer was called`;
  logSystemEvent("info", FIELD_SIGNATURE_EVENT_SOURCE, `${oneLine(what)}: ${oneLine(body.reason)}`, {
    estimateId,
    revision: est?.revision ?? null,
    customer: est?.customerName ?? null,
    signatureId: body.signatureId,
    event: body.event,
    reason: body.reason,
    signerName: body.signerName,
    capturedAt: body.capturedAt ?? null,
    refusal: body.refusal ?? null,
    recordedBy: ctx.actor,
    ip: ctx.ip,
  });
  return { filed: true, duplicate: false };
}
