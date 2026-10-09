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
 * AFTER THE SIGNATURE the screen says "Signed", with the total the server froze and the options
 * taken, then the technician's way on: the deposit (CollectPayment, the field's existing flow) and
 * "Back to the job", where the job screen offers "Complete work now" / "Schedule for later" - the two
 * choices Kyle ruled on 2026-09-21. Nothing here books or schedules anything.
 *
 * The technician's strip at the top ("Back to the customer's quote") is the only control that is not
 * for the customer, and it goes away once the estimate is signed (there is nothing to go back to).
 */

import { useState } from 'react'
import type { InPersonSignResult } from '../../lib/crmSync'
import type { EstimateOptionLetter } from '../../../../shared/estimateOptions'
import { CONSENT_TEXT } from '../../../../shared/consentText'
import { SignaturePad } from '../components/SignaturePad'
import { CollectPayment } from '../components/CollectPayment'

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

/** What the screen posts, and what it asks the server to accept. */
export type SignInPersonPost = (input: {
  signerName: string
  signatureImage: string
  selectedOptions: EstimateOptionLetter[]
}) => Promise<InPersonSignResult>

/**
 * Press "Accept & Sign": the cheap checks first (nothing is posted for a missing name, tick or mark),
 * then ONE post. The server's refusal reason comes back verbatim as `error` - "already been signed",
 * "expired on ...", "choose at least one option" - never reworded here.
 */
export async function submitSignature(args: {
  name: string
  agreed: boolean
  signature: string | null
  selectedOptions: readonly EstimateOptionLetter[]
  onSign: SignInPersonPost
}): Promise<{ ok: true; result: InPersonSignResult } | { ok: false; error: string }> {
  const problem = signingProblem(args)
  if (problem) return { ok: false, error: problem }
  try {
    const result = await args.onSign({
      signerName: args.name.trim(),
      signatureImage: args.signature!,
      selectedOptions: [...args.selectedOptions],
    })
    return { ok: true, result }
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
  /** Post the signature (QuoteScreen: signEstimateInPerson). Rejects with the server's reason. */
  onSign: SignInPersonPost
  /** Back to the customer's quote - before anything is signed. */
  onBack: () => void
  /** Leave for the job screen (after signing, or when the server says it is already signed). */
  onBackToJob: () => void
}) {
  const { visitId, number, title, selectedOptions, optionNames, total, onSign, onBack, onBackToJob } = props
  const [name, setName] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [signature, setSignature] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<InPersonSignResult | null>(null)

  if (result) return <SignedView result={result} visitId={visitId} optionNames={optionNames} onBackToJob={onBackToJob} />

  const submit = () => {
    if (busy) return
    setError(null)
    setBusy(true)
    submitSignature({ name, agreed, signature, selectedOptions, onSign })
      .then((r) => (r.ok ? setResult(r.result) : setError(r.error)))
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
          <SignaturePad onChange={setSignature} disabled={busy} />
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
        <p className="text-xs text-slate-600">Needs signal: the signature is only recorded once Red Cedar Electric&apos;s system has accepted it.</p>
      </div>
    </div>
  )
}
