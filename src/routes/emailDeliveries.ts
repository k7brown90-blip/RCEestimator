/**
 * Email deliveries — the CRM's read side of transactional email (Kyle, 2026-09-09:
 * "I need the emails working, very few are actually getting through, this is
 * priority number one").
 *
 * The rows come from services/transactionalEmail.ts (one per customer send) and
 * their status from services/resendWebhook.ts. This router lists them for an
 * estimate or a visit, and reports the transport's health for the status strip
 * on the Financials bounced-emails card.
 *
 * Mounted behind the operator session like emailBouncesRouter.
 */

import express from "express";
import { prisma } from "../lib/prisma";
import { asyncHandler } from "./agent-helpers";
import {
  bccSelfEnabled, transactionalFrom, transactionalProvider, transactionalReplyTo,
} from "../services/transactionalEmail";
import { lastResendWebhookEventAt } from "../services/resendWebhook";
import { gmailTransportConfigured } from "../services/gmailTransport";

export const emailDeliveriesRouter = express.Router();

const STATUSES = ["sent", "delivered", "delayed", "bounced", "complained", "failed"] as const;

/** GET /email-deliveries?estimateId=&visitId=&limit= — newest first, capped at 200. */
emailDeliveriesRouter.get("/email-deliveries", asyncHandler(async (req, res) => {
  const estimateId = typeof req.query.estimateId === "string" ? req.query.estimateId.trim() : "";
  const visitId = typeof req.query.visitId === "string" ? req.query.visitId.trim() : "";
  const limitRaw = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 50;

  const rows = await prisma.emailDelivery.findMany({
    where: {
      ...(estimateId ? { issuedEstimateId: estimateId } : {}),
      ...(visitId ? { visitId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      issuedEstimate: { select: { id: true, number: true, revision: true, title: true } },
    },
  });
  res.json(rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    providerMessageId: r.providerMessageId,
    to: r.to,
    subject: r.subject,
    kind: r.kind,
    estimateNumber: r.estimateNumber,
    issuedEstimateId: r.issuedEstimateId,
    visitId: r.visitId,
    status: r.status,
    statusAt: r.statusAt,
    error: r.error,
    createdAt: r.createdAt,
    estimate: r.issuedEstimate,
  })));
}));

/**
 * GET /email-status — which pipe customer email leaves through, whether the delivery webhook
 * can be verified, the last 24 hours by status, and when the last Resend event arrived.
 */
emailDeliveriesRouter.get("/email-status", asyncHandler(async (_req, res) => {
  const since = new Date(Date.now() - 24 * 3600_000);
  const grouped = await prisma.emailDelivery.groupBy({
    by: ["status"],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
  });
  const last24h: Record<(typeof STATUSES)[number] | "total", number> = {
    sent: 0, delivered: 0, delayed: 0, bounced: 0, complained: 0, failed: 0, total: 0,
  };
  for (const g of grouped) {
    const key = g.status as (typeof STATUSES)[number];
    if (key in last24h) last24h[key] = g._count._all;
    last24h.total += g._count._all;
  }

  // The last event this process saw, or — after a restart — the newest status the webhook wrote.
  const inProcess = lastResendWebhookEventAt();
  const fromTable = await prisma.emailDelivery.findFirst({
    where: { provider: "resend", status: { in: ["delivered", "delayed", "bounced", "complained"] }, statusAt: { not: null } },
    orderBy: { statusAt: "desc" },
    select: { statusAt: true },
  });
  const lastWebhookEventAt = [inProcess, fromTable?.statusAt ?? null]
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  res.json({
    provider: transactionalProvider(),
    from: transactionalFrom(),
    replyTo: transactionalReplyTo(),
    bccSelf: bccSelfEnabled(),
    resendConfigured: Boolean(process.env.RESEND_API_KEY),
    gmailConfigured: gmailTransportConfigured(),
    webhookSecretSet: Boolean(process.env.RESEND_WEBHOOK_SECRET),
    lastWebhookEventAt,
    last24h,
  });
}));
