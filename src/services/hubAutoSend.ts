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
import { getOwnerSetting } from "./ownerSettings";
import { customerSendsEnabled, twilioSendEnabled } from "./automationGate";
import { isSuppressed } from "./emailCampaigns";
import { SINGLE_ADDRESS } from "./emailCc";
import { sendBlockText } from "../../shared/hub/sendBlocks";
import { autoSendCategoryFor, type HubAutoSendValue } from "../../shared/hub/autoSendCategories";

const AI_AUTHORS = new Set(["ai_agent", "claude"]);
/** A dollar sign followed by a digit: "$150", "$ 1,200". */
const PRICE = /\$\s?\d/;

export const AUTO_SEND_ACTOR_NAME = "Auto-send rule";

export async function getHubAutoSend(db: PrismaClient = defaultPrisma): Promise<HubAutoSendValue> {
  return (await getOwnerSetting("hubAutoSend", db)) as HubAutoSendValue;
}

export type AutoSendVerdict = { ok: true; category: string } | { ok: false; why: string };

/** Whether this draft may go out without a person pressing Approve, and if not, the first reason it may not. */
export async function evaluateAutoSend(message: HubMessage, thread: HubThread, db: PrismaClient = defaultPrisma): Promise<AutoSendVerdict> {
  const no = (why: string): AutoSendVerdict => ({ ok: false, why });
  if (message.status !== "pending_approval" || !AI_AUTHORS.has(message.authorType)) {
    return no("Only an AI draft waiting for approval can be auto-sent.");
  }
  const category = autoSendCategoryFor(message.category);
  if (!category) return no("This send type is not one that can be auto-sent.");
  // A message to a customer is outbound; an in-app post for the team (team_internal, training_reply) is internal.
  if (message.direction !== (category.customerFacing ? "outbound" : "internal")) {
    return no("Only an AI draft waiting for approval can be auto-sent.");
  }
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
  const actor = { key: `rule:${verdict.category}`, display: AUTO_SEND_ACTOR_NAME };
  const won = await db.$transaction(async (tx) => {
    const claim = await tx.hubMessage.updateMany({
      where: { id: messageId, status: "pending_approval", deletedAt: null },
      data: { status: "approved", decidedBy: actor.key, decidedAt, claimedAt: decidedAt, error: null },
    });
    if (claim.count === 0) return false;
    await hubAudit(tx, {
      actorKey: actor.key, actorDisplay: actor.display, action: "message_auto_approved", entityType: "message", entityId: messageId,
      threadId: message.threadId, messageId, afterText: `auto-approved by rule ${verdict.category}`,
      details: { category: verdict.category, channel: message.channel },
    });
    return true;
  });
  if (!won) return { autoApproved: false, why: "A person decided it first." };
  void emitHubEventSafe({ type: "approval.decided", messageId, status: "approved", actionKind: message.actionKind ?? "customer_message", resultIds: {} });
  return { autoApproved: true, category: verdict.category, send: await hubSend(messageId, actor, db) };
}
