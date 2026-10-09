/**
 * What "Email to customer" / "Sign now" on the presentation screen will DO, decided from the
 * draft's lifecycle the server sent (2026-10-08 audit §5, one-estimating-system plan Phase 2).
 *
 * The bug: both buttons called pbIssue on every press. On a draft that was already issued and not
 * touched since, each press made a NEW revision — same number, revision +1, the customer's old link
 * dead — for a document that had not changed. Kyle pressing "Email to customer" twice shipped two
 * revisions of one estimate.
 *
 * SHARED (Phase 3 unit B, 2026-10-08): this was client/src/lib/presentIssue.ts. The field app's "Show
 * the customer" screen asks the SAME function before its "Sign now", so the phone and the office
 * issue-or-reuse by one rule (Kyle: one estimating system). Plain functions only.
 *
 * The rule, in one place so the page cannot drift from the server's own answer
 * (shared/draftLifecycle.ts, from issuedEstimateService.getDraftLifecycle):
 *
 *   no estimate yet, or the draft changed since it was issued → ISSUE (a first estimate, or a
 *     revision carrying the edits — the server's issueDraft decides which);
 *   issued and unchanged → REUSE the estimate that exists, as it stands;
 *   lost → BLOCKED: "reopen it first" (the same refusal the server would answer with).
 *
 * "Sign now" on a signed estimate has nothing to sign, and "Email to customer" on a signed or archived
 * one has nothing to send: the server's send refuses both ("already signed", "Unarchive it first"),
 * so both buttons are greyed WITH those words before the press (2026-10-08 review).
 */

import type { DraftLifecycle } from "./draftLifecycle";

export type PresentDecision =
  | { kind: "issue"; revises: { number: string; revision: number } | null }
  | {
      kind: "reuse";
      estimateId: string;
      number: string;
      revision: number;
      signed: boolean;
      archived: boolean;
      /** The draft was edited after this estimate was issued (a signed one is not re-issued from here, so the edits are NOT on it). */
      changedSince: boolean;
    }
  | { kind: "blocked"; reason: string };

export function presentDecision(lifecycle: DraftLifecycle | null | undefined): PresentDecision {
  const issued = lifecycle?.issued ?? null;
  if (!issued) return { kind: "issue", revises: null };
  if (issued.status === "lost") {
    return { kind: "blocked", reason: lifecycle?.reviseReason ?? `Estimate ${issued.number} is marked lost — reopen it before changing or issuing it again.` };
  }
  if (lifecycle?.hasUnsavedChanges && !issued.signedAt) {
    return { kind: "issue", revises: { number: issued.number, revision: issued.revision } };
  }
  // Unchanged — or signed: a signed estimate is never re-issued from here (the server refuses;
  // the office's own Revise button is the deliberate path), so it is used as it stands.
  return {
    kind: "reuse",
    estimateId: issued.estimateId,
    number: issued.number,
    revision: issued.revision,
    signed: Boolean(issued.signedAt),
    archived: Boolean(issued.archived),
    changedSince: Boolean(lifecycle?.hasUnsavedChanges),
  };
}

/** Why "Sign now" is greyed, or null when it is live. */
export function signNowReason(d: PresentDecision): string | null {
  if (d.kind === "blocked") return d.reason;
  if (d.kind === "reuse" && d.signed) return `Estimate ${d.number} is already signed — there is nothing to sign.`;
  return null;
}

/** Why "Email to customer" is greyed, or null when it is live. */
export function emailReason(d: PresentDecision): string | null {
  if (d.kind === "blocked") return d.reason;
  if (d.kind === "reuse" && d.signed) return `Estimate ${d.number} is already signed — there is no estimate email left to send.`;
  if (d.kind === "reuse" && d.archived) return `Estimate ${d.number} is archived — unarchive it (Estimates page) first, then it can be emailed.`;
  return null;
}

/** The line under the two buttons: what pressing either one records. */
export function presentFooter(d: PresentDecision): string {
  switch (d.kind) {
    case "issue":
      return d.revises
        ? `Either action saves your changes to estimate ${d.revises.number} as revision ${d.revises.revision + 1} (same number) and replaces the customer's link.`
        : "Either action records the estimate and freezes its prices. Nothing is frozen before then.";
    case "reuse":
      if (d.changedSince) {
        return `Estimate ${d.number} rev ${d.revision} is already recorded, and the draft has been edited since — those edits are not on it. These use the estimate as it stands.`;
      }
      return `Estimate ${d.number} rev ${d.revision} is already recorded and nothing has changed since — these use it as it stands.`;
    case "blocked":
      return d.reason;
  }
}
