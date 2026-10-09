/**
 * Quote in the field (Kyle, 2026-09-01, step 4 of the service call): build the
 * estimate in the driveway from the SAME price book and engine as the office.
 *
 * The flow mirrors the day: search the book, add lines (difficulty and A/B/C
 * options per line), watch the same totals the office would see, then ISSUE —
 * the customer signs on their own phone from the customer page link, and the
 * deposit QR is one tap away on the job screen. Gaps are shown per line before
 * issue, because the graduation gate will refuse them with the same words.
 *
 * Needs signal, deliberately: prices are the office's live book, and a quote
 * built against a stale cached book is a wrong promise.
 *
 * ONE ESTIMATING SYSTEM (Kyle, 2026-10-08, Phase 2): the controls below are the phone's twins of
 * Estimate Intake's, worded the same and calling the same server functions —
 *   "Adding into" (which option the next item lands in), option names + descriptions (tap the name
 *   on an option's heading), "One-or-the-other options", "Copy lines", and the "Discount" block
 *   under the totals. The discount in dollars and the one-or-the-other range come FROM THE SERVER
 *   (quote.money); nothing on this screen does money arithmetic.
 *
 * AI PROPOSALS, OPEN QUESTIONS, WALK THE JOB (Phase 2 unit D, 2026-10-08): "Walk the job — list what you
 * need" is the office's Walkthrough tab ("Build the draft (AI)" / "Basic match only"); what the AI
 * suggests lands under "AI proposals" (Confirm / Edit & confirm / Reject) and what it could not place
 * under "Open questions" (Resolve) — QuoteSuggestions.tsx. The quote cannot be issued while either
 * list has anything in it, and the Issue button says so BEFORE the press.
 *
 * PHOTOS, THE ISSUE CHECKBOXES, CHANGE ORDERS (Phase 2 unit E, 2026-10-08): "Photos for the estimate"
 * (QuotePhotos.tsx) is the office's photo picker narrowed to THIS JOB (Kyle, 2026-10-09, ruling 2:
 * the quote's visit and its job chain, not the whole account), ticked per send, filed through the existing job-photo upload; the ticked ones ride "Email the estimate
 * to the customer". Beside "Deposit required" sit the office's other two issue boxes: "Attach
 * generator sizing recommendation" and, on a change order, "Add to the current job when signed".
 * A change order is opened from the Job site screen ("Raise a change order") and lands here.
 *
 * A SIGNED quote shuts every editing control here. The reason (quote.optionSet.lockedReason) is
 * printed ONCE, just under the header; each greyed control carries it as its tooltip.
 *
 * THE QUOTE OUTLIVES ISSUE (Phase 2 unit B, 2026-10-08). "Build the quote" resumes the visit's
 * quote even after it was issued (the server's workingDraftForVisit); the screen then shows the
 * estimate as it stands (IssuedEstimatePanel) with "Edit the estimate", and the green button reads
 * "Save changes to the estimate" - a revise through issueDraft, same number, revision +1. (The
 * office's button of that name calls reviseEstimate directly and, unlike this one, also revises a
 * SIGNED estimate; the phone is refused there, greyed with FIELD_SIGNED_REVISE_REASON - a deliberate CRM-only power, Kyle 2026-10-09 ruling 1, like void and mark-lost.) Before this, an edit after issue started a new draft and a new number. The
 * title & scope editor, "Copy to a new quote" and "Delete this quote" are in QuoteLifecycle.tsx.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  addQuoteLine,
  addQuoteOption,
  confirmSuggestedLine,
  copyQuoteOption,
  copyQuoteToNew,
  deleteQuote,
  deleteQuotePhoto,
  editQuoteLine,
  emailEstimateToCustomer,
  emailFinancing,
  fetchPropertyFindings,
  fetchQuote,
  fetchQuotePhotoPreview,
  fetchQuotePhotos,
  issueQuote,
  matchWalkthroughList,
  openQuoteForVisit,
  proposeFromWalkthroughList,
  raiseChangeOrder,
  rejectSuggestedLine,
  removeQuoteLine,
  removeQuoteOption,
  resolveQuoteQuestion,
  saveQuoteLineOrder,
  saveQuoteOptionMeta,
  setQuoteDetails,
  setQuoteDiscount,
  setQuoteOptionsMode,
  signEstimateInPerson,
  uploadJobPhoto,
  type QuoteLine,
  type QuoteState,
} from '../../lib/crmSync'
import type { FindingRecord } from '../../db/database'
import type { EstimateOptionLetter } from '../../../../shared/estimateOptions'
import { SAVE_CHANGES_LABEL } from '../../../../shared/draftLifecycle'
import { QuoteOptionBoard } from './QuoteOptionBoard'
import { QuoteCatalogPicker } from './QuoteCatalogPicker'
import { AddingIntoBar, OptionModeAndCopy, QuoteTotals } from './QuoteSettings'
import { IssuedEstimatePanel, QuoteExits, TitleScopeEditor, issueButtonState } from './QuoteLifecycle'
import { OpenQuestionsPanel, SuggestedLinesPanel, WalkthroughList } from './QuoteSuggestions'
import { QuotePhotos } from './QuotePhotos'
import type { EstimatePhoto } from '../../../../shared/estimatePhotos'
import { issueDisabledReason } from '../../lib/quoteSuggestions'
import { ShowCustomerScreen, showCustomerReason, type SignHandoff } from './ShowCustomerScreen'
import { SignInPersonScreen } from './SignInPersonScreen'
import { selectionPrice } from '../../../../shared/quoteMoney'

interface Props {
  visitId: string
  propertyId: string
  customerName: string
  /**
   * Open THIS draft instead of the visit's working quote (2026-09-20). The
   * resolutions change order raised off a diagnostic is a draft on the same
   * visit, and `openQuoteForVisit` deliberately will not return it — a change
   * order describes the CHANGE, so it must be opened by id or not at all.
   */
  draftId?: string | null
  /** Where the back arrow goes, in words: "Job site" (the default) or "Diagnostics" for a diagnostic's draft. */
  backLabel?: string
  /**
   * Open straight onto "Show the customer" (the Job site's "Show the customer / Sign now"). The
   * screen still falls back to the builder, with the reason, when there is nothing to show.
   */
  startShowing?: boolean
  /**
   * Open a change order the server just made (App.tsx shows it on this screen). Given on the Job-site
   * route only; it puts "Raise a change order" on the SIGNED estimate's panel, beside the greyed Edit
   * button that tells the tech to raise one.
   */
  onOpenChangeOrder?: (draftId: string) => void
  /**
   * Leave for the JOB screen once the estimate is signed (Phase 3 unit C): the job screen is where
   * "Complete work now" / "Schedule for later" live. Falls back to `onBack`. Separate from onBack
   * because a diagnostic's change order sends the back arrow to Diagnostics, not to the job.
   */
  onBackToJob?: () => void
  onBack: () => void
}

const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`)
const DIFFS = ['NORMAL', 'DIFFICULT', 'VERY_DIFFICULT'] as const
const DIFF_LABEL = { NORMAL: 'Normal', DIFFICULT: 'Difficult', VERY_DIFFICULT: 'Very difficult' } as const

export function LineRow({ line, busy, lockedReason, letters, allowNegative, onPatch, onRemove }: {
  line: QuoteLine
  busy: boolean
  /** The server's reason this quote is shut (signed), or null. Greys every control on the row. */
  lockedReason: string | null
  /** The options THIS quote has (A, B, C plus any added) — the one-thumb way to move a line. */
  letters: readonly EstimateOptionLetter[]

  /** Only a change order's lines may carry a negative quantity (a credit) — assertQuantityAllowed, server-side. */
  allowNegative: boolean
  /**
   * Both return the call so a REFUSAL (the office signed it a moment ago, a bad number) lands in this
   * row's own error slot, beside the box that was typed in - not at the top of a long screen
   * (2026-10-08 review). Callers that don't return a promise are fine.
   */
  onPatch: (patch: Parameters<typeof editQuoteLine>[1]) => Promise<unknown> | void
  onRemove: () => Promise<unknown> | void
}) {
  const [qty, setQty] = useState(String(line.quantity))
  const [rowError, setRowError] = useState<string | null>(null)
  // Bumped when a save is refused: the boxes re-read the line even though the line did not change.
  const [resync, setResync] = useState(0)
  useEffect(() => setQty(String(line.quantity)), [line.quantity, resync])
  // Where the work is and what to remember about it — both end up on the estimate the customer
  // reads, exactly as the office's "Location (optional)" and "Note (optional)" do. Saved when the
  // box is left; an emptied box clears the field (null), never stores a blank.
  const [loc, setLoc] = useState(line.location ?? '')
  const [note, setNote] = useState(line.note ?? '')
  useEffect(() => setLoc(line.location ?? ''), [line.location, resync])
  useEffect(() => setNote(line.note ?? ''), [line.note, resync])
  const off = busy || Boolean(lockedReason)
  const why = lockedReason ?? undefined
  // A refused save must not look saved: the boxes go back to what the line really holds (the screen
  // refreshes the quote on a refusal) and the reason is printed under this row.
  const run = (fn: () => Promise<unknown> | void) => {
    setRowError(null)
    Promise.resolve(fn()).catch((err) => {
      setRowError(err instanceof Error ? err.message : String(err))
      setResync((n) => n + 1)
    })
  }
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-white">{line.description}</span>
        <span className="shrink-0 text-sm font-semibold text-emerald-300">{money(line.lineTotal)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <input
          className="w-20 rounded border border-slate-600 bg-slate-900 p-2 text-white"
          type="number"
          inputMode="decimal"
          min={allowNegative ? undefined : 0.01}
          value={qty}
          disabled={off}
          title={why}
          onChange={(e) => setQty(e.target.value)}
          onBlur={() => {
            const n = Number(qty)
            const valid = Number.isFinite(n) && n !== 0 && (n > 0 || allowNegative)
            if (valid && n !== line.quantity) run(() => onPatch({ quantity: n }))
            else setQty(String(line.quantity))
          }}
        />
        <select
          className="rounded border border-slate-600 bg-slate-900 p-2 text-white"
          value={line.difficulty}
          disabled={off}
          title={why}
          onChange={(e) => run(() => onPatch({ difficulty: e.target.value as QuoteLine['difficulty'] }))}
        >
          {DIFFS.map((d) => <option key={d} value={d}>{DIFF_LABEL[d]}</option>)}
        </select>
        <select
          className="rounded border border-slate-600 bg-slate-900 p-2 text-white"
          value={line.option}
          disabled={off}
          title={why}
          onChange={(e) => run(() => onPatch({ option: e.target.value as QuoteLine['option'] }))}
        >
          {letters.map((o) => <option key={o} value={o}>Option {o}</option>)}
        </select>
        <button type="button" disabled={off} title={why} onClick={() => run(onRemove)} className="ml-auto text-red-300 underline disabled:opacity-40">
          remove
        </button>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 text-xs">
        <label className="block text-slate-400">
          Location
          <input
            className="mt-1 w-full rounded border border-slate-600 bg-slate-900 p-2 text-white"
            value={loc}
            placeholder="kitchen, garage…"
            disabled={off}
            title={why}
            onChange={(e) => setLoc(e.target.value)}
            onBlur={() => {
              const next = loc.trim()
              if (next !== (line.location ?? '')) run(() => onPatch({ location: next === '' ? null : next }))
            }}
          />
        </label>
        <label className="block text-slate-400">
          Note
          <input
            className="mt-1 w-full rounded border border-slate-600 bg-slate-900 p-2 text-white"
            value={note}
            placeholder="anything the customer or the office should know about this line"
            disabled={off}
            title={why}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => {
              const next = note.trim()
              if (next !== (line.note ?? '')) run(() => onPatch({ note: next === '' ? null : next }))
            }}
          />
        </label>
      </div>
      {rowError && <p className="mt-2 rounded bg-red-950/60 p-2 text-xs text-red-200">{rowError}</p>}
      {line.gaps.length > 0 && (
        <ul className="mt-2 space-y-1">
          {line.gaps.map((g, i) => (
            <li key={i} className="rounded bg-amber-950/50 p-2 text-[11px] text-amber-200">{g}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function QuoteScreen({ visitId, propertyId, customerName, draftId: fixedDraftId, backLabel = 'Job site', startShowing = false, onOpenChangeOrder, onBackToJob, onBack }: Props) {
  const [draftId, setDraftId] = useState<string | null>(fixedDraftId ?? null)
  const [quote, setQuote] = useState<QuoteState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [issueReasons, setIssueReasons] = useState<string[]>([])
  // Lines that froze at $0 on the last issue from THIS screen — shown once on the issued panel.
  const [unpriced, setUnpriced] = useState<string[]>([])
  // "Edit the estimate" was pressed: show the builder although the quote is issued and unchanged.
  // The first edit reopens the draft on the server; a save (revision) puts the panel back.
  const [editing, setEditing] = useState(false)
  // "Show the customer" is open: the phone is in the homeowner's hands (ShowCustomerScreen).
  const [showing, setShowing] = useState(startShowing)
  // "Sign now" was pressed on that screen and the estimate is recorded: the customer is signing on
  // this phone (SignInPersonScreen). Holds what they ticked; cleared by "Back to the customer's quote".
  const [signing, setSigning] = useState<SignHandoff | null>(null)
  // The EXISTING optional deposit checkbox, at the tech's discretion (Kyle, 2026-09-21). null =
  // the service's default (on for an estimate, off for a change order) until the tech touches it.
  const [depositRequired, setDepositRequired] = useState<boolean | null>(null)
  // "Adding into" (Phase 2): the option the next price-book item lands in, like the office's bar.
  const [addInto, setAddInto] = useState<EstimateOptionLetter>('A')
  // The office's other two issue boxes (Phase 2 unit E), at the same defaults as Estimate Intake:
  // the generator one-pager is OFF until ticked; "add to the current job" is ON (change orders only).
  const [includeGenerator, setIncludeGenerator] = useState(false)
  const [addToCurrentJob, setAddToCurrentJob] = useState(true)
  // Photos for the estimate: THIS JOB's photos only (Kyle, 2026-10-09, ruling 2), and the ones ticked
  // to ride the email (none unless ticked - the office's rule).
  const [photos, setPhotos] = useState<EstimatePhoto[] | null>(null)
  const [photoMax, setPhotoMax] = useState(10)
  const [photoTotal, setPhotoTotal] = useState<number | undefined>(undefined)
  const [photoVisitId, setPhotoVisitId] = useState<string>(visitId)
  const [photoIds, setPhotoIds] = useState<string[]>([])
  /*
    Open item 2 (2026-09-01): what the assessment found offers itself while
    quoting. A finding is NOT a price-book row, so nothing is auto-mapped —
    tapping one seeds the search with its words, and the next line added
    carries the finding as its note, so the estimate line says WHY it exists.
  */
  const [findings, setFindings] = useState<FindingRecord[]>([])
  const [findingsOpen, setFindingsOpen] = useState(false)
  const [activeFinding, setActiveFinding] = useState<FindingRecord | null>(null)
  useEffect(() => {
    fetchPropertyFindings(propertyId)
      .then((r) => setFindings(r.findings.filter((f) => f.status === 'open' || f.status === 'scheduled')))
      .catch(() => setFindings([]))
  }, [propertyId])

  const refresh = async (id: string) => setQuote(await fetchQuote(id))

  const loadPhotos = useCallback(async (id: string) => {
    const r = await fetchQuotePhotos(id)
    setPhotos(r.photos)
    setPhotoMax(r.max)
    setPhotoTotal(r.total)
    setPhotoVisitId(r.visitId)
    // A ticked photo that is gone (taken back here or by the office) cannot ride the email.
    const present = new Set(r.photos.map((p) => p.id))
    setPhotoIds((prev) => prev.filter((x) => present.has(x)))
  }, [])
  useEffect(() => {
    if (!draftId) return
    loadPhotos(draftId).catch((err) => { setPhotos([]); setError(`Could not load the photos: ${err instanceof Error ? err.message : String(err)}`) })
  }, [draftId, loadPhotos])
  const loadPreview = useCallback((photoId: string) => fetchQuotePhotoPreview(draftId!, photoId), [draftId])

  // The chosen option can disappear (removed here, or by the office): fall back to A, which always exists.
  const optionLetters = quote?.optionSet.options.map((o) => o.option) ?? []
  useEffect(() => {
    if (quote && !optionLetters.includes(addInto)) setAddInto('A')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote, addInto])
  // The server's reason this quote is shut (signed), or null. Decided by one server function.
  const lockedReason = quote?.optionSet.lockedReason ?? null
  // Issued or not, changed since, deletable — the server's answer (shared/draftLifecycle.ts).
  const lifecycle = quote?.lifecycle ?? null
  const issued = lifecycle?.issued ?? null
  const showIssuedPanel = Boolean(quote && issued && !lifecycle?.hasUnsavedChanges && !editing)
  const issueButton = issueButtonState(lifecycle)
  // Suggested lines and open questions BLOCK ISSUE (finalizeDraft refuses them): the button is greyed
  // WITH the reason, in the same words the server's refusal uses (shared/suggestedLines.ts).
  const suggestedLines = quote?.suggestedLines ?? []
  const openQuestions = quote?.openQuestions ?? []
  const issueBlockedReason = issueDisabledReason(issueButton.disabledReason, suggestedLines.length, openQuestions.length)

  useEffect(() => {
    if (fixedDraftId) {
      setDraftId(fixedDraftId)
      refresh(fixedDraftId).catch((err) => setError(err instanceof Error ? err.message : String(err)))
      return
    }
    openQuoteForVisit(visitId)
      .then(async ({ draftId }) => { setDraftId(draftId); await refresh(draftId) })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitId, fixedDraftId])

  // What the issue boxes say, as the server's issue call takes them. First issue only for the generator
  // sheet and add-to-current-job: a revision carries the previous document's values (the boxes are
  // greyed once something is issued). Used by the green button AND by "Sign now" on the customer screen.
  const issueOptions = () => ({
    ...(depositRequired === null ? {} : { depositRequired }),
    ...(issued === null && includeGenerator ? { includeGenerator: true } : {}),
    ...(issued === null && quote?.isChangeOrder ? { addToCurrentJob } : {}),
  })

  // Returns true when the call landed — the picker says "Added …" only then.
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (!draftId) return false
    setBusy(true)
    setError(null)
    try { await fn(); await refresh(draftId); return true }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); return false }
    finally { setBusy(false) }
  }
  // The same, for the option board (add / remove option, save line order): it prints a refusal
  // right beside its own buttons, where the tech is looking, so this one lets the error through.
  const actThrowing = async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (!draftId) throw new Error('The quote is not open yet')
    setBusy(true)
    setError(null)
    try { const r = await fn(); await refresh(draftId); return r }
    catch (err) {
      // A refusal means this screen may be out of date (the office changed the quote, or it was
      // signed) — show the quote as it really is, then let the board print the reason.
      await refresh(draftId).catch(() => undefined)
      throw err
    }
    finally { setBusy(false) }
  }

  // "Copy to a new quote" / "Delete this quote" — on the issued panel and under the builder alike,
  // because the exit lives wherever the thing is shown (standing rule).
  const exits = quote && (
    <QuoteExits
      title={quote.title}
      lineCount={quote.lines.length}
      busy={busy}
      deleteReason={lifecycle?.deleteReason ?? null}
      copyReason={lifecycle?.copyReason ?? null}
      onCopy={async () => {
        const copy = await actThrowing(() => copyQuoteToNew(draftId!))
        // The copy is the newest draft on the visit, so "Build the quote" opens it from now on.
        setDraftId(copy.draftId)
        setEditing(false)
        setUnpriced([])
        setQuote(await fetchQuote(copy.draftId))
      }}
      onDelete={async () => {
        await actThrowing(() => deleteQuote(draftId!))
        onBack()
      }}
    />
  )

  // "Photos for the estimate" - on the issued panel (next to the email button it feeds) AND under
  // the builder (where the quote is made), because the exit and the add live where the thing is shown.
  const photosSection = (collapsible: boolean) => quote && draftId && (
    <QuotePhotos
      collapsible={collapsible}
      photos={photos}
      total={photoTotal}
      max={photoMax}
      selected={photoIds}
      // A signed estimate has no estimate email left to send (the server refuses it), so ticking is greyed WITH why.
      tickLockedReason={issued?.signedAt ? 'This estimate is signed, so there is no estimate email left to send photos with.' : null}
      busy={busy}
      loadPreview={loadPreview}
      onToggle={(id) => setPhotoIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < photoMax ? [...prev, id] : prev))}
      onAdd={async (file, caption) => {
        // The existing job-photo upload (the Job site screen's) - filed on this quote's visit.
        await uploadJobPhoto(photoVisitId, file, caption || undefined)
        await loadPhotos(draftId)
      }}
      onRemove={async (photoId) => {
        await deleteQuotePhoto(draftId, photoId)
        await loadPhotos(draftId)
      }}
    />
  )

  // "Accept & Sign": the customer signs on this phone. The total is the server's table lookup for the
  // exact combination ticked (shared selectionPrice) - nothing is added up here. After the signature
  // the quote is refetched so the lifecycle (signed, locked) is current if the tech comes back to it.
  if (quote && signing) {
    const names: Partial<Record<string, string | null>> = {}
    for (const o of quote.optionSet.options) names[o.option] = o.label
    return (
      <SignInPersonScreen
        visitId={visitId}
        number={signing.number}
        title={quote.title}
        selectedOptions={signing.selectedOptions}
        optionNames={names}
        total={selectionPrice(quote.money, signing.selectedOptions)?.total ?? null}
        onSign={async (input) => {
          try {
            return await signEstimateInPerson(signing.estimateId, input)
          } finally {
            // Signed or refused, show the quote as it really is now.
            await refresh(draftId!).catch(() => undefined)
          }
        }}
        onBack={() => setSigning(null)}
        onBackToJob={onBackToJob ?? onBack}
      />
    )
  }

  // "Show the customer": the phone goes to the homeowner. Before AND after issue; the same screen.
  const showReason = showCustomerReason(quote)
  if (quote && showing && showReason === null) {
    return (
      <ShowCustomerScreen
        quote={quote}
        // ONE issue decision (shared/presentIssue.ts, the server's issueDraft): the screen calls this only
        // when nothing is recorded yet or the quote changed since. Refreshes so the lifecycle is current.
        issue={async () => {
          const r = await issueQuote(draftId!, issueOptions())
          setUnpriced(r.unpriced)
          setEditing(false)
          setQuote(await fetchQuote(draftId!))
          return r
        }}
        issueBlockedReason={issueDisabledReason(null, suggestedLines.length, openQuestions.length)}
        // Phase 3 unit C: always available - the signing screen lives on this phone.
        onSignInPerson={(h) => setSigning(h)}
        onBack={() => setShowing(false)}
      />
    )
  }

  if (quote && issued && showIssuedPanel) {
    return (
      <IssuedEstimatePanel
        issued={issued}
        showCustomerReason={showReason}
        onShowCustomer={() => setShowing(true)}
        reviseReason={lifecycle?.reviseReason ?? null}
        unpriced={unpriced}
        emailEstimate={(estimateId, choices) => emailEstimateToCustomer(estimateId, { ...choices, photoIds })}
        emailFinancing={emailFinancing}
        photoCount={photoIds.length}
        onEdit={() => setEditing(true)}
        onBack={onBack}
        backLabel={backLabel}
        onRaiseChangeOrder={
          onOpenChangeOrder && !quote.isChangeOrder
            ? async () => { onOpenChangeOrder((await raiseChangeOrder(visitId)).draftId) }
            : undefined
        }
      >
        {photosSection(false)}
        {exits}
      </IssuedEstimatePanel>
    )
  }

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <button type="button" onClick={onBack} className="text-sm text-sky-300 underline">← {backLabel}</button>
      <header>
        <h1 className="text-xl font-semibold text-white">{quote?.isChangeOrder ? 'Change order' : 'Quote'} — {customerName}</h1>
        <p className="text-xs text-slate-400">Same book, same prices, same gates as the office.</p>
      </header>
      {/* Hand the phone over — available before AND after issue; greyed WITH the reason, here and in the tooltip. */}
      <div className="space-y-1">
        <button
          type="button"
          disabled={showReason !== null || busy}
          title={showReason ?? 'Turn the phone around: the customer sees each option, ticks what they want and watches the total'}
          onClick={() => setShowing(true)}
          className="w-full rounded-lg bg-sky-700 p-3 text-sm font-semibold text-white disabled:opacity-40"
        >
          Show the customer
        </button>
        {showReason && <p className="text-[11px] text-slate-400">{showReason}</p>}
      </div>
      {/* Which document this is (the office's wording): it describes the CHANGE, and its total joins the invoice when signed. */}
      {quote?.isChangeOrder && (
        <p className="rounded bg-sky-950/60 p-2 text-xs text-sky-200">
          Change order{quote.changeOrderFor ? ` to invoice ${quote.changeOrderFor}` : ''} — its total joins that invoice when
          signed. Add the new work as lines; a minus quantity takes work off.
        </p>
      )}

      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
      {/* A signed quote is shut — the server's own sentence, ONCE, before anyone presses (nullable). */}
      {lockedReason && (
        <p className="rounded bg-amber-950/60 p-2 text-xs text-amber-200">
          This quote can&apos;t be changed here. {lockedReason}
        </p>
      )}
      {/* Editing an issued estimate: the office's amber banner, worded for the truck. */}
      {issued && !lockedReason && (
        <p className="rounded bg-amber-950/60 p-2 text-xs text-amber-200">
          Editing estimate {issued.number}{issued.revision > 1 ? ` rev ${issued.revision}` : ''}. Nothing reaches the
          customer until you press &quot;{SAVE_CHANGES_LABEL}&quot; below — that makes a new revision (same number) and
          replaces their link.
          {!lifecycle?.hasUnsavedChanges && (
            <>
              {' '}
              <button type="button" className="underline" onClick={() => setEditing(false)}>Back to the issued estimate</button>
            </>
          )}
        </p>
      )}
      {quote && (
        <TitleScopeEditor
          title={quote.title}
          jobDescription={quote.jobDescription}
          busy={busy}
          lockedReason={lockedReason}
          issuedNumber={issued?.number ?? null}
          onSave={async (patch) => { await actThrowing(() => setQuoteDetails(draftId!, patch)) }}
        />
      )}
      {quote?.rateProvisional && (
        <p className="rounded bg-amber-950/60 p-2 text-xs text-amber-200">
          PROVISIONAL labour rate — the office has to settle the rate before this can be issued.
        </p>
      )}

      {/* What the AI suggested, and what it could not place: decided here, in the office's words. */}
      {quote && (
        <SuggestedLinesPanel
          lines={suggestedLines}
          busy={busy}
          lockedReason={lockedReason}
          allowNegative={quote.isChangeOrder}
          onConfirm={async (lineId, edits) => { await actThrowing(() => confirmSuggestedLine(lineId, edits)) }}
          onReject={async (lineId) => { await actThrowing(() => rejectSuggestedLine(lineId)) }}
        />
      )}
      {quote && (
        <OpenQuestionsPanel
          questions={openQuestions}
          busy={busy}
          lockedReason={lockedReason}
          onResolve={async (questionId, note) => { await actThrowing(() => resolveQuoteQuestion(questionId, note)) }}
        />
      )}

      {quote && (
        <AddingIntoBar
          options={quote.optionSet.options}
          active={addInto}
          onSelect={setAddInto}
          lockedReason={lockedReason}
        />
      )}
      {/* Search the price book, or browse it by section (assemblies included) — QuoteCatalogPicker.
          The assessment findings sit between the search box and the lists, as they always did. */}
      <QuoteCatalogPicker
        search={search}
        onSearch={setSearch}
        lockedReason={lockedReason}
        busy={busy}
        addInto={addInto}
        onError={setError}
        onPick={(r) => {
          const note = activeFinding ? `Assessment finding: ${activeFinding.title}` : undefined
          setActiveFinding(null)
          // Quantity 1; the number, difficulty, location and note are set on the line itself. The
          // option is the one picked in "Adding into" — before 2026-10-08 every result landed in A.
          return act(() => addQuoteLine(draftId!, {
            itemId: r.itemId,
            quantity: 1,
            option: addInto,
            ...(note ? { note } : {}),
          }))
        }}
      >
        {findings.length > 0 && (
          <div className="space-y-1 rounded-lg border border-amber-800 bg-amber-950/20 p-2">
            <button
              type="button"
              onClick={() => setFindingsOpen((o) => !o)}
              className="w-full text-left text-xs font-medium text-amber-200"
            >
              ⚡ {findings.length} open finding{findings.length > 1 ? 's' : ''} at this address — tap one to quote it
            </button>
            {findingsOpen && findings.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setActiveFinding(f)
                  setFindingsOpen(false)
                  // Seed the book search with the finding's own words; the tech
                  // trims it to the term that matches how the book names things.
                  setSearch(f.title.split(/[—:-]/)[0].trim().slice(0, 40))
                }}
                className={`block w-full rounded p-2 text-left text-xs ${activeFinding?.id === f.id ? 'bg-amber-900/60 text-amber-100' : 'text-amber-200 hover:bg-amber-950/40'}`}
              >
                {f.critical ? '⚠ ' : ''}{f.title}
                <span className="block text-[10px] text-amber-400/70">{f.severity}{f.section ? ` · ${f.section}` : ''}</span>
              </button>
            ))}
            {activeFinding && (
              <p className="rounded bg-slate-900/70 p-2 text-[11px] text-slate-300">
                Quoting: <b className="text-amber-200">{activeFinding.title}</b> — the next item you add
                carries it as the line note.{' '}
                <button type="button" className="underline" onClick={() => setActiveFinding(null)}>clear</button>
              </p>
            )}
          </div>
        )}
      </QuoteCatalogPicker>

      {/* "Walk the job — list what you need": the office's Walkthrough tab (Build the draft (AI) / Basic match only). */}
      {quote && (
        <WalkthroughList
          lockedReason={lockedReason}
          busy={busy}
          addInto={addInto}
          onPropose={(text) => actThrowing(() => proposeFromWalkthroughList(draftId!, text))}
          onMatch={async (lines) => (await matchWalkthroughList(lines)).rows}
          // actThrowing, not act: a refusal prints on the row that was tapped (WalkthroughRowCard's own
          // error slot), not at the top of the screen above the picker - off-screen once the list is long.
          onAdd={async (c, _raw, note) => {
            await actThrowing(() => addQuoteLine(draftId!, { itemId: c.itemId, quantity: 1, option: addInto, note }))
            return true
          }}
        />
      )}

      <section className="space-y-2">
        {quote === null && !error && <p className="text-xs text-slate-500">Loading the quote…</p>}
        {quote?.lines.length === 0 && (
          <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-4 text-sm text-slate-400">
            No lines yet — search the book above, or browse it by section, and tap an item to add it.
          </p>
        )}
      </section>

      {/*
        Lines grouped under each option the draft has, with Add / Remove option and drag-and-drop
        (2026-10-08, Kyle: one estimating system — the office's Review tab does the same). The
        option list is the server's (quote.optionSet), not a fixed A/B/C.
      */}
      {quote && (
        <QuoteOptionBoard
          quote={quote}
          busy={busy}
          renderLine={(l) => (
            <LineRow
              line={l}
              busy={busy}
              lockedReason={lockedReason}
              letters={quote.optionSet.options.map((o) => o.option)}
              allowNegative={quote.isChangeOrder}
              onPatch={(patch) => actThrowing(() => editQuoteLine(l.id, patch))}
              onRemove={() => actThrowing(() => removeQuoteLine(l.id))}
            />
          )}
          onAddOption={async () => {
            // "+ Add Option D" selects the new option, so the next item lands in it (Phase 2).
            const added = await actThrowing(() => addQuoteOption(draftId!))
            setAddInto(added.option)
          }}
          onRemoveOption={async (option, expectedLines) => { await actThrowing(() => removeQuoteOption(draftId!, option, expectedLines)) }}
          onSaveOrder={async (order) => { await actThrowing(() => saveQuoteLineOrder(draftId!, order)) }}
          onSaveMeta={async (option, meta) => { await actThrowing(() => saveQuoteOptionMeta(draftId!, option, meta)) }}
        />
      )}

      {/* One-or-the-other mode and Copy lines — the office's "Option mode + copy" bar (Phase 2). */}
      {quote && (
        <OptionModeAndCopy
          quote={quote}
          busy={busy}
          lockedReason={lockedReason}
          onSetMode={async (exclusive) => { await actThrowing(() => setQuoteOptionsMode(draftId!, exclusive)) }}
          onCopy={(from, to) => actThrowing(() => copyQuoteOption(draftId!, from, to))}
        />
      )}

      {/*
        The grand total only: each option's own subtotal sits on its heading above, so the per-option
        rows this box used to repeat are gone (Phase 2). The discount, in dollars, comes from the
        server with the quote — see QuoteSettings.
      */}
      {quote && quote.lines.length > 0 && (
        <QuoteTotals
          quote={quote}
          busy={busy}
          lockedReason={lockedReason}
          onSetDiscount={async (next) => { await actThrowing(() => setQuoteDiscount(draftId!, next)) }}
        />
      )}

      {photosSection(true)}

      {issueReasons.length > 0 && (
        <ul className="space-y-1">
          {issueReasons.map((r, i) => (
            <li key={i} className="rounded bg-amber-950/60 p-2 text-xs text-amber-200">{r}</li>
          ))}
        </ul>
      )}

      {quote && quote.lines.length > 0 && (
        <label
          className="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm text-slate-200"
          title={issued ? `Set when ${issued.number} was issued. A revision keeps it; the office changes it from the estimate.` : undefined}
        >
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5"
            checked={depositRequired ?? !quote.isChangeOrder}
            // First issue only, like the office: a revision carries the previous document's flag.
            disabled={issued !== null}
            onChange={(e) => setDepositRequired(e.target.checked)}
          />
          <span>
            Deposit required — one third up front before the job is scheduled.
            <span className="block text-[11px] text-slate-400">
              {issued
                ? `Set when ${issued.number} was issued — a revision keeps it. The office can change it from the estimate.`
                : 'Your call. Off means no deposit ask and nothing gates scheduling. The office can change it after issue.'}
            </span>
          </span>
        </label>
      )}
      {/* The office's generator one-pager box (P031): off until ticked; first issue only. */}
      {quote && quote.lines.length > 0 && (
        <label
          className="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm text-slate-200"
          title={issued ? `Set when ${issued.number} was issued - a revision carries it forward.` : undefined}
        >
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5"
            checked={includeGenerator}
            disabled={issued !== null}
            onChange={(e) => setIncludeGenerator(e.target.checked)}
          />
          <span>
            Attach generator sizing recommendation (from this address&apos;s field assessment)
            <span className="block text-[11px] text-slate-400">
              {issued
                ? `Set when ${issued.number} was issued - a revision carries it forward.`
                : 'Off unless you tick it. If no generator sizing is on file for this address, issuing says so - run one from the load calculation first, or untick it.'}
            </span>
          </span>
        </label>
      )}
      {/* Change orders only: the office's "Add to the current job when signed" (no separate scheduling). */}
      {quote && quote.lines.length > 0 && quote.isChangeOrder && (
        <label
          className="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-sm text-slate-200"
          title={issued ? `Set when ${issued.number} was issued. The office changes it from the estimate.` : undefined}
        >
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5"
            checked={addToCurrentJob}
            disabled={issued !== null}
            onChange={(e) => setAddToCurrentJob(e.target.checked)}
          />
          <span>
            Add to the current job when signed (no separate scheduling)
            <span className="block text-[11px] text-slate-400">
              {issued
                ? `Set when ${issued.number} was issued. The office can change it from the estimate.`
                : 'On: signing adds this to the job you are already on, so nothing new is scheduled. Off: it becomes its own job for the office to schedule.'}
            </span>
          </span>
        </label>
      )}
      {quote && quote.lines.length > 0 && (
        <button
          type="button"
          disabled={busy || issueBlockedReason !== null}
          title={issueBlockedReason ?? undefined}
          onClick={() => {
            setBusy(true)
            setIssueReasons([])
            // ONE decision, both doors: issueDraft graduates a first estimate or revises the live one.
            // First issue only for the generator sheet and add-to-current-job: a revision carries the
            // previous document's values (the boxes above are greyed once something is issued).
            issueQuote(draftId!, issueOptions())
              .then(async (r) => {
                setUnpriced(r.unpriced)
                setEditing(false)
                // The lifecycle now names the estimate; the issued panel renders from it.
                setQuote(await fetchQuote(draftId!))
              })
              .catch((err) => {
                const body = (err as { body?: { reasons?: string[] } }).body
                if (body?.reasons?.length) setIssueReasons(body.reasons)
                else setError(err instanceof Error ? err.message : String(err))
              })
              .finally(() => setBusy(false))
          }}
          className="w-full rounded-lg bg-emerald-700 p-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {issueButton.label}
        </button>
      )}
      {/* Greyed WITH the reason, on the page as well as in the tooltip. */}
      {quote && quote.lines.length > 0 && issueBlockedReason && (
        <p className="text-[11px] text-slate-400">{issueBlockedReason}</p>
      )}
      {exits}
    </div>
  )
}
