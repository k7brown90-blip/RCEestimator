/**
 * An AI agent's PROPOSED change to an existing price-book item (Kyle, 2026-11-24: "proposed edits to EXISTING items (price, hours, name).
 * Nothing changes until Kyle or Michael approves it in the UI"; 2026-11-25: Michael — "Yes, same power").
 *
 * ONE approval mechanism, no second queue: a proposal is a CARD in the Messages hub, a HubMessage of kind `price_change`
 * (shared/hub/cards.ts, the registry in services/hubActions/registry.ts). It shows in the CRM at Messages -> "Waiting for approval" and on the
 * field app's "Waiting for approval" list, drawn by the one ApprovalCard in each app. This file is the kind's three parts:
 *
 *   insertPriceChangeCard  what the agent door does: the card row, in the door's own transaction. The card is made here, NOT through
 *                          postMessageResult or createDraftMessage, so it can never be published or sent by an agent's own request (publishTeamPost and
 *                          sendAgentMessageNow, services/hubAgentSend.ts, are only ever called on a post or message that went through those
 *                          writers). A price change is the ONE thing an agent's request does not approve (Kyle 2026-11-24): it waits for a person.
 *   describePriceChange    what the card says, built from the DATABASE at the moment it is read - the item as it stands now, the sell
 *                          prices before and after (planAtomicUpdate: the book's one pricing computation, dry run) and every assembly the
 *                          change moves and by how much (findAssemblyImpacts; Kyle 2026-09-12: "must show which assemblies it moves, and by
 *                          how much, BEFORE it is accepted"). Never the agent's words, except a proposed NAME, which is the thing proposed.
 *   runPriceChange         what Approve does: applyApprovedPriceChange (the item's update through the book's guarded path and the assembly
 *                          cascade, one transaction), then the card settles as posted with its audit row. A change that cannot be applied
 *                          (the item was retired, an assembly guard) settles the card as failed with the reason, and Reject is still there.
 *
 * WHO MAY APPROVE OR REJECT: whoever holds the price_book_edit power (Kyle's, granted to Michael at Team -> CRM login), IN PLACE OF approve_drafts
 * (Kyle 2026-11-25, "Yes, same power"). The rule is per kind (CardKindEntry.approverPower, enforced in services/hubApproval.ts for Approve, Edit
 * and Reject) and the card says why its buttons are greyed for anyone who lacks it. approve_drafts alone does not decide a price change.
 *
 * Where the card lives: one Team-kind thread titled "Price book changes", belonging to no person (technicianId null), so no technician's
 * phone lists it; the office sees every thread and the agents that read Team chats can read it.
 */
import type { HubMessage, Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { HubError, SYSTEM_ACTOR, bumpThreadForMessage, createMessageRow, hubAudit } from "./hub";
import { announceDecision } from "./hubBus";
import { planAtomicUpdate } from "./priceBookCatalog";
import {
  PRICE_CHANGE_KIND, PROPOSABLE_FIELDS, agentEditorName, parsePriceChangePayload, patchOf, serializePriceChangePayload,
  type PriceChangePayload, type ProposableField,
} from "./priceBookProposalPayload";

import { applyApprovedPriceChange, findAssemblyImpacts } from "./priceBookRefresh";
import type { LaborTier } from "./priceBookAssembly";
import type { CardDescription, DescribeCtx } from "./hubActions/registry";
import type { SendActor, SendResult } from "./hubSend";

export { PRICE_CHANGE_KIND, PROPOSABLE_FIELDS, agentEditorName, parsePriceChangePayload, patchOf };
export type { PriceChangePayload, ProposableField };

export const PRICE_BOOK_THREAD_ID = "pricebook-changes";
export const PRICE_BOOK_THREAD_TITLE = "Price book changes";

// ── the thread ───────────────────────────────────────────────────────────────────────────────────

/** The one thread the cards live in, made on first use. Two callers racing: the fixed id keeps one and the loser reads it. */
export async function ensurePriceBookThread(db: PrismaClient = defaultPrisma): Promise<string> {
  const existing = await db.hubThread.findUnique({ where: { id: PRICE_BOOK_THREAD_ID }, select: { id: true } });
  if (existing) return existing.id;
  try {
    await db.hubThread.create({ data: { id: PRICE_BOOK_THREAD_ID, kind: "team", title: PRICE_BOOK_THREAD_TITLE } });
    await hubAudit(db, {
      actorKey: SYSTEM_ACTOR.key, actorDisplay: SYSTEM_ACTOR.display, action: "thread_created", entityType: "thread",
      entityId: PRICE_BOOK_THREAD_ID, threadId: PRICE_BOOK_THREAD_ID, details: { kind: "team", purpose: "price_book_changes" },
    });
  } catch (err) {
    const raced = await db.hubThread.findUnique({ where: { id: PRICE_BOOK_THREAD_ID }, select: { id: true } });
    if (!raced) throw err;
  }
  return PRICE_BOOK_THREAD_ID;
}

// ── making the card ──────────────────────────────────────────────────────────────────────────────

const FIELD_WORDS: Record<ProposableField, string> = {
  description: "name",
  companyCost: "cost",
  laborNormal: "normal hours",
  laborDifficult: "difficult hours",
  laborVeryDifficult: "very difficult hours",
};

export interface NewPriceChangeCard {
  threadId: string;
  itemId: string;
  proposed: PriceChangePayload["proposed"];
  principal: { keyId: string; name: string; role: string };
}

/**
 * The card row, its message audit row and the thread's activity time, in the caller's transaction. The body is built here from the field
 * names alone (never from the agent's words): the numbers and the assemblies are on the card, computed when it is read.
 */
export async function insertPriceChangeCard(tx: Prisma.TransactionClient, input: NewPriceChangeCard): Promise<HubMessage> {
  const fields = PROPOSABLE_FIELDS.filter((f) => input.proposed[f] !== undefined).map((f) => FIELD_WORDS[f]);
  const payload: PriceChangePayload = { v: 1, itemId: input.itemId, proposed: input.proposed, keyId: input.principal.keyId, keyName: input.principal.name };
  const row = await createMessageRow(tx, {
    threadId: input.threadId,
    authorType: input.principal.role === "claude_code" ? "claude" : "ai_agent",
    authorKey: `agent:${input.principal.keyId}`,
    authorBotKeyId: input.principal.keyId,
    authorDisplay: input.principal.name,
    channel: "in_app",
    direction: "internal",
    status: "pending_approval",
    body: `Price book change proposed for ${input.itemId}: ${fields.join(", ")}.`,
    actionKind: PRICE_CHANGE_KIND,
    actionPayloadJson: serializePriceChangePayload(payload),
  });
  const actor = { key: `agent:${input.principal.keyId}`, display: input.principal.name };
  await bumpThreadForMessage(tx, input.threadId, row, actor);
  await hubAudit(tx, {
    actorKey: actor.key, actorDisplay: actor.display, action: "price_change_proposed", entityType: "message", entityId: row.id,
    threadId: input.threadId, messageId: row.id, afterText: row.body, details: { itemId: input.itemId, fields: Object.keys(input.proposed) },
  });
  return row;
}

// ── what the card says ───────────────────────────────────────────────────────────────────────────

const money = (n: number | null | undefined): string => (n === null || n === undefined ? "none" : `$${n.toFixed(2)}`);
const hoursText = (n: number | null | undefined): string => (n === null || n === undefined ? "blank" : String(n));

/** The audit fields a card shows, in this order, with the words Kyle reads. */
const SHOWN: Array<{ field: string; label: string; kind: "text" | "money" | "hours" }> = [
  { field: "description", label: "Name", kind: "text" },
  { field: "companyCost", label: "Cost (before tax)", kind: "money" },
  { field: "laborNormal", label: "Normal hours", kind: "hours" },
  { field: "laborDifficult", label: "Difficult hours", kind: "hours" },
  { field: "laborVeryDifficult", label: "Very difficult hours", kind: "hours" },
  { field: "companyCostWithTax", label: "Cost with sales tax", kind: "money" },
  { field: "companyPrice", label: "Material price with markup (tax in)", kind: "money" },
  { field: "sellNormal", label: "Sell — normal", kind: "money" },
  { field: "sellDifficult", label: "Sell — difficult", kind: "money" },
  { field: "sellVeryDifficult", label: "Sell — very difficult", kind: "money" },
];

function shown(kind: "text" | "money" | "hours", value: string | null): string {
  if (value === null) return kind === "money" ? "none" : "blank";
  if (kind === "text") return `"${value}"`;
  return kind === "money" ? money(Number(value)) : hoursText(Number(value));
}

const BLOCKED_NO_CHANGE = "This card has no change attached, so it cannot be approved.";
const EDIT_BLOCKED = "A price change cannot be edited. Reject it and ask the agent to propose it again.";

export async function describePriceChange({ message, db }: DescribeCtx): Promise<CardDescription> {
  const base = {
    headerLine: "Price book change",
    chip: { tone: "internal" as const, text: "Changes the price book — never reaches a customer" },
    approveLabel: "Approve change",
    confirm: "Change the price book as shown on this card?",
    editBlockedReason: EDIT_BLOCKED,
    editable: { subject: false, to: false, cc: false },
  };
  const payload = parsePriceChangePayload(message.actionPayloadJson);
  if (!payload) return { ...base, effectLines: [], blockedReason: BLOCKED_NO_CHANGE };

  const item = await db.priceBookAtomic.findUnique({ where: { itemId: payload.itemId } });
  const header = { ...base, headerLine: `Price book change · ${payload.itemId}` };
  if (!item) return { ...header, effectLines: [], blockedReason: `${payload.itemId} is no longer in the price book.` };
  if (item.retiredAt) return { ...header, effectLines: [`${payload.itemId} — ${item.description ?? ""}`], blockedReason: `${payload.itemId} has been retired, so its price cannot be changed.` };

  const patch = patchOf(payload);
  const plan = await planAtomicUpdate(db, payload.itemId, patch);
  if (!plan.ok) return { ...header, effectLines: [`${payload.itemId} — ${item.description ?? ""}`], blockedReason: plan.reason };

  const lines: string[] = [`${payload.itemId} — ${item.description ?? ""} (as it stands now)`];
  if (plan.noop) {
    lines.push("Nothing would change: the item already has these values.");
    return { ...header, effectLines: lines, blockedReason: null };
  }
  for (const s of SHOWN) {
    const a = plan.plan.audits.find((x) => x.field === s.field);
    if (a) lines.push(`${s.label}: ${shown(s.kind, a.oldValue)} → ${shown(s.kind, a.newValue)}`);
  }

  // Which assemblies this moves, and by how much: the same computation the cascade runs when it is approved.
  const costChange = plan.plan.audits.find((a) => a.field === "companyCost");
  const hourChanges: Partial<Record<LaborTier, number | null>> = {};
  for (const tier of ["laborNormal", "laborDifficult", "laborVeryDifficult"] as const) {
    const a = plan.plan.audits.find((x) => x.field === tier);
    if (a) hourChanges[tier] = a.newValue === null ? null : Number(a.newValue);
  }
  if (costChange || Object.keys(hourChanges).length > 0) {
    const impacts = await findAssemblyImpacts(db, payload.itemId, costChange ? (costChange.newValue === null ? null : Number(costChange.newValue)) : null, hourChanges);
    if (impacts.length === 0) {
      lines.push("No assembly uses this item, so no assembly moves.");
    } else {
      for (const i of impacts) {
        const delta = i.delta === null ? "" : ` (${i.delta >= 0 ? "+" : "-"}$${Math.abs(i.delta).toFixed(2)})`;
        // Every tier the change can move: an hours change moves the sell tiers and the assembly's own hours, not its cost (Kyle 2026-09-12: "which
        // assemblies it moves, and by how much, BEFORE it is accepted").
        const sells = [
          `sell normal ${money(i.currentSellNormal)} → ${money(i.projectedSellNormal)}`,
          `sell difficult ${money(i.currentSellDifficult)} → ${money(i.projectedSellDifficult)}`,
          `sell very difficult ${money(i.currentSellVeryDifficult)} → ${money(i.projectedSellVeryDifficult)}`,
        ].join("; ");
        const moved = (["laborNormal", "laborDifficult", "laborVeryDifficult"] as const).filter((t) => i.currentHours[t] !== i.projectedHours[t]);
        const hours = moved.length === 0 ? "" : `; hours ${moved.map((t) => `${FIELD_WORDS[t].replace(" hours", "")} ${hoursText(i.currentHours[t])} → ${hoursText(i.projectedHours[t])}`).join(", ")}`;
        lines.push(
          `Moves assembly ${i.assemblyItemId}${i.assemblyDescription ? ` — ${i.assemblyDescription}` : ""}: cost ${money(i.currentCost)} → ${money(i.projectedCost)}${delta}; ${sells}${hours}`,
        );
      }
    }
  }
  return { ...header, effectLines: lines, blockedReason: null };
}

// ── what Reject does ───────────────────────────────────────────────────────────────────────────────

/**
 * Reject's record on the item (the registry's onReject, in Reject's own transaction): one PriceBookEdit row, so the item's history ends the
 * proposal it began ("proposed:<field>") with who turned it down and why. The price book itself is untouched.
 */
export async function recordPriceChangeRejected(tx: Prisma.TransactionClient, message: HubMessage, rejectedBy: string, reason: string): Promise<void> {
  const payload = parsePriceChangePayload(message.actionPayloadJson);
  if (!payload) return;
  await tx.priceBookEdit.create({
    data: {
      itemId: payload.itemId, field: "priceChangeRejected", oldValue: null, newValue: PROPOSABLE_FIELDS.filter((f) => payload.proposed[f] !== undefined).join(", "),
      editedBy: agentEditorName(payload.keyName),
      note: `Rejected by ${rejectedBy}: ${reason} (card ${message.id}); proposed by agent key "${payload.keyName}". The price book was not changed.`,
    },
  });
}

// ── what Approve does ────────────────────────────────────────────────────────────────────────────

/**
 * Approve's work, run by services/hubApproval.ts AFTER it claimed the card (status approved). Applies the change, then settles the card:
 * posted (with a price_change_applied audit row) or failed with the reason. Never throws for a refusal; a database error propagates and
 * the approval code settles the card as failed, as it does for every kind.
 */
export async function runPriceChange(messageId: string, actor: SendActor, db: PrismaClient = defaultPrisma): Promise<SendResult> {
  const message = await db.hubMessage.findUnique({ where: { id: messageId } });
  if (!message) throw new HubError("Message not found", 404);
  const payload = parsePriceChangePayload(message.actionPayloadJson);

  const settleFailed = async (reason: string): Promise<SendResult> => {
    const error = reason.slice(0, 300);
    await db.$transaction(async (tx) => {
      const moved = await tx.hubMessage.updateMany({ where: { id: messageId, status: "approved" }, data: { status: "failed", error, claimedAt: null } });
      if (moved.count === 0) return;
      // The item's own history says the approved change did not apply, and why (the proposal row alone would read as still open).
      if (payload) {
        await tx.priceBookEdit.create({
          data: {
            itemId: payload.itemId, field: "priceChangeFailed", oldValue: null, newValue: null, editedBy: agentEditorName(payload.keyName),
            note: `Approved by ${actor.display}, but the price book was not changed: ${error} (card ${messageId}); proposed by agent key "${payload.keyName}".`,
          },
        });
      }
      await hubAudit(tx, {
        actorKey: actor.key, actorDisplay: actor.display, action: "message_send_failed", entityType: "message", entityId: messageId,
        threadId: message.threadId, messageId, afterText: error, details: { kind: PRICE_CHANGE_KIND },
      });
    });
    announceDecision(messageId);
    return { messageId, status: "failed", error };
  };

  if (!payload) return settleFailed(BLOCKED_NO_CHANGE);
  const result = await applyApprovedPriceChange(
    db, payload.itemId, patchOf(payload), agentEditorName(payload.keyName),
    `Approved by ${actor.display}; proposed by key "${payload.keyName}" (card ${messageId}).`,
  );
  if (!result.ok) return settleFailed(result.reason);

  await db.$transaction(async (tx) => {
    const moved = await tx.hubMessage.updateMany({ where: { id: messageId, status: "approved" }, data: { status: "posted", error: null, claimedAt: null, sentAt: new Date() } });
    if (moved.count === 0) return;
    await hubAudit(tx, {
      actorKey: actor.key, actorDisplay: actor.display, action: "price_change_applied", entityType: "message", entityId: messageId,
      threadId: message.threadId, messageId,
      afterText: result.changed.length === 0 ? "No change: the item already had these values." : `Changed ${result.changed.map((c) => c.field).join(", ")}.`,
      details: { itemId: payload.itemId, changed: result.changed.map((c) => c.field), assemblies: result.cascadedAssemblies.map((a) => a.assemblyItemId), proposedBy: payload.keyName },
    });
  });
  announceDecision(messageId);
  return { messageId, status: "posted", error: null };
}
