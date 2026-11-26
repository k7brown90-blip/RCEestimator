/**
 * The approval card in the field app (work order agent-team, U10): a draft an AI agent wrote, waiting for a
 * person who holds the approve_drafts power to send, edit or reject it, drawn for a phone.
 *
 *   Home -> Messages -> "Waiting for approval (n)" -> this card (W2-D: was "Needs approval")
 *
 * It is the CRM's card (client/src/components/ApprovalCard.tsx) in the field's clothes, not a second design:
 * what the card SAYS is the server's (the header line, the chip, the "When you approve" lines, "Sends as:"), and what is
 * greyed, why, and what the buttons are called come from shared/hub/approvalRules.ts, the same file the CRM's card reads.
 *
 *   "Approve and send"   asks "Send this email to Jane (jane@...)? It goes to the customer." first
 *   "Edit"               subject, words, To and CC, then "Send my version"
 *   "Reject"             "Why?" then "Reject draft" (greyed with "Type a reason first" until there is one)
 *
 * Greyed, never hidden, and the reason is printed on the card (not only in a tooltip, which a phone has no hover for):
 * the server's approve.blockedReason / editBlockedReason, word for word. A failed send has "Try sending again" and
 * Reject; a text held because texting is off has "Send now" and Reject. A sent, rejected or blocked card is the record.
 * The screen that fetches and decides is NeedsApprovalScreen (MessagesScreen.tsx); this component only draws and calls
 * the handlers it is given, so it can be rendered and pinned without a network.
 */
import { useState } from 'react'
import type { ApprovalCardView } from '../../../../shared/hub/views'
import { REJECT_FIRST_HINT, REJECT_REASON_MIN, approvingLabel, cardLocks, isActionable } from '../../../../shared/hub/approvalRules'

export interface EditSend {
  body: string
  subject?: string
  to?: string | null
  cc?: string[]
}

const whenText = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })

type Mode = 'view' | 'edit' | 'reject'

export function ApprovalCard({
  card, canApprove, approveReason, onApprove, onEditSend, onReject, confirmSend = (text: string) => window.confirm(text),
}: {
  card: ApprovalCardView
  /** Does this person hold the approve_drafts power? (GET /hub/approvals says.) */
  canApprove: boolean
  /** The power's sentence, printed beside a greyed button when canApprove is false. */
  approveReason: string | null
  onApprove?: (card: ApprovalCardView) => Promise<void>
  onEditSend?: (card: ApprovalCardView, edit: EditSend) => Promise<void>
  onReject?: (card: ApprovalCardView, reason: string) => Promise<void>
  /** The "this goes to the customer" question. A phone's own confirm box by default. */
  confirmSend?: (text: string) => boolean
}) {
  const [mode, setMode] = useState<Mode>('view')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [subject, setSubject] = useState(card.subject ?? '')
  const [body, setBody] = useState(card.body)
  const [to, setTo] = useState(card.recipientAddress ?? '')
  const [cc, setCc] = useState(card.cc.join(', '))
  const [reason, setReason] = useState('')

  const actionable = isActionable(card)
  const customerFacing = card.chip.tone === 'customer'
  const isEmail = card.channel === 'email'
  const { lock, editLock, rejectLock, approveLabel } = cardLocks(card, canApprove, approveReason)

  const run = async (fn: (() => Promise<void>) | undefined) => {
    if (!fn) return
    setBusy(true)
    setError(null)
    try {
      await fn()
      setMode('view')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const approve = () => {
    if (customerFacing && !confirmSend(card.approve.confirm)) return
    void run(onApprove && (() => onApprove(card)))
  }
  const editSend = () => {
    if (!body.trim() || editLock || busy) return
    const typedTo = to.trim()
    void run(onEditSend && (() => onEditSend(card, {
      body: body.trim(),
      ...(isEmail ? { subject: subject.trim(), ...(typedTo && typedTo !== (card.recipientAddress ?? '') ? { to: typedTo } : {}), cc: cc.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
    })))
  }
  const reject = () => {
    if (reason.trim().length < REJECT_REASON_MIN || busy) return
    void run(onReject && (() => onReject(card, reason.trim())))
  }

  const header = `Draft by ${card.draftedBy} · ${card.headerLine}${card.recipient ? ` · to ${card.recipient}` : ''}`

  return (
    <article
      className="rounded-lg border border-amber-600 bg-amber-950/30 p-3 text-sm text-white"
      aria-label={`Draft to ${card.recipient ?? card.threadTitle}`}
      data-testid="approval-card"
      data-message-id={card.id}
    >
      <p className="font-semibold text-slate-100">
        {header}
        <span className="ml-1 text-xs font-normal text-slate-400">· {whenText(card.createdAt)}</span>
      </p>

      <p
        className={`mt-1 inline-block rounded px-2 py-0.5 text-[11px] font-semibold ${customerFacing ? 'bg-amber-200 text-amber-900' : 'bg-slate-600 text-slate-100'}`}
        data-testid="approval-chip"
      >
        {card.chip.text}
      </p>

      {card.recent.length > 0 && (
        <details className="mt-2 rounded border border-slate-700 bg-slate-900/60 px-2 py-1">
          <summary className="cursor-pointer text-xs font-medium text-slate-300">
            The last {card.recent.length === 1 ? 'message' : `${card.recent.length} messages`} before this
          </summary>
          <ul className="mt-1 space-y-1">
            {card.recent.map((m, i) => (
              <li key={`${m.at}-${i}`} className="text-xs text-slate-200">
                <span className="font-medium">{m.authorDisplay}:</span> {m.text}
              </li>
            ))}
          </ul>
        </details>
      )}

      {mode !== 'edit' ? (
        <div className="mt-2">
          {card.subject && <p className="font-medium">{card.subject}</p>}
          <p className="whitespace-pre-wrap break-words">{card.body}</p>
          {card.recipientAddress && (
            <p className="mt-0.5 text-xs text-slate-400">To {card.recipientAddress}{card.cc.length > 0 ? ` · cc ${card.cc.join(', ')}` : ''}</p>
          )}
        </div>
      ) : (
        <form
          className="mt-2 space-y-2"
          aria-label="Edit draft"
          onSubmit={(e) => { e.preventDefault(); editSend() }}
        >
          {isEmail && (
            <label className="block text-xs font-medium text-slate-300">
              Subject
              <input
                className="mt-1 w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
                value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)}
              />
            </label>
          )}
          <label className="block text-xs font-medium text-slate-300">
            {isEmail ? 'Message' : 'Words (the header and the STOP line are added for you)'}
            <textarea
              className="mt-1 w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
              rows={5} value={body} onChange={(e) => setBody(e.target.value)}
            />
          </label>
          {isEmail && (
            <>
              <label className="block text-xs font-medium text-slate-300">
                To
                <input
                  className="mt-1 w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
                  type="email" value={to} onChange={(e) => setTo(e.target.value)}
                />
              </label>
              <label className="block text-xs font-medium text-slate-300">
                CC (separate with commas)
                <input
                  className="mt-1 w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
                  value={cc} onChange={(e) => setCc(e.target.value)}
                />
              </label>
            </>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="rounded bg-sky-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
              disabled={!body.trim() || Boolean(editLock) || busy}
              title={editLock ?? undefined}
            >
              {busy ? 'Sending…' : 'Send my version'}
            </button>
            <button type="button" onClick={() => { setMode('view'); setError(null) }} className="rounded border border-slate-600 px-3 py-2 text-xs text-slate-200">Cancel</button>
          </div>
          {editLock && <p className="text-xs text-amber-200" data-testid="edit-lock">{editLock}</p>}
        </form>
      )}

      {card.sendsAs && (
        <div className="mt-2 rounded border border-slate-700 bg-slate-900/60 px-2 py-1" data-testid="sends-as">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Sends as:</p>
          <p className="whitespace-pre-wrap break-words text-xs">{card.sendsAs}</p>
        </div>
      )}

      {actionable && card.effectLines.length > 0 && (
        <div className="mt-2 rounded border border-slate-700 bg-slate-900/60 px-2 py-1" data-testid="when-you-approve">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">When you approve</p>
          <ul className="list-disc pl-4 text-xs">
            {card.effectLines.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}

      {card.outcome.text && <p className="mt-2 text-xs font-medium" data-testid="approval-outcome">{card.outcome.text}</p>}
      {card.outcome.error && card.status !== 'failed' && <p className="mt-1 text-xs text-red-300">{card.outcome.error}</p>}

      {actionable && mode === 'reject' && (
        <form
          className="mt-2 space-y-2 rounded border border-red-800 bg-red-950/40 p-2"
          aria-label="Reject draft"
          onSubmit={(e) => { e.preventDefault(); reject() }}
        >
          <label className="block text-xs font-medium text-slate-200">
            Why?
            <input
              className="mt-1 w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
              value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className="rounded bg-red-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
              disabled={reason.trim().length < REJECT_REASON_MIN || busy}
              title={reason.trim().length < REJECT_REASON_MIN ? REJECT_FIRST_HINT : undefined}
            >
              {busy ? 'Rejecting…' : 'Reject draft'}
            </button>
            {reason.trim().length < REJECT_REASON_MIN && <span className="text-xs text-slate-400">{REJECT_FIRST_HINT}</span>}
            <button type="button" onClick={() => { setMode('view'); setReason(''); setError(null) }} className="rounded border border-slate-600 px-3 py-2 text-xs text-slate-200">Cancel</button>
          </div>
        </form>
      )}

      {actionable && mode === 'view' && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded bg-sky-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
            disabled={Boolean(lock) || busy}
            title={lock ?? undefined}
            onClick={approve}
          >
            {busy ? approvingLabel(card) : approveLabel}
          </button>
          {card.status === 'pending_approval' && (
            <button
              type="button"
              className="rounded border border-slate-500 px-3 py-2 text-xs font-medium text-slate-100 disabled:opacity-40"
              disabled={Boolean(editLock) || busy}
              title={editLock ?? undefined}
              onClick={() => { setBody(card.body); setSubject(card.subject ?? ''); setTo(card.recipientAddress ?? ''); setCc(card.cc.join(', ')); setMode('edit') }}
            >
              Edit
            </button>
          )}
          <button
            type="button"
            className="rounded border border-red-700 px-3 py-2 text-xs font-medium text-red-200 disabled:opacity-40"
            disabled={Boolean(rejectLock) || busy}
            title={rejectLock ?? undefined}
            onClick={() => { setReason(''); setMode('reject') }}
          >
            Reject
          </button>
        </div>
      )}
      {actionable && lock && (
        <p className="mt-1 rounded border border-amber-700 bg-amber-950/40 px-2 py-1 text-xs text-amber-200" data-testid="approval-lock">{lock}</p>
      )}
      {error && <p className="mt-1 text-xs text-red-300" role="alert">{error}</p>}
    </article>
  )
}
