/**
 * Words and numbers the field Quote screen's option board shares with its tests (2026-10-08,
 * one-estimating-system plan, Phase 1 unit 1c). Kept out of the component file so it exports only
 * components.
 */

/** Touch: hold this long before a line lifts, so scrolling the list never starts a drag. */
export const TOUCH_HOLD_MS = 250
/** Touch: a finger may wobble this far during the hold without cancelling it. */
export const TOUCH_HOLD_TOLERANCE_PX = 8

/** The confirm wording, same as the CRM's: "Option D has 3 lines — remove them too?" */
export function removeOptionConfirm(option: string, lineCount: number): string {
  return `Option ${option} has ${lineCount} ${lineCount === 1 ? 'line' : 'lines'} — remove them too?`
}

/** What an empty option says (only an added option is ever empty — A, B and C show as before). */
export const EMPTY_OPTION_TEXT = 'No lines yet — drag one here or pick this option on a line'

// ─── Phase 2 (2026-10-08): the Quote screen's settings controls ──────────────────────────────
// Worded like the office's Estimate Intake for the same control, so the two screens read alike.

/** Copy: the two boxes name the same option. */
export const COPY_SAME_REASON = 'Pick two different options — an option cannot be copied into itself'

/** Copy: nothing to copy. */
export function copyEmptyReason(option: string): string {
  return `Option ${option} has no lines to copy`
}

/** What the office prints after a copy: "Copied 3 line(s) from Option A into Option B." */
export function copiedNotice(copied: number, from: string, to: string): string {
  return `Copied ${copied} line(s) from Option ${from} into Option ${to}.`
}

/** The empty name box says what it is for; a typed value is what the customer reads. */
export function namePlaceholder(option: string, fixedMeaning: string | undefined): string {
  return fixedMeaning ?? `Name Option ${option}`
}

/** A custom discount is 0 < percent <= 50 (the server enforces it; this only enables the Apply button). */
export const CUSTOM_DISCOUNT_MAX = 50
export function customPercentLooksValid(text: string): boolean {
  if (text.trim() === '') return false
  const n = Number(text)
  return Number.isFinite(n) && n > 0 && n <= CUSTOM_DISCOUNT_MAX
}
