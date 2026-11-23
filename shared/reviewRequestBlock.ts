/**
 * Why a review request cannot go out, worded ONCE (work order agent-team, TM0 and C6): the server's
 * reviewRequestBlockOf (src/services/reviewRequest.ts, which the email function, the agent tools and the CRM's
 * review panel all read) and the CRM's "Email the customer" panel (client PaymentPanel, which greys the Review
 * request choice before anyone presses it) import these sentences from here, so the two can never drift.
 *
 * The codes are exactly these four. There is NO repeat-customer window (removed 2026-11-21) and NO filter on
 * "Customer happy?" (addendum v2, Kyle T3): a completed job with an email on file, not yet asked, is askable
 * whatever the customer said. Order: not complete, already asked, no email, automation off (a manual press
 * skips only the last).
 */
export type ReviewBlockCode = "not_complete" | "already_asked_job" | "no_email" | "automation_off";

export const REVIEW_BLOCK_SENTENCES = {
  not_complete: "This job is not marked complete yet.",
  already_asked_job: "A review request has already been sent for this job.",
  no_email: (customerName: string): string => `No email on file for ${customerName} — add one to the account first.`,
  automation_off: "Review requests are not sending automatically right now.",
} as const;

export interface ReviewBlockFacts {
  status: string;
  /** Anything truthy means the ask already went (a Date on the server, an ISO string in the CRM). */
  reviewRequestedAt: unknown;
  /** The customer's email on file, or null. */
  email: string | null;
  customerName: string;
  /** The caller typed a recipient, so a missing account email does not block. */
  hasToOverride?: boolean;
  /** A human pressed the button: the automation gate does not apply. */
  manual?: boolean;
  /** Whether review requests may go out on their own (the server's automation gate). */
  automationOn: boolean;
}

/** The first thing that blocks the ask, or null. The ONE ordering of the four codes. */
export function reviewBlockCodeOf(f: ReviewBlockFacts): ReviewBlockCode | null {
  if (f.status !== "completed") return "not_complete";
  if (f.reviewRequestedAt) return "already_asked_job";
  if (!f.email && !f.hasToOverride) return "no_email";
  if (!f.manual && !f.automationOn) return "automation_off";
  return null;
}

/** The sentence for a code. */
export function reviewBlockReason(code: ReviewBlockCode, customerName: string): string {
  return code === "no_email" ? REVIEW_BLOCK_SENTENCES.no_email(customerName) : REVIEW_BLOCK_SENTENCES[code];
}
