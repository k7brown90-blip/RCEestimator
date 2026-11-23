/**
 * The three decisions on a draft (work order agent-team, U4 + TC1): Approve, Edit-and-approve and Reject.
 * The routes (routes/hub.ts) call these only after the approve_drafts gate (canApprove) has passed, so
 * nothing here re-checks who the person is; what it checks is the MESSAGE: that it is in a state that
 * can be decided, and that it is decided once.
 *
 * Every decision, without exception:
 *   * moves the message by a CONDITIONAL update (pending_approval -> ..., `updateMany where status`), so a
 *     double click or two approvers decide it once and the loser gets a 409;
 *   * writes one HubAuditLog row (message_approved / message_edit_approved / message_rejected) in the same
 *     transaction as the change;
 *   * tells the agents once, through emitHubEventSafe approval.decided (never the reject reason or the edited
 *     text: the agent reads those through get_draft_status).
 * Approve and Edit-and-approve then run the kind's `run` (hubActions/registry.ts), which for a customer
 * message is hubSend, so a send happens in exactly one function.
 *
 * An approved message that could not go yet has an exit here too (nothing is permanent): "Send now" retries
 * a failed or held message, and Reject cancels one.
 */
import type { HubMessage, HubThread, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma as defaultPrisma } from "../lib/prisma";
import { HubError, createMessageRow, findVisibleThread, hubAudit, type HubReader } from "./hub";
import { emitHubEventSafe } from "./hubEvents";
import { entryFor } from "./hubActions/registry";
import { SINGLE_ADDRESS, ccSchema, cleanCc } from "./emailCc";
import { approvalCardFor } from "./hubCards";
import { groupDraftBlock } from "./hubGroups";
import { prepareSms, releaseStaleSends, settleBlocked, type SendResult } from "./hubSend";
import { twilioSendEnabled } from "./automationGate";
import { logSystemEvent } from "./systemEvents";
import type { ApprovalCardView } from "../../shared/hub/views";
import type { HubMessageStatus } from "../../shared/hub/model";
import { SMS_DISABLED_ERROR, isEditFixableReason, sendBlockText } from "../../shared/hub/sendBlocks";

export interface DecisionResult {
  card: ApprovalCardView;
  /** What the send did (sent, held, blocked, failed); null when the decision sent nothing (a rejection). */
  send: SendResult | null;
}

/**
 * What the three decision routes accept, defined ONCE: the CRM's (routes/hub.ts) and the field's
 * (routes/hubTechRoutes.ts) both parse with these, so the two doors cannot disagree about a request.
 */
export const editApproveSchema = z.object({
  body: z.string().trim().min(1, "A message needs text.").max(10_000),
  subject: z.string().trim().max(200).optional(),
  to: z.string().trim().email("That is not a valid email address.").nullable().optional(),
  cc: ccSchema,
});
export const rejectSchema = z.object({ reason: z.string().trim().min(3, "Say why you are rejecting it (at least 3 characters).").max(500) });

/** What a decision answers: the card as it now stands and, when something was sent, what the send did. */
export const decisionView = (r: DecisionResult) => ({ card: r.card, send: r.send ? { status: r.send.status, error: r.send.error } : null });

const NOT_YET = "This kind of card is handled in a later step, so it cannot be approved here yet.";

const asActor = (reader: HubReader) => ({ key: reader.key, display: reader.display });

/** A held message: approved, but waiting because texting is switched off. */
const isHeld = (m: Pick<HubMessage, "status" | "error">): boolean => m.status === "approved" && m.error === SMS_DISABLED_ERROR;

async function loadDecidable(reader: HubReader, messageId: string, db: PrismaClient): Promise<{ message: HubMessage; thread: HubThread }> {
  // A send the server lost track of is settled first, so the state checks below see what is true now.
  await releaseStaleSends(db);
  const message = await db.hubMessage.findUnique({ where: { id: messageId } });
  const thread = message && !message.deletedAt ? await findVisibleThread(reader, message.threadId, db) : null;
  if (!message || !thread) throw new HubError("Message not found", 404);
  return { message, thread };
}

/**
 * A text is checked BEFORE anything is decided (the same prepareSms the card and hubSend use), so a text that
 * can never go out is never recorded as approved and the agents are never told it was:
 *   * a reason the words cause (the header or STOP line already in them) -> 409 and nothing changes, the draft
 *     stays waiting so it can be edited;
 *   * any other reason (marketing, no consent, opted out, review...) -> the message is blocked with its ONE
 *     send_blocked row and the agents hear "blocked".
 * Returns null when the text may proceed (or the message is not a text).
 */
async function refuseUnsendableText(
  reader: HubReader, message: HubMessage, thread: HubThread, kind: string, db: PrismaClient,
): Promise<SendResult | null> {
  if (message.channel !== "sms") return null;
  const prepared = await prepareSms(message, thread, db);
  if (prepared.ok) return null;
  if (isEditFixableReason(prepared.reason)) throw new HubError(sendBlockText(prepared.reason), 409);
  const blocked = await settleBlocked(db, message, thread, prepared.reason, asActor(reader), message.status as HubMessageStatus);
  if (!blocked) throw new HubError("Someone else already decided this draft.", 409);
  void emitHubEventSafe({ type: "approval.decided", messageId: message.id, status: "blocked", actionKind: kind, resultIds: {} });
  return blocked;
}

/**
 * Approve: a draft waiting for approval is approved and sent. "Send now" is the same call on a message
 * that failed or is held (texting was off): it was already decided, so it sends again without a second
 * decision (and without a second approval.decided).
 */
export async function approveMessage(reader: HubReader, messageId: string, db: PrismaClient = defaultPrisma): Promise<DecisionResult> {
  const { message, thread } = await loadDecidable(reader, messageId, db);
  const { kind, entry } = entryFor(message);
  if (!entry?.run) throw new HubError(NOT_YET, 409);
  const actor = asActor(reader);

  if (message.status === "pending_approval") {
    const groupBlock = await groupDraftBlock(thread, message, db);
    if (groupBlock) throw new HubError(groupBlock, 409);
    const refused = await refuseUnsendableText(reader, message, thread, kind, db);
    if (refused) return { card: await approvalCardFor(reader, messageId, db), send: refused };
    const decidedAt = new Date();
    const won = await db.$transaction(async (tx) => {
      const claim = await tx.hubMessage.updateMany({
        where: { id: messageId, status: "pending_approval", deletedAt: null },
        // claimedAt marks the moment it was approved, so a send that never starts is found by releaseStaleSends.
        data: { status: "approved", decidedBy: reader.key, decidedAt, claimedAt: decidedAt, error: null },
      });
      if (claim.count === 0) return false;
      await hubAudit(tx, {
        actorKey: reader.key, actorDisplay: reader.display, action: "message_approved", entityType: "message", entityId: messageId,
        threadId: message.threadId, messageId, beforeText: "pending_approval", afterText: "approved", details: { kind, channel: message.channel },
      });
      return true;
    });
    if (!won) throw new HubError("Someone else already decided this draft.", 409);
    void emitHubEventSafe({ type: "approval.decided", messageId, status: "approved", actionKind: kind, resultIds: {} });
  } else if (message.status === "failed" || isHeld(message)) {
    // Texting is still off: "Send now" would only hold it again and add two audit rows. Refuse it here too.
    if (isHeld(message) && message.channel === "sms" && !twilioSendEnabled("hubSms")) {
      throw new HubError("Texting is turned off, so this cannot be sent yet.", 409);
    }
    await hubAudit(db, {
      actorKey: reader.key, actorDisplay: reader.display, action: "message_retry", entityType: "message", entityId: messageId,
      threadId: message.threadId, messageId, beforeText: message.status, details: { kind, channel: message.channel },
    });
    if (message.status === "failed") {
      // sentAt is written the moment a provider accepts a message, so a failed row that has one DID go out.
      if (message.sentAt) throw new HubError("This message already went out, so it will not be sent again.", 409);
      const reset = await db.hubMessage.updateMany({
        where: { id: messageId, status: "failed", sentAt: null }, data: { status: "approved", error: null, claimedAt: new Date() },
      });
      if (reset.count === 0) throw new HubError("Someone else already sent this again.", 409);
    }
  } else {
    throw new HubError(`This message is ${message.status.replace(/_/g, " ")}, so it cannot be approved.`, 409);
  }

  const send = await runDecided(entry.run, messageId, actor, db);
  return { card: await approvalCardFor(reader, messageId, db), send };
}

/**
 * Run the kind's send. hubSend settles everything that goes wrong AFTER it claims the row; what can escape is
 * a failure before the claim (a database error). The row is then "approved" with nothing running, which has
 * no buttons, so it is moved to failed here (it then has "Try sending again" and Reject). A refusal (a 409
 * from hubSend: someone else already sent it) is passed through untouched.
 */
async function runDecided(
  run: (messageId: string, actor: { key: string; display: string }) => Promise<SendResult>,
  messageId: string, actor: { key: string; display: string }, db: PrismaClient,
): Promise<SendResult> {
  try {
    return await run(messageId, actor);
  } catch (err) {
    if (err instanceof HubError) throw err;
    const text = err instanceof Error ? err.message : String(err);
    logSystemEvent("error", "hub", `send of message ${messageId} failed before it started: ${text}`);
    const error = "The message could not be sent. See System events for why.";
    const moved = await db.hubMessage.updateMany({ where: { id: messageId, status: "approved", error: null }, data: { status: "failed", error, claimedAt: null } }).catch(() => null);
    if (!moved || moved.count === 0) throw err;
    await hubAudit(db, {
      actorKey: actor.key, actorDisplay: actor.display, action: "message_send_failed", entityType: "message", entityId: messageId,
      messageId, afterText: error, details: { before: "approved" },
    }).catch(() => undefined);
    return { messageId, status: "failed", error };
  }
}

export interface EditInput {
  body: string;
  /** Email only. */
  subject?: string | null;
  /** Email only: an address to send to instead of the one on file. */
  to?: string | null;
  /** Email only. */
  cc?: readonly string[];
}

/**
 * Edit and approve ("Send my version"): the original stays on the record (status edited) and a NEW
 * message carrying the edited words, linked back by editedFromId, is approved and sent. Built through the
 * one row-create function, which derives the class and purpose from the send type again.
 */
export async function editApproveMessage(reader: HubReader, messageId: string, edit: EditInput, db: PrismaClient = defaultPrisma): Promise<DecisionResult> {
  const { message: original, thread } = await loadDecidable(reader, messageId, db);
  const { kind, entry } = entryFor(original);
  if (!entry?.run) throw new HubError(NOT_YET, 409);
  if (original.status !== "pending_approval" && original.status !== "failed") {
    throw new HubError(`This message is ${original.status.replace(/_/g, " ")}, so it cannot be edited and sent.`, 409);
  }
  if (original.sentAt) throw new HubError("This message already went out, so it will not be sent again.", 409);
  const groupBlock = await groupDraftBlock(thread, original, db);
  if (groupBlock) throw new HubError(groupBlock, 409);
  const body = (edit.body ?? "").trim();
  if (!body) throw new HubError("A message needs text.", 400);
  if (body.length > 10_000) throw new HubError("Keep the message under 10,000 characters.", 400);

  let subject = original.subject;
  let toAddress = original.toAddress;
  let cc = original.cc;
  if (original.channel === "email") {
    subject = edit.subject !== undefined ? (edit.subject ?? "").trim() : original.subject;
    if (!subject) throw new HubError("An email needs a subject.", 400);
    if (subject.length > 200) throw new HubError("Keep the subject to 200 characters.", 400);
    if (edit.to !== undefined) {
      toAddress = edit.to ? edit.to.trim() : null;
      if (toAddress && !SINGLE_ADDRESS.test(toAddress)) throw new HubError("That is not a valid email address.", 400);
    }
    if (edit.cc !== undefined) {
      const cleaned = cleanCc(edit.cc, toAddress ?? "");
      if (!cleaned.ok) throw new HubError(cleaned.reason, 400);
      cc = cleaned.cc;
    }
  }

  // The edited words are checked before anything is decided, exactly as Approve checks the original's.
  if (original.channel === "sms") {
    const refused = await refuseUnsendableText(reader, { ...original, body }, thread, kind, db);
    if (refused) return { card: await approvalCardFor(reader, messageId, db), send: refused };
  }

  const decidedAt = new Date();
  const copy = await db.$transaction(async (tx) => {
    const claim = await tx.hubMessage.updateMany({
      where: { id: messageId, status: { in: ["pending_approval", "failed"] }, sentAt: null, deletedAt: null },
      data: { status: "edited", decidedBy: reader.key, decidedAt },
    });
    if (claim.count === 0) return null;
    const row = await createMessageRow(tx, {
      threadId: original.threadId,
      authorType: "office",
      authorKey: reader.key,
      authorTechnicianId: reader.technicianId,
      authorDisplay: reader.display,
      channel: original.channel,
      direction: original.direction,
      status: "approved",
      body,
      subject,
      toAddress,
      toPhone: original.toPhone10,
      cc,
      photoIds: original.photoIds,
      category: original.category,
      tags: original.tags,
      visitId: original.visitId,
      issuedEstimateId: original.issuedEstimateId,
      editedFromId: original.id,
      decidedBy: reader.key,
      decidedAt,
      actionKind: original.actionKind,
      actionPayloadJson: original.actionPayloadJson,
      eventStart: original.eventStart,
      eventEnd: original.eventEnd,
    });
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "message_edit_approved", entityType: "message", entityId: row.id,
      threadId: original.threadId, messageId: row.id, beforeText: original.body, afterText: row.body,
      details: { kind, channel: original.channel, editedFromId: original.id, subjectChanged: subject !== original.subject, toChanged: toAddress !== original.toAddress },
    });
    return row;
  });
  if (!copy) throw new HubError("Someone else already decided this draft.", 409);
  void emitHubEventSafe({ type: "approval.decided", messageId: original.id, status: "edited", actionKind: kind, resultIds: { message_id: copy.id } });

  const send = await runDecided(entry.run, copy.id, asActor(reader), db);
  return { card: await approvalCardFor(reader, copy.id, db), send };
}

/** Reject: the draft is not sent, and the reason is kept on it. A reason of at least three characters is required. */
export async function rejectMessage(reader: HubReader, messageId: string, reason: string, db: PrismaClient = defaultPrisma): Promise<DecisionResult> {
  const why = (reason ?? "").trim();
  if (why.length < 3) throw new HubError("Say why you are rejecting it (at least 3 characters).", 400);
  if (why.length > 500) throw new HubError("Keep the reason to 500 characters.", 400);
  const { message } = await loadDecidable(reader, messageId, db);
  const { kind } = entryFor(message);
  const rejectable = message.status === "pending_approval" || message.status === "failed" || isHeld(message);
  if (!rejectable) throw new HubError(`This message is ${message.status.replace(/_/g, " ")}, so it cannot be rejected.`, 409);

  const decidedAt = new Date();
  const won = await db.$transaction(async (tx) => {
    const claim = await tx.hubMessage.updateMany({
      where: { id: messageId, deletedAt: null, OR: [{ status: { in: ["pending_approval", "failed"] } }, { status: "approved", error: SMS_DISABLED_ERROR }] },
      data: { status: "rejected", rejectedReason: why, decidedBy: reader.key, decidedAt, error: null, heldReason: null, claimedAt: null },
    });
    if (claim.count === 0) return false;
    await hubAudit(tx, {
      actorKey: reader.key, actorDisplay: reader.display, action: "message_rejected", entityType: "message", entityId: messageId,
      threadId: message.threadId, messageId, beforeText: message.status, afterText: why, details: { kind, channel: message.channel },
    });
    return true;
  });
  if (!won) throw new HubError("Someone else already decided this draft.", 409);
  void emitHubEventSafe({ type: "approval.decided", messageId, status: "rejected", actionKind: kind, resultIds: {} });
  return { card: await approvalCardFor(reader, messageId, db), send: null };
}
