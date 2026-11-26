/**
 * The field app's Messages (work order agent-team, U5): what a technician's phone reads of the hub. The
 * routes on healthRecordTechRouter (routes/health-record.ts, "THE FIELD APP'S MESSAGES") are thin doors onto
 * these functions and onto the hub's own writers (postMessage, editOwnMessage, softDeleteMessage,
 * markThreadRead), so a technician's message is made by the same ONE writer as the office's.
 *
 * Who a technician can reach, by the ONE visibility rule (visibleThreadWhere): the job threads of visits
 * they are assigned to, their OWN Team thread (one per person, made here the first time they open
 * Messages), their own Training thread if one exists, and the office-made GROUP chats they are a member of (C7;
 * a closed group leaves the list, like a closed job thread). Never a customer thread and never a Dev thread
 * (team answer 11b). A thread that exists but is not theirs is a 403, not a hint that it is there.
 *
 * What they read: the crew's in-app messages that stand as posted. A text or an email to a customer that
 * sits in a job's conversation is not shown, and a draft an AI agent left for approval (Scout's, in a
 * Training thread) is hidden until it is approved and posted (amendment 16a). Names only: an author is
 * the technician's name (Technician.name, selected alone, never the access token) or "<name> (AI)".
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import {
  HubError, approverReaderForTechnician, ensureTeamThread, findVisibleThread, readerHoldsPower, unreadCounts, visibleThreadWhere, type HubReader,
} from "./hub";
import { listApprovalCards } from "./hubCards";
import { FIELD_CRM_ONLY_KINDS, FIELD_CRM_ONLY_REASON } from "../../shared/hub/cards";
import type { ApprovalsResponse } from "../../shared/hub/views";
import { THREAD_MESSAGE_LIMIT } from "./hubInbox";
import { stagedPhotos } from "./hubAttachments";
import { AI_ADMIN_SUB } from "./adminLogin";
import type { TechBadge, TechMessage, TechThreadDetail, TechThreadRow, TechThreadsResponse } from "../../shared/hub/views";

/** A message a technician may read: said in the app, among the crew, and standing as posted. */
export const TECH_MESSAGE_WHERE = { channel: "in_app", direction: "internal", status: "posted" } as const;

const AI_AUTHORS = new Set(["ai_agent", "claude"]);

export function techAuthorLabel(authorType: string, name: string): string {
  return AI_AUTHORS.has(authorType) && !/\(AI\)\s*$/.test(name) ? `${name} (AI)` : name;
}

/**
 * W2-D: the agent role behind each AI post, for the avatar. ONE query for the whole read (never one per message), selecting the key's
 * id and role ONLY: an AgentKey row holds its secret hash, so nothing else of it is ever fetched. The AI admin's own CRM session writes
 * ai_agent posts with no key and authorKey "ai-admin"; those are Admin's words, so "admin" (the rule hubEvents.emitTeamMessageEvents
 * uses). A person's message, and an approver's edited copy of an agent's draft (authored as the approver, a person), are null: the
 * avatar says "an AI wrote this", and an edited copy was rewritten and sent by a person. An AI post whose key has since been deleted is
 * null too, and the bubble falls back to the neutral "AI" avatar by authorType.
 */
export async function agentRolesFor(
  rows: ReadonlyArray<{ authorType: string; authorKey: string | null; authorBotKeyId: string | null }>, db: PrismaClient = defaultPrisma,
): Promise<(row: { authorType: string; authorKey: string | null; authorBotKeyId: string | null }) => string | null> {
  const keyIds = [...new Set(rows.flatMap((m) => (AI_AUTHORS.has(m.authorType) && m.authorBotKeyId ? [m.authorBotKeyId] : [])))];
  const roles = new Map(
    (keyIds.length === 0 ? [] : await db.agentKey.findMany({ where: { id: { in: keyIds } }, select: { id: true, agentRole: true } })).map((k) => [k.id, k.agentRole]),
  );
  return (m) => {
    if (!AI_AUTHORS.has(m.authorType)) return null;
    if (m.authorBotKeyId) return roles.get(m.authorBotKeyId) ?? null;
    return m.authorKey === AI_ADMIN_SUB ? "admin" : null;
  };
}

/** The hub reader for a signed-in technician (the route's req.technician). */
export function techReader(tech: { id: string; name: string }): HubReader {
  return {
    key: `tech:${tech.id}`, kind: "tech", display: tech.name, technicianId: tech.id,
    threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false,
  };
}

/**
 * The ONE approver rule, seen from the field (work order agent-team, U10 under default D1): a technician may decide
 * what the agents draft only when the person they are is linked to a CRM login that holds the approve_drafts power, or
 * is Kyle's own principal login. It is the CRM's test (readerForKey applies the same canApprove rule to a stored
 * login), never the technician's role. Returns the OFFICE reader of that login: the decisions are made, audited and
 * shown as that person's CRM identity, so an approval reads the same whichever phone or desk it was made on.
 * Null for everyone else (a technician with no login, a login without the power, a login that is turned off).
 */
export async function techApproverReader(technicianId: string, db: PrismaClient = defaultPrisma): Promise<HubReader | null> {
  return approverReaderForTechnician(technicianId, db);
}

/**
 * The field's "Needs approval" list for this technician: the CRM's cards, built by the CRM's card builder (a
 * technician's own message filter hides drafts and customer threads on purpose, so an approver reads the cards, not
 * the messages), minus the kinds only the CRM decides. A technician who may not approve gets an empty list that
 * says so, so the screen never shows them the chip.
 */
export async function techApprovals(technicianId: string, db: PrismaClient = defaultPrisma): Promise<{ approver: HubReader | null; response: ApprovalsResponse }> {
  const approver = await techApproverReader(technicianId, db);
  if (!approver) return { approver: null, response: { cards: [], canApprove: false, approveReason: null } };
  // canApprove here is approve_drafts; a login holding only a kind's own power (price_book_edit) gets a list cut to that kind (hubCards).
  return { approver, response: await listApprovalCards(approver, { status: "pending", excludeKinds: FIELD_CRM_ONLY_KINDS }, await readerHoldsPower(approver, "approve_drafts", db), db) };
}

/** A card kind only the CRM decides is refused here, by id, as well as left out of the list. */
export async function assertFieldDecidable(messageId: string, db: PrismaClient = defaultPrisma): Promise<void> {
  const row = await db.hubMessage.findUnique({ where: { id: messageId }, select: { actionKind: true } });
  if (row?.actionKind && FIELD_CRM_ONLY_KINDS.includes(row.actionKind)) throw new HubError(FIELD_CRM_ONLY_REASON, 409);
}

/** The same "still on my list" test as GET /health-record/assignments. */
const ASSIGNED_NOW: Prisma.VisitAssignmentWhereInput = {
  status: { in: ["assigned", "in_progress"] },
  visit: { status: { notIn: ["cancelled", "completed"] }, completedAt: null },
};

const ellipsis = (text: string): string => (text.length > 120 ? `${text.slice(0, 120)}…` : text);

/**
 * The Messages list: Team, Training (when there is one), the groups this person is in, and one row per job the technician is on - a job
 * nobody has written in yet is a row with no thread, opened by visit id. Makes the Team thread on first use.
 */
export async function listTechThreads(reader: HubReader, db: PrismaClient = defaultPrisma): Promise<TechThreadsResponse> {
  const techId = reader.technicianId;
  if (!techId) return { threads: [], unread: 0 };
  const team = await ensureTeamThread(techId, db);

  const [assignments, training] = await Promise.all([
    db.visitAssignment.findMany({
      where: { technicianId: techId, ...ASSIGNED_NOW },
      select: { visitId: true, visit: { select: { customer: { select: { name: true } }, property: { select: { addressLine1: true } } } } },
      orderBy: { assignedAt: "asc" },
    }),
    db.hubThread.findFirst({ where: { kind: "training", technicianId: techId } }),
  ]);
  const activeVisitIds = assignments.map((a) => a.visitId);
  const jobThreads = await db.hubThread.findMany({
    where: {
      AND: [
        visibleThreadWhere(reader), { kind: "job" }, { status: { not: "closed" } },
        { OR: [{ visitId: { in: activeVisitIds } }, { messages: { some: { ...TECH_MESSAGE_WHERE, deletedAt: null } } }] },
      ],
    },
  });
  const groups = await db.hubThread.findMany({
    where: { AND: [visibleThreadWhere(reader), { kind: "group" }, { status: { not: "closed" } }] },
    orderBy: { lastMessageAt: "desc" },
  });
  const threads = [team, ...(training ? [training] : []), ...groups, ...jobThreads];
  const ids = threads.map((t) => t.id);

  const [unread, lastRows] = await Promise.all([
    unreadCounts(reader, db, ids),
    db.hubMessage.findMany({
      where: { threadId: { in: ids }, deletedAt: null, ...TECH_MESSAGE_WHERE },
      orderBy: { createdAt: "desc" }, distinct: ["threadId"],
      select: { threadId: true, authorType: true, authorKey: true, authorBotKeyId: true, authorDisplay: true, body: true, photoIds: true, createdAt: true, sentAt: true, _count: { select: { attachments: true } } },
    }),
  ]);
  const last = new Map(lastRows.map((m) => [m.threadId, m]));
  const roleOf = await agentRolesFor(lastRows, db);
  const lastLineOf = (threadId: string): TechThreadRow["lastLine"] => {
    const m = last.get(threadId);
    if (!m) return null;
    const hasPhoto = m.photoIds.length > 0 || m._count.attachments > 0;
    return { authorType: m.authorType, agentRole: roleOf(m), authorLabel: techAuthorLabel(m.authorType, m.authorDisplay), text: m.body ? ellipsis(m.body) : hasPhoto ? "Photo" : "", at: (m.sentAt ?? m.createdAt).toISOString() };
  };

  const rows: TechThreadRow[] = [];
  const row = (t: (typeof threads)[number], kind: TechThreadRow["kind"], key: string, title: string): TechThreadRow => ({
    key, kind, threadId: t.id, title, visitId: t.visitId, unread: unread.byThread[t.id] ?? 0,
    lastLine: lastLineOf(t.id), lastMessageAt: last.has(t.id) ? t.lastMessageAt.toISOString() : null,
  });
  rows.push(row(team, "team", "team", "Team"));
  if (training) rows.push(row(training, "training", "training", "Training"));
  for (const g of groups) rows.push(row(g, "group", `group:${g.id}`, g.title));

  const byVisit = new Map(jobThreads.map((t) => [t.visitId, t]));
  const jobRows: TechThreadRow[] = [];
  for (const a of assignments) {
    const t = byVisit.get(a.visitId);
    if (t) {
      byVisit.delete(a.visitId);
      jobRows.push(row(t, "job", `job:${a.visitId}`, t.title));
    } else {
      jobRows.push({
        key: `job:${a.visitId}`, kind: "job", threadId: null, visitId: a.visitId,
        title: `${a.visit.customer.name} — ${a.visit.property.addressLine1}`, unread: 0, lastLine: null, lastMessageAt: null,
      });
    }
  }
  // Job threads on jobs that are no longer on today's list, still with messages in them.
  for (const t of byVisit.values()) jobRows.push(row(t, "job", `job:${t.visitId}`, t.title));
  jobRows.sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
  rows.push(...jobRows);

  return { threads: rows, unread: rows.reduce((n, r) => n + r.unread, 0) };
}

/**
 * The home screen's "Messages (n new)" and, for an approver, "n waiting for approval": the unread across the same list the Messages
 * screen shows, and the length of the SAME card list the "Waiting for approval" screen shows (techApprovals, not a second rule). A
 * person who may not approve gets 0 and the approvals query never runs for them beyond the one login lookup.
 */
export async function techBadge(reader: HubReader, db: PrismaClient = defaultPrisma): Promise<TechBadge> {
  const unread = (await listTechThreads(reader, db)).unread;
  if (!reader.technicianId) return { unread, waitingApproval: 0 };
  const { approver, response } = await techApprovals(reader.technicianId, db);
  return { unread, waitingApproval: approver && response.canApprove ? response.cards.length : 0 };
}

/**
 * The thread, or a refusal: 404 when there is no such thread, 403 when there is one the technician may not
 * open (another job's, a customer's, someone else's Team thread, any Dev thread).
 */
export async function techThread(reader: HubReader, threadId: string, db: PrismaClient = defaultPrisma) {
  const seen = await findVisibleThread(reader, threadId, db);
  if (seen) return seen;
  const exists = await db.hubThread.count({ where: { id: threadId } });
  if (exists === 0) throw new HubError("Conversation not found", 404);
  throw new HubError("That conversation is not yours to open.", 403);
}

/** One thread with its readable messages. Does not mark anything read (the screen asks for that). */
export async function techThreadDetail(reader: HubReader, threadId: string, db: PrismaClient = defaultPrisma): Promise<TechThreadDetail> {
  const thread = await techThread(reader, threadId, db);
  if (thread.kind !== "team" && thread.kind !== "training" && thread.kind !== "job" && thread.kind !== "group") {
    throw new HubError("That conversation is not yours to open.", 403);
  }
  const [rowsDesc, readState, staged] = await Promise.all([
    db.hubMessage.findMany({
      where: { threadId, ...TECH_MESSAGE_WHERE },
      orderBy: { createdAt: "desc" }, take: THREAD_MESSAGE_LIMIT + 1,
      include: { attachments: { where: { deletedAt: null }, select: { id: true, mimeType: true }, orderBy: { createdAt: "asc" } } },
    }),
    db.hubReadState.findUnique({ where: { readerKey_threadId: { readerKey: reader.key, threadId } } }),
    stagedPhotos(reader, threadId, db),
  ]);
  const truncated = rowsDesc.length > THREAD_MESSAGE_LIMIT;
  if (truncated) rowsDesc.length = THREAD_MESSAGE_LIMIT;
  const rows = rowsDesc.reverse();

  // A technician's name is read live and alone: never the whole technician row (it holds the access token).
  const techIds = [...new Set(rows.flatMap((m) => (m.authorTechnicianId ? [m.authorTechnicianId] : [])))];
  const names = new Map(
    (techIds.length === 0 ? [] : await db.technician.findMany({ where: { id: { in: techIds } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]),
  );

  const roleOf = await agentRolesFor(rows, db);
  const messages: TechMessage[] = rows.map((m) => {
    const deleted = m.deletedAt !== null;
    const mine = m.authorKey !== null && m.authorKey === reader.key;
    const name = (m.authorTechnicianId ? names.get(m.authorTechnicianId) : undefined) ?? m.authorDisplay;
    return {
      id: m.id, authorType: m.authorType, agentRole: roleOf(m), authorLabel: techAuthorLabel(m.authorType, name),
      body: deleted ? null : m.body, deleted, editedAt: m.editedAt ? m.editedAt.toISOString() : null,
      createdAt: m.createdAt.toISOString(), at: (m.sentAt ?? m.createdAt).toISOString(), mine, canEdit: mine && !deleted, canDelete: mine && !deleted,
      attachments: deleted ? [] : m.attachments, photoIds: deleted ? [] : m.photoIds,
    };
  });
  return {
    thread: { id: thread.id, kind: thread.kind, title: thread.title, visitId: thread.visitId, status: thread.status },
    messages, lastReadAt: readState ? readState.lastReadAt.toISOString() : null, truncated, staged,
  };
}
