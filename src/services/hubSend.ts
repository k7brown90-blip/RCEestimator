/**
 * hubSend: the ONE function that sends an approved message from the Messages hub to a customer (work
 * order agent-team, U4 + BA7). Every customer-facing message the hub holds - an AI draft a person
 * approved, a person's edited version, a message an auto-send rule approved - goes out through here and
 * nowhere else, so every one passes the same checks and leaves the same audit trail.
 *
 * It takes an APPROVED HubMessage only (a draft, a message waiting for approval, a rejected one is
 * refused) and dispatches by channel:
 *
 *   in_app  marked posted (a drafted reply in a job, Team, Dev or Training thread).
 *   email   services/recordEmail.ts sendRecordMessage - the very function behind "Email the customer" - so
 *           the same pipe, ONE EmailDelivery row (linked to the message), the same recipient and CC rule.
 *   sms     the class guard, then the consent gate, then the SMS leg. The leg is the new TwilioSendLeg
 *           `hubSms` (env HUB_SMS_OUTBOUND_ENABLED). While it is off an approved text is HELD as approved
 *           with the error "SMS disabled" and nothing is sent to Twilio. The class guard runs BEFORE that
 *           hold, so a text that can never go out is refused at Approve (with a send_blocked audit row), not
 *           parked until the switch is turned on and refused then:
 *             1. a message with no class is refused;
 *             2. marketing is ALWAYS refused in this build ("No marketing text opt-in on record"), with one
 *                send_blocked row and the reason on the card - never held, so it cannot release later;
 *             3. transactional keeps the consent gate (services/twilio.ts smsConsentFor, the same question
 *                sendSms asks);
 *             4. the consent gate is bypassed ONLY for a transactional thread_reply within 36 hours of the
 *                customer's last inbound text (a number with no Lead or Customer is treated as never-asked,
 *                so it too can only be answered inside that window);
 *             5. smsBlockReason(phone) is asked (a stub returning null until P2B-1, step 6);
 *             6. the "Sends as:" preview and the text that goes out come from the SAME composeSms call
 *                (shared/sms/compose.ts) with the SAME inputs: prepareSms composes the preview, and sendSms
 *                (services/twilio.ts) composes the sent text itself from the message's raw words, class,
 *                send type and event window, re-checking the first-text footer at the moment of Approve.
 *                hubSend never writes the header or the footer, so a double brand cannot happen;
 *             7. a text of kind review is refused: review requests are NEVER texted.
 *           Quiet hours and the release worker for a held text are P2B-6/P2B-7 (step 6); until they exist the
 *           leg must stay off, which is Kyle's env flip after A2P.
 *
 * Nothing here is on a route a bot can reach: the routes that call it (routes/hub.ts) are the CRM's own
 * session routes behind the approve_drafts power, and the auto-send rule (services/hubAutoSend.ts) calls it
 * only after the owner's switch AND the hubAutoSend gate are on.
 *
 * Writers of HubMessage.status here, all of them: the claim (approved -> approving, conditional, so two
 * senders cannot both send), then exactly one of sent / posted, approved (held), blocked or failed; and
 * releaseStaleSends, which settles a row a restart left "approving" (or approved and never claimed) as sent
 * (the provider had accepted it) or failed (it has "Try sending again" and Reject). Once a provider accepts a
 * message nothing here may turn it into "failed" (commitSent), because a failed card offers a second send.
 */
import { Prisma, type HubMessage, type HubThread, type PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { logSystemEvent } from "./systemEvents";
import { HubError, SYSTEM_ACTOR, bumpThreadForMessage, fanOutMessage, hubAudit, isFirstTextTo, last10 } from "./hub";
import { announceDecision } from "./hubBus";
import { sendRecordMessage, type RecordEmailTarget } from "./recordEmail";
import { sendSms, smsConsentFor, type SendSmsOptions } from "./twilio";
import { isInternalSmsNumber, smsBlockReason } from "./smsGuards";
import { twilioSendEnabled } from "./automationGate";
import { getSmsPurposeLabels } from "./ownerSettings";
import { inRehearsal, runAsRehearsal } from "./rehearsal";
import { messageCategoryFor, type MessageClass } from "../../shared/hub/messageCategories";
import { SMS_DISABLED_ERROR, isSendBlockReason, sendBlockText, type SendBlockReason } from "../../shared/hub/sendBlocks";
import { composeSms } from "../../shared/sms/compose";
import type { HubMessageStatus } from "../../shared/hub/model";

type Db = PrismaClient | Prisma.TransactionClient;

/** How long after a customer's last text we may still answer it without their saying yes to texts (team answer 7). */
export const REPLY_WINDOW_MS = 36 * 60 * 60 * 1000;

export interface SendActor {
  key: string;
  display: string;
}

export interface SendResult {
  messageId: string;
  status: HubMessageStatus;
  /** The reason code, "SMS disabled", or the failure sentence; null on a clean send. */
  error: string | null;
}

// ── who a message goes to ────────────────────────────────────────────────────────────────────────

export interface Recipient {
  name: string;
  email: string | null;
  phone: string | null;
  /** The record an email is filed against (its EmailDelivery row); null when the thread is not one. */
  target: RecordEmailTarget | null;
  customerId: string | null;
  leadId: string | null;
  visitId: string | null;
  /** True when the account is the office's own test account (Customer.isTestAccount): an approval there is a rehearsal. */
  testAccount: boolean;
}

/** The customer a thread is about: the account, the lead, or the job's account. Null for a Team, Dev or Training thread. */
export async function recipientFor(thread: HubThread, db: Db = defaultPrisma): Promise<Recipient | null> {
  if (thread.customerId) {
    const c = await db.customer.findUnique({ where: { id: thread.customerId }, select: { id: true, name: true, email: true, phone: true, isTestAccount: true } });
    return c ? { name: c.name, email: c.email, phone: c.phone, target: { kind: "account", customerId: c.id }, customerId: c.id, leadId: null, visitId: null, testAccount: c.isTestAccount } : null;
  }
  if (thread.leadId) {
    const l = await db.lead.findUnique({ where: { id: thread.leadId }, select: { id: true, name: true, email: true, phone: true } });
    return l ? { name: l.name, email: l.email, phone: l.phone, target: { kind: "lead", leadId: l.id }, customerId: null, leadId: l.id, visitId: null, testAccount: false } : null;
  }
  if (thread.kind === "job" && thread.visitId) {
    const v = await db.visit.findUnique({ where: { id: thread.visitId }, select: { id: true, customer: { select: { id: true, name: true, email: true, phone: true, isTestAccount: true } } } });
    return v ? { name: v.customer.name, email: v.customer.email, phone: v.customer.phone, target: { kind: "job", visitId: v.id }, customerId: v.customer.id, leadId: null, visitId: v.id, testAccount: v.customer.isTestAccount } : null;
  }
  return null;
}

// ── the text branch ──────────────────────────────────────────────────────────────────────────────

export type SmsPrepared =
  | {
    ok: true;
    /** E.164 number the text goes to. */
    to: string;
    toPhone10: string;
    /** True only for a transactional thread_reply inside the 36-hour window. */
    bypassConsent: boolean;
    /** The exact words that go out, and what they were composed from. */
    sentText: string;
    footerIncluded: boolean;
    headerAt: Date;
    eventStart: Date | null;
    eventEnd: Date | null;
  }
  | { ok: false; reason: SendBlockReason };

/** The customer's last inbound text from this number, if any, newest first. */
async function lastInboundText(db: Db, thread: HubThread, toPhone10: string): Promise<Date | null> {
  const row = await db.hubMessage.findFirst({
    where: {
      channel: "sms", direction: "inbound", deletedAt: null,
      OR: [{ threadId: thread.id }, { thread: { phone: toPhone10 } }],
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row ? row.createdAt : null;
}

/**
 * Everything a text needs decided before it can go, with no side effect: the class guard, the opt-out
 * question, the consent gate and the composed words. hubSend runs it at the moment of Approve; the card
 * runs the same function to print "Sends as:" and to grey Approve with the reason, so what is previewed
 * and what is checked cannot differ from what is sent.
 */
export async function prepareSms(message: HubMessage, thread: HubThread, db: Db, claimedAt: Date = new Date()): Promise<SmsPrepared> {
  const block = (reason: SendBlockReason): SmsPrepared => ({ ok: false, reason });
  const cls = message.messageClass;

  // 1. A message with no class (or one we do not know) is refused: no rule can be applied to it.
  if (cls !== "transactional" && cls !== "marketing" && cls !== "internal") return block("no_class");
  // 7. A review request is NEVER texted (addendum v2), whatever its class says.
  if (/review/i.test(message.category ?? "") || /review/i.test(message.purposeKey ?? "") || /review/i.test(message.actionKind ?? "")) return block("review_never_sms");
  // 2. Marketing is always refused in this build: there is no marketing opt-in to find. Never held.
  if (cls === "marketing") return block("marketing_not_opted_in");

  const recipient = await recipientFor(thread, db);
  const toPhone10 = message.toPhone10 ?? last10(recipient?.phone);
  if (!toPhone10) return block("no_phone");
  const to = `+1${toPhone10}`;

  let bypassConsent = false;
  if (cls === "internal") {
    if (!(await isInternalSmsNumber(to))) return block("internal_not_allowed");
  } else {
    if (!message.purposeKey) return block("no_purpose");
    // 5. Has this number opted out of texts? (stub until step 6; the one answer, asked here and in sendSms.)
    const blocked = await smsBlockReason(to);
    if (blocked) return block(isSendBlockReason(blocked) ? blocked : "opted_out");
    // 3 + 4. Transactional keeps the consent gate; only a reply within 36 hours of their own text goes round it.
    const lastInbound = await lastInboundText(db, thread, toPhone10);
    const inWindow = lastInbound !== null && claimedAt.getTime() - lastInbound.getTime() <= REPLY_WINDOW_MS;
    bypassConsent = message.category === "thread_reply" && inWindow;
    if (!bypassConsent) {
      const consent = await smsConsentFor(to).catch(() => "no" as const);
      if (consent === "no") return block("no_sms_consent");
      // A number with no Lead or Customer is never-asked, not unrestricted: only the 36-hour reply may go.
      if (consent === "unknown_number") return block("reply_window_closed");
    }
  }

  // 6. The words: the same composeSms call the preview prints and the send uses.
  const entry = messageCategoryFor(message.category);
  const eventStart = message.eventStart ?? null;
  const eventEnd = message.eventEnd ?? null;
  const headerAt = eventStart ?? claimedAt;
  const firstText = await isFirstTextTo(db, toPhone10, { id: message.id });
  const composed = composeSms({
    messageClass: cls, purposeKey: message.purposeKey, footer: entry?.footer ?? "first", body: message.body,
    when: { start: headerAt, end: eventEnd }, firstText, labels: await getSmsPurposeLabels().catch(() => undefined),
  });
  if (!composed.ok) return block(composed.reason);
  return {
    ok: true, to, toPhone10, bypassConsent, sentText: composed.text, footerIncluded: composed.footerIncluded,
    headerAt, eventStart, eventEnd,
  };
}

// ── settling a message ───────────────────────────────────────────────────────────────────────────

const toLast4 = (phone10: string | null | undefined): string | null => (phone10 ? phone10.slice(-4) : null);

/**
 * Refuse a message for good: the row becomes blocked and ONE send_blocked row says why. `from` is the status it
 * must still be in (approving when a send found the block; pending_approval or failed when an Approve found it
 * before anything was decided). Null when the row had already moved on, in which case nothing is written.
 */
export async function settleBlocked(
  db: PrismaClient, message: HubMessage, thread: HubThread, reason: SendBlockReason, actor: SendActor, from: HubMessageStatus = "approving",
): Promise<SendResult | null> {
  const won = await db.$transaction(async (tx) => {
    const claim = await tx.hubMessage.updateMany({
      where: { id: message.id, status: from, deletedAt: null },
      data: { status: "blocked", error: reason, heldReason: null, claimedAt: null },
    });
    if (claim.count === 0) return false;
    await hubAudit(tx, {
      actorKey: actor.key, actorDisplay: actor.display, action: "send_blocked", entityType: "message", entityId: message.id,
      threadId: thread.id, messageId: message.id, afterText: sendBlockText(reason),
      details: {
        reason, messageClass: message.messageClass, category: message.category, purposeKey: message.purposeKey,
        channel: message.channel, toLast4: toLast4(message.toPhone10),
        ids: { threadId: thread.id, messageId: message.id, customerId: thread.customerId, leadId: thread.leadId, visitId: thread.visitId },
      },
    });
    return true;
  });
  return won ? { messageId: message.id, status: "blocked", error: reason } : null;
}

async function settleHeld(db: PrismaClient, message: HubMessage, thread: HubThread, actor: SendActor): Promise<SendResult> {
  await db.$transaction(async (tx) => {
    await tx.hubMessage.update({ where: { id: message.id }, data: { status: "approved", error: SMS_DISABLED_ERROR, heldReason: "sms_disabled", claimedAt: null } });
    await hubAudit(tx, {
      actorKey: actor.key, actorDisplay: actor.display, action: "message_held", entityType: "message", entityId: message.id,
      threadId: thread.id, messageId: message.id, afterText: SMS_DISABLED_ERROR,
      details: { reason: "sms_disabled", channel: message.channel, messageClass: message.messageClass, category: message.category },
    });
  });
  return { messageId: message.id, status: "approved", error: SMS_DISABLED_ERROR };
}

async function settleFailed(
  db: PrismaClient, message: Pick<HubMessage, "id" | "channel">, thread: Pick<HubThread, "id"> | { id: null }, error: string, actor: SendActor,
  extra: Prisma.HubMessageUncheckedUpdateInput = {},
): Promise<SendResult> {
  await db.$transaction(async (tx) => {
    await tx.hubMessage.update({ where: { id: message.id }, data: { ...extra, status: "failed", error, heldReason: null, claimedAt: null } });
    await hubAudit(tx, {
      actorKey: actor.key, actorDisplay: actor.display, action: "message_send_failed", entityType: "message", entityId: message.id,
      threadId: thread.id, messageId: message.id, afterText: error, details: { channel: message.channel },
    });
  });
  return { messageId: message.id, status: "failed", error };
}

async function settleSent(
  db: PrismaClient, message: HubMessage, thread: HubThread, status: "sent" | "posted", actor: SendActor,
  extra: Prisma.HubMessageUncheckedUpdateInput = {}, details: Record<string, unknown> = {},
): Promise<SendResult> {
  const at = new Date();
  const updated = await db.$transaction(async (tx) => {
    const row = await tx.hubMessage.update({
      where: { id: message.id },
      data: { ...extra, status, sentAt: at, error: null, heldReason: null, claimedAt: null },
    });
    // A message that lands in a closed thread brings it back: the SAME helper postMessage uses.
    await bumpThreadForMessage(tx, thread.id, { id: row.id, createdAt: at }, actor, at);
    await hubAudit(tx, {
      actorKey: actor.key, actorDisplay: actor.display, action: status === "sent" ? "message_sent" : "message_posted", entityType: "message",
      entityId: message.id, threadId: thread.id, messageId: message.id,
      details: { channel: message.channel, messageClass: message.messageClass, category: message.category, ...details },
    });
    return row;
  });
  fanOutMessage(updated, thread); // the ONE fan-out call site
  return { messageId: message.id, status, error: null };
}

// ── the send ─────────────────────────────────────────────────────────────────────────────────────

/** The message is not in a state that may be sent at all (not approved, already going out, deleted). A 409. */
export class HubSendRefusal extends HubError {
  constructor(message: string) {
    super(message, 409);
    this.name = "HubSendRefusal";
  }
}

/** A send that has been "approving" (or approved and never claimed) this long was lost, not slow: a restart took it. */
export const STALE_SEND_MS = 10 * 60 * 1000;
export const STALE_SEND_ERROR = "The send was interrupted (the server restarted). Check the customer's record before trying again.";

const movedOn = (messageId: string): SendResult => ({ messageId, status: "failed", error: STALE_SEND_ERROR });

function staleWhere(cutoff: Date): Prisma.HubMessageWhereInput {
  return {
    deletedAt: null,
    OR: [
      { status: "approving", claimedAt: { lt: cutoff } },
      // Approved, decided, and never claimed by a send (a failure between the decision and the send). A text held
      // because texting is off carries an error and is not this. sendAfter is for the future release worker.
      { status: "approved", error: null, sendAfter: null, OR: [{ claimedAt: { lt: cutoff } }, { claimedAt: null, decidedAt: { lt: cutoff } }] },
    ],
  };
}

/**
 * Give a message the server lost track of a way out. A row stays "approving" only while a live process is
 * inside hubSend, and "approved with no error" only for the moment between the decision and the send, so a
 * row past STALE_SEND_MS in either state was cut off by a restart or a crash. It becomes:
 *   * sent, when the provider already accepted it (sentAt is written the moment it does);
 *   * failed otherwise - which has "Try sending again" and Reject on its card. A person decides whether to
 *     resend, because the send may have gone out; the sentence says to check the record first.
 * One audit row per message. Cheap (one indexed read); called wherever cards are read or decided.
 */
export async function releaseStaleSends(db: PrismaClient = defaultPrisma, now: Date = new Date()): Promise<number> {
  const where = staleWhere(new Date(now.getTime() - STALE_SEND_MS));
  const stale = await db.hubMessage.findMany({ where, select: { id: true, threadId: true, status: true, channel: true, sentAt: true } });
  let released = 0;
  for (const m of stale) {
    const delivered = m.status === "approving" && m.sentAt !== null;
    const won = await db.$transaction(async (tx) => {
      const claim = await tx.hubMessage.updateMany({
        where: { AND: [{ id: m.id }, where] },
        data: delivered
          ? { status: "sent", error: null, heldReason: null, claimedAt: null }
          : { status: "failed", error: STALE_SEND_ERROR, heldReason: null, claimedAt: null },
      });
      if (claim.count === 0) return false;
      await hubAudit(tx, {
        actorKey: SYSTEM_ACTOR.key, actorDisplay: SYSTEM_ACTOR.display, action: delivered ? "message_sent" : "message_send_interrupted",
        entityType: "message", entityId: m.id, threadId: m.threadId, messageId: m.id, beforeText: m.status,
        afterText: delivered ? "sent" : STALE_SEND_ERROR, details: { channel: m.channel, releasedStale: true },
      });
      return true;
    });
    if (won) released += 1;
  }
  return released;
}

/**
 * Send one APPROVED message. Claims it (approved -> approving, conditional) so a double click or two
 * approvers send it once, runs the channel's branch, and settles the row. Never throws for a send that
 * went wrong - a failure is a settled "failed" row the card shows; it throws HubSendRefusal only when the
 * message is not in a state that may be sent at all.
 */
export async function hubSend(messageId: string, actor: SendActor, db: PrismaClient = defaultPrisma): Promise<SendResult> {
  const result = await hubSendOnce(messageId, actor, db);
  // The card moved on (sent, held, blocked or failed): the open Messages screens hear it (ids only).
  announceDecision(messageId);
  return result;
}

async function hubSendOnce(messageId: string, actor: SendActor, db: PrismaClient): Promise<SendResult> {
  const claimedAt = new Date();
  const claim = await db.hubMessage.updateMany({
    where: { id: messageId, status: "approved", deletedAt: null },
    data: { status: "approving", claimedAt },
  });
  if (claim.count === 0) {
    const row = await db.hubMessage.findUnique({ where: { id: messageId }, select: { status: true, deletedAt: true } });
    if (!row) throw new HubSendRefusal("Message not found.");
    if (row.deletedAt) throw new HubSendRefusal("That message was deleted.");
    throw new HubSendRefusal(row.status === "approving" || row.status === "sent" || row.status === "posted"
      ? "That message is already going out or has gone out."
      : `Only an approved message can be sent (this one is ${row.status.replace(/_/g, " ")}).`);
  }

  // Everything after the claim is inside the try: whatever throws, the row is settled rather than left "approving".
  let loaded: { message: HubMessage; thread: HubThread } | null = null;
  try {
    const message = await db.hubMessage.findUniqueOrThrow({ where: { id: messageId } });
    const thread = await db.hubThread.findUniqueOrThrow({ where: { id: message.threadId } });
    loaded = { message, thread };
    if (message.channel === "in_app") return await settleSent(db, message, thread, "posted", actor);
    const dispatch = (): Promise<SendResult> => {
      if (message.channel === "email") return sendEmail(db, message, thread, actor);
      if (message.channel === "sms") return sendText(db, message, thread, actor, claimedAt);
      return settleFailed(db, message, thread, `A ${message.channel} message cannot be sent from here.`, actor);
    };
    // An approval on the office's TEST ACCOUNT is a rehearsal (TC10): everything is checked and settled exactly
    // as for a customer, but the email and the text are skipped at their doors (services/rehearsal.ts).
    const rehearse = (message.channel === "email" || message.channel === "sms") && (await recipientFor(thread, db))?.testAccount === true;
    return await (rehearse ? runAsRehearsal(dispatch, thread.customerId) : dispatch());
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    logSystemEvent("error", "hub", `hubSend failed for message ${messageId}: ${text}`);
    const threadId = loaded
      ? loaded.thread.id
      : (await db.hubMessage.findUnique({ where: { id: messageId }, select: { threadId: true } }).catch(() => null))?.threadId ?? null;
    return settleFailed(db, loaded ? loaded.message : { id: messageId, channel: "unknown" }, { id: threadId }, "The message could not be sent. See System events for why.", actor);
  }
}

/**
 * The provider has accepted the message. From here a failure to write it down must NEVER turn into "failed":
 * a failed card offers "Try sending again", and that would send the customer a second copy. So the ids and
 * sentAt are written first in a plain update (so a restart leaves the evidence, and releaseStaleSends settles
 * the row as sent), then the full settle runs; if that throws, a bare conditional update still marks it sent.
 * Never throws.
 */
async function commitSent(
  db: PrismaClient, message: HubMessage, thread: HubThread, actor: SendActor,
  extra: Prisma.HubMessageUncheckedUpdateInput, details: Record<string, unknown>,
): Promise<SendResult> {
  try {
    await db.hubMessage.update({ where: { id: message.id }, data: { ...extra, sentAt: new Date() } });
  } catch (err) {
    logSystemEvent("error", "hub", `message ${message.id} went out but its ids could not be saved: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return await settleSent(db, message, thread, "sent", actor, extra, details);
  } catch (err) {
    logSystemEvent("error", "hub", `message ${message.id} went out but could not be settled: ${err instanceof Error ? err.message : String(err)}`);
    try {
      await db.hubMessage.updateMany({ where: { id: message.id, status: "approving" }, data: { status: "sent", sentAt: new Date(), error: null, claimedAt: null } });
    } catch (err2) {
      logSystemEvent("error", "hub", `message ${message.id} went out and is still marked approving: ${err2 instanceof Error ? err2.message : String(err2)}`);
    }
    return { messageId: message.id, status: "sent", error: null };
  }
}

async function sendEmail(db: PrismaClient, message: HubMessage, thread: HubThread, actor: SendActor): Promise<SendResult> {
  const recipient = await recipientFor(thread, db);
  if (!recipient?.target) {
    return settleFailed(db, message, thread, "An email can only go from a customer's or a job's conversation.", actor);
  }
  // A draft written from a job's "Email the customer" is tagged with that job but sits on the customer's account
  // thread. File the delivery against the job, the way a direct send from the same panel does, so the job's Email
  // history lists it. Only when the job really belongs to this thread's customer (never a stray tag).
  let target: RecordEmailTarget = recipient.target;
  if (message.visitId && recipient.customerId) {
    const visit = await db.visit.findUnique({ where: { id: message.visitId }, select: { customerId: true } });
    if (visit?.customerId === recipient.customerId) target = { kind: "job", visitId: message.visitId };
  }
  const result = await sendRecordMessage({
    target, to: message.toAddress, cc: message.cc,
    subject: message.subject?.trim() || "A message from Red Cedar Electric", body: message.body, estimateId: message.issuedEstimateId,
  });
  if (!result.ok) {
    return settleFailed(db, message, thread, result.error, actor, result.deliveryId ? { emailDeliveryId: result.deliveryId } : {});
  }
  return commitSent(db, message, thread, actor, result.deliveryId ? { emailDeliveryId: result.deliveryId } : {}, { suppressed: result.suppressed, ...(inRehearsal() ? { rehearsal: true } : {}) });
}

/** What sendSms is told about an approved message: its frozen class and send type, its window, and that THIS row is the text. */
function textOptions(message: HubMessage, thread: HubThread, prepared: Extract<SmsPrepared, { ok: true }>): SendSmsOptions {
  return {
    messageClass: message.messageClass as MessageClass,
    category: message.category ?? "",
    bypassConsentCheck: prepared.bypassConsent,
    when: { start: prepared.headerAt, end: prepared.eventEnd },
    hub: { customerId: thread.customerId, leadId: thread.leadId, visitId: thread.visitId, purposeKey: message.purposeKey, messageId: message.id },
  };
}

async function sendText(db: PrismaClient, message: HubMessage, thread: HubThread, actor: SendActor, claimedAt: Date): Promise<SendResult> {
  const prepared = await prepareSms(message, thread, db, claimedAt);
  if (!prepared.ok) return (await settleBlocked(db, message, thread, prepared.reason, actor)) ?? movedOn(message.id);
  // The leg comes AFTER the class guard, consent and composition: a text that can never go out is refused
  // now, not parked until texting is switched on.
  const common = { headerAt: prepared.headerAt, eventStart: prepared.eventStart, eventEnd: prepared.eventEnd, toPhone10: prepared.toPhone10 };
  // A rehearsal skips the provider and the texting switch alike: the row settles as the text that WOULD have
  // gone, with no provider id, and the card says "Rehearsal: email and text skipped".
  if (inRehearsal()) {
    await sendSms(prepared.to, message.body, textOptions(message, thread, prepared)); // logs the skip; sends nothing
    return commitSent(db, message, thread, actor, { sentText: prepared.sentText, footerIncluded: prepared.footerIncluded, ...common }, { footerIncluded: prepared.footerIncluded, rehearsal: true });
  }
  if (!twilioSendEnabled("hubSms")) return settleHeld(db, message, thread, actor);

  // sendSms composes the words itself, from the message's own raw body, class, send type and event window: the
  // same composeSms call, with the same inputs, that prepareSms made for the preview. What it says it sent is
  // what is stored (a first-text answer that changed between preview and send shows here, never a stale preview).
  const sent = await sendSms(prepared.to, message.body, textOptions(message, thread, prepared));
  if (!sent) return settleFailed(db, message, thread, "The text was not sent: Twilio is not set up or refused it. See System events.", actor);
  return commitSent(db, message, thread, actor, {
    providerMessageId: sent.sid, sentText: sent.sentText, footerIncluded: sent.footerIncluded, ...common,
  }, { footerIncluded: sent.footerIncluded });
}
