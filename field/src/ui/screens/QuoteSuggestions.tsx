/**
 * The field Quote screen's AI-suggested lines, open questions and walkthrough list
 * (2026-10-08, one-estimating-system plan, Phase 2 unit D). NOT Savannah: these are the office's
 * Walkthrough tab ("Build the draft (AI)", "Basic match only") and its Review tab's "AI proposals"
 * and "Open questions", on a phone.
 *
 * Kyle, 2026-10-08: the office and the truck are ONE estimating system. A draft the office built
 * from a walkthrough carries suggested lines and questions that BLOCK ISSUE until a person decides
 * each one; before this the truck could see them (greyed, no controls) and could not clear them, so
 * the quote could not be issued from the driveway. Each control below is the phone's twin of one in
 * PriceBookIntakePage.tsx, worded the same, calling the same server function:
 *
 *   AI proposals — N waiting on you    [Confirm | Edit & confirm] [Reject]   ProposedLineRow
 *   Open questions — N                 "Answer / what you did" [Resolve]      QuestionRow
 *   Walk the job — list what you need  [Build the draft (AI)] [Basic match only]   WalkthroughTab
 *
 * A suggested line is NOT PRICED and sits in no total, so there is no money on these sections and no
 * arithmetic. Hours, labour dollars, rates and Red Cedar's costs never reach this file's data
 * (shared/suggestedLines.ts); the technician hands the phone to the customer.
 *
 * Each call refreshes the quote and THROWS the server's words on refusal; the card that was pressed
 * prints them beside its own buttons, where the tech is looking. A SIGNED quote greys everything here
 * (the reason is printed once near the top of the screen and is each control's tooltip) — greyed with
 * the reason, never hidden.
 */

import { useEffect, useState } from 'react'
import type { QuoteLine } from '../../lib/crmSync'
import type { EstimateOptionLetter } from '../../../../shared/estimateOptions'
import type {
  FieldOpenQuestion,
  QuoteSuggestedLine,
  FieldWalkthroughCandidate,
  FieldWalkthroughRow,
  WalkthroughProposal,
} from '../../../../shared/suggestedLines'
import {
  PROPOSALS_NOTE,
  WALKTHROUGH_MAX_CHARS,
  aiSummaryText,
  confirmButtonLabel,
  confirmEdits,
  proposalsHeading,
  questionsHeading,
  suggestionQuantityProblem,
  unmatchedText,
  walkthroughLineNote,
  walkthroughLines,
  walkthroughPathBadge,
} from '../../lib/quoteSuggestions'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const DIFFS = ['NORMAL', 'DIFFICULT', 'VERY_DIFFICULT'] as const
const DIFF_LABEL = { NORMAL: 'Normal', DIFFICULT: 'Difficult', VERY_DIFFICULT: 'Very difficult' } as const

// ─── AI proposals ────────────────────────────────────────────────────────────

function SuggestedLineCard(props: {
  line: QuoteSuggestedLine
  busy: boolean
  lockedReason: string | null
  allowNegative: boolean
  onConfirm: (lineId: string, edits: { quantity?: number; difficulty?: QuoteLine['difficulty'] }) => Promise<void>
  onReject: (lineId: string) => Promise<void>
}) {
  const { line, busy, lockedReason, allowNegative, onConfirm, onReject } = props
  const [qty, setQty] = useState(String(line.quantity))
  const [difficulty, setDifficulty] = useState<QuoteLine['difficulty']>(line.difficulty)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setQty(String(line.quantity)), [line.quantity])
  useEffect(() => setDifficulty(line.difficulty), [line.difficulty])

  const problem = suggestionQuantityProblem(qty, allowNegative)
  const changed = Number(qty) !== line.quantity || difficulty !== line.difficulty
  const off = busy || working || Boolean(lockedReason)
  const run = async (fn: () => Promise<void>) => {
    setWorking(true)
    setError(null)
    try { await fn() } catch (e) { setError(errText(e)) } finally { setWorking(false) }
  }

  return (
    <div className="space-y-2 rounded-lg border-l-4 border-sky-400 bg-slate-800 p-3">
      <div>
        <div className="text-sm font-semibold text-white">{line.description}</div>
        <div className="text-[11px] text-slate-400">
          {line.itemId}
          {line.proposedBy ? ` · proposed by ${line.proposedBy}` : ''} · goes in Option {line.option}
        </div>
      </div>
      {/* The model's reasoning sits next to the decision: confirming without seeing why it was
          suggested is rubber-stamping, which is the failure the office's screen exists to avoid. */}
      {line.reasoning && <p className="rounded bg-sky-950/60 p-2 text-xs text-sky-100">“{line.reasoning}”</p>}

      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="text-slate-400">
          Qty
          <input
            className="mt-1 block w-20 rounded border border-slate-600 bg-slate-900 p-2 text-white"
            type="number"
            inputMode="decimal"
            value={qty}
            disabled={off}
            title={lockedReason ?? undefined}
            onChange={(e) => setQty(e.target.value)}
          />
        </label>
        <label className="text-slate-400">
          Difficulty
          <select
            className="mt-1 block rounded border border-slate-600 bg-slate-900 p-2 text-white"
            value={difficulty}
            disabled={off}
            title={lockedReason ?? undefined}
            onChange={(e) => setDifficulty(e.target.value as QuoteLine['difficulty'])}
          >
            {DIFFS.map((d) => <option key={d} value={d}>{DIFF_LABEL[d]}</option>)}
          </select>
        </label>
      </div>
      {problem && <p className="text-xs text-amber-200">{problem}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={off || problem !== null}
          title={lockedReason ?? problem ?? undefined}
          onClick={() => void run(() => onConfirm(line.id, confirmEdits(line, qty, difficulty)))}
          className="min-h-[2.75rem] flex-1 rounded-lg bg-emerald-700 p-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {working ? 'Working…' : confirmButtonLabel(changed)}
        </button>
        <button
          type="button"
          disabled={off}
          title={lockedReason ?? 'Drop this suggestion — nothing is added to the quote'}
          onClick={() => void run(() => onReject(line.id))}
          className="min-h-[2.75rem] rounded-lg border border-slate-500 px-4 text-sm font-medium text-slate-100 disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
    </div>
  )
}

/** "AI proposals — N waiting on you": the office's Review list, on the phone. Renders nothing when empty. */
export function SuggestedLinesPanel(props: {
  lines: QuoteSuggestedLine[]
  busy: boolean
  lockedReason: string | null
  /** Only a change order's lines may be edited into a credit (the same rule as the quantity boxes). */
  allowNegative: boolean
  onConfirm: (lineId: string, edits: { quantity?: number; difficulty?: QuoteLine['difficulty'] }) => Promise<void>
  onReject: (lineId: string) => Promise<void>
}) {
  const { lines, ...rest } = props
  if (lines.length === 0) return null
  return (
    <section className="space-y-2" aria-label="AI proposals">
      <h2 className="text-sm font-semibold text-white">{proposalsHeading(lines.length)}</h2>
      <p className="text-[11px] text-slate-400">{PROPOSALS_NOTE}</p>
      {lines.map((l) => <SuggestedLineCard key={l.id} line={l} {...rest} />)}
    </section>
  )
}

// ─── Open questions ──────────────────────────────────────────────────────────

function QuestionCard(props: {
  question: FieldOpenQuestion
  busy: boolean
  lockedReason: string | null
  onResolve: (questionId: string, note: string) => Promise<void>
}) {
  const { question, busy, lockedReason, onResolve } = props
  const [note, setNote] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const off = busy || working || Boolean(lockedReason)
  return (
    <div className="space-y-2 rounded-lg border-l-4 border-amber-400 bg-slate-800 p-3">
      <p className="text-sm text-white">{question.question}</p>
      <p className="text-[11px] text-slate-400">raised by {question.raisedBy}</p>
      <div className="flex gap-2">
        <input
          className="min-h-[2.75rem] flex-1 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white disabled:opacity-50"
          placeholder="Answer / what you did"
          value={note}
          disabled={off}
          title={lockedReason ?? undefined}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="button"
          disabled={off || !note.trim()}
          title={lockedReason ?? (!note.trim() ? 'Write what you did or found out first' : undefined)}
          onClick={async () => {
            setWorking(true)
            setError(null)
            try { await onResolve(question.id, note.trim()) } catch (e) { setError(errText(e)) } finally { setWorking(false) }
          }}
          className="min-h-[2.75rem] rounded-lg border border-slate-500 px-4 text-sm font-medium text-slate-100 disabled:opacity-50"
        >
          {working ? 'Working…' : 'Resolve'}
        </button>
      </div>
      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
    </div>
  )
}

/** "Open questions — N": what the model could not place. Renders nothing when empty. */
export function OpenQuestionsPanel(props: {
  questions: FieldOpenQuestion[]
  busy: boolean
  lockedReason: string | null
  onResolve: (questionId: string, note: string) => Promise<void>
}) {
  const { questions, ...rest } = props
  if (questions.length === 0) return null
  return (
    <section className="space-y-2" aria-label="Open questions">
      <h2 className="text-sm font-semibold text-white">{questionsHeading(questions.length)}</h2>
      {questions.map((q) => <QuestionCard key={q.id} question={q} {...rest} />)}
    </section>
  )
}

// ─── Walk the job — list what you need ───────────────────────────────────────

export function WalkthroughRowCard(props: {
  row: FieldWalkthroughRow
  busy: boolean
  addInto: EstimateOptionLetter
  onAdd: (candidate: FieldWalkthroughCandidate, raw: string) => Promise<boolean>
}) {
  const { row, busy, addInto, onAdd } = props
  const [added, setAdded] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const badge =
    row.status === 'MATCHED'
      ? 'bg-emerald-900 text-emerald-100'
      : row.status === 'AMBIGUOUS'
        ? 'bg-sky-900 text-sky-100'
        : 'bg-amber-900 text-amber-100'
  return (
    <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-800 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="break-words font-mono text-sm text-white">{row.raw}</div>
          <div className="text-[11px] text-slate-400">
            matched on “{row.searchTerm}”
            {row.parsedQuantity !== null && row.parsedQuantity !== undefined
              ? ` · you wrote ${row.parsedQuantity} — set the quantity on the line`
              : ''}
          </div>
        </div>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${badge}`}>{row.status}</span>
      </div>
      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}
      <div className="space-y-1">
        {row.candidates.map((c) => {
          const isAdded = added.includes(c.itemId)
          return (
            <button
              key={c.itemId}
              type="button"
              disabled={isAdded || busy || working}
              title={isAdded ? undefined : `Adds one to Option ${addInto} — set the quantity on the line`}
              onClick={async () => {
                setWorking(true)
                setError(null)
                try {
                  if (await onAdd(c, row.raw)) setAdded((prev) => [...prev, c.itemId])
                } catch (e) { setError(errText(e)) } finally { setWorking(false) }
              }}
              className={
                isAdded
                  ? 'flex min-h-[2.75rem] w-full items-center justify-between gap-2 rounded-lg border border-slate-600 p-2 text-left text-sm text-slate-300 opacity-60'
                  : 'flex min-h-[2.75rem] w-full items-center justify-between gap-2 rounded-lg bg-sky-800 p-2 text-left text-sm text-white disabled:opacity-50'
              }
            >
              {/* Kyle's own item name is the label — his catalog, his words. */}
              <span className="min-w-0 break-words">{c.description ?? c.itemId}</span>
              <span className="shrink-0 text-xs">{isAdded ? '✓ added' : '+ Add to quote'}</span>
            </button>
          )
        })}
        {row.candidates.length === 0 && (
          <p className="rounded bg-amber-950/60 p-2 text-xs text-amber-200">{unmatchedText(row.unknownWords)}</p>
        )}
      </div>
    </div>
  )
}

/**
 * The office's Walkthrough tab, on the phone. Closed it is one button; open it is the textarea, the
 * two buttons and what came back. "Build the draft (AI)" puts suggestions under "AI proposals" above;
 * "Basic match only" lists candidates here and NOTHING is added until the tech taps "+ Add to quote".
 * Which brain answered is always named, and a degraded AI says why.
 */
export function WalkthroughList(props: {
  lockedReason: string | null
  busy: boolean
  addInto: EstimateOptionLetter
  /** "Build the draft (AI)": resolves with the server's answer AFTER the quote was refreshed (so what
   *  the AI wrote shows under "AI proposals"); THROWS on a refusal. */
  onPropose: (text: string) => Promise<WalkthroughProposal>
  /** "Basic match only": one row per typed line. */
  onMatch: (lines: string[]) => Promise<FieldWalkthroughRow[]>
  /** Adds the candidate at quantity 1 (with the walkthrough note); resolves true when it landed. */
  onAdd: (candidate: FieldWalkthroughCandidate, raw: string, note: string) => Promise<boolean>
}) {
  const { lockedReason, busy, addInto, onPropose, onMatch, onAdd } = props
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [working, setWorking] = useState<'ai' | 'basic' | null>(null)
  const [path, setPath] = useState<'ai' | 'basic' | null>(null)
  const [degraded, setDegraded] = useState<string | null>(null)
  const [summary, setSummary] = useState<{ proposed: number; questions: number; rejected: number } | null>(null)
  const [rows, setRows] = useState<FieldWalkthroughRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!open) {
    return (
      <button
        type="button"
        disabled={Boolean(lockedReason)}
        title={lockedReason ?? 'Type what you need, one item per line — the AI drafts lines from it, or match it to the price book'}
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-sm font-medium text-sky-200 disabled:opacity-50"
      >
        Walk the job — list what you need
      </button>
    )
  }

  const runMatch = async () => {
    const lines = walkthroughLines(text)
    setWorking('basic')
    setError(null)
    try {
      setRows(await onMatch(lines))
      setPath((p) => p ?? 'basic')
    } catch (e) {
      setError(errText(e))
    } finally {
      setWorking(null)
    }
  }

  const runAi = async () => {
    setWorking('ai')
    setError(null)
    try {
      const r = await onPropose(text.trim())
      setPath(r.path)
      setDegraded(r.degradedReason ?? null)
      if (r.path === 'ai') {
        setRows(null)
        setSummary({ proposed: r.proposed.length, questions: r.questions.length, rejected: r.rejected.length })
        // Suggestions and questions now sit on the quote (onPropose refreshed it) — they show under
        // "AI proposals" / "Open questions" above.
        setWorking(null)
      } else {
        // The model could not run, so the draft was not touched: the tech still gets candidates.
        setSummary(null)
        setWorking(null)
        await runMatch()
      }
    } catch (e) {
      // Same as the office: the reason is shown, and the basic match runs so the list is not lost.
      setPath('basic')
      setDegraded(errText(e))
      setSummary(null)
      setWorking(null)
      await runMatch()
    }
  }

  const empty = walkthroughLines(text).length === 0
  const off = Boolean(lockedReason) || busy || working !== null

  return (
    <div className="space-y-2 rounded-lg border border-slate-700 bg-slate-800/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="walkthrough-list" className="text-xs font-medium text-slate-300">
          Walk the job — list what you need, one item per line
        </label>
        <button type="button" className="text-xs text-sky-300 underline" onClick={() => setOpen(false)}>Close</button>
      </div>
      <textarea
        id="walkthrough-list"
        className="h-40 w-full rounded border border-slate-600 bg-slate-900 p-2 font-mono text-sm text-white disabled:opacity-50"
        placeholder={'4 20A receptacle\n50 ft 1-1/4 EMT\n2 4-square box\nthat weird outdoor plug by the pool'}
        maxLength={WALKTHROUGH_MAX_CHARS}
        value={text}
        disabled={Boolean(lockedReason)}
        title={lockedReason ?? undefined}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={off || empty}
          title={lockedReason ?? (empty ? 'Type the list first' : undefined)}
          onClick={() => void runAi()}
          className="min-h-[2.75rem] flex-1 rounded-lg bg-sky-700 px-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {working === 'ai' ? 'Building the draft…' : 'Build the draft (AI)'}
        </button>
        <button
          type="button"
          disabled={off || empty}
          title={lockedReason ?? (empty ? 'Type the list first' : undefined)}
          onClick={() => void runMatch()}
          className="min-h-[2.75rem] flex-1 rounded-lg border border-slate-500 px-3 text-sm font-medium text-slate-100 disabled:opacity-50"
        >
          {working === 'basic' ? 'Matching…' : 'Basic match only'}
        </button>
      </div>

      {/* WHICH BRAIN PRODUCED THIS (P023): always named, and a degraded AI says why. */}
      {path && (
        <p className={path === 'ai' ? 'rounded bg-emerald-950/60 p-2 text-xs text-emerald-200' : 'rounded bg-amber-950/60 p-2 text-xs text-amber-200'}>
          {walkthroughPathBadge(path, degraded)}
        </p>
      )}
      <p className="text-[11px] text-slate-400">
        Nothing is added automatically. “Build the draft (AI)” puts its suggestions under “AI proposals” for you to
        confirm or reject. “Basic match only” lists the matches from your book — tap <b>+ Add to quote</b> on the one
        you meant. Quantities are set on the line.
      </p>
      {error && <p className="rounded bg-red-950/60 p-2 text-xs text-red-200">{error}</p>}

      {summary && (
        <div className="rounded bg-slate-900 p-2 text-xs text-slate-200">
          <p className="font-medium">{aiSummaryText(summary.proposed, summary.questions, summary.rejected)}</p>
          <p className="mt-1 text-slate-400">Confirm, edit or drop each one under “AI proposals” and “Open questions”. Nothing counts until you do.</p>
        </div>
      )}

      {rows?.map((row, i) => (
        <WalkthroughRowCard
          key={`${row.raw}-${i}`}
          row={row}
          busy={busy || Boolean(lockedReason)}
          addInto={addInto}
          onAdd={(c, raw) => onAdd(c, raw, walkthroughLineNote(raw))}
        />
      ))}
    </div>
  )
}
