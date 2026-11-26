/**
 * A customer message from an AI agent that is WAITING FOR APPROVAL - the state every agent email and text used to be left in.
 *
 * Kyle 2026-11-24 ("requiring them to check-in on everything defeats the purpose of the chat"): an agent's customer message is now SENT when
 * it is posted (services/hubDrafts.ts createDraftMessage), so no live code path makes one of these any more. Cards written BEFORE that
 * deploy are still sitting in Messages -> Waiting for approval and must stay decidable exactly as before ("do not auto-send old drafts"), and the
 * approval machinery (Approve, Edit and send, Reject, Try sending again, the held and blocked states, the reminders, the pushes) still has to
 * be tested. This helper writes such a legacy card: the row the old draft door wrote (createMessageRow, the ONE row-create function, so the
 * class and purpose are derived from the send type exactly as in production), its audit row, and the one fan-out. It is TEST-ONLY: nothing
 * under src/ may import it, and nothing in src/ can produce this state.
 */
import type { HubMessage, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../../src/lib/prisma";
import { createMessageRow, fanOutMessage, findVisibleThread, hubAudit, type HubReader } from "../../src/services/hub";
import type { DraftInput } from "../../src/services/hubDrafts";

export async function waitingDraft(
  reader: HubReader, input: Omit<DraftInput, "status">, db: PrismaClient = defaultPrisma,
): Promise<{ message: HubMessage }> {
  const thread = await findVisibleThread(reader, input.threadId, db);
  if (!thread) throw new Error(`waitingDraft: no visible thread ${input.threadId}`);
  const message = await db.$transaction(async (tx) => {
    const row = await createMessageRow(tx, {
      threadId: thread.id,
      authorType: reader.kind === "agent" && reader.agentRole === "claude_code" ? "claude" : "ai_agent",
      authorKey: reader.key,
      authorBotKeyId: reader.agentKeyId,
      authorDisplay: reader.display,
      channel: input.channel,
      direction: "outbound",
      status: "pending_approval",
      body: input.body.trim(),
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
      clientMessageId: input.clientMessageId?.trim() || null,
    });
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "message_created", entityType: "message", entityId: row.id,
      threadId: thread.id, messageId: row.id, afterText: row.body, details: { status: row.status, channel: row.channel, kind: "customer_message" },
    });
    return row;
  });
  fanOutMessage(message, thread);
  return { message };
}
