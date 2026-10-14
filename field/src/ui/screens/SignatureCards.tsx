/**
 * A signature taken on this phone, as the technician sees it until the office has answered
 * (Phase 7 unit U8, 2026-10-10, one-estimating-system plan, design §6).
 *
 * ONE card, three states, on the Job site AND the Quote screen (click-through rule 4 — the tech
 * stands on either):
 *   - QUEUED (amber): "Signature saved on this phone — NOT recorded yet", who signed and when, and
 *     "Don't start work until this says Signed." The exit is "Cancel this signature (not recorded
 *     yet)", reason required — filed at the office on the next sync, never silently dropped.
 *   - REFUSED (red): "Not recorded: <the office's words>. The customer believes they signed — call
 *     them." with "Sign again" (needs signal, so the office answers at once) and "I've called the
 *     customer — dismiss", reason required.
 *   - RECORDED (green): "Signed" — the office answered 2xx. Only then.
 *   - UNFILED (grey, D4 2026-10-13): the technician cancelled or dismissed it, and the office would
 *     NOT file that (the estimate is gone, or no longer this technician's). The office's words are
 *     on the card, nothing was recorded, and the one exit is "Remove from this phone".
 *
 * The phone never shows "Signed" before a 2xx (U8 trap). The words here are the design's §1/§2
 * sentences, exported so the screens and the tests cannot drift. The handlers are the lib's
 * (lib/signatureQueue.ts cancelSignature / dismissRefusedSignature), passed in by the screen;
 * rendered to static markup by the tests (the field suite runs in node with no DOM).
 */

import { useState } from 'react'
import type { SignatureQueueRecord } from '../../db/database'
import { savedAtWords } from './QuoteOffline'

// ─── The words (design §1, §2, §6) ────────────────────────────────────────────────────────────

export const SIGNATURE_SAVED_NOT_RECORDED = 'Signature saved on this phone — NOT recorded yet'
export const DONT_START_WORK = "Don't start work until this says Signed."
/** Complete work now / Schedule for later / Collect payment while a signature waits (§2). */
export const WAITING_FOR_SIGNATURE = 'Waiting for the signature to reach the office'
/** The same controls once the office has REFUSED the signature (D6): nothing is on its way any more. */
export const SIGNATURE_REFUSED_BLOCK = 'The office refused the signature — have the customer sign again, or dismiss it on the card'
export const REMOVE_FROM_PHONE_LABEL = 'Remove from this phone'
/** "Edit the estimate" / Issue while a signature waits: a revision would get the waiting signature refused. */
export const WAITING_FOR_SIGNATURE_EDIT = 'Waiting for the signature to reach the office — a change now would make a new revision and the office would refuse the signature the customer gave'
export const CANCEL_SIGNATURE_LABEL = 'Cancel this signature (not recorded yet)'
export const SIGN_AGAIN_LABEL = 'Sign again'
export const DISMISS_LABEL = "I've called the customer — dismiss"
export const SIGN_AGAIN_NEEDS_SIGNAL = 'Needs signal — sign again with signal, so the office answers while the customer is here'
export const REASON_REQUIRED = 'A reason is required — nothing was changed.'

/** The red card's first line: the office's own words, then what the technician must do. */
export function refusedWords(reason: string): string {
  const said = reason.trim()
  return `Not recorded: ${said}${/[.!?]$/.test(said) ? '' : '.'} The customer believes they signed — call them.`
}

/** "This phone's copy, saved 2:14 PM" — the label on a customer screen or a signing screen read from the saved copy (§U8). */
export function savedCopyWords(savedAt: string): string {
  return `This phone's copy, saved ${savedAtWords(savedAt)}`
}

/** "Mrs Panel signed estimate 2026-1098 at 2:14 PM" */
export function signedByWords(row: Pick<SignatureQueueRecord, 'signerName' | 'number' | 'estimateId' | 'capturedAt'>): string {
  return `${row.signerName} signed estimate ${row.number ?? row.estimateId} at ${savedAtWords(row.capturedAt)} (this phone's clock)`
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Ask for the reason the standing rule requires; null when the technician backed out or typed nothing. */
function askReason(question: string): string | null {
  const answer = window.prompt(question)
  if (answer === null) return null
  return answer.trim() || null
}

// ─── The card ─────────────────────────────────────────────────────────────────────────────────

export function SignaturePendingCard(props: {
  row: SignatureQueueRecord
  /** No signal right now: "Sign again" is greyed with its reason (the office must answer at once). */
  offline: boolean
  busy: boolean
  /** The office answered 401 on the last try: the card says so instead of "waiting for signal". */
  authNeeded?: boolean
  onCancel: (signatureId: string, reason: string) => Promise<void>
  onDismiss: (signatureId: string, reason: string) => Promise<void>
  /** Opens signing with the customer again (the refused row is dismissed as "signing again"). Omitted where the screen cannot open it. */
  onSignAgain?: () => Promise<void> | void
  /** "Remove from this phone" on an unfiled cancellation (D4). Omitted where the screen cannot remove it. */
  onRemove?: (signatureId: string) => Promise<void>
}) {
  const { row, offline, busy, authNeeded = false, onCancel, onDismiss, onSignAgain, onRemove } = props
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>) => {
    setWorking(true); setError(null)
    try { await fn() } catch (err) { setError(errText(err)) } finally { setWorking(false) }
  }

  if (row.state === 'unfiled') {
    const what = row.cancelKind === 'dismissed' ? 'dismissal' : 'cancellation'
    const removeReason = onRemove ? null : 'Remove it from the card on the job or the quote'
    return (
      <section role="status" aria-label="Cancellation not filed" className="space-y-2 rounded-lg border border-slate-600 bg-slate-800/70 p-3 text-xs text-slate-200">
        <p className="text-sm font-semibold">Cancelled on this phone — the office would not file the {what}: {row.fileRefusal ?? 'no reason given'}</p>
        <p className="text-slate-300">{signedByWords(row)}. Nothing was recorded for this signature{row.cancelReason ? ` (your reason: ${row.cancelReason})` : ''}.</p>
        {error && <p className="rounded bg-red-950/60 p-2 text-red-100">{error}</p>}
        <button
          type="button"
          disabled={busy || working || removeReason !== null}
          title={removeReason ?? 'Takes it off this phone; the office has already said it will not file it'}
          onClick={() => {
            if (!onRemove) return
            if (!window.confirm(`Remove the cancelled signature ${row.signerName} gave for estimate ${row.number ?? row.estimateId} from this phone? The office said it would not file it, so nothing else is kept.`)) return
            void run(() => onRemove(row.signatureId))
          }}
          className="rounded-lg border border-slate-400 px-3 py-2 font-semibold text-slate-100 disabled:opacity-40"
        >
          {REMOVE_FROM_PHONE_LABEL}
        </button>
        {removeReason && <p className="text-[11px] text-slate-400">{removeReason}</p>}
      </section>
    )
  }

  if (row.state === 'recorded') {
    return (
      <section role="status" aria-label="Signature recorded" className="space-y-1 rounded-lg border border-emerald-700 bg-emerald-950/40 p-3 text-xs text-emerald-100">
        <p className="text-sm font-semibold">Signed — estimate {row.number ?? row.estimateId} is recorded at the office</p>
        <p className="text-emerald-200/90">{signedByWords(row)}{row.recordedAt ? `; recorded ${savedAtWords(row.recordedAt)}` : ''}.</p>
      </section>
    )
  }

  if (row.state === 'refused') {
    const signAgainReason = !onSignAgain ? 'Sign again from the quote' : offline ? SIGN_AGAIN_NEEDS_SIGNAL : null
    return (
      <section role="alert" aria-label="Signature not recorded" className="space-y-2 rounded-lg border border-red-800 bg-red-950/50 p-3 text-xs text-red-100">
        <p className="text-sm font-semibold">{refusedWords(row.reason ?? 'the office did not say why')}</p>
        <p className="text-red-200/90">{signedByWords(row)}. The office has been told.</p>
        {error && <p className="rounded bg-red-900/60 p-2 text-red-100">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || working || signAgainReason !== null}
            title={signAgainReason ?? 'Opens the customer\'s screen so they can sign again; the refused one is put away as "signing again"'}
            onClick={() => { if (onSignAgain) void run(async () => { await onSignAgain() }) }}
            className="rounded-lg bg-emerald-700 px-3 py-2 font-semibold text-white disabled:opacity-40"
          >
            {SIGN_AGAIN_LABEL}
          </button>
          <button
            type="button"
            disabled={busy || working}
            onClick={() => {
              const reason = askReason('What was done about it? (filed at the office with the refusal — required)')
              if (reason === null) { setError(REASON_REQUIRED); return }
              void run(() => onDismiss(row.signatureId, reason))
            }}
            className="rounded-lg border border-red-400 px-3 py-2 font-semibold text-red-100 disabled:opacity-40"
          >
            {DISMISS_LABEL}
          </button>
        </div>
        {signAgainReason && <p className="text-[11px] text-red-200/80">{signAgainReason}</p>}
      </section>
    )
  }

  // Queued (and a cancel still to be filed, which reads the same until it goes).
  const waitingWords = row.state === 'cancelled'
    ? 'Cancelled — the cancellation is filed at the office when this phone has signal.'
    : authNeeded
      ? 'Sign in again — the office no longer accepts this phone\'s sign-in; reconnect this device from the Today screen and it goes on its own.'
      : offline
        ? 'Waiting for signal — it goes to the office on its own when the phone has bars.'
        : row.attempts > 0 && row.lastError && row.lastErrorKind === 'phone'
          // D7: this phone's own code failed on the send — not the signal, not the office; said so.
          ? `Could not be sent from this phone — last try: ${row.lastError}. It is tried again when the app is reopened; if it keeps failing, update the app or cancel it and sign again.`
          : row.attempts > 0
            ? `Sending… (${row.attempts} ${row.attempts === 1 ? 'try' : 'tries'} so far${row.lastError ? ` — last answer: ${row.lastError}` : ''})`
            : 'Sending to the office…'
  return (
    <section role="status" aria-label="Signature not recorded yet" className="space-y-2 rounded-lg border border-amber-700 bg-amber-950/50 p-3 text-xs text-amber-100">
      <p className="text-sm font-semibold">{SIGNATURE_SAVED_NOT_RECORDED}</p>
      <p className="text-amber-200/90">{signedByWords(row)}.</p>
      <p className="font-semibold">{DONT_START_WORK}</p>
      <p className="text-amber-200/80">{waitingWords}</p>
      {error && <p className="rounded bg-red-950/60 p-2 text-red-100">{error}</p>}
      {row.state === 'queued' && (
        <button
          type="button"
          disabled={busy || working}
          title="Drops the signature from this phone before it is recorded; the reason is filed at the office"
          onClick={() => {
            const reason = askReason('Why is this signature being cancelled? (filed at the office — required)')
            if (reason === null) { setError(REASON_REQUIRED); return }
            if (!window.confirm(`Cancel the signature ${row.signerName} gave for estimate ${row.number ?? row.estimateId}? It was never recorded, so it is simply gone; the office is told why.`)) return
            void run(() => onCancel(row.signatureId, reason))
          }}
          className="rounded-lg border border-amber-400 px-3 py-2 font-semibold text-amber-100 disabled:opacity-40"
        >
          {CANCEL_SIGNATURE_LABEL}
        </button>
      )}
    </section>
  )
}
