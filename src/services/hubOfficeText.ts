/**
 * An office person's text to a lead or customer, from the Conversation's "Text the customer" box (Kyle 2026-11-26: "Every lead and every
 * customer with a phone number gets a working text box in Conversation, whether or not they came from the website form or have been
 * converted to an account."). A person typing a text is a person approving it: the row is written as a person's Approve leaves it
 * (approved, decided by its author) and handed to hubSend, the ONE sender, so the text passes the same checks as every other text -
 * STOP is the only block on a lead or customer - and leaves the same audit trail.
 *
 * It is the person's counterpart of createDraftMessage (services/hubDrafts.ts), which is the door for AI agents and refuses a person. The
 * AI admin's own session uses createDraftMessage, never this.
 */
import type { HubMessage, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { HubError, createMessageRow, fanOutMessage, findVisibleThread, hubAudit, type HubReader } from "./hub";
import { hubSend, recipientFor } from "./hubSend";
import { notSentReasonFor } from "./hubAgentSend";
import { SEND_BLOCK_REASONS } from "../../shared/hub/sendBlocks";

/** The send type of a person's text: "Reply in a conversation" (shared/hub/messageCategories.ts), a transactional text about their own work. */
export const OFFICE_TEXT_CATEGORY = "thread_reply";

export interface OfficeTextInput {
  threadId: string;
  body: string;
  /** The job this text is about, when it was sent from a job. */
  visitId?: string | null;
  /** One id per composed text: a retry of a send whose answer was lost finds the text already made and sends nothing again. */
  clientMessageId?: string | null;
}

export interface OfficeTextResult {
  message: HubMessage;
  /** True when the provider accepted it. */
  sent: boolean;
  /** Why it did not go, in plain words; null when it went out. */
  notSentReason: string | null;
  /** True when this id had already made a text: nothing new was written or sent. */
  replayed: boolean;
}

export async function sendOfficeText(reader: HubReader, input: OfficeTextInput, db: PrismaClient = defaultPrisma): Promise<OfficeTextResult> {
  if (reader.kind !== "owner" && reader.kind !== "user") throw new HubError("Only an office login texts a customer from here.", 403);
  const body = (input.body ?? "").trim();
  if (!body) throw new HubError("A text needs words.");
  const thread = await findVisibleThread(reader, input.threadId, db);
  if (!thread) throw new HubError("Conversation not found", 404);
  const recipient = await recipientFor(thread, db);
  if (!recipient) throw new HubError("A text goes in a customer's or a job's conversation.", 400);
  if (!recipient.phone || recipient.phone.replace(/\D/g, "").length < 10) throw new HubError(SEND_BLOCK_REASONS.no_phone, 400);

  const clientMessageId = input.clientMessageId?.trim() || null;
  const replayOf = (existing: HubMessage): OfficeTextResult => ({
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
      const row = await createMessageRow(tx, {
        threadId: thread.id,
        authorType: "office",
        authorKey: reader.key,
        authorTechnicianId: reader.technicianId,
        authorDisplay: reader.display,
        channel: "sms",
        direction: "outbound",
        // Exactly what a person's Approve leaves: approved, decided by the person who wrote it.
        status: "approved",
        decidedBy: reader.key,
        decidedAt,
        body,
        category: OFFICE_TEXT_CATEGORY,
        toPhone: recipient.phone,
        visitId: input.visitId ?? null,
        clientMessageId,
      });
      // claimedAt marks the moment it was approved, so a send that never starts is found by releaseStaleSends.
      await tx.hubMessage.update({ where: { id: row.id }, data: { claimedAt: decidedAt } });
      await hubAudit(tx, {
        actorKey: reader.key, actorDisplay: reader.display, action: "message_created", entityType: "message", entityId: row.id,
        threadId: thread.id, messageId: row.id, afterText: row.body, details: { status: row.status, channel: row.channel, kind: "office_text" },
      });
      return row;
    });
  } catch (err) {
    // Two taps of Send with the same id at once: the unique key kept one. The loser gets the winner's row.
    if (clientMessageId !== null && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await db.hubMessage.findFirst({ where: { authorKey: reader.key, clientMessageId } });
      if (winner) return replayOf(winner);
    }
    throw err;
  }

  // hubSend settles whatever happens (sent, blocked, held while texting is off, failed) and announces a sent text itself.
  await hubSend(message.id, { key: reader.key, display: reader.display }, db);
  const fresh = (await db.hubMessage.findUnique({ where: { id: message.id } })) ?? message;
  // A text that did not go is announced here, once, so the open screens show it as not sent.
  if (fresh.status !== "sent" && fresh.status !== "posted") fanOutMessage(fresh, thread);
  return { message: fresh, sent: fresh.status === "sent", notSentReason: notSentReasonFor(fresh), replayed: false };
}
