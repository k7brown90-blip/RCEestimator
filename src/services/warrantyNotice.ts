/**
 * The customer-facing wording for a home-warranty claim on an estimate — ONE
 * source for the page, the signed copy, the invoice, the PDF, and the emails,
 * so no two surfaces can describe the same claim differently.
 *
 * Kyle, 2026-09-09: "The warranty company is covering $370 of this bill. I
 * need to get a signature from the home owner first to clarify they owe the
 * remainder and be able to show on the invoice sent to her that the warranty
 * is covering what ever their chosen amount is with the claim number."
 *
 * The notice carries the RELY Service Provider agreement clause B(f) points
 * for non-covered work — the homeowner may choose their own technician; Red
 * Cedar does the non-covered work on its own, apart from the warranty company;
 * the warranty company is not responsible for Red Cedar's rates on it; and the
 * signed document is the written estimate/authorization for it — plus the
 * 45-day fallback and where coverage questions go. Ratified wording; do not
 * paraphrase.
 */

import type { WarrantyClaim } from "./stripePayments";

/** "Warranty coverage — RELY Home, claim 343467219, auth auth45978673 · billed to RELY Home" */
export function warrantyRowLabel(claim: Pick<WarrantyClaim, "company" | "claimNumber" | "authNumber">): string {
  return (
    `Warranty coverage — ${claim.company}, claim ${claim.claimNumber}` +
    `${claim.authNumber ? `, auth ${claim.authNumber}` : ""} · billed to ${claim.company}`
  );
}

/** The one-line form for emails: "Warranty coverage (RELY Home, claim 343467219): −$370.00 · billed to RELY Home". */
export function warrantyEmailLine(
  claim: Pick<WarrantyClaim, "company" | "claimNumber">,
  applied: number,
): string {
  return `Warranty coverage (${claim.company}, claim ${claim.claimNumber}): −$${applied.toFixed(2)} · billed to ${claim.company}`;
}

/** The company-copy header line. */
export function warrantyCompanyLine(claim: WarrantyClaim, applied: number): string {
  return (
    `Warranty: ${claim.company} claim ${claim.claimNumber}` +
    `${claim.authNumber ? ` auth ${claim.authNumber}` : ""} covering $${applied.toFixed(2)}`
  );
}

/** The notice printed above the signature area. Plain text; callers escape for HTML. */
export function warrantyNoticeText(claim: Pick<WarrantyClaim, "company" | "claimNumber" | "authNumber">): string {
  const c = claim.company;
  const auth = claim.authNumber ? ` (authorization ${claim.authNumber})` : "";
  return (
    `Home warranty claim ${claim.claimNumber}, ${c}. The covered portion of this work is being ` +
    `performed under your ${c} service contract${auth} and is billed to ${c}, not to you, except ` +
    `any service fee due under your contract. The "Warranty coverage" line above reflects this. ` +
    `The remaining amount is not covered by ${c}. Before we begin it, please note: (1) you may ` +
    `choose your own technician for this work; (2) Red Cedar Electric LLC provides this work ` +
    `solely on its own, separate and apart from ${c}; (3) ${c} is not responsible for Red Cedar ` +
    `Electric's rates or charges on non-covered work; and (4) this document is the written ` +
    `estimate for that work, and your signature below is your authorization to begin it. Any ` +
    `amount ${c} does not pay within 45 days of the invoice is due from you. Questions about ` +
    `what your contract covers go to ${c}.`
  );
}
