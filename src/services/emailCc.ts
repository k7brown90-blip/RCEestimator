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
import { MAX_ESTIMATE_PHOTOS } from "../../shared/estimatePhotos";

/** The same single-address check sendInvoiceEmail / sendEstimateEmail run on `to`. */
export const SINGLE_ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const MAX_CC = 10;

/** The wire shape on every route: optional, up to ten well-formed addresses. */
export const ccSchema = z.array(z.string().trim().email("A CC address is not a valid email address")).max(MAX_CC, `At most ${MAX_CC} CC addresses`).optional();

/**
 * THE ONE REQUEST SHAPE for a customer email (Kyle, 2026-10-27, "one tool for one task"): who it goes
 * to, who is copied, an optional note, and the photos ticked to ride along. Every kind the "Email the
 * customer" panel sends - invoice, deposit request, financing link, review request, estimate - is
 * this plus its own few fields (customerEmail.ts, estimateEmailBodySchema), and the field app's
 * estimate door parses the same base. `message` is the wire name the field contract already uses
 * (shared/estimateEmail.ts); the screens call it "Note".
 */
export const customerEmailBaseSchema = z.object({
  to: z.string().trim().email().nullable().optional(),
  cc: ccSchema,
  message: z.string().trim().max(2000).nullable().optional(),
  photoIds: z.array(z.string().min(1)).max(MAX_ESTIMATE_PHOTOS).optional(),
});

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

/**
 * THE ONE RECIPIENT RULE (Kyle, 2026-10-27: "A rule of thumb is there is one tool for one task. We
 * do not create multiple tools that do the same thing.").
 *
 * Every email the CRM sends to a customer - the invoice, the estimate, the deposit request, the
 * financing link, the review request, a free-form message - decides WHO it goes to through this one
 * function: the address chosen on the "Email the customer" panel (`toOverride`) or, when none was
 * chosen, the address on file; one single-address check on the To; then the CC list through
 * cleanCc. It used to be pasted into sendInvoiceEmail and sendEstimateEmail and re-written (or
 * skipped) by the other sends, which is how five buttons took five different amounts of care.
 * Nothing sends to a customer without passing here.
 */
export function resolveRecipients(
  input: { toOverride?: string | null; onFile?: string | null; cc?: readonly string[] | null },
  /** Used when there is no usable To at all - lets a send name the thing (default: the estimate). */
  missing = "No valid customer email address on this estimate. Add one to the customer record, or supply an address when sending.",
): { ok: true; to: string; cc: string[] } | { ok: false; reason: string } {
  const to = (input.toOverride ?? input.onFile ?? "").trim();
  if (!to || !SINGLE_ADDRESS.test(to)) return { ok: false, reason: missing };
  const ccChecked = cleanCc(input.cc, to);
  if (!ccChecked.ok) return { ok: false, reason: ccChecked.reason };
  return { ok: true, to, cc: ccChecked.cc };
}
