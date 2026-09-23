/**
 * "Expired" — ONE definition, read by the server and the CRM client (PUNCHLIST A10/H4, 2026-09-22).
 *
 * Before this file, EstimatesPage.tsx (the "expired" bucket and its attention strip) measured
 * staleness from `sentAt` — when the email went out — while the server (the nightly relabel
 * sweep, the signature refusal at the moment of signing, and reopen's landing status) measured
 * from `createdAt` — when the document was issued. Same 30 days (`validDays`), different start,
 * so a quote could read "expired" on the tracker while the customer's link still worked, or the
 * reverse. THE SERVER'S DEFINITION WINS: it is what actually refuses a customer's signature, so
 * the tracker has to agree with it or it is lying about what will happen if they sign.
 */

const DAY_MS = 86_400_000;

/** Past its printed validity window — the same arithmetic the signature refusal uses. */
export function isPastValidity(est: { createdAt: Date | string; validDays: number }, now = Date.now()): boolean {
  const createdAt = est.createdAt instanceof Date ? est.createdAt.getTime() : new Date(est.createdAt).getTime();
  return now > createdAt + est.validDays * DAY_MS;
}
