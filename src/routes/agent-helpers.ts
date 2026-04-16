/**
 * Shared helpers for all agent route files (Jerry Mode 1, Savannah, Jerry Mode 2, shared).
 * Extracted from agent.ts to prevent duplication across route files.
 */

import express from "express";
import { ZodError } from "zod";
import { prisma } from "../lib/prisma";

// ─── ASYNC HANDLER ──────────────────────────────────────────────────────────────

export const asyncHandler = (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─── EXPRESS 5 PARAM READER ─────────────────────────────────────────────────────

export const readParam = (req: express.Request, key: string): string => {
  const raw = req.params[key];
  return Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
};

// ─── STRING HELPERS ─────────────────────────────────────────────────────────────

export function truncate(s: unknown, max: number): string {
  const text = typeof s === "string" ? s : String(s ?? "");
  return text.length <= max ? text : text.slice(0, max) + "…";
}

// ─── PHONE NORMALIZATION ────────────────────────────────────────────────────────

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

// ─── AUDIT LOG ──────────────────────────────────────────────────────────────────

export function logAgent(action: string, details: {
  agent?: string;
  visitId?: string;
  entityType?: string;
  entityId?: string;
  payload?: unknown;
  endpoint?: string;
  responseStatus?: number;
  durationMs?: number;
  clientRequestId?: string;
}): void {
  prisma.agentAuditLog.create({
    data: {
      action,
      agent: details.agent,
      visitId: details.visitId,
      entityType: details.entityType,
      entityId: details.entityId,
      payloadJson: details.payload ? JSON.stringify(details.payload) : null,
      endpoint: details.endpoint,
      responseStatus: details.responseStatus,
      durationMs: details.durationMs,
      clientRequestId: details.clientRequestId,
    },
  }).catch((err) => console.error("[AgentAudit] log failed:", err));
}

// ─── IDEMPOTENCY ────────────────────────────────────────────────────────────────

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function checkIdempotency(
  clientRequestId: string | undefined,
  endpoint: string,
): Promise<object | null> {
  if (!clientRequestId) return null;

  // Fire-and-forget cleanup of expired records
  prisma.agentIdempotency.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  }).catch(() => {});

  const existing = await prisma.agentIdempotency.findUnique({
    where: { clientRequestId_endpoint: { clientRequestId, endpoint } },
  });

  if (!existing) return null;

  if (new Date() > existing.expiresAt) {
    await prisma.agentIdempotency.delete({ where: { id: existing.id } }).catch(() => {});
    return null;
  }

  return JSON.parse(existing.responseJson);
}

export async function saveIdempotency(
  clientRequestId: string | undefined,
  endpoint: string,
  visitId: string | undefined,
  responseBody: object,
  agent?: string,
): Promise<void> {
  if (!clientRequestId) return;
  await prisma.agentIdempotency.create({
    data: {
      clientRequestId,
      endpoint,
      agent,
      visitId,
      responseJson: JSON.stringify(responseBody),
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    },
  }).catch(() => {}); // ignore duplicate key errors on race
}

// ─── ZOD ERROR HELPER ───────────────────────────────────────────────────────────

export function agentZodError(err: ZodError): { code: string; message: string; spoken_fallback: string } {
  const issue = err.issues[0];
  let spoken_fallback: string;
  let message: string;
  const path = issue.path.join(".");

  switch (issue.code) {
    case "invalid_value": {
      const vals = "values" in issue ? (issue.values as string[]).join(", ") : "";
      message = `${path || "value"} must be one of: ${vals}`;
      spoken_fallback = `That wasn't one of the options — pick from ${vals}.`;
      break;
    }
    case "too_small":
      message = `${path || "value"} is required`;
      spoken_fallback = "I didn't catch that — could you say it again?";
      break;
    case "invalid_type": {
      const expected = "expected" in issue ? String(issue.expected) : "valid input";
      message = `${path || "value"} must be a ${expected}`;
      spoken_fallback = `I need a ${expected} there.`;
      break;
    }
    default:
      message = issue.message;
      spoken_fallback = "Something wasn't right with that input. Try again?";
  }

  return { code: "VALIDATION_FAILED", message, spoken_fallback };
}

// ─── STANDARD RESPONSE BUILDERS ─────────────────────────────────────────────────

export function successResponse(data: unknown, spokenConfirmation: string) {
  return {
    success: true,
    data,
    spoken_confirmation: spokenConfirmation,
    error: null,
  };
}

export function errorResponse(code: string, message: string, spokenFallback: string) {
  return {
    success: false,
    data: null,
    spoken_confirmation: spokenFallback,
    error: { code, message },
  };
}

// ─── AUTH MIDDLEWARE ─────────────────────────────────────────────────────────────

export const agentAuth: express.RequestHandler = (req, res, next) => {
  const AGENT_API_TOKEN = process.env.AGENT_API_TOKEN;
  if (!AGENT_API_TOKEN) {
    res.status(503).json({ error: "Agent API not configured" });
    return;
  }
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${AGENT_API_TOKEN}`) {
    res.status(401).json({ error: "Invalid or missing agent token" });
    return;
  }
  next();
};

// ─── ZOD ERROR MIDDLEWARE ───────────────────────────────────────────────────────

export function zodErrorMiddleware(err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (err instanceof ZodError) {
    const e = agentZodError(err);
    res.status(422).json(errorResponse(e.code, e.message, e.spoken_fallback));
    return;
  }
  next(err);
}
