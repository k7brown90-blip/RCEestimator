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
import { notifyOwnerSigned } from "../services/issuedEstimateSend";

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
    res.type("html").send(renderEstimatePage(estimate));
  })
);

estimatePageRouter.post(
  "/:token/sign",
  asyncHandler(async (req, res) => {
    const token = readParam(req, "token");
    const body = (req.body ?? {}) as { signerName?: string; signatureImage?: string };

    const result = await signEstimate(prisma, token, {
      signerName: String(body.signerName ?? ""),
      signatureImage: typeof body.signatureImage === "string" ? body.signatureImage : null,
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

    const signed = await getEstimateByToken(prisma, token);
    if (!signed.ok) {
      res.status(404).type("html").send(renderUnavailable());
      return;
    }
    res.type("html").send(renderEstimatePage(signed.estimate));
  })
);
