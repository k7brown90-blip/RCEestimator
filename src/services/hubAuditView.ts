/**
 * The Message audit log (work order agent-team, U4; Kyle only): a read-only view of HubAuditLog, newest
 * first, filtered by conversation, by who acted, or to the "Blocked texts" (action send_blocked: when,
 * reason, class, send type and record - never a phone number, not even its last four digits, and never
 * the words of a message). The log itself is append-only (hubAudit in services/hub.ts is its only writer
 * and the database refuses UPDATE and DELETE); nothing here writes.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { messageCategoryFor } from "../../shared/hub/messageCategories";
import { hubAuditActionLabel } from "../../shared/hub/auditLabels";
import { sendBlockText } from "../../shared/hub/sendBlocks";
import type { AuditEntryView, AuditResponse } from "../../shared/hub/views";

export const AUDIT_PAGE_SIZE = 100;

export interface AuditFilter {
  threadId?: string;
  /** The actor key (HubAuditLog.actorKey). */
  actor?: string;
  /** "send_blocked" is the Blocked texts filter. Any other value is read as an action name. */
  action?: string;
  /** ISO time: only entries older than this (the next page). */
  before?: string;
}

function detailsOf(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export async function listAudit(filter: AuditFilter, db: PrismaClient = defaultPrisma): Promise<AuditResponse> {
  const before = filter.before ? new Date(filter.before) : null;
  const rows = await db.hubAuditLog.findMany({
    where: {
      ...(filter.threadId ? { threadId: filter.threadId } : {}),
      ...(filter.actor ? { actorKey: filter.actor } : {}),
      ...(filter.action ? { action: filter.action } : {}),
      ...(before && !Number.isNaN(before.getTime()) ? { at: { lt: before } } : {}),
    },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: AUDIT_PAGE_SIZE + 1,
  });
  const more = rows.length > AUDIT_PAGE_SIZE;
  if (more) rows.length = AUDIT_PAGE_SIZE;

  const threadIds = [...new Set(rows.flatMap((r) => (r.threadId ? [r.threadId] : [])))];
  const threads = threadIds.length > 0 ? await db.hubThread.findMany({ where: { id: { in: threadIds } }, select: { id: true, title: true } }) : [];
  const titleOf = new Map(threads.map((t) => [t.id, t.title]));

  const entries: AuditEntryView[] = rows.map((r) => {
    const d = detailsOf(r.detailsJson);
    const reasonCode = text(d.reason);
    const category = text(d.category);
    const blocked = r.action === "send_blocked";
    const label = hubAuditActionLabel(r.action);
    const sendType = category ? messageCategoryFor(category)?.label ?? category : null;
    const title = r.threadId ? titleOf.get(r.threadId) ?? null : null;
    return {
      id: r.id,
      at: r.at.toISOString(),
      actorKey: r.actorKey,
      actorDisplay: r.actorDisplay,
      action: r.action,
      actionLabel: label,
      threadId: r.threadId,
      threadTitle: title,
      messageId: r.messageId,
      reason: blocked ? sendBlockText(reasonCode) || null : null,
      messageClass: text(d.messageClass),
      category,
      summary: blocked
        ? `${text(d.messageClass) ?? "Unclassified"} ${text(d.channel) === "sms" ? "text" : "message"}${sendType ? ` (${sendType})` : ""} was not sent${title ? ` — ${title}` : ""}`
        : `${label}${title ? ` — ${title}` : ""}`,
    };
  });

  // Who has acted, for the "who" filter: the distinct actors of the newest entries.
  const recentActors = await db.hubAuditLog.findMany({
    orderBy: { at: "desc" }, take: 500, select: { actorKey: true, actorDisplay: true },
  });
  const seen = new Map<string, string>();
  for (const a of recentActors) if (!seen.has(a.actorKey)) seen.set(a.actorKey, a.actorDisplay);

  return { entries, actors: [...seen].map(([key, display]) => ({ key, display })), more };
}
