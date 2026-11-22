/**
 * The ONE append-only agent audit (work order agent-team, K-U3), on AgentAuditLog (extended; the old
 * Savannah and Jerry rows stay as history). ONE row per agent call, written BEFORE the response is
 * sent: if the insert fails, the call fails with 500 `internal` and returns no data. A call that
 * returns data nobody recorded is the thing this exists to prevent.
 *
 * What a row holds, and what it never holds:
 *   * action = the tool name (or the REST route's action), endpoint = the route, agent = the key's
 *     role, door = "mcp" | "rest", scopeUsed = the scope that authorised it, recordIds = ids only,
 *     resultCode = "ok" | "replayed" | the error code, responseStatus, durationMs, agentKeyId.
 *   * clientRequestId = the idempotency key as a sha256 (never the key itself).
 *   * NEVER a request or response body, a message, a name, a token or a key. `payloadJson` is never
 *     written. This function has no parameter that could carry one.
 *   * Unknown-key refusals (a 401 for a key that is not in the table) are written with agentKeyId
 *     null and nothing from the credential.
 *
 * Append-only is enforced by the database: the migration's trigger raises on UPDATE and DELETE of
 * AgentAuditLog. Nothing in the app updates or deletes these rows, and nothing may.
 *
 * Daily drafts: a row that made a draft carries entityType "draft" and resultCode "ok". A replay
 * ("replayed") made nothing, so it does not count. The cap (500 per key per Chicago day) is read
 * from these rows by countDraftsToday.
 */
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { zonedParts, zonedWallToInstant } from "../../shared/businessDays";
import { CALENDAR_DAY_TIME_ZONE } from "../../shared/calendarDay";

export const AGENT_DRAFT_ENTITY_TYPE = "draft";
export const AGENT_DAILY_DRAFT_LIMIT = 500;

export type AgentDoor = "mcp" | "rest";

export interface AgentCallRecord {
  /** The key's id, or null when the key is unknown (a refused credential). */
  agentKeyId: string | null;
  /** The key's role (admin, inventory, ...), or null for an unknown key. */
  agentRole: string | null;
  /** The tool name, or the route's action for REST. */
  tool: string;
  /** The route (method and path) for REST, "/mcp" for MCP. */
  route: string;
  door: AgentDoor;
  scopeUsed: string | null;
  /** Ids only. Never names, text or contact details. */
  recordIds?: readonly string[] | null;
  /** "ok", "replayed" or an error code. */
  resultCode: string;
  status: number;
  durationMs: number;
  /** The raw idempotency key; stored only as its sha256. */
  idempotencyKey?: string | null;
  /** True when this call made a draft (counts toward the daily cap unless it was a replay). */
  madeDraft?: boolean;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** An id-shaped string only: cuids, uuids, numbers like E-1042. Anything else is dropped from recordIds. */
const ID_LIKE = /^[A-Za-z0-9_.:-]{1,64}$/;

function cleanRecordIds(ids: readonly string[] | null | undefined): string[] | null {
  if (!ids || ids.length === 0) return null;
  return ids.filter((id) => typeof id === "string" && ID_LIKE.test(id)).slice(0, 200);
}

/**
 * Write the one audit row for a call. Returns its id. THROWS if the insert fails; the caller turns
 * that into a 500 and sends nothing else.
 *
 * A WRITE passes its own transaction client as `db`, from inside the withIdempotency callback and
 * after the effect, so the audit row commits or rolls back WITH the write: a draft can never exist
 * unaudited and uncounted. Reads and refusals use the default client.
 */
export async function recordAgentCall(
  call: AgentCallRecord, db: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<string> {
  const countsAsDraft = call.madeDraft === true && call.resultCode === "ok";
  const row = await db.agentAuditLog.create({
    data: {
      action: call.tool,
      agent: call.agentRole,
      endpoint: call.route,
      entityType: countsAsDraft ? AGENT_DRAFT_ENTITY_TYPE : null,
      responseStatus: call.status,
      durationMs: Math.max(0, Math.round(call.durationMs)),
      clientRequestId: call.idempotencyKey ? sha256Hex(call.idempotencyKey) : null,
      agentKeyId: call.agentKeyId,
      door: call.door,
      scopeUsed: call.scopeUsed,
      recordIds: cleanRecordIds(call.recordIds) ?? undefined,
      resultCode: call.resultCode,
    },
    select: { id: true },
  });
  return row.id;
}

/** The instant the Chicago calendar day containing `now` began. DST-safe (zonedWallToInstant). */
export function chicagoDayStart(now: Date = new Date()): Date {
  const p = zonedParts(now, CALENDAR_DAY_TIME_ZONE);
  return zonedWallToInstant(p.year, p.month, p.day, 0, 0, CALENDAR_DAY_TIME_ZONE);
}

/** Drafts this key has made since Chicago midnight, from the audit. Replays and refusals are not counted. */
export async function countDraftsToday(
  agentKeyId: string, now: Date = new Date(), db: PrismaClient = defaultPrisma,
): Promise<number> {
  return db.agentAuditLog.count({
    where: {
      agentKeyId,
      createdAt: { gte: chicagoDayStart(now) },
      entityType: AGENT_DRAFT_ENTITY_TYPE,
      resultCode: "ok",
    },
  });
}
