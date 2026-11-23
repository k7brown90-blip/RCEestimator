/**
 * The Messages hub's data core (work order agent-team, U1). Threads of all five kinds, messages, read
 * state, the append-only action audit, and WHO IS READING: one reader identity for the owner, a
 * person's CRM login, the AI admin, a technician and an agent key, with the one rule for which
 * threads each of them may see.
 *
 * What lives here, and what does not:
 *   * ONE row-create function (createMessageRow). Every path that makes a HubMessage - posting in
 *     the app, an edit-approve, a card edit, logging an existing text - goes through it. It derives
 *     `messageClass` and `purposeKey` from `category` through the one registry
 *     (shared/hub/messageCategories.ts) and ignores any class or purposeKey a caller supplies, so a
 *     request body (an agent's, above all) can never choose them.
 *   * ONE audit (hubAudit) on HubAuditLog. Append-only: the database refuses UPDATE and DELETE.
 *   * ONE visibility rule (visibleThreadWhere). A technician sees the job threads they are assigned
 *     to, their own Team thread and their own Training thread, and never a Dev thread. An agent key
 *     sees only the thread kinds in its `hubThreadKinds` (empty means no limit).
 *     A GROUP (C7, an office-made chat) is seen by its members: a technician and an agent key only when they
 *     are in it; the office (an owner or a CRM login) sees every group, because the office makes and manages
 *     them, but is only counted and pushed to as a member. The AI admin session sees none.
 *   * ONE fan-out call site (fanOutMessage): where a new message becomes the live-update event
 *     (services/hubBus.ts), the web push (services/hubNotifier.ts) and the signed webhook event
 *     (services/hubEvents.ts). No other place emits for a message; an edit and a delete announce
 *     themselves here too, and a decision announces through hubBus announceDecision.
 *
 * It sends nothing to a customer. Email and text go out through the send function (U4), which comes
 * after this. Person id everywhere is Technician.id.
 */
import type { Request } from "express";
import { Prisma, type HubMessage, type HubThread, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import type { RequestAuthState } from "../middleware/accessLog";
import type { TechRequest } from "../routes/technicianAuth";
import type { AgentRequestState } from "../agentApi/gate";
import { logSystemEvent } from "./systemEvents";
import { isKylePhone } from "./kylePhone";
import { getPrincipalLogin } from "./crmLogin";
import { emitGroupMessageEventSafe, emitHubEventSafe } from "./hubEvents";
import { publishHubChange } from "./hubBus";
import { notifyNewMessage } from "./hubNotifier";
import { stagedPhotoIds } from "./hubAttachments";
import { messageCategoryFor, type MessageClass } from "../../shared/hub/messageCategories";
import {
  HUB_AUTHOR_TYPES, HUB_CHANNELS, HUB_DIRECTIONS, HUB_MESSAGE_STATUSES, HUB_READABLE_STATUSES,
  HUB_THREAD_STATUSES, type HubChannel, type HubMessageStatus,
} from "../../shared/hub/model";
import { hubKindsFor, isHubThreadKind, type HubThreadKind } from "../../shared/agentScopes";
import { GROUP_CLOSED_POST_REASON } from "../../shared/hub/groups";

type Db = PrismaClient | Prisma.TransactionClient;

export class HubError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "HubError";
    this.status = status;
  }
}

// ── who is reading ───────────────────────────────────────────────────────────────────────────────

export type HubReaderKind = "owner" | "user" | "ai-admin" | "tech" | "agent";

/**
 * One reader of the hub. `key` is the identity used for read state and for "my own message":
 * `owner` (Kyle's PIN session, and gate-disabled dev/test), `user:<CrmLogin.id>`, `ai-admin`,
 * `tech:<Technician.id>`, `agent:<AgentKey.id>`. `technicianId` is the person (Technician.id) when
 * there is one. `threadKinds` is an agent key's `hubThreadKinds` (empty means no limit).
 */
export interface HubReader {
  key: string;
  kind: HubReaderKind;
  display: string;
  technicianId: string | null;
  threadKinds: string[];
  /** The agent key's role (admin, inventory, claude_code, ...); only for kind "agent". */
  agentRole: string | null;
  /** The agent key's id; only for kind "agent". */
  agentKeyId: string | null;
  /**
   * The agent key's scopes; only for kind "agent". Which kinds of thread the key may see and post in comes from
   * these (shared/agentScopes.ts HUB_KIND_SCOPES). Missing means none: an agent reader built without scopes sees nothing.
   */
  agentScopes?: readonly string[];
  /**
   * Kyle himself: his PIN session, gate-disabled, or his principal CRM login (the same test as
   * middleware/kylePowers isKyle). A "user" reader can be Kyle, so `kind === "owner"` alone is not it.
   */
  isKyle: boolean;
}

type HubRequest = Request & RequestAuthState & AgentRequestState & Partial<Pick<TechRequest, "technician">>;

/**
 * Who this request is, for the hub. Order matters: an agent key is never also a session, and a
 * technician's bearer is never a CRM session (the field routes mount before the session gate). Null
 * when the request carries no identity the hub knows.
 */
export function readerFor(req: Request): HubReader | null {
  const r = req as HubRequest;
  if (r.agentPrincipal) {
    const p = r.agentPrincipal;
    return {
      key: `agent:${p.keyId}`, kind: "agent", display: p.name, technicianId: null,
      threadKinds: [...p.hubThreadKinds], agentRole: p.role, agentKeyId: p.keyId, agentScopes: [...p.scopes], isKyle: false,
    };
  }
  if (r.technician) {
    return {
      key: `tech:${r.technician.id}`, kind: "tech", display: r.technician.name, technicianId: r.technician.id,
      threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false,
    };
  }
  if (r._crmLogin) {
    return {
      key: `user:${r._crmLogin.id}`, kind: "user", display: r._crmLogin.name, technicianId: r._crmLogin.technicianId,
      threadKinds: [], agentRole: null, agentKeyId: null, isKyle: r._crmLogin.isPrincipal === true,
    };
  }
  if (r._authActor === "ai-admin") {
    return { key: "ai-admin", kind: "ai-admin", display: "AI admin", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false };
  }
  if (r._authActor === "owner" || r._authOutcome === "gate-disabled") {
    return { key: "owner", kind: "owner", display: "Kyle", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: true };
  }
  return null;
}

/** The reader key for read state and "my own message", or null when the request has no identity. */
export function readerKeyFor(req: Request): string | null {
  return readerFor(req)?.key ?? null;
}

/**
 * The reader a stored reader key stands for, for the places that act on someone who is NOT making a
 * request (a push notification is addressed to a key). Null when the key no longer names anyone who may
 * read: a login that was turned off, a technician who is no longer active, or a key that is not a person
 * (the AI admin and the agent keys are never notified by push). `canApprove` is the same test as
 * middleware/kylePowers canApprove, applied to the stored login instead of a request.
 */
export async function readerForKey(key: string, db: Db = defaultPrisma): Promise<{ reader: HubReader; canApprove: boolean } | null> {
  if (key === "owner") {
    return {
      reader: { key, kind: "owner", display: "Kyle", technicianId: null, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: true },
      canApprove: true,
    };
  }
  if (key.startsWith("user:")) {
    const login = await db.crmLogin.findUnique({ where: { id: key.slice("user:".length) }, include: { technician: { select: { name: true, isActive: true } } } });
    if (!login || !login.enabled || !login.technician.isActive) return null;
    return {
      reader: {
        key, kind: "user", display: login.technician.name, technicianId: login.technicianId,
        threadKinds: [], agentRole: null, agentKeyId: null, isKyle: login.isPrincipal,
      },
      canApprove: login.isPrincipal || login.powers.includes("approve_drafts"),
    };
  }
  if (key.startsWith("tech:")) {
    const t = await db.technician.findUnique({ where: { id: key.slice("tech:".length) }, select: { id: true, name: true, isActive: true } });
    if (!t || !t.isActive) return null;
    return {
      reader: { key, kind: "tech", display: t.name, technicianId: t.id, threadKinds: [], agentRole: null, agentKeyId: null, isKyle: false },
      canApprove: false,
    };
  }
  return null;
}

/**
 * The threads this reader may see, as a Prisma where. The one rule:
 *   - owner, a person's CRM login and the AI admin: every thread;
 *   - a technician: a job thread for a visit they are assigned to, their own Team thread, their own
 *     Training thread. Never a customer thread and never a Dev thread (team answer 11b);
 *   - an agent key: only the kinds its scopes open (customer and job: hub:read or hub:draft; team: team:reply;
 *     dev: dev:read; training: training:read or training:write), and of those only the kinds in its hubThreadKinds
 *     when that list is not empty (Scout: training only; Claude Code: dev only).
 */
export function visibleThreadWhere(reader: HubReader): Prisma.HubThreadWhereInput {
  switch (reader.kind) {
    case "owner":
    case "user":
      return {};
    case "ai-admin":
      // The AI admin session is not a member of anything: an office-made group is the office's and its members'.
      return { kind: { not: "group" } };
    case "tech": {
      const id = reader.technicianId;
      if (!id) return { id: { in: [] } };
      return {
        OR: [
          { kind: "job", visit: { assignments: { some: { technicianId: id } } } },
          { kind: "team", technicianId: id },
          { kind: "training", technicianId: id },
          { kind: "group", members: { some: { technicianId: id } } },
        ],
      };
    }
    case "agent": {
      // What the key's scopes open, narrowed by its hubThreadKinds (ONE rule: HUB_KIND_SCOPES). The door
      // narrows again to read or post for the call it is answering.
      const kinds = hubKindsFor(reader.agentScopes ?? [], "any", reader.threadKinds);
      if (!kinds.includes("group")) return { kind: { in: kinds } };
      // A group the key is not a member of is not there at all (the door answers it as not found).
      const others = kinds.filter((k) => k !== "group");
      const memberOf: Prisma.HubThreadWhereInput = reader.agentKeyId
        ? { kind: "group", members: { some: { agentKeyId: reader.agentKeyId } } }
        : { id: { in: [] } };
      return others.length > 0 ? { OR: [{ kind: { in: others } }, memberOf] } : memberOf;
    }
  }
}

/**
 * The person (Technician.id) a reader is, when they are one: a technician, a CRM login tied to a person, or Kyle's PIN
 * session, which acts as the principal login's person. Null for the AI admin, an agent key and a sign-in tied to no one.
 */
export async function personIdOf(reader: HubReader, db: PrismaClient = defaultPrisma): Promise<string | null> {
  if (reader.technicianId) return reader.technicianId;
  if (reader.kind === "owner") return (await getPrincipalLogin(db))?.technicianId ?? null;
  return null;
}

/**
 * Which of these GROUP threads the reader is a member of (C7): a person by Technician.id, an agent key by AgentKey.id.
 * The office reads and manages every group, but only a member is counted unread, pushed to and let post.
 */
export async function memberGroupIds(reader: HubReader, groupIds: readonly string[], db: PrismaClient = defaultPrisma): Promise<Set<string>> {
  if (groupIds.length === 0) return new Set();
  const personId = await personIdOf(reader, db);
  const or: Prisma.HubThreadMemberWhereInput[] = [];
  if (personId) or.push({ technicianId: personId });
  if (reader.kind === "agent" && reader.agentKeyId) or.push({ agentKeyId: reader.agentKeyId });
  if (or.length === 0) return new Set();
  const rows = await db.hubThreadMember.findMany({ where: { threadId: { in: [...groupIds] }, OR: or }, select: { threadId: true } });
  return new Set(rows.map((r) => r.threadId));
}

/** The thread, only if this reader may see it; otherwise null (callers answer 404, never "forbidden"). */
export async function findVisibleThread(reader: HubReader, threadId: string, db: Db = defaultPrisma): Promise<HubThread | null> {
  return db.hubThread.findFirst({ where: { AND: [{ id: threadId }, visibleThreadWhere(reader)] } });
}

// ── the audit ────────────────────────────────────────────────────────────────────────────────────

export interface HubAuditEntry {
  actorKey: string;
  actorDisplay: string;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  threadId?: string | null;
  messageId?: string | null;
  agentAuditLogId?: string | null;
  beforeText?: string | null;
  afterText?: string | null;
  details?: Record<string, unknown> | null;
}

export const SYSTEM_ACTOR = { key: "system", display: "System" } as const;

export function actorOf(reader: HubReader | null): { key: string; display: string } {
  return reader ? { key: reader.key, display: reader.display } : SYSTEM_ACTOR;
}

/**
 * Append one row to the hub audit. The ONLY writer of HubAuditLog; there is no update and no delete
 * in the app (and the database refuses both). Pass the transaction client when the audited change is
 * in a transaction, so the row commits or rolls back WITH it.
 */
export async function hubAudit(db: Db, entry: HubAuditEntry): Promise<string> {
  const row = await db.hubAuditLog.create({
    data: {
      actorKey: entry.actorKey,
      actorDisplay: entry.actorDisplay,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      threadId: entry.threadId ?? null,
      messageId: entry.messageId ?? null,
      agentAuditLogId: entry.agentAuditLogId ?? null,
      beforeText: entry.beforeText ?? null,
      afterText: entry.afterText ?? null,
      detailsJson: entry.details ? JSON.stringify(entry.details) : null,
    },
    select: { id: true },
  });
  return row.id;
}

// ── threads ──────────────────────────────────────────────────────────────────────────────────────

const isUniqueRace = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/** The last ten digits of a phone number, or null when there are fewer than ten digits. */
export function last10(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

export type ThreadTarget = { customerId: string } | { leadId: string } | { visitId: string };

/**
 * The conversation for one record, made on its first use. A customer id gives the account's thread
 * (kind customer); a lead id gives the lead's thread (kind customer), or the account's when the lead
 * has already become one; a visit id gives that job's crew thread (kind job). Idempotent and safe
 * against two callers at once: the unique keys on HubThread decide, and the loser reads the winner's.
 */
export async function ensureThreadFor(target: ThreadTarget, db: Db = defaultPrisma): Promise<HubThread> {
  if ("customerId" in target) {
    return ensureKeyedThread(db, "customer", "customerId", target.customerId, async () => {
      const c = await db.customer.findUnique({ where: { id: target.customerId }, select: { name: true } });
      if (!c) throw new HubError("Account not found", 404);
      return c.name;
    });
  }
  if ("leadId" in target) {
    const lead = await db.lead.findUnique({ where: { id: target.leadId }, select: { name: true, customerId: true } });
    if (!lead) throw new HubError("Lead not found", 404);
    if (lead.customerId) return ensureThreadFor({ customerId: lead.customerId }, db);
    return ensureKeyedThread(db, "customer", "leadId", target.leadId, async () => lead.name);
  }
  return ensureKeyedThread(db, "job", "visitId", target.visitId, async () => {
    const v = await db.visit.findUnique({
      where: { id: target.visitId },
      select: { customer: { select: { name: true } }, property: { select: { addressLine1: true } } },
    });
    if (!v) throw new HubError("Job not found", 404);
    return `${v.customer.name} — ${v.property.addressLine1}`;
  });
}

/** One Team thread per person (team answer 9a), made on first use. */
export async function ensureTeamThread(technicianId: string, db: Db = defaultPrisma): Promise<HubThread> {
  return ensureKeyedThread(db, "team", "technicianId", technicianId, async () => {
    const t = await db.technician.findUnique({ where: { id: technicianId }, select: { name: true } });
    if (!t) throw new HubError("Person not found", 404);
    return `${t.name} ↔ AI team`;
  });
}

type KeyColumn = "customerId" | "leadId" | "visitId" | "technicianId";

async function ensureKeyedThread(
  db: Db, kind: HubThreadKind, column: KeyColumn, id: string, titleOf: () => Promise<string>,
): Promise<HubThread> {
  const where = { kind, [column]: id } as Prisma.HubThreadWhereInput;
  const existing = await db.hubThread.findFirst({ where });
  if (existing) return existing;
  const title = await titleOf();
  try {
    const created = await db.hubThread.create({ data: { kind, title, [column]: id } as Prisma.HubThreadUncheckedCreateInput });
    await hubAudit(db, {
      actorKey: SYSTEM_ACTOR.key, actorDisplay: SYSTEM_ACTOR.display,
      action: "thread_created", entityType: "thread", entityId: created.id, threadId: created.id,
      details: { kind, [column]: id },
    });
    return created;
  } catch (err) {
    // Two callers raced to make the same thread; the unique key kept one. Read it. (Inside a
    // transaction a failed insert aborts the transaction, so only the plain client recovers here.)
    if (isUniqueRace(err)) {
      const winner = await db.hubThread.findFirst({ where });
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Conversion (called by convertLeadToOpportunity INSIDE its transaction, with the transaction
 * client): the lead's conversation joins the account's. If the account has no thread yet, the lead's
 * thread is re-keyed to the account. If it has one, the lead thread's messages and files move onto it
 * and the empty lead thread goes. Either way one audit row says what happened. A lead that never had
 * a conversation costs nothing.
 */
export async function mergeLeadThread(
  tx: Prisma.TransactionClient, input: { leadId: string; customerId: string },
): Promise<{ action: "none" | "rekeyed" | "merged"; threadId: string | null; moved: number }> {
  const leadThread = await tx.hubThread.findFirst({ where: { kind: "customer", leadId: input.leadId } });
  if (!leadThread) return { action: "none", threadId: null, moved: 0 };
  const accountThread = await tx.hubThread.findFirst({ where: { kind: "customer", customerId: input.customerId } });
  if (!accountThread) {
    await tx.hubThread.update({ where: { id: leadThread.id }, data: { customerId: input.customerId, leadId: null } });
    await hubAudit(tx, {
      actorKey: SYSTEM_ACTOR.key, actorDisplay: SYSTEM_ACTOR.display, action: "thread_merged", entityType: "thread",
      entityId: leadThread.id, threadId: leadThread.id, details: { leadId: input.leadId, customerId: input.customerId, how: "rekeyed" },
    });
    return { action: "rekeyed", threadId: leadThread.id, moved: 0 };
  }
  const moved = await tx.hubMessage.updateMany({ where: { threadId: leadThread.id }, data: { threadId: accountThread.id } });
  await tx.hubAttachment.updateMany({ where: { threadId: leadThread.id }, data: { threadId: accountThread.id } });
  const newest = leadThread.lastMessageAt > accountThread.lastMessageAt ? leadThread.lastMessageAt : accountThread.lastMessageAt;
  await tx.hubThread.update({ where: { id: accountThread.id }, data: { lastMessageAt: newest } });
  await tx.hubThread.delete({ where: { id: leadThread.id } });
  await hubAudit(tx, {
    actorKey: SYSTEM_ACTOR.key, actorDisplay: SYSTEM_ACTOR.display, action: "thread_merged", entityType: "thread",
    entityId: accountThread.id, threadId: accountThread.id,
    details: { leadId: input.leadId, customerId: input.customerId, how: "merged", fromThreadId: leadThread.id, messages: moved.count },
  });
  return { action: "merged", threadId: accountThread.id, moved: moved.count };
}

/**
 * A conversation was merged or handed back INSIDE a caller's transaction (mergeLeadThread, returnThreadToLead).
 * The caller says so here AFTER its transaction commits, so an open screen refetches and finds the result. Pass
 * the SURVIVING thread's id (the one the call returned): a deleted thread would never be delivered. Nothing to say
 * for "none".
 */
export function announceThreadMoved(outcome: { threadId: string | null }): void {
  if (outcome.threadId) publishHubChange({ type: "changed", threadId: outcome.threadId, messageId: null });
}

/**
 * The other way (called by deleteCustomer INSIDE its transaction, before the account goes): an EMPTY
 * account is being deleted and its lead goes back to being a lead (status "new", no account). The
 * account's thread would be deleted with it (HubThread.customerId cascades), and with it the
 * conversation the lead had BEFORE it converted. So the thread goes back to the lead. A lead that
 * somehow has a thread of its own again gets the messages moved onto it. With no lead the thread goes
 * with the account, like the account's notes do. One audit row says what happened.
 */
export async function returnThreadToLead(
  tx: Prisma.TransactionClient, input: { customerId: string; leadId: string | null },
): Promise<{ action: "none" | "rekeyed" | "merged"; threadId: string | null }> {
  if (!input.leadId) return { action: "none", threadId: null };
  const accountThread = await tx.hubThread.findFirst({ where: { kind: "customer", customerId: input.customerId } });
  if (!accountThread) return { action: "none", threadId: null };
  const leadThread = await tx.hubThread.findFirst({ where: { kind: "customer", leadId: input.leadId } });
  if (!leadThread) {
    await tx.hubThread.update({ where: { id: accountThread.id }, data: { customerId: null, leadId: input.leadId } });
    await hubAudit(tx, {
      actorKey: SYSTEM_ACTOR.key, actorDisplay: SYSTEM_ACTOR.display, action: "thread_merged", entityType: "thread",
      entityId: accountThread.id, threadId: accountThread.id,
      details: { how: "returned_to_lead", leadId: input.leadId, customerId: input.customerId },
    });
    return { action: "rekeyed", threadId: accountThread.id };
  }
  const moved = await tx.hubMessage.updateMany({ where: { threadId: accountThread.id }, data: { threadId: leadThread.id } });
  await tx.hubAttachment.updateMany({ where: { threadId: accountThread.id }, data: { threadId: leadThread.id } });
  await tx.hubThread.delete({ where: { id: accountThread.id } });
  await hubAudit(tx, {
    actorKey: SYSTEM_ACTOR.key, actorDisplay: SYSTEM_ACTOR.display, action: "thread_merged", entityType: "thread",
    entityId: leadThread.id, threadId: leadThread.id,
    details: { how: "returned_to_lead", leadId: input.leadId, customerId: input.customerId, fromThreadId: accountThread.id, messages: moved.count },
  });
  return { action: "merged", threadId: leadThread.id };
}

/** Close or reopen (or snooze) a thread, with the audit. The exit for a conversation: nothing here is deleted. */
export async function setThreadStatus(reader: HubReader, threadId: string, status: string, db: PrismaClient = defaultPrisma): Promise<HubThread> {
  if (!(HUB_THREAD_STATUSES as readonly string[]).includes(status)) throw new HubError("Unknown thread status");
  const thread = await findVisibleThread(reader, threadId, db);
  if (!thread) throw new HubError("Conversation not found", 404);
  if (thread.status === status) return thread;
  const changed = await db.$transaction(async (tx) => {
    const updated = await tx.hubThread.update({ where: { id: threadId }, data: { status } });
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "thread_status", entityType: "thread",
      entityId: threadId, threadId, beforeText: thread.status, afterText: status,
    });
    return updated;
  });
  // Closing or reopening moves every open screen's list and badge (ids only; U6).
  publishHubChange({ type: "changed", threadId, messageId: null });
  return changed;
}

/** Rename a thread, with the audit (the old title is kept in it). Any reader who can see the thread may. */
export async function renameThread(reader: HubReader, threadId: string, title: string, db: PrismaClient = defaultPrisma): Promise<HubThread> {
  const next = (title ?? "").trim();
  if (!next) throw new HubError("A thread needs a name.");
  if (next.length > 120) throw new HubError("Keep the name to 120 characters.");
  const thread = await findVisibleThread(reader, threadId, db);
  if (!thread) throw new HubError("Conversation not found", 404);
  if (thread.title === next) return thread;
  const renamed = await db.$transaction(async (tx) => {
    const updated = await tx.hubThread.update({ where: { id: threadId }, data: { title: next } });
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "thread_renamed", entityType: "thread",
      entityId: threadId, threadId, beforeText: thread.title, afterText: next,
    });
    return updated;
  });
  publishHubChange({ type: "changed", threadId, messageId: null });
  return renamed;
}

// ── messages: the one row-create function ────────────────────────────────────────────────────────

/**
 * Everything a caller may set on a new message. There is deliberately NO `messageClass` and NO
 * `purposeKey` here: both come from `category` and the registry. A caller that smuggles either in
 * (an agent's request body) is ignored, because the row is built field by field from this list.
 */
export interface CreateMessageInput {
  threadId: string;
  authorType: string;
  authorKey?: string | null;
  authorTechnicianId?: string | null;
  authorBotKeyId?: string | null;
  authorDisplay: string;
  channel: string;
  direction: string;
  status: string;
  body: string;
  subject?: string | null;
  toAddress?: string | null;
  /** The recipient's phone in any format, for toPhone10. Only the last ten digits are kept as a column. */
  toPhone?: string | null;
  cc?: readonly string[];
  photoIds?: readonly string[];
  category?: string | null;
  tags?: readonly string[];
  visitId?: string | null;
  issuedEstimateId?: string | null;
  editedFromId?: string | null;
  decidedBy?: string | null;
  decidedAt?: Date | null;
  rejectedReason?: string | null;
  emailDeliveryId?: string | null;
  providerMessageId?: string | null;
  error?: string | null;
  sentText?: string | null;
  footerIncluded?: boolean;
  headerAt?: Date | null;
  eventStart?: Date | null;
  eventEnd?: Date | null;
  actionKind?: string | null;
  actionPayloadJson?: string | null;
  sendAfter?: Date | null;
  heldReason?: string | null;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  /** postMessage only: the composing screen's one id for this message (see HubMessage.clientMessageId). */
  clientMessageId?: string | null;
}

const oneOf = <T extends string>(list: readonly T[], value: string, what: string): T => {
  if (!(list as readonly string[]).includes(value)) throw new HubError(`Unknown ${what}: ${value}`);
  return value as T;
};

/**
 * Make a HubMessage. THE one place a row is created (U1 first migration; ruling "one row-create
 * function"). Validates the vocabulary, derives class and purposeKey from the registry, and refuses an
 * outbound text that has no send type. Does not touch the thread, the audit or the events; the
 * callers that need those (postMessage, the send function) do them around this call.
 */
export async function createMessageRow(db: Db, input: CreateMessageInput): Promise<HubMessage> {
  const authorType = oneOf(HUB_AUTHOR_TYPES, input.authorType, "author type");
  const channel = oneOf(HUB_CHANNELS, input.channel, "channel");
  const direction = oneOf(HUB_DIRECTIONS, input.direction, "direction");
  const status = oneOf(HUB_MESSAGE_STATUSES, input.status, "message status");
  if (typeof input.body !== "string") throw new HubError("A message needs text");

  const category = input.category ? input.category : null;
  const entry = category ? messageCategoryFor(category) : null;
  if (category && !entry) throw new HubError(`Unknown send type: ${category}`);
  // An outbound text with no send type has no class, so no rule can be applied to it: refused.
  if (channel === "sms" && direction === "outbound" && !entry) {
    throw new HubError("A text needs a send type (category).");
  }

  const toPhone10 = channel === "sms" ? last10(input.toPhone ?? input.toAddress) : null;
  return db.hubMessage.create({
    data: {
      threadId: input.threadId,
      authorType,
      authorKey: input.authorKey ?? null,
      authorTechnicianId: input.authorTechnicianId ?? null,
      authorBotKeyId: input.authorBotKeyId ?? null,
      authorDisplay: input.authorDisplay,
      channel,
      direction,
      status,
      body: input.body,
      subject: input.subject ?? null,
      toAddress: input.toAddress ?? null,
      cc: [...(input.cc ?? [])],
      photoIds: [...(input.photoIds ?? [])],
      category,
      messageClass: entry?.messageClass ?? null,
      purposeKey: entry?.purposeKey ?? null,
      tags: [...(input.tags ?? [])],
      visitId: input.visitId ?? null,
      issuedEstimateId: input.issuedEstimateId ?? null,
      editedFromId: input.editedFromId ?? null,
      decidedBy: input.decidedBy ?? null,
      decidedAt: input.decidedAt ?? null,
      rejectedReason: input.rejectedReason ?? null,
      emailDeliveryId: input.emailDeliveryId ?? null,
      providerMessageId: input.providerMessageId ?? null,
      error: input.error ?? null,
      toPhone10,
      sentText: input.sentText ?? null,
      footerIncluded: input.footerIncluded ?? false,
      headerAt: input.headerAt ?? null,
      eventStart: input.eventStart ?? null,
      eventEnd: input.eventEnd ?? null,
      actionKind: input.actionKind ?? null,
      actionPayloadJson: input.actionPayloadJson ?? null,
      sendAfter: input.sendAfter ?? null,
      heldReason: input.heldReason ?? null,
      sentAt: input.sentAt ?? null,
      deliveredAt: input.deliveredAt ?? null,
      clientMessageId: input.clientMessageId ?? null,
    },
  });
}

/**
 * Who may POST in a thread that limits it. Returns the sentence that says why not, or null when the post is fine.
 * Used by postMessage (the one writer), the photo upload and the thread detail (so the screen greys the box with
 * the same sentence).
 *
 *   * A Team thread is ONE person's channel with the AI team (team answer 9a). Office people may READ every
 *     one, but a signed-in office person (a CRM login, or Kyle's PIN session, which posts as the principal
 *     login's person) may only POST in their OWN. The AI admin and agent keys are the other side of that channel
 *     and are not limited here; a technician can only see their own Team thread to begin with.
 *   * A GROUP (C7) is posted in by its members only, and not while it is closed (a message never reopens a group: its
 *     exit is Close, and Reopen is the way back). The office reads and manages every group; to post in one it is not
 *     in, add yourself under Members. A technician and an agent key only ever see a group they are in.
 */
export async function postRefusal(reader: HubReader, thread: HubThread, db: PrismaClient = defaultPrisma): Promise<string | null> {
  if (thread.kind === "group") {
    if (thread.status === "closed") return GROUP_CLOSED_POST_REASON;
    if (reader.kind === "ai-admin") return "The AI admin session is not a member of any group.";
    if ((await memberGroupIds(reader, [thread.id], db)).has(thread.id)) return null;
    if (reader.kind === "owner" || reader.kind === "user") {
      return (await personIdOf(reader, db))
        ? "You are not a member of this group, so you can read and manage it but not post. Add yourself under Members to post."
        : "This sign-in is not tied to a person on the team, so it cannot post in a group. Sign in with your own login.";
    }
    return "You are not a member of this group.";
  }
  if (thread.kind !== "team") return null;
  if (reader.kind !== "owner" && reader.kind !== "user") return null;
  const mine = reader.kind === "owner" ? (await getPrincipalLogin(db))?.technicianId ?? null : reader.technicianId;
  if (mine && thread.technicianId === mine) return null;
  if (!mine) {
    return "This sign-in is not tied to a person on the team, so it cannot post in a Team thread. Sign in with your own login.";
  }
  const owner = thread.technicianId
    ? await db.technician.findUnique({ where: { id: thread.technicianId }, select: { name: true } })
    : null;
  return `This is ${owner ? `${owner.name}'s` : "another person's"} thread with the AI team — you can read it, not post in it.`;
}

/**
 * A message that a person can now READ has landed in a thread (a post, a text or email that went out):
 * move the thread's last-activity time, and BRING IT BACK if it was closed. The Messages list hides
 * closed threads, so a message in one would otherwise be unread where nobody can see it; the audit says
 * so. The ONE place that does it: postMessage calls it for a post and the send function (services/
 * hubSend.ts) calls it for a sent message - a send into a closed thread reuses this, it does not
 * reimplement it. Pass the transaction client when the message was made in a transaction.
 */
export async function bumpThreadForMessage(
  tx: Db, threadId: string, message: Pick<HubMessage, "id" | "createdAt">, actor: { key: string; display: string }, at: Date = message.createdAt,
): Promise<void> {
  const current = await tx.hubThread.findUnique({ where: { id: threadId }, select: { status: true, kind: true, lastMessageAt: true } });
  if (!current) return;
  // A message never reopens a GROUP (C7): the office closed it on purpose, and Reopen is the way back (an approval of
  // a post drafted before the close lands in it quietly).
  const reopen = current.status === "closed" && current.kind !== "group";
  await tx.hubThread.update({
    where: { id: threadId },
    data: { lastMessageAt: at > current.lastMessageAt ? at : current.lastMessageAt, ...(reopen ? { status: "open" } : {}) },
  });
  if (reopen) {
    await hubAudit(tx, {
      actorKey: actor.key, actorDisplay: actor.display, action: "thread_status", entityType: "thread",
      entityId: threadId, threadId, beforeText: "closed", afterText: "open",
      details: { reason: "message_arrived", messageId: message.id },
    });
  }
}

/** The most photos one message carries. */
export const MAX_PHOTOS_PER_MESSAGE = 6;

/** What a reader's post is authored as. */
function authorTypeFor(reader: HubReader): string {
  switch (reader.kind) {
    case "tech": return "tech";
    case "owner":
    case "user": return "office";
    case "ai-admin": return "ai_agent";
    case "agent": return reader.agentRole === "claude_code" ? "claude" : "ai_agent";
  }
}

export interface PostMessageInput {
  threadId: string;
  body: string;
  subject?: string | null;
  /** VisitPhoto ids already filed on THIS job (a job thread only). */
  photoIds?: readonly string[];
  /**
   * HubAttachment ids already uploaded to THIS thread and not yet on a message (a Team or Training thread).
   * The message takes them; one that was removed, or belongs to another thread, refuses the post.
   */
  attachmentIds?: readonly string[];
  tags?: readonly string[];
  /** An agent may post a draft; anything else it posts waits for approval. Ignored for people. */
  status?: string;
  /** The record this message is about, when the thread is not already that record (a tag inside a customer thread). */
  visitId?: string | null;
  issuedEstimateId?: string | null;
  /** Where the conversation was started from, carried only into the event (TC7 supplies it). */
  context?: { kind: string; id: string } | null;
  /**
   * The composing screen's id for THIS message, made once when the person composes it and sent again on every retry.
   * The same author posting the same id again gets the message they already made, not a second one.
   */
  clientMessageId?: string | null;
}

export const CLIENT_MESSAGE_ID_MIN = 8;
export const CLIENT_MESSAGE_ID_MAX = 100;

export interface PostMessageResult {
  message: HubMessage;
  /** True when this id had already made a message: nothing new was written and nothing was announced. */
  replayed: boolean;
}

/**
 * A person or an agent posts INSIDE the app. Cannot make an outbound text or email: those are a
 * send, and a send is its own function (U4) so every customer message passes the same checks.
 *
 *   - People (owner, a login, the AI admin, a technician): the message is `posted` at once.
 *   - An agent key: `pending_approval`, or `draft` when it asks for draft. Never posted, never
 *     approved (team answer 3). The one exception is Claude Code in a Dev thread, which is `posted`
 *     as an internal message whatever the body says.
 */
export async function postMessage(reader: HubReader, input: PostMessageInput, db: PrismaClient = defaultPrisma): Promise<HubMessage> {
  return (await postMessageResult(reader, input, db)).message;
}

/** The message this author already made under this client id, or null. Scoped to the author: nobody else's id matches. */
async function messageForClientId(reader: HubReader, clientMessageId: string, db: PrismaClient): Promise<HubMessage | null> {
  return db.hubMessage.findFirst({ where: { authorKey: reader.key, clientMessageId } });
}

/**
 * postMessage, saying whether it made a message or found the one this author already made under the same
 * clientMessageId (a retry of a send whose answer was lost). The routes answer 201 for a new message and 200 for the
 * existing one. Same function, same writer: postMessage is this with the flag dropped.
 */
export async function postMessageResult(reader: HubReader, input: PostMessageInput, db: PrismaClient = defaultPrisma): Promise<PostMessageResult> {
  const clientMessageId = input.clientMessageId?.trim() || null;
  if (clientMessageId !== null && (clientMessageId.length < CLIENT_MESSAGE_ID_MIN || clientMessageId.length > CLIENT_MESSAGE_ID_MAX)) {
    throw new HubError("That message id is not valid.");
  }
  // A retry is answered BEFORE anything else is checked: its photos were taken by the first try, so checking them
  // again would refuse the very message that already went.
  if (clientMessageId !== null) {
    const existing = await messageForClientId(reader, clientMessageId, db);
    if (existing) {
      if (existing.threadId !== input.threadId) throw new HubError("That message id was already used in a different conversation.", 409);
      return { message: existing, replayed: true };
    }
  }
  const body = (input.body ?? "").trim();
  const photoIds = [...new Set(input.photoIds ?? [])];
  const attachmentIds = [...new Set(input.attachmentIds ?? [])];
  // A photo can be sent on its own; anything else needs words.
  if (!body && photoIds.length + attachmentIds.length === 0) throw new HubError("A message needs text");
  if (photoIds.length + attachmentIds.length > MAX_PHOTOS_PER_MESSAGE) {
    throw new HubError(`Send at most ${MAX_PHOTOS_PER_MESSAGE} photos in one message.`);
  }
  const thread = await findVisibleThread(reader, input.threadId, db);
  if (!thread) throw new HubError("Conversation not found", 404);
  if (photoIds.length > 0) {
    // A job photo is the JOB's (one photo store for job photos): it must already be filed on this job.
    if (thread.kind !== "job" || !thread.visitId) throw new HubError("A job photo can only go in that job's thread.");
    const onJob = await db.visitPhoto.count({ where: { id: { in: photoIds }, visitId: thread.visitId } });
    if (onJob !== photoIds.length) throw new HubError("A photo is not filed on this job.");
  }

  const refusal = await postRefusal(reader, thread, db);
  if (refusal) throw new HubError(refusal, 403);

  if (attachmentIds.length > 0) {
    // A photo goes only in the message of the person who ADDED it (the attachment_added audit row's actor, the
    // same test as "Remove"): on a Training or Team thread, someone else's staged photo is not yours to send.
    const mine = new Set(await stagedPhotoIds(reader, thread.id, db));
    const notMine = attachmentIds.filter((id) => !mine.has(id));
    if (notMine.length > 0) {
      const others = await db.hubAttachment.count({ where: { id: { in: notMine }, threadId: thread.id, messageId: null, deletedAt: null } });
      if (others > 0) throw new HubError("That photo was added by someone else, so it cannot go in your message.", 409);
      // Not in this thread, already on a message, or removed: the existing refusal below says so.
    }
  }

  let status: HubMessageStatus = "posted";
  if (reader.kind === "agent") {
    // A draft to a CUSTOMER is a send, with a channel and a send type; it comes through the draft door
    // (BA3), not through an in-app post. Nothing an agent posts here can reach a customer.
    if (thread.kind === "customer") throw new HubError("Customer drafts go through the draft door, not an in-app post.", 403);
    if (thread.kind === "dev" && reader.agentRole === "claude_code") {
      status = "posted";
    } else if (thread.kind === "training") {
      // Amendment 16b: every agent post in a training thread waits for approval - a "draft" is not an option there.
      // (Anything other than draft or pending_approval is still refused below the same way.)
      if (input.status !== undefined && input.status !== "pending_approval" && input.status !== "draft") {
        throw new HubError("An agent can only leave a draft or a message waiting for approval.", 403);
      }
      status = "pending_approval";
    } else if (input.status === undefined || input.status === "pending_approval") {
      status = "pending_approval";
    } else if (input.status === "draft") {
      status = "draft";
    } else {
      throw new HubError("An agent can only leave a draft or a message waiting for approval.", 403);
    }
  }

  let message: HubMessage;
  try {
    message = await db.$transaction(async (tx) => {
    const row = await createMessageRow(tx, {
      threadId: thread.id,
      authorType: authorTypeFor(reader),
      authorKey: reader.key,
      authorTechnicianId: reader.technicianId,
      authorBotKeyId: reader.agentKeyId,
      authorDisplay: reader.display,
      channel: "in_app",
      direction: "internal",
      status,
      body,
      subject: input.subject ?? null,
      photoIds,
      tags: input.tags ?? [],
      visitId: input.visitId ?? null,
      issuedEstimateId: input.issuedEstimateId ?? null,
      clientMessageId,
    });
    if (attachmentIds.length > 0) {
      // Take the photos uploaded to this thread: still unattached, not removed, in THIS thread only.
      const taken = await tx.hubAttachment.updateMany({
        where: { id: { in: attachmentIds }, threadId: thread.id, messageId: null, deletedAt: null },
        data: { messageId: row.id },
      });
      if (taken.count !== attachmentIds.length) throw new HubError("A photo was removed before the message was sent. Add it again.", 409);
    }
    await bumpThreadForMessage(tx, thread.id, row, { key: reader.key, display: reader.display });
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "message_created", entityType: "message",
      entityId: row.id, threadId: thread.id, messageId: row.id, afterText: row.body,
      details: { status: row.status, channel: row.channel },
    });
    return row;
    });
  } catch (err) {
    // Two sends of the same composed message at once: the unique key kept one. The loser gets the winner's row.
    if (clientMessageId !== null && isUniqueRace(err)) {
      const winner = await messageForClientId(reader, clientMessageId, db);
      if (winner) return { message: winner, replayed: true };
    }
    throw err;
  }
  fanOutMessage(message, thread, input.context ?? null);
  return { message, replayed: false };
}

/**
 * The ONE fan-out call site for a new message: the live-update event for open screens, the web push for
 * the people who should hear of it, and one signed webhook event - all fire-and-forget (none can fail or
 * slow the post). Nothing else emits for a message. Only a human's words and a customer's words wake an agent: an agent's own post, a draft
 * and a system line do not (that would have the agents answering each other).
 */
export function fanOutMessage(message: HubMessage, thread: HubThread, context: { kind: string; id: string } | null = null): void {
  if (message.deletedAt) return;
  // Every new message tells the open screens (ids only) and, when it is something a person should hear
  // about, their devices - whatever its status. A draft waiting for approval is exactly that.
  publishHubChange({ type: "message", threadId: thread.id, messageId: message.id });
  void notifyNewMessage(message, thread);
  if (message.status !== "posted" && message.status !== "received" && message.status !== "sent") return;
  // A person's words INSIDE the app. A message that went out to a customer (an edited-and-approved email or
  // text, direction outbound) is not a team message and wakes no agent.
  const byPerson = (message.authorType === "tech" || message.authorType === "office") && message.direction === "internal";
  let type: "message.inbound" | "message.team" | "message.dev" | null = null;
  if (message.authorType === "customer" && message.direction === "inbound") type = "message.inbound";
  else if (byPerson && thread.kind === "dev") type = "message.dev";
  else if (byPerson && (thread.kind === "team" || thread.kind === "job")) type = "message.team";
  else if (byPerson && thread.kind === "group") {
    // A group's agents are its members: the wake-up goes only if the routed agent is one of them (hubEvents.ts).
    void emitGroupMessageEventSafe({ messageId: message.id, threadId: thread.id, context });
    return;
  }
  if (!type) return;
  void emitHubEventSafe({ type, messageId: message.id, context });
}

/** An own message's text, edited in place. Only its author, only while it stands as posted; the old text is in the audit. */
export async function editOwnMessage(reader: HubReader, messageId: string, body: string, db: PrismaClient = defaultPrisma): Promise<HubMessage> {
  const text = (body ?? "").trim();
  if (!text) throw new HubError("A message needs text");
  const message = await db.hubMessage.findUnique({ where: { id: messageId } });
  if (!message || !(await findVisibleThread(reader, message.threadId, db))) throw new HubError("Message not found", 404);
  if (message.authorKey !== reader.key) throw new HubError("You can only edit your own message.", 403);
  if (message.deletedAt) throw new HubError("That message was deleted.", 409);
  if (message.status !== "posted" || message.channel !== "in_app") throw new HubError("Only a message posted in the app can be edited.", 409);
  const edited = await db.$transaction(async (tx) => {
    const updated = await tx.hubMessage.update({ where: { id: messageId }, data: { body: text, editedAt: new Date() } });
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "message_edited", entityType: "message",
      entityId: messageId, threadId: message.threadId, messageId, beforeText: message.body, afterText: text,
    });
    return updated;
  });
  publishHubChange({ type: "changed", threadId: message.threadId, messageId });
  return edited;
}

/**
 * The exit for a message: deleted by marking it (deletedAt, who, why), never by removing the row.
 * Its files go with it (a Team photo is held on its message). The text stays in the audit. The author
 * may delete their own; Kyle (the PIN session or his principal login) may delete any.
 */
export async function softDeleteMessage(reader: HubReader, messageId: string, reason: string | null, db: PrismaClient = defaultPrisma): Promise<HubMessage> {
  const message = await db.hubMessage.findUnique({ where: { id: messageId } });
  if (!message || !(await findVisibleThread(reader, message.threadId, db))) throw new HubError("Message not found", 404);
  if (message.deletedAt) return message;
  if (message.authorKey !== reader.key && !reader.isKyle) throw new HubError("You can only delete your own message.", 403);
  const now = new Date();
  const deleted = await db.$transaction(async (tx) => {
    const updated = await tx.hubMessage.update({
      where: { id: messageId },
      data: { deletedAt: now, deletedBy: reader.key, deletedReason: reason?.trim() || null },
    });
    await tx.hubAttachment.updateMany({ where: { messageId, deletedAt: null }, data: { deletedAt: now } });
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "message_deleted", entityType: "message",
      entityId: messageId, threadId: message.threadId, messageId, beforeText: message.body,
      details: reason?.trim() ? { reason: reason.trim() } : null,
    });
    return updated;
  });
  publishHubChange({ type: "changed", threadId: message.threadId, messageId });
  return deleted;
}

// ── read state ───────────────────────────────────────────────────────────────────────────────────

/** Mark a thread read for this reader, as of now. */
export async function markThreadRead(reader: HubReader, threadId: string, db: PrismaClient = defaultPrisma): Promise<void> {
  if (!(await findVisibleThread(reader, threadId, db))) throw new HubError("Conversation not found", 404);
  const now = new Date();
  await db.hubReadState.upsert({
    where: { readerKey_threadId: { readerKey: reader.key, threadId } },
    create: { readerKey: reader.key, threadId, lastReadAt: now },
    update: { lastReadAt: now },
  });
  // The same person's other screens (a phone and a desktop) move their badge and dots now, not at the next 10-minute reconnect.
  publishHubChange({ type: "changed", threadId, messageId: null });
}

/**
 * Unread messages per visible thread for this reader. A message is unread when it is readable
 * (received, posted or sent), not deleted, not the reader's own, and newer than the reader's
 * lastReadAt on that thread (every such message when they never opened it). Drafts and cards waiting
 * for approval are counted by the approval queue, not here. `only` limits the count to those threads
 * (still only the ones this reader may see). `openOnly` leaves closed threads out: the nav badge uses it,
 * because the Messages list hides closed threads and a badge must never count what the list does not show.
 */
export async function unreadCounts(
  reader: HubReader, db: PrismaClient = defaultPrisma, only?: readonly string[], opts: { openOnly?: boolean } = {},
): Promise<{ total: number; byThread: Record<string, number> }> {
  const and: Prisma.HubThreadWhereInput[] = [visibleThreadWhere(reader)];
  if (only) and.push({ id: { in: [...only] } });
  if (opts.openOnly) and.push({ status: { not: "closed" } });
  const visible = await db.hubThread.findMany({ where: { AND: and }, select: { id: true, kind: true } });
  let ids = visible.map((t) => t.id);
  if (reader.kind === "owner" || reader.kind === "user") {
    // The office SEES every group, but a group's messages are unread only for a member of it (C7): a group Kyle is not in
    // is not on his badge.
    const groups = visible.filter((t) => t.kind === "group").map((t) => t.id);
    if (groups.length > 0) {
      const mine = await memberGroupIds(reader, groups, db);
      ids = ids.filter((id) => !groups.includes(id) || mine.has(id));
    }
  }
  if (ids.length === 0) return { total: 0, byThread: {} };
  // A technician sees only what the crew said to each other: an in-app message, never a text or an email to
  // a customer that happens to sit in a job's conversation. The count must match what they can read.
  const crewOnly = reader.kind === "tech" ? Prisma.sql`AND m."channel" = 'in_app' AND m."direction" = 'internal'` : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ threadId: string; n: number }>>`
    SELECT m."threadId" AS "threadId", COUNT(*)::int AS n
    FROM "HubMessage" m
    LEFT JOIN "HubReadState" r ON r."threadId" = m."threadId" AND r."readerKey" = ${reader.key}
    WHERE m."threadId" = ANY(${ids}::text[])
      AND m."deletedAt" IS NULL
      AND m."status" = ANY(${[...HUB_READABLE_STATUSES]}::text[])
      AND (m."authorKey" IS NULL OR m."authorKey" <> ${reader.key})
      AND (r."lastReadAt" IS NULL OR COALESCE(m."sentAt", m."createdAt") > r."lastReadAt")
      ${crewOnly}
    GROUP BY m."threadId"`;
  const byThread: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    byThread[row.threadId] = row.n;
    total += row.n;
  }
  return { total, byThread };
}

// ── texts the CRM sends by itself, written into the conversation (U9) ────────────────────────────

/**
 * True when no OTHER text has gone out to this number: the first text to a number carries the STOP footer.
 * Only texts that actually went (status sent) count. A text still being claimed does NOT: it may yet fail,
 * be blocked or be lost to a restart, and a number that never received a text must still get the footer on
 * the one that does go. Two kinds of "sent" row do NOT count, because the number never got the footer from
 * them: a rehearsal row (a test account's text, settled sent with no provider id, nothing texted) and an
 * internal text (to Kyle, the operator number or a tech, which never wears the footer; a test account on
 * Kyle's own cell would otherwise hide the footer from that customer for good). The price is that two texts sent in the same instant to a brand-new number may
 * both carry it - an extra footer, never a missing one. The ONE definition: the hub's send function
 * (prepareSms, for the card's "Sends as:") and sendSms (for every text that actually goes) both ask it.
 * A text sent with no customer, lead or job to file it under is not in the hub, so a number texted only
 * that way reads as new and gets the footer again - the safe direction.
 */
export async function isFirstTextTo(db: Db, toPhone10: string, mine: { id: string | null }): Promise<boolean> {
  const earlier = await db.hubMessage.count({
    where: { ...(mine.id ? { id: { not: mine.id } } : {}), channel: "sms", direction: "outbound", toPhone10, deletedAt: null, status: "sent", providerMessageId: { not: null }, messageClass: { not: "internal" } },
  });
  return earlier === 0;
}

/**
 * Who a text went to, for the screen: "Kyle" for Kyle's own number, else "(615) ***-0101" (area code and last four
 * only). Null when the row has no number. The full number never goes in a view.
 */
export function maskedRecipient(toPhone10: string | null | undefined): string | null {
  if (!toPhone10 || toPhone10.length < 10) return null;
  if (isKylePhone(toPhone10)) return "Kyle";
  return `(${toPhone10.slice(0, 3)}) ***-${toPhone10.slice(-4)}`;
}

/** Who a text is about: the records it is filed under. Everything optional; none at all means "not logged". */
export interface SmsLogContext {
  customerId?: string | null;
  leadId?: string | null;
  visitId?: string | null;
  technicianId?: string | null;
}

/**
 * Where a text is filed (U9 routing): a technician with a visit is the JOB's crew thread; a customer or
 * lead is that customer's thread (a text TO KYLE about a customer is filed there too, because it carries
 * the customer's phone and address and must never sit in a Team or job thread); no context is not filed.
 * Null when there is nothing to file it under or the record is gone.
 */
export async function smsThreadFor(context: SmsLogContext | null | undefined, db: Db = defaultPrisma): Promise<HubThread | null> {
  if (!context) return null;
  try {
    if (context.technicianId && context.visitId) return await ensureThreadFor({ visitId: context.visitId }, db);
    if (context.customerId) return await ensureThreadFor({ customerId: context.customerId }, db);
    if (context.leadId) return await ensureThreadFor({ leadId: context.leadId }, db);
  } catch (err) {
    if (err instanceof HubError && err.status === 404) return null;
    throw err;
  }
  return null;
}

/**
 * A text TO KYLE is never filed in a job's crew thread, whoever wrote it: the crew can read that thread, and
 * the text carries a customer's phone and address. When the recipient is Kyle and the context names a
 * technician, the technician is dropped and the visit's customer (looked up when the caller did not name
 * one) is the conversation it is filed under. Every other recipient keeps the context as given.
 */
async function contextForRecipient(context: SmsLogContext | null | undefined, to: string, db: Db): Promise<SmsLogContext | null | undefined> {
  if (!context || !context.technicianId || !isKylePhone(to)) return context;
  const { technicianId: _dropped, ...rest } = context;
  if (rest.customerId || !rest.visitId) return rest;
  const visit = await db.visit.findUnique({ where: { id: rest.visitId }, select: { customerId: true } });
  return { ...rest, customerId: visit?.customerId ?? null };
}

export interface SystemSmsInput {
  context: SmsLogContext | null | undefined;
  /** The number it went (or would have gone) to, in any format. */
  to: string;
  messageClass: MessageClass;
  /** The send type: class and purposeKey are derived from it, never taken from the caller. */
  category: string;
  /** The words the caller wrote, without the header or the footer. */
  body: string;
  /** What actually went out (the composed text), for a sent text. */
  sentText?: string | null;
  footerIncluded?: boolean;
  headerAt?: Date | null;
  eventStart?: Date | null;
  eventEnd?: Date | null;
  providerMessageId?: string | null;
  /** sent: it went. blocked: the CRM refused it, and `blockReason` says why. */
  outcome: "sent" | "blocked";
  blockReason?: string;
}

/**
 * Write a text the CRM sent (or refused to send) on its own into the conversation it belongs to: an
 * outbound sms line by "System", status sent or blocked. Called by sendSms (services/twilio.ts) and nothing
 * else, and AWAITED there, so the next text to the same number sees this one (the first-text footer rule).
 * The row is made by createMessageRow (the one writer) and announced by fanOutMessage (the one fan-out
 * call site) AFTER it has committed. A refusal also writes the ONE send_blocked audit row, in the same
 * transaction; with no thread to file it under, the audit row is still written (a block is never silent).
 * Never throws: a failure to write it down must not turn a text that went into a failed one.
 */
export async function logSystemSms(input: SystemSmsInput, db: PrismaClient = defaultPrisma): Promise<HubMessage | null> {
  try {
    const entry = messageCategoryFor(input.category);
    const toPhone10 = last10(input.to);
    const thread = await smsThreadFor(await contextForRecipient(input.context, input.to, db), db);
    const blocked = input.outcome === "blocked";
    const auditDetails = {
      reason: input.blockReason ?? null, messageClass: entry?.messageClass ?? input.messageClass, category: input.category, purposeKey: entry?.purposeKey ?? null,
      channel: "sms", toLast4: toPhone10 ? toPhone10.slice(-4) : null,
      ids: {
        threadId: thread?.id ?? null, customerId: input.context?.customerId ?? null, leadId: input.context?.leadId ?? null,
        visitId: input.context?.visitId ?? null, technicianId: input.context?.technicianId ?? null,
      },
    };
    if (!thread || !entry) {
      if (blocked) {
        await hubAudit(db, {
          actorKey: SYSTEM_ACTOR.key, actorDisplay: SYSTEM_ACTOR.display, action: "send_blocked", entityType: "sms",
          afterText: input.blockReason ?? null, details: auditDetails,
        });
      }
      return null;
    }
    const row = await db.$transaction(async (tx) => {
      const made = await createMessageRow(tx, {
        threadId: thread.id,
        authorType: "system",
        authorKey: SYSTEM_ACTOR.key,
        authorDisplay: SYSTEM_ACTOR.display,
        channel: "sms",
        direction: "outbound",
        status: blocked ? "blocked" : "sent",
        body: input.body,
        toPhone: input.to,
        category: input.category,
        visitId: input.context?.visitId ?? null,
        providerMessageId: input.providerMessageId ?? null,
        error: blocked ? input.blockReason ?? null : null,
        sentText: blocked ? null : input.sentText ?? null,
        footerIncluded: blocked ? false : input.footerIncluded ?? false,
        headerAt: input.headerAt ?? null,
        eventStart: input.eventStart ?? null,
        eventEnd: input.eventEnd ?? null,
        sentAt: blocked ? null : new Date(),
      });
      if (blocked) {
        await hubAudit(tx, {
          actorKey: SYSTEM_ACTOR.key, actorDisplay: SYSTEM_ACTOR.display, action: "send_blocked", entityType: "message",
          entityId: made.id, threadId: thread.id, messageId: made.id, afterText: input.blockReason ?? null, details: auditDetails,
        });
      } else {
        await bumpThreadForMessage(tx, thread.id, made, SYSTEM_ACTOR);
      }
      return made;
    }, { maxWait: 10_000, timeout: 20_000 });
    fanOutMessage(row, thread); // the ONE fan-out call site, after the commit
    return row;
  } catch (err) {
    logHubFailure(`logging a ${input.outcome} text`, err);
    return null;
  }
}

/** A hub failure that must not break the caller (logged, never thrown). */
export function logHubFailure(what: string, err: unknown): void {
  logSystemEvent("error", "hub", `${what} failed: ${err instanceof Error ? err.message : String(err)}`);
}

export { isHubThreadKind };
export type { HubChannel, MessageClass };
