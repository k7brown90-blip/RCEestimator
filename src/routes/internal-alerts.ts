/**
 * Internal endpoints that end silent-failure. Deliberately not behind the PIN
 * auth (see middleware/pinAuth exemption): Railway must be able to healthcheck
 * without a session, and Railway/Twilio webhooks cannot send an Authorization
 * header. Auth for the two POST endpoints is a URL-path token compared in
 * constant time. That is the same pattern the brain flags in
 * `decisions/2026-08-04-secrets-and-security-posture.md` as pre-gate acceptable
 * but flip-to-signature at the customer-data gate.
 */

import express from "express";
import crypto from "node:crypto";
import { prisma } from "../lib/prisma";
import { sendAlert } from "../services/alerting";
import { logSystemEvent } from "../services/systemEvents";
import { requireTwilioSignature } from "../middleware/twilioSignature";

export const internalRouter = express.Router();

const HEALTH_TIMEOUT_MS = 2000;

async function pingDb(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const result = await Promise.race([
      prisma.$queryRaw`SELECT 1`.then(() => ({ ok: true as const })),
      new Promise<{ ok: false; reason: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, reason: `db-timeout-${HEALTH_TIMEOUT_MS}ms` }), HEALTH_TIMEOUT_MS),
      ),
    ]);
    return result;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : "db-error" };
  }
}

/** Mounted at `/healthz` (root, not under the router) so Railway's healthcheckPath hits it. */
export async function healthzHandler(_req: express.Request, res: express.Response): Promise<void> {
  const db = await pingDb();
  if (!db.ok) {
    void sendAlert({
      severity: "critical",
      eventType: "healthz-db-unreachable",
      service: process.env.RAILWAY_SERVICE_NAME ?? "RCEestimator",
      reason: db.reason,
      dedupeKey: "healthz-db-unreachable",
    });
    res.status(503).json({ ok: false, db: false, reason: db.reason });
    return;
  }
  res.status(200).json({ ok: true, db: true, at: new Date().toISOString() });
}

function tokenMatches(supplied: string | undefined, expected: string | undefined): boolean {
  if (!supplied || !expected || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

// ─── POST /internal/webhooks/railway/:token ──────────────────────────────────
// Railway project webhook. Fires on deploy events; we alert on failures and
// crashes only — success would be pure noise.
internalRouter.post("/webhooks/railway/:token", express.json({ limit: "64kb" }), async (req, res) => {
  if (!tokenMatches(req.params.token, process.env.INTERNAL_WEBHOOK_TOKEN)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const body = req.body as { type?: string; deployment?: { id?: string; meta?: unknown }; project?: { name?: string } };
  const type = body?.type ?? "unknown";
  const dedupeKey = `railway:${type}:${body?.deployment?.id ?? "unknown"}`;

  // Railway event names vary by API version; match the ones that indicate a bad state.
  const isFailure = /fail|crash|error/i.test(type);
  if (!isFailure) {
    logSystemEvent("info", "alerting", `railway webhook ignored (${type})`, { dedupeKey });
    res.status(204).end();
    return;
  }

  const result = await sendAlert({
    severity: "critical",
    eventType: `railway.${type}`,
    service: body?.project?.name ?? process.env.RAILWAY_SERVICE_NAME ?? "RCEestimator",
    reason: `deployment ${body?.deployment?.id ?? "?"}`,
    dedupeKey,
  });
  res.status(200).json({ alerted: result.delivered, deduplicated: result.deduplicated ?? false, sid: result.sid });
});

// ─── POST /internal/webhooks/twilio-status/:token ────────────────────────────
// Twilio delivery-status callback. Persists the terminal status so a report
// can cite `delivered` rather than `queued`.
//
// SIGNATURE-GATED as of P017 (§2: "any other Twilio webhook route that exists"). It already had
// the URL-path token; the signature is the second factor and the one Twilio actually vouches
// for. Currently DORMANT in practice — statusCallback is only attached by the operator-alert
// send, which P013 gated off — so this is hardening ahead of the day those gates reopen, not a
// live path. Signature first, then the path token: a caller who cannot produce the signature
// never reaches the comparison, and the two refusals stay distinguishable (403 vs 401).
internalRouter.post(
  "/webhooks/twilio-status/:token",
  express.urlencoded({ extended: false, limit: "16kb" }),
  requireTwilioSignature("POST /internal/webhooks/twilio-status"),
  (req, res) => {
    // Express widens a path param to `string | string[]` once a route carries extra middleware;
    // take the first value rather than let a repeated segment reach a constant-time compare.
    const supplied = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
    if (!tokenMatches(supplied, process.env.INTERNAL_WEBHOOK_TOKEN)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const { MessageSid, MessageStatus, ErrorCode, ErrorMessage } = req.body as Record<string, string>;
    if (!MessageSid || !MessageStatus) {
      res.status(400).json({ error: "missing sid or status" });
      return;
    }
    const level = MessageStatus === "delivered" ? "info" : MessageStatus === "failed" || MessageStatus === "undelivered" ? "error" : "info";
    logSystemEvent(level, "alerting", `sms status ${MessageStatus}`, {
      sid: MessageSid,
      status: MessageStatus,
      errorCode: ErrorCode ?? undefined,
      errorMessage: ErrorMessage ?? undefined,
    });
    res.status(204).end();
  },
);
