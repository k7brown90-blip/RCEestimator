/**
 * What happens to an AI agent's fresh message (work order agent-price-book-and-no-check-ins, batch PB-3; Kyle 2026-11-24:
 * "We are submitting direct requests to these agents which implies approval to all that they are reqested to do in the CRM.
 * requiring them to check-in on everything defeates the purpose of the chat" and "The messages are going to be automated too,
 * no check in."). This file replaces the old auto-send rule file (hubAutoSend.ts; Settings -> "Auto-send rules" is gone).
 *
 *   1. A CUSTOMER email or text an agent key (or the AI admin session) writes SENDS when it is posted: sendAgentMessageNow, called by
 *      createDraftMessage (services/hubDrafts.ts, the ONE draft door) for every agent customer message. It is the same send as a
 *      person's Approve - hubSend, the ONE sender - so the text's class guard, opt-out and consent, the first-text footer, the
 *      unsubscribe list and the test-account rehearsal all still apply. A guard that refuses leaves the message recorded as NOT SENT
 *      (status blocked, ONE send_blocked audit row naming the reason) and the agent is told why: nothing is ever queued for approval.
 *      The guards read here, fresh, on every send: Agent access must be On (the kill switch), the key must be live with "Allow writes"
 *      on, texting must be switched on (HUB_SMS_OUTBOUND_ENABLED), and an email needs an address that has not unsubscribed. The
 *      500-a-day cap and the rate limit are the door's (agentApi/gate.ts, hubDoor.ts), before anything is written; the AI admin session's
 *      own 500-a-day cap is checked by routes/communications.ts. The server-side switch AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND (or the
 *      master AUTOMATED_CUSTOMER_SENDS), default-deny, covers every AI customer send; the office test account is rehearsed, never refused.
 *   2. A TEAM post (team_internal: a Team, group or crew chat) never reaches a customer. It is published by its author KEY's own
 *      "Team posts publish immediately" box (AgentKey.teamPostsPublish, re-read from the row), while Agent access is On and the key's
 *      writes are on: publishTeamPost. A key whose box is off leaves its team posts waiting for a person, as before. A Training
 *      post is published by postMessageResult itself (Kyle 2026-11-24; amendment 16b is gone).
 *
 * Nothing here is reachable from a route: it is called by the draft door and by the hub's post function right after a row is written.
 */
import type { HubMessage, HubThread, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { hubAudit, fanOutMessage } from "./hub";
import { emitHubEventSafe } from "./hubEvents";
import { announceDecision } from "./hubBus";
import { hubSend, recipientFor, settleBlocked, type SendActor, type SendResult } from "./hubSend";
import { getAgentAccess } from "./ownerSettings";
import { customerSendsEnabled, logCustomerSendSkipped, twilioSendEnabled } from "./automationGate";
import { isSuppressed } from "./emailCampaigns";
import { SINGLE_ADDRESS } from "./emailCc";
import { logSystemEvent } from "./systemEvents";
import { SMS_DISABLED_ERROR, sendBlockText, type SendBlockReason } from "../../shared/hub/sendBlocks";

const AI_AUTHORS = new Set(["ai_agent", "claude"]);

/** The send type of an agent's post in a Team, group or crew chat (hub.ts agentPostCategory). It is decided by the author key. */
export const TEAM_POST_CATEGORY = "team_internal";

// ── 1. a customer message goes out when it is posted ─────────────────────────────────────────────

/** The guard that refuses this send right now, or null. Every read is fresh: nothing is cached from the request that wrote the row. */
async function guardRefusal(message: HubMessage, thread: HubThread, db: PrismaClient): Promise<SendBlockReason | null> {
  // The kill switch overrides everything: anything but "on" (including an unreadable row) refuses.
  if ((await getAgentAccess(db)).mode !== "on") return "agent_access_off";
  // The key that wrote it must still be live with "Allow writes" on (Kyle may have just revoked it or un-ticked the box).
  if (message.authorBotKeyId) {
    const key = await db.agentKey.findUnique({ where: { id: message.authorBotKeyId }, select: { writesEnabled: true, revokedAt: true } });
    if (!key || key.revokedAt || !key.writesEnabled) return "agent_writes_off";
  }
  // The office's own TEST ACCOUNT is a rehearsal (TC10): hubSend skips the provider and both server-side switches for it and settles the
  // message as the one that WOULD have gone, exactly as it does after a person's Approve. Nothing reaches anyone, so the switches have
  // nothing to hold back and the rehearsal is not refused here.
  const recipient = await recipientFor(thread, db);
  const rehearsal = recipient?.testAccount === true;
  // The server-side switch for an AI's customer send (AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND, or the master): default-deny, manual-first ruling
  // 2026-08-11, and the "email env gate" the plan keeps. It covers an email and a text alike; a text also needs the hubSms leg below.
  if (!rehearsal && !customerSendsEnabled("hubAutoSend")) {
    logCustomerSendSkipped("hubAutoSend", `message ${message.id}`);
    return "agent_sends_off";
  }
  if (message.channel === "sms") {
    // The text's own class guard, opt-out and consent are asked by hubSend itself, at the moment it sends (prepareSms).
    if (!rehearsal && !twilioSendEnabled("hubSms")) return "texting_off";
    return null;
  }
  if (message.channel === "email") {
    const address = message.toAddress?.trim() || recipient?.email || null;
    if (!address || !SINGLE_ADDRESS.test(address)) return "no_email";
    if (await isSuppressed(db, address)) return "email_unsubscribed";
    return null;
  }
  return "wrong_channel";
}

export interface DirectSendOutcome {
  /** The row as it now stands. */
  message: HubMessage;
  /** True only when the provider accepted it (status sent). */
  sent: boolean;
  /** Why it did not go, in plain words; null when it was sent. */
  notSentReason: string | null;
}

/** Why a message is not sent, in the words the agent and the card say; null when it is sent (or posted). */
export function notSentReasonFor(m: Pick<HubMessage, "status" | "error">): string | null {
  switch (m.status) {
    case "sent": case "posted": return null;
    case "blocked": return `Not sent: ${sendBlockText(m.error)}`;
    case "failed": return `Not sent: ${m.error ?? "the send failed"}`;
    case "approved": return m.error === SMS_DISABLED_ERROR ? "Not sent: texting is turned off." : "It is being sent.";
    case "approving": return "It is going out now.";
    case "pending_approval": return "It is waiting for a person to approve it (it was written before agents sent directly).";
    case "draft": return "It was saved as a draft, as asked.";
    default: return `It is ${m.status.replace(/_/g, " ")}.`;
  }
}

/**
 * Send an agent's customer message NOW. The row must already exist as `approved` (createDraftMessage writes it that way, decided by the
 * author itself) - the very state a person's Approve leaves - so the one sender, hubSend, takes it from there. A guard that refuses
 * settles the row blocked (never left waiting); a send that fails settles it failed. This does not throw for a message that did not go:
 * the outcome says so.
 */
export async function sendAgentMessageNow(messageId: string, db: PrismaClient = defaultPrisma): Promise<DirectSendOutcome> {
  const message = await db.hubMessage.findUniqueOrThrow({ where: { id: messageId } });
  const thread = await db.hubThread.findUniqueOrThrow({ where: { id: message.threadId } });
  const actor: SendActor = { key: message.authorKey ?? "agent", display: message.authorDisplay };

  if (message.status !== "approved" || message.direction !== "outbound" || !AI_AUTHORS.has(message.authorType)) {
    return { message, sent: false, notSentReason: notSentReasonFor(message) };
  }
  const refusal = await guardRefusal(message, thread, db);
  if (refusal) {
    await settleBlocked(db, message, thread, refusal, actor, "approved");
    announceDecision(messageId);
  } else {
    try {
      await hubSend(messageId, actor, db);
    } catch (err) {
      // hubSend settles whatever goes wrong AFTER it claims the row; a failure before the claim leaves it "approved" with nothing running.
      const text = err instanceof Error ? err.message : String(err);
      logSystemEvent("error", "hub", `direct send of message ${messageId} failed before it started: ${text}`);
      const error = "The message could not be sent. See System events for why.";
      const moved = await db.hubMessage.updateMany({
        where: { id: messageId, status: "approved", error: null }, data: { status: "failed", error, claimedAt: null },
      }).catch(() => null);
      if (moved && moved.count > 0) {
        await hubAudit(db, {
          actorKey: actor.key, actorDisplay: actor.display, action: "message_send_failed", entityType: "message", entityId: messageId,
          threadId: thread.id, messageId, afterText: error, details: { before: "approved" },
        }).catch(() => undefined);
      }
    }
  }
  const fresh = (await db.hubMessage.findUnique({ where: { id: messageId } })) ?? message;
  // A sent message was announced by hubSend (settleSent is a fan-out call site); one that did not go is announced here, once.
  if (fresh.status !== "sent" && fresh.status !== "posted") fanOutMessage(fresh, thread);
  return { message: fresh, sent: fresh.status === "sent", notSentReason: notSentReasonFor(fresh) };
}

// ── 2. a Team post is published by its key's own box ─────────────────────────────────────────────

const AGENT_ACCESS_NOT_ON = "Agent access is not On (it is paused or off), so nothing an AI wrote is published on its own.";

type TeamVerdict =
  | { ok: true; actor: { key: string; display: string; keyId: string } }
  | { ok: false; why: string };

/** Whether a Team, group or crew post may be published by its author key now, and if not, the first reason. */
async function evaluateTeamPost(message: HubMessage, thread: HubThread, db: PrismaClient): Promise<TeamVerdict> {
  const no = (why: string): TeamVerdict => ({ ok: false, why });
  if (message.status !== "pending_approval" || !AI_AUTHORS.has(message.authorType)) return no("Only an AI post waiting for approval can be published by its key.");
  if (message.category !== TEAM_POST_CATEGORY) return no("This kind of post waits for a person to approve it.");
  if (message.direction !== "internal" || message.channel !== "in_app") return no("A team post is an in-app post.");
  if (thread.customerId || thread.leadId || thread.kind === "customer") return no("An in-app post cannot go to a customer's conversation.");
  if (!message.authorBotKeyId) return no("The post has no agent key to decide it.");
  // The key's box is read from the row NOW, never from what the request carried: Kyle may have just un-ticked it or revoked the key.
  const key = await db.agentKey.findUnique({
    where: { id: message.authorBotKeyId }, select: { id: true, name: true, teamPostsPublish: true, writesEnabled: true, revokedAt: true },
  });
  if (!key || key.revokedAt) return no("The key that wrote this post is revoked, so a person must approve it.");
  if (!key.teamPostsPublish) return no(`"Team posts publish immediately" is off for the key "${key.name}", so the post waits for a person to approve it.`);
  if (!key.writesEnabled) return no(`Writes are off for the key "${key.name}", so the post waits for a person to approve it.`);
  if ((await getAgentAccess(db)).mode !== "on") return no(AGENT_ACCESS_NOT_ON);
  return { ok: true, actor: { key: `key:${key.id}`, display: key.name, keyId: key.id } };
}

/**
 * Publish a fresh Team, group or crew post by its author key's own box, when that box (and Agent access, and the key's writes) allow it.
 * Returns what happened; a post that does not qualify is left exactly as it was, waiting for a person.
 */
export async function publishTeamPost(
  messageId: string, db: PrismaClient = defaultPrisma,
): Promise<{ published: false; why: string } | { published: true; send: SendResult }> {
  const message = await db.hubMessage.findUnique({ where: { id: messageId } });
  if (!message) return { published: false, why: "Message not found." };
  const thread = await db.hubThread.findUnique({ where: { id: message.threadId } });
  if (!thread) return { published: false, why: "Conversation not found." };
  const verdict = await evaluateTeamPost(message, thread, db);
  if (!verdict.ok) return { published: false, why: verdict.why };

  const decidedAt = new Date();
  const actor = verdict.actor;
  const won = await db.$transaction(async (tx) => {
    const claim = await tx.hubMessage.updateMany({
      where: { id: messageId, status: "pending_approval", deletedAt: null },
      data: { status: "approved", decidedBy: actor.key, decidedAt, claimedAt: decidedAt, error: null },
    });
    if (claim.count === 0) return false;
    await hubAudit(tx, {
      actorKey: actor.key, actorDisplay: actor.display, action: "message_auto_approved", entityType: "message", entityId: messageId,
      threadId: message.threadId, messageId,
      afterText: `published by the key "${actor.display}" (Team posts publish immediately)`,
      details: { category: TEAM_POST_CATEGORY, channel: message.channel, keyId: actor.keyId, keyName: actor.display },
    });
    return true;
  });
  if (!won) return { published: false, why: "A person decided it first." };
  void emitHubEventSafe({ type: "approval.decided", messageId, status: "approved", actionKind: message.actionKind ?? "team_reply", resultIds: {} });
  return { published: true, send: await hubSend(messageId, { key: actor.key, display: actor.display }, db) };
}
