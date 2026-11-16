/**
 * THE BALLPARK ON A LEAD (Kyle, 2026-11-15, plan lead-intake-fixes F4).
 *
 * An online lead (Yelp, Nextdoor, Angi) often has no street address, so the office cannot start an
 * estimate for it the ordinary way (Account -> Property -> Create Estimate). Kyle chose to let a
 * lead hold ONE saved ballpark: a draft in the same Estimate Intake builder, tied to the lead,
 * that is never sent from the CRM, and that moves onto the consultation visit when the lead is
 * converted so the tech's field Quote screen opens that same draft.
 *
 * This narrows two of his earlier rulings and does not repeal them (constants.md, "LEADS,
 * CONSULTATIONS AND THE BALLPARK"). Every other estimate still starts Account -> Property -> Create.
 *
 * A draft is "a ballpark on a lead" when it has a lead and NO visit. The moment conversion gives
 * it a visit it is the job's quote and these rules stop applying.
 *
 * Server and CRM read the same words from here, so the greyed button and the refusal cannot differ.
 */

/** Why a ballpark on a lead cannot be issued, sent or emailed. Shown on screen and returned by the server. */
export const BALLPARK_ON_LEAD_REASON = "A ballpark on a lead can't be sent — convert the lead first";

/** The one line the ballpark carries on the lead, in the builder's header. */
export function ballparkHeaderLine(leadName: string | null | undefined): string {
  return `Ballpark for lead ${leadName?.trim() || "(unnamed lead)"} — it moves onto the job when the lead is converted.`;
}

/** Pure: is this draft a ballpark that still sits on a lead? */
export function isBallparkOnLead(draft: { leadId: string | null; visitId: string | null; changeOrderForId?: string | null }): boolean {
  return Boolean(draft.leadId) && !draft.visitId && !draft.changeOrderForId;
}

/** What GET /leads/:leadId carries for the lead's ballpark (the lead drawer and the lead page read it). */
export interface LeadBallpark {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  /** Set once the lead was converted: the ballpark is then the consultation's quote. */
  visitId: string | null;
  /** The draft's total when it can be worked out and means one number; otherwise null. */
  total: number | null;
  lineCount: number;
}
