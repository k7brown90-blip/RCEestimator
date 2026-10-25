/**
 * What "Email the estimate" can carry - the contract between the server's ONE send service
 * (sendEstimateEmail, issuedEstimateSend.ts) and both doors that press it: the CRM's Estimate Intake
 * "Email estimate" and the field Quote screen's "Email the estimate to the customer"
 * (Phase 4, one estimating system, 2026-10-08).
 *
 * Kyle, 2026-10-08: the office and the truck are ONE estimating system. The CRM's send panel has
 * always offered an address, a note, the Electrical Health Record report, the Generator Sizing data
 * sheet, the Synchrony financing line and photos; the phone sent only photos. The options, their
 * defaults and the way a choice becomes the request body live HERE so neither app can drift: a
 * default changed in this file changes both.
 *
 * What the server does with the body is not decided here - the zod schema and the refusals live in
 * the service (estimateEmailBodySchema, sendEstimateEmailFromBody). This file only names the
 * choices and builds the body from them.
 *
 * No hours, no costs, no rates - an email option is a yes/no, an address or a sentence.
 * Plain interfaces and functions only (no TS enums, no constructor parameter properties).
 */

/** The choices on the send panel, as the person left them. */
export interface EstimateEmailChoices {
  /** Send to this address instead of the one on the account. Blank means the account's address. */
  to: string;
  /** Extra recipients on the same message (CRM only so far; Kyle, 2026-10-24). Absent = none. */
  cc?: string[];
  /** A sentence or two added above the link. Blank means none. */
  message: string;
  /** Job photos ticked to ride along (ids). Nothing is attached unless ticked. */
  photoIds: string[];
  /** Render the Electrical Health Record report from the newest assessment at this address and attach it. */
  attachHealthReport: boolean;
  /** Render the Generator Sizing data sheet and attach it. */
  attachGeneratorReport: boolean;
  /** The "Prefer to pay over time" line with the Synchrony link. ON unless switched off. */
  includeFinancingLink: boolean;
}

/**
 * The defaults, identical in both apps. The financing line is ticked (Kyle, 2026-10-02): it has
 * gone out on every estimate email since 2026-09-16, so what he gains is the ability to leave it
 * OFF on one estimate, not a new thing to remember. The two attachments start unticked - attaching
 * is the person's explicit act (2026-08-29).
 */
export const ESTIMATE_EMAIL_DEFAULTS: EstimateEmailChoices = {
  to: "",
  message: "",
  photoIds: [],
  attachHealthReport: false,
  attachGeneratorReport: false,
  includeFinancingLink: true,
};

/** The request body for the estimate-email routes (CRM `/issued-estimates/:id/send`, field `/health-record/issued-estimates/:id/email`). */
export interface EstimateEmailRequest {
  to?: string | null;
  /** CC addresses on the same message. Omitted when empty; the field app never sends it. */
  cc?: string[];
  message?: string | null;
  photoIds?: string[];
  attachHealthReport?: boolean;
  attachGeneratorReport?: boolean;
  /** Only ever `false`: the server treats absent as "send the line", so the default path stays byte-identical to what estimates have always carried. */
  includeFinancingLink?: boolean;
}

/**
 * The one way a set of choices becomes a request body. Trimmed text, blank text is absent (so the
 * default body is `{}`, what the phone has always sent), an unticked box is simply not sent, and
 * only an unticked financing box is sent (as false).
 */
export function estimateEmailRequest(choices: Partial<EstimateEmailChoices> = {}): EstimateEmailRequest {
  const c: EstimateEmailChoices = { ...ESTIMATE_EMAIL_DEFAULTS, ...choices };
  return {
    to: c.to.trim() || undefined,
    cc: c.cc && c.cc.length > 0 ? c.cc : undefined,
    message: c.message.trim() || undefined,
    photoIds: c.photoIds.length > 0 ? c.photoIds : undefined,
    attachHealthReport: c.attachHealthReport || undefined,
    attachGeneratorReport: c.attachGeneratorReport || undefined,
    includeFinancingLink: c.includeFinancingLink ? undefined : false,
  };
}

/** The words the confirm / the button use to name what is riding along - ONE phrasing for both apps. */
export function estimateEmailExtras(choices: Pick<EstimateEmailChoices, "photoIds" | "attachHealthReport" | "attachGeneratorReport">): string {
  return [
    choices.attachHealthReport ? "the Health Record report" : null,
    choices.attachGeneratorReport ? "the Generator Sizing sheet" : null,
    choices.photoIds.length ? `${choices.photoIds.length} photo(s)` : null,
  ].filter(Boolean).join(", ");
}
