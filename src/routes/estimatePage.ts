/**
 * The customer's estimate page — `/e/:token`. (P027)
 *
 * THE ONLY UNAUTHENTICATED SURFACE THIS PROMPT ADDS, and it is two routes:
 *
 *   GET  /e/:token        read the estimate (records the first view)
 *   POST /e/:token/sign   accept it
 *
 * Both are on the P015 allowlist with credential "URL-path token", and nothing else was added.
 *
 * THE CAPABILITY MODEL. The token is 32 random bytes (256 bits) and it scopes to exactly one
 * estimate: every read is `findUnique({ where: { token } })`, so there is no id, no list, no
 * filter, and no query parameter through which one token could reach another estimate. The
 * customer never sees an internal id — the page renders the house estimate number, which is not
 * a lookup key here.
 *
 * ENUMERATION. A wrong token, a malformed token, a superseded revision and a voided estimate all
 * render the SAME "not available" page with the same status. A prober learns nothing about which
 * of those it hit. The token's shape is validated before any query runs, so a junk path segment
 * never becomes a database lookup.
 *
 * WHY HTML AND NOT THE REACT APP. The customer is not a CRM user, has no session, and is opening
 * a link on a phone from their email. Server-rendered HTML gets there in one request with no
 * bundle, and it keeps this surface completely outside the authenticated client — the React app
 * never has to learn how to render for a non-user.
 */

import express from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler, readParam } from "./agent-helpers";
import {
  getEstimateByToken,
  recordFirstView,
  signEstimate,
} from "../services/issuedEstimateService";
import { renderEstimatePage, renderUnavailable } from "../services/issuedEstimateRender";
import { notifyOwnerSigned, publicBaseUrl, sendInvoiceEmail } from "../services/issuedEstimateSend";
import { paymentSummary } from "../services/stripePayments";
import { sendDepositRequestEmail } from "../services/paymentReceipts";
import { createJobFromSignedEstimate } from "../services/accountSpine";

export const estimatePageRouter = express.Router();

/** The one place a client IP is derived, so the signed record and the logs agree. */
function clientIp(req: express.Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (first ?? req.socket.remoteAddress ?? "unknown").trim();
}

estimatePageRouter.get(
  "/:token",
  asyncHandler(async (req, res) => {
    const token = readParam(req, "token");
    const found = await getEstimateByToken(prisma, token);
    if (!found.ok) {
      // 404 for every failure reason — see the enumeration note above.
      res.status(404).type("html").send(renderUnavailable());
      return;
    }

    // Recorded before the render so a customer who opens the link and closes it still counts as
    // having seen it. Failure to record must never cost the customer their estimate, so it is
    // awaited but its errors are contained.
    try {
      await recordFirstView(prisma, found.estimate.id);
    } catch (err) {
      console.error("[EstimatePage] first-view record failed:", err);
    }

    // Re-read so the rendered page reflects the view we just recorded.
    const fresh = await getEstimateByToken(prisma, token);
    const estimate = fresh.ok ? fresh.estimate : found.estimate;
    res.type("html").send(renderEstimatePage(estimate, { deposit: await depositState(estimate) }));
  })
);

/**
 * The deposit ask for a signed estimate's page (Kyle, 2026-08-25). Null when
 * unsigned — the page then carries the signing block, not a payment one.
 */
async function depositState(estimate: { id: string; signedAt: Date | null; token: string }) {
  if (!estimate.signedAt) return null;
  const summary = await paymentSummary(prisma, estimate.id, publicBaseUrl());
  if (!summary) return null;
  return {
    due: Math.round((summary.depositDue - summary.depositPaid) * 100) / 100,
    satisfied: summary.depositSatisfied,
    paidInFull: summary.paidInFull,
    payUrl: `${publicBaseUrl()}/pay/${estimate.token}?type=deposit`,
  };
}

estimatePageRouter.post(
  "/:token/sign",
  asyncHandler(async (req, res) => {
    const token = readParam(req, "token");
    const body = (req.body ?? {}) as {
      signerName?: string;
      signatureImage?: string;
      selectedOptions?: string;
    };

    /*
      The tick boxes arrive as one comma-joined field, because this is a plain HTML form post and
      that survives a customer with JavaScript disabled better than repeated checkbox names do.

      An ABSENT field and an EMPTY one mean different things and are kept apart here: absent means
      the page never offered a choice (older document, no script), and the service reads that as
      the whole estimate. Empty means the customer unticked everything, which the service refuses.
    */
    const raw = body.selectedOptions;
    const selectedOptions =
      typeof raw === "string" ? raw.split(",").map((o) => o.trim()).filter(Boolean) : null;

    const result = await signEstimate(prisma, token, {
      signerName: String(body.signerName ?? ""),
      signatureImage: typeof body.signatureImage === "string" ? body.signatureImage : null,
      selectedOptions,
      ip: clientIp(req),
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 500),
    });

    if (!result.ok) {
      // Re-render the estimate carrying the refusal, rather than dropping the customer onto a
      // bare error page they cannot get back from. If the token itself is dead there is nothing
      // to re-render, so the unavailable page is the honest answer.
      const found = await getEstimateByToken(prisma, token);
      if (!found.ok) {
        res.status(404).type("html").send(renderUnavailable());
        return;
      }
      res.status(400).type("html").send(renderEstimatePage(found.estimate, { error: result.reason }));
      return;
    }

    // Kyle's notification is internal and must never be able to fail the customer's signature —
    // the signature is already durably recorded by this point.
    notifyOwnerSigned(prisma, result.estimateId).catch((err) =>
      console.error("[EstimatePage] owner notification failed:", err)
    );
    /*
      THE SOLD JOB EXISTS THE MOMENT THEY SIGN (Kyle, 2026-09-02: "Mabel signed
      and payed the deposit and there is no way to schedule her"). The in-person
      path has created the job since P029; the email-link path never did, so a
      customer signing from home produced a signed estimate with nothing to
      schedule. Same service, same idempotency; a failure is logged, never shown
      to the customer — their signature already stands, and the office button
      remains the manual fallback.
    */
    createJobFromSignedEstimate(prisma, result.estimateId, { actor: "customer:email-sign" })
      .then((job) => {
        if (!job.ok) console.error("[EstimatePage] job creation after email sign refused:", job.reason);
      })
      .catch((err) => console.error("[EstimatePage] job creation after email sign failed:", err));
    // The deposit request (Kyle, 2026-08-25): a customer signing from home has
    // no other way to hear the deposit gate exists. Fire-and-forget.
    sendDepositRequestEmail(prisma, result.estimateId, publicBaseUrl()).catch((err) =>
      console.error("[EstimatePage] deposit request email failed:", err)
    );
    // The customer's signed copy (Kyle, 2026-09-05: "The emails are not going
    // out after the customer signs and pays the deposit on site") — the signed
    // invoice, PDF attached, pay link included, the moment they sign. Existed
    // only behind the manual button before; both sign doors now fire it.
    // Fire-and-forget: their signature already stands, and a missing email
    // address refuses cleanly and is logged.
    sendInvoiceEmail(prisma, result.estimateId, { sentBy: "system:auto-on-sign" })
      .then((r) => { if (!r.ok) console.error("[EstimatePage] auto invoice email refused:", r.reason); })
      .catch((err) => console.error("[EstimatePage] auto invoice email failed:", err));

    const signed = await getEstimateByToken(prisma, token);
    if (!signed.ok) {
      res.status(404).type("html").send(renderUnavailable());
      return;
    }
    // The re-rendered page carries the deposit ask too, so it's on screen the
    // second after they sign — not only in their inbox.
    res.type("html").send(renderEstimatePage(signed.estimate, { deposit: await depositState(signed.estimate) }));
  })
);
