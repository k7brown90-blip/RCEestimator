/**
 * Auto-send (work order agent-team, BA8): an AI draft in a category Kyle switched ON goes out without a
 * person pressing Approve. Every category is OFF until he turns it on (the owner setting `hubAutoSend`,
 * Settings -> "AI auto-send rules"), and a switch alone sends nothing. A draft is auto-approved only when
 * ALL of these hold, and any one failing leaves it as a normal draft waiting for a person:
 *
 *   1. the draft is waiting for approval, outbound, and written by an AI author (never a person's message);
 *   2. its send type is one the registry marks auto-send eligible (shared/hub/autoSendCategories.ts) AND
 *      Kyle switched that category ON;
 *   3. the server-side gate is ON: CustomerSendWorkflow `hubAutoSend` (env AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND);
 *   4. the customer may be contacted that way: for a text, the same preflight an Approve runs (class guard,
 *      opt-out, consent) AND the hub SMS leg is on; for an email, there is an address and it is not on the
 *      unsubscribe list;
 *   5. the body is within the category's length cap;
 *   6. the body names no dollar amount, unless the category allows prices.
 *   7. (W2, Kyle 2026-11-23, "the kill switch overrides all approvals") Agent access is ON, read fresh and failing closed: while it
 *      is paused or off nothing an agent wrote is approved by a rule. A person's own Approve is unchanged.
 *
 * A TEAM POST is the one exception to the list above (W2). An agent's post in a Team, group or crew chat never reaches a customer, so it
 * does not follow the owner's rules, the customer-send env gate, the length cap or the dollar rule: it is published by its author KEY's own
 * "Team posts publish immediately" box (AgentKey.teamPostsPublish, re-read from the row), and Agent access must be On. It is approved by
 * the key (decidedBy "key:<keyId>", the audit row names the key) and posted through hubSend like every other approved message.
 *
 * When it passes, the message is approved by the RULE (decidedBy "rule:<category>"), the audit says
 * "auto-approved by rule <category>", the agents get approval.decided, and it goes out through hubSend like
 * any approved message. Nothing here is reachable from a route: it is called by the hub's draft-create path
 * (services/hubDrafts.ts) right after a draft is written.
 */
import type { HubMessage, HubThread, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { hubAudit } from "./hub";
import { emitHubEventSafe } from "./hubEvents";
import { hubSend, prepareSms, recipientFor, type SendResult } from "./hubSend";
import { getAgentAccess, getOwnerSetting } from "./ownerSettings";
import { customerSendsEnabled, twilioSendEnabled } from "./automationGate";
import { isSuppressed } from "./emailCampaigns";
import { SINGLE_ADDRESS } from "./emailCc";
import { sendBlockText } from "../../shared/hub/sendBlocks";
import { autoSendCategoryFor, type HubAutoSendValue } from "../../shared/hub/autoSendCategories";

const AI_AUTHORS = new Set(["ai_agent", "claude"]);
/** The send type of an agent's post in a Team, group or crew chat (hub.ts agentPostCategory). It is decided by the author key, not by an owner rule. */
export const TEAM_POST_CATEGORY = "team_internal";
/** A dollar sign followed by a digit: "$150", "$ 1,200". */
const PRICE = /\$\s?\d/;

export const AUTO_SEND_ACTOR_NAME = "Auto-send rule";

export async function getHubAutoSend(db: PrismaClient = defaultPrisma): Promise<HubAutoSendValue> {
  return (await getOwnerSetting("hubAutoSend", db)) as HubAutoSendValue;
}

/** ok carries who approves: the rule (the default) or, for a team post, the author KEY. */
export type AutoSendVerdict =
  | { ok: true; category: string; actor?: { key: string; display: string; keyId: string } }
  | { ok: false; why: string };

const AGENT_ACCESS_NOT_ON = "Agent access is not On (it is paused or off), so nothing an AI wrote is published or sent on its own.";

/** A team post: published by its author key's own box, while Agent access is On. Never an owner rule, never the customer-send env gate. */
async function evaluateTeamPost(message: HubMessage, thread: HubThread, db: PrismaClient): Promise<AutoSendVerdict> {
  const no = (why: string): AutoSendVerdict => ({ ok: false, why });
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
  return { ok: true, category: TEAM_POST_CATEGORY, actor: { key: `key:${key.id}`, display: key.name, keyId: key.id } };
}

/** Whether this draft may go out without a person pressing Approve, and if not, the first reason it may not. */
export async function evaluateAutoSend(message: HubMessage, thread: HubThread, db: PrismaClient = defaultPrisma): Promise<AutoSendVerdict> {
  const no = (why: string): AutoSendVerdict => ({ ok: false, why });
  if (message.status !== "pending_approval" || !AI_AUTHORS.has(message.authorType)) {
    return no("Only an AI draft waiting for approval can be auto-sent.");
  }
  // W2: a team post is decided by its author key, ahead of (and apart from) the owner's rules below.
  if (message.category === TEAM_POST_CATEGORY) return evaluateTeamPost(message, thread, db);
  const category = autoSendCategoryFor(message.category);
  if (!category) return no("This send type is not one that can be auto-sent.");
  // A message to a customer is outbound; an in-app post for the team (team_internal, training_reply) is internal.
  if (message.direction !== (category.customerFacing ? "outbound" : "internal")) {
    return no("Only an AI draft waiting for approval can be auto-sent.");
  }
  // The kill switch overrides every rule (R-d): read fresh, and anything but "on" (including an unreadable row) holds the draft.
  if ((await getAgentAccess(db)).mode !== "on") return no(AGENT_ACCESS_NOT_ON);
  const setting = await getHubAutoSend(db);
  if (setting.categories[category.key] !== true) return no(`Auto-send is off for "${category.label}".`);
  if (!customerSendsEnabled("hubAutoSend")) return no("The server-side auto-send gate is off.");
  if (message.body.length > category.lengthCap) return no(`The message is longer than ${category.lengthCap} characters.`);
  if (!category.allowsPrices && PRICE.test(`${message.subject ?? ""} ${message.body}`)) return no("The message names a dollar amount.");

  // A category that never reaches a customer (team_internal, training_reply) is an in-app post in a Team, Dev,
  // Training or job conversation: no consent, address or text rules apply, and it can go nowhere else.
  if (!category.customerFacing) {
    if (message.channel !== "in_app") return no("This kind of message is an in-app post, not an email or a text.");
    if (thread.customerId || thread.leadId || thread.kind === "customer") return no("An in-app post cannot go to a customer's conversation.");
    return { ok: true, category: category.key };
  }
  if (message.channel === "sms") {
    if (!twilioSendEnabled("hubSms")) return no("Texting is off.");
    const prepared = await prepareSms(message, thread, db);
    if (!prepared.ok) return no(`The text cannot go: ${sendBlockText(prepared.reason)}`);
  } else if (message.channel === "email") {
    const recipient = await recipientFor(thread, db);
    const address = message.toAddress?.trim() || recipient?.email || null;
    if (!address || !SINGLE_ADDRESS.test(address)) return no("There is no email address to send to.");
    if (await isSuppressed(db, address)) return no("That address unsubscribed from email.");
  } else {
    return no("Only an email or a text can be auto-sent.");
  }
  return { ok: true, category: category.key };
}

/**
 * Evaluate a fresh draft and, when every condition holds, approve it by the rule and send it. Returns what
 * happened; a draft that does not qualify is left exactly as it was.
 */
export async function maybeAutoApprove(
  messageId: string, db: PrismaClient = defaultPrisma,
): Promise<{ autoApproved: false; why: string } | { autoApproved: true; category: string; send: SendResult }> {
  const message = await db.hubMessage.findUnique({ where: { id: messageId } });
  if (!message) return { autoApproved: false, why: "Message not found." };
  const thread = await db.hubThread.findUnique({ where: { id: message.threadId } });
  if (!thread) return { autoApproved: false, why: "Conversation not found." };
  const verdict = await evaluateAutoSend(message, thread, db);
  if (!verdict.ok) return { autoApproved: false, why: verdict.why };

  const decidedAt = new Date();
  const actor = verdict.actor ?? { key: `rule:${verdict.category}`, display: AUTO_SEND_ACTOR_NAME };
  const won = await db.$transaction(async (tx) => {
    const claim = await tx.hubMessage.updateMany({
      where: { id: messageId, status: "pending_approval", deletedAt: null },
      data: { status: "approved", decidedBy: actor.key, decidedAt, claimedAt: decidedAt, error: null },
    });
    if (claim.count === 0) return false;
    await hubAudit(tx, {
      actorKey: actor.key, actorDisplay: actor.display, action: "message_auto_approved", entityType: "message", entityId: messageId,
      threadId: message.threadId, messageId,
      afterText: verdict.actor ? `published by the key "${verdict.actor.display}" (Team posts publish immediately)` : `auto-approved by rule ${verdict.category}`,
      details: { category: verdict.category, channel: message.channel, ...(verdict.actor ? { keyId: verdict.actor.keyId, keyName: verdict.actor.display } : {}) },
    });
    return true;
  });
  if (!won) return { autoApproved: false, why: "A person decided it first." };
  void emitHubEventSafe({ type: "approval.decided", messageId, status: "approved", actionKind: message.actionKind ?? "customer_message", resultIds: {} });
  return { autoApproved: true, category: verdict.category, send: await hubSend(messageId, actor, db) };
}
