/**
 * The approval-card registry (work order agent-team, TC1): one entry per card KIND, each with
 * describe() and run(). ONE card component (client/src/components/ApprovalCard.tsx) draws every kind;
 * what a kind says and does is registered HERE, so a new kind (stock drafts, a booking, a campaign) is an
 * entry, not a new screen.
 *
 *   describe(ctx)  what the card says: the header line, the "When you approve" lines, the chip, the button
 *                  words, and why Approve is greyed. Derived ONLY from the database and the frozen
 *                  columns (channel, messageClass, purposeKey, category) plus the SMS switch - never from
 *                  words an agent wrote - so a draft cannot describe itself as harmless.
 *   run(id, actor) what Approve does once the decision is made: the existing service, never new logic.
 *                  customer_message and team_reply both go out through hubSend.
 *
 * Kinds built now: customer_message, team_reply. contact_instead and opt_out_review are REGISTERED for
 * step 6 (P2B-3/7/8): they appear in shared/hub/cards.ts with implemented false and have no `run`, so an
 * Approve on one is refused ("not handled yet") and nothing can be sent through them by accident. The
 * columns they need (HubMessage.actionKind, actionPayloadJson) already exist from U1, so step 6 adds an
 * entry here and no migration.
 */
import type { HubMessage, HubThread } from "@prisma/client";
import { cardHeaderLine, CARD_KINDS, isCardKind, type CardKind } from "../../../shared/hub/cards";
import { SMS_DISABLED_ERROR, isEditFixableReason, sendBlockText } from "../../../shared/hub/sendBlocks";
import { twilioSendEnabled } from "../automationGate";
import { REHEARSAL_CARD_LINE } from "../rehearsal";
import { hubSend, type Recipient, type SendActor, type SendResult, type SmsPrepared } from "../hubSend";

export interface DescribeCtx {
  message: HubMessage;
  thread: HubThread;
  recipient: Recipient | null;
  /** The text's preflight (prepareSms) when the message is a text; null otherwise. */
  sms: SmsPrepared | null;
}

export interface CardDescription {
  headerLine: string;
  effectLines: string[];
  chip: { tone: "customer" | "internal"; text: string };
  approveLabel: string;
  confirm: string;
  /** Why Approve and "Send my version" are greyed whoever is signed in. Null when they are live. */
  blockedReason: string | null;
  /** Why Edit and "Send my version" are greyed: only for a reason an edit cannot cure. Null when editing can fix it. */
  editBlockedReason: string | null;
  editable: { subject: boolean; to: boolean; cc: boolean };
}

export interface CardKindEntry {
  describe(ctx: DescribeCtx): CardDescription;
  /** What Approve runs once the message is approved. Absent for a kind this build does not handle yet. */
  run?: (messageId: string, actor: SendActor) => Promise<SendResult>;
}

/** The kind of a message: its stored actionKind when it has one, else worked out from its channel. */
export function kindOfMessage(m: Pick<HubMessage, "actionKind" | "channel">): string {
  if (m.actionKind) return m.actionKind;
  return m.channel === "email" || m.channel === "sms" ? "customer_message" : "team_reply";
}

const NEVER_REACHES_CUSTOMER = "Internal only — never reaches a customer";

function describeCustomerMessage(ctx: DescribeCtx): CardDescription {
  const { message, recipient } = ctx;
  const name = recipient?.name ?? "the customer";
  const headerLine = cardHeaderLine(message);
  const described = describeForCustomer(ctx, name, headerLine);
  // The office's TEST ACCOUNT (TC10): the card says so in the same words before and after, and Approve rehearses.
  if (recipient?.testAccount) {
    return {
      ...described,
      effectLines: [REHEARSAL_CARD_LINE, "Approving still checks the message and files it in the Conversation, exactly as for a real customer."],
      chip: { tone: "internal", text: REHEARSAL_CARD_LINE },
      confirm: `Rehearse this for ${name}? ${REHEARSAL_CARD_LINE}.`,
    };
  }
  return described;
}

function describeForCustomer({ message, recipient, sms }: DescribeCtx, name: string, headerLine: string): CardDescription {
  if (message.channel === "sms") {
    const legOn = twilioSendEnabled("hubSms");
    // A held text ("Approved — SMS disabled") cannot be sent again while texting is still off: Send now is greyed.
    const held = message.status === "approved" && message.error === SMS_DISABLED_ERROR;
    const blockedReason = sms && !sms.ok
      ? sendBlockText(sms.reason)
      : held && !legOn
        ? "Texting is turned off. This text goes out once texting is turned on."
        : null;
    return {
      headerLine,
      effectLines: [
        `Texts ${name} the words under "Sends as:".`,
        legOn
          ? "Goes out the moment you approve."
          : "Texting is turned off, so Approve holds it as \"Approved — SMS disabled\" and nothing is sent until texting is turned on.",
      ],
      chip: { tone: "customer", text: legOn ? "This will text the customer" : "Texting is off — this will not be sent yet" },
      approveLabel: "Approve and send",
      confirm: `Text this to ${name}? It goes to the customer.`,
      blockedReason,
      editBlockedReason: sms && !sms.ok && !isEditFixableReason(sms.reason) ? sendBlockText(sms.reason) : null,
      editable: { subject: false, to: false, cc: false },
    };
  }
  const address = message.toAddress?.trim() || recipient?.email || null;
  return {
    headerLine,
    effectLines: [
      address ? `Emails ${name} at ${address} from Red Cedar Electric.` : `Emails ${name}.`,
      "The email is filed in the account's Conversation with its delivery status.",
    ],
    chip: { tone: "customer", text: "This will email the customer" },
    approveLabel: "Approve and send",
    confirm: `Send this email to ${name}${address ? ` (${address})` : ""}? It goes to the customer.`,
    blockedReason: address ? null : "There is no email address on file for this customer. Edit the draft and type one.",
    // Typing an address in Edit is the remedy, so Edit stays live.
    editBlockedReason: null,
    editable: { subject: true, to: true, cc: true },
  };
}

function describeTeamReply({ message }: DescribeCtx): CardDescription {
  return {
    headerLine: cardHeaderLine(message),
    effectLines: ["Posts this message in the conversation under the AI author's name."],
    chip: { tone: "internal", text: NEVER_REACHES_CUSTOMER },
    approveLabel: "Approve and post",
    confirm: "Post this in the conversation?",
    blockedReason: null,
    editBlockedReason: null,
    editable: { subject: false, to: false, cc: false },
  };
}

const NOT_YET = "This kind of card is handled in a later step, so it cannot be approved here yet.";

function describeNotYet(kind: CardKind) {
  return ({ message }: DescribeCtx): CardDescription => ({
    headerLine: `${CARD_KINDS[kind].label}${message.channel === "sms" ? " · Text" : ""}`,
    effectLines: [],
    chip: { tone: "internal", text: NEVER_REACHES_CUSTOMER },
    approveLabel: "Approve",
    confirm: "Approve this?",
    blockedReason: NOT_YET,
    editBlockedReason: NOT_YET,
    editable: { subject: false, to: false, cc: false },
  });
}

const run = (messageId: string, actor: SendActor) => hubSend(messageId, actor);

export const CARD_REGISTRY: Record<CardKind, CardKindEntry> = {
  customer_message: { describe: describeCustomerMessage, run },
  team_reply: { describe: describeTeamReply, run },
  // Step 6 (P2B-3/7/8) adds `run` and a real describe; until then they are listed and cannot be approved.
  contact_instead: { describe: describeNotYet("contact_instead") },
  opt_out_review: { describe: describeNotYet("opt_out_review") },
};

/** The registry entry for a message's kind, or null when the stored kind is one this build has never heard of. */
export function entryFor(m: Pick<HubMessage, "actionKind" | "channel">): { kind: string; entry: CardKindEntry | null } {
  const kind = kindOfMessage(m);
  return { kind, entry: isCardKind(kind) ? CARD_REGISTRY[kind] : null };
}
