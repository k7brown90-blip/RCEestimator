/**
 * CC on a CRM send (Kyle, 2026-10-24: "I need to be able to send emails to multiple recipients at
 * once." / "The email will be the same as doing a CC email.").
 *
 * ONE place decides what a CC list is, for every door that takes one: the invoice send, the
 * estimate send (CRM and field door share sendEstimateEmailFromBody) and the record follow-up
 * email. Each CC passes the same single-address check the To address passes, is lower-cased,
 * de-duplicated, and dropped when it equals the To (the same person twice on one message is one
 * message to them, not a second copy).
 */

import { z } from "zod";

/** The same single-address check sendInvoiceEmail / sendEstimateEmail run on `to`. */
export const SINGLE_ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const MAX_CC = 10;

/** The wire shape on every route: optional, up to ten well-formed addresses. */
export const ccSchema = z.array(z.string().trim().email("A CC address is not a valid email address")).max(MAX_CC, `At most ${MAX_CC} CC addresses`).optional();

export type CleanCc = { ok: true; cc: string[] } | { ok: false; reason: string };

export function cleanCc(raw: readonly string[] | null | undefined, to: string): CleanCc {
  const toKey = to.trim().toLowerCase();
  const out: string[] = [];
  for (const entry of raw ?? []) {
    const address = entry.trim().toLowerCase();
    if (!address) continue;
    if (!SINGLE_ADDRESS.test(address)) {
      return { ok: false, reason: `"${entry.trim()}" is not a valid CC email address. Fix or remove it and send again.` };
    }
    if (address === toKey || out.includes(address)) continue;
    out.push(address);
  }
  if (out.length > MAX_CC) {
    return { ok: false, reason: `At most ${MAX_CC} CC addresses can go on one email.` };
  }
  return { ok: true, cc: out };
}

/** "X · cc Y, Z" for an event line; just X when nobody was CC'd. */
export function withCcText(to: string, cc: readonly string[]): string {
  return cc.length > 0 ? `${to} · cc ${cc.join(", ")}` : to;
}
