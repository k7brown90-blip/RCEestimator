/**
 * Why the office cannot record "Customer accepted" on an estimate - ONE place (work order agent-team,
 * TM0). The server (services/officeAcceptance.ts acceptEstimateFromOffice), the CRM Estimate drawer
 * ("Customer accepted is unavailable: ...") and the agent tools read this one function, so the
 * sentence on the screen is the sentence the refusal carries. Pure: no database, no clock of its own
 * (`now` is a parameter, default the real clock).
 *
 * The order is the order the server has always refused in: already accepted, void, lost, replaced,
 * expired (judged by createdAt + validDays, NOT by the nightly relabel), then anything but sent or
 * viewed. The wording is the server's, word for word, and the date is Chicago time on both sides.
 */
import { isPastValidity } from "./estimateExpiry";

export type OfficeAcceptanceBlockCode = "already_accepted" | "void" | "lost" | "superseded" | "expired" | "not_sent";

export interface OfficeAcceptanceBlock {
  code: OfficeAcceptanceBlockCode;
  reason: string;
}

/** The fields the gate reads. Dates may be Date or ISO string (the client holds strings). */
export interface OfficeAcceptanceSubject {
  status: string;
  signedAt?: Date | string | null;
  voidedAt?: Date | string | null;
  lostAt?: Date | string | null;
  createdAt: Date | string;
  validDays?: number | null;
  supersededBy?: { revision: number } | null;
}

/** The Copy-to-new sentence - Kyle's ruling, 2026-09-24: an expired quote is reissued, never accepted. */
export function expiredRefusal(est: { createdAt: Date | string; validDays: number }): string {
  const created = est.createdAt instanceof Date ? est.createdAt.getTime() : new Date(est.createdAt).getTime();
  const expiresAt = new Date(created + est.validDays * 86_400_000);
  return `This quote expired on ${expiresAt.toLocaleDateString("en-US", { timeZone: "America/Chicago" })}. Use Copy to new to reissue at today's pricing.`;
}

/** Null when the office may record an acceptance; otherwise the one reason, with a stable code. */
export function officeAcceptanceBlock(est: OfficeAcceptanceSubject, now: number = Date.now()): OfficeAcceptanceBlock | null {
  if (est.signedAt || est.status === "signed") return { code: "already_accepted", reason: "Already accepted / signed." };
  if (est.status === "void" || est.voidedAt) return { code: "void", reason: "This estimate is void." };
  if (est.status === "lost" || est.lostAt) return { code: "lost", reason: "Marked lost — reopen it first." };
  if (est.supersededBy) {
    return { code: "superseded", reason: `Replaced by rev ${est.supersededBy.revision} — accept that one.` };
  }
  // Past validity is checked BEFORE the status allow-list so a row the sweep has already relabelled
  // "expired" gets the Copy-to-new sentence rather than a status complaint. An estimate with no
  // validDays (an older client payload) is judged by its status label alone.
  const validDays = est.validDays ?? null;
  const past = validDays !== null ? isPastValidity({ createdAt: est.createdAt, validDays }, now) : false;
  if (est.status === "expired" || past) {
    return { code: "expired", reason: expiredRefusal({ createdAt: est.createdAt, validDays: validDays ?? 30 }) };
  }
  if (est.status !== "sent" && est.status !== "viewed") {
    // Only "draft" reaches here today; an allow-list so a future status is refused, not accepted.
    return { code: "not_sent", reason: "Never sent to the customer. Send it first, then record their acceptance." };
  }
  return null;
}
