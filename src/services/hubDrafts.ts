/**
 * The hub's draft-create path (work order agent-team, U4/BA8): where an AI agent's draft of an email or
 * a text to a customer becomes a HubMessage waiting for a person. It writes the row through the one
 * row-create function (createMessageRow, which derives messageClass and purposeKey from the send type and
 * ignores any a caller passes), audits it, and then offers it to the auto-send rule - which approves it
 * only when Kyle has switched that category ON and every condition in services/hubAutoSend.ts holds.
 *
 * Nothing sends from here directly, and no person's message passes through it (a person's reply is the
 * "Email the customer" panel or a call note). The agent doors that will call it - the REST draft door
 * (K-U7) and the draft_customer_message tool (TM9) - come in later batches; they must call this and never
 * write a customer-facing HubMessage themselves.
 */
import type { HubMessage, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { HubError, createMessageRow, fanOutMessage, findVisibleThread, hubAudit, type HubReader } from "./hub";
import { recipientFor } from "./hubSend";
import { maybeAutoApprove } from "./hubAutoSend";

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
  /** "draft" keeps it out of the approval queue until someone moves it on; the default is waiting for approval. */
  status?: "draft" | "pending_approval";
}

export interface DraftResult {
  message: HubMessage;
  /** Set when the auto-send rule approved it and it went out. */
  autoApproved: boolean;
  /** Why it was NOT auto-approved (present whenever it was offered to the rule and refused). */
  autoSendNote: string | null;
}

export async function createDraftMessage(reader: HubReader, input: DraftInput, db: PrismaClient = defaultPrisma): Promise<DraftResult> {
  if (reader.kind !== "agent" && reader.kind !== "ai-admin") throw new HubError("Only an AI agent drafts a message to a customer.", 403);
  const body = (input.body ?? "").trim();
  if (!body) throw new HubError("A message needs text");
  const thread = await findVisibleThread(reader, input.threadId, db);
  if (!thread) throw new HubError("Conversation not found", 404);
  if (!(await recipientFor(thread, db))) throw new HubError("A draft to a customer must be in a customer's or a job's conversation.", 400);
  const status = input.status ?? "pending_approval";
  // The type says draft or pending_approval, but a door that parsed a request body could pass anything:
  // an agent can never create a message that is already approved or sent.
  if (status !== "draft" && status !== "pending_approval") throw new HubError("An agent can only leave a draft or a message waiting for approval.", 403);

  const message = await db.$transaction(async (tx) => {
    const row = await createMessageRow(tx, {
      threadId: thread.id,
      authorType: reader.kind === "agent" && reader.agentRole === "claude_code" ? "claude" : "ai_agent",
      authorKey: reader.key,
      authorBotKeyId: reader.agentKeyId,
      authorDisplay: reader.display,
      channel: input.channel,
      direction: "outbound",
      status,
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
    });
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "message_created", entityType: "message", entityId: row.id,
      threadId: thread.id, messageId: row.id, afterText: row.body, details: { status: row.status, channel: row.channel, kind: "customer_message" },
    });
    return row;
  });

  // The ONE fan-out call site: the open screens and the approvers' devices hear that a draft is waiting.
  // A draft that is offered to the auto-send rule is announced AFTER the rule has decided, using the row as it
  // stands: one that auto-sent is no longer waiting and must not wake every approver with "needs approval".
  if (status !== "pending_approval") {
    fanOutMessage(message, thread);
    return { message, autoApproved: false, autoSendNote: null };
  }
  let offered: Awaited<ReturnType<typeof maybeAutoApprove>>;
  let fresh: HubMessage = message;
  try {
    offered = await maybeAutoApprove(message.id, db);
  } finally {
    fresh = (await db.hubMessage.findUnique({ where: { id: message.id } })) ?? message;
    fanOutMessage(fresh, thread);
  }
  return offered.autoApproved
    ? { message: fresh, autoApproved: true, autoSendNote: null }
    : { message: fresh, autoApproved: false, autoSendNote: offered.why };
}
