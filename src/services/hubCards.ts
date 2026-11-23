/**
 * The approval cards' reads (work order agent-team, U4 + TC1/TC3): the drafts waiting for a decision and
 * the ones already decided, shaped for the ONE card component. Read-only. Every read goes through
 * visibleThreadWhere, so a reader sees only the cards in threads the hub lets them see.
 *
 * A "card" is any message that went through approval: a draft waiting (pending_approval), one going out
 * (approving), one held because texting is off (approved), one that could not go (failed, blocked), and
 * the decided ones (rejected, edited, sent or posted after a decision). Nothing here writes; the three
 * decisions are services/hubApproval.ts.
 *
 * What a card says about itself comes from the registry (hubActions/registry.ts describe()), computed
 * from the database and the frozen class/purpose columns, never from an agent's words.
 */
import type { HubMessage, HubThread, EmailDelivery, PrismaClient, Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { findVisibleThread, visibleThreadWhere, HubError, type HubReader } from "./hub";
import { prepareSms, recipientFor, releaseStaleSends, type Recipient, type SmsPrepared } from "./hubSend";
import { entryFor } from "./hubActions/registry";
import { emailOf } from "./hubTimeline";
import { groupDraftBlock } from "./hubGroups";
import { REHEARSAL_RESULT_LINE } from "./rehearsal";
import { CARD_KINDS, isCardKind } from "../../shared/hub/cards";
import { SMS_DISABLED_ERROR, sendBlockText } from "../../shared/hub/sendBlocks";
import { CRM_POWERS } from "../../shared/crmPowers";
import type { ApprovalCardView, ApprovalsResponse } from "../../shared/hub/views";
import type { HubMessageStatus } from "../../shared/hub/model";

/** The statuses of a draft that is waiting, in flight, stuck or refused: the card stays visible and carries its reason. */
export const CARD_OPEN_STATUSES = ["pending_approval", "approving", "approved", "failed", "blocked"] as const;
/** The statuses a decision leaves behind: the card stays as the record of what was decided. */
export const CARD_DECIDED_STATUSES = ["rejected", "edited", "superseded"] as const;

const AI_AUTHORS = new Set(["ai_agent", "claude"]);
export const APPROVAL_LIST_LIMIT = 100;
const RECENT_ABOVE = 5;

type CardRow = HubMessage & { thread: HubThread; emailDelivery: EmailDelivery | null };

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** "Jane Smith" -> "Jane", the way a header line names a customer without a surname. */
const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

async function decidedByNames(db: PrismaClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db.hubAuditLog.findMany({
    where: { messageId: { in: ids }, action: { in: ["message_approved", "message_edit_approved", "message_rejected", "message_auto_approved"] } },
    orderBy: { at: "asc" },
    select: { messageId: true, actorDisplay: true },
  });
  for (const r of rows) if (r.messageId) out.set(r.messageId, r.actorDisplay);
  // An edited original has no approval row of its own: the decision is filed under its COPY's id. Name the
  // person on the original's card from the copy's row, so it never reads "Edited by someone".
  const originals = await db.hubMessage.findMany({ where: { id: { in: ids }, status: "edited" }, select: { id: true } });
  if (originals.length > 0) {
    const copies = await db.hubMessage.findMany({
      where: { editedFromId: { in: originals.map((o) => o.id) } }, select: { id: true, editedFromId: true }, orderBy: { createdAt: "asc" },
    });
    const copyRows = copies.length === 0 ? [] : await db.hubAuditLog.findMany({
      where: { messageId: { in: copies.map((c) => c.id) }, action: "message_edit_approved" }, orderBy: { at: "asc" }, select: { messageId: true, actorDisplay: true },
    });
    const byCopy = new Map(copyRows.map((r) => [r.messageId, r.actorDisplay]));
    for (const c of copies) {
      const name = byCopy.get(c.id);
      if (c.editedFromId && name && !out.has(c.editedFromId)) out.set(c.editedFromId, name);
    }
  }
  return out;
}

async function recentAbove(db: PrismaClient, m: CardRow) {
  const rows = await db.hubMessage.findMany({
    where: {
      threadId: m.threadId, deletedAt: null, id: { not: m.id }, createdAt: { lt: m.createdAt },
      status: { in: ["received", "posted", "sent"] },
    },
    orderBy: { createdAt: "desc" },
    take: RECENT_ABOVE,
    select: { authorType: true, authorDisplay: true, body: true, createdAt: true },
  });
  return rows.reverse().map((r) => ({
    authorType: r.authorType, authorDisplay: r.authorDisplay,
    text: r.body.length > 240 ? `${r.body.slice(0, 240)}…` : r.body, at: r.createdAt.toISOString(),
  }));
}

function outcomeText(m: CardRow, decidedBy: string | null, testAccount = false): string | null {
  const status = m.status as HubMessageStatus;
  const who = decidedBy ?? "someone";
  switch (status) {
    // A message approved on the office's test account settles as sent with no provider id and no delivery row:
    // nothing left the building (TC10), and the card says so rather than "Sent by Kyle".
    case "sent": return testAccount && (m.channel === "email" || m.channel === "sms") && !m.providerMessageId && !m.emailDeliveryId
      ? REHEARSAL_RESULT_LINE
      : `Sent by ${who}`;
    case "posted": return `Posted by ${who}`;
    case "rejected": return `Rejected: ${m.rejectedReason ?? "no reason given"}`;
    case "edited": return `Edited by ${who} before sending`;
    case "superseded": return "Replaced by a newer message";
    case "blocked": return `Not sent: ${sendBlockText(m.error)}`;
    case "failed": return `Could not be sent: ${m.error ?? "unknown reason"}`;
    case "approving": return "Sending…";
    case "approved": return m.error === SMS_DISABLED_ERROR ? "Approved — SMS disabled" : `Approved by ${who}`;
    default: return null;
  }
}

async function viewOf(db: PrismaClient, m: CardRow, who: Map<string, string>): Promise<ApprovalCardView> {
  const { kind, entry } = entryFor(m);
  const recipient: Recipient | null = await recipientFor(m.thread, db);
  // A text that still has a decision or a retry ahead of it is checked now, with the very function the send runs.
  const sms: SmsPrepared | null = m.channel === "sms" && entry?.run && ["pending_approval", "approved", "failed"].includes(m.status)
    ? await prepareSms(m, m.thread, db)
    : null;
  const described = entry?.describe({ message: m, thread: m.thread, recipient, sms });
  const decidedBy = who.get(m.id) ?? (m.decidedBy?.startsWith("rule:") ? "an auto-send rule" : null);
  const ai = AI_AUTHORS.has(m.authorType);
  // A draft waiting in a group that has since been closed, or whose agent has left it, cannot be approved: say why on the card.
  const groupBlock = m.status === "pending_approval" ? await groupDraftBlock(m.thread, m, db) : null;
  return {
    id: m.id,
    threadId: m.threadId,
    threadTitle: m.thread.title,
    threadKind: m.thread.kind,
    customerId: m.thread.customerId,
    kind,
    kindLabel: isCardKind(kind) ? CARD_KINDS[kind].label : kind,
    status: m.status as HubMessageStatus,
    channel: m.channel,
    draftedBy: ai && !/\(AI\)\s*$/.test(m.authorDisplay) ? `${m.authorDisplay} (AI)` : m.authorDisplay,
    draftedByAi: ai,
    createdAt: m.createdAt.toISOString(),
    headerLine: described?.headerLine ?? kind,
    recipient: m.channel === "in_app" ? null : recipient ? firstName(recipient.name) : null,
    recipientAddress: m.channel === "email" ? m.toAddress?.trim() || recipient?.email || null : null,
    subject: m.subject,
    body: m.body,
    cc: m.cc,
    // The "Sends as:" preview: the words composeSms made in prepareSms, the very call the send makes.
    sendsAs: sms && sms.ok ? sms.sentText : m.sentText,
    recent: await recentAbove(db, m),
    effectLines: described?.effectLines ?? [],
    chip: described?.chip ?? { tone: "internal", text: "Internal only — never reaches a customer" },
    approve: {
      label: described?.approveLabel ?? "Approve",
      confirm: described?.confirm ?? "Approve this?",
      blockedReason: groupBlock ?? (described ? described.blockedReason : "This kind of card is not handled by this version."),
      editBlockedReason: groupBlock ?? (described ? described.editBlockedReason : "This kind of card is not handled by this version."),
    },
    editable: described?.editable ?? { subject: false, to: false, cc: false },
    outcome: {
      text: outcomeText(m, decidedBy, recipient?.testAccount === true),
      error: m.error && m.status !== "blocked" && m.error !== SMS_DISABLED_ERROR ? m.error : null,
      decidedBy,
      decidedAt: iso(m.decidedAt),
      rejectedReason: m.rejectedReason,
      sentAt: iso(m.sentAt),
      emailDelivery: m.emailDelivery ? emailOf(m.emailDelivery) : null,
    },
  };
}

export interface ApprovalFilter {
  /** "pending": only what is waiting for a decision. "all": every card, decided or not. */
  status?: "pending" | "all";
  threadId?: string;
  messageId?: string;
  /** Leave out cards of these kinds (the field app's list leaves out the CRM-only ones). A plain draft has no kind stored and is never left out. */
  excludeKinds?: readonly string[];
}

const INCLUDE = { thread: true, emailDelivery: true } as const;

export async function listApprovalCards(
  reader: HubReader, filter: ApprovalFilter, canApprove: boolean, db: PrismaClient = defaultPrisma,
): Promise<ApprovalsResponse> {
  const pendingOnly = (filter.status ?? "pending") === "pending";
  // A send the server lost track of (a restart mid-send) becomes a failed card with its exits, before it is read.
  await releaseStaleSends(db);
  const base: Prisma.HubMessageWhereInput[] = [{
    deletedAt: null,
    // A text the CRM sent or refused by itself (author "system", services/hub.ts logSystemSms) never went through approval:
    // it is a line in the conversation, not a draft, so it is never a card.
    authorType: { not: "system" },
    thread: visibleThreadWhere(reader),
  }];
  if (filter.threadId) base.push({ threadId: filter.threadId });
  if (filter.messageId) base.push({ id: filter.messageId });
  if (filter.excludeKinds && filter.excludeKinds.length > 0) {
    // NOT IN drops rows whose actionKind is null, and a plain draft has none: keep those explicitly.
    base.push({ OR: [{ actionKind: null }, { actionKind: { notIn: [...filter.excludeKinds] } }] });
  }
  const where = (status: Prisma.HubMessageWhereInput): Prisma.HubMessageWhereInput => ({ AND: [...base, status] });

  // Oldest first for the queue (first drafted, first reviewed); a conversation's cards read as a history.
  // The OPEN cards (the ones with buttons) are never capped, so a long conversation's newest draft is always
  // there; the decided history fills what is left of the window with the NEWEST rows.
  const rows: CardRow[] = pendingOnly
    ? await db.hubMessage.findMany({ where: where({ status: "pending_approval" }), orderBy: { createdAt: "asc" }, take: APPROVAL_LIST_LIMIT, include: INCLUDE })
    : [
      ...(await db.hubMessage.findMany({ where: where({ status: { in: [...CARD_OPEN_STATUSES] } }), orderBy: { createdAt: "asc" }, include: INCLUDE })),
      ...(await db.hubMessage.findMany({
        where: where({ OR: [{ status: { in: [...CARD_DECIDED_STATUSES] } }, { status: { in: ["sent", "posted"] }, decidedAt: { not: null } }] }),
        orderBy: { createdAt: "desc" }, take: APPROVAL_LIST_LIMIT, include: INCLUDE,
      })),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const who = await decidedByNames(db, rows.map((r) => r.id));
  const cards: ApprovalCardView[] = [];
  for (const row of rows) cards.push(await viewOf(db, row, who));
  return { cards, canApprove, approveReason: canApprove ? null : CRM_POWERS.approve_drafts.reason };
}

/** One card, only if this reader may see its thread. */
export async function approvalCardFor(reader: HubReader, messageId: string, db: PrismaClient = defaultPrisma): Promise<ApprovalCardView> {
  const row = await db.hubMessage.findUnique({ where: { id: messageId }, include: INCLUDE });
  if (!row || row.deletedAt || row.authorType === "system" || !(await findVisibleThread(reader, row.threadId, db))) throw new HubError("Message not found", 404);
  const who = await decidedByNames(db, [row.id]);
  return viewOf(db, row, who);
}
