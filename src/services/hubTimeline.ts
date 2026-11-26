/**
 * ONE conversation per record (work order agent-team, U2; default D3). The timeline the Account page,
 * the Lead drawer, the Job drawer and the Property page show: everything said to or about this
 * customer, newest first, from the four places it is kept:
 *
 *   * the call notes (CustomerNote) - the notes routes in app.ts stay the ONLY writer of them;
 *   * the emails sent from any door (EmailDelivery) - the lead-era ones, the job ones, the account ones;
 *   * the hub's own messages on the customer's thread (drafts waiting, texts, anything posted);
 *   * one line for a website chat (the transcript itself stays in the Lead drawer's Website chat).
 *
 * An email that a hub message already stands for (HubMessage.emailDeliveryId) is shown ONCE, as the
 * message, so nothing lists twice. Read-only: this builds a view and writes nothing.
 *
 * Who asks decides what they may see: the customer thread is read through findVisibleThread like any
 * other hub read.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { parseJsonArrayLength } from "../lib/json";
import { HubError, findVisibleThread, maskedRecipient, unreadCounts, type HubReader } from "./hub";
import type {
  TimelineEmail, TimelineEntry, TimelineMessage, TimelineNote, TimelineResponse,
} from "../../shared/hub/views";
import { wasSentDirectly } from "../../shared/hub/views";

export type TimelineTarget =
  | { customerId: string }
  | { leadId: string }
  | { visitId: string }
  | { propertyId: string };

/** The most rows read from any one source. A real account has a handful; this is a guard, not a page size. */
export const TIMELINE_SOURCE_CAP = 300;

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function jobLabelOf(v: { jobType: string | null; purpose: string | null; property: { addressLine1: string } | null } | undefined): string | null {
  if (!v) return null;
  const what = v.jobType || v.purpose || "Job";
  return v.property?.addressLine1 ? `${what} — ${v.property.addressLine1}` : what;
}

const NOTE_INCLUDE = {
  visit: {
    select: {
      id: true, jobType: true, purpose: true, visitDate: true,
      property: { select: { addressLine1: true } },
    },
  },
} as const;

export type DeliveryRow = {
  id: string; provider: string; to: string; cc: string[]; subject: string; kind: string; estimateNumber: string | null;
  status: string; statusAt: Date | null; error: string | null; createdAt: Date; visitId: string | null;
};

/** One EmailDelivery row as the screens show it (the approval card shares it, so a sent draft reads like any email). */
export const emailOf = (d: DeliveryRow): TimelineEmail => ({
  id: d.id,
  provider: d.provider === "gmail" ? "gmail" : "resend",
  status: d.status as TimelineEmail["status"],
  statusAt: iso(d.statusAt),
  to: d.to,
  cc: d.cc,
  subject: d.subject,
  kind: d.kind,
  estimateNumber: d.estimateNumber,
  error: d.error,
  createdAt: d.createdAt.toISOString(),
});

export async function buildTimeline(
  reader: HubReader, target: TimelineTarget, db: PrismaClient = defaultPrisma,
): Promise<TimelineResponse> {
  // ── 1. which record, and which account it belongs to ──────────────────────────────────────────
  let customerId: string | null = null;
  let leadOnlyId: string | null = null;
  let visitId: string | null = null;
  let propertyId: string | null = null;
  let name: string | null = null;

  if ("customerId" in target) {
    const c = await db.customer.findUnique({ where: { id: target.customerId }, select: { id: true, name: true } });
    if (!c) throw new HubError("Account not found", 404);
    customerId = c.id;
    name = c.name;
  } else if ("leadId" in target) {
    const lead = await db.lead.findUnique({ where: { id: target.leadId }, select: { id: true, name: true, customerId: true } });
    if (!lead) throw new HubError("Lead not found", 404);
    if (lead.customerId) {
      // A lead that became an account carries the account's whole conversation (its own emails are on it).
      customerId = lead.customerId;
      const c = await db.customer.findUnique({ where: { id: lead.customerId }, select: { name: true } });
      name = c?.name ?? lead.name;
    } else {
      leadOnlyId = lead.id;
      name = lead.name;
    }
  } else if ("visitId" in target) {
    const v = await db.visit.findUnique({ where: { id: target.visitId }, select: { id: true, customerId: true, customer: { select: { name: true } } } });
    if (!v) throw new HubError("Job not found", 404);
    customerId = v.customerId;
    visitId = v.id;
    name = v.customer.name;
  } else {
    const p = await db.property.findUnique({ where: { id: target.propertyId }, select: { id: true, customerId: true, customer: { select: { name: true } } } });
    if (!p) throw new HubError("Address not found", 404);
    customerId = p.customerId;
    propertyId = p.id;
    name = p.customer.name;
  }

  const entries: TimelineEntry[] = [];
  let truncated = false;
  const cap = TIMELINE_SOURCE_CAP;

  // The jobs in scope: all of the account's, or just this address's on the Property page.
  const visits = customerId
    ? await db.visit.findMany({
        where: propertyId ? { propertyId } : { customerId },
        select: { id: true, jobType: true, purpose: true, property: { select: { addressLine1: true } } },
      })
    : [];
  const visitById = new Map(visits.map((v) => [v.id, v]));
  const visitIds = visits.map((v) => v.id);
  const labelFor = (id: string | null): string | null => (id ? jobLabelOf(visitById.get(id)) : null);

  // The leads that fed this account (their emails and website chat are part of its conversation).
  const leadIds = propertyId
    ? []
    : leadOnlyId
      ? [leadOnlyId]
      : (await db.lead.findMany({ where: { customerId: customerId as string }, select: { id: true } })).map((l) => l.id);

  // ── 2. call notes ─────────────────────────────────────────────────────────────────────────────
  if (customerId) {
    const notes = await db.customerNote.findMany({
      where: propertyId ? { customerId, visitId: { in: visitIds } } : { customerId },
      orderBy: { createdAt: "desc" },
      take: cap + 1,
      include: NOTE_INCLUDE,
    });
    if (notes.length > cap) { truncated = true; notes.length = cap; }
    for (const n of notes) {
      const note: TimelineNote = {
        id: n.id, customerId: n.customerId, visitId: n.visitId, body: n.body, takenBy: n.takenBy,
        createdAt: n.createdAt.toISOString(), updatedAt: n.updatedAt.toISOString(),
        visit: n.visit ? { ...n.visit, visitDate: n.visit.visitDate.toISOString() } : null,
      };
      entries.push({ type: "note", id: `note:${n.id}`, at: note.createdAt, visitId: n.visitId, jobLabel: jobLabelOf(n.visit ?? undefined), note });
    }
  }

  // ── 3. the hub's messages on the customer thread ──────────────────────────────────────────────
  const thread = await db.hubThread.findFirst({
    where: customerId ? { kind: "customer", customerId } : { kind: "customer", leadId: leadOnlyId as string },
  });
  const visibleThread = thread ? await findVisibleThread(reader, thread.id, db) : null;
  const messageIds = new Set<string>();
  if (visibleThread) {
    const rows = await db.hubMessage.findMany({
      where: { threadId: visibleThread.id, ...(propertyId ? { visitId: { in: visitIds } } : {}) },
      orderBy: { createdAt: "desc" },
      take: cap + 1,
      include: { emailDelivery: true },
    });
    if (rows.length > cap) { truncated = true; rows.length = cap; }
    const deletedIds = rows.filter((m) => m.deletedAt).map((m) => m.id);
    const whoDeleted = new Map<string, string>();
    if (deletedIds.length > 0) {
      const audits = await db.hubAuditLog.findMany({ where: { action: "message_deleted", messageId: { in: deletedIds } }, select: { messageId: true, actorDisplay: true } });
      for (const a of audits) if (a.messageId) whoDeleted.set(a.messageId, a.actorDisplay);
    }
    for (const m of rows) {
      messageIds.add(m.id);
      const deleted = m.deletedAt !== null;
      const message: TimelineMessage = {
        id: m.id, threadId: m.threadId, authorType: m.authorType, authorDisplay: m.authorDisplay, channel: m.channel,
        direction: m.direction, status: m.status as TimelineMessage["status"], subject: m.subject,
        body: deleted ? null : m.body, toAddress: m.toAddress,
        toMasked: m.channel === "sms" ? maskedRecipient(m.toPhone10) : null, messageClass: m.messageClass ?? null, error: m.error, deleted,
        deletedBy: deleted ? whoDeleted.get(m.id) ?? m.deletedBy : null, deletedReason: deleted ? m.deletedReason : null,
        editedAt: iso(m.editedAt), createdAt: m.createdAt.toISOString(), sentAt: iso(m.sentAt),
        emailDelivery: m.emailDelivery ? emailOf({ ...m.emailDelivery, visitId: m.emailDelivery.visitId }) : null,
        sentDirectly: wasSentDirectly(m),
      };
      entries.push({ type: "message", id: `message:${m.id}`, at: message.createdAt, visitId: m.visitId, jobLabel: labelFor(m.visitId), message });
    }
  }

  // ── 4. emails from every door ─────────────────────────────────────────────────────────────────
  const deliveryOr: Prisma.EmailDeliveryWhereInput[] = propertyId
    ? [{ visitId: { in: visitIds } }, { issuedEstimate: { serviceAddressId: propertyId } }]
    : customerId
      // An estimate or invoice email may carry only the estimate it was about, so its account counts too.
      ? [{ customerId }, { visitId: { in: visitIds } }, { leadId: { in: leadIds } }, { issuedEstimate: { customerId } }]
      : [{ leadId: leadOnlyId as string }];
  const deliveries = await db.emailDelivery.findMany({
    where: { OR: deliveryOr },
    orderBy: { createdAt: "desc" },
    take: cap + 1,
    include: { hubMessage: { select: { id: true } } },
  });
  if (deliveries.length > cap) { truncated = true; deliveries.length = cap; }
  for (const d of deliveries) {
    // Already shown as the hub message that sent it.
    if (d.hubMessage && messageIds.has(d.hubMessage.id)) continue;
    const email = emailOf(d);
    entries.push({ type: "email", id: `email:${d.id}`, at: email.createdAt, visitId: d.visitId, jobLabel: labelFor(d.visitId), email });
  }

  // ── 5. a website chat: one line, the transcript stays in the Lead drawer ──────────────────────
  if (leadIds.length > 0) {
    const chats = await db.bookingChat.findMany({
      where: { leadId: { in: leadIds } },
      select: { id: true, leadId: true, status: true, transcriptJson: true, createdAt: true },
    });
    for (const c of chats) {
      entries.push({
        type: "web_chat", id: `chat:${c.id}`, at: c.createdAt.toISOString(), visitId: null, jobLabel: null,
        leadId: c.leadId as string, count: parseJsonArrayLength(c.transcriptJson), status: c.status,
      });
    }
  }

  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));

  // ── 6. the job's own crew thread, for the Job drawer's "Crew chat" button ─────────────────────
  let crewThread: TimelineResponse["crewThread"] = null;
  if (visitId) {
    const crew = await db.hubThread.findFirst({ where: { kind: "job", visitId } });
    const visibleCrew = crew ? await findVisibleThread(reader, crew.id, db) : null;
    if (visibleCrew) {
      const counts = await unreadCounts(reader, db, [visibleCrew.id]);
      crewThread = { id: visibleCrew.id, unread: counts.byThread[visibleCrew.id] ?? 0 };
    }
  }

  return {
    scope: { customerId, leadId: leadOnlyId ?? ("leadId" in target ? target.leadId : null), visitId, propertyId, name },
    readOnly: propertyId !== null,
    entries,
    truncated,
    crewThread,
  };
}
