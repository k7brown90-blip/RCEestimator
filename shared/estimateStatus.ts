/**
 * The issued-estimate status vocabulary — ONE definition, read by the server, the CRM client and
 * the tests (2026-09-20, drawers plan Phase 2 / PUNCHLIST E2).
 *
 * Before this file the vocabulary lived in a schema comment and every consumer hardcoded strings,
 * which is how "expired" came to be written by the nightly sweep (server.ts) without appearing in
 * the schema comment or in either of the client's two copies of the union. Nothing below is new
 * behaviour except LOST; the rest names what the code already wrote.
 *
 *   draft    issued, not yet emailed or presented
 *   sent     emailed to the customer
 *   viewed   the customer opened the link (a fact about a SENT estimate, not a separate stage)
 *   signed   the customer accepted — the sale
 *   expired  past its validity window unsigned (the sweep's relabel; the signature path refuses
 *            by date arithmetic regardless)
 *   lost     THE CUSTOMER DECIDED — hired someone else, or is not moving forward. Kyle, 2026-09-20.
 *            Stays in the win-rate denominator. Reversible ("reopen") because it is a judgement
 *            about the customer, not about the document.
 *   void     THE DOCUMENT IS DEAD — wrong price, superseded by hand, job cancelled. Leaves the
 *            denominator. Never reversible.
 *
 * VOID and LOST are different and must stay different: only LOST belongs in a win rate.
 */

export const ISSUED_ESTIMATE_STATUSES = ["draft", "sent", "viewed", "signed", "expired", "lost", "void"] as const;
export type IssuedEstimateStatus = (typeof ISSUED_ESTIMATE_STATUSES)[number];

/**
 * Where "lost" can be reached FROM. A draft never went out (delete it); a signed estimate is a
 * sale (void it); void is dead; lost is already lost. An EXPIRED estimate is a sent one the
 * customer let lapse — Kyle usually learns "we went with someone else" after the window, and the
 * funnel still needs that answer recorded.
 */
export const LOSABLE_STATUSES = ["sent", "viewed", "expired"] as const;

/** What the nightly expiry sweep may relabel. A lost estimate is never swept. */
export const EXPIRABLE_STATUSES = ["sent", "viewed"] as const;

/**
 * Why a lead — or now an estimate — was lost. THE SAME LIST FOR BOTH (Kyle's ruling, 2026-09-20):
 * two taxonomies would make the win/loss report add apples to oranges. `app.ts` re-exports this as
 * `LOST_REASONS` for the lead routes and the client as `LEAD_LOST_REASONS`.
 */
export const LOST_REASONS = ["price", "timing", "referral", "trust", "scope", "other"] as const;
export type LostReason = (typeof LOST_REASONS)[number];
