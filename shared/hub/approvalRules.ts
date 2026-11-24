/**
 * The approval card's RULES, defined once for both apps (work order agent-team, U4 + U10; CLAUDE.md "one estimating
 * system, two doors" applied to approvals). The CRM draws the card in client/src/components/ApprovalCard.tsx and the
 * field app in field/src/ui/components/ApprovalCard.tsx; they are two screens, but what they grey, why, and what a
 * button says come from here, so the two cannot drift: the field's Approve is greyed with the very sentence the server
 * put in approve.blockedReason / editBlockedReason, and an approver sees the same buttons on a phone as at a desk.
 *
 * Nothing here decides who may approve. That is the approve_drafts power (the server's canApprove, and
 * ApprovalsResponse.canApprove for the screen); the screens only print what the server said.
 */
import type { ApprovalCardView } from "./views";

/**
 * The ONE name of "a draft is waiting for a person to decide it", read by both apps (Kyle 2026-11-23 item 6: "waiting for approval"):
 * the CRM's Messages chip, its per-thread chip and its status chip, and the field app's chip at the top of Messages, its home button
 * and its screen heading. It replaces the two older wordings ("Needs approval" in both apps) so they cannot drift apart again.
 */
export const WAITING_FOR_APPROVAL = "Waiting for approval";
/** The chip with its count: "Waiting for approval (3)". */
export const waitingForApprovalLabel = (n: number): string => `${WAITING_FOR_APPROVAL} (${n})`;

/** "Approved — SMS disabled": a text approved while texting is off. It has "Send now" and Reject. */
export const SMS_HELD_OUTCOME = "Approved — SMS disabled";

/** Why "Reject draft" stays greyed until a reason is typed. */
export const REJECT_FIRST_HINT = "Type a reason first";
/** The shortest reason the server takes. */
export const REJECT_REASON_MIN = 3;

/** Statuses with buttons: a draft waiting, a failed send to try again, a text held because texting is off. */
export const isActionable = (card: Pick<ApprovalCardView, "status" | "outcome">): boolean =>
  card.status === "pending_approval" || card.status === "failed" || (card.status === "approved" && card.outcome.text === SMS_HELD_OUTCOME);

const EXIT_STATES = new Set(["pending_approval", "failed", "approved"]);
/** Statuses a card stays on the screen for, with its reason: waiting, held, failed and refused. */
export const isOpenCard = (status: string): boolean => EXIT_STATES.has(status) || status === "blocked" || status === "approving";

export interface CardLocks {
  /** Why Approve is greyed, or null. The session's power first, then the card's own reason. */
  lock: string | null;
  /** Why Edit and "Send my version" are greyed, or null. A draft blocked only by its own words keeps Edit live: Edit is the remedy. */
  editLock: string | null;
  /** Why Reject is greyed, or null. Only the power: a reason is typed afterwards. */
  rejectLock: string | null;
  /** The Approve button's words: "Try sending again" for a failed send, "Send now" for a held text, else the kind's own. */
  approveLabel: string;
}

export function cardLocks(card: Pick<ApprovalCardView, "status" | "approve">, canApprove: boolean, approveReason: string | null): CardLocks {
  const power = approveReason ?? "";
  return {
    lock: !canApprove ? approveReason : card.approve.blockedReason,
    editLock: !canApprove ? approveReason : card.approve.editBlockedReason,
    rejectLock: !canApprove ? power : null,
    approveLabel: card.status === "failed" ? "Try sending again" : card.status === "approved" ? "Send now" : card.approve.label,
  };
}
