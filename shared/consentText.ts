/**
 * The words a customer agrees to when they sign an estimate - ONE copy, for every screen that asks.
 *
 * It was a constant inside services/issuedEstimateService.ts, printed on the emailed page and
 * RECORDED on the signature row (`consentText`). Phase 3 unit C (2026-10-08, one-estimating-system
 * plan) puts a signing screen on the technician's phone, which must show the customer exactly the
 * sentence the server will record next to their name - a second hand-typed copy in the field app
 * would drift from what is stored. issuedEstimateService re-exports this, so every existing import
 * of CONSENT_TEXT from there is unchanged.
 *
 * REWORDED 2026-10-09 (Kyle, one-estimating-system rulings, ruling 4): the old sentence said "typing my
 * full name below and tapping Accept"; the screens' button reads "Accept & Sign", and "below" is not
 * true on a phone that lays the form out differently. EVERY signing surface now shows THIS text
 * verbatim and its button reads exactly "Accept & Sign": the emailed customer page /e/:token
 * (issuedEstimateRender.ts), the CRM's SigningModePage, and the field's SignInPersonScreen.
 *
 * ALREADY-SIGNED ROWS KEEP WHAT THEY RECORDED. `signatures.consentText` and the signed estimate's
 * consent are written at signing and never rewritten; changing this constant changes only what the
 * NEXT customer reads and what the NEXT row records. Do not backfill.
 */
export const CONSENT_TEXT =
  "By typing my full name and tapping Accept & Sign, I agree to the scope and the price on this " +
  "estimate, and I authorize Red Cedar Electric LLC to perform the work described. I understand " +
  "this is an electronic signature with the same effect as a written one.";
