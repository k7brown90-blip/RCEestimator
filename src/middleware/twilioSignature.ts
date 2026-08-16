/**
 * Twilio webhook signature validation — the mailbox now checks the postmark.
 *
 * P017 §2, adopted as follow-up 3 of the P015 review. `/sms/inbound` accepted any POST claiming
 * to be Twilio. It is on the no-credential allowlist, and it is the weakest entry on it: job
 * costing rides on inbound MMS (`decisions/2026-08-11-manual-first-automation-deferral.md`
 * §CLARIFICATION 4), so a forged webhook could inject receipt rows, technician job notes, and
 * customer confirmation actions — writes, not just noise.
 *
 * ── THE ALGORITHM, AND WHY IT IS IMPLEMENTED HERE RATHER THAN INSTALLED ───────────────────────
 *
 * Twilio signs: the full request URL, then every POST parameter appended in lexicographic order
 * of key as `key + value`, HMAC-SHA1 with the account's auth token, base64. `services/twilio.ts`
 * already states the standing choice — "uses fetch directly to avoid requiring the twilio npm
 * package at build time" — and this is thirty lines against a new dependency on the deploy path.
 *
 * It reads the PARSED body rather than a raw one, which is correct for the
 * `application/x-www-form-urlencoded` payloads Twilio's messaging webhooks send and is why no
 * raw-body capture had to be bolted onto the JSON parser.
 *
 * ── URL RECONSTRUCTION IS THE PART THAT BREAKS ───────────────────────────────────────────────
 *
 * The signature covers the URL Twilio *called*, which is the public one. Behind Railway's proxy
 * the app sees http and an internal host, so the proto and host come from the forwarded headers.
 * Getting this wrong fails closed — a legitimate Twilio POST would 403 — so the reconstructed
 * URL is included in the refusal log line. That is the first thing to look at if real texts stop
 * arriving.
 *
 * ── FAIL CLOSED ──────────────────────────────────────────────────────────────────────────────
 *
 * No `TWILIO_AUTH_TOKEN` → 503, not "skip the check". This is the `/mcp` precedent from P012
 * verbatim: an unconfigured endpoint refuses rather than serving unauthenticated, because
 * protection that depends on a variable being set is a configuration fact, not a code fact.
 *
 * This is INBOUND VERIFICATION ONLY. It creates no send path and touches none of P013's gates —
 * the number still listens and never replies.
 */

import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AuthOutcome, RequestAuthState } from "./accessLog";

/** The public URL Twilio signed, reconstructed from the forwarded headers. */
export function requestUrlForSignature(req: Request): string {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol || "https";
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0].trim();
  // `originalUrl` — not `req.url`. The `/api` prefix strip rewrites `req.url`, and Twilio signed
  // whatever it actually called.
  return `${proto}://${host}${req.originalUrl}`;
}

/**
 * Twilio's documented scheme. Exported so the tests sign with the same function the server
 * verifies with — a test that reimplements the algorithm proves the test, not the server.
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, unknown>,
): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    data += key + (value === undefined || value === null ? "" : String(value));
  }
  return crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

function signaturesMatch(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  // Length check first: timingSafeEqual throws on a length mismatch, and the length of a base64
  // SHA-1 is not a secret.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function mark(req: Request, outcome: AuthOutcome): void {
  (req as Request & RequestAuthState)._authOutcome = outcome;
}

/**
 * Reject any request to a Twilio webhook that does not carry a signature this account could
 * have produced. `label` names the route in the refusal log.
 */
export function requireTwilioSignature(label: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!authToken) {
      // eslint-disable-next-line no-console
      console.error(
        `[twilioSignature] REFUSED ${label} — TWILIO_AUTH_TOKEN is not set. The webhook accepts ` +
          `writes (receipts, job notes, confirmation actions) and will not serve unverified ` +
          `traffic. Set the variable to enable it.`,
      );
      mark(req, "bad-signature");
      res.status(503).json({
        error: "Twilio webhook is not configured",
        detail: "TWILIO_AUTH_TOKEN is unset; the endpoint refuses rather than trusting an unverified webhook.",
      });
      return;
    }

    const supplied = req.headers["x-twilio-signature"];
    const url = requestUrlForSignature(req);

    if (typeof supplied !== "string" || supplied.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[twilioSignature] ${label} refused — no X-Twilio-Signature header. url=${url}`);
      mark(req, "bad-signature");
      res.status(403).json({ error: "Missing Twilio signature" });
      return;
    }

    const params = (req.body ?? {}) as Record<string, unknown>;
    const expected = computeTwilioSignature(authToken, url, params);

    if (!signaturesMatch(expected, supplied)) {
      // The reconstructed URL is logged because it is the field that goes wrong; the supplied
      // signature is not, because echoing an attacker's input into a log is how log injection
      // starts. Body values are never logged — they are the customer's message.
      // eslint-disable-next-line no-console
      console.warn(
        `[twilioSignature] ${label} refused — signature did not verify. ` +
          `url=${url} params=${Object.keys(params).length}`,
      );
      mark(req, "bad-signature");
      res.status(403).json({ error: "Invalid Twilio signature" });
      return;
    }

    next();
  };
}
