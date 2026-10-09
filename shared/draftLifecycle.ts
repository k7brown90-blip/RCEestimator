/**
 * Where a draft stands in its life — issued or not, changed since, deletable or not — decided ONCE
 * on the server and read by both apps (2026-10-08, one-estimating-system plan, Phase 2 unit B).
 *
 * Kyle, 2026-10-08: the office and the truck are ONE estimating system. Before this each screen
 * worked "is there a live estimate?" out for itself: the CRM's Estimate Intake from the issued
 * list, the presentation screen not at all (it issued on every press), the field never (its
 * "Build the quote" only resumed a never-issued draft, so an edit after issue started a NEW draft
 * and a NEW estimate number). One server function — src/services/issuedEstimateService.ts
 * `getDraftLifecycle`, the SAME lookup `issueDraft` runs — now answers for every screen, in the
 * CRM review and compute payloads and in the field quote payload.
 *
 * Plain interfaces only — no TS enum, no constructor parameter properties — so the client and field
 * tsconfigs (erasableSyntaxOnly) accept this file as-is.
 */

/** The estimate that pressing Issue would REVISE: the newest one from this draft that is not superseded and not void. */
export interface DraftLifecycleIssued {
  estimateId: string;
  /** The house number, shared across revisions ("2026-1098"). */
  number: string;
  revision: number;
  /** IssuedEstimate.status — "draft" (issued, not yet sent), "sent", "viewed", "signed", "lost", "expired". */
  status: string;
  /** ISO timestamp of the customer's signature, or null while unsigned. */
  signedAt: string | null;
  /**
   * True when the estimate was put away (archived). The send refuses it ("Unarchive it first"), and
   * "live" for the issue door excludes only void, so an archived estimate still comes back here;
   * the screens grey "Email" with that reason before the press.
   */
  archived: boolean;
  /**
   * The tokenized customer page, for the technician's "Open the customer's estimate to review &
   * sign". Filled by the TECH route only (built with estimateLink, never the raw token); the CRM
   * reads the link from GET /issued-estimates/:id and gets null here.
   */
  customerUrl: string | null;
}

export interface DraftLifecycle {
  /** PriceBookDraftEstimate.status — "draft" (open, or reopened by an edit) or "finalized" (as issued). */
  status: string;
  /** Null until something has been issued from this draft (or everything issued from it is void). */
  issued: DraftLifecycleIssued | null;
  /**
   * True when the draft has been edited since `issued` was made: any edit reopens the draft
   * (status "draft" again), so pressing Issue / "Save changes to the estimate" would make a
   * revision that differs from what the customer holds. False when nothing changed — a press then
   * would only replace the customer's link with an identical copy, so the screens grey it.
   */
  hasUnsavedChanges: boolean;
  /**
   * Why "Save changes to the estimate" / "Edit the estimate" is refused to THIS app right now, or
   * null. The screens grey the button with it BEFORE the press.
   *
   * Kyle, 2026-10-09 (ruling 1): changing a SIGNED estimate is OFFICE ONLY, like void and mark-lost.
   * So the sentence depends on the door the payload is built for (getDraftLifecycle's `door`):
   *   - FIELD: signed -> FIELD_SIGNED_REVISE_REASON; lost -> "reopen it first".
   *   - CRM:   signed -> null (the office CAN revise a signed estimate; the customer signs the new
   *            revision); lost -> "reopen it first".
   */
  reviseReason: string | null;
  /**
   * Why "Delete this quote / draft" is refused, or null when the draft can go: once anything has
   * been issued from it the draft is that estimate's record, and the exit is on the estimate
   * (delete it while unsigned, void it, mark it lost — CRM, Estimates page).
   */
  deleteReason: string | null;
  /**
   * Why "Copy to new / Copy to a new quote" is refused, or null when the draft can be copied: a
   * change order or a diagnostic's resolutions draft cannot be copied into an ordinary quote — the
   * copy would take over as the visit's main quote (atomicEstimateService.draftCopyReason). Greyed
   * with this sentence, never hidden.
   */
  copyReason: string | null;
}

/**
 * The two reasons a draft cannot be copied into a new quote, worded ONCE (server: draftCopyReason in
 * atomicEstimateService; the CRM drawer uses the first to grey "Copy to new" on a change order
 * before the press).
 */
export const COPY_REFUSED_CHANGE_ORDER =
  "This is a change order, so it can't be copied into a new quote — the copy would stop being a " +
  "change order and take over as this job's quote. To change it, edit it here; to start again, " +
  "delete it and raise a new change order from the job.";
export const COPY_REFUSED_DIAGNOSTIC =
  "This quote belongs to a diagnostic report, so it can't be copied into a new quote — the copy " +
  "would take over as this job's quote. Edit it here, or build the job's quote from the job.";

/**
 * Why the field's "Save changes to the estimate" / "Edit the estimate" is greyed on a SIGNED
 * estimate - EXACTLY these words (Kyle, 2026-10-09, ruling 1).
 *
 * A DELIBERATE CRM-ONLY POWER, like void and mark-lost: the office revises a signed estimate
 * (reviseEstimate, POST /issued-estimates/:id/revise, Estimate Intake "Save changes to the
 * estimate"); the truck cannot, and raises a change order for new work instead. The field refuses
 * it in issueDraft (door "field") and greys the button with this sentence.
 */
export const FIELD_SIGNED_REVISE_REASON =
  "Signed — the office changes a signed estimate; raise a change order for new work";

/** The issue button's words when a live estimate exists, from this draft, in either app. */
export const SAVE_CHANGES_LABEL = "Save changes to the estimate";

/** Why "Save changes to the estimate" is greyed when nothing on the draft has changed since it was issued. */
export function nothingChangedReason(issued: Pick<DraftLifecycleIssued, "number" | "revision">): string {
  return (
    `Nothing has changed since estimate ${issued.number} rev ${issued.revision} was issued — saving would only ` +
    `replace the customer's link with an identical copy. Edit the quote first.`
  );
}
