/**
 * The hub's customer-message door for AI agents (work order agent-team U4/BA8; changed by Kyle 2026-11-24, batch PB-3): where an AI
 * agent's email or text to a customer becomes a HubMessage AND GOES OUT. Kyle: "We are submitting direct requests to these agents which
 * implies approval to all that they are reqested to do in the CRM ... The messages are going to be automated too, no check in."
 * It writes the row through the one row-create function (createMessageRow, which derives messageClass and purposeKey from the send type and
 * ignores any a caller passes) in the state a person's Approve leaves it in (approved, decided by the author itself), audits it, and hands it to
 * sendAgentMessageNow (services/hubAgentSend.ts), which runs the guards and then the ONE sender, hubSend. A message the agent asks to keep as a
 * "draft" is written as a draft and goes nowhere.
 *
 * No person's message passes through it (a person's reply is the "Email the customer" panel or a call note). The agent doors that call it - the REST
 * door (POST /hub/messages, src/agentApi/hubDoor.ts) and the post_message tool - and the AI admin's "Email" panel (routes/communications.ts) must call
 * this and never write a customer-facing HubMessage themselves.
 */
import { Prisma, type HubMessage, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { HubError, createMessageRow, fanOutMessage, findVisibleThread, hubAudit, type HubReader } from "./hub";
import { recipientFor } from "./hubSend";
import { notSentReasonFor, sendAgentMessageNow } from "./hubAgentSend";
import { AGENT_DAILY_DRAFT_LIMIT, chicagoDayStart } from "../agentApi/audit";

export interface DraftInput {
  threadId: string;
  channel: "email" | "sms";
  body: string;
  subject?: string | null;
  toAddress?: string | null;
  toPhone?: string | null;
  cc?: readonly string[];
  /** The send type (shared/hub/messageCategories.ts). Required for a text. */
  category?: string | null;
  tags?: readonly string[];
  visitId?: string | null;
  issuedEstimateId?: string | null;
  eventStart?: Date | null;
  eventEnd?: Date | null;
  /** "draft" keeps it as a draft that goes nowhere until someone moves it on; the default, "send", sends it now (Kyle 2026-11-24: no check-ins). */
  status?: "draft" | "send";
  /**
   * One id per composed draft (the agent door derives it from the idempotency key): a repeat finds the message this author already
   * made under it and returns that one, writing and sending nothing. This is what keeps a retry after a crash from sending twice,
   * because the row is written in its own transaction BEFORE the send starts.
   */
  clientMessageId?: string | null;
}

export interface DraftResult {
  message: HubMessage;
  /** True when the provider accepted it: the message went out. */
  sent: boolean;
  /** Why it did not go (a guard refused it, the send failed, or it was kept as a draft); null when it went out. */
  notSentReason: string | null;
  /** True when the message already existed under this clientMessageId: nothing new was written or sent. */
  replayed?: boolean;
}

export async function createDraftMessage(reader: HubReader, input: DraftInput, db: PrismaClient = defaultPrisma): Promise<DraftResult> {
  if (reader.kind !== "agent" && reader.kind !== "ai-admin") throw new HubError("Only an AI agent sends a message to a customer from here.", 403);
  const body = (input.body ?? "").trim();
  if (!body) throw new HubError("A message needs text");
  const thread = await findVisibleThread(reader, input.threadId, db);
  if (!thread) throw new HubError("Conversation not found", 404);
  if (!(await recipientFor(thread, db))) throw new HubError("A message to a customer must be in a customer's or a job's conversation.", 400);
  const wanted = input.status ?? "send";
  // The type says draft or send, but a door that parsed a request body could pass anything: an agent can never write a message in any other state.
  if (wanted !== "draft" && wanted !== "send") throw new HubError("An agent can only send a message or leave a draft.", 403);

  const clientMessageId = input.clientMessageId?.trim() || null;
  const replayOf = (existing: HubMessage): DraftResult => ({
    message: existing, sent: existing.status === "sent", notSentReason: notSentReasonFor(existing), replayed: true,
  });
  if (clientMessageId !== null) {
    const existing = await db.hubMessage.findFirst({ where: { authorKey: reader.key, clientMessageId } });
    if (existing) {
      if (existing.threadId !== thread.id) throw new HubError("That message id was already used in a different conversation.", 409);
      return replayOf(existing);
    }
  }

  const decidedAt = new Date();
  let message: HubMessage;
  try {
    message = await db.$transaction(async (tx) => {
    // The AI admin session has no key, so the door's 500-a-day cap never sees it: it holds the same cap here (Kyle 2026-11-24, no check-ins
    // means the cap is the one brake left). The lock makes the count and the insert one step, so parallel sends cannot overshoot.
    if (wanted === "send" && reader.kind === "ai-admin") {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ai-admin:daily-sends'))`;
      const today = await tx.hubMessage.count({
        where: { authorKey: reader.key, direction: "outbound", channel: { in: ["email", "sms"] }, status: { not: "draft" }, createdAt: { gte: chicagoDayStart() } },
      });
      if (today >= AGENT_DAILY_DRAFT_LIMIT) throw new HubError(`The AI admin has sent its ${AGENT_DAILY_DRAFT_LIMIT} messages for today; try again tomorrow.`, 429);
    }
    const row = await createMessageRow(tx, {
      threadId: thread.id,
      authorType: reader.kind === "agent" && reader.agentRole === "claude_code" ? "claude" : "ai_agent",
      authorKey: reader.key,
      authorBotKeyId: reader.agentKeyId,
      authorDisplay: reader.display,
      channel: input.channel,
      direction: "outbound",
      // A message to be sent is written exactly as a person's Approve leaves it: approved, decided by its author (the agent was asked to do it).
      status: wanted === "draft" ? "draft" : "approved",
      decidedBy: wanted === "draft" ? null : reader.key,
      decidedAt: wanted === "draft" ? null : decidedAt,
      body,
      subject: input.subject ?? null,
      toAddress: input.toAddress ?? null,
      toPhone: input.toPhone ?? null,
      cc: input.cc ?? [],
      category: input.category ?? null,
      tags: input.tags ?? [],
      visitId: input.visitId ?? null,
      issuedEstimateId: input.issuedEstimateId ?? null,
      eventStart: input.eventStart ?? null,
      eventEnd: input.eventEnd ?? null,
      clientMessageId,
    });
    if (wanted === "send") await tx.hubMessage.update({ where: { id: row.id }, data: { claimedAt: decidedAt } });
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "message_created", entityType: "message", entityId: row.id,
      threadId: thread.id, messageId: row.id, afterText: row.body, details: { status: row.status, channel: row.channel, kind: "customer_message" },
    });
    // The trail says in so many words that nobody approved this one: the agent's own request is the approval (Kyle 2026-11-24).
    if (wanted === "send") {
      await hubAudit(tx, {
        actorKey: reader.key, actorDisplay: reader.display, action: "message_sent_directly", entityType: "message", entityId: row.id,
        threadId: thread.id, messageId: row.id, afterText: `sent by ${reader.display} (AI) without an approval step`,
        details: { channel: row.channel, category: row.category, ...(reader.agentKeyId ? { keyId: reader.agentKeyId, keyName: reader.display } : { session: reader.key }) },
      });
    }
    return row;
    });
  } catch (err) {
    // Two calls with the same id at once: the unique key kept one. The loser gets the winner's row.
    if (clientMessageId !== null && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await db.hubMessage.findFirst({ where: { authorKey: reader.key, clientMessageId } });
      if (winner) return replayOf(winner);
    }
    throw err;
  }

  // The ONE fan-out call site: the open screens hear that a draft exists. A message that is being sent is announced by the send itself
  // (hubSend settles it and fans out), or, when a guard refuses it, by sendAgentMessageNow once the row says "not sent".
  if (wanted === "draft") {
    fanOutMessage(message, thread);
    return { message, sent: false, notSentReason: notSentReasonFor(message) };
  }
  const outcome = await sendAgentMessageNow(message.id, db);
  return { message: outcome.message, sent: outcome.sent, notSentReason: outcome.notSentReason };
}
