import { unreviewedReasons } from '../../../shared/suggestedLines'

/**
 * Words and small rules the field Quote screen's "AI proposals", "Open questions" and "Walk the job"
 * sections share with their tests (2026-10-08, one-estimating-system plan, Phase 2 unit D). Kept out
 * of the component file so it exports only components. Worded like the office's Estimate Intake for
 * the same control, so the two screens read alike.
 *
 * NO MONEY HERE: a suggested line is not priced, and nothing on these sections adds anything up.
 */

/** The heading over the list of suggested lines — the office's own words. */
export function proposalsHeading(count: number): string {
  return `AI proposals — ${count} waiting on you`
}

/** The heading over the list of open questions — the office's own words. */
export function questionsHeading(count: number): string {
  return `Open questions — ${count}`
}

/** What a suggestion is until a person decides: the sentence under the "AI proposals" heading. */
export const PROPOSALS_NOTE = 'Nothing counts, and nothing is priced, until you confirm it.'

/**
 * The quantity box on a suggestion: the same rule as the office's (non-zero, and negative ONLY on a
 * change order). The server stays the decision; this only saves a round trip and a mystery.
 */
export function suggestionQuantityProblem(raw: string, isChangeOrder: boolean): string | null {
  const n = raw.trim() === '' ? NaN : Number(raw)
  if (!Number.isFinite(n)) return 'Enter a quantity.'
  if (n === 0) return 'A quantity of zero changes nothing — enter a number above zero' + (isChangeOrder ? ' (or a minus number to take work off).' : '.')
  if (n < 0 && !isChangeOrder) return 'Only a change order can take work off — enter a quantity above zero.'
  return null
}

/** "Confirm" as proposed, or "Edit & confirm" once the quantity or difficulty was changed. */
export function confirmButtonLabel(changed: boolean): string {
  return changed ? 'Edit & confirm' : 'Confirm'
}

/**
 * What Confirm sends: only what the tech changed. Nothing changed = an empty body = the suggestion
 * exactly as proposed (the server records `editedBeforeConfirm` only when a value differs).
 */
export function confirmEdits<D extends string>(
  line: { quantity: number; difficulty: D },
  qty: string,
  difficulty: D,
): { quantity?: number; difficulty?: D } {
  const edits: { quantity?: number; difficulty?: D } = {}
  if (Number(qty) !== line.quantity) edits.quantity = Number(qty)
  if (difficulty !== line.difficulty) edits.difficulty = difficulty
  return edits
}

/** The typed walkthrough list, one item per line, blank lines dropped (what both buttons send). */
export function walkthroughLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}

/** The server takes at most this much text for "Build the draft (AI)" (walkthroughTextBodySchema). */
export const WALKTHROUGH_MAX_CHARS = 8000

/** The note a line added from a matched row carries — the office writes the same. */
export function walkthroughLineNote(raw: string): string {
  return `From walkthrough: "${raw}"`
}

/** The badge under "Build the draft (AI)": which brain answered, and (for basic) why — never silent. */
export function walkthroughPathBadge(path: 'ai' | 'basic', degradedReason: string | null): string {
  return path === 'ai'
    ? 'AI proposal — lines are proposed for your review, nothing is priced or confirmed'
    : `Basic match${degradedReason ? ` — AI unavailable: ${degradedReason}` : ''}`
}

/** "3 line(s) proposed · 1 question(s) · 1 refused" — the office's summary after an AI build. */
export function aiSummaryText(proposed: number, questions: number, rejected: number): string {
  return `${proposed} line(s) proposed · ${questions} question(s)${rejected > 0 ? ` · ${rejected} refused` : ''}`
}

/** What an UNMATCHED row says: which of the tech's words the book does not know, and where to look instead. */
export function unmatchedText(unknownWords: string[]): string {
  if (unknownWords.length > 0) {
    const quoted = unknownWords.map((w) => `“${w}”`).join(', ')
    return `Nothing matched — ${quoted} ${unknownWords.length === 1 ? 'is not' : 'are not'} in your price book. Search the price book above, or browse it by section, for what you do carry.`
  }
  return 'Nothing in the price book matched this. Search the price book above, or browse it by section, and add it from there.'
}

/** Under an option on the board: how many AI suggestions are headed for it, and where they are decided. */
export function suggestedPointer(count: number): string {
  return `${count} AI-suggested ${count === 1 ? 'line is' : 'lines are'} waiting on you for this option — see “AI proposals” at the top (not priced yet).`
}

/**
 * Why the Issue / "Save changes to the estimate" button is greyed, or null. The lifecycle's own reason
 * (signed, lost, nothing changed) wins; otherwise suggestions or questions still waiting on the tech
 * block it, in the SAME sentence the server's issue refusal gives (shared/suggestedLines.ts) — so the
 * button explains itself before it is pressed and the refusal, if it were pressed, would say the same.
 */
export function issueDisabledReason(lifecycleReason: string | null, suggested: number, questions: number): string | null {
  if (lifecycleReason) return lifecycleReason
  const waiting = unreviewedReasons(suggested, questions).join(' ')
  return waiting || null
}
