/**
 * Post to a Twilio webhook the way Twilio does — with a signature the server will accept.
 *
 * P017 gated `/sms/inbound` on `X-Twilio-Signature`. Tests that exist to pin inbound ROUTING
 * (does a tech's text become a job note? does STOP flip consent?) still need to reach the
 * handler, so they sign properly rather than having the check disabled for them. A test that
 * bypassed the gate would stop proving the thing it was written for the day someone re-pointed
 * the route.
 *
 * The signature covers the URL Twilio called, which under supertest would otherwise be
 * `http://127.0.0.1:<ephemeral port>` — unknowable before the request is made. Forcing
 * `X-Forwarded-Proto`/`X-Forwarded-Host` makes it deterministic and exercises the same
 * forwarded-header reconstruction the server does behind Railway's proxy.
 *
 * It signs with the server's own `computeTwilioSignature`. A helper that reimplemented the
 * algorithm would prove the helper agrees with itself.
 */

import request from "supertest";
import type { Express } from "express";
import { computeTwilioSignature } from "../../src/middleware/twilioSignature";

export const WEBHOOK_HOST = "test.local";

/** The auth token these tests sign with. Set it on the environment before calling. */
export function twilioTestToken(): string {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) throw new Error("TWILIO_AUTH_TOKEN must be set for a signed webhook test");
  return token;
}

/** A correctly signed form POST to a Twilio webhook route. */
export function postSignedTwilioWebhook(
  app: Express,
  path: string,
  body: Record<string, string>,
) {
  const url = `https://${WEBHOOK_HOST}${path}`;
  const signature = computeTwilioSignature(twilioTestToken(), url, body);
  return request(app)
    .post(path)
    .set("X-Forwarded-Proto", "https")
    .set("X-Forwarded-Host", WEBHOOK_HOST)
    .set("X-Twilio-Signature", signature)
    .type("form")
    .send(body);
}

/** The same POST with a signature that does not verify — the forgery case. */
export function postForgedTwilioWebhook(
  app: Express,
  path: string,
  body: Record<string, string>,
) {
  return request(app)
    .post(path)
    .set("X-Forwarded-Proto", "https")
    .set("X-Forwarded-Host", WEBHOOK_HOST)
    .set("X-Twilio-Signature", "bm90LWEtcmVhbC1zaWduYXR1cmUtYXQtYWxs")
    .type("form")
    .send(body);
}
