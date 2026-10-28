/**
 * The words for one queued quote edit — what "Changes waiting (N)" on the Quote screen lists
 * (Phase 7 unit U5, 2026-10-10, one-estimating-system plan). A queued edit is item ids,
 * quantities, letters, names and a discount programme (database.ts QuoteOpBody); this turns each
 * into the sentence a tech reads before pressing Discard on it. Words only — a queued edit never
 * carries money, and nothing here prints a figure.
 *
 * Kept out of the component file so the tests can pin the sentences without rendering, and out of
 * quoteSync.ts so the sync engine stays about sending, not saying.
 */

import type { QuoteOpBody, QuoteOpRecord } from '../db/database'

const DIFF_WORDS = { NORMAL: 'Normal', DIFFICULT: 'Difficult', VERY_DIFFICULT: 'Very difficult' } as const

export interface QuoteOpWordsLookup {
  /** The line's description as the screen shows it, by the line's id (a line added on this phone included). */
  lineWords: (lineId: string) => string | undefined
  /** The price-book description for an item id (the saved price book), for an add whose line is not on screen. */
  itemWords: (itemId: string) => string | undefined
}

const NO_LOOKUP: QuoteOpWordsLookup = { lineWords: () => undefined, itemWords: () => undefined }

function discountWords(type: 'military' | 'senior' | 'custom' | null, percent: number | null): string {
  if (type === null) return 'Discount taken off'
  if (type === 'military') return 'Discount: Military 5%'
  if (type === 'senior') return 'Discount: Senior 5%'
  return `Discount: Custom ${percent ?? ''}%`.replace(' %', '%')
}

/** One sentence for one queued edit. */
export function describeQuoteOp(op: Pick<QuoteOpRecord, 'body'>, lookup: QuoteOpWordsLookup = NO_LOOKUP): string {
  const b: QuoteOpBody = op.body
  switch (b.kind) {
    case 'start_quote':
      return b.title ? `Started this quote on this phone — "${b.title}"` : 'Started this quote on this phone'
    case 'add_line': {
      const what = lookup.lineWords(b.lineId) ?? lookup.itemWords(b.itemId) ?? b.itemId
      const diff = b.difficulty && b.difficulty !== 'NORMAL' ? `, ${DIFF_WORDS[b.difficulty]}` : ''
      return `Added ${what} ×${b.quantity} to Option ${b.option ?? 'A'}${diff}`
    }
    case 'edit_line': {
      const what = lookup.lineWords(b.lineId) ?? 'a line'
      const parts: string[] = []
      if (b.patch.quantity !== undefined) parts.push(`quantity → ${b.patch.quantity}`)
      if (b.patch.difficulty !== undefined) parts.push(`difficulty → ${DIFF_WORDS[b.patch.difficulty]}`)
      if (b.patch.option !== undefined) parts.push(`moved to Option ${b.patch.option}`)
      if (b.patch.location !== undefined) parts.push(b.patch.location ? `location → ${b.patch.location}` : 'location cleared')
      if (b.patch.note !== undefined) parts.push(b.patch.note ? 'note changed' : 'note cleared')
      if (b.patch.customName !== undefined) parts.push(b.patch.customName ? `name on the estimate → ${b.patch.customName}` : 'price-book name back')
      return `${what}: ${parts.join(', ') || 'no change'}`
    }
    case 'remove_line':
      return `Removed ${lookup.lineWords(b.lineId) ?? 'a line'}`
    case 'add_option':
      return `Added Option ${b.option}`
    case 'remove_option':
      return `Removed Option ${b.option}`
    case 'set_option_meta':
      return b.label.trim() === '' && b.note.trim() === ''
        ? `Took the name off Option ${b.option}`
        : `Named Option ${b.option} "${b.label.trim()}"${b.note.trim() ? ` — ${b.note.trim()}` : ''}`
    case 'set_discount':
      return discountWords(b.type, b.percent)
    case 'set_mode':
      return b.exclusive ? 'One-or-the-other options: on' : 'One-or-the-other options: off'
    case 'set_details': {
      const parts: string[] = []
      if (b.title !== undefined) parts.push(`title → "${b.title}"`)
      if (b.jobDescription !== undefined) parts.push(b.jobDescription ? 'scope of work changed' : 'scope of work cleared')
      return parts.join(', ') || 'Title and scope'
    }
    case 'line_order':
      return 'Lines reordered or moved between options'
  }
}

/** What the row under the sentence says about where the edit stands. */
export function quoteOpStatusWords(op: Pick<QuoteOpRecord, 'status' | 'refusal' | 'lastError' | 'attempts' | 'lastErrorKind'>): string {
  if (op.status === 'delivered') return 'Reached the office — waiting for its prices'
  if (op.status === 'refused') return `Refused by the office: ${op.refusal ?? 'no reason given'}`
  if (op.attempts > 0 && op.lastError) {
    // D7: only a try that got NO answer is "waiting for signal". The office saying "not now" (5xx,
    // 408, 429, sign in) and this phone's own code failing are each said as what they are.
    if (op.lastErrorKind === 'office') return `The office could not take it yet — last try: ${op.lastError}. It is tried again on its own.`
    if (op.lastErrorKind === 'phone') return `Could not be sent from this phone — last try: ${op.lastError}. Discard it and make the change again, or update the app.`
    return `Waiting for signal — last try: ${op.lastError}`
  }
  return 'Waiting for signal'
}
