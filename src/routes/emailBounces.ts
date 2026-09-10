/**
 * Email bounces — the CRM's view of Gmail's delivery failures (Kyle, 2026-09-09:
 * "My emails are not getting to the clients" / "very few are actually getting
 * through, this is priority number one").
 *
 * The rows come from services/bounceWatcher.ts, which polls the mailbox every ten
 * minutes. This router lists them for the Financials card, lets Kyle resolve one
 * with a note (which also clears the estimate's bounce flag), and exposes the poll
 * as a "Check now" button.
 *
 * Mounted behind the operator session like financialsRouter.
 */

import express from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { asyncHandler, readParam } from "./agent-helpers";
import { pollBounces } from "../services/bounceWatcher";
import { logSystemEvent } from "../services/systemEvents";

export const emailBouncesRouter = express.Router();

const BOUNCE_INCLUDE = {
  issuedEstimate: {
    select: {
      id: true, number: true, revision: true, title: true, customerId: true,
      account: { select: { id: true, name: true } },
    },
  },
  visit: {
    select: {
      id: true, purpose: true, jobType: true, scheduledStart: true, customerId: true,
      customer: { select: { id: true, name: true } },
    },
  },
} as const;

type BounceRow = Prisma.EmailBounceGetPayload<{ include: typeof BOUNCE_INCLUDE }>;

/** The account the bounce belongs to — through the estimate first, the visit second. */
function serialize(row: BounceRow) {
  const account = row.issuedEstimate?.account ?? row.visit?.customer ?? null;
  return {
    id: row.id,
    recipient: row.recipient,
    status: row.status,
    diagnostic: row.diagnostic,
    action: row.action,
    remoteMta: row.remoteMta,
    originalSubject: row.originalSubject,
    kind: row.kind,
    estimateNumber: row.estimateNumber,
    issuedEstimateId: row.issuedEstimateId,
    visitId: row.visitId,
    bouncedAt: row.bouncedAt,
    resolvedAt: row.resolvedAt,
    resolvedNote: row.resolvedNote,
    account,
    estimate: row.issuedEstimate
      ? { id: row.issuedEstimate.id, number: row.issuedEstimate.number, revision: row.issuedEstimate.revision, title: row.issuedEstimate.title }
      : null,
    visit: row.visit
      ? { id: row.visit.id, purpose: row.visit.purpose, jobType: row.visit.jobType, scheduledStart: row.visit.scheduledStart }
      : null,
  };
}

/** GET /email-bounces?unresolved=1 — newest first, capped at 100. */
emailBouncesRouter.get("/email-bounces", asyncHandler(async (req, res) => {
  const unresolvedOnly = String(req.query.unresolved ?? "") === "1" || String(req.query.unresolved ?? "") === "true";
  const rows = await prisma.emailBounce.findMany({
    where: unresolvedOnly ? { resolvedAt: null } : {},
    orderBy: { bouncedAt: "desc" },
    take: 100,
    include: BOUNCE_INCLUDE,
  });
  res.json(rows.map(serialize));
}));

/**
 * POST /email-bounces/:id/resolve {note} — Kyle has dealt with it (called the customer,
 * fixed the address, re-sent). Clears the estimate's flag when the bounce named one.
 */
emailBouncesRouter.post("/email-bounces/:id/resolve", asyncHandler(async (req, res) => {
  const id = readParam(req, "id");
  const body = z.object({ note: z.string().trim().max(500).nullable().optional() }).parse(req.body ?? {});

  const existing = await prisma.emailBounce.findUnique({ where: { id }, select: { id: true, issuedEstimateId: true, recipient: true, estimateNumber: true } });
  if (!existing) {
    res.status(404).json({ error: "Bounce not found" });
    return;
  }

  const [row] = await prisma.$transaction([
    prisma.emailBounce.update({
      where: { id },
      data: { resolvedAt: new Date(), resolvedNote: body.note ?? null },
      include: BOUNCE_INCLUDE,
    }),
    ...(existing.issuedEstimateId
      ? [prisma.issuedEstimate.update({
          where: { id: existing.issuedEstimateId },
          data: { lastBounceAt: null, lastBounceReason: null },
        })]
      : []),
  ]);

  logSystemEvent("info", "email", `Bounce resolved for ${existing.recipient}${existing.estimateNumber ? ` (estimate ${existing.estimateNumber})` : ""}`, {
    bounceId: id,
    note: body.note ?? null,
  });
  res.json(serialize(row));
}));

/** POST /email-bounces/poll — the "Check now" button. Returns the watcher's counts, never throws. */
emailBouncesRouter.post("/email-bounces/poll", asyncHandler(async (_req, res) => {
  const result = await pollBounces({ sinceDays: 7 });
  res.json(result);
}));
