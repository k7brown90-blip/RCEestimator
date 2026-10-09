/**
 * The estimate's option letters — ONE list for the server, the CRM client and the field app
 * (2026-10-08, one-estimating-system plan, Phase 0).
 *
 * Kyle, 2026-10-08: "I want to be able to add more than 3 options for projects that are more
 * expansive ... continue the options past 'C'." and "Capping it at eight is good."
 *
 * A, B and C keep the meanings Kyle gave them on 2026-08-19 (A the direct quote, B code
 * violations or hazards found, C a recommendation beyond A and B). D through H have no fixed
 * meaning: the user names them (PriceBookDraftOption.label), and until they do the hint says so.
 *
 * Two lists, on purpose:
 *   ALL_OPTIONS   what VALIDATION accepts — every letter the PriceBookOption enum
 *                 (prisma/schema.prisma) can hold.
 *   BASE_OPTIONS  the three every draft always has. UI lists that render a button per option
 *                 use this until a screen draws the draft's own option list (A, B, C plus any
 *                 letter that has a PriceBookDraftOption row or a line).
 *
 * Nothing that issues, prints or presents an estimate may loop over a fixed list: it iterates
 * the options that actually exist on that estimate, so an A/B/C estimate looks exactly as it
 * always did and nobody is shown eight headings, five of them empty.
 *
 * Plain consts and a type alias only — no TS enum and no constructor parameter properties — so
 * the client and field tsconfigs (erasableSyntaxOnly) accept this file as-is.
 */

export const ALL_OPTIONS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
export type EstimateOptionLetter = (typeof ALL_OPTIONS)[number];

/** The three options every draft always has; A, B and C can never be removed. */
export const BASE_OPTIONS = ["A", "B", "C"] as const;

/** Kyle, 2026-10-08: "Capping it at eight is good." */
export const MAX_OPTIONS = ALL_OPTIONS.length;

/** Type guard for a value that may be an option letter (route params, JSON, form fields). */
export function isEstimateOption(x: unknown): x is EstimateOptionLetter {
  return typeof x === "string" && (ALL_OPTIONS as readonly string[]).includes(x);
}

/** Said wherever "Add option" is refused (or greyed) at the cap — same words on both apps. */
export const OPTION_LIMIT_REASON = "Eight options is the limit";

/**
 * The letter "Add option" creates: the LOWEST letter after C the draft does not already have
 * (2026-10-08, one-estimating-system plan, Phase 1). Null when the draft has all eight.
 *
 * "Remove option" leaves a gap on purpose — it never re-letters the others, because lines, names,
 * the customer's page and issued rows all refer to the letter — so "one past the highest" would
 * strand the freed letter and could run out of room with letters unused. Taking the lowest free
 * one after C fills the gap first. A, B and C are always present, so they are never returned.
 */
export function nextFreeOption(have: Iterable<string>): EstimateOptionLetter | null {
  const taken = new Set(have);
  for (const letter of ALL_OPTIONS) {
    if ((BASE_OPTIONS as readonly string[]).includes(letter)) continue;
    if (!taken.has(letter)) return letter;
  }
  return null;
}

/**
 * One option as a draft has it. Built by ONE server function for both the CRM review payload and
 * the tech quote payload (atomicEstimateService.getDraftOptionSet), so no screen re-derives which
 * options exist.
 */
export interface DraftOptionEntry {
  option: EstimateOptionLetter;
  /** What the user named it in Review; null until they do. */
  label: string | null;
  note: string | null;
  /** Every line in the option, proposed or confirmed — what "Remove Option D" would delete. */
  lineCount: number;
  /** False for A, B and C: they are permanent. */
  removable: boolean;
}

export interface DraftOptionSet {
  /** A, B, C always, plus any letter with a PriceBookDraftOption row or a line. In letter order. */
  options: DraftOptionEntry[];
  /** What "Add option" would create; null at the cap (the button greys with OPTION_LIMIT_REASON). */
  nextOption: EstimateOptionLetter | null;
  /**
   * Why this draft's lines and options cannot be changed right now, or null when they can.
   * Worked out by the SAME rule the server's refusal uses (atomicEstimateService.draftLockedReason),
   * so both apps grey Add / Remove / drag with the server's own sentence BEFORE the press instead of
   * each deciding "signed" for itself (2026-10-08 review: the CRM's own test ignored a signed
   * estimate that had since been revised, so its buttons looked live and the server refused them).
   */
  lockedReason: string | null;
}

/** What A, B and C are for, in Kyle's words (2026-08-19). */
export const OPTION_HINTS: Readonly<Record<string, string>> = {
  A: "what the client called for",
  B: "code violations & hazards found",
  C: "recommended beyond A and B",
};

/** D through H have no fixed meaning; the user names them in Review. */
export const OPTION_HINT_FALLBACK = "name this option in Review";

/**
 * The same, worded for the truck: the field app has no Review screen (the field "Review" is the
 * checklist sign-off), so it must not send the tech there. The Quote screen names an option in
 * place: tap the option's name on its heading (2026-10-08, Phase 2 — before that control existed
 * this said "the office can name this option").
 */
export const OPTION_HINT_FALLBACK_FIELD = "tap the name to describe this option";

/**
 * The short line shown beside an option: its fixed meaning for A/B/C, the fallback otherwise.
 * `app` picks the wording of the fallback only — "crm" (default) points at the Review tab, "field"
 * does not.
 */
export function optionHint(option: string, app: "crm" | "field" = "crm"): string {
  return OPTION_HINTS[option] ?? (app === "field" ? OPTION_HINT_FALLBACK_FIELD : OPTION_HINT_FALLBACK);
}
