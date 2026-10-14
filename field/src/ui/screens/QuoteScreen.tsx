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
 * WORKS WITH NO SIGNAL (Phase 7 unit U5, 2026-10-10; Kyle, 2026-09-22: "They would have to be able
 * to do estimates ... without service"). The screen opens the office's copy saved on this phone
 * (or starts a quote here), and EVERY edit — online and offline alike — goes through ONE path,
 * lib/quoteSync.ts writeQuote: written to the phone first, carrying the id this phone minted and
 * `expected` (what the screen showed), sent at once through the same tech routes as before, and
 * replayed in order when signal returns. The figures on screen are the office's own when nothing
 * is waiting; once anything is laid over they are a labelled Preview from the price sheet saved
 * on this phone (U3; Kyle, 2026-10-13: at the line's own difficulty), or "Priced when signal returns"
 * when no sheet is saved — never a number this screen made. The firm number is still the office's:
 * Issue, Show the customer, the AI, photos, emails, copy and delete-at-the-office need signal and
 * are greyed WITH their reason (design §2), never hidden. The header strip, the "Changes waiting
 * (N)" list with its Discard, and every one of those sentences live in QuoteOffline.tsx.
 *
 * AFTER THE SYNC (Phase 7 unit U6, 2026-10-10; QuoteAfterSync.tsx): a refused edit shows as a red
 * card with the office's words and [Discard this change] / [Discard all N waiting changes]; a
 * start-quote the office answered "already started one for this visit" shows the three-button
 * prompt (Add my N lines to it / Keep them on this phone for now / Discard them) with "Apply mine
 * too?" per setting; and once the office has priced what this phone sent, the "Prices from the
 * office's book" panel lists what is new or different (equality only, both figures) and Issue,
 * Show the customer and Sign now stay greyed with "Check the prices first" until "I've checked the
 * prices". With a price sheet saved, "Show the customer" on a changed quote opens the customer's
 * view in PREVIEW mode (watermark, no financing, Sign now greyed) instead of being greyed.
 *
 * SIGNING WITH NO SIGNAL (Phase 7 unit U8, 2026-10-10; Kyle's rulings 9 and 10). An estimate the
 * office issued while this phone had signal, saved here and unchanged since, can be shown and signed
 * with no signal: "Show the customer" opens the saved copy (the frozen table the office holds,
 * labelled "This phone's copy, saved 2:14 PM"), "Sign now" is decided by ONE rule
 * (lib/signatureGate.ts — nothing waiting, inside the 30 days by this clock, no signature already
 * held) and "Accept & Sign" is captured to this phone FIRST (lib/signatureQueue.ts) and sent under
 * the id it minted; the office's answer, and only that, makes it "Signed". Until then the card
 * under the header (SignatureCards.tsx) reads "Signature saved on this phone — NOT recorded yet"
 * with "Cancel this signature (not recorded yet)"; a refusal turns it red with "Sign again" and
 * "I've called the customer — dismiss". While one waits, "Edit the estimate" and Issue are greyed
 * (a revision would get the customer's signature refused).
 *
 * ONE ESTIMATING SYSTEM (Kyle, 2026-10-08, Phase 2): the controls below are the phone's twins of
 * Estimate Intake's, worded the same and calling the same server functions —
 *   "Adding into" (which option the next item lands in), option names + descriptions (tap the name
 *   on an option's heading), "One-or-the-other options", "Copy lines", and the "Discount" block
 *   under the totals. The discount in dollars and the one-or-the-other range come FROM THE SERVER
 *   (quote.money) or, with no signal, from the shared preview over the saved sheet; nothing on this
 *   screen does money arithmetic.
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
  isNetworkFailure,
  issueQuote,
  matchWalkthroughList,
  openQuoteForVisit,
  proposeFromWalkthroughList,
  raiseChangeOrder,
  rejectSuggestedLine,
  resolveQuoteQuestion,
  uploadJobPhoto,
  type QuoteLine,
} from '../../lib/crmSync'
import {
  cancelSignature,
  captureSignature,
  dismissRefusedSignature,
  onSignatureSyncSettled,
  removeUnfiledSignature,
  signatureForEstimate,
  signatureSyncNeedsSignIn,
  type SignatureQueueRecord,
} from '../../lib/signatureQueue'
import { heldSignatureReason, signGate } from '../../lib/signatureGate'
import { CONSENT_TEXT } from '../../../../shared/consentText'
import { SignaturePendingCard, WAITING_FOR_SIGNATURE_EDIT } from './SignatureCards'
import {
  REBASE_NEEDS_SIGNAL,
  applyRebase,
  deleteLocalOnlyQuote,
  discardAllQuoteOps,
  discardQuoteOp,
  discardRebase,
  enqueueQuoteOp,
  expectedForDetails,
  expectedForDiscount,
  expectedForLine,
  expectedForMode,
  expectedForOptionMeta,
  forgetQuoteMirror,
  isPhoneOffline,
  loadQuoteView,
  markPricesReviewed,
  onQuoteSyncSettled,
  quoteMirror,
  quoteSyncNeedsSignIn,
  workingQuoteMirrorForVisit,
  writeQuote,
  type QuoteOpBody,
  type QuoteView,
  type QuoteViewLine,
  type QuoteWriteOutcome,
} from '../../lib/quoteSync'
import { priceCheck } from '../../lib/priceCheck'
import { describeQuoteOp, type QuoteOpWordsLookup } from '../../lib/quoteOpWords'
import type { FindingRecord } from '../../db/database'
import type { EstimateOptionLetter } from '../../../../shared/estimateOptions'
import { SAVE_CHANGES_LABEL } from '../../../../shared/draftLifecycle'
import { QuoteOptionBoard } from './QuoteOptionBoard'
import { QuoteCatalogPicker } from './QuoteCatalogPicker'
import { AddingIntoBar, OptionModeAndCopy, QuoteTotals } from './QuoteSettings'
import { IssuedEstimatePanel, QuoteExits, TitleScopeEditor, issueButtonState } from './QuoteLifecycle'
import { OpenQuestionsPanel, SuggestedLinesPanel, WalkthroughList } from './QuoteSuggestions'
import { QuotePhotos } from './QuotePhotos'
import {
  CHECK_PRICES_FIRST,
  ChangesWaiting,
  DISCARD_FIRST_REASON,
  OFFLINE_AI_REASON,
  OFFLINE_COPY_LINES_REASON,
  OFFLINE_COPY_NEW_REASON,
  OFFLINE_DELETE_REASON,
  OFFLINE_EMAIL_REASON,
  OFFLINE_ISSUE_REASON,
  OFFLINE_PHOTOS_REASON,
  OFFLINE_SHOW_REASON,
  OFFLINE_SHOW_SAVED_REASON,
  REFUSED_FIRST_REASON,
  SENDING_SHOW_REASON,
  SignalStrip,
  lineFigureWords,
  sendingIssueReason,
  waitForChangesReason,
} from './QuoteOffline'
import { CheckPricesPanel, RebasePrompt, RefusalBanner } from './QuoteAfterSync'
import type { EstimatePhoto } from '../../../../shared/estimatePhotos'
import { issueDisabledReason } from '../../lib/quoteSuggestions'
import { ShowCustomerScreen, previewShowReason, showCustomerReason, type CustomerPreview, type SignHandoff } from './ShowCustomerScreen'
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

/** A line as the screen shows it: the office's, or the view's with where its figure came from (Phase 7). */
export type ShownLine = QuoteLine & Partial<Pick<QuoteViewLine, 'priceStatus' | 'priceReason' | 'localOnly'>>

/** The words a saved quote the office never received gets when it cannot be opened with no signal. */
export const NOT_SAVED_ON_PHONE = 'No signal — this quote has not been saved on this phone. Open it once with signal and it is saved for next time.'

export function LineRow({ line, busy, lockedReason, letters, allowNegative, onPatch, onRemove }: {
  line: ShownLine
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
  // Under the figure: "Preview", "may come down once issued", or why there is no figure (Phase 7 §3).
  const figureWords = line.priceStatus ? lineFigureWords({ priceStatus: line.priceStatus, priceReason: line.priceReason ?? null }) : null
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
        <span className="text-sm font-medium text-white">
          {line.description}
          {line.localOnly && <span className="ml-2 rounded bg-amber-900/70 px-1.5 py-0.5 text-[10px] font-normal text-amber-100">on this phone — not at the office yet</span>}
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-sm font-semibold text-emerald-300">{money(line.lineTotal)}</span>
          {figureWords && (
            <span className={`block max-w-[11rem] text-[10px] ${line.priceStatus === 'unpriced' ? 'text-amber-300' : 'text-sky-300'}`}>{figureWords}</span>
          )}
        </span>
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

/** True when a call's result is a writeQuote outcome (the queue's answer) rather than a live call's. */
function isWriteOutcome(r: unknown): r is QuoteWriteOutcome {
  return typeof r === 'object' && r !== null && 'state' in r && ((r as { state: unknown }).state === 'delivered' || (r as { state: unknown }).state === 'queued')
}

export function QuoteScreen({ visitId, propertyId, customerName, draftId: fixedDraftId, backLabel = 'Job site', startShowing = false, onOpenChangeOrder, onBackToJob, onBack }: Props) {
  const [draftId, setDraftId] = useState<string | null>(fixedDraftId ?? null)
  // The quote AS THE SCREEN SHOWS IT (lib/quoteSync.ts loadQuoteView): the office's copy saved on
  // this phone with the waiting edits laid over it. With nothing waiting it is exactly the office's
  // payload (priceSource 'server'); it extends QuoteState, so every child reads it as before.
  const [quote, setQuote] = useState<QuoteView | null>(null)
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
    NO SIGNAL (Phase 7 U5). "Offline" means the phone KNOWS it has no signal (navigator.onLine
    false) or a request got NO ANSWER (fetch threw) — never an HTTP refusal, which is the office
    saying no with words. Set by the load, every refresh and every write; cleared the moment a
    request is answered or the browser says the signal is back.
  */
  const [offline, setOffline] = useState(isPhoneOffline())
  // The office answered 401 on the queue's last try (U6): the strip says "Sign in again — N changes waiting".
  const [authNeeded, setAuthNeeded] = useState(quoteSyncNeedsSignIn())
  // "Keep them on this phone for now" was pressed on the office-started-one-first prompt for THIS
  // draft: the prompt stays down while this screen is open and comes back the next time the quote is
  // opened (nothing on the phone changes — the start stays refused and the edits stay queued behind it).
  const [rebaseKeptFor, setRebaseKeptFor] = useState<string | null>(null)
  const rebaseKept = rebaseKeptFor !== null && rebaseKeptFor === draftId
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

  /** The view from what is on the phone: the saved copy with the waiting edits laid over (no fetch). */
  const reloadLocal = useCallback(async (id: string) => {
    setQuote(await loadQuoteView(id))
    setAuthNeeded(quoteSyncNeedsSignIn())
  }, [])
  /**
   * The office's answer when it can be had, then the view. NO ANSWER (no signal) is not an error:
   * the saved copy stands and the screen says so. A refusal (the office deleted the quote, not the
   * tech's) is thrown exactly as before.
   */
  const refresh = useCallback(async (id: string) => {
    if (!isPhoneOffline()) {
      try {
        await fetchQuote(id, { visitId })
        setOffline(false)
      } catch (err) {
        if (!isNetworkFailure(err)) throw err
        setOffline(true)
      }
    } else {
      setOffline(true)
    }
    setQuote(await loadQuoteView(id))
    setAuthNeeded(quoteSyncNeedsSignIn())
  }, [visitId])

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
    if (!draftId || isPhoneOffline()) return
    loadPhotos(draftId).catch((err) => {
      setPhotos([])
      // No answer is "no signal" (the photos section says so itself); a refusal is still printed.
      if (isNetworkFailure(err)) setOffline(true)
      else setError(`Could not load the photos: ${err instanceof Error ? err.message : String(err)}`)
    })
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

  // The signature this phone holds for the issued estimate (U8): queued (not recorded yet), refused
  // by the office, or recorded. Re-read as the signature queue settles in the background.
  const [signature, setSignature] = useState<SignatureQueueRecord | null>(null)
  const issuedEstimateId = issued?.estimateId ?? null
  const reloadSignature = useCallback(async () => {
    setSignature(issuedEstimateId ? (await signatureForEstimate(issuedEstimateId)) ?? null : null)
  }, [issuedEstimateId])
  useEffect(() => {
    void reloadSignature().catch(() => undefined)
    return onSignatureSyncSettled(() => { void reloadSignature().catch(() => undefined) })
  }, [reloadSignature])
  const signatureQueued = signature?.state === 'queued'
  // Held = queued or refused: the customer's screen stays shut until the tech has dealt with it.
  const signatureHeld = signature && (signature.state === 'queued' || signature.state === 'refused') ? signature : null

  // ── What is waiting on this phone, and the reasons that follow from it (design §2) ──
  const waitingCount = quote ? quote.waiting.filter((o) => o.status !== 'delivered').length : 0
  const refusedCount = quote?.refused.length ?? 0
  const pendingCount = waitingCount + refusedCount
  // Something is laid over the office's copy (waiting, or landed with the office's answer not back yet).
  const touched = quote?.touched ?? false
  const localOnlyQuote = quote?.localOnlyQuote ?? false
  // ── After the sync (U6) ──
  // The start-quote the office refused because it had already started one for this visit: the
  // three-button prompt is ITS banner, so the general refusal card leaves it out.
  const rebaseOp = quote?.refused.find((o) => o.kind === 'start_quote' && o.existingDraftId) ?? null
  const pendingRebase = quote?.pendingRebase ?? rebaseOp?.existingDraftId ?? null
  const otherRefused = quote?.refused.filter((o) => o !== rebaseOp) ?? []
  // The office priced what this phone sent and the tech has not looked yet: the panel shows while
  // the figures on screen are the office's (nothing laid over), and the gate holds until the tap.
  const pricesNeedReview = quote?.pricesNeedReview ?? false
  const showPricePanel = Boolean(quote && pricesNeedReview && quote.priceSource === 'server')
  /** A call decided at the office that goes round the queue: needs signal, and nothing of this quote's on its way. */
  const liveCallReason = (offlineWords: string): string | null =>
    offline ? offlineWords : refusedCount > 0 ? REFUSED_FIRST_REASON : touched ? waitForChangesReason(waitingCount) : null
  // ONE signing rule (lib/signatureGate.ts), from the quote as shown, the queue and the signature held (U8).
  const gate = signGate({ issued, hasUnsavedChanges: lifecycle?.hasUnsavedChanges ?? false, waiting: pendingCount, localOnlyQuote, offline, signature })
  const issueBlockedReason = offline
    ? OFFLINE_ISSUE_REASON
    : refusedCount > 0
      ? REFUSED_FIRST_REASON
      : signatureQueued
        ? WAITING_FOR_SIGNATURE_EDIT
      : touched
        ? (waitingCount > 0 ? sendingIssueReason(waitingCount) : waitForChangesReason(0))
        : pricesNeedReview
          ? CHECK_PRICES_FIRST
          : issueDisabledReason(issueButton.disabledReason, suggestedLines.length, openQuestions.length)
  const aiReason = lockedReason ?? (offline ? OFFLINE_AI_REASON : null)
  const copyLinesReason = liveCallReason(OFFLINE_COPY_LINES_REASON)
  const copyNewReason = lifecycle?.copyReason ?? liveCallReason(OFFLINE_COPY_NEW_REASON)
  // "Delete this quote": a quote the office never received is deleted from this phone (works with no
  // signal); one the office has is deleted at the office, so it waits for signal and an empty queue.
  const deleteReason = localOnlyQuote
    ? null
    : (lifecycle?.deleteReason ?? (offline ? OFFLINE_DELETE_REASON : pendingCount > 0 ? DISCARD_FIRST_REASON : null))
  const photosOfflineReason = offline ? OFFLINE_PHOTOS_REASON : null

  // ── Opening the quote: the office first; with no signal, the copy saved on this phone; with none, start one here ──
  useEffect(() => {
    let cancelled = false
    const fail = (err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) }
    const open = async () => {
      if (fixedDraftId) {
        // A change order (or a diagnostic's draft) is opened by id or not at all. With no signal it
        // opens only if this phone saved it while it had signal.
        setDraftId(fixedDraftId)
        try {
          await fetchQuote(fixedDraftId, { visitId })
          if (!cancelled) setOffline(false)
        } catch (err) {
          if (!isNetworkFailure(err)) throw err
          if (cancelled) return
          setOffline(true)
          if (!(await quoteMirror(fixedDraftId))) {
            setError(NOT_SAVED_ON_PHONE)
            return
          }
        }
        if (!cancelled) setQuote(await loadQuoteView(fixedDraftId))
        return
      }
      try {
        const opened = await openQuoteForVisit(visitId)
        if (cancelled) return
        setDraftId(opened.draftId)
        await refresh(opened.draftId)
        return
      } catch (err) {
        if (!isNetworkFailure(err)) throw err
      }
      if (cancelled) return
      // No signal. The visit's quote as this phone saved it at the Today screen (or the last time it
      // was open), with whatever is waiting laid over — or a quote started here, sent when signal returns.
      setOffline(true)
      const mirror = await workingQuoteMirrorForVisit(visitId)
      if (mirror) {
        setDraftId(mirror.draftId)
        setQuote(await loadQuoteView(mirror.draftId))
        return
      }
      const id = crypto.randomUUID()
      await enqueueQuoteOp({ draftId: id, visitId, body: { kind: 'start_quote', title: `Quote — ${customerName}` } })
      if (cancelled) return
      setDraftId(id)
      setQuote(await loadQuoteView(id))
    }
    open().catch(fail)
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visitId, fixedDraftId])

  // The queue drains in the background (signal back, app start): re-read the phone when it settles,
  // so delivered edits give way to the office's figures without the tech touching anything.
  useEffect(() => {
    if (!draftId) return
    return onQuoteSyncSettled(() => { void reloadLocal(draftId).catch(() => undefined) })
  }, [draftId, reloadLocal])
  // The browser's own word on the signal: back → fetch the office's copy; gone → say so at once.
  useEffect(() => {
    const up = () => { if (draftId) void refresh(draftId).catch(() => undefined); else setOffline(false) }
    const down = () => setOffline(true)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [draftId, refresh])

  // What the issue boxes say, as the server's issue call takes them. First issue only for the generator
  // sheet and add-to-current-job: a revision carries the previous document's values (the boxes are
  // greyed once something is issued). Used by the green button AND by "Sign now" on the customer screen.
  const issueOptions = () => ({
    ...(depositRequired === null ? {} : { depositRequired }),
    ...(issued === null && includeGenerator ? { includeGenerator: true } : {}),
    ...(issued === null && quote?.isChangeOrder ? { addToCurrentJob } : {}),
  })

  /**
   * ONE write path (lib/quoteSync.ts writeQuote): to the phone first, then to the office through the
   * same tech route as before, with the id this phone minted and `expected`. Resolves delivered or
   * queued; THROWS the office's own words on a live refusal, so the control that pressed prints them.
   */
  const write = (body: QuoteOpBody): Promise<QuoteWriteOutcome> => {
    if (!draftId) throw new Error('The quote is not open yet')
    return writeQuote({ draftId, visitId, body })
  }
  /** After a call: a queue answer re-reads the phone (the flush already refreshed the office's copy when it delivered); a live call fetches. */
  const settle = async (id: string, result: unknown) => {
    if (isWriteOutcome(result)) {
      if (result.state === 'delivered') setOffline(false)
      else if (result.offline) setOffline(true)
      await reloadLocal(id)
    } else {
      await refresh(id)
    }
  }

  // Returns true when the call landed or was queued — the picker says "Added …" only then.
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (!draftId) return false
    setBusy(true)
    setError(null)
    try { const r = await fn(); await settle(draftId, r); return true }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); return false }
    finally { setBusy(false) }
  }
  // The same, for the option board (add / remove option, save line order): it prints a refusal
  // right beside its own buttons, where the tech is looking, so this one lets the error through.
  const actThrowing = async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (!draftId) throw new Error('The quote is not open yet')
    setBusy(true)
    setError(null)
    try { const r = await fn(); await settle(draftId, r); return r }
    catch (err) {
      // A refusal means this screen may be out of date (the office changed the quote, or it was
      // signed) — show the quote as it really is, then let the board print the reason.
      await refresh(draftId).catch(() => undefined)
      throw err
    }
    finally { setBusy(false) }
  }

  // The words for each waiting change — the line as the screen shows it, else the item id.
  const opWords: QuoteOpWordsLookup = {
    lineWords: (lineId) => quote?.lines.find((l) => l.id === lineId)?.description,
    itemWords: () => undefined,
  }

  // "Copy to a new quote" / "Delete this quote" — on the issued panel and under the builder alike,
  // because the exit lives wherever the thing is shown (standing rule).
  const exits = quote && (
    <QuoteExits
      title={quote.title}
      lineCount={quote.lines.length}
      busy={busy}
      deleteReason={deleteReason}
      copyReason={copyNewReason}
      onCopy={async () => {
        const copy = await actThrowing(() => copyQuoteToNew(draftId!))
        // The copy is the newest draft on the visit, so "Build the quote" opens it from now on.
        setDraftId(copy.draftId)
        setEditing(false)
        setUnpriced([])
        await refresh(copy.draftId)
      }}
      onDelete={async () => {
        if (localOnlyQuote) {
          // The office never received it: it goes from this phone, edits and all. No signal needed.
          await deleteLocalOnlyQuote(draftId!)
          onBack()
          return
        }
        // Not through actThrowing: a refetch of a quote that no longer exists is a refusal, and it
        // used to print one here after a delete that had succeeded — leaving the tech on a dead
        // quote (Phase 7 U5 walk, 2026-10-10). The saved copy goes with it.
        setBusy(true)
        try {
          await deleteQuote(draftId!)
          await forgetQuoteMirror(draftId!).catch(() => undefined)
        } finally {
          setBusy(false)
        }
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
      offlineReason={photosOfflineReason}
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

  // Open a quote by id after a rebase prompt is answered: the office's answer when it can be had,
  // else the copy saved on this phone, else the words (the same path as a change order's open).
  const openById = async (id: string) => {
    setDraftId(id)
    setEditing(false)
    setUnpriced([])
    try {
      await fetchQuote(id, { visitId })
      setOffline(false)
    } catch (err) {
      if (!isNetworkFailure(err)) throw err
      setOffline(true)
      if (!(await quoteMirror(id))) throw new Error(NOT_SAVED_ON_PHONE, { cause: err })
    }
    await reloadLocal(id)
  }

  // The strip, the after-sync cards (U6) and the waiting list: under the header on the builder, and
  // on the issued panel too.
  const offlineSection = quote && draftId && (
    <>
      <SignalStrip offline={offline} waiting={waitingCount} refused={refusedCount} authNeeded={authNeeded} />
      {/* The signature this phone holds for the issued estimate (U8): not recorded yet / refused / recorded. */}
      {signature && (
        <SignaturePendingCard
          row={signature}
          offline={offline}
          busy={busy}
          authNeeded={signatureSyncNeedsSignIn()}
          onCancel={async (id, reason) => {
            await cancelSignature(id, reason)
            await reloadSignature()
          }}
          onDismiss={async (id, reason) => {
            await dismissRefusedSignature(id, reason)
            await reloadSignature()
          }}
          onRemove={async (id) => {
            await removeUnfiledSignature(id)
            await reloadSignature()
          }}
          onSignAgain={async () => {
            // The refused capture is put away as "signing again" (filed at the office), and the
            // customer's screen opens so they can sign afresh.
            await dismissRefusedSignature(signature.signatureId, 'Signing again on this phone')
            await reloadSignature()
            setShowing(true)
          }}
        />
      )}
      {pendingRebase && !rebaseKept && (
        <RebasePrompt
          ops={[...quote.waiting, ...quote.refused].sort((a, b) => a.seq - b.seq)}
          lookup={opWords}
          busy={busy}
          addBlockedReason={offline ? REBASE_NEEDS_SIGNAL : null}
          onAddMine={async (applySettings) => {
            // The office's draft is read first (and saved here), the edits re-pointed at it and sent;
            // the screen then shows the office's quote with them laid over until they land.
            await applyRebase(draftId, pendingRebase, visitId, { applySettings })
            setDraftId(pendingRebase)
            setEditing(false)
            setUnpriced([])
            await reloadLocal(pendingRebase)
          }}
          onKeep={() => setRebaseKeptFor(draftId)}
          onDiscard={async () => {
            await discardRebase(draftId)
            await openById(pendingRebase)
          }}
        />
      )}
      {otherRefused.length > 0 && (
        <RefusalBanner
          refused={otherRefused}
          waiting={pendingCount}
          lookup={opWords}
          busy={busy}
          onDiscard={async (opId) => {
            const { discarded } = await discardQuoteOp(opId)
            const words = discarded.map((o) => describeQuoteOp(o, opWords))
            await reloadLocal(draftId)
            return discarded.length === 1 ? `Discarded: ${words[0]}` : `Discarded ${discarded.length} changes: ${words.join('; ')}`
          }}
          onDiscardAll={async () => {
            const { discarded } = await discardAllQuoteOps(draftId)
            await reloadLocal(draftId)
            return `Discarded ${discarded.length} change${discarded.length === 1 ? '' : 's'} — the quote is as the office has it.`
          }}
        />
      )}
      {showPricePanel && (
        <CheckPricesPanel
          report={priceCheck(quote.shownBeforeSync, quote)}
          shownAt={quote.shownBeforeSync?.at ?? null}
          busy={busy}
          onChecked={async () => {
            await markPricesReviewed(draftId)
            await reloadLocal(draftId)
          }}
        />
      )}
      <ChangesWaiting
        ops={[...quote.waiting, ...quote.refused].sort((a, b) => a.seq - b.seq)}
        lookup={opWords}
        busy={busy}
        startOpen={refusedCount > 0}
        onDiscard={async (opId) => {
          const { discarded } = await discardQuoteOp(opId)
          // Words first: once the view is re-read, a discarded add's line is gone from it.
          const words = discarded.map((o) => describeQuoteOp(o, opWords))
          await reloadLocal(draftId)
          return discarded.length === 1 ? `Discarded: ${words[0]}` : `Discarded ${discarded.length} changes: ${words.join('; ')}`
        }}
      />
    </>
  )

  // "Accept & Sign": the customer signs on this phone. The total is the server's table lookup for the
  // exact combination ticked (shared selectionPrice) - nothing is added up here. The capture goes to
  // this phone FIRST (lib/signatureQueue.ts, U8) carrying the issued estimate's revision, the
  // server's own figures key and the consent sentence shown; the office's answer, and only that,
  // makes it "Signed". Afterwards the quote is re-read so the lifecycle (signed, locked) is current.
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
          if (!issued || issued.estimateId !== signing.estimateId) {
            throw new Error('The estimate on screen is not the one being signed — go back to the quote and press Sign now again.')
          }
          if (!issued.figuresKey || !issued.issuedAt) {
            // A copy saved by a build from before the capture fields existed: the server could not
            // check the figures. Refresh it once with signal rather than sign blind.
            throw new Error("This phone's copy of the estimate is from before the update — open the quote once with signal, then sign.")
          }
          const outcome = await captureSignature({
            estimateId: issued.estimateId,
            draftId,
            visitId,
            number: issued.number,
            signerName: input.signerName,
            signatureImage: input.signatureImage,
            selectedOptions: input.selectedOptions,
            revision: issued.revision,
            figuresKey: issued.figuresKey,
            consentText: CONSENT_TEXT,
            issuedAt: issued.issuedAt,
            validDays: issued.validDays,
          })
          if (outcome.state === 'queued' && outcome.offline) setOffline(true)
          if (outcome.state === 'recorded') {
            setOffline(false)
            // Signed: show the quote as it really is now (locked, the lifecycle says signed).
            await refresh(draftId!).catch(() => undefined)
          }
          await reloadSignature().catch(() => undefined)
          return outcome
        }}
        onBack={() => setSigning(null)}
        onBackToJob={onBackToJob ?? onBack}
        savedCopy={offline && quote.snapshotAt ? { savedAt: quote.snapshotAt } : null}
        offline={offline}
        authNeeded={signatureSyncNeedsSignIn()}
      />
    )
  }

  // "Show the customer": the phone goes to the homeowner. Before AND after issue; the same screen.
  // On the office's own figures — or, with a price sheet saved on this phone, in PREVIEW mode on a
  // quote changed here (U6): the watermark, no financing, nothing signable (nobody signs a preview,
  // design §3). With no sheet there is no figure to show, so it is greyed WITH why until the changes
  // have reached the office; after a sync it waits for "I've checked the prices".
  const customerPreview: CustomerPreview | null = quote?.priceSource === 'preview'
    ? { sheetAt: quote.priceSheetAt, options: quote.previewOptions, reason: quote.previewReason }
    : null
  // With no signal an UNCHANGED saved copy opens only when it is an issued estimate (U8, ruling 9):
  // its figures are the frozen table the office holds. A never-issued draft's figures are not.
  const showReason = !quote
    ? showCustomerReason(null)
    : refusedCount > 0
      ? REFUSED_FIRST_REASON
      : signatureHeld && issued
        ? heldSignatureReason(issued.number, signatureHeld)
      : customerPreview
        ? previewShowReason(quote, customerPreview)
        : offline
          ? (touched || localOnlyQuote ? OFFLINE_SHOW_REASON : issued ? showCustomerReason(quote) : OFFLINE_SHOW_SAVED_REASON)
          : touched
            ? SENDING_SHOW_REASON
            : pricesNeedReview
              ? CHECK_PRICES_FIRST
              : showCustomerReason(quote)
  if (quote && showing && showReason === null) {
    return (
      <ShowCustomerScreen
        quote={quote}
        preview={customerPreview}
        // ONE issue decision (shared/presentIssue.ts, the server's issueDraft): the screen calls this only
        // when nothing is recorded yet or the quote changed since. Refreshes so the lifecycle is current.
        issue={async () => {
          const r = await issueQuote(draftId!, issueOptions())
          setUnpriced(r.unpriced)
          setEditing(false)
          await refresh(draftId!)
          return r
        }}
        issueBlockedReason={issueDisabledReason(null, suggestedLines.length, openQuestions.length)}
        // Phase 3 unit C: always available - the signing screen lives on this phone.
        onSignInPerson={(h) => setSigning(h)}
        onBack={() => setShowing(false)}
        // U8: the saved copy's label with no signal, the one signing rule, and "Discard my changes".
        savedCopy={offline && quote.snapshotAt ? { savedAt: quote.snapshotAt } : null}
        signGate={gate}
        onDiscardChanges={async () => {
          await discardAllQuoteOps(draftId!)
          await reloadLocal(draftId!)
        }}
      />
    )
  }

  if (quote && issued && showIssuedPanel) {
    return (
      <IssuedEstimatePanel
        issued={issued}
        showCustomerReason={showReason}
        onShowCustomer={() => setShowing(true)}
        // While a signature waits to reach the office (U8), an edit would make a revision the
        // office would then refuse the customer's signature against: greyed WITH that reason.
        reviseReason={lifecycle?.reviseReason ?? (signatureQueued ? WAITING_FOR_SIGNATURE_EDIT : null)}
        unpriced={unpriced}
        emailEstimate={(estimateId, choices) => emailEstimateToCustomer(estimateId, { ...choices, photoIds })}
        emailFinancing={emailFinancing}
        photoCount={photoIds.length}
        offlineReason={offline ? OFFLINE_EMAIL_REASON : null}
        onEdit={() => setEditing(true)}
        onBack={onBack}
        backLabel={backLabel}
        onRaiseChangeOrder={
          onOpenChangeOrder && !quote.isChangeOrder
            ? async () => { onOpenChangeOrder((await raiseChangeOrder(visitId)).draftId) }
            : undefined
        }
      >
        {offlineSection}
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
      {offlineSection}
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
          // A quote started on this phone has no office title to have "seen": the office names it
          // when it lands, so `expected` would only ever be refused. Omitted there, sent everywhere else.
          onSave={async (patch) => {
            await actThrowing(() => write({ kind: 'set_details', ...patch, ...(localOnlyQuote ? {} : { expected: expectedForDetails(quote) }) }))
          }}
        />
      )}
      {quote?.rateProvisional && (
        <p className="rounded bg-amber-950/60 p-2 text-xs text-amber-200">
          PROVISIONAL labour rate — the office has to settle the rate before this can be issued.
        </p>
      )}

      {/* What the AI suggested, and what it could not place: decided here, in the office's words. Online only (design §2). */}
      {quote && (
        <SuggestedLinesPanel
          lines={suggestedLines}
          busy={busy}
          lockedReason={aiReason}
          allowNegative={quote.isChangeOrder}
          onConfirm={async (lineId, edits) => { await actThrowing(() => confirmSuggestedLine(lineId, edits)) }}
          onReject={async (lineId) => { await actThrowing(() => rejectSuggestedLine(lineId)) }}
        />
      )}
      {quote && (
        <OpenQuestionsPanel
          questions={openQuestions}
          busy={busy}
          lockedReason={aiReason}
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
          With no signal it reads the book saved on this phone. The assessment findings sit between
          the search box and the lists, as they always did. */}
      <QuoteCatalogPicker
        search={search}
        onSearch={setSearch}
        lockedReason={lockedReason}
        busy={busy}
        addInto={addInto}
        offline={offline}
        onNetworkFailure={() => setOffline(true)}
        onError={setError}
        onPick={(r) => {
          const note = activeFinding ? `Assessment finding: ${activeFinding.title}` : undefined
          setActiveFinding(null)
          // Quantity 1; the number, difficulty, location and note are set on the line itself. The
          // option is the one picked in "Adding into" — before 2026-10-08 every result landed in A.
          // The line's id is minted here, so a replay after a lost answer lands on the same row.
          return act(() => write({
            kind: 'add_line',
            lineId: crypto.randomUUID(),
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

      {/* "Walk the job — list what you need": the office's Walkthrough tab (Build the draft (AI) / Basic match only). Online only (design §2). */}
      {quote && (
        <WalkthroughList
          lockedReason={aiReason}
          busy={busy}
          addInto={addInto}
          onPropose={(text) => actThrowing(() => proposeFromWalkthroughList(draftId!, text))}
          onMatch={async (lines) => (await matchWalkthroughList(lines)).rows}
          // actThrowing, not act: a refusal prints on the row that was tapped (WalkthroughRowCard's own
          // error slot), not at the top of the screen above the picker - off-screen once the list is long.
          onAdd={async (c, _raw, note) => {
            await actThrowing(() => write({ kind: 'add_line', lineId: crypto.randomUUID(), itemId: c.itemId, quantity: 1, option: addInto, note }))
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
        option list is the server's (quote.optionSet), not a fixed A/B/C. Every write below goes
        through `write` with `expected` read off the quote as shown (Phase 7).
      */}
      {quote && (
        <QuoteOptionBoard
          quote={quote}
          busy={busy}
          priceSource={quote.priceSource}
          previewOptions={quote.previewOptions}
          renderLine={(l) => (
            <LineRow
              line={l as QuoteViewLine}
              busy={busy}
              lockedReason={lockedReason}
              letters={quote.optionSet.options.map((o) => o.option)}
              allowNegative={quote.isChangeOrder}
              onPatch={(patch) => actThrowing(() => write({ kind: 'edit_line', lineId: l.id, patch, expected: expectedForLine(l, patch) }))}
              onRemove={() => actThrowing(() => write({ kind: 'remove_line', lineId: l.id }))}
            />
          )}
          onAddOption={async () => {
            // "+ Add Option D" selects the new option, so the next item lands in it (Phase 2). The
            // letter is the one the screen showed, so a replay cannot add a second one.
            const letter = quote.optionSet.nextOption
            if (!letter) throw new Error('Eight options is the limit.')
            await actThrowing(() => write({ kind: 'add_option', option: letter }))
            setAddInto(letter)
          }}
          onRemoveOption={async (option, expectedLines) => { await actThrowing(() => write({ kind: 'remove_option', option, expectedLines })) }}
          onSaveOrder={async (order) => { await actThrowing(() => write({ kind: 'line_order', order })) }}
          onSaveMeta={async (option, meta) => {
            await actThrowing(() => write({ kind: 'set_option_meta', option, label: meta.label, note: meta.note, expected: expectedForOptionMeta(quote, option) }))
          }}
        />
      )}

      {/* One-or-the-other mode and Copy lines — the office's "Option mode + copy" bar (Phase 2). */}
      {quote && (
        <OptionModeAndCopy
          quote={quote}
          busy={busy}
          lockedReason={lockedReason}
          copyBlockedReason={copyLinesReason}
          onSetMode={async (exclusive) => { await actThrowing(() => write({ kind: 'set_mode', exclusive, expected: expectedForMode(quote) })) }}
          onCopy={(from, to) => actThrowing(() => copyQuoteOption(draftId!, from, to))}
        />
      )}

      {/*
        The grand total only: each option's own subtotal sits on its heading above, so the per-option
        rows this box used to repeat are gone (Phase 2). The discount, in dollars, comes from the
        server with the quote — or from the shared preview with no signal — see QuoteSettings.
      */}
      {quote && quote.lines.length > 0 && (
        <QuoteTotals
          quote={quote}
          busy={busy}
          lockedReason={lockedReason}
          priceSource={quote.priceSource}
          priceSheetAt={quote.priceSheetAt}
          pendingDiscount={quote.pendingDiscount}
          onSetDiscount={async (next) => {
            await actThrowing(() => write({ kind: 'set_discount', type: next.type, percent: next.percent ?? null, expected: expectedForDiscount(quote) }))
          }}
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
                await refresh(draftId!)
              })
              .catch((err) => {
                const body = (err as { body?: { reasons?: string[] } }).body
                if (body?.reasons?.length) setIssueReasons(body.reasons)
                else if (isNetworkFailure(err)) { setOffline(true); setError(OFFLINE_ISSUE_REASON) }
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
