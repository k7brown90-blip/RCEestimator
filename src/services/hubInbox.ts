/**
 * The Messages page's reads (work order agent-team, U3): the thread list with unread counts, one
 * thread with its messages, and the nav badge. Read-only. Every read goes through visibleThreadWhere,
 * so a reader sees exactly the threads the hub says they may, whatever they ask for. Writes (post,
 * edit, delete, rename, close, mark read) are in services/hub.ts.
 *
 * A thread with no message in it is not listed: a conversation exists on the page once somebody has
 * said something in it.
 */
import { Prisma, type HubThread, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { stagedPhotos } from "./hubAttachments";
import { groupView } from "./hubGroups";
import { HubError, findVisibleThread, maskedRecipient, postRefusal, unreadCounts, visibleThreadWhere, type HubReader } from "./hub";
import type {
  HubBadge, ThreadDetail, ThreadLastLine, ThreadMessage, ThreadRow, ThreadsResponse,
} from "../../shared/hub/views";
import type { HubMessageStatus } from "../../shared/hub/model";

/** The threads the Messages page lists, newest activity first. */
export const THREAD_LIST_LIMIT = 100;
/** The most messages one thread sends at a time. */
export const THREAD_MESSAGE_LIMIT = 300;

const AI_AUTHORS = new Set(["ai_agent", "claude"]);
const PENDING = "pending_approval";

export interface ThreadListFilter {
  kind?: string;
  /** "open" (default: open and snoozed), "closed" or "all". */
  status?: string;
  needsApproval?: boolean;
  q?: string;
  /** Only these kinds (an agent key: the ones its scopes open for reading). Narrows `kind`, never widens the reader's own rule. */
  kinds?: readonly string[];
  /** Only threads with a message after this time (an agent's `since`). */
  since?: Date;
  /** Keep each last line whole instead of cutting it at 140: the agent door scrubs the full text first, then cuts. */
  wholeLastLine?: boolean;
}

/** The longest last line the Messages page shows. */
export const LAST_LINE_MAX = 140;

function rowOf(t: HubThread, unread: number, pending: number, last: ThreadLastLine | null): ThreadRow {
  return {
    id: t.id, kind: t.kind, title: t.title, status: t.status, lastMessageAt: t.lastMessageAt.toISOString(),
    unread, pending, aiLast: last ? AI_AUTHORS.has(last.authorType) : false, lastLine: last,
    customerId: t.customerId, leadId: t.leadId, visitId: t.visitId, technicianId: t.technicianId,
  };
}

/** The newest message of each thread that was not deleted, one query for all of them. */
async function lastLines(db: PrismaClient, ids: string[], whole = false): Promise<Map<string, ThreadLastLine>> {
  const out = new Map<string, ThreadLastLine>();
  if (ids.length === 0) return out;
  const rows = await db.$queryRaw<Array<{ threadId: string; authorType: string; authorDisplay: string; status: string; body: string; createdAt: Date }>>`
    SELECT DISTINCT ON (m."threadId") m."threadId" AS "threadId", m."authorType" AS "authorType",
      m."authorDisplay" AS "authorDisplay", m."status" AS "status", m."body" AS "body", m."createdAt" AS "createdAt"
    FROM "HubMessage" m
    WHERE m."threadId" = ANY(${ids}::text[]) AND m."deletedAt" IS NULL
    ORDER BY m."threadId", m."createdAt" DESC`;
  for (const r of rows) {
    out.set(r.threadId, {
      authorType: r.authorType, authorDisplay: r.authorDisplay, status: r.status as HubMessageStatus,
      text: whole || r.body.length <= LAST_LINE_MAX ? r.body : `${r.body.slice(0, LAST_LINE_MAX)}…`, at: r.createdAt.toISOString(),
    });
  }
  return out;
}

async function pendingByThread(db: PrismaClient, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await db.hubMessage.groupBy({
    by: ["threadId"], where: { threadId: { in: ids }, status: PENDING, deletedAt: null }, _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.threadId, r._count._all]));
}

/** Messages waiting for approval in the threads this reader may see. */
export async function countNeedsApproval(reader: HubReader, db: PrismaClient = defaultPrisma): Promise<number> {
  return db.hubMessage.count({ where: { status: PENDING, deletedAt: null, thread: visibleThreadWhere(reader) } });
}

export async function listThreads(
  reader: HubReader, filter: ThreadListFilter, canApprove: boolean, db: PrismaClient = defaultPrisma,
): Promise<ThreadsResponse> {
  // A conversation is listed once somebody has said something in it - except a GROUP, which the office made and its members
  // must be able to open and write in before the first word is said (C7).
  const and: Prisma.HubThreadWhereInput[] = [visibleThreadWhere(reader), { OR: [{ messages: { some: {} } }, { kind: "group" }] }];
  if (filter.kind) and.push({ kind: filter.kind });
  if (filter.kinds) and.push({ kind: { in: [...filter.kinds] } });
  if (filter.since) and.push({ lastMessageAt: { gt: filter.since } });
  // The approval queue never hides a draft because its thread was closed: countNeedsApproval counts every
  // visible thread, so the list behind "Needs approval (n)" lists every one of them too.
  const status = filter.status ?? "open";
  if (!filter.needsApproval) {
    if (status === "closed") and.push({ status: "closed" });
    else if (status !== "all") and.push({ status: { not: "closed" } });
  }
  if (filter.needsApproval) and.push({ messages: { some: { status: PENDING, deletedAt: null } } });
  const q = filter.q?.trim();
  if (q) {
    and.push({
      OR: [
        { title: { contains: q, mode: "insensitive" } },
        { messages: { some: { deletedAt: null, body: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }

  const threads = await db.hubThread.findMany({ where: { AND: and }, orderBy: { lastMessageAt: "desc" }, take: THREAD_LIST_LIMIT });
  const ids = threads.map((t) => t.id);
  const [unread, pending, last, needsApproval] = await Promise.all([
    unreadCounts(reader, db, ids), pendingByThread(db, ids), lastLines(db, ids, filter.wholeLastLine), countNeedsApproval(reader, db),
  ]);
  return {
    threads: threads.map((t) => rowOf(t, unread.byThread[t.id] ?? 0, pending.get(t.id) ?? 0, last.get(t.id) ?? null)),
    needsApproval,
    canApprove,
  };
}

export async function threadDetail(
  reader: HubReader, threadId: string, db: PrismaClient = defaultPrisma, opts: { wholeLastLine?: boolean } = {},
): Promise<ThreadDetail> {
  const thread = await findVisibleThread(reader, threadId, db);
  if (!thread) throw new HubError("Conversation not found", 404);

  const [rowsDesc, unread, pending, last, readState, postBlock, staged] = await Promise.all([
    db.hubMessage.findMany({ where: { threadId }, orderBy: { createdAt: "desc" }, take: THREAD_MESSAGE_LIMIT + 1 }),
    unreadCounts(reader, db, [threadId]),
    pendingByThread(db, [threadId]),
    lastLines(db, [threadId], opts.wholeLastLine),
    db.hubReadState.findUnique({ where: { readerKey_threadId: { readerKey: reader.key, threadId } } }),
    postRefusal(reader, thread, db),
    stagedPhotos(reader, threadId, db),
  ]);
  const group = thread.kind === "group" ? await groupView(reader, thread, db) : null;
  const truncated = rowsDesc.length > THREAD_MESSAGE_LIMIT;
  if (truncated) rowsDesc.length = THREAD_MESSAGE_LIMIT;
  const rows = rowsDesc.reverse();

  // "Deleted by Eric": the name is on the audit row, the message only keeps a key.
  const deletedIds = rows.filter((m) => m.deletedAt).map((m) => m.id);
  const whoDeleted = new Map<string, string>();
  if (deletedIds.length > 0) {
    const audits = await db.hubAuditLog.findMany({
      where: { action: "message_deleted", messageId: { in: deletedIds } }, select: { messageId: true, actorDisplay: true },
    });
    for (const a of audits) if (a.messageId) whoDeleted.set(a.messageId, a.actorDisplay);
  }

  // The photos held on these messages (a Team or Training thread's), one query; never their bytes.
  const held = new Map<string, Array<{ id: string; mimeType: string }>>();
  const heldRows = rows.length === 0 ? [] : await db.hubAttachment.findMany({
    where: { messageId: { in: rows.filter((m) => !m.deletedAt).map((m) => m.id) }, deletedAt: null },
    select: { id: true, mimeType: true, messageId: true }, orderBy: { createdAt: "asc" },
  });
  for (const a of heldRows) if (a.messageId) held.set(a.messageId, [...(held.get(a.messageId) ?? []), { id: a.id, mimeType: a.mimeType }]);

  const messages: ThreadMessage[] = rows.map((m) => {
    const deleted = m.deletedAt !== null;
    const mine = m.authorKey !== null && m.authorKey === reader.key;
    return {
      id: m.id, authorType: m.authorType, authorDisplay: m.authorDisplay, channel: m.channel, direction: m.direction,
      status: m.status as HubMessageStatus, subject: m.subject, body: deleted ? null : m.body, toAddress: m.toAddress,
      toMasked: m.channel === "sms" ? maskedRecipient(m.toPhone10) : null, messageClass: m.messageClass ?? null,
      error: m.error, deleted, deletedBy: deleted ? whoDeleted.get(m.id) ?? m.deletedBy : null,
      deletedReason: deleted ? m.deletedReason : null, editedAt: m.editedAt ? m.editedAt.toISOString() : null,
      createdAt: m.createdAt.toISOString(), mine,
      canEdit: mine && !deleted && m.status === "posted" && m.channel === "in_app",
      canDelete: !deleted && (mine || reader.isKyle),
      attachments: deleted ? [] : held.get(m.id) ?? [],
      photoIds: deleted ? [] : m.photoIds,
    };
  });

  return {
    thread: rowOf(thread, unread.byThread[threadId] ?? 0, pending.get(threadId) ?? 0, last.get(threadId) ?? null),
    messages,
    lastReadAt: readState ? readState.lastReadAt.toISOString() : null,
    truncated,
    postBlock,
    staged,
    group,
  };
}

/**
 * The Messages nav badge: unread messages, plus approvals when this session may act on them. Unread is
 * counted over the threads the default list shows (not closed), so the badge never points at nothing;
 * approvals are counted over every thread because the approval list shows them all.
 */
export async function hubBadge(reader: HubReader, canApprove: boolean, db: PrismaClient = defaultPrisma): Promise<HubBadge> {
  const [unread, needsApproval] = await Promise.all([
    unreadCounts(reader, db, undefined, { openOnly: true }), countNeedsApproval(reader, db),
  ]);
  return { unread: unread.total, needsApproval, canApprove, total: unread.total + (canApprove ? needsApproval : 0) };
}
