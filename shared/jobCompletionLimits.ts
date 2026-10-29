/**
 * The Job Completion Report's limits and fixed words (Kyle, 2026-10-29) - plain values with no zod,
 * so the CRM and the field app can import them without bundling zod. jobCompletion.ts re-exports
 * everything here; the schemas there are built from these same numbers.
 */

// ── Limits, defined once ─────────────────────────────────────────────────────────────────────────
/** "What was done and why", per line. */
export const MAX_EXPLANATION_LENGTH = 4000;
/** NEC articles cited on one line, and the longest one ("210.8(A)(2)", "250.50"). */
export const MAX_NEC_REFS = 12;
export const MAX_NEC_REF_LENGTH = 40;
/** Readings on one line ("Voltage L1-L2 · 240 · V"), and the longest label / value / unit. */
export const MAX_READINGS = 20;
export const MAX_READING_LABEL_LENGTH = 80;
export const MAX_READING_VALUE_LENGTH = 40;
export const MAX_READING_UNIT_LENGTH = 20;
/** Photos printed under one line. */
export const MAX_COMPLETION_PHOTOS = 8;
/** Report ids one receipt email can carry. */
export const MAX_RECEIPT_REPORTS = 20;

/** The receipt's id for the Job Completion Report (the others are "health:<id>" and so on). */
export const COMPLETION_REPORT_ID = "completion";

/** Shown when the Job Completion Report has no entries at all. */
export const NO_LINES_WRITTEN_UP = "No lines are written up yet";
