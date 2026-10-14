/**
 * Can this estimate be signed on this phone right now? ONE rule for every door that leads to
 * "Accept & Sign" — the Job site's "Show the customer / Sign now", the customer screen's "Sign
 * now", and the capture itself (lib/signatureQueue.ts captureSignature) — so the three cannot
 * disagree (Phase 7 unit U8, 2026-10-10, one-estimating-system plan, design §6).
 *
 * Kyle, 2026-10-09, ruling 9: with no signal, only an estimate issued while the phone had signal
 * and unchanged since can be signed. Ruling 10: the 30 days are judged by the phone's clock at
 * capture, so the phone judges them here, with the same arithmetic the server refuses with
 * (shared/estimateExpiry.ts isPastValidity), and warns at two days or less.
 *
 * Plain functions, no store, no DOM. The words are the design's §2 table. Nothing here decides
 * that a signature is VALID — the server does that at the write (applySignature); this only keeps
 * the phone from taking one it already knows the office would refuse, and from taking a second
 * while one waits.
 */

import type { DraftLifecycleIssued } from '../../../shared/draftLifecycle'
import { isPastValidity } from '../../../shared/estimateExpiry'
import type { SignatureQueueRecord } from '../db/database'

const DAY_MS = 86_400_000

/** "Sign on a quote built or changed offline" (design §2). Also the preview's reason (QuoteOffline). */
export const SIGN_NEEDS_ISSUE_REASON = 'Signing needs the issued estimate — issue it when this phone has signal'
/** "Sign on an issued estimate that has unsent changes" (design §2); the screen offers "Discard my changes" beside it. */
export const CHANGED_ON_PHONE_SIGN_REASON = 'You changed this estimate on the phone — Discard my changes to sign the issued version'
export const DISCARD_MY_CHANGES_LABEL = 'Discard my changes'

export type SignGateKind = 'ok' | 'signature' | 'needs-issue' | 'signed' | 'changes' | 'edited' | 'expired'

export interface SignGate {
  kind: SignGateKind
  /** Why Sign now / Accept & Sign cannot be reached, or null when it can. */
  reason: string | null
  /** "Estimate N is valid until … — 2 days left", at two days or less; else null. */
  warning: string | null
  /** Whole days until the estimate's validity runs out by this phone's clock; null with nothing issued. */
  daysLeft: number | null
}

export interface SignGateInput {
  /** The issued estimate the quote stands on (lifecycle.issued), or null when nothing is issued. */
  issued: Pick<DraftLifecycleIssued, 'number' | 'issuedAt' | 'validDays' | 'signedAt' | 'status'> | null
  /** The draft was edited after `issued` was made (lifecycle.hasUnsavedChanges). */
  hasUnsavedChanges: boolean
  /** Edits waiting on this phone for the draft (queued or refused). */
  waiting: number
  /** The office has never received this quote. */
  localOnlyQuote: boolean
  /** No signal: the issued, saved, unchanged copy is the only thing signable (ruling 9). */
  offline: boolean
  /** The signature this phone already holds for the issued estimate, if any (queued, refused or recorded). */
  signature: Pick<SignatureQueueRecord, 'state' | 'signerName' | 'capturedAt'> | null
  now?: number
}

const dateWords = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
const timeWords = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** When the validity window ends, as an ISO string, from the issued estimate's start and days. */
export function validUntil(issued: Pick<DraftLifecycleIssued, 'issuedAt' | 'validDays'>): string {
  return new Date(new Date(issued.issuedAt).getTime() + issued.validDays * DAY_MS).toISOString()
}

/** The words for a signature this phone already holds for the estimate, by its state. */
export function heldSignatureReason(number: string, signature: NonNullable<SignGateInput['signature']>): string {
  switch (signature.state) {
    case 'queued':
      return `A signature for estimate ${number} by ${signature.signerName} is already saved on this phone (taken ${timeWords(signature.capturedAt)}) — waiting to reach the office`
    case 'refused':
      return `The office refused the last signature for estimate ${number} — Sign again, or dismiss it, from the card on the quote`
    case 'recorded':
      return `Estimate ${number} is signed — recorded at the office`
    case 'cancelled':
      return `The signature for estimate ${number} was cancelled on this phone`
    case 'unfiled':
      return `A cancelled signature for estimate ${number} is still on this phone — the office would not file it; remove it from the card`
  }
}

/** A row that still counts as "held" for the gate: not a cancellation on its way out, nor one the office would not file. */
const holds = (state: SignatureQueueRecord['state']) => state !== 'cancelled' && state !== 'unfiled'

export function signGate(input: SignGateInput): SignGate {
  const { issued, hasUnsavedChanges, waiting, localOnlyQuote, offline, signature } = input
  const now = input.now ?? Date.now()
  const none = (kind: SignGateKind, reason: string): SignGate => ({ kind, reason, warning: null, daysLeft: null })

  if (!issued || localOnlyQuote) {
    // Online, an un-issued draft is issued by "Sign now" itself (shared/presentIssue, decision
    // 'issue'); with no signal there is nothing to sign (ruling 9).
    return offline ? none('needs-issue', SIGN_NEEDS_ISSUE_REASON) : { kind: 'ok', reason: null, warning: null, daysLeft: null }
  }
  if (signature && holds(signature.state)) return none('signature', heldSignatureReason(issued.number, signature))
  if (issued.signedAt) return none('signed', `Estimate ${issued.number} is already signed — there is nothing to sign.`)
  if (waiting > 0) return none('changes', CHANGED_ON_PHONE_SIGN_REASON)
  if (hasUnsavedChanges && offline) {
    return none(
      'edited',
      `Needs signal — the quote was edited after estimate ${issued.number} was issued, so what is on screen is not the issued version; save the changes with signal first`,
    )
  }
  const daysLeft = Math.ceil((new Date(issued.issuedAt).getTime() + issued.validDays * DAY_MS - now) / DAY_MS)
  // With no signal the phone's clock is the only judge (ruling 10); with signal the server's is,
  // and a wrong phone clock must not grey a signature the office would take.
  if (offline && isPastValidity({ createdAt: issued.issuedAt, validDays: issued.validDays }, now)) {
    return { ...none('expired', `Estimate ${issued.number} expired on ${dateWords(validUntil(issued))} — it can't be signed. The office reissues it.`), daysLeft }
  }
  const warning = daysLeft <= 2
    ? `Estimate ${issued.number} is valid until ${dateWords(validUntil(issued))} — ${
        daysLeft < 0 ? 'past that by this phone\'s clock; the office decides' : daysLeft === 0 ? 'it runs out today' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`
      }`
    : null
  return { kind: 'ok', reason: null, warning, daysLeft }
}
