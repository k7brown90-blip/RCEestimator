/**
 * "Accept & Sign" - the customer signs the estimate on the technician's phone (Phase 3 unit C,
 * 2026-10-08, one-estimating-system plan).
 *
 * Kyle, 2026-09-24 (two apps, two places): "The field app is for the techs on site." A signature taken
 * with the customer standing at the panel is a FIELD action. The CRM has carried a full in-person
 * signing screen (client/src/pages/SigningModePage.tsx) while the field's quote flow stopped at
 * "issue" - this is the phone's twin of it, and it asks for the same four things: the customer's
 * printed name, their finger-drawn signature, a tick that they agree, and "Accept & Sign".
 *
 * ALL THE RULES ARE THE SERVER'S. This screen only collects, then posts to
 * POST /health-record/issued-estimates/:id/sign-in-person, which runs the very function the office's
 * screen runs (services/inPersonSigning.ts -> applySignature): sign-once, expired, closed, void,
 * the options chosen, one-or-the-other. The few checks here (a name, the tick, a drawn mark) only
 * save a round trip and mirror the CRM screen's own.
 *
 * WHAT IS SHOWN, AND WHAT IS NOT. The customer sees exactly what they are agreeing to: the estimate
 * number, the options they ticked and the total looked up from the server's price table
 * (`selectionPrice`) - nothing added up here. The consent sentence is `CONSENT_TEXT` from shared/,
 * the very string the server records beside their name, so what they read is what is stored. No
 * hours, costs, margins or rates are in the payload this screen is built from.
 *
 * CAPTURE FIRST, "SIGNED" ONLY ON THE OFFICE'S ANSWER (Phase 7 unit U8, 2026-10-10; Kyle's rulings
 * 9 and 10). "Accept & Sign" hands the capture to lib/signatureQueue.ts captureSignature, which
 * writes it to this phone BEFORE anything goes over the wire and then sends it through the same
 * route as before. Three things can come back:
 *   - RECORDED (the office answered 2xx): the screen says "Signed", with the total the server
 *     froze and the options taken, then the technician's way on (the deposit, "Back to the job").
 *   - REFUSED while the customer is still here: the office's words, verbatim, as before.
 *   - NO ANSWER (no signal, or the answer was lost): "Signature saved on this phone — NOT recorded
 *     yet", with who signed and when, "Don't start work until this says Signed.", the exit
 *     "Cancel this signature (not recorded yet)" (reason required), the deposit greyed "Waiting
 *     for the signature to reach the office", and "Back to the job". The screen keeps watching the
 *     queue: when the office answers it turns to "Signed", and when the office refuses it turns to
 *     the red card with "Sign again" and "I've called the customer — dismiss". Never "Signed" first.
 * With no signal the estimate shown is this phone's saved copy of the one the office issued, and
 * the technician's strip says so ("This phone's copy, saved 2:14 PM").
 *
 * The technician's strip at the top ("Back to the customer's quote") is the only control that is not
 * for the customer, and it goes away once the estimate is signed (there is nothing to go back to).
 */

import { useEffect, useState } from 'react'
import type { InPersonSignResult } from '../../lib/crmSync'
import { cancelSignature, dismissRefusedSignature, onSignatureSyncSettled, signatureById, type SignatureOutcome } from '../../lib/signatureQueue'
import type { SignatureQueueRecord } from '../../db/database'
import type { EstimateOptionLetter } from '../../../../shared/estimateOptions'
import { CONSENT_TEXT } from '../../../../shared/consentText'
import { SignaturePad } from '../components/SignaturePad'
import { CollectPayment } from '../components/CollectPayment'
import { SIGNATURE_REFUSED_BLOCK, SIGNATURE_SAVED_NOT_RECORDED, SignaturePendingCard, WAITING_FOR_SIGNATURE, savedCopyWords } from './SignatureCards'

const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`)

/**
 * What stops the button, in the CRM screen's own words (SigningModePage submitSignature), or null.
 * Exported for the tests; the server re-checks all of it.
 */
export function signingProblem(args: { name: string; agreed: boolean; signature: string | null }): string | null {
  if (args.name.trim().length < 2) return 'Please type your full name.'
  if (!args.agreed) return 'Please tick the box to agree before signing.'
  if (!args.signature) return 'Please draw your signature in the box.'
  return null
}

/** What the screen hands to the capture (QuoteScreen adds the estimate, revision, figures key and consent). */
export type SignInPersonPost = (input: {
  signerName: string
  signatureImage: string
  selectedOptions: EstimateOptionLetter[]
}) => Promise<SignatureOutcome>

/** A capture that is on this phone: recorded by the office, or saved and not recorded yet. */
export type SignatureHeld = Exclude<SignatureOutcome, { state: 'refused' }>

/**
 * Press "Accept & Sign": the cheap checks first (nothing is captured for a missing name, tick or
 * mark), then ONE capture. A refusal the office answered at once comes back verbatim as `error` -
 * "already been signed", "expired on ...", "choose at least one option" - never reworded here; so
 * does the gate's own refusal (a signature already waiting, edits waiting, past the 30 days).
 */
export async function submitSignature(args: {
  name: string
  agreed: boolean
  signature: string | null
  selectedOptions: readonly EstimateOptionLetter[]
  onSign: SignInPersonPost
}): Promise<{ ok: true; outcome: SignatureHeld } | { ok: false; error: string }> {
  const problem = signingProblem(args)
  if (problem) return { ok: false, error: problem }
  try {
    const outcome = await args.onSign({
      signerName: args.name.trim(),
      signatureImage: args.signature!,
      selectedOptions: [...args.selectedOptions],
    })
    if (outcome.state === 'refused') return { ok: false, error: outcome.reason }
    return { ok: true, outcome }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** "Option A" / "Options A + C", as the totals bar on the Show screen words it. */
export function optionsLabel(options: readonly string[]): string {
  return `Option${options.length > 1 ? 's' : ''} ${options.join(' + ')}`
}

/** The signed state: what the customer agreed to, from the SERVER's answer, then the way on. */
export function SignedView(props: {
  result: InPersonSignResult
  visitId: string
  /** Names of the options taken, by letter, so "Option B - Exterior lights" can be printed. */
  optionNames: Partial<Record<string, string | null>>
  onBackToJob: () => void
}) {
  const { result, visitId, optionNames, onBackToJob } = props
  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="mx-auto max-w-xl space-y-4 p-4">
        <header className="rounded-xl bg-emerald-700 p-5 text-white">
          <h1 className="text-3xl font-bold">Signed — thank you</h1>
          <p className="mt-1 text-lg">Estimate {result.number} is agreed. A copy has gone to Red Cedar Electric.</p>
        </header>

        <section aria-label="What was signed" className="space-y-2 rounded-xl border-2 border-slate-300 bg-white p-4">
          <ul className="space-y-1 text-lg">
            {result.selectedOptions.map((o) => (
              <li key={o}>
                <span className="font-bold">Option {o}</span>
                {optionNames[o] ? <span className="text-slate-700"> — {optionNames[o]}</span> : null}
              </li>
            ))}
          </ul>
          <div className="flex items-end justify-between border-t border-slate-200 pt-2">
            <span className="text-base text-slate-600">Total</span>
            <span className="text-4xl font-bold" aria-label="Signed total">{money(result.total)}</span>
          </div>
          {result.archivedNumbers.length > 0 && (
            <p className="text-sm text-slate-600">
              The other estimate{result.archivedNumbers.length > 1 ? 's' : ''} at this address ({result.archivedNumbers.join(', ')}) {result.archivedNumbers.length > 1 ? 'were' : 'was'} put away.
            </p>
          )}
        </section>

        {/* From here the phone goes back to the technician. */}
        <section className="space-y-3 rounded-xl bg-slate-900 p-4 text-white">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Next, for the technician</h2>
          <p className="text-sm text-slate-300">
            {result.jobJoined
              ? 'This change order joined the current job - nothing new to schedule.'
              : 'Collect the deposit below, then go back to the job and choose "Complete work now" or "Schedule for later".'}
          </p>
          <div className="rounded-lg bg-slate-800 p-3">
            <CollectPayment visitId={visitId} />
          </div>
          <button
            type="button"
            onClick={onBackToJob}
            className="min-h-[3.5rem] w-full rounded-xl bg-emerald-600 p-3 text-lg font-bold text-white"
          >
            Back to the job
          </button>
        </section>
      </div>
    </div>
  )
}

/**
 * The capture is on this phone and the office has not answered (U8): NOT "Signed". The customer's
 * part says so plainly; the technician's part carries the card (with its Cancel, or — once the
 * office has refused it — Sign again / dismiss), the deposit greyed with why, and "Back to the job".
 */
export function SavedNotRecordedView(props: {
  row: SignatureQueueRecord
  visitId: string
  selectedOptions: readonly EstimateOptionLetter[]
  optionNames: Partial<Record<string, string | null>>
  total: number | null
  offline: boolean
  authNeeded?: boolean
  onCancel: (signatureId: string, reason: string) => Promise<void>
  onDismiss: (signatureId: string, reason: string) => Promise<void>
  /** Back to the form so the customer signs again (after the office refused). */
  onSignAgain: () => void
  onBackToJob: () => void
}) {
  const { row, visitId, selectedOptions, optionNames, total, offline, authNeeded = false, onCancel, onDismiss, onSignAgain, onBackToJob } = props
  const refused = row.state === 'refused'
  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="mx-auto max-w-xl space-y-4 p-4">
        <header className={`rounded-xl p-5 text-white ${refused ? 'bg-red-800' : 'bg-amber-700'}`}>
          <h1 className="text-3xl font-bold">{refused ? 'Not recorded' : SIGNATURE_SAVED_NOT_RECORDED}</h1>
          <p className="mt-1 text-lg">
            {refused
              ? `Red Cedar Electric could not record the signature for estimate ${row.number ?? row.estimateId}. The technician will go over it with you.`
              : `Thank you, ${row.signerName}. Your signature for estimate ${row.number ?? row.estimateId} is saved on this phone and is recorded with Red Cedar Electric as soon as it has signal.`}
          </p>
        </header>

        <section aria-label="What was signed" className="space-y-2 rounded-xl border-2 border-slate-300 bg-white p-4">
          <ul className="space-y-1 text-lg">
            {selectedOptions.map((o) => (
              <li key={o}>
                <span className="font-bold">Option {o}</span>
                {optionNames[o] ? <span className="text-slate-700"> — {optionNames[o]}</span> : null}
              </li>
            ))}
          </ul>
          <div className="flex items-end justify-between border-t border-slate-200 pt-2">
            <span className="text-base text-slate-600">Total</span>
            <span className="text-4xl font-bold" aria-label="Total">{money(total)}</span>
          </div>
        </section>

        {/* From here the phone goes back to the technician. */}
        <section className="space-y-3 rounded-xl bg-slate-900 p-4 text-white">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">For the technician</h2>
          <SignaturePendingCard
            row={row}
            offline={offline}
            busy={false}
            authNeeded={authNeeded}
            onCancel={onCancel}
            onDismiss={onDismiss}
            onSignAgain={onSignAgain}
          />
          <div className="rounded-lg bg-slate-800 p-3">
            {/* D6: once the office has refused it, nothing is "on its way" — the reason says what to do instead. */}
            <CollectPayment visitId={visitId} blockedReason={refused ? SIGNATURE_REFUSED_BLOCK : WAITING_FOR_SIGNATURE} />
          </div>
          <button
            type="button"
            onClick={onBackToJob}
            className="min-h-[3.5rem] w-full rounded-xl bg-slate-700 p-3 text-lg font-bold text-white"
          >
            Back to the job
          </button>
        </section>
      </div>
    </div>
  )
}

export function SignInPersonScreen(props: {
  visitId: string
  /** The estimate number being signed, e.g. "2026-1042". */
  number: string
  title: string
  /** The options the customer ticked, in letter order. */
  selectedOptions: readonly EstimateOptionLetter[]
  /** Option letter -> the name the tech gave it, for the summary and the signed view. */
  optionNames: Partial<Record<string, string | null>>
  /** The total for exactly that combination, LOOKED UP in the server's price table. Null = not priced. */
  total: number | null
  /** Capture the signature (QuoteScreen: lib/signatureQueue.ts captureSignature). Rejects with the gate's or the server's reason. */
  onSign: SignInPersonPost
  /** Back to the customer's quote - before anything is signed. */
  onBack: () => void
  /** Leave for the job screen (after signing, or when the server says it is already signed). */
  onBackToJob: () => void
  /** Set when the estimate on screen is this phone's saved copy (no signal): the strip says so. */
  savedCopy?: { savedAt: string } | null
  /** No signal right now (the strip says the signature will be saved here first). */
  offline?: boolean
  /** The office answered 401 on the queue's last try: the saved view says "Sign in again". */
  authNeeded?: boolean
}) {
  const { visitId, number, title, selectedOptions, optionNames, total, onSign, onBack, onBackToJob, savedCopy = null, offline = false, authNeeded = false } = props
  const [name, setName] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [signature, setSignature] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [held, setHeld] = useState<SignatureHeld | null>(null)
  // After a "Sign again", the form is shown fresh; the pad is re-mounted by this key.
  const [attempt, setAttempt] = useState(0)

  // A capture saved and not recorded: watch the queue. The office's answer turns the view to
  // "Signed" (2xx) or to the red card (a refusal); a dismissed or cancelled row leaves for the job.
  const heldId = held?.state === 'queued' ? held.row.signatureId : null
  useEffect(() => {
    if (!heldId) return
    const read = () => {
      void signatureById(heldId).then((row) => {
        if (!row || row.state === 'cancelled' || row.state === 'unfiled') return
        if (row.state === 'recorded' && row.result) setHeld({ state: 'recorded', row, result: row.result })
        else setHeld({ state: 'queued', row, offline: false })
      }).catch(() => undefined)
    }
    read()
    return onSignatureSyncSettled(read)
  }, [heldId])

  if (held?.state === 'recorded') {
    return <SignedView result={held.result} visitId={visitId} optionNames={optionNames} onBackToJob={onBackToJob} />
  }
  if (held?.state === 'queued') {
    return (
      <SavedNotRecordedView
        row={held.row}
        visitId={visitId}
        selectedOptions={selectedOptions}
        optionNames={optionNames}
        total={total}
        offline={offline || held.offline}
        authNeeded={authNeeded}
        onCancel={async (id, reason) => { await cancelSignature(id, reason); onBackToJob() }}
        onDismiss={async (id, reason) => { await dismissRefusedSignature(id, reason); onBackToJob() }}
        onSignAgain={() => {
          // The refused capture is put away as "signing again" and the form comes back clean.
          void dismissRefusedSignature(held.row.signatureId, 'Signing again on this phone').catch(() => undefined)
          setHeld(null)
          setName('')
          setAgreed(false)
          setSignature(null)
          setError(null)
          setAttempt((n) => n + 1)
        }}
        onBackToJob={onBackToJob}
      />
    )
  }

  const submit = () => {
    if (busy) return
    setError(null)
    setBusy(true)
    submitSignature({ name, agreed, signature, selectedOptions, onSign })
      .then((r) => (r.ok ? setHeld(r.outcome) : setError(r.error)))
      .finally(() => setBusy(false))
  }
  const alreadySigned = Boolean(error && /already been signed/i.test(error))

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      {/* The technician's strip. Everything below it is for the customer. */}
      <div className="bg-slate-900 p-3">
        <button type="button" disabled={busy} onClick={onBack} className="min-h-[2.5rem] text-sm font-medium text-sky-300 underline disabled:opacity-40">
          ← Back to the customer&apos;s quote
        </button>
        {savedCopy && (
          <p className="mt-1 text-xs text-sky-300" data-testid="saved-copy">
            {savedCopyWords(savedCopy.savedAt)} — the estimate exactly as the office issued it. The signature is saved on this phone first and recorded when signal returns.
          </p>
        )}
        {!savedCopy && offline && (
          <p className="mt-1 text-xs text-amber-300">No signal — the signature is saved on this phone first and recorded when signal returns.</p>
        )}
      </div>

      <div className="mx-auto max-w-xl space-y-4 p-4 pb-8">
        <header>
          <h1 className="text-3xl font-bold leading-tight">Please review and sign</h1>
          <p className="mt-1 text-lg text-slate-700">{title} <span className="text-base text-slate-500">({number})</span></p>
        </header>

        <section aria-label="What you are signing" className="space-y-1 rounded-xl border-2 border-slate-300 bg-white p-4">
          <div className="text-lg font-semibold">{optionsLabel(selectedOptions)}</div>
          <ul className="text-base text-slate-700">
            {selectedOptions.filter((o) => optionNames[o]).map((o) => (
              <li key={o}>Option {o} — {optionNames[o]}</li>
            ))}
          </ul>
          <div className="flex items-end justify-between border-t border-slate-200 pt-2">
            <span className="text-base text-slate-600">Total</span>
            <span className="text-4xl font-bold" aria-label="Total">{money(total)}</span>
          </div>
        </section>

        <label className="block text-lg font-semibold">
          Type your full name to sign
          <input
            className="mt-1 w-full rounded-lg border-2 border-slate-400 bg-white p-3 text-xl"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            placeholder="Your full name"
            disabled={busy}
          />
        </label>

        {/* The pad is drawn for a dark theme (light label, white canvas), so it sits in a dark panel. */}
        <div className="rounded-xl bg-slate-800 p-3">
          <SignaturePad key={attempt} onChange={setSignature} disabled={busy} />
        </div>

        <label className="flex items-start gap-3 text-base text-slate-700">
          <input
            type="checkbox"
            className="mt-1 h-7 w-7 shrink-0"
            checked={agreed}
            disabled={busy}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          <span>{CONSENT_TEXT}</span>
        </label>

        {error && (
          <div role="alert" className="space-y-2 rounded-lg bg-red-100 p-3 text-base text-red-900">
            <p>{error}</p>
            {alreadySigned && (
              <button type="button" onClick={onBackToJob} className="min-h-[2.5rem] rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white">
                It is already signed — back to the job
              </button>
            )}
          </div>
        )}

        <button
          type="button"
          disabled={busy}
          onClick={submit}
          className="min-h-[3.5rem] w-full rounded-xl bg-emerald-700 p-3 text-xl font-bold text-white disabled:opacity-40"
        >
          {busy ? 'Signing…' : 'Accept & Sign'}
        </button>
        <p className="text-xs text-slate-600">
          The signature is recorded only once Red Cedar Electric&apos;s system has accepted it. With no signal it is saved on this phone and sent when signal returns — nothing is recorded before then.
        </p>
      </div>
    </div>
  )
}
