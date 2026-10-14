/**
 * The field Quote screen's LIFECYCLE controls (2026-10-08, one-estimating-system plan, Phase 2 unit B):
 * the title & scope editor, the issued-estimate panel with "Edit the estimate", the issue button's
 * wording, and the two exits — "Copy to a new quote" and "Delete this quote".
 *
 * Kyle, 2026-10-08: the office and the truck are ONE estimating system. Each control here is the
 * phone's twin of one in Estimate Intake, calling the same server function:
 *
 *   Title & scope                       the draft card's "Estimate title" / "Scope of work"   (setDraftDetails)
 *   Estimate N issued · Edit the estimate   the Review tab's amber banner + the Edit button    (reopen on first edit)
 *   Save changes to the estimate        the Send panel's button of the same name                (issueDraft → revise)
 *   Copy to a new quote                 the estimate drawer's "Copy to new"                     (duplicateDraft)
 *   Delete this quote                   the draft card's "Delete this draft"                    (deleteDraft)
 *
 * Everything shown here comes from the server's `quote.lifecycle` (shared/draftLifecycle.ts): which
 * estimate exists, whether the draft changed since, why editing or deleting is refused. The screen
 * decides nothing about "signed", "lost" or "issued" for itself. Standing rule: an unavailable
 * action is greyed WITH its reason as the tooltip and on the page, never hidden.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { DraftLifecycle } from '../../../../shared/draftLifecycle'
import { SAVE_CHANGES_LABEL, nothingChangedReason } from '../../../../shared/draftLifecycle'
import { ESTIMATE_EMAIL_DEFAULTS, type EstimateEmailChoices } from '../../../../shared/estimateEmail'
import { OFFLINE_CHANGE_ORDER_REASON } from './QuoteOffline'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ─── The issue button's words ────────────────────────────────────────────────

export const ISSUE_LABEL = 'Issue the estimate — freezes prices, customer signs next'

/**
 * What the big green button says and why it is greyed, from the lifecycle alone. A first issue
 * reads ISSUE_LABEL; once an estimate exists it reads the office's "Save changes to the estimate",
 * greyed when nothing changed (saving would only replace the customer's link with an identical
 * copy), when the estimate is signed, or when it is lost (reopen it first — the Phase 0 rule).
 */
export function issueButtonState(lifecycle: DraftLifecycle | null | undefined): { label: string; disabledReason: string | null } {
  const issued = lifecycle?.issued ?? null
  if (!issued) return { label: ISSUE_LABEL, disabledReason: null }
  if (lifecycle?.reviseReason) return { label: SAVE_CHANGES_LABEL, disabledReason: lifecycle.reviseReason }
  if (!lifecycle?.hasUnsavedChanges) return { label: SAVE_CHANGES_LABEL, disabledReason: nothingChangedReason(issued) }
  return { label: SAVE_CHANGES_LABEL, disabledReason: null }
}

/** One line naming the estimate as it stands: "Estimate 2026-1098 rev 2 — issued, not signed yet". */
export function issuedHeadline(issued: NonNullable<DraftLifecycle['issued']>): string {
  const rev = issued.revision > 1 ? ` rev ${issued.revision}` : ''
  const state = issued.signedAt
    ? 'signed'
    : issued.status === 'lost'
      ? 'marked lost'
      : issued.status === 'expired'
        ? 'expired'
        : 'issued, not signed yet'
  return `Estimate ${issued.number}${rev} — ${state}`
}

// ─── Title & scope ───────────────────────────────────────────────────────────

/**
 * The estimate's title and the scope of work the customer reads under it. Collapsed to one line
 * ("Title · scope ✎") until tapped; thumb-sized Save / Cancel. Greyed with the reason on a signed
 * quote (the server still takes the edit, like the discount — but the truck cannot press "Save
 * changes to the estimate" on a signed one, so a change here would sit on the draft unseen).
 */
export function TitleScopeEditor(props: {
  title: string
  jobDescription: string | null
  busy: boolean
  lockedReason: string | null
  /** The estimate this draft already issued, if any — the hint says the edit reaches it on save. */
  issuedNumber: string | null
  onSave: (patch: { title: string; jobDescription: string | null }) => Promise<void>
}) {
  const { title, jobDescription, busy, lockedReason, issuedNumber, onSave } = props
  const [open, setOpen] = useState(false)
  const [draftTitle, setDraftTitle] = useState(title)
  const [draftScope, setDraftScope] = useState(jobDescription ?? '')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setDraftTitle(title)
    setDraftScope(jobDescription ?? '')
  }, [title, jobDescription])
  const off = busy || Boolean(lockedReason)
  const dirty = draftTitle.trim() !== title || draftScope.trim() !== (jobDescription ?? '')

  if (!open) {
    return (
      <button
        type="button"
        disabled={off}
        title={lockedReason ?? 'Change the title or the scope of work the customer reads'}
        onClick={() => setOpen(true)}
        className="block w-full rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-left disabled:opacity-50"
      >
        <span className="block text-sm font-medium text-white">{title} <span className="text-slate-400">✎</span></span>
        <span className="block text-xs text-slate-400">
          {jobDescription ? jobDescription : 'No scope of work yet — tap to describe the job for the customer.'}
        </span>
      </button>
    )
  }
  return (
    <div className="space-y-2 rounded-lg border border-slate-600 bg-slate-800 p-3">
      <label className="block text-xs text-slate-300">
        Estimate title
        <input
          className="mt-1 w-full rounded border border-slate-600 bg-slate-900 p-3 text-sm text-white"
          value={draftTitle}
          maxLength={200}
          disabled={off}
          onChange={(e) => setDraftTitle(e.target.value)}
        />
      </label>
      <label className="block text-xs text-slate-300">
        Scope of work — what the customer reads under the title (optional)
        <textarea
          className="mt-1 w-full rounded border border-slate-600 bg-slate-900 p-3 text-sm text-white"
          rows={3}
          value={draftScope}
          maxLength={4000}
          disabled={off}
          onChange={(e) => setDraftScope(e.target.value)}
        />
      </label>
      {issuedNumber && (
        <p className="text-[11px] text-amber-200">
          Reaches the customer when you press &quot;{SAVE_CHANGES_LABEL}&quot; — a new revision of {issuedNumber}.
        </p>
      )}
      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={off || !dirty || !draftTitle.trim()}
          title={!draftTitle.trim() ? 'The estimate needs a title.' : !dirty ? 'Nothing changed' : undefined}
          onClick={() => {
            setError(null)
            onSave({ title: draftTitle.trim(), jobDescription: draftScope.trim() || null })
              .then(() => setOpen(false))
              .catch((err) => setError(errText(err)))
          }}
          className="flex-1 rounded-lg bg-sky-700 p-3 text-sm font-semibold text-white disabled:opacity-40"
        >
          Save title &amp; scope
        </button>
        <button
          type="button"
          onClick={() => { setDraftTitle(title); setDraftScope(jobDescription ?? ''); setError(null); setOpen(false) }}
          className="rounded-lg border border-slate-600 px-4 py-3 text-sm text-slate-200"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─── The exits: copy to a new quote, delete this quote ───────────────────────

/**
 * Standing rule (Kyle, 2026-09-18): nothing the app creates is permanent, and the exit lives where
 * the thing is shown. "Delete this quote" is greyed WITH the server's reason once anything was
 * issued from it — the way out is then on the estimate, in the office. "Copy to a new quote" is
 * the drawer's "Copy to new": re-quote a signed or stale estimate fresh, at today's book.
 */
export function QuoteExits(props: {
  title: string
  lineCount: number
  busy: boolean
  deleteReason: string | null
  /** Why "Copy to a new quote" is refused (a change order, a diagnostic's draft), or null. Greyed WITH it. */
  copyReason?: string | null
  onCopy: () => Promise<void>
  onDelete: () => Promise<void>
}) {
  const { title, lineCount, busy, deleteReason, copyReason = null, onCopy, onDelete } = props
  const [error, setError] = useState<string | null>(null)
  const run = (fn: () => Promise<void>) => { setError(null); fn().catch((err) => setError(errText(err))) }
  return (
    <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
      <p className="text-xs font-medium text-slate-300">This quote</p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || copyReason !== null}
          title={copyReason ?? "A new quote on this job with the same lines, names and discount, priced at today's book. This one is untouched."}
          onClick={() => { if (window.confirm(`Copy "${title}" into a new quote? The new quote becomes the one this job opens.`)) run(onCopy) }}
          className="flex-1 rounded-lg border border-slate-600 p-3 text-sm text-slate-200 disabled:opacity-40"
        >
          Copy to a new quote
        </button>
        <button
          type="button"
          disabled={busy || deleteReason !== null}
          title={deleteReason ?? 'Deletes this quote and its lines. Nothing has been issued from it.'}
          onClick={() => {
            if (window.confirm(`Delete the quote "${title}" and its ${lineCount} line(s)? This cannot be undone.`)) run(onDelete)
          }}
          className="flex-1 rounded-lg border border-red-900 p-3 text-sm text-red-300 disabled:opacity-40"
        >
          Delete this quote
        </button>
      </div>
      {copyReason && <p className="text-[11px] text-slate-400">{copyReason}</p>}
      {deleteReason && <p className="text-[11px] text-slate-400">{deleteReason}</p>}
      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
    </div>
  )
}

// ─── Emailing the estimate ───────────────────────────────────────────────────

/**
 * Why "Email the estimate" is refused right now, or null. The server's own send refuses a signed
 * estimate ("already signed") and a lost one ("Reopen it first") - issuedEstimateSend.ts - and the
 * panel is drawn for both every time the tech comes back to the quote, so the button says so BEFORE
 * the press (2026-10-08 review). Archived is not in the lifecycle payload; the server still refuses it.
 */
export function emailBlockedReason(issued: NonNullable<DraftLifecycle['issued']>): string | null {
  if (issued.signedAt) {
    return `Estimate ${issued.number} is already signed, so there is no estimate email left to send - the customer has it.`
  }
  if (issued.status === 'lost') {
    return `Estimate ${issued.number} is marked lost, so it can't be emailed. The office reopens it first, then it can be sent again.`
  }
  if (issued.archived) {
    return `Estimate ${issued.number} is archived, so it can't be emailed. The office unarchives it first, then it can be sent again.`
  }
  return null
}

/**
 * Why "Email the financing link" is refused right now, or null. Unlike the estimate email it is
 * allowed on a SIGNED estimate and on an archived one (services/financingEmail.ts); what it refuses
 * is an estimate that is not a live offer. The panel is drawn for the newest revision of a live
 * draft, so lost is the case that reaches it. The server decides (void, superseded, no email on
 * file all come back in its words); this only greys the button before the press when the lifecycle
 * already says no.
 */
export function financingBlockedReason(issued: NonNullable<DraftLifecycle['issued']>): string | null {
  if (issued.status === 'lost') {
    return `Estimate ${issued.number} is marked lost, so the financing link can't be sent. The office reopens it first (Estimates page), then it can be sent.`
  }
  return null
}

/**
 * "Email the financing link" - the Synchrony application link on its own, BEFORE the customer signs
 * (Kyle, 2026-10-08: "the financing link should be able to be sent before signing"). Beside "Email
 * the estimate" on the Quote screen's issued panel and on the Job site's awaiting-signature panel;
 * the same server send the CRM's buttons make (services/financingEmail.ts). The email states no
 * rates or terms: it is a link and an invitation to apply. A second press is a decision: once sent,
 * the button says so. Greyed WITH its reason, never hidden.
 */
export function EmailFinancingButton(props: {
  estimateId: string
  send: (estimateId: string) => Promise<{ to: string }>
  blockedReason?: string | null
}) {
  const { estimateId, send, blockedReason = null } = props
  const [sending, setSending] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <button
        type="button"
        disabled={sending || blockedReason !== null}
        title={blockedReason ?? 'Emails the customer the Synchrony application link - no rates or terms are stated in the email'}
        onClick={() => {
          setSending(true); setError(null); setSentTo(null)
          send(estimateId)
            .then((r) => setSentTo(r.to))
            .catch((err) => setError(errText(err)))
            .finally(() => setSending(false))
        }}
        className="w-full rounded-lg border border-slate-600 p-3 text-sm text-slate-200 disabled:opacity-40"
      >
        {sending ? 'Emailing the financing link…' : sentTo ? '📧 Send the financing link again' : '📧 Email the financing link'}
      </button>
      {blockedReason && <p className="text-[11px] text-amber-200">{blockedReason}</p>}
      {sentTo && (
        <p className="rounded bg-emerald-950/50 p-2 text-xs text-emerald-200">
          The financing link is on its way to {sentTo}.
        </p>
      )}
      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
    </>
  )
}

/**
 * The phone's "Email the estimate to the customer" - the same send the CRM's button makes, through
 * the field's tech-scoped route. Used on the Quote screen's issued panel and the Job site screen's
 * "issued - not signed yet" panel, so both say and do the same thing. 2026-10-01 - Kyle: "the text
 * option for signiture needs chaged to email since we do not have text yet": there is no
 * navigator.share here, on purpose, anywhere.
 *
 * A SECOND SEND IS A DECISION, NOT A DOUBLE-TAP (security review, 2026-10-01): once it has gone, the
 * button says so and asks for a deliberate re-send instead. Greyed WITH its reason, never hidden.
 */
export function EmailEstimateButton(props: {
  estimateId: string
  /** Called with the choices made above the button; the caller adds the ticked photos (the Quote screen owns those). */
  send: (estimateId: string, choices: Partial<EstimateEmailChoices>) => Promise<{ to: string }>
  blockedReason?: string | null
  /** How many photos are ticked to ride the email (Phase 2 unit E) - said on the button, so nothing goes unseen. */
  photoCount?: number
}) {
  const { estimateId, send, blockedReason = null, photoCount = 0 } = props
  const [sending, setSending] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The office's Email estimate panel, on the phone (Phase 4, 2026-10-08): the same boxes with the
  // same words and the same defaults (shared/estimateEmail.ts) - the financing line ticked, the two
  // reports unticked - and the same server function behind them. Nothing here is decided by the
  // phone: a report with no assessment on file, a bad address, a void estimate all come back as the
  // server's own words below.
  const [to, setTo] = useState(ESTIMATE_EMAIL_DEFAULTS.to)
  const [message, setMessage] = useState(ESTIMATE_EMAIL_DEFAULTS.message)
  const [attachHealthReport, setAttachHealthReport] = useState(ESTIMATE_EMAIL_DEFAULTS.attachHealthReport)
  const [attachGeneratorReport, setAttachGeneratorReport] = useState(ESTIMATE_EMAIL_DEFAULTS.attachGeneratorReport)
  const [includeFinancingLink, setIncludeFinancingLink] = useState(ESTIMATE_EMAIL_DEFAULTS.includeFinancingLink)
  const boxClass = 'flex items-center gap-2 text-xs text-slate-300'
  return (
    <>
      {blockedReason === null && (
        <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-800/40 p-3">
          <p className="text-xs font-medium text-slate-300">Email options</p>
          <input
            type="email"
            inputMode="email"
            value={to}
            onChange={(ev) => setTo(ev.target.value)}
            placeholder="Send to a different address (optional)"
            aria-label="Send the estimate to a different email address"
            className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
          />
          <input
            type="text"
            value={message}
            onChange={(ev) => setMessage(ev.target.value)}
            maxLength={2000}
            placeholder="Optional note to include in the email"
            aria-label="Optional note to include in the email"
            className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
          />
          <label className={boxClass}>
            <input type="checkbox" checked={attachHealthReport} onChange={(ev) => setAttachHealthReport(ev.target.checked)} />
            Attach Electrical Health Record report (latest assessment at this address)
          </label>
          <label className={boxClass}>
            <input type="checkbox" checked={attachGeneratorReport} onChange={(ev) => setAttachGeneratorReport(ev.target.checked)} />
            Attach Generator Sizing data sheet
          </label>
          <label className={boxClass}>
            <input type="checkbox" checked={includeFinancingLink} onChange={(ev) => setIncludeFinancingLink(ev.target.checked)} />
            Include the Synchrony financing link
          </label>
        </div>
      )}
      <button
        type="button"
        disabled={sending || blockedReason !== null}
        title={blockedReason ?? undefined}
        onClick={() => {
          setSending(true); setError(null); setSentTo(null)
          send(estimateId, { to, message, attachHealthReport, attachGeneratorReport, includeFinancingLink })
            .then((r) => setSentTo(r.to))
            .catch((err) => setError(errText(err)))
            .finally(() => setSending(false))
        }}
        className="w-full rounded-lg border border-slate-600 p-3 text-sm text-slate-200 disabled:opacity-40"
      >
        {sending
          ? 'Emailing the estimate…'
          : sentTo
            ? '📧 Send it again'
            : '📧 Email the estimate to the customer'}
        {!sending && photoCount > 0 ? ` (with ${photoCount} photo${photoCount === 1 ? '' : 's'})` : ''}
      </button>
      {blockedReason && <p className="text-[11px] text-amber-200">{blockedReason}</p>}
      {sentTo && (
        <p className="rounded bg-emerald-950/50 p-2 text-xs text-emerald-200">
          It&apos;s gone to {sentTo} — tell the customer to check their inbox.
        </p>
      )}
      {error && (
        <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">
          {error} You can still go through it with them on this phone: Show the customer, then Sign now.
        </p>
      )}
    </>
  )
}

// ─── Issued: the panel after Issue, and the way back in ──────────────────────

/**
 * The link to the customer's own page of an estimate that is still waiting on them. It is NOT the
 * way to sign with the customer standing next to the tech: a signature on that page goes through
 * the public /e/:token door and is recorded as signed from the emailed link, with no technician
 * named. Signing at the house is "Show the customer" then "Sign now" (recorded in person). The
 * label says whose device the page is for so the tech does not hand the phone to the wrong one
 * (review finding, 2026-10-08).
 */
export const CUSTOMER_PAGE_LABEL = 'Open the customer’s estimate page (for their own device)'

/**
 * What the screen shows while the quote is issued and unchanged: the estimate as it stands, the
 * customer's link, the email button, and "Edit the estimate" — which is the office's Edit button:
 * it opens the builder, the first edit reopens the draft on the server (reopenForEditIfUnsigned),
 * and "Save changes to the estimate" revises the same number. Greyed with the reason when the
 * estimate is signed or lost (the office reopens it first).
 *
 * SIGNED is a deliberate CRM-only power (Kyle, 2026-10-09, ruling 1), like void and mark-lost: the
 * office changes a signed estimate, the truck cannot. The button is greyed with exactly
 * FIELD_SIGNED_REVISE_REASON (shared/draftLifecycle.ts) and "Raise a change order" sits right under
 * it for new work.
 *
 * Before 2026-10-08 this panel lived for about thirty seconds after Issue and then "Build the
 * quote" started a NEW draft; now it is rendered from the server's lifecycle whenever the tech
 * comes back to the quote.
 */
export function IssuedEstimatePanel(props: {
  issued: NonNullable<DraftLifecycle['issued']>
  reviseReason: string | null
  /** Lines that froze at $0 on the LAST issue from this screen — a warning worth repeating once. */
  unpriced: string[]
  emailEstimate: (estimateId: string, choices: Partial<EstimateEmailChoices>) => Promise<{ to: string }>
  /** "Email the financing link" (Phase 4): the Synchrony link on its own, sendable before the customer signs. */
  emailFinancing: (estimateId: string) => Promise<{ to: string }>
  /** How many photos are ticked to ride the email (Phase 2 unit E) - said on the button, so nothing goes unseen. */
  photoCount?: number
  onEdit: () => void
  onBack: () => void
  /** Words for the way back: "Job site" (the default) or "Diagnostics" when the quote was opened from there. */
  backLabel?: string
  /**
   * "Raise a change order" on a SIGNED estimate: the greyed Edit button tells the tech a signed
   * agreement is changed by the office only - "raise a change order for new work" - and the only such button used
   * to be on the Job site screen (2026-10-08 review; click-through rule 4). Same server call as that
   * button. Omitted where the panel has no way to open the result (and on a change order itself).
   */
  onRaiseChangeOrder?: () => Promise<void>
  /**
   * "Show the customer" (Phase 3 unit B): the screen the tech hands to the homeowner. On this panel
   * as well as under the builder, because the estimate is shown from wherever the tech is standing
   * (click-through rule 4). `showCustomerReason` greys it WITH the words; omit `onShowCustomer` and
   * the button does not render (a caller with no such screen).
   */
  onShowCustomer?: () => void
  showCustomerReason?: string | null
  /**
   * No signal (Phase 7 U5): the two emails and "Raise a change order" are live calls to the office,
   * so each is greyed WITH this reason (design §2: "Needs signal"), never hidden. "Edit the estimate"
   * stays live — an edit queues on this phone and reopens the draft when it lands.
   */
  offlineReason?: string | null
  children?: ReactNode
}) {
  const { issued, reviseReason, unpriced, emailEstimate, emailFinancing, photoCount = 0, onEdit, onBack, backLabel = 'Job site', onRaiseChangeOrder, onShowCustomer, showCustomerReason = null, offlineReason = null, children } = props
  const [coBusy, setCoBusy] = useState(false)
  const [coError, setCoError] = useState<string | null>(null)
  const lost = issued.status === 'lost'
  // Only an estimate still waiting on the customer is handed over to be signed.
  const awaitingCustomer = !issued.signedAt && !lost
  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-semibold text-white">{issuedHeadline(issued)}</h1>
      {unpriced.length > 0 && (
        <p className="rounded bg-amber-950/60 p-3 text-xs text-amber-200">
          Heads up — these lines froze at $0 (no price in the book): {unpriced.join(', ')}.
          The estimate is cheaper than the work by whatever they are worth.
        </p>
      )}
      {awaitingCustomer && (
        <p className="text-sm text-slate-300">
          {onShowCustomer ? (
            <>
              To sign with the customer standing here, press <span className="font-semibold text-white">Show the customer</span>, then{' '}
              <span className="font-semibold text-white">Sign now</span> — that records a signature taken in person.{' '}
            </>
          ) : null}
          The page link below is for the customer&apos;s own device, and a signature there is recorded as
          signed from the emailed link. The deposit QR is on the job screen the moment it&apos;s signed.
        </p>
      )}
      {/*
        The pointer down the path (Kyle, 2026-09-23): issuing used to be a dead end on screen —
        nothing said the JOB screen is where the next step lives, so a tech standing in the
        driveway after issuing had no way to find "Complete work now" / "Schedule for later".
      */}
      {awaitingCustomer && (
        <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-xs text-slate-300">
          Next: the customer signs. Once signed, go back to the <span className="font-semibold text-white">Job site</span> screen
          — it offers <span className="font-semibold text-white">Complete work now</span> (keeps this calendar block)
          or <span className="font-semibold text-white">Schedule for later</span>.
        </p>
      )}
      {lost && (
        <p className="rounded-lg border border-slate-700 bg-slate-800/60 p-3 text-xs text-slate-300">
          This estimate is marked lost, so it is not out for signing. The office reopens it first (Estimates page), then it can be sent again.
        </p>
      )}
      {/* The tech turns the phone around: options, ticks, live total, then "Sign now". */}
      {onShowCustomer && (
        <>
          <button
            type="button"
            disabled={showCustomerReason !== null}
            title={showCustomerReason ?? 'Turn the phone around: the customer sees each option, ticks what they want and watches the total'}
            onClick={onShowCustomer}
            className="w-full rounded-lg bg-sky-700 p-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            Show the customer
          </button>
          {showCustomerReason && <p className="text-[11px] text-amber-200">{showCustomerReason}</p>}
        </>
      )}
      {issued.customerUrl && (
        <a
          href={issued.customerUrl}
          target="_blank"
          rel="noreferrer"
          className="block w-full rounded-lg bg-sky-600 p-3 text-center text-sm font-medium text-white"
        >
          {issued.signedAt ? 'Open the customer’s signed estimate' : lost ? 'Open the customer’s estimate' : CUSTOMER_PAGE_LABEL}
        </a>
      )}
      {/*
        2026-10-01 — Kyle: "On the field app the text option for signiture needs chaged to
        email since we do not have text yet." This used to be `navigator.share(...)`, labelled
        "Share the link to their phone" — the OS share sheet, which on a phone in practice means
        texting the link. Red Cedar has no SMS (Kyle, 2026-08-16: "There will be NO automated
        texting ONLY emails ... My personal number is what I will use to text clients"), so
        there was nothing to share TO. The button emails the estimate instead, through the same
        send the CRM uses (`sendEstimateEmail`, via the field's own tech-scoped route) — do NOT
        restore navigator.share here; it was removed on purpose, not lost.

        A SECOND SEND IS A DECISION, NOT A DOUBLE-TAP (security review, 2026-10-01): once it has
        gone, the button says so and asks for a deliberate re-send instead.
      */}
      <EmailEstimateButton
        estimateId={issued.estimateId}
        send={emailEstimate}
        blockedReason={offlineReason ?? emailBlockedReason(issued)}
        photoCount={photoCount}
      />
      {/* Beside the estimate email, not behind the signature (Kyle, 2026-10-08). */}
      <EmailFinancingButton
        estimateId={issued.estimateId}
        send={emailFinancing}
        blockedReason={offlineReason ?? financingBlockedReason(issued)}
      />
      {/* The office's Edit button. Greyed with the server's reason, never hidden. */}
      <button
        type="button"
        disabled={reviseReason !== null}
        title={reviseReason ?? `Reopens this quote; "${SAVE_CHANGES_LABEL}" then makes a new revision of ${issued.number}`}
        onClick={onEdit}
        className="w-full rounded-lg bg-emerald-700 p-3 text-sm font-semibold text-white disabled:opacity-40"
      >
        Edit the estimate
      </button>
      {reviseReason && <p className="text-[11px] text-amber-200">{reviseReason}</p>}
      {/* A signed estimate is changed by the OFFICE only (ruling 1, 2026-10-09): the truck's way to new work is a change order, one tap from here. */}
      {issued.signedAt && onRaiseChangeOrder && (
        <>
          <button
            type="button"
            disabled={coBusy || offlineReason !== null}
            title={offlineReason !== null ? OFFLINE_CHANGE_ORDER_REASON : 'Starts a change order against this signed estimate - the new or changed work, signed on its own'}
            onClick={() => {
              setCoBusy(true); setCoError(null)
              onRaiseChangeOrder().catch((err) => { setCoError(errText(err)); setCoBusy(false) })
            }}
            className="w-full rounded-lg border border-sky-700 p-3 text-sm font-semibold text-sky-200 disabled:opacity-40"
          >
            {coBusy ? 'Raising the change order…' : 'Raise a change order'}
          </button>
          {offlineReason !== null && <p className="text-[11px] text-amber-200">{OFFLINE_CHANGE_ORDER_REASON}</p>}
          {coError && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{coError}</p>}
        </>
      )}
      {children}
      <button type="button" onClick={onBack} className="w-full rounded-lg border border-slate-700 p-3 text-sm text-slate-300">
        Back to the {backLabel === 'Job site' ? 'job' : backLabel.toLowerCase()}
      </button>
    </div>
  )
}
